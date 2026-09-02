'use strict';

// The web player's set_volume handler, and the mute state it is not allowed to touch.
//
// Two bugs lived here at once, and the second is why fixing the first alone would have been worse
// than leaving it broken:
//
//   1. THE KEY. The dashboard sends `{ level: <0..1> }` (device-detail.js: slider/100) and the
//      Android player reads exactly that (`optDouble("level")`). The web player read
//      `payload.value`. Nothing in the product sends `value`, so the slider was a silent no-op on
//      every browser panel — and a no-op is invisible: the command is delivered, acked, and does
//      nothing.
//   2. THE SCALE. The local was named `pct` and divided by 100. Had only the key been corrected,
//      `level: 0.5` would have become 0.5% — near-silence that LOOKS like the fix worked, because
//      the handler now runs and the element's volume genuinely changes.
//
// And separately: setMediaVolume() wrote `el.muted = (v === 0)`, so any non-zero volume command
// un-muted whatever was playing — defeating a per-item mute an operator had set on purpose
// (reproduced in a browser: item flagged muted, one set_volume, muted went false), and defying the
// autoplay rule in lib/media-mute.js, where unmuting without a gesture costs the video.
//
// The real functions are extracted from index.html and run against fake globals, so this asserts
// what the shipped player does rather than a paraphrase of it.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'player', 'index.html'), 'utf8');

/** Extract a top-level `function name(...) { ... }` from the player by brace matching. */
function extract(name) {
  const start = HTML.indexOf(`    function ${name}(`);
  assert.notEqual(start, -1, `${name}() must exist in the player`);
  let depth = 0;
  for (let i = HTML.indexOf('{', start); i < HTML.length; i++) {
    if (HTML[i] === '{') depth++;
    else if (HTML[i] === '}' && --depth === 0) return HTML.slice(start, i + 1);
  }
  throw new Error(`unterminated ${name}()`);
}

function loadVolumeParser() {
  const sandbox = { console: { log() {}, warn() {} } };
  vm.createContext(sandbox);
  vm.runInContext(extract('volumeLevelFromCommand'), sandbox);
  return (data) => vm.runInContext('volumeLevelFromCommand', sandbox)(data);
}

/**
 * setMediaVolume() against fake media elements. Returns the elements so the test can see exactly
 * which properties were written.
 */
