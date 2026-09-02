// #240 — the WAL checkpointer's STARVATION escalation must be gated on WAL size.
//
// Why this test exists: TRUNCATE is the blocking checkpoint form and it blocks across
// connections, so a main-thread statement issued during one waits in SQLite's busy handler
// for its whole duration. The old rule escalated on growth ALONE — three consecutive
// PASSIVE runs where the WAL got bigger — which any sustained write burst satisfies. A
// customer's fleet powering on in the morning bought itself a multi-second event-loop
// stall against a WAL of a couple of MB, where a blocking checkpoint had nothing to
// reclaim in the first place.
//
// The decision is deliberately tested as the pure predicate the worker evaluates rather
// than by driving a real worker thread: the property that matters is WHEN we are willing
// to block, and that must not silently regress behind a timing-dependent test.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('../config');

const MB = 1024 * 1024;

// The worker's escalation rule, kept in one place so the assertions below read as policy.
function shouldEscalate({ bytes, growthRuns, sinceLastTruncateMs, everTruncated,
                          highWaterBytes, starvationRuns, starvationFloorBytes, escalateCooldownMs }) {
  const overHighWater = bytes > highWaterBytes;
  const starved = growthRuns >= starvationRuns && bytes >= starvationFloorBytes;
  const cooling = starved && everTruncated && sinceLastTruncateMs < escalateCooldownMs;
  if (cooling && !overHighWater) return { overHighWater, starved, cooling, escalate: false };
  return { overHighWater, starved, cooling, escalate: overHighWater || starved };
}

const RULE = {
  highWaterBytes: config.walCheckpointHighWaterMB * MB,
  starvationRuns: config.walCheckpointStarvationRuns,
  starvationFloorBytes: config.walCheckpointStarvationFloorMB * MB,
  escalateCooldownMs: config.walCheckpointEscalateCooldownMs,
  sinceLastTruncateMs: Infinity,
  everTruncated: false,
};

test('#240: a small WAL growing across runs no longer triggers the blocking TRUNCATE', () => {
  // The morning-wave shape: sustained writes, WAL grew every run, still only 2MB.
  const r = shouldEscalate({ ...RULE, bytes: 2 * MB, growthRuns: 5 });
  assert.equal(r.escalate, false, 'growth alone must not escalate while the WAL is small');
});

test('#240: growth still escalates once the WAL is actually large', () => {
  const r = shouldEscalate({ ...RULE, bytes: config.walCheckpointStarvationFloorMB * MB, growthRuns: config.walCheckpointStarvationRuns });
  assert.equal(r.starved, true, 'at the floor, sustained growth is real starvation');
  assert.equal(r.escalate, true);
});

test('#240: the high-water backstop is untouched — the WAL still cannot grow unbounded', () => {
  // No growth signal at all (a single huge run), well over the high-water mark.
  const r = shouldEscalate({ ...RULE, bytes: (config.walCheckpointHighWaterMB + 1) * MB, growthRuns: 0 });
  assert.equal(r.overHighWater, true);
  assert.equal(r.escalate, true, 'high-water must escalate regardless of the growth counter');
});

test('#240: the floor sits below the high-water mark, so the two rules cannot invert', () => {
  assert.ok(
    config.walCheckpointStarvationFloorMB < config.walCheckpointHighWaterMB,
    'a floor at or above high-water would make the starvation rule dead code'
  );
});

// The floor on its own does NOT close this. Bold's WAL sat at 6.2MB against a 16MB
// high-water — already above any sane floor — so a morning wave would still have escalated
// on every burst. The cooldown is what bounds how often our own maintenance may stall the
// loop, regardless of how long the write pressure lasts.
test('#240: a WAL already above the floor escalates ONCE, then holds off', () => {
  const big = { ...RULE, bytes: 12 * MB, growthRuns: 5 };

  const first = shouldEscalate({ ...big });
  assert.equal(first.escalate, true, 'the first sustained-growth burst still escalates');

  const during = shouldEscalate({ ...big, everTruncated: true, sinceLastTruncateMs: 30_000 });
  assert.equal(during.cooling, true);
  assert.equal(during.escalate, false, 'a second burst inside the cooldown must not stall the loop again');

  const after = shouldEscalate({ ...big, everTruncated: true, sinceLastTruncateMs: config.walCheckpointEscalateCooldownMs + 1 });
  assert.equal(after.escalate, true, 'once the window passes, escalation is available again');
});

