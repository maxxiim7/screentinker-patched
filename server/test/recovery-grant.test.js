'use strict';

// Break-glass recovery must be revocable, bounded and auditable.
//
// A `recovery: true` JWT was accepted on the strength of the claim alone, with no database
// involvement, so it could not be revoked without rotating JWT_SECRET (which logs out every
// user), could not be enumerated, and — because the synthetic id is not a users row — left
// no audit trail at all: every activity_log insert for it failed the user_id foreign key
// and was swallowed by a catch.
//
// These tests pin the properties that follow: a token is only good with a matching grant,
// only until it expires, and only until someone revokes it — and its first use is recorded.

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'st-recov-'));
process.env.DATA_DIR = TMP;
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-recovery-' + crypto.randomBytes(4).toString('hex');

const { test } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const grants = require('../lib/recovery-grant');
const { db } = require('../db/database');

// ---------------------------------------------------------------------------
// The grant lifecycle
// ---------------------------------------------------------------------------
test('a grant stays usable for the whole session, and records its first use', () => {
  // NOT single-use-per-request: a recovery admin makes many requests, so consuming the
  // grant on the first would make break-glass unusable. Revocation and expiry are the
  // controls; used_at is the audit stamp.
  const { jti } = grants.mint({ mintedBy: 'test' });
  assert.equal(grants.redeem(jti, { sourceIp: '10.0.0.1' }), true, 'first request works');
  assert.equal(grants.redeem(jti, { sourceIp: '10.0.0.9' }), true, 'so does the next one');
  assert.equal(grants.isSpent(jti), true, 'first use is recorded');
  const row = db.prepare('SELECT source_ip FROM recovery_grants WHERE jti = ?').get(jti);
  assert.equal(row.source_ip, '10.0.0.1', 'the FIRST use is what is attributed, not the latest');
});

test('an unknown jti never redeems', () => {
  assert.equal(grants.redeem(grants.newJti()), false);
  assert.equal(grants.redeem(''), false);
  assert.equal(grants.redeem(null), false);
});

test('an expired grant does not redeem', () => {
  const { jti } = grants.mint({ ttlSec: 60 });
  const later = Math.floor(Date.now() / 1000) + 3600;
  assert.equal(grants.redeem(jti, { now: later }), false, 'past its expiry it is refused');
});

test('revoke() kills an outstanding grant without touching anything else', () => {
  const a = grants.mint().jti;
  const b = grants.mint().jti;
  assert.equal(grants.revoke(a), 1);
  assert.equal(grants.redeem(a), false, 'revoked grant is dead');
  assert.equal(grants.redeem(b), true, 'an unrelated grant is unaffected');
});

test('outstanding grants are enumerable, and revokeAll clears them', () => {
  grants.revokeAll();
  grants.mint({ note: 'one' }); grants.mint({ note: 'two' });
  assert.equal(grants.listOutstanding().length, 2, 'an operator can see what is outstanding');
  grants.revokeAll();
  assert.equal(grants.listOutstanding().length, 0);
});

test('redeeming stamps who and when, so a break-glass session is attributable', () => {
  const { jti } = grants.mint({ mintedBy: 'root@host' });
  grants.redeem(jti, { sourceIp: '203.0.113.9' });
  const row = db.prepare('SELECT * FROM recovery_grants WHERE jti = ?').get(jti);
  assert.ok(row.used_at, 'used_at recorded');
  assert.equal(row.source_ip, '203.0.113.9');
  assert.equal(row.minted_by, 'root@host');
});

test('pruneExpired only removes rows that can never be redeemed again', () => {
  grants.revokeAll();
  const fresh = grants.mint({ ttlSec: 3600 }).jti;
  grants.pruneExpired(Math.floor(Date.now() / 1000));
  assert.equal(grants.listOutstanding().some(g => g.jti === fresh), true, 'a live grant survives pruning');
});

// ---------------------------------------------------------------------------
// Enforcement: requireAuth must demand a grant
// ---------------------------------------------------------------------------
const express = require('express');
const http = require('node:http');
const { requireAuth } = require('../middleware/auth');

function appWithAuth() {
  const app = express();
  app.get('/probe', requireAuth, (req, res) => res.json({ ok: true, id: req.user.id, provider: req.user.auth_provider }));
  return app;
}
async function probe(token) {
  const server = http.createServer(appWithAuth());
  await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const res = await fetch(base + '/probe', { headers: { Authorization: 'Bearer ' + token } });
  let body = null; try { body = await res.json(); } catch { /* */ }
  await new Promise(r => server.close(r));
  return { status: res.status, body };
}
const recoveryToken = (jti) => jwt.sign(
  { id: 'recovery-' + (jti || 'nogrant'), email: 'admin@localhost', role: 'admin', recovery: true, jti },
  process.env.JWT_SECRET, { expiresIn: '1h' }
);

test('a recovery token with NO grant row is refused', async () => {
  const r = await probe(recoveryToken(grants.newJti()));
  assert.equal(r.status, 401, 'an unbacked recovery claim must not authenticate');
});

test('a recovery token WITH a grant authenticates, and revocation ends it', async () => {
  const { jti } = grants.mint({ mintedBy: 'test' });
  const tok = recoveryToken(jti);
  const first = await probe(tok);
  assert.equal(first.status, 200, 'a backed recovery token works');
  assert.equal(first.body.provider, 'recovery');

  const second = await probe(tok);
  assert.equal(second.status, 200, 'the session keeps working — break-glass needs many requests');

  grants.revoke(jti);
  assert.equal((await probe(tok)).status, 401, 'but revoking it stops the very next request');
});

test('revoking the grant immediately kills the token', async () => {
  const { jti } = grants.mint();
  grants.revoke(jti);
  assert.equal((await probe(recoveryToken(jti))).status, 401);
});
