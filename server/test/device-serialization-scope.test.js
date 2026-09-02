'use strict';

// What a device row carries depends on WHICH endpoint returned it.
//
// Two fields on `devices` are not ordinary data:
//   device_token  — the credential the player proves with on the /device socket. Never
//                   leaves the server, on any endpoint.
//   settings_pin  — unlocks the player's on-device settings menu (2x Back), i.e. hands
//                   someone standing at the panel physical control of it.
//
// The dashboard genuinely shows the PIN, but on exactly one screen — the device detail
// page, which fetches a single device. The collection endpoint has no consumer for it, so
// it does not send it: same data, far smaller blast radius. These tests pin that split so
// a future `SELECT d.*` on either path can't quietly widen it again.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');

const { freePort } = require('./helpers/free-port');
let PORT, BASE, proc, db;
const DATA_DIR = path.join(os.tmpdir(), 'st-devser-' + crypto.randomBytes(4).toString('hex'));
const LOG = path.join(os.tmpdir(), 'st-devser-' + crypto.randomBytes(4).toString('hex') + '.log');
const PIN = '8675309';
const TOKEN = 'device-token-must-never-ship';
const S = {};

const jfetch = async (p, opts = {}) => {
  const res = await fetch(BASE + p, opts);
  let body = null; try { body = await res.json(); } catch { /* */ }
  return { status: res.status, body };
};
const auth = () => ({ Authorization: 'Bearer ' + S.token, 'Content-Type': 'application/json' });

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
  db = new Database(path.join(DATA_DIR, 'db', 'remote_display.db'));

  const email = 'u' + crypto.randomBytes(5).toString('hex') + '@x.local';
  const reg = await jfetch('/api/auth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'Passw0rd123' }),
  });
  S.token = reg.body.token;
  const me = await jfetch('/api/auth/me', { headers: auth() });
  S.wsId = me.body.accessible_workspaces[0].id;

  S.deviceId = crypto.randomUUID();
  db.prepare(`INSERT INTO devices (id, name, status, workspace_id, settings_pin, device_token, created_at)
              VALUES (?, 'pinned panel', 'offline', ?, ?, ?, strftime('%s','now'))`)
    .run(S.deviceId, S.wsId, PIN, TOKEN);
});
after(() => { try { db && db.close(); } catch { /* */ } try { proc.kill('SIGKILL'); } catch { /* */ } });

const findOurs = (body) => {
  const rows = Array.isArray(body) ? body : (body?.items || body?.devices || []);
  return rows.find(d => d.id === S.deviceId);
};

test('the collection endpoint does not hand out every panel\'s settings PIN', async () => {
  const r = await jfetch('/api/devices', { headers: auth() });
  assert.equal(r.status, 200);
  const row = findOurs(r.body);
  assert.ok(row, 'our seeded device is in the list');
  assert.equal(row.settings_pin, undefined, 'settings_pin must not appear in the list response');
});

test('the detail endpoint still returns the PIN, because the dashboard shows it there', async () => {
  const r = await jfetch(`/api/devices/${S.deviceId}`, { headers: auth() });
  assert.equal(r.status, 200);
  assert.equal(r.body.settings_pin, PIN, 'the device detail page must keep working');
});

test('the device socket credential never leaves the server, on either endpoint', async () => {
  const list = await jfetch('/api/devices', { headers: auth() });
  const detail = await jfetch(`/api/devices/${S.deviceId}`, { headers: auth() });
  assert.equal(findOurs(list.body).device_token, undefined, 'absent from the list');
  assert.equal(detail.body.device_token, undefined, 'absent from the detail');
  // Belt and braces: the secret must not appear anywhere in either serialized payload.
  assert.ok(!JSON.stringify(list.body).includes(TOKEN), 'token string absent from the whole list payload');
  assert.ok(!JSON.stringify(detail.body).includes(TOKEN), 'token string absent from the whole detail payload');
});

test('sanitising is non-destructive to ordinary device fields', async () => {
  const r = await jfetch('/api/devices', { headers: auth() });
  const row = findOurs(r.body);
  assert.equal(row.name, 'pinned panel', 'ordinary fields survive');
  assert.equal(row.status, 'offline');
  assert.ok('orphan_count' in row, 'list-only decorations still applied');
});
