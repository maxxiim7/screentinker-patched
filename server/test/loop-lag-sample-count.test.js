// #240 — a loop-lag window must report how many samples it is made of.
//
// The bug this closes is a reading bug, not a code bug. An IntervalHistogram window that
// recorded exactly ONE delay reports mean = p50 = p99 = max, with the mean sitting just
// below the identical percentiles (the mean is the raw value; the percentiles are the
// HdrHistogram bucket ceiling above it). From the four numbers alone that is
// indistinguishable from a fixed cost paid on every single cycle — and it was read that
// way on a production incident. It is the opposite: one long loop turn, once.
//
// So /api/status now carries `samples` and an independently-measured wall-clock tick gap.
// These assertions pin the arithmetic that makes the distinction real.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHistogram, monitorEventLoopDelay } = require('perf_hooks');

const NS = 1e6;
const r2 = (x) => Math.round(x * 100) / 100;

test('#240: one recorded sample produces the mean=p50=p99=max signature', () => {
  const h = createHistogram();
  h.record(1329070000);                       // 1329.07ms, the production reading
  assert.equal(h.count, 1);
  assert.equal(r2(h.mean / NS), 1329.07, 'mean is the raw value');
  const p50 = r2(h.percentile(50) / NS), p99 = r2(h.percentile(99) / NS), max = r2(h.max / NS);
  assert.equal(p50, p99);
  assert.equal(p99, max, 'every percentile collapses onto the same bucket ceiling');
  assert.ok(max > r2(h.mean / NS), 'the ceiling sits ABOVE the mean — the tell that count is 1');
});

test('#240: a busy window does NOT produce that signature — p50 stays at the floor', () => {
  // Many small delays plus one big one: the real shape of an intermittent stall.
  const h = createHistogram();
  for (let i = 0; i < 49; i++) h.record(20000000);   // 20ms, the resolution floor
  h.record(1329070000);                              // one 1.3s stall
  assert.equal(h.count, 50);
  assert.notEqual(r2(h.percentile(50) / NS), r2(h.max / NS),
    'with real samples in the window the median cannot equal the max');
  assert.ok(r2(h.mean / NS) < r2(h.percentile(99) / NS), 'mean stays well under p99');
});

test('#240: an idle loop reports the RESOLUTION, not zero — the healthy baseline is the floor', async () => {
  const h = monitorEventLoopDelay({ resolution: 20 });
  h.enable();
  await new Promise((r) => setTimeout(r, 250));
  h.disable();
  assert.ok(h.count > 5, 'the sampler should have recorded several ticks');
  const mean = h.mean / NS;
  assert.ok(mean >= 19 && mean < 60, `idle mean should sit at ~the 20ms resolution, got ${r2(mean)}`);
});

test('#240: getLag() carries samples and the independent tick-gap fields', () => {
  const loopLag = require('../services/loop-lag');
  const lag = loopLag.getLag();
  for (const k of ['mean_ms', 'p50_ms', 'p99_ms', 'max_ms', 'samples', 'tick_gap_ms', 'worst_tick_gap_ms', 'worst_tick_at', 'band', 'sampled_at']) {
    assert.ok(k in lag, `/api/status loop_lag must expose ${k}`);
  }
});
