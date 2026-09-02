'use strict';

// The widget telemetry endpoint accepts writes from UNAUTHENTICATED callers (the diag
// widget runs in a null-origin sandboxed iframe, so it cannot carry a session). Two
// invariants keep that from being a resource-exhaustion path — on this product a dead
// server is a fleet-wide reconnect, so these are fleet-safety properties:
//
//   1. The in-memory store is BOUNDED — a fixed entry cap and a TTL, so an unauthenticated
//      writer cannot grow it without limit no matter how many distinct keys it invents.
//   2. An unauthenticated report writes NO durable row — it must not be able to grow a
//      database table either.
//
// And the consumer contract is unchanged: a live key returns its object, an unknown or
// expired key returns null, which frontend/js/views/device-detail.js already handles
// (it renders "no report yet" and treats anything older than 15s as stale anyway).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { createStore } = require('../lib/bounded-snapshot-store');

// ---------------------------------------------------------------------------
// 1. The bound itself (unit)
// ---------------------------------------------------------------------------
test('the store never exceeds its cap, however many distinct keys arrive', () => {
  const s = createStore({ max: 50, ttlMs: 60_000 });
  for (let i = 0; i < 5000; i++) s.set('attacker-key-' + i, { receivedAt: Date.now() });
  assert.equal(s.size(), 50, '5000 distinct keys must not produce 5000 entries');
});

test('eviction is least-recently-written, so a live reporter is never dropped', () => {
  const s = createStore({ max: 10, ttlMs: 60_000 });
  s.set('live-panel', { receivedAt: Date.now() });
  for (let i = 0; i < 100; i++) {
    s.set('noise-' + i, { receivedAt: Date.now() });
    s.set('live-panel', { receivedAt: Date.now() }); // the panel keeps reporting
  }
  assert.ok(s.get('live-panel'), 'a key that keeps being written survives a flood');
  assert.equal(s.size(), 10);
});

test('entries expire, on read as well as by sweep', () => {
  const s = createStore({ max: 100, ttlMs: 1000 });
  const t0 = 1_000_000;
  s.set('k', { receivedAt: t0 });
  assert.ok(s.get('k', t0 + 500), 'fresh entry is returned');
  assert.equal(s.get('k', t0 + 5000), null, 'expired entry reads as null, not stale data');

  s.set('a', { receivedAt: t0 });
  s.set('b', { receivedAt: t0 });
  assert.equal(s.sweep(t0 + 5000), 2, 'sweep drops expired entries');
  assert.equal(s.size(), 0);
});

test('a missing key reads as null — the shape the dashboard already handles', () => {
  const s = createStore();
  assert.equal(s.get('never-seen'), null);
});

test('the sweep timer does not hold the process open', () => {
  const s = createStore({ ttlMs: 50 });
  const t = s.startSweep(10);
  assert.equal(typeof t.unref, 'function');
  s.stopSweep();
});

// ---------------------------------------------------------------------------
// 2. End to end: no durable row, and the HTTP contract is unchanged
// ---------------------------------------------------------------------------
const { freePort } = require('./helpers/free-port');
let PORT, BASE, proc;
const DATA_DIR = path.join(os.tmpdir(), 'st-telemetry-test-' + crypto.randomBytes(4).toString('hex'));
const LOG = path.join(os.tmpdir(), 'st-telemetry-' + crypto.randomBytes(4).toString('hex') + '.log');

before(async () => {
  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  const logFd = fs.openSync(LOG, 'w');
  proc = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(PORT), NODE_ENV: 'test' },
    stdio: ['ignore', logFd, logFd],
  });
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(BASE + '/api/status'); if (r.ok) return; } catch { /* not yet */ }
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error('server did not boot:\n' + fs.readFileSync(LOG, 'utf8').slice(-2000));
});
after(() => { try { proc.kill('SIGKILL'); } catch { /* ignore */ } });

const postTelemetry = (widgetId, body) => fetch(`${BASE}/api/widgets/${widgetId}/telemetry`, {
  method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(body),
});

test('an unauthenticated report writes no durable row', async () => {
  const wid = 'w-' + crypto.randomBytes(4).toString('hex');
  for (let i = 0; i < 25; i++) {
    const res = await postTelemetry(wid, { device: 'dev-' + i, fps: 60 });
    assert.ok(res.status < 400, 'the widget must keep being able to report');
  }
  const Database = require('better-sqlite3');
  const db = new Database(path.join(DATA_DIR, 'db', 'remote_display.db'), { readonly: true });
  const n = db.prepare("SELECT COUNT(*) n FROM activity_log WHERE action LIKE '%telemetry%'").get().n;
  db.close();
  assert.equal(n, 0, 'an unauthenticated caller must not be able to grow activity_log');
});

test('the SERVER store is bounded — a flood of distinct keys evicts older ones', async () => {
  // The unit tests above specify the store in isolation; this one proves it is actually
  // WIRED IN, by observing eviction through the HTTP surface. On an unbounded store the
  // first key survives forever and this fails.
  const wid = 'w-' + crypto.randomBytes(4).toString('hex');
  const first = 'dev-first-' + crypto.randomBytes(4).toString('hex');
  await postTelemetry(wid, { device: first, fps: 1 });
  assert.ok((await (await fetch(`${BASE}/api/widgets/${wid}/telemetry?device=${first}`)).json()),
    'the first report is readable before the flood');

  for (let i = 0; i < 700; i++) await postTelemetry(wid, { device: `flood-${i}`, fps: 60 });

  const after = await (await fetch(`${BASE}/api/widgets/${wid}/telemetry?device=${first}`)).json();
  assert.equal(after, null, 'an unbounded store would still be holding the first key');
});

test('the read contract is unchanged: live key -> object, unknown key -> null', async () => {
  const wid = 'w-' + crypto.randomBytes(4).toString('hex');
  const dev = 'dev-' + crypto.randomBytes(4).toString('hex');
  await postTelemetry(wid, { device: dev, fps: 59, verdict: 'SMOOTH' });

  const live = await fetch(`${BASE}/api/widgets/${wid}/telemetry?device=${dev}`);
  assert.equal(live.status, 200);
  const body = await live.json();
  assert.equal(body.fps, 59, 'the reporting panel\'s snapshot comes back');
  assert.equal(body.verdict, 'SMOOTH');
  assert.equal(typeof body.receivedAt, 'number', 'receivedAt drives the dashboard staleness check');

  const unknown = await fetch(`${BASE}/api/widgets/${wid}/telemetry?device=nobody`);
  assert.equal(unknown.status, 200);
  assert.equal(await unknown.json(), null, 'unknown device reads as null, the shape the UI handles');
});
