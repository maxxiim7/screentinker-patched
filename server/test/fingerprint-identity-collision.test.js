'use strict';

// A display's fingerprint used to be derived ONLY from hardware traits — user agent, screen
// geometry, colour depth, timezone, core count, platform, canvas raster. Every one of those
// describes a MODEL, not a unit. Two identical panels therefore produced the same value, and the
// server treated that value as an identity.
//
// Observed live: two UniFi Pro Displays at DIFFERENT sites both produced web-m73u8w-5f. The
// second one could not be onboarded at all — the server saw a known identity with a live socket
// and refused it, ten times in a row. That is the benign half. The other half is that the guard
// which refused it is a liveness check: had the first display been offline, the second would have
// been handed that row's identity, a freshly minted token, and its playlist and content. The
// fingerprint lookup is global — not scoped to a workspace or an owner — so "identical hardware"
// is the only precondition.
//
// The rules pinned here:
//   1. Two installs on identical hardware get DIFFERENT identities.
//   2. The hardware value is still sent, but only ever MIGRATES a caller that has already proved
//      itself by token onto its OWN row. A caller without credentials never resolves through it,
//      however few rows it appears to match — "exactly one row" means one row was recorded, not
//      that one display exists, and that distinction is the whole bug. Such a caller is
//      provisioned a new device: one pairing code, and it cannot be wrong.
//   3. Clients that send no hardware value (older players, and the APK/.wgt whose fingerprint is
//      a genuinely per-unit hardware id) behave exactly as they did before.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');

const DATA_DIR = path.join(os.tmpdir(), 'st-fpid-' + crypto.randomBytes(4).toString('hex'));
fs.mkdirSync(path.join(DATA_DIR, 'db'), { recursive: true });
process.env.DATA_DIR = DATA_DIR;
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';

const { db } = require('../db/database');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'player', 'index.html'), 'utf8');

after(() => { try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* */ } });

// ---------------------------------------------------------------- client: distinct identities

// Run the real client function against a fake localStorage, one per simulated panel.
function makePanel(hw, store = {}, screenSuffix = '') {
  const start = HTML.indexOf('function generateBrowserFingerprint()');
  assert.notEqual(start, -1);
  let depth = 0, end = -1;
  for (let j = HTML.indexOf('{', start); j < HTML.length; j++) {
    if (HTML[j] === '{') depth++;
    else if (HTML[j] === '}' && --depth === 0) { end = j + 1; break; }
  }
  const src = HTML.slice(start, end);
  const scope = {
    // A dual-output BrightSign runs two widgets against one localStorage, so the install
    // salt is namespaced per output. Empty for every single-output player.
    SCREEN_SUFFIX: screenSuffix,
    generateHardwareFingerprint: () => hw,
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
    },
    window: { crypto: { getRandomValues: (b) => crypto.randomFillSync(b) } },
  };
  const fn = new Function(...Object.keys(scope), `${src} return generateBrowserFingerprint;`)(...Object.values(scope));
  return { fp: fn, store };
}

test('THE BUG: two identical panels no longer share an identity', () => {
  const HW = 'web-m73u8w-5f';           // the value both UniFi displays actually produced
  const a = makePanel(HW), b = makePanel(HW);
  assert.notEqual(a.fp(), b.fp(), 'identical hardware, different identities');
  assert.ok(a.fp().startsWith(HW), 'the hardware value is still recognisable inside it');
});

test('two OUTPUTS of one dual-HDMI player also get distinct identities', () => {
  // autorun.brs gives the second HDMI output its own widget; both share an origin and one
  // localStorage. Without the per-output salt they would fingerprint identically and the server
  // would merge them into a single device row.
  const HW = 'web-m73u8w-5f';
  const shared = {};
  const out1 = makePanel(HW, shared, '');
  const out2 = makePanel(HW, shared, '_s2');
  assert.notEqual(out1.fp(), out2.fp(), 'one player, two screens, two displays');
});

test('an identity is stable across reloads of the same install', () => {
  const p = makePanel('web-m73u8w-5f');
  assert.equal(p.fp(), p.fp(), 'same call twice');
  const again = makePanel('web-m73u8w-5f', p.store);   // same storage = same install
  assert.equal(again.fp(), p.fp(), 'a reload keeps the identity');
});

test('clearing storage mints a new identity — that IS a new install', () => {
  const p = makePanel('web-m73u8w-5f');
  const before = p.fp();
  delete p.store.st_install_id;
  assert.notEqual(p.fp(), before);
});

test('storage being unavailable degrades to hardware rather than to nothing', () => {
  const start = HTML.indexOf('function generateBrowserFingerprint()');
  let depth = 0, end = -1;
  for (let j = HTML.indexOf('{', start); j < HTML.length; j++) {
    if (HTML[j] === '{') depth++;
    else if (HTML[j] === '}' && --depth === 0) { end = j + 1; break; }
  }
  const scope = {
    SCREEN_SUFFIX: '',
    generateHardwareFingerprint: () => 'web-hw',
    localStorage: { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } },
    window: { crypto: { getRandomValues: (b) => crypto.randomFillSync(b) } },
  };
  const fn = new Function(...Object.keys(scope), `${HTML.slice(start, end)} return generateBrowserFingerprint;`)(...Object.values(scope));
  assert.equal(fn(), 'web-hw', 'still identifies itself; the server treats ambiguity as unknown');
});

