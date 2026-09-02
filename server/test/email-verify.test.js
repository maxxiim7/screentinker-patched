'use strict';

// Email verification on signup. Boots the real server with a mail transport CONFIGURED
// (SMTP pointed at a dead port — sendEmail() never throws, so nothing actually sends, but
// isConfigured() is true so the gate engages). Covers the hosted HARD block and the self-host
// SOFT nudge, plus the verify-link + resend endpoints.
//
// Assertions go through the API (login / register responses), NOT direct DB reads: the server
// runs in a separate process and, under WAL, a fresh test-side connection can read a stale
// snapshot of the server's just-committed write. Planting a verification token IS a DB write
// (test -> server), which the server reads correctly. Register calls are kept <=5 per server
// to stay under the 5/min-per-IP register limit (each describe boots its own server -> own limit).

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const { freePort } = require('./helpers/free-port');

const PW = 'Passw0rd123';
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const rand = () => crypto.randomBytes(5).toString('hex');
const MAIL_ENV = { EMAIL_TRANSPORT: 'smtp', SMTP_HOST: '127.0.0.1', SMTP_PORT: '2', SMTP_FROM: 'noreply@test.local' };

async function boot(extraEnv) {
  const PORT = await freePort();
  const BASE = `http://127.0.0.1:${PORT}`;
  const DATA_DIR = path.join(os.tmpdir(), 'st-ev-' + rand());
  const LOG = path.join(os.tmpdir(), 'st-ev-' + rand() + '.log');
  const logFd = fs.openSync(LOG, 'w');
  const proc = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, ...MAIL_ENV, ...extraEnv, DATA_DIR, PORT: String(PORT), NODE_ENV: 'test' },
    stdio: ['ignore', logFd, logFd],
  });
  let up = false;
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(BASE + '/api/status'); if (r.ok) { up = true; break; } } catch { /* not yet */ }
    await new Promise(r => setTimeout(r, 250));
  }
  if (!up) throw new Error('server did not boot:\n' + fs.readFileSync(LOG, 'utf8').slice(-2000));
  return { BASE, proc, dbPath: path.join(DATA_DIR, 'db', 'remote_display.db') };
}

async function jfetch(BASE, p, body, method = 'POST') {
  const res = await fetch(BASE + p, {
    method, redirect: 'manual',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null; try { json = await res.json(); } catch { /* redirect / non-JSON */ }
  return { status: res.status, body: json, location: res.headers.get('location') };
}
const register = (BASE, email) => jfetch(BASE, '/api/auth/register', { email, password: PW });
const login = (BASE, email) => jfetch(BASE, '/api/auth/login', { email, password: PW });

// Plant a known verification token straight into the user's row (the plaintext otherwise lives
// only in the email). A test->server write; the server reads it correctly.
function plantToken(dbPath, email, tok, expiresInSec = 3600) {
  const db = new Database(dbPath); db.pragma('busy_timeout = 4000');
  try {
    db.prepare('UPDATE users SET email_verify_hash=?, email_verify_expires=? WHERE email=?')
      .run(sha256(tok), Math.floor(Date.now() / 1000) + expiresInSec, email);
  } finally { db.close(); }
}
function forceUnverified(dbPath, email) {
  const db = new Database(dbPath); db.pragma('busy_timeout = 4000');
  try {
    db.prepare('UPDATE users SET email_verified=0, email_verify_hash=NULL, email_verify_expires=NULL WHERE email=?').run(email);
  } finally { db.close(); }
}

describe('hosted (SELF_HOSTED unset): hard block until verified', () => {
  let S;
  before(async () => { S = await boot({ SELF_HOSTED: 'false' }); });
  after(() => { try { S.proc.kill('SIGKILL'); } catch { /* ignore */ } });

  test('first user is exempt; a later signup is gated with no session', async () => {
    const admin = 'ev-admin-' + rand() + '@x.test';
    const first = await register(S.BASE, admin);
    assert.equal(first.status, 201);
    assert.ok(first.body.token, 'first/bootstrap user is verified -> full session');

    const email = 'ev-' + rand() + '@x.test';
    const r = await register(S.BASE, email);
    assert.equal(r.body.verification_required, true, 'gated signup');
    assert.equal(r.body.token, undefined, 'NO session before verification');
  });

  test('login is blocked until verified, then succeeds; verify link is single-use', async () => {
    const email = 'ev-' + rand() + '@x.test';
    await register(S.BASE, email);

    const blocked = await login(S.BASE, email);
    assert.equal(blocked.body.verification_required, true, 'login blocked while unverified');
    assert.equal(blocked.body.token, undefined);

    const tok = rand() + rand();
    plantToken(S.dbPath, email, tok);
    const click = await jfetch(S.BASE, '/api/auth/verify-email?token=' + tok, null, 'GET');
    assert.equal(click.status, 302);
    assert.match(click.location, /verified=1/);

    const ok = await login(S.BASE, email);
    assert.ok(ok.body.token, 'login succeeds after verification');
    assert.equal(ok.body.user.email_verified, 1);

    const reuse = await jfetch(S.BASE, '/api/auth/verify-email?token=' + tok, null, 'GET');
    assert.match(reuse.location, /verify_error=1/, 'single-use: second click errors');
  });

  test('bad and expired tokens redirect to verify_error', async () => {
    const bad = await jfetch(S.BASE, '/api/auth/verify-email?token=deadbeef', null, 'GET');
    assert.match(bad.location, /verify_error=1/);

    const email = 'ev-' + rand() + '@x.test';
    await register(S.BASE, email);
    const tok = rand() + rand();
    plantToken(S.dbPath, email, tok, -10); // already expired
    const click = await jfetch(S.BASE, '/api/auth/verify-email?token=' + tok, null, 'GET');
    assert.match(click.location, /verify_error=1/, 'expired token rejected');

    // ...and that same user (still unverified) is asked on login — the existing-user path.
    const gated = await login(S.BASE, email);
    assert.equal(gated.body.verification_required, true, 'unverified user is gated on login');
  });

  test('resend is generic for known, unknown, and already-verified addresses', async () => {
    const email = 'ev-' + rand() + '@x.test';
    await register(S.BASE, email);
    assert.deepEqual((await jfetch(S.BASE, '/api/auth/resend-verification', { email })).body, { ok: true });
    assert.deepEqual((await jfetch(S.BASE, '/api/auth/resend-verification', { email: 'nobody-' + rand() + '@x.test' })).body,
      { ok: true }, 'unknown address returns the same generic ok (no enumeration)');
  });
});

describe('self-host (SELF_HOSTED=true): soft nudge, never blocks', () => {
  let S;
  before(async () => { S = await boot({ SELF_HOSTED: 'true' }); });
  after(() => { try { S.proc.kill('SIGKILL'); } catch { /* ignore */ } });

  test('a later signup still gets a session, flagged unverified for the banner', async () => {
    await register(S.BASE, 'ev-admin-' + rand() + '@x.test'); // first user
    const email = 'ev-' + rand() + '@x.test';
    const r = await register(S.BASE, email);
    assert.ok(r.body.token, 'self-host issues a session even when unverified');
    assert.equal(r.body.user.email_verified, 0, 'flagged unverified so the client can nudge');

    const li = await login(S.BASE, email);
    assert.ok(li.body.token, 'login proceeds (soft nudge, no block)');

    // An existing/unverified user still logs in on self-host (soft), never gated.
    forceUnverified(S.dbPath, email);
    assert.ok((await login(S.BASE, email)).body.token, 'still no block after forcing unverified');
  });
});
