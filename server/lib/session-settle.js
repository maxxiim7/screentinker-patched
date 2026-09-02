'use strict';

// #148 patch2 — per-device SESSION-SETTLE debounce (the field-safe net). When a device opens
// duplicate/rapid sockets in a burst, keep it on ONE live incumbent connection and soft-refuse
// the duplicates, so it converges and STAYS ONLINE — instead of churning through evictions.
// This closes the gap the reconnect-throttle's 30s post-restart warm-up leaves open (during
// warm-up only the hard ceiling applies, so an 8-in-9s duplicate burst passes undamped and
// each new socket evicts the prior). This debounce is warm-up-INDEPENDENT.
//
// DECISION ONLY: this module never touches sockets or the DB. The caller supplies whether the
// incumbent is actually alive (the LIVENESS SAFEGUARD) and does the refuse/disconnect. Bounded:
// one small timestamp per device_id, idle entries swept.

const config = require('../config');

const state = new Map();   // device_id -> lastAcceptedMs

// Should this NEW socket be soft-refused (keep the incumbent)? TRUE only when a socket was
// accepted for this device within the settle window AND the incumbent is genuinely alive.
// incumbentAlive is the load-bearing safeguard: if the incumbent is dead/half-open the caller
// passes false and we return false -> accept the new socket, never stranding the device.
function shouldHold(deviceId, incumbentAlive, now = Date.now()) {
  if (!incumbentAlive) return false;
  const last = state.get(deviceId) || 0;
  return (now - last) < config.sessionSettleWindowMs;
}

// Record that a socket was ACCEPTED (evicted+registered) for this device — (re)arms the window.
function accepted(deviceId, now = Date.now()) { state.set(deviceId, now); }

// Bounded: drop entries idle well past the window.
function sweep(now = Date.now()) {
  let n = 0;
  for (const [k, t] of state) if (now - t > config.sessionSettleWindowMs * 4) { state.delete(k); n++; }
  return n;
}
let sweepTimer = null;
function startSweep() {
  if (sweepTimer) return sweepTimer;
  sweepTimer = setInterval(() => sweep(), 60000);
  if (sweepTimer.unref) sweepTimer.unref();
  return sweepTimer;
}

function reset() { state.clear(); }
function _size() { return state.size; }

module.exports = { shouldHold, accepted, sweep, startSweep, reset, _size };
