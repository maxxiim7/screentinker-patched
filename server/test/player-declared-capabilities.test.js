'use strict';

// The same index.html is BOTH the browser player and the BrightSign player. Identical code,
// wildly different powers depending on whether a host bridge answered.
//
// That is why the declaration is computed rather than constant, and why it is worth testing: a
// browser tab claiming `system.reboot` puts a button on the dashboard that cannot ever work, and
// a BrightSign failing to claim it hides one that would. Both are the same bug in opposite
// directions.
//
// The real function is extracted from index.html and run against fake globals, so this asserts
// what the player will actually send rather than a reimplementation of it.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { CAP_SET } = require('../lib/player-capabilities');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'player', 'index.html'), 'utf8');

/** Pull declaredCapabilities() out of the player and run it in a controlled world. */
function declare({ host = false, sync = false, transitions = false, canvas = true, sw = true, swRefused = false } = {}) {
  const start = HTML.indexOf('    function declaredCapabilities() {');
  assert.notEqual(start, -1, 'declaredCapabilities() must exist in the player');
  let depth = 0, end = -1;
  for (let i = HTML.indexOf('{', start); i < HTML.length; i++) {
    if (HTML[i] === '{') depth++;
    else if (HTML[i] === '}' && --depth === 0) { end = i + 1; break; }
  }
  const src = HTML.slice(start, end);

  const sandbox = {
    console: { log() {}, warn() {} },
    // `sw` now means "a worker is IN CONTROL", not merely "the API exists" — those are different
    // things, and a real BrightSign widget is the difference (see the test below).
    navigator: sw ? { serviceWorker: { controller: {} } } : (swRefused ? { serviceWorker: {} } : {}),
    document: {
      createElement: () => (canvas
        ? { width: 0, height: 0, getContext: () => ({ drawImage() {} }), toDataURL: () => 'data:,' }
        : { width: 0, height: 0, getContext: () => null }),
    },
    BS: host ? { hasHost: () => true } : null,
  };
  sandbox.swRegistrationFailed = swRefused;
  sandbox.window = sandbox;
  if (sync) sandbox.ScreenTinkerBSSync = { available: () => true };
  // The real runtime globals the player's own transitionRuntimeReady() checks. An earlier draft
  // faked a global that does not exist, which passed a test while declaring nothing.
  if (transitions) {
    sandbox.TransitionRenderer = {};
    sandbox.TransitionParams = {};
    sandbox.__TRANSITION_SHADERS = {};
  }

  vm.createContext(sandbox);
  // declaredCapabilities() calls transitionRuntimeReady(), which lives elsewhere in the player.
  const predicate = 'function transitionRuntimeReady() { return !!(window.TransitionRenderer && window.TransitionParams && window.__TRANSITION_SHADERS); }';
  vm.runInContext(`${predicate}\n${src}\nvar __out = declaredCapabilities();`, sandbox);
  return sandbox.__out;
}

test('every declared name is a real capability the server understands', () => {
  // A typo here is silently dropped by parseDeclared, so the control just never appears.
  for (const c of declare({ host: true, sync: true, transitions: true })) {
    assert.ok(CAP_SET.has(c), `player declares unknown capability "${c}"`);
  }
});

test('THE LIE WE ARE REMOVING: a browser tab does not claim host-only powers', () => {
  const web = declare({ host: false });
  for (const cap of ['system.reboot', 'display.power', 'display.resolution', 'system.self_update']) {
    assert.ok(!web.includes(cap), `a browser tab must not claim ${cap}`);
  }
});

test('the same code behind a live host DOES claim them', () => {
  const bs = declare({ host: true });
  for (const cap of ['system.reboot', 'display.power', 'display.resolution', 'system.self_update']) {
    assert.ok(bs.includes(cap), `a hosted player must claim ${cap}`);
  }
});

test('what both share is declared by both', () => {
  const web = declare({ host: false });
  const bs = declare({ host: true });
  for (const cap of ['playback.video', 'playback.zones', 'audio.mute', 'audio.volume',
    'display.rotation', 'remote.input', 'system.restart_player', 'sync.clock']) {
    assert.ok(web.includes(cap), `web should declare ${cap}`);
    assert.ok(bs.includes(cap), `hosted should declare ${cap}`);
  }
});

test('native sync depends on the module resolving, not on being a BrightSign', () => {
  // BOS 8.2.10+ is a firmware question. A hosted player on older firmware has no SyncManager and
  // must not offer frame-accurate sync it cannot perform.
  assert.ok(!declare({ host: true, sync: false }).includes('sync.native'));
  assert.ok(declare({ host: true, sync: true }).includes('sync.native'));
});

test('screenshots are claimed only when there is something to draw on', () => {
  assert.ok(declare({ canvas: true }).includes('remote.screenshot'));
  assert.ok(!declare({ canvas: false }).includes('remote.screenshot'));
});

test('offline cache follows a worker that is actually IN CONTROL', () => {
  assert.ok(declare({ sw: true }).includes('offline.cache'));
  assert.ok(!declare({ sw: false }).includes('offline.cache'));
});

test('THE BRIGHTSIGN CASE: the API exists, no worker controls the page, so no claim', () => {
  // Found on real hardware. A BrightSign XT245 on alpha has navigator.serviceWorker, passes an
  // `'serviceWorker' in navigator` check, and then never even fetches sw.js — its widget runtime
  // refuses to register one. It was advertising offline.cache to the fleet while being unable to
  // cache a single byte, which is precisely the lie this whole capability model exists to stop.
  const caps = declare({ swRefused: true });
  assert.ok(!caps.includes('offline.cache'), 'a runtime that will not run a worker must not claim to cache');
  assert.ok(caps.includes('playback.video'), 'and it must still declare what it genuinely can do');
});

test('transitions are declared only when the bundle actually loaded', () => {
  // It is a progressive enhancement — a failed load means hard cuts, not a broken player.
  assert.ok(!declare({ transitions: false }).includes('playback.transitions'));
  assert.ok(declare({ transitions: true }).includes('playback.transitions'));
});

test('a hostile environment degrades instead of throwing during registration', () => {
  // This runs inside register(). Throwing here would cost the display its registration entirely,
  // which is a far worse outcome than an under-declared capability set.
  assert.doesNotThrow(() => declare({ canvas: false, sw: false, host: false }));
});
