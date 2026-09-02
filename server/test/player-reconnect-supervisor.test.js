'use strict';

// socket.io does not retry every disconnect. On 'io server disconnect' it deliberately stands
// down and waits to be told to reconnect. The player assumed the opposite — its disconnect
// handler stopped the watchdog with the comment "socket.io owns the reconnect once it KNOWS it's
// down", and verifyLivenessSoon() skipped a present-but-disconnected socket for the same reason.
//
// So when the server closed a socket — a handler throwing, a deploy, an eviction — nothing was
// watching, and the player stayed down until a human reloaded the page. That happened to a live
// panel: its heartbeat hit an FK error, the server disconnected it, and it sat dark. A display on
// a wall has nobody to press reload.
//
// The supervisor is the backstop. What it must NOT do is fight the reconnection socket.io already
// owns, so it waits out a grace longer than socket.io's 30s maximum backoff, and it never
// supervises a teardown the client itself initiated.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'player', 'index.html'), 'utf8');

function lift(name) {
  const start = HTML.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name}() should exist in the player`);
  let depth = 0;
  for (let j = HTML.indexOf('{', start); j < HTML.length; j++) {
    if (HTML[j] === '{') depth++;
    else if (HTML[j] === '}' && --depth === 0) {
      return new Function(`${HTML.slice(start, j + 1)} return ${name};`)();
    }
  }
  throw new Error('unbalanced braces reading ' + name);
}
const shouldSuperviseReconnect = lift('shouldSuperviseReconnect');
const shouldForceReconnect = lift('shouldForceReconnect');

const GRACE = 45000;

test('THE BUG: a server-closed socket IS supervised', () => {
  // This is the reason socket.io refuses to retry, and the one that stranded a real panel.
  assert.equal(shouldSuperviseReconnect('io server disconnect'), true);
});

test('an ordinary transport drop is supervised too', () => {
  // socket.io usually retries these; the supervisor only acts after the grace, so it is a
  // backstop rather than a competitor.
  for (const r of ['transport close', 'ping timeout', 'transport error', undefined]) {
    assert.equal(shouldSuperviseReconnect(r), true, `${r} should be supervised`);
  }
});

test('our OWN teardown is not supervised — it would fight the reconnect in progress', () => {
  // connect() closes the previous socket before opening the next; supervising that would race it.
  assert.equal(shouldSuperviseReconnect('io client disconnect'), false);
});

test('a connected socket is never torn down by the supervisor', () => {
  assert.equal(shouldForceReconnect(true, Date.now() - 10 * GRACE, Date.now(), GRACE), false,
    'being connected beats any amount of elapsed time');
});

test('it waits out the grace, so socket.io gets first refusal', () => {
  const t0 = 1_000_000;
  assert.equal(shouldForceReconnect(false, t0, t0 + 1000, GRACE), false, 'too soon');
  assert.equal(shouldForceReconnect(false, t0, t0 + 30000, GRACE), false, 'still inside socket.io backoff');
  assert.equal(shouldForceReconnect(false, t0, t0 + GRACE, GRACE), true, 'grace reached');
  assert.equal(shouldForceReconnect(false, t0, t0 + 10 * GRACE, GRACE), true, 'and stays true');
});

test('the grace outlasts socket.io max backoff, or the two would race', () => {
  const grace = Number((HTML.match(/RECONNECT_GRACE_MS\s*=\s*(\d+)/) || [])[1]);
  const maxBackoff = Number((HTML.match(/reconnectionDelayMax:\s*(\d+)/) || [])[1]);
  assert.ok(grace > maxBackoff, `grace ${grace}ms must exceed socket.io's ${maxBackoff}ms max backoff`);
});

test('no disconnect timestamp means nothing to act on', () => {
  assert.equal(shouldForceReconnect(false, 0, Date.now(), GRACE), false);
});

// ------------------------------------------------------------------ wiring

test('the disconnect handler actually starts the supervisor', () => {
  const i = HTML.indexOf("socket.on('disconnect'");
  const block = HTML.slice(i, i + 1400);
  assert.match(block, /shouldSuperviseReconnect\(reason\)/, 'it consults the decision');
  assert.match(block, /startReconnectSupervisor\(\)/, 'and arms the backstop');
  assert.match(block, /socket\.on\('disconnect', \(reason\)/, 'the reason is captured, not ignored');
});

test('a successful connect stands the supervisor down', () => {
  const i = HTML.indexOf("socket.on('connect'");
  assert.match(HTML.slice(i, i + 400), /stopReconnectSupervisor\(\)/);
});

test('verifyLivenessSoon no longer abandons a disconnected socket', () => {
  // It used to skip this case entirely, believing socket.io owned it — which is the same wrong
  // assumption in a second place. A resume is exactly when a stranded panel deserves another go.
  const body = HTML.slice(HTML.indexOf('function verifyLivenessSoon()'));
  const block = body.slice(0, body.indexOf('function startWatchdog'));
  assert.match(block, /!socket\.connected/, 'the disconnected case is handled');
  assert.match(block, /startReconnectSupervisor\(\)/, 'and handed to the supervisor');
});

test('the supervisor does not run in preview mode', () => {
  const i = HTML.indexOf('function startReconnectSupervisor()');
  assert.match(HTML.slice(i, i + 700), /PREVIEW_MODE/,
    'a device-free dashboard preview has no socket to keep alive');
});
