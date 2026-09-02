'use strict';

/*
 * A BrightSign now photographs itself with BrightSign's own API, and these tests pin the parts of
 * that which are easy to undo by accident.
 *
 * The player could never capture its own screen: video decodes onto a hardware plane the DOM
 * cannot read, so a canvas composite comes back with the content missing — the panel reported
 * "Video is playing on the hardware plane and cannot be captured" while playing perfectly.
 *
 * The long way round was to ask the HOST to capture through the player's DWS. That route is a dead
 * end on this hardware: page->host messaging stops working after page load, so the request never
 * arrives. `@brightsign/screenshot` composites the video and graphics layers and needs no host at
 * all — which is precisely why it works. It is reached through the same Node `require` that the
 * widget already exposes (the one that also makes `module` visible to classic scripts, which is
 * what broke the shared UMD modules on this platform).
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const BRIDGE = read('brightsign/st-bridge.js');
const PLAYER = read('server/player/index.html');

test('#BS-capture: the bridge uses BrightSign\'s own screenshot API', () => {
  assert.match(BRIDGE, /captureScreen:\s*function/, 'the bridge must expose captureScreen');
  assert.match(BRIDGE, /tryRequire\('@brightsign\/screenshot'\)/, 'must load the native module');
  // Both capture methods are documented; either is acceptable, but one must be called.
  assert.match(BRIDGE, /syncCapture|asyncCapture/);
});

test('#BS-capture: it writes to RAM, not to the boot flash', () => {
  // The remote-control view drives this once a second. A screenshot per second written to flash is
  // a wear-out mechanism with no upside — the file is read back and deleted immediately, so it
  // never needs to be durable.
  const block = BRIDGE.slice(BRIDGE.indexOf('captureScreen:'), BRIDGE.indexOf('requestSnapshot:'));
  const dirs = block.match(/var dirs = \[([^\]]+)\]/);
  assert.ok(dirs, 'candidate directories not found');
  const list = dirs[1].split(',').map((d) => d.trim().replace(/'/g, ''));
  assert.ok(/tmp/.test(list[0]), `RAM must be tried first, got ${list[0]}`);
  assert.ok(list.some((d) => /flash/.test(d)), 'real storage should still be a fallback');
  assert.ok(list.indexOf(list.find((d) => /flash/.test(d))) > 0, 'flash must never be the first choice');
});

test('#BS-capture: the temp file is removed after it is read', () => {
  const block = BRIDGE.slice(BRIDGE.indexOf('captureScreen:'), BRIDGE.indexOf('requestSnapshot:'));
  assert.match(block, /unlinkSync/, 'a capture per second must not accumulate files');
  assert.match(block, /toString\('base64'\)/, 'the bytes must come back as base64 for the socket');
});

test('#BS-capture: a missing module or file fails cleanly rather than hanging', () => {
  const block = BRIDGE.slice(BRIDGE.indexOf('captureScreen:'), BRIDGE.indexOf('requestSnapshot:'));
  assert.match(block, /no @brightsign\/screenshot module/, 'absent module must reject, not throw');
  assert.match(block, /no fs module/);
  assert.match(block, /timeoutMs/, 'the file poll must be bounded — a capture that never lands cannot wedge the player');
});

test('#BS-capture: the player tries the native API BEFORE the host route', () => {
  // Order is the whole fix. The host route is a dead end on this hardware, so trying it first
  // would spend the operator's patience on a 15s timeout before reaching the path that works.
  const nativeAt = PLAYER.indexOf('BS.captureScreen');
  const hostAt = PLAYER.indexOf('BS.requestSnapshot');
  assert.ok(nativeAt > 0, 'the player must call captureScreen');
  assert.ok(hostAt > 0, 'the host route should remain as a fallback');
  assert.ok(nativeAt < hostAt, 'native capture must be attempted first');
});

test('#BS-capture: a native failure still falls back, never blanks', () => {
  const seg = PLAYER.slice(PLAYER.indexOf('BS.captureScreen'), PLAYER.indexOf('function captureAndSendCanvas'));
  assert.match(seg, /\.catch\(/, 'a rejected capture must be handled');
  assert.match(seg, /hostSnapshotOrCanvas\(\)/, 'and fall through to the older routes');
  assert.match(seg, /captureAndSendCanvas\(\)/, 'an empty result must still produce something');
});

test('#BS-capture: remote streaming inherits it — one capture path, not two', () => {
  // startStreaming drives captureAndSend on a timer, so whatever the screenshot button gets, the
  // live view gets. A second capture path would be a second, subtly different feature.
  assert.match(PLAYER, /streamTimer = setInterval\(captureAndSend, 1000\)/);
});
