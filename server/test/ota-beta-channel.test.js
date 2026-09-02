'use strict';

// Handing someone a test build was a trap.
//
// A prerelease sorts BELOW its own release: 1.9.25-fix234d < 1.9.25. So a display sideloaded with a
// test build asked the server "anything newer?", was correctly told yes — the released 1.9.25 — and
// updated itself straight back off the build we had asked someone to test. Same versionCode, so
// Android installed it without complaint. Silent, within minutes.
//
// It happened on #234: the reporter installed the fix, tested for an evening, and reported that
// nothing had changed. They were right — their tablet was running the old code again by then.
//
// The opt-in is per display and deliberately narrow: it holds a prerelease of the CURRENT core
// only. An older-core prerelease is genuinely stale and must still be offered an update, and once a
// newer release ships the display must rejoin it — otherwise "beta" quietly becomes "abandoned on a
// branch nobody maintains".

const { test } = require('node:test');
const assert = require('node:assert/strict');
const breaker = require('../lib/ota-breaker');

// decide(client, latest, deviceId, now, betaChannel)
const ask = (client, latest, beta) => breaker.decide(client, latest, null, Date.now(), beta);

test('THE BUG: without the opt-in, a test build is offered its own release and reverts', () => {
  const v = ask('1.9.25-fix234d', '1.9.25', false);
  assert.equal(v.update_available, true, 'this is the revert that cost a reporter an evening');
  assert.equal(v.reason, 'offer');
});

test('THE FIX: an opted-in display keeps a prerelease of the current release', () => {
  const v = ask('1.9.25-fix234d', '1.9.25', true);
  assert.equal(v.update_available, false);
  assert.equal(v.reason, 'beta-channel');
});

test('opting in does NOT strand a display once a newer release ships', () => {
  // The whole risk of a beta flag is that it becomes permanent. 1.9.26 is a real newer core, so an
  // opted-in display on any 1.9.25 build must take it.
  const v = ask('1.9.25-fix234d', '1.9.26', true);
  assert.equal(v.update_available, true, 'a beta display must rejoin the next real release');
});

test('the superseded-prerelease guard is untouched for displays that did NOT opt in', () => {
  // #144's phantom protection: a device reporting an ancient beta is not chased with offers.
  const v = ask('1.9.1-beta4', '1.9.25', false);
  assert.equal(v.update_available, false);
  assert.equal(v.reason, 'superseded-prerelease');
});

test('but an opted-in display on an old prerelease IS offered the current release', () => {
  // This is the escape hatch, and it is the difference between "beta" and "abandoned". Without
  // it the superseded guard pins a tester on an old test build permanently — they would have to
  // notice and sideload their way out, which is exactly the trap the opt-in exists to remove.
  const v = ask('1.9.1-beta4', '1.9.25', true);
  assert.equal(v.update_available, true, 'opting in must never mean never updating again');
});

test('the opt-in changes nothing for a display on a plain release', () => {
  assert.equal(ask('1.9.25', '1.9.25', true).reason, 'up-to-date');
  assert.equal(ask('1.9.24', '1.9.25', true).update_available, true, 'a real upgrade is unaffected');
  assert.equal(ask('1.9.24', '1.9.25', false).update_available, true);
});

test('a display ahead of the server is never downgraded, opted in or not', () => {
  assert.equal(ask('1.9.26', '1.9.25', true).reason, 'client-newer');
  assert.equal(ask('1.9.26', '1.9.25', false).reason, 'client-newer');
});

test('a -patchN build is a release, not a prerelease, so beta does not pin it', () => {
  // isReleased() treats patchN as released; it must keep being offered real updates.
  const v = ask('1.9.2-patch3', '1.9.25', true);
  assert.equal(v.update_available, true, 'a patch release must not be mistaken for a beta build');
});

test('the flag defaults to off, so nothing changes for a fleet that never sets it', () => {
  const withDefault = breaker.decide('1.9.25-fix234d', '1.9.25', null, Date.now());
  assert.equal(withDefault.update_available, true, 'default must match pre-existing behaviour');
});
