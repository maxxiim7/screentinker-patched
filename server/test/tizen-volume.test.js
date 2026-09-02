'use strict';

/*
 * The volume slider, end to end.
 *
 * The dashboard sends `set_volume` with `{ level: <0..1 fraction> }`
 * (frontend/js/views/device-detail.js: `{ level: parseInt(el.value, 10) / 100 }`). The Android
 * player reads exactly that (`payload.optDouble("level")`). The Tizen player read `value`/`volume`
 * as a 0..100 PERCENTAGE, so it matched nothing the dashboard has ever sent: every slider move
 * logged "no usable value in payload" and changed nothing, on a panel that declared audio.volume as
 * a working capability.
 *
 * Two mistakes, and fixing either one alone is worse than fixing neither:
 *   - the KEY:   `level`, not `value`/`volume`
 *   - the SCALE: a fraction, not a percentage
 * Take `level` while still treating it as a percentage and a request for 50% becomes 0.5% — silent,
 * and indistinguishable from a slider that works.
 *
 * The handler is EXECUTED here, lifted out of the shipped app.js the same way the wall-geometry
 * parity test lifts the Tizen tile maths. A regex asserting that the file mentions "level" would
 * pass on the 0.5%-instead-of-50% version, which is the one failure mode that matters.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const APP = fs.readFileSync(path.join(ROOT, 'tizen', 'js', 'app.js'), 'utf8');

/**
 * Lift the real applyVolume out of app.js and run it against recording stubs.
 * Returns { set(payload) -> {tv, media, warned} }.
 */
function loadHandler({ hasTvAudio = true } = {}) {
  const m = /(\n\s*var mediaVolume = null;[\s\S]*?\n  function applyVolume\(payload\) \{[\s\S]*?\n  \})/.exec(APP);
  assert.ok(m, 'could not find applyVolume in tizen/js/app.js');

  const calls = { tv: null, media: null, logs: [] };

  // A vm context rather than `new Function`, because the handler reaches STCapabilities as a BARE
  // global (`window.STCapabilities ? STCapabilities.tvAudio() : null`) — a local `var window` would
  // leave that a ReferenceError, the try/catch would swallow it, and the test would silently
  // exercise only the fallback path while claiming to cover the TV one.
  const vm = require('node:vm');
  const sandbox = {
    STCapabilities: {
      tvAudio: () => (hasTvAudio ? { setVolume: (v) => { calls.tv = v; } } : null),
    },
    reportCmd: (level, cmd, msg) => calls.logs.push(level + ':' + msg),
    Number, Math, isFinite,
    __calls: calls,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`
    function applyMediaVolume() { __calls.media = mediaVolume; }
    ${m[1]}
  `, sandbox);
  const harness = sandbox.applyVolume;
  assert.equal(typeof harness, 'function');

  return {
    set(payload) {
      calls.tv = null; calls.media = null; calls.logs = [];
      harness(payload);
      return {
        tv: calls.tv,
        media: calls.media,
        warned: calls.logs.some((l) => l.startsWith('warn')),
        logs: calls.logs,
      };
    },
  };
}

test('THE DASHBOARD PAYLOAD: {level: 0..1} reaches the TV as 0..100', () => {
  const h = loadHandler();
  // Exactly what frontend/js/views/device-detail.js sends for slider positions 0 / 50 / 100.
  assert.deepEqual(h.set({ level: 0 }).tv, 0);
  assert.deepEqual(h.set({ level: 0.5 }).tv, 50, 'half volume must be 50, not 0.5');
  assert.deepEqual(h.set({ level: 1 }).tv, 100, 'full volume must be 100, not 1');
  assert.equal(h.set({ level: 0.5 }).warned, false, 'and must not report the payload unusable');
});

test('THE TRAP: reading `level` as a percentage would be inaudible, not merely wrong', () => {
  // 0.5 interpreted as a percentage is 0.5% — near silence. It changes the volume, logs success,
  // and looks from the dashboard exactly like a working slider. This is the assertion that
  // distinguishes a real fix from a plausible one.
  const h = loadHandler();
  assert.ok(h.set({ level: 0.5 }).tv > 1, 'a fraction must be scaled, not clamped into near-silence');
});

test('tvaudiocontrol is preferred — it is the volume that reaches the panel speakers', () => {
  // Tizen has two volumes and only one of them is audible on a TV: tizen.tvaudiocontrol is the
  // SET's own volume and applies to AVPlay video on the hardware plane, which the media elements
  // cannot touch at all. Portrait video (#170) plays through AVPlay, so a media-element-only
  // implementation would leave a rotated panel at full blast.
  const withTv = loadHandler({ hasTvAudio: true }).set({ level: 0.3 });
  assert.equal(withTv.tv, 30);
  assert.equal(withTv.media, null, 'the media fallback must not also run');
});

test('...and a build with no TV profile still moves the media elements', () => {
  // The URL-Launcher path and a plain browser have no tv.audio surface. Falling through keeps the
  // control honest rather than silently doing nothing.
  const noTv = loadHandler({ hasTvAudio: false }).set({ level: 0.4 });
  assert.equal(noTv.tv, null);
  assert.ok(Math.abs(noTv.media - 0.4) < 1e-9, 'media elements take a 0..1 fraction');
});

test('legacy percentage senders still work, so one dead control is not traded for another', () => {
  // The group-command route and hand-issued commands use `value`. These are percentages, not
  // fractions — a different key, so there is no ambiguity to resolve.
  const h = loadHandler();
  assert.equal(h.set({ value: 25 }).tv, 25);
  assert.equal(h.set({ volume: 70 }).tv, 70);
});

test('a payload with nothing usable is refused loudly rather than defaulting to silence', () => {
  const h = loadHandler();
  const r = h.set({ nothing: true });
  assert.equal(r.tv, null);
  assert.ok(r.warned, 'an unusable payload must say so — a silent 0 reads as broken hardware');
});

test('out-of-range values are clamped, not passed through to the panel API', () => {
  const h = loadHandler();
  assert.equal(h.set({ level: 5 }).tv, 100);
  assert.equal(h.set({ level: -2 }).tv, 0);
});

test('the dashboard really does send `level` as a fraction — the other half of the contract', () => {
  // Pinned against the sender, because this test is only meaningful while that stays true. If the
  // dashboard ever switches to percentages, this fails here instead of on a shop floor.
  const ui = fs.readFileSync(path.join(ROOT, 'frontend', 'js', 'views', 'device-detail.js'), 'utf8');
  assert.match(ui, /sendCommand\(device\.id, cmd, \{ level: parseInt\(el\.value, 10\) \/ 100 \}\)/,
    'the set_volume wire format is { level: 0..1 }');
});
