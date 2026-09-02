'use strict';

// The companion to limiter-telemetry.test.js: that one tests the counter, this one proves the
// counter is actually WIRED to a real 429 and that adding it changed nothing about the limiter.
// A diagnostic that alters the thing it measures is worse than no diagnostic.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');

const { freePort } = require('./helpers/free-port');
let PORT, BASE, proc, adminToken;
const DATA_DIR = path.join(os.tmpdir(), 'st-limrej-' + crypto.randomBytes(4).toString('hex'));
const LOG = path.join(os.tmpdir(), 'st-limrej-' + crypto.randomBytes(4).toString('hex') + '.log');

const jfetch = async (p, opts = {}) => {
  const res = await fetch(BASE + p, opts);
  let body = null; try { body = await res.json(); } catch { /* */ }
  return { status: res.status, body };
};
const login = (email, ip) => jfetch('/api/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
  body: JSON.stringify({ email, password: 'definitely-wrong-password' }),
});

before(async () => {
  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  const logFd = fs.openSync(LOG, 'w');
  proc = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(PORT), NODE_ENV: 'test' },
    stdio: ['ignore', logFd, logFd],
  });
  let up = false;
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(BASE + '/api/status'); if (r.ok) { up = true; break; } } catch { /* */ }
    await new Promise(r => setTimeout(r, 250));
  }
  if (!up) throw new Error('server did not boot:\n' + fs.readFileSync(LOG, 'utf8').slice(-2000));

  // First account on a fresh self-hosted instance is platform_admin — the only role that may
  // read the diagnostic.
  const reg = await jfetch('/api/auth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.10.1' },
    body: JSON.stringify({ email: 'admin' + crypto.randomBytes(4).toString('hex') + '@x.local', password: 'Passw0rd123' }),
  });
  adminToken = reg.body.token;
});
after(() => { try { proc.kill('SIGKILL'); } catch { /* */ } });

const snapshot = () => jfetch('/api/admin/limiter-rejections', { headers: { Authorization: 'Bearer ' + adminToken } });

test('the limiter still behaves exactly as before: 10 through, then 429', async () => {
  const IP = '198.51.99.10';
  const codes = [];
  for (let i = 0; i < 12; i++) codes.push((await login(`u${i}@corp.test`, IP)).status);
  assert.equal(codes.filter(c => c === 429).length, 2, 'the 11th and 12th are rejected');
  assert.ok(!codes.slice(0, 10).includes(429), 'the first ten are not');
  const body = (await login('u0@corp.test', IP));
  assert.equal(body.status, 429);
  assert.deepEqual(body.body, { error: 'Too many requests, try again later' },
    'response shape unchanged — the diagnostic is invisible to clients');
});

test('the rejection is recorded, with the distinct-account signal that answers QA-SNAT', async () => {
  const snap = await snapshot();
  assert.equal(snap.status, 200);
  const row = snap.body.rows.find(r => r.ip === '198.51.99.10');
  assert.ok(row, 'the 429 left a trace — previously it left none at all');
  assert.equal(row.endpoint, '/api/auth/login');
  assert.ok(row.rejections >= 2);
  assert.ok(row.distinctIdentifiers >= 3, 'several accounts from one IP');
  assert.equal(row.likelySharedEgress, true, 'which reads as a NATed site, not one attacker');
  assert.ok(snap.body.shared_egress_suspects >= 1);
});

test('one account hammered is NOT flagged as a shared egress', async () => {
  const IP = '198.51.99.11';
  for (let i = 0; i < 12; i++) await login('one.victim@corp.test', IP);
  const row = (await snapshot()).body.rows.find(r => r.ip === IP);
  assert.equal(row.distinctIdentifiers, 1);
  assert.equal(row.likelySharedEgress, false, 'the limiter is doing its job here — do not widen it');
});

test('the diagnostic never leaks the addresses it counted', async () => {
  const dump = JSON.stringify((await snapshot()).body);
  assert.doesNotMatch(dump, /one\.victim/);
  assert.doesNotMatch(dump, /corp\.test/);
});

test('it is platform-admin gated, not readable by an ordinary tenant', async () => {
  const reg = await jfetch('/api/auth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.10.2' },
    body: JSON.stringify({ email: 'plain' + crypto.randomBytes(4).toString('hex') + '@x.local', password: 'Passw0rd123' }),
  });
  const r = await jfetch('/api/admin/limiter-rejections', { headers: { Authorization: 'Bearer ' + reg.body.token } });
  assert.ok(r.status === 403 || r.status === 401, `ordinary user refused (got ${r.status})`);
  const anon = await jfetch('/api/admin/limiter-rejections');
  assert.ok(anon.status === 401 || anon.status === 403, 'and anonymous too');
});
