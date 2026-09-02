'use strict';

// #148 patch2 — session-settle DECISION unit tests. The liveness safeguard is the load-bearing
// one: a dead incumbent must NEVER be held (else we recreate #148 by stranding the device).

process.env.SESSION_SETTLE_WINDOW_MS = '2500';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const ss = require('../lib/session-settle');

beforeEach(() => ss.reset());

test('HOLD: live incumbent + a socket accepted within the window -> refuse the duplicate', () => {
  ss.accepted('dev', 1000);
  assert.equal(ss.shouldHold('dev', true, 1500), true);   // 500ms into the 2500ms window, incumbent alive
});

test('LIVENESS SAFEGUARD (critical): a DEAD incumbent is NEVER held -> accept the new socket', () => {
  ss.accepted('dev', 1000);
  // Within the window, but the caller reports the incumbent is not alive -> must NOT hold,
  // so the new socket is accepted and the corpse evicted (device never stranded offline).
  assert.equal(ss.shouldHold('dev', false, 1500), false);
});

test('window elapsed -> accept (a genuine move to a new socket still works)', () => {
  ss.accepted('dev', 1000);
  assert.equal(ss.shouldHold('dev', true, 1000 + 2500), false);   // exactly at the edge
  assert.equal(ss.shouldHold('dev', true, 1000 + 5000), false);
});

test('first connection (no prior accept) -> accept', () => {
  assert.equal(ss.shouldHold('fresh', true, 9999), false);
});

test('bounded: sweep drops entries idle past 4x the window', () => {
  ss.accepted('a', 1000);
  ss.accepted('b', 1000);
  assert.equal(ss._size(), 2);
  ss.sweep(1000 + 2500 * 4 + 1);
  assert.equal(ss._size(), 0);
});
