'use strict';

// A group is the mixed-platform case by definition: a lobby group holding two Android panels and
// a couple of browser tabs. "Reboot" is a legitimate thing to ask that group, and the two Android
// panels should get it — but the browser tabs cannot reboot their host, and the response used to
// count them as sent. The operator reads "sent to 4/4 devices" and walks away believing the whole
// group rebooted, which is the exact failure the capability model exists to end, just aggregated.
//
// The choice being pinned here: report per-device, do NOT refuse the whole command. Failing all
// four because one member is a browser tab would be its own bug.

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
const DATA_DIR = path.join(os.tmpdir(), 'st-grpcaps-' + crypto.randomBytes(4).toString('hex'));
const LOG = path.join(os.tmpdir(), 'st-grpcaps-' + crypto.randomBytes(4).toString('hex') + '.log');
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

  const g = await jfetch('/api/groups', {
    method: 'POST', headers: auth(), body: JSON.stringify({ name: 'lobby' }),
  });
  S.groupId = g.body.id;

  // Two Android panels and two browser tabs.
  //
  // The panels DECLARE system.reboot (i.e. they are device owners) rather than relying on the
  // baseline. The parity audit removed system.reboot from the Android baseline — STPolicy.reboot()
  // needs device owner, so an undeclared panel cannot honour it either — and with all four members
  // unable to reboot, this test would still pass while proving nothing. The point here is the
  // MIXED case: some members can, some cannot, and the response must not blur them together.
  const owner = JSON.stringify(['playback.video', 'system.reboot', 'system.restart_player']);
  S.android = [
    mkDevice({ client_type: 'apk', android_version: '12', capabilities: owner }),
    mkDevice({ client_type: 'apk', android_version: '12', capabilities: owner }),
  ];
  S.web = [mkDevice({ android_version: 'Web/Chrome' }), mkDevice({ android_version: 'Web/Chrome' })];
  for (const id of [...S.android, ...S.web]) {
    db.prepare('INSERT INTO device_group_members (group_id, device_id) VALUES (?, ?)').run(S.groupId, id);
  }
});
after(() => { try { db && db.close(); } catch { /* */ } try { proc.kill('SIGKILL'); } catch { /* */ } });

function mkDevice(cols) {
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO devices (id, name, status, workspace_id, device_token, client_type, android_version, capabilities, created_at)
              VALUES (?, ?, 'offline', ?, ?, ?, ?, ?, strftime('%s','now'))`)
    .run(id, 'panel-' + id.slice(0, 4), S.wsId, crypto.randomBytes(16).toString('hex'),
         cols.client_type || null, cols.android_version || null, cols.capabilities || null);
  return id;
}

const send = (type) => jfetch(`/api/groups/${S.groupId}/command`, {
  method: 'POST', headers: auth(), body: JSON.stringify({ type }),
});

test('reboot on a mixed group does not count the browser tabs as sent', async () => {
  const r = await send('reboot');
  assert.equal(r.status, 200);
  assert.equal(r.body.total, 4);
  assert.equal(r.body.unsupported, 2, 'the two web players cannot reboot their host');
  assert.equal(r.body.offline, 2, 'the two Android panels are reachable in principle, just not connected');
  assert.equal(r.body.sent, 0);
  assert.notEqual(r.body.offline + r.body.sent, 4,
    'before this, "4/4" was reported and the operator believed the whole group rebooted');
});

test('the response names which device was skipped and what it lacked', async () => {
  const r = await send('reboot');
  const skipped = r.body.results.filter(x => x.status === 'unsupported');
  assert.equal(skipped.length, 2);
  for (const x of skipped) {
    assert.ok(S.web.includes(x.device_id), 'only the web players are skipped');
    assert.equal(x.capability, 'system.reboot', 'so the reason is diagnosable without guessing');
    assert.ok(x.name, 'named, because a device_id alone means nothing to an operator');
  }
});

test('a command every member supports skips nobody', async () => {
  // The control case: gating that quietly refuses everything looks identical to gating that
  // works, until someone checks a command that should pass.
  const r = await send('launch');
  assert.equal(r.body.unsupported, 0, 'restarting the player is something all four can do');
  assert.equal(r.body.offline, 4);
});

test('one unsupported member does not fail the command for the rest of the group', async () => {
  const r = await send('reboot');
  assert.equal(r.status, 200, 'the request itself succeeds');
  assert.equal(r.body.success, true);
  assert.equal(r.body.results.length, 4, 'every member is accounted for, none silently dropped');
});
