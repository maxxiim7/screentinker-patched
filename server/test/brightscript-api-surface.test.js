'use strict';

// BrightScript cannot be run, linted or type-checked here — the only interpreter is a player. So a
// call to an object that does not exist looks exactly like a call to one that does, right up until
// a display in the field stops working.
//
// That is not hypothetical. `brightsign/*.brs` shipped with a whole family of ROKU APIs in it —
// roFileSystem, roMessageDigest, PostFromStringWithRetry — because BrightScript is Roku's language
// and the two references read almost identically. Each one silently disabled a feature: the
// self-update path could never mark a package applied, verification returned false unconditionally
// and burned an attempt counter, and a snapshot request raised "Member function not found" from
// inside the event loop, taking the player down. None of it was visible from here.
//
// This is the cheapest thing that would have caught all of it: a deny-list of APIs that exist on
// Roku and not on BrightSign, plus the argument-shape mistakes that made calls compile and then do
// nothing. It cannot prove the scripts are right. It does stop these specific, expensive mistakes
// coming back — and every entry below was paid for once already.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join(__dirname, '..', '..', 'brightsign');
const FILES = fs.readdirSync(DIR).filter((f) => f.endsWith('.brs'));

/** Source with comment lines stripped, so prose about a bug is not mistaken for the bug. */
function code(file) {
  return fs.readFileSync(path.join(DIR, file), 'utf8')
    .split('\n')
    .filter((l) => !/^\s*'/.test(l))
    .join('\n');
}

test('there are BrightScript files to check', () => {
  assert.ok(FILES.length >= 2, `expected the host scripts, found ${FILES.join(', ')}`);
});

// Objects that exist on Roku and NOT on BrightSign. Verified against BrightSign's Object Reference,
// which lists every ro* object the platform has.
const ROKU_ONLY = [
  ['roFileSystem', 'use the global MoveFile / DeleteFile / CopyFile, or roByteArray to read'],
  ['roMessageDigest', 'use roHashGenerator("sha256"); Hash() answers with an roByteArray'],
  ['roUnzip', 'use roBrightPackage — roUnzip is not the reader for a player package'],
  ['roRegistryKey', 'use roRegistrySection'],
  ['roAssociativeArrayEx', 'plain roAssociativeArray'],
  // roDeviceInfo.GetDeviceUniqueId() is real; a global of that name is not.
  ['roDataGramSocket', 'not a BrightSign object'],
];

for (const [obj, advice] of ROKU_ONLY) {
  test(`no ${obj} — it does not exist on BrightSign (${advice})`, () => {
    for (const f of FILES) {
      assert.ok(!code(f).includes(obj), `${f} calls ${obj}, which is a Roku object. ${advice}`);
    }
  });
}

// Methods that do not exist on the object they are called on.
const BAD_METHODS = [
  ['PostFromStringWithRetry', 'roUrlTransfer has no retry variant; AsyncPostFromString + roUrlEvent is how a POST body is read'],
  ['.Final(', 'roMessageDigest-era API; roHashGenerator returns the digest from Hash()'],
  ['OpenInputFile', 'no roFileSystem here; read with roByteArray.ReadFile'],
  // Each of these reads as obviously-correct and is documented NOT to exist on BrightSign.
  ['SetMessagePort', 'the setter is SetPort(roMessagePort) — SetMessagePort is Roku'],
  ['.WaitEvent(', 'roMessagePort has WaitMessage(timeout_ms); WaitEvent is Roku'],
  ['.SetAlgorithm(', 'roHashGenerator takes its algorithm as a CONSTRUCTOR argument'],
  ['.VerifyPackage(', 'roBrightPackage has no VerifyPackage — hash the bytes yourself'],
  ['.UnpackAll(', 'roBrightPackage has Unpack(path) and UnpackFile(name, path)'],
  ['SetOrientation(vm', 'roVideoMode has no SetOrientation — rotation is SetScreenModes()[i].transform'],
  // Nearly shipped 2026-08-10, while fixing the very thing it would have broken. BrightSign's
  // roDeviceInfo has NO network method of any kind — checked against the published Object
  // Reference, where the string does not occur once. The address comes from
  // roNetworkConfiguration(iface).GetCurrentConfig().ip4_address. Calling this would have raised
  // "Member function not found" from inside SendHostTelemetry, once a minute, forever.
  ['GetIPAddrs', 'roDeviceInfo has no network methods on BrightSign; use roNetworkConfiguration(iface).GetCurrentConfig().ip4_address'],
];

for (const [needle, advice] of BAD_METHODS) {
  test(`no ${needle.replace(/[.(]/g, '')} — ${advice}`, () => {
    for (const f of FILES) {
      assert.ok(!code(f).includes(needle), `${f} calls ${needle}. ${advice}`);
    }
  });
}

test('MatchFiles is called with a DIRECTORY and a bare pattern', () => {
  // The bug that made a deployment report an empty card while `dir SD:` listed the file. MatchFiles
  // takes a directory plus a pattern and is documented to return nothing when the pattern contains
  // a separator — so passing a path as the second argument answers "no" for every file that exists.
  for (const f of FILES) {
    for (const m of code(f).matchAll(/MatchFiles\(([^)]*)\)/g)) {
      const args = m[1].split(',').map((a) => a.trim());
      assert.equal(args.length, 2, `${f}: MatchFiles needs exactly two arguments, got ${m[0]}`);
      assert.ok(!/["'].*\/.*["']/.test(args[1]) && !/\+/.test(args[1]),
        `${f}: the MatchFiles PATTERN must not contain a path separator — ${m[0]}`);
    }
  }
});

test('Unpack() is never used as if it returned a boolean', () => {
  // Unpack(path) is declared As Void. `if not package.Unpack(...)` is a type error, not an error
  // check — and reads exactly like one. Success is proven by looking for an expected file instead.
  for (const f of FILES) {
    const src = code(f);
    assert.ok(!/if\s+not\s+\w*\.?Unpack\s*\(/i.test(src),
      `${f}: Unpack() returns Void — test for an extracted file rather than its return value`);
    assert.ok(!/=\s*\w*\.?Unpack\s*\(/i.test(src), `${f}: Unpack() returns nothing to assign`);
  }
});

test('Unpack() never targets a volume root', () => {
  // "Providing a destination path of SD:/ will wipe all preexisting files from the card." Unpacking
  // an update straight to the root would erase the player's provisioning and its whole content pool
  // as a side effect of a routine upgrade.
  for (const f of FILES) {
    for (const m of code(f).matchAll(/\.Unpack\(([^)]*)\)/g)) {
      const arg = m[1].trim();
      assert.ok(!/^(root|root\$)\s*\+\s*"\/"$/.test(arg) && !/^"[A-Z0-9]+:\/"$/.test(arg),
        `${f}: ${m[0]} unpacks to a volume root, which DELETES everything already there. Stage it.`);
    }
  }
});

test('roVideoMode.SetMode() is called with exactly one argument', () => {
  // SetMode(mode As String). A second argument is a "wrong number of function parameters" abort.
  // Rotation belongs to SetScreenModes(), whose config carries the transform.
  for (const f of FILES) {
    for (const m of code(f).matchAll(/\.SetMode\(([^)]*)\)/g)) {
      assert.equal(m[1].split(',').length, 1, `${f}: ${m[0]} — SetMode takes one argument`);
    }
  }
});

test('GetStorageStatus is not called with a USBn: drive string', () => {
  // Documented: "The results of the GetStorageStatus() method are unreliable when called with a
  // USBn: parameter." The drive strings it understands are "USB:", "SD:", "SSD:", "SD2:/", "Flash:".
  for (const f of FILES) {
    assert.ok(!/GetStorageStatus\(\s*"USB\d/i.test(code(f)),
      `${f}: GetStorageStatus is unreliable with USBn: — use "USB:"`);
  }
});

test('a load-error is reported with its uri, not a url', () => {
  // `url` is a key of download-request; a load-error carries `uri`. Reading the wrong one made the
  // only diagnostic that names the failing resource print "invalid" every time.
  for (const f of FILES) {
    const src = code(f);
    if (!src.includes('load-error')) continue;
    assert.ok(!/\bdata\.url\b/.test(src), `${f}: a load-error names its resource in data.uri`);
  }
});

test('parameters do not carry BOTH a type suffix and an As clause', () => {
  // `filePath$ As String` is a shape the reference never sanctions, and a parse error would stop
  // the script loading at all — the worst possible failure, since nothing would run to report it.
  for (const f of FILES) {
    for (const m of code(f).matchAll(/(?:Function|Sub)\s+\w+\s*\(([^)]*)\)/g)) {
      for (const param of m[1].split(',')) {
        assert.ok(!/[$%!#&]\s+As\s+/i.test(param),
          `${f}: parameter "${param.trim()}" has a type suffix and an As clause`);
      }
    }
  }
});

test('the storage root is resolved by probing, not assumed', () => {
  // Knowing only FLASH and SD meant that fitting real storage to a flash-booting player and moving
  // the deployment onto it resolved every derived path to a volume that was not there.
  const src = code('autorun.brs');
  const fn = src.slice(src.indexOf('Function StorageRoot'));
  for (const vol of ['SSD:', 'USB1:', 'FLASH:']) {
    assert.ok(fn.slice(0, 900).includes(vol), `StorageRoot() must consider ${vol}`);
  }
});

test('the widget storage path is absolute, on a real volume', () => {
  // "/cache" carries no drive specifier, so the widget's local storage has nowhere to persist.
  const src = code('autorun.brs');
  assert.ok(!/storage_path:\s*"\/[^"]*"/.test(src),
    'storage_path must name a volume — a bare "/path" is outside the writable volumes');
  assert.match(src, /storage_path:\s*StorageRoot\(\)/);
});

test('no doubled quotes inside a string literal — BrightScript has no escape sequences', () => {
  // The one that cost a player its boot. `"{""width"":"` is not an escaped quote; it is three
  // adjacent string literals with no operator between them, and the compiler rejects the WHOLE
  // FILE: "ScriptLoadError: Syntax Error. (compile error &h02) in SSD:/autorun.brs(196)". The
  // display came up with nothing at all — not a broken feature, no player. A quote in a literal has
  // to come from Chr(34).
  for (const f of FILES) {
    const lines = fs.readFileSync(path.join(DIR, f), 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (/^\s*'/.test(line)) return;
      // `""` hugged by non-delimiters is a literal trying to contain a quote; `, ""` or `("")` is
      // simply an empty string argument and is fine.
      assert.ok(!/[^\s(,=]""[^\s),]/.test(line),
        `${f}:${i + 1}: a string literal cannot contain a quote — build it with Chr(34)\n    ${line.trim()}`);
    });
  }
});

test('every string literal on a line is closed', () => {
  // An odd number of quotes is the same class of failure: it takes the whole script down, and
  // nothing here can run it to find out.
  for (const f of FILES) {
    const lines = fs.readFileSync(path.join(DIR, f), 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (/^\s*'/.test(line)) return;
      const beforeComment = line.split(/\s'(?=(?:[^"]*"[^"]*")*[^"]*$)/)[0];
      const quotes = (beforeComment.match(/"/g) || []).length;
      assert.equal(quotes % 2, 0, `${f}:${i + 1}: unbalanced quotes\n    ${line.trim()}`);
    });
  }
});

test('file existence is tested with roReadFile, not MatchFiles', () => {
  // MatchFiles is for LISTING a directory. Used as an existence check it has burned us twice: once
  // passing a full path as both arguments (never true for anything), and once passing a directory
  // plus a bare name, which STILL answered "no" for a file sitting in a volume root on a real
  // XT245 — silently skipping a staged update on every boot. BrightSign's own boilerplate uses
  // roReadFile + type(); so do we.
  for (const f of FILES) {
    const src = code(f);
    const helper = src.slice(src.indexOf('Function FileExists'));
    if (!helper) continue;
    assert.match(helper.slice(0, 300), /roReadFile/,
      `${f}: FileExists must use roReadFile — MatchFiles does not answer reliably for a volume root`);
  }
});

test('Str() is never applied to something that is already a string', () => {
  // Str(value As Float). Handing it a string is a type error that aborts wherever it runs — and the
  // place this was reached from is the event loop, i.e. it would take the player down while
  // reporting a diagnostic. Message keys documented as String need no conversion at all.
  for (const f of FILES) {
    for (const m of code(f).matchAll(/\bStr\((\w+(?:\.\w+)*)\)/g)) {
      assert.ok(/%$|^\d/.test(m[1]) || /count|len|size|retries|attempts/i.test(m[1]),
        `${f}: Str(${m[1]}) — Str is for numbers; a String needs no conversion`);
    }
  }
});

/* ---------------------------------------------------------------------------------------------
 * Rules added after a line-by-line pass against docs.brightsign.biz. Each one is a call that
 * compiles, reads correctly, and is documented to do something other than what it looks like.
 * ------------------------------------------------------------------------------------------- */

test('roVideoMode.SetOrientation does not exist — rotation is a SetScreenModes transform', () => {
  // Zero occurrences of SetOrientation in the roVideoMode reference. Rotation has two documented
  // routes and neither is a method on roVideoMode: the per-screen `transform` member of
  // SetScreenModes ("normal"/"90"/"180"/"270"), or roHtmlWidget's `transform` init parameter
  // ("identity"/"rot90"/"rot180"/"rot270") — note the two use DIFFERENT vocabularies.
  for (const f of FILES) {
    for (const m of code(f).matchAll(/(\w+)\.SetOrientation\s*\(/g)) {
      assert.fail(`${f}: ${m[0]} — roVideoMode has no SetOrientation. Use SetScreenModes()[i].transform`);
    }
  }
});

test('FindMemberFunction is itself feature-gated before it is used as a guard', () => {
  // "It is only available if roDeviceInfo.HasFeature("FindMemberFunction") returns true." Calling it
  // on a player without the feature is a runtime error — and both call sites here are reached from
  // the EVENT LOOP (the boot capability probe, and host telemetry every 60s), so on such a player
  // the host would die within a minute and take the display with it. The guard needed guarding.
  for (const f of FILES) {
    const src = code(f);
    if (!src.includes('FindMemberFunction(')) continue;
    assert.match(src, /HasFeature\("FindMemberFunction"\)/,
      `${f}: FindMemberFunction is only available when roDeviceInfo.HasFeature("FindMemberFunction") is true`);
    // ...and every call must sit behind that check, not merely somewhere in the same file.
    for (const m of src.matchAll(/^(?!.*HasFeature).*\bFindMemberFunction\(/gm)) {
      const line = m[0];
      assert.ok(/HasFindMember\(\)|HasFeature/.test(src.slice(Math.max(0, src.indexOf(line) - 400), src.indexOf(line))),
        `${f}: this FindMemberFunction call is not behind a HasFeature guard:\n    ${line.trim()}`);
    }
  }
});

test('GetStorageStatus is never handed a drive string straight from GetStorages()', () => {
  // The two speak DIFFERENT vocabularies. GetStorages() answers ["USB1:/", "SD:/", "SD2:/", "SSD:/",
  // "Flash:/"] — trailing slash, USB numbered — while GetStorageStatus() understands "USB:", "SD:",
  // "SSD:", "SD2:/", "Flash:" and is documented as UNRELIABLE for "USBn:". Feeding the enumerator's
  // output back in re-creates the bug the static fallback list exists to avoid, and only on the OS
  // versions that HAVE the enumerator — so it looks fine in testing.
  for (const f of FILES) {
    const src = code(f);
    if (!src.includes('GetStorageStatus')) continue;
    for (const m of src.matchAll(/GetStorageStatus\(([^)]*)\)/g)) {
      const arg = m[1].trim();
      assert.ok(/^"/.test(arg) || /StatusDrive\(/.test(arg),
        `${f}: ${m[0]} — normalise the drive first (StatusDrive) or pass a literal; GetStorages() speaks a different vocabulary`);
    }
  }
});

test('PostJSMessage keys are lowercase — BrightScript canonicalises them on the way to JS', () => {
  // BrightScript associative-array keys created with object-literal syntax are case-INSENSITIVE and
  // arrive lowercased on the JavaScript side. BrightSign's own sample sends
  // `{serialNumber: ...}` and reads `msg["serialnumber"]`. A camelCase key here is therefore a field
  // the bridge reads as undefined, silently, with no error anywhere.
  for (const f of FILES) {
    for (const m of code(f).matchAll(/PostJSMessage\(\{([\s\S]*?)\}\)/g)) {
      for (const km of m[1].matchAll(/(?:^|[,\n])\s*([A-Za-z_]\w*)\s*:/g)) {
        assert.equal(km[1], km[1].toLowerCase(),
          `${f}: PostJSMessage key "${km[1]}" is not lowercase — it arrives in JavaScript lowercased and the reader sees undefined`);
      }
    }
  }
});

test('PostJSMessage payloads are flat — nested associative arrays are not supported', () => {
  // "This method does not support passing nested associative arrays." A nested value is dropped, so
  // the message arrives looking well-formed and missing the part that mattered.
  for (const f of FILES) {
    for (const m of code(f).matchAll(/PostJSMessage\(\{([\s\S]*?)\}\)/g)) {
      assert.ok(!/:\s*\{/.test(m[1]),
        `${f}: PostJSMessage carries a nested associative array, which BrightSign drops:\n    ${m[0].slice(0, 160)}`);
    }
  }
});

test('roUrlTransfer.SetPort takes a message port, never a TCP port number', () => {
  // ifMessagePort.SetPort(port As roMessagePort). There is no integer overload — a TCP port belongs
  // in the URL string. Passing a number here reads exactly like configuring a port and configures
  // nothing.
  for (const f of FILES) {
    for (const m of code(f).matchAll(/\.SetPort\(([^)]*)\)/g)) {
      assert.ok(!/^\d+$/.test(m[1].trim()),
        `${f}: ${m[0]} — SetPort takes an roMessagePort; put a TCP port in the URL`);
    }
  }
});

test('roBrightPackage is constructed with a filename string, not an associative array', () => {
  // "created with a filename parameter that specifies the name of the .zip file". A password goes
  // through SetPassword() afterwards. An AA here is the Roku-shaped guess.
  for (const f of FILES) {
    for (const m of code(f).matchAll(/CreateObject\("roBrightPackage"\s*,\s*([^)]*)\)/g)) {
      assert.ok(!m[1].trim().startsWith('{'),
        `${f}: ${m[0]} — roBrightPackage takes a filename String; use SetPassword() for a password`);
    }
  }
});

test('the widget storage quota is not a string', () => {
  // "A BrightScript integer is only guaranteed to be able to represent a count of bytes up to 2GB so
  // avoid using integers... Use float or double instead... (string can also be used but is not
  // recommended)."
  const src = code('autorun.brs');
  assert.ok(!/storage_quota:\s*"/.test(src), 'storage_quota should be a double, not a string');
  assert.match(src, /storage_quota:\s*\d+\.\d/, 'storage_quota must be a double literal');
});

test('nodejs_enabled is what gates require("@brightsign/*")', () => {
  // The bridge is entirely require()-based. brightsign_js_objects_enabled gates the LEGACY GLOBALS
  // (BSDeviceInfo, BSMessagePort) and not the modules — BrightSign's own cookbook calls
  // require("@brightsign/bt") with nodejs_enabled alone. Losing nodejs_enabled costs the player its
  // identity and its restart delegation, silently.
  const src = code('autorun.brs');
  assert.match(src, /nodejs_enabled:\s*true/, 'without this there are no @brightsign modules at all');
});

test('a second widget is never given the first screen\'s rectangle', () => {
  // roHtmlWidget has NO output selector — not in its init parameters, not in the JavaScript
  // HtmlWidgetParams. A second output is addressed by building one tall canvas with SetScreenModes
  // and placing the widget at that output's display_x/display_y. Reusing the full-screen rect puts
  // both widgets on output ONE, on top of each other, while output two stays dark.
  const src = code('autorun.brs');
  if (!/widget2\s*=\s*MakeWidget/.test(src)) return;
  // Split on TOP-LEVEL commas: the first argument is itself a call (PlayerUrl(cfg, screen2)), and a
  // naive split lands on its inner comma and inspects the wrong argument — which is how the first
  // draft of this rule passed against the very source it was written to reject.
  const call = /widget2\s*=\s*MakeWidget\((.*)\)\s*$/m.exec(src);
  assert.ok(call, 'could not find the second widget');
  const args = [];
  let depth = 0;
  let cur = '';
  for (const ch of call[1]) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { args.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  args.push(cur.trim());
  assert.equal(args.length, 4, `unexpected MakeWidget arity: ${call[0]}`);
  assert.notEqual(args[1], 'rect',
    'the second widget must be positioned at the second output\'s canvas offset, not at rect');
});

test('storage is probed directly, not only through the mount check', () => {
  // The mount check is roStorageHotplug.GetStorageStatus(), whose documented drive strings are
  // "SD:", "SSD:" and "USB:" — internal FLASH: is not one of them, and the object may not exist on
  // an older build at all. Gating the whole probe on it made "cannot say" indistinguishable from
  // "no disk", and a player with an NVMe in it reported 1025 MB: the widget's own cache quota,
  // reported through the navigator.storage.estimate() fallback in st-bridge.js, because the host
  // had answered present:false.
  //
  // roStorageInfo is the direct question and needs no hotplug object. A volume that reports a
  // non-zero size IS the disk.
  const src = code('autorun.brs');
  const probe = /Function StorageProbe\(\)[\s\S]*?\nEnd Function/.exec(src);
  assert.ok(probe, 'StorageProbe went missing');
  const body = probe[0];
  // A second pass that does not consult `mounted` at all.
  const passes = body.split(/for each raw in volumes/).length - 1;
  assert.ok(passes >= 2, 'the probe must fall back to asking the volumes directly');
  assert.ok(/FLASH:/i.test(body),
    'internal flash must be on the list the direct pass walks — it is how a card-less player boots');
  // And the direct pass must reject a volume that answers zero, or every player "has" every drive.
  const fill = /Function FillStorage\([\s\S]*?\nEnd Function/.exec(src);
  assert.ok(fill, 'FillStorage went missing');
  assert.match(fill[0], /total\s*=\s*invalid\s+or\s+total\s*<=\s*0/,
    'a volume that reports no size is not a disk');
});
