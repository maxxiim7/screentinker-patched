'use strict';

// An event-loop-lag sampling window that recorded nothing leaves the histogram empty, and an
// empty IntervalHistogram reports `mean` as NaN. NaN survives every arithmetic step in the
// sampler without complaint and only becomes visible at the very edge, where JSON.stringify
// silently renders it as `null` — so /api/status served `"mean_ms": null` and nothing anywhere
// raised an error. Anything consuming that gauge (a dashboard, an alerting rule) saw null
// instead of a number.
//
// It surfaced as a CI-only test failure — `typeof mean_ms` came back 'object' — because an
// idle window is far more likely on a loaded runner with several test servers in flight than
// on a developer machine. The failure was real, not flaky infrastructure.
//
// The rule pinned here: a metric with no samples reports 0, never NaN and never null. Zero is
// the honest answer — no samples means no measured delay.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { monitorEventLoopDelay } = require('node:perf_hooks');
const { _metric } = require('../services/loop-lag');

test('THE BUG: an empty histogram really does report NaN for mean', () => {
  // Establishes the premise rather than assuming it — if Node ever changes this, the reason
  // for the guard below disappears and this test says so.
  const h = monitorEventLoopDelay({ resolution: 10 });
  h.enable(); h.disable(); h.reset();
  assert.ok(Number.isNaN(h.mean), 'empty histogram mean is NaN');
  assert.ok(Number.isFinite(h.percentile(99)), 'percentiles return a floor, which is why only mean broke');
});

test('NaN would serialise to null, which is how it escaped notice', () => {
  const round2 = (x) => Math.round(x * 100) / 100;
  const unguarded = round2(NaN / 1e6);
  assert.ok(Number.isNaN(unguarded), 'NaN propagates silently through the arithmetic');
  assert.equal(JSON.parse(JSON.stringify({ mean_ms: unguarded })).mean_ms, null,
    'and JSON.stringify turns it into null at the API boundary');
});

test('the guard converts a non-finite reading to 0', () => {
  assert.equal(_metric(NaN), 0);
  assert.equal(_metric(Infinity), 0);
  assert.equal(_metric(-Infinity), 0);
});

test('normal readings are untouched, still rounded to 2dp', () => {
  assert.equal(_metric(1.234), 1.23);
  assert.equal(_metric(0), 0);
  assert.equal(_metric(15.005), 15.01);
  assert.equal(_metric(1234.5678), 1234.57);
});

test('every guarded value survives a JSON round-trip as a number', () => {
  const snap = { mean_ms: _metric(NaN), p50_ms: _metric(0), p99_ms: _metric(2.5), max_ms: _metric(NaN) };
  const back = JSON.parse(JSON.stringify(snap));
  for (const k of Object.keys(snap)) {
    assert.equal(typeof back[k], 'number', `${k} stays numeric across the API boundary`);
  }
});
