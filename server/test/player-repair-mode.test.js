'use strict';

// A display panel usually has no keyboard and no pointer. So any recovery path that WAITS
// for a click is not a recovery path at all — it is a dead end that needs someone to drive
// to the site and power-cycle the screen.
//
// That is what the unpaired / auth-error handlers used to do: they revealed the server-URL
// form (typing you cannot do) and HID the pairing section (the one thing that would rescue
// the screen). A real panel sat stuck on "Device was removed from the server" until it was
// physically reloaded, even though the player was still talking to the right server the
// whole time and could have asked for a new pairing code by itself.
//
// The rule pinned here: those handlers must hand off to something that recovers WITHOUT
// input, while leaving the URL editable for whoever does have a remote. The Android player
// already worked this way (ProvisioningActivity repair mode).
//
// The player is one big inline script with no jsdom in this repo, so this file does two
// things: structural checks on the wiring, and a real behavioural test of the countdown
// itself, which is lifted out of the HTML and run against a small shim.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'player', 'index.html'), 'utf8');

const bodyOf = (name) => {
  const start = HTML.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name}() should exist`);
  let i = HTML.indexOf('{', start), depth = 0;
  for (let j = i; j < HTML.length; j++) {
    if (HTML[j] === '{') depth++;
    else if (HTML[j] === '}' && --depth === 0) return HTML.slice(start, j + 1);
  }
  throw new Error(`unbalanced braces reading ${name}`);
};
const handlerOf = (event) => {
  const start = HTML.indexOf(`socket.on('${event}'`);
  assert.notEqual(start, -1, `a handler for ${event} should exist`);
  return HTML.slice(start, HTML.indexOf('});', start));
};

// ----------------------------------------------------------------- structural wiring

test('THE BUG: neither recovery handler dead-ends waiting for input', () => {
  for (const ev of ['device:unpaired', 'device:auth-error']) {
    const h = handlerOf(ev);
    assert.match(h, /enterRepairMode\(/, `${ev} routes into repair mode`);
    assert.doesNotMatch(h, /pairingSection'\)\.style\.display\s*=\s*'none'/,
      `${ev} must not hide the pairing section and then stop`);
  }
});

test('repair mode recovers on its own AND leaves the URL editable', () => {
  const b = bodyOf('enterRepairMode');
  assert.match(b, /startAutoContinue\(\s*\d+\s*\)/, 'it starts an unattended countdown');
  assert.match(b, /urlForm'\)\.style\.display\s*=\s*'block'/, 'the URL field stays available');
  assert.match(b, /config\.paired\s*=\s*false/, 'stale credentials are dropped');
  assert.match(b, /saveConfig\(config\)/, 'and persisted, so a reload agrees with memory');
});

test('the cancel-on-typing listener is bound exactly once', () => {
  // startAutoContinue() runs more than once per session (first boot, then repair), so
  // binding inside it would stack a listener per countdown.
  const bindings = HTML.match(/getElementById\('serverUrl'\)\.addEventListener\('input'/g) || [];
  assert.equal(bindings.length, 1, 'one binding, outside the countdown');
  assert.doesNotMatch(bodyOf('startAutoContinue'), /addEventListener/,
    'the countdown itself binds nothing');
});

// ----------------------------------------------------------------- behaviour

// Run the real countdown source against a shim, so this tests the shipped code rather
// than a paraphrase of it.
function loadCountdown() {
  const calls = { connect: 0 };
  const btn = { textContent: '', disabled: true };
  let timer = null, tickFn = null;
  const scope = {
    document: { getElementById: (id) => (id === 'connectBtn' ? btn : null) },
    _t: (k) => k,
    connectBtnFunc: () => { calls.connect++; },
    setInterval: (fn) => { tickFn = fn; timer = {}; return timer; },
    clearInterval: () => { timer = null; tickFn = null; },
  };
  const src = `let autoContinueTimer; ${bodyOf('cancelAutoContinue')} ${bodyOf('startAutoContinue')}
               return { startAutoContinue, cancelAutoContinue, get armed() { return !!autoContinueTimer; } };`;
  const api = new Function(...Object.keys(scope), src)(...Object.values(scope));
  return { api, calls, btn, tick: (n = 1) => { for (let i = 0; i < n; i++) if (tickFn) tickFn(); } };
}

test('the countdown reaches zero and connects with nobody touching the screen', () => {
  const { api, calls, btn, tick } = loadCountdown();
  api.startAutoContinue(3);
  assert.match(btn.textContent, /\(3\)/, 'it shows the remaining seconds');
  assert.equal(btn.disabled, false, 'and the button is usable meanwhile');
  tick(2);
  assert.equal(calls.connect, 0, 'not yet');
  tick(1);
  assert.equal(calls.connect, 1, 'reconnects by itself — this is the whole fix');
  assert.equal(api.armed, false, 'and disarms');
});

test('typing cancels it, so an operator mid-edit is never yanked', () => {
  const { api, calls, tick } = loadCountdown();
  api.startAutoContinue(3);
  api.cancelAutoContinue();
  tick(5);
  assert.equal(calls.connect, 0, 'no auto-connect once cancelled');
  assert.equal(api.armed, false);
});

test('restarting the countdown does not leave the old one running', () => {
  // Both timers would otherwise fire, double-connecting.
  const { api, calls, tick } = loadCountdown();
  api.startAutoContinue(2);
  api.startAutoContinue(2);
  tick(2);
  assert.equal(calls.connect, 1, 'exactly one connect');
});

test('the countdown fires once, not every tick after zero', () => {
  const { api, calls, tick } = loadCountdown();
  api.startAutoContinue(1);
  tick(4);
  assert.equal(calls.connect, 1);
});