test('#240: the cooldown never delays the runaway-WAL backstop', () => {
  const runaway = {
    ...RULE, bytes: (config.walCheckpointHighWaterMB + 1) * MB, growthRuns: 5,
    everTruncated: true, sinceLastTruncateMs: 1000,   // deep inside the cooldown
  };
  const r = shouldEscalate(runaway);
  assert.equal(r.escalate, true, 'over high-water must escalate even mid-cooldown — that rule is the safety net');
});

test('#240: the worker actually applies the floor it is handed', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'db', 'wal-checkpointer-worker.js'), 'utf8');
  assert.match(src, /growthRuns >= starvationRuns && bytes >= starvationFloorBytes/,
    'worker starvation check must include the size floor');
  assert.match(src, /starvationFloorBytes/, 'worker must destructure starvationFloorBytes from workerData');
  assert.match(src, /sinceLast < escalateCooldownMs/, 'worker must apply the escalation cooldown');
  const ctl = fs.readFileSync(path.join(__dirname, '..', 'db', 'wal-checkpointer.js'), 'utf8');
  assert.match(ctl, /starvationFloorBytes:\s*config\.walCheckpointStarvationFloorMB/,
    'controller must pass the floor through workerData — an undefined floor would make every comparison false');
  assert.match(ctl, /escalateCooldownMs:\s*config\.walCheckpointEscalateCooldownMs/,
    'controller must pass the cooldown through workerData');
});

// Measured, not assumed: with a single reader mid-transaction, TRUNCATE returns busy=1
// after sitting on its 5s busy timeout and reclaims nothing (probe: WAL 8.8MB -> 8.8MB,
// worst main-thread write 4,936ms). That outcome must not be logged as a success.
// The startup line is where an operator learns the policy. It went stale the moment the gates were
// added — it still promised "3 growing runs" with no mention of the floor or the cooldown, so it
// described a checkpointer that no longer existed. A log line that states a rule has to state the
// whole rule, and nothing but a test keeps the two in step.
test('#240: the startup line states the WHOLE escalation policy', () => {
  const ctl = fs.readFileSync(path.join(__dirname, '..', 'db', 'wal-checkpointer.js'), 'utf8');
  // Anchor forward from the message text, not back to `return worker;` — the idempotence guard at
  // the top of startWalCheckpointer() returns first, so slicing to it yields nothing at all.
  const start = ctl.indexOf('off-thread checkpointer started');
  assert.ok(start > 0, 'the startup line is gone entirely');
  const line = ctl.slice(start, start + 800);
  for (const knob of [
    'walCheckpointIntervalMs',
    'walCheckpointHighWaterMB',
    'walCheckpointStarvationRuns',
    'walCheckpointStarvationFloorMB',
    'walCheckpointEscalateCooldownMs',
  ]) {
    assert.ok(line.includes(knob), `the startup line must report ${knob} — an operator reads it as the policy`);
  }
});

test('#240: a TRUNCATE that reclaimed nothing says so', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'db', 'wal-checkpointer-worker.js'), 'utf8');
  assert.match(src, /busy === 1/, 'worker must inspect the checkpoint result');
  assert.match(src, /reclaimed nothing/, 'a busy TRUNCATE must be reported as the loss it is');
});

test('#240: the unrecoverable-worker fallback no longer blocks the loop for a small WAL', () => {
  const ctl = fs.readFileSync(path.join(__dirname, '..', 'db', 'wal-checkpointer.js'), 'utf8');
  assert.match(ctl, /wal_checkpoint\(\$\{over \? 'TRUNCATE' : 'PASSIVE'\}\)/,
    'fallback reclaim must pick TRUNCATE only when the WAL is over the high-water mark');
});

test('#240: /api/status exposes the sticky fallback state', () => {
  const { getCheckpointerState } = require('../db/wal-checkpointer');
  const s = getCheckpointerState();
  // Not started in this process — the point is the shape, and that reading it is safe
  // before startWalCheckpointer() has ever run (status is served during boot too).
  assert.deepEqual(Object.keys(s).sort(), ['fallbackEngaged', 'respawns', 'walBytes', 'worker']);
  assert.equal(s.fallbackEngaged, false);
  assert.equal(typeof s.walBytes, 'number');
});
