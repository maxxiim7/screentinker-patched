'use strict';

// The OTA rate-breaker's bucket must not be a lever anyone can pull against someone else's panel.
//
// `/api/update/check` is deliberately unauthenticated — every client version has to be able to
// ask, including old ones that never learned to send a token — and it keys the breaker on the
// caller-supplied `?device_id=`. Keying on IP is not an option either: the fleet SNATs behind one
// address, so per-IP would collapse a whole site into one bucket (see lib/ota-breaker.js).
//
// The consequence was that anyone who learned a panel's UUID could burn its bucket with a handful
// of requests and leave the REAL panel in rate-backoff — silently un-updatable, for up to 30
// minutes at a time, renewable indefinitely.
//
// The containment is to make it self-healing rather than to add auth: when a device proves its
// identity on the /device socket (device_token, timing-safe compared) its bucket is cleared. An
// attacker can still make noise, but the denial now lasts until the panel's next genuine
// reconnect instead of as long as the attacker keeps poking.

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const breaker = require('../lib/ota-breaker');

const LATEST = '9.9.9';      // always newer than the client, so checks are "offerable"
const OLD = '1.0.0';

beforeEach(() => breaker.reset());

// Drive the breaker until it starts refusing, mirroring what the route does.
function hammer(deviceId, n) {
  let last = null;
  for (let i = 0; i < n; i++) last = breaker.decide(OLD, LATEST, deviceId);
  return last;
}

test('THE BUG: rapid checks against a device id trip that device into rate-backoff', () => {
  const victim = 'victim-device-uuid';
  const verdict = hammer(victim, breaker.THRESHOLD + 2);
  assert.equal(verdict.reason, 'rate-backoff', 'the bucket trips');
  assert.equal(verdict.update_available, false);
  assert.ok(verdict.retry_after_seconds > 0, 'and reports a cooldown');
});

test('the poisoning is TARGETED — only the named device is affected', () => {
  const victim = 'victim-device-uuid';
  hammer(victim, breaker.THRESHOLD + 2);
  const bystander = breaker.decide(OLD, LATEST, 'some-other-device');
  assert.notEqual(bystander.reason, 'rate-backoff', 'an unrelated device is unaffected');
  assert.equal(bystander.update_available, true, 'and is still offered its update');
});

test('the device proving its identity clears the backoff', () => {
  const victim = 'victim-device-uuid';
  assert.equal(hammer(victim, breaker.THRESHOLD + 2).reason, 'rate-backoff', 'poisoned first');

  const cleared = breaker.forgiveDevice(victim);
  assert.equal(cleared, true, 'the bucket existed and was cleared');

  const after = breaker.decide(OLD, LATEST, victim);
  assert.notEqual(after.reason, 'rate-backoff', 'the real device is no longer refused');
  assert.equal(after.update_available, true, 'and is offered its update again');
});

test('forgiving one device does not clear anyone else', () => {
  hammer('device-a', breaker.THRESHOLD + 2);
  hammer('device-b', breaker.THRESHOLD + 2);
  breaker.forgiveDevice('device-a');
  assert.equal(breaker.decide(OLD, LATEST, 'device-b').reason, 'rate-backoff',
    'device-b keeps its own state');
});

test('forgiving is safe for ids that were never seen, and for no id at all', () => {
  assert.equal(breaker.forgiveDevice('never-checked-in'), false, 'returns false rather than throwing');
  assert.equal(breaker.forgiveDevice(null), false);
  assert.equal(breaker.forgiveDevice(undefined), false);
  assert.equal(breaker.forgiveDevice(''), false);
});

test('a version-keyed bucket (no device_id) is NOT reachable by forgiveDevice', () => {
  // Old clients send only ?version=, so they share a per-version bucket. That one protects the
  // server from a fleet of stuck legacy clients and must not be clearable by device id.
  const v = hammer(null, breaker.THRESHOLD + 2);
  assert.equal(v.reason, 'rate-backoff', 'the version bucket trips');
  breaker.forgiveDevice(OLD);                 // the version string is not a device id
  assert.equal(breaker.decide(OLD, LATEST, null).reason, 'rate-backoff',
    'the version-keyed bucket survives — it is a different namespace');
});

test('the breaker still does its real job after a forgive', () => {
  const d = 'looping-device';
  breaker.forgiveDevice(d);
  // A device that genuinely loops still gets stopped; forgiving is not an escape hatch.
  assert.equal(hammer(d, breaker.THRESHOLD + 2).reason, 'rate-backoff',
    'a looping client is still rate-limited');
});