// ---------------------------------------------------------------- server: the ambiguity rule

const mkDevice = (name) => {
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO devices (id,name,status,created_at) VALUES (?,?,'offline',strftime('%s','now'))`).run(id, name);
  return id;
};
const addFp = (fp, deviceId, hw) =>
  db.prepare('INSERT INTO device_fingerprints (fingerprint, device_id, hw_fingerprint) VALUES (?,?,?)').run(fp, deviceId, hw);

// The server's resolution rule, exercised directly. `provenDeviceId` is non-null only when the
// caller authenticated with a valid device_id + token.
function resolve(fingerprint, hw, provenDeviceId = null) {
  let existing = db.prepare('SELECT * FROM device_fingerprints WHERE fingerprint = ?').get(fingerprint);
  if (!existing && hw && provenDeviceId) {
    const c = db.prepare(
      'SELECT * FROM device_fingerprints WHERE (hw_fingerprint = ? OR fingerprint = ?) AND device_id = ?')
      .all(hw, hw, provenDeviceId);
    if (c.length === 1) existing = c[0];
  }
  return existing;
}

test('the hardware column exists — the migration is wired up', () => {
  const cols = db.prepare('PRAGMA table_info(device_fingerprints)').all().map(c => c.name);
  assert.ok(cols.includes('hw_fingerprint'));
});

test('the SHIPPED handler enforces this, not just resolve() above', () => {
  // resolve() mirrors the server's rule; without this the whole server half of the file would
  // pass against an unfixed deviceSocket.js.
  const src = fs.readFileSync(path.join(__dirname, '..', 'ws', 'deviceSocket.js'), 'utf8');
  const i = src.indexOf('hw_fingerprint && tokenProven');
  assert.notEqual(i, -1, 'the hint is gated on the caller having proved identity');
  const block = src.slice(i, i + 700);
  assert.match(block, /AND device_id = \?/, 'and the lookup is bound to that proven device_id');
  assert.match(src, /const tokenProven = !!\(device_id && validateDeviceToken\(/,
    'proof is a real token check, not merely a device_id being present');
});

test('THE SECURITY RULE: a caller with no credentials never resolves via hardware', () => {
  const HW = 'web-shared-model';
  const victim = mkDevice('Customer A screen');
  addFp('web-shared-model-aaaa', victim, HW);

  // A different identical panel arrives with an identity nobody has seen and no credentials.
  // Exactly ONE row carries this hardware value — and acting on that would be the takeover.
  // One row recorded does not mean one display exists.
  assert.equal(resolve('web-shared-model-cccc', HW, null), undefined,
    'an unauthenticated caller is provisioned fresh rather than handed the row');
});

test('and still not, even when several rows share the hardware', () => {
  const HW = 'web-shared-model-2';
  addFp('web-shared-model-2-aaaa', mkDevice('A'), HW);
  addFp('web-shared-model-2-bbbb', mkDevice('B'), HW);
  assert.equal(resolve('web-shared-model-2-cccc', HW, null), undefined);
});

test('an AUTHENTICATED player migrates its own row to the new identity', () => {
  // The backwards-compatible path: an existing player keeps device_id + token across an update
  // and only needs its stored fingerprint moved to the salted form.
  const HW = 'web-unique-model';
  const dev = mkDevice('Existing panel');
  addFp('web-unique-model-old', dev, HW);
  const got = resolve('web-unique-model-new', HW, dev);
  assert.ok(got, 'identity was already proven by token; the hint only locates the row');
  assert.equal(got.device_id, dev, 'and only ever its OWN row');
});

test('an authenticated player cannot migrate someone ELSE\'s row', () => {
  const HW = 'web-shared-model-3';
  const theirs = mkDevice('Someone else');
  addFp('web-shared-model-3-theirs', theirs, HW);
  const mine = mkDevice('Me');
  assert.equal(resolve('web-shared-model-3-mine', HW, mine), undefined,
    'the lookup is bound to the authenticated device_id');
});

test('an exact identity match never consults the hint', () => {
  const dev = mkDevice('Known');
  addFp('web-exact-1234', dev, 'web-exact');
  const got = resolve('web-exact-1234', 'web-totally-different', dev);
  assert.equal(got.device_id, dev, 'the identity wins; the hint is only a fallback');
});

test('a legacy row whose stored value IS the bare hardware value still migrates', () => {
  // Pre-upgrade rows have fingerprint = the hardware value and hw_fingerprint = NULL.
  const HW = 'web-legacy-9z';
  const dev = mkDevice('Legacy panel');
  db.prepare('INSERT INTO device_fingerprints (fingerprint, device_id) VALUES (?,?)').run(HW, dev);
  const got = resolve('web-legacy-9z-newsalt', HW, dev);
  assert.ok(got, 'the old bare value is found by the hint');
  assert.equal(got.device_id, dev, 'so the existing fleet is not orphaned by this change');
});

test('no hint at all means exact-match-only, exactly as before', () => {
  const dev = mkDevice('Old client');
  addFp('apk-hardware-id-42', dev, null);
  assert.ok(resolve('apk-hardware-id-42', undefined, dev), 'clients that send no hint are unaffected');
  assert.equal(resolve('apk-unknown-id', undefined, dev), undefined);
});
