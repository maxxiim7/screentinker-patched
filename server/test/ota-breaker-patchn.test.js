// OTA breaker — the -patchN transition. The legacy '-patchN' release scheme (e.g. 1.9.2-patch3) parses
// as a semver prerelease, which made the superseded-prerelease guard STRAND the old fleet: with clean
// 1.9.3 as latest, a 1.9.2-patchN device was refused the update. isReleased() now treats -patchN as a
// shipped release so it's offered, while GENUINE prereleases (-beta/-rc/-alpha) keep prerelease semantics.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const ota = require('../lib/ota-breaker');
const LATEST = '1.9.3';               // the clean-semver release
const T = 1_000_000;

test('-patchN fleet is OFFERED the newer stable (the transition fix)', () => {
  ota.reset();
  for (const v of ['1.9.2-patch3', '1.9.2-patch4', '1.9.1-patch2', '1.9.2-PATCH3' /* case-insensitive */]) {
    const d = ota.decide(v, LATEST, null, T);
    assert.equal(d.update_available, true, `${v} -> 1.9.3 should be offered (was 'superseded-prerelease')`);
    assert.equal(d.reason, 'offer');
  }
});

test('GENUINE older-core prereleases are STILL superseded (no offer) — unchanged', () => {
  ota.reset();
  for (const v of ['1.9.1-beta4', '1.9.2-beta6', '1.9.0-rc1', '1.8.5-alpha2']) {
    const d = ota.decide(v, LATEST, null, T);
    assert.equal(d.update_available, false, `${v} is a genuine prerelease of an older core -> no offer`);
    assert.equal(d.reason, 'superseded-prerelease');
  }
});

test('clean older releases still offered; equal is up-to-date; newer never downgraded', () => {
  ota.reset();
  assert.equal(ota.decide('1.9.2', LATEST, null, T).reason, 'offer', 'clean 1.9.2 -> offered');
  assert.equal(ota.decide('1.9.1', LATEST, null, T).reason, 'offer', 'clean 1.9.1 -> offered');
  assert.equal(ota.decide('1.7.12', LATEST, null, T).reason, 'offer', 'old clean release -> offered');
  assert.equal(ota.decide('1.9.3', LATEST, null, T).reason, 'up-to-date');
  assert.equal(ota.decide('1.9.4', LATEST, null, T).reason, 'client-newer', 'never downgrade a newer core');
});

test('a prerelease of a HIGHER core is client-newer, not offered (e.g. a 1.9.4-beta1 tester)', () => {
  ota.reset();
  assert.equal(ota.decide('1.9.4-beta1', LATEST, null, T).reason, 'client-newer');
  // and a -patchN of a higher core is likewise newer (never a downgrade)
  assert.equal(ota.decide('1.9.4-patch1', LATEST, null, T).reason, 'client-newer');
});

test('regression: unrecognized/garbage still refused; the fix did not loosen the phantom guard', () => {
  ota.reset();
  assert.equal(ota.decide('banana', LATEST, null, T).reason, 'unrecognized-version');
  assert.equal(ota.decide('', LATEST, null, T).reason, 'no-version');
});

test('regression: with a PRERELEASE server (beta4 latest), superseded-prerelease still fires for older betas', () => {
  ota.reset();
  // mirrors the existing ota-breaker.test.js scenario — a -patchN client change must not disturb it
  const d = ota.decide('1.9.1-beta4', '1.9.2-beta4', null, T);
  assert.equal(d.reason, 'superseded-prerelease');
  // a same-core older beta against a beta server is offerable (rate path), unchanged
  assert.equal(ota.decide('1.9.2-beta3', '1.9.2-beta4', null, T).reason, 'offer');
});