function loadSetVolume({ wallFollower = false, elements } = {}) {
  const els = elements || [
    { tagName: 'VIDEO', volume: 1, muted: false },
    { tagName: 'VIDEO', volume: 1, muted: true },
  ];
  const sandbox = {
    console: { log() {}, warn() {} },
    document: { querySelectorAll: () => els },
    isWallFollower: () => wallFollower,
    mediaVolume: null,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext('let mediaVolume = null;\n' + extract('setMediaVolume'), sandbox);
  return { els, call: (v) => vm.runInContext('setMediaVolume', sandbox)(v), sandbox };
}

// ---------------------------------------------------------------------------------------------
// THE WIRE FORM

test('THE BUG: the key the dashboard actually sends is honoured', () => {
  const parse = loadVolumeParser();
  assert.equal(parse({ type: 'set_volume', payload: { level: 0.5 } }), 0.5);
});

test('THE OTHER HALF: a fraction is not divided by 100', () => {
  // The trap. 0.5 -> 0.005 is near-mute and would read as "fixed" to anyone checking that the
  // handler fires at all.
  const parse = loadVolumeParser();
  assert.equal(parse({ type: 'set_volume', payload: { level: 0.5 } }), 0.5);
  assert.equal(parse({ type: 'set_volume', payload: { level: 1 } }), 1);
  assert.equal(parse({ type: 'set_volume', payload: { level: 0 } }), 0);
});

test('the legacy percentage key is still understood, as a percentage', () => {
  const parse = loadVolumeParser();
  assert.equal(parse({ type: 'set_volume', payload: { value: 80 } }), 0.8);
  assert.equal(parse({ type: 'set_volume', value: 25 }), 0.25);   // top-level, as the old code read it
});

test('the scale comes from the KEY, never from the magnitude', () => {
  // 1 is legal in both conventions — full volume as a fraction, 1% as a percentage. A magnitude
  // heuristic has to be wrong for one of them, so there is no heuristic.
  const parse = loadVolumeParser();
  assert.equal(parse({ payload: { level: 1 } }), 1, 'level:1 is FULL volume');
  assert.equal(parse({ payload: { value: 1 } }), 0.01, 'value:1 is one percent');
});

test('level wins when a caller sends both', () => {
  const parse = loadVolumeParser();
  assert.equal(parse({ payload: { level: 0.3, value: 90 } }), 0.3);
});

test('out-of-range input is clamped, not wrapped', () => {
  const parse = loadVolumeParser();
  assert.equal(parse({ payload: { level: 4 } }), 1);
  assert.equal(parse({ payload: { level: -2 } }), 0);
  assert.equal(parse({ payload: { value: 5000 } }), 1);
});

test('a command carrying no level is refused rather than turned into 0', () => {
  // Returning 0 for "no value" would silence a display on a malformed command — a failure that
  // looks exactly like someone dragging the slider down.
  const parse = loadVolumeParser();
  for (const bad of [{}, { payload: {} }, { payload: { level: null } }, { payload: { level: '' } },
    { payload: { level: 'loud' } }, { payload: { level: true } }, null, undefined]) {
    assert.equal(parse(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

test('numeric strings are accepted — an integrator posting JSON as text still works', () => {
  const parse = loadVolumeParser();
  assert.equal(parse({ payload: { level: '0.4' } }), 0.4);
  assert.equal(parse({ payload: { value: '70' } }), 0.7);
});

// ---------------------------------------------------------------------------------------------
// WHAT IT IS NOT ALLOWED TO TOUCH

test('THE BUG: a volume command does not un-mute a deliberately muted item', () => {
  const { els, call } = loadSetVolume();
  els[1].muted = true;                        // an operator silenced this item
  call(0.6);
  assert.equal(els[1].volume, 0.6, 'the level still applies');
  assert.equal(els[1].muted, true, 'a muted element must stay muted');
  assert.equal(els[0].muted, false, 'and an unmuted one must stay unmuted');
});

test('volume 0 does not need to set muted — the level alone is silence', () => {
  const { els, call } = loadSetVolume();
  call(0);
  assert.equal(els[0].volume, 0);
  assert.equal(els[0].muted, false, 'mute is not this function\'s decision to make');
});

test('a wall follower is left silent — volume never reaches its elements', () => {
  // One audio source per wall. A follower that honoured the slider would give the room the same
  // track from every panel, a few milliseconds apart.
  const { els, call } = loadSetVolume({ wallFollower: true });
  call(0.9);
  assert.equal(els[0].volume, 1, 'untouched');
});

test('the level is remembered so it survives the next item', () => {
  const { call, sandbox } = loadSetVolume();
  call(0.35);
  assert.equal(vm.runInContext('mediaVolume', sandbox), 0.35);
});

test('an element torn down mid-call cannot break the loop', () => {
  const boom = { tagName: 'VIDEO', set volume(v) { throw new Error('detached'); }, muted: false };
  const good = { tagName: 'VIDEO', volume: 1, muted: false };
  const { call } = loadSetVolume({ elements: [boom, good] });
  call(0.5);
  assert.equal(good.volume, 0.5, 'the surviving element still gets the level');
});

// ---------------------------------------------------------------------------------------------
// THE HANDLER WIRING — the parser is useless if the socket handler does not call it

test('the set_volume handler routes through the parser and setMediaVolume', () => {
  const handler = HTML.slice(HTML.indexOf("if (data.type === 'set_volume')"));
  const block = handler.slice(0, handler.indexOf('\n        }') + 10);
  assert.match(block, /volumeLevelFromCommand\(data\)/, 'the handler must use the shared parser');
  assert.match(block, /setMediaVolume\(/, 'and apply it');
  assert.ok(!/\/\s*100/.test(block), 'the handler must not re-scale — the parser already returns 0..1');
});
