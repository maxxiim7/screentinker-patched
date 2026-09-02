'use strict';

// The settings PIN and the provisioning pairing code both gate access — the PIN to the
// on-device settings menu, the pairing code to claiming a device into a workspace. Both
// must come from a CSPRNG.
//
// Math.random is not one: V8 implements it as xorshift128+, whose state is recoverable
// from a few consecutive outputs, and every call in a process shares that stream. Since
// the PIN is observable in device API responses, a user who collects a few could predict
// values minted around them.
//
// The source assertion at the bottom is the one that fails if a future change reintroduces
// Math.random for either value — the statistical tests below cannot distinguish a CSPRNG
// from a good PRNG, so they alone would not catch a regression.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { sixDigitCode } = require('../lib/numeric-code');

test('a code is always exactly six digits, 100000-999999', () => {
  for (let i = 0; i < 2000; i++) {
    const c = sixDigitCode();
    assert.match(c, /^[1-9]\d{5}$/, `got ${c}`);
    const n = Number(c);
    assert.ok(n >= 100000 && n <= 999999, `out of range: ${n}`);
  }
});

test('codes are not obviously degenerate (spread across the range, few repeats)', () => {
  const seen = new Set();
  const buckets = new Array(9).fill(0); // by leading digit 1..9
  for (let i = 0; i < 5000; i++) {
    const c = sixDigitCode();
    seen.add(c);
    buckets[Number(c[0]) - 1]++;
  }
  assert.ok(seen.size > 4900, `too many collisions in 5000 draws: ${seen.size} unique`);
  // Every leading digit should appear; a badly-scaled range would starve 1 or 9.
  for (let d = 0; d < 9; d++) assert.ok(buckets[d] > 0, `leading digit ${d + 1} never appeared`);
});

test('the generator is CSPRNG-backed, not Math.random', () => {
  // Inspect the FUNCTION body, not the file: the file's comment legitimately mentions
  // Math.random while explaining why it is not used.
  const body = sixDigitCode.toString();
  assert.ok(/crypto\.randomInt|randomInt/.test(body), `must use crypto.randomInt, got: ${body}`);
  assert.ok(!/Math\.random/.test(body), 'must not use Math.random');
});

test('no access-gating code is generated with Math.random anywhere on the server', () => {
  // Scans the two call sites that mint access-gating values. Deliberately narrow: other
  // Math.random uses in the tree are non-security (an image-generation seed in
  // lib/image-gen.js, and anti-burn-in pixel jitter inside generated widget HTML), and
  // sweeping those in would make this test a nuisance rather than a guard.
  const root = path.join(__dirname, '..');
  for (const rel of ['server.js', 'routes/status.js']) {
    const src = fs.readFileSync(path.join(root, rel), 'utf8');
    for (const line of src.split('\n')) {
      if (!/Math\.random/.test(line)) continue;
      assert.ok(!/(pin|pairing|code|secret|token)/i.test(line),
        `${rel} mints an access-gating value with Math.random: ${line.trim()}`);
    }
  }
});
