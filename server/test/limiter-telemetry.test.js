'use strict';

// QA-SNAT. The auth limiters are app.use middleware that return 429 before the handler that
// writes activity_log, so a rejection leaves no trace anywhere — the limit censors the evidence
// of itself. Four production IPs sit at exactly 10 logins/min and there is no way to tell
// whether that is one attacker or a NATed office colliding on a shared egress address.
//
// The count of rejections does NOT answer that. The count of DISTINCT ACCOUNTS per IP does:
// one account hammered means the limiter is working as intended; several accounts each denied
// a few times means real users are being locked out by a shared IP. That is the measurement
// pinned here.
//
// The second thing pinned here is restraint: this must not quietly become a store of customer
// email addresses. Identifiers are salted-hashed and only ever counted.

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const tel = require('../lib/limiter-telemetry');

beforeEach(() => tel.reset());

const rej = (ip, identifier, endpoint = '/api/auth/login') =>
  tel.recordRejection({ endpoint, ip, identifier });

test('THE POINT: one account hammered reads differently from many accounts denied', () => {
  for (let i = 0; i < 20; i++) rej('203.0.113.1', 'victim@example.com');
  for (const who of ['a@corp.test', 'b@corp.test', 'c@corp.test', 'd@corp.test']) rej('203.0.113.2', who);

  const [attacker] = tel.snapshot().filter(r => r.ip === '203.0.113.1');
  const [office] = tel.snapshot().filter(r => r.ip === '203.0.113.2');

  assert.equal(attacker.distinctIdentifiers, 1);
  assert.equal(attacker.likelySharedEgress, false, 'many rejections, one account -> limiter working');
  assert.equal(office.distinctIdentifiers, 4);
  assert.equal(office.likelySharedEgress, true, 'few rejections each, many accounts -> shared egress');
  assert.ok(office.rejections < attacker.rejections,
    'and the rejection COUNT alone would have ranked these the wrong way round');
});

test('identifiers are never exposed — counts only', () => {
  rej('203.0.113.3', 'secret.person@customer.example');
  const dump = JSON.stringify(tel.snapshot());
  assert.doesNotMatch(dump, /secret\.person/, 'no address in the snapshot');
  assert.doesNotMatch(dump, /customer\.example/, 'not even the domain');
  assert.match(dump, /"distinctIdentifiers":1/);
});

test('the same account in different case is one account, not two', () => {
  rej('203.0.113.4', 'Bob@Example.COM');
  rej('203.0.113.4', 'bob@example.com');
  assert.equal(tel.snapshot()[0].distinctIdentifiers, 1, 'or an attacker could inflate the count and look like an office');
});

test('endpoint and IP are keyed separately', () => {
  rej('203.0.113.5', 'x@y.z', '/api/auth/login');
  rej('203.0.113.5', 'x@y.z', '/api/auth/register');
  rej('203.0.113.6', 'x@y.z', '/api/auth/login');
  assert.equal(tel.snapshot().length, 3, 'three distinct buckets');
});

test('a rejection with no identifier still counts', () => {
  // Not every limited endpoint carries an email (reset-password redeem, totp verify).
  const t = rej('203.0.113.7', undefined, '/api/auth/reset-password');
  assert.equal(t.rejections, 1);
  assert.equal(t.distinctIdentifiers, 0);
});

test('memory is bounded, and says so rather than silently undercounting', () => {
  for (let i = 0; i < tel.MAX_IDS_PER_KEY + 25; i++) rej('203.0.113.8', `u${i}@x.test`);
  const row = tel.snapshot()[0];
  assert.equal(row.distinctIdentifiers, tel.MAX_IDS_PER_KEY, 'capped');
  assert.equal(row.identifiersTruncated, true, 'and flagged, so the number is not read as exact');
});

test('key count is bounded under a flood of distinct IPs', () => {
  for (let i = 0; i < tel.MAX_KEYS + 500; i++) rej(`198.51.100.${i}`, 'x@y.z');
  assert.ok(tel.snapshot().length <= tel.MAX_KEYS, 'cannot be grown without limit by spraying IPs');
});

test('busiest first, so the snapshot is readable at a glance', () => {
  rej('203.0.113.9', 'a@x.t');
  for (let i = 0; i < 5; i++) rej('203.0.113.10', 'b@x.t');
  assert.equal(tel.snapshot()[0].ip, '203.0.113.10');
});
