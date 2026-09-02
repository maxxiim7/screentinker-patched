'use strict';

// GET /api/devices/:id/screenshot returns a live picture of what a screen is showing, so
// it must be authorised the same way every other device route is: by the caller's access
// to the DEVICE'S WORKSPACE.
//
// It instead used a pre-tenancy ownership test — `device.user_id !== user.id`, with an
// elevated-role bypass listing 'admin'/'superadmin'. Three consequences this pins:
//
//   1. `device.user_id &&` SHORT-CIRCUITS. A device with no user_id (never paired, or its
//      owner was deleted) skips the ownership test entirely, so ANY authenticated user on
//      the instance can read it. An unpaired panel displays its pairing code on screen,
//      so that image is also a route to claiming the device (see AUTH-10).
//   2. platform_admin is NOT in the bypass list. The #14 migration renamed superadmin ->
//      platform_admin, so a real platform admin falls through to the ownership test and is
//      denied unless they happen to own the row.
//   3. Workspace members other than the owner are denied a device they can otherwise fully
//      administer through every other endpoint.

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
const DATA_DIR = path.join(os.tmpdir(), 'st-shot-test-' + crypto.randomBytes(4).toString('hex'));
const LOG = path.join(os.tmpdir(), 'st-shot-' + crypto.randomBytes(4).toString('hex') + '.log');
const PW = 'Passw0rd123';
const S = {};

const jfetch = async (p, opts = {}) => {
  const res = await fetch(BASE + p, opts);
  let body = null; try { body = await res.json(); } catch { /* binary/none */ }
  return { status: res.status, body };
};
const post = (obj) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });
const shot = (deviceId, token) => fetch(`${BASE}/api/devices/${deviceId}/screenshot`, { headers: { Authorization: 'Bearer ' + token } });

async function register() {
  const email = 'u' + crypto.randomBytes(5).toString('hex') + '@x.local';
  const r = await jfetch('/api/auth/register', post({ email, password: PW }));
  return { email, token: r.body.token, id: r.body.user.id, role: r.body.user.role };
}

// Give a device a screenshot on disk so a permitted caller gets a real 200.
function seedScreenshot(deviceId) {
  const file = `${deviceId}_latest.jpg`;
  fs.mkdirSync(path.join(DATA_DIR, 'uploads', 'screenshots'), { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, 'uploads', 'screenshots', file), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]));
  // screenshots.id is an INTEGER rowid alias — let SQLite assign it.
  db.prepare('INSERT INTO screenshots (device_id, filepath, captured_at) VALUES (?,?,?)')
    .run(deviceId, file, Math.floor(Date.now() / 1000));
}

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
    try { const r = await fetch(BASE + '/api/status'); if (r.ok) { up = true; break; } } catch { /* not yet */ }
    await new Promise(r => setTimeout(r, 250));
  }
  if (!up) throw new Error('server did not boot:\n' + fs.readFileSync(LOG, 'utf8').slice(-2000));
  db = new Database(path.join(DATA_DIR, 'db', 'remote_display.db'));

  S.admin = await register();                 // first user => platform_admin
  assert.equal(S.admin.role, 'platform_admin');
  S.owner = await register();                 // owns a device, in its own workspace
  S.outsider = await register();              // no relationship to that device

  S.ownerWs = db.prepare('SELECT workspace_id FROM workspace_members WHERE user_id = ?').get(S.owner.id).workspace_id;

  // A normally-paired device: owned, and in the owner's workspace.
  S.owned = crypto.randomUUID();
  db.prepare("INSERT INTO devices (id, user_id, workspace_id, name, status) VALUES (?,?,?,'Owned','online')")
    .run(S.owned, S.owner.id, S.ownerWs);
  seedScreenshot(S.owned);

  // An UNPAIRED device: no user_id, no workspace — the state a panel sits in while it is
  // displaying its pairing code.
  S.unpaired = crypto.randomUUID();
  db.prepare("INSERT INTO devices (id, user_id, workspace_id, name, status, pairing_code) VALUES (?,NULL,NULL,'Unpaired','provisioning','424242')")
    .run(S.unpaired);
  seedScreenshot(S.unpaired);
});
after(() => { try { db && db.close(); } catch { /* */ } try { proc.kill('SIGKILL'); } catch { /* */ } });

test('the device owner can read its screenshot', async () => {
  const res = await shot(S.owned, S.owner.token);
  assert.equal(res.status, 200, 'the owner must keep working');
});

test('an unrelated user cannot read a device in a workspace they are not in', async () => {
  const res = await shot(S.owned, S.outsider.token);
  assert.equal(res.status, 403, 'no access path to that workspace');
});

test('a platform admin can read any device screenshot', async () => {
  const res = await shot(S.owned, S.admin.token);
  assert.equal(res.status, 200, 'platform_admin must not be denied by a stale role list');
});

test('an UNPAIRED device is not readable by an arbitrary authenticated user', async () => {
  // The short-circuit made this readable by anyone with an account. An unpaired panel is
  // showing its pairing code, so the image is also a claim vector.
  const res = await shot(S.unpaired, S.outsider.token);
  assert.ok(res.status === 403 || res.status === 404,
    `an unassigned device must not be readable by any account (got ${res.status})`);
});

test('an unknown device id is still a 404, and no token is still a 401', async () => {
  assert.equal((await shot(crypto.randomUUID(), S.owner.token)).status, 404);
  assert.equal((await fetch(`${BASE}/api/devices/${S.owned}/screenshot`)).status, 401);
});
