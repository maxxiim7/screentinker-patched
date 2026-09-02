'use strict';

// A bounded "latest snapshot per key" store for diagnostic data that arrives from
// UNAUTHENTICATED callers.
//
// The widget-telemetry store was a plain Map keyed on a value the caller supplies, with no
// cap, no TTL and no eviction: an unauthenticated caller could add entries until the
// process ran out of memory, and on this product a dead server means every screen in the
// fleet reconnects at once. A bound is therefore a fleet-safety control, not tidiness.
//
// Deliberately NOT rate-limited per IP. This codebase already learned that lesson for the
// OTA download guard ("NEVER per-IP (SNAT)"): signage sites egress through one NAT
// address, so a per-IP cap punishes a whole venue for one noisy panel and does nothing
// against a distributed writer. The GLOBAL entry cap is the honest bound — it makes the
// worst case a fixed amount of memory regardless of who is writing or from where.
//
// Eviction is least-recently-WRITTEN. Every live reporter rewrites its own key on each
// report, so under a flood the only entries eligible for eviction are ones already older
// than any consumer would treat as live.

function createStore({ max = 500, ttlMs = 60_000 } = {}) {
  // Map preserves insertion order, and re-setting a key does NOT refresh that order, so
  // delete-then-set is what makes the iteration order a true recency order.
  const m = new Map();
  let sweepTimer = null;

  function set(key, value) {
    if (m.has(key)) m.delete(key);
    m.set(key, value);
    // Evict the least-recently-written entries until we are back inside the cap.
    while (m.size > max) {
      const oldest = m.keys().next();
      if (oldest.done) break;
      m.delete(oldest.value);
    }
    return value;
  }

  // Returns null for a missing OR expired entry. Expiry is enforced on READ as well as by
  // the sweep, so a stale value can never be served just because the sweep hasn't run.
  function get(key, now = Date.now()) {
    const v = m.get(key);
    if (!v) return null;
    const at = typeof v.receivedAt === 'number' ? v.receivedAt : 0;
    if (now - at > ttlMs) { m.delete(key); return null; }
    return v;
  }

  function sweep(now = Date.now()) {
    let dropped = 0;
    for (const [k, v] of m) {
      const at = typeof v.receivedAt === 'number' ? v.receivedAt : 0;
      if (now - at > ttlMs) { m.delete(k); dropped++; }
    }
    return dropped;
  }

  // unref() so the interval never holds the process open (same discipline as
  // lib/log-coalescer.js and the other sweeps).
  function startSweep(intervalMs = ttlMs) {
    if (sweepTimer) return sweepTimer;
    sweepTimer = setInterval(() => { try { sweep(); } catch (_) { /* never throw from a timer */ } }, intervalMs);
    if (sweepTimer.unref) sweepTimer.unref();
    return sweepTimer;
  }

  function stopSweep() { if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; } }

  return { set, get, sweep, startSweep, stopSweep, size: () => m.size, max, ttlMs };
}

module.exports = { createStore };
