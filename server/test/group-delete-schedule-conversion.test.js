'use strict';

// Deleting a device group converts its group schedules into per-device ones so the screens keep
// their programming. That INSERT omitted workspace_id, which is nullable with no default — so every
// converted row landed with workspace_id = NULL.
//
// A null workspace does not merely look untidy. It makes the row unreachable in three directions at
// once, and they compound into the worst possible combination:
//
//   invisible   — the schedule list and the all-screens calendar both filter on workspace_id
//   undeletable — PUT and DELETE refuse a row with no workspace (403)
//   still live  — services/scheduler.js has NO workspace filter, so it keeps firing every 60s
//
// i.e. "I deleted the group but the screens still switch content at 9am, and there is nothing in
// the calendar to remove." The only way out was direct database access.
//
// The invariant: a schedule that survives a group deletion stays owned by a workspace, so it can be
// seen and removed by the person whose screens it controls.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'st-groupdel-'));
process.env.DATA_DIR = tmp;
process.env.JWT_SECRET = 'test-secret-group-delete';

const express = require('express');
const { db } = require('../db/database');
const { requireAuth, generateToken } = require('../middleware/auth');
const { resolveTenancy } = require('../lib/tenancy');

const O = 'o-gd', WS = 'ws-gd', U = 'u-gd', G = 'g-gd', DEV = 'dev-gd';
db.prepare("INSERT OR IGNORE INTO users (id,email,password_hash,role) VALUES (?,?, 'x','user')").run(U, 'gd@t.local');
db.prepare('INSERT OR IGNORE INTO organizations (id,name,owner_user_id) VALUES (?,?,?)').run(O, 'Org', U);
db.prepare('INSERT OR IGNORE INTO workspaces (id,organization_id,name) VALUES (?,?,?)').run(WS, O, 'WS');
db.prepare("INSERT OR IGNORE INTO organization_members (organization_id,user_id,role) VALUES (?,?, 'org_owner')").run(O, U);
db.prepare(`INSERT OR IGNORE INTO devices (id,name,workspace_id,created_at,updated_at)
            VALUES (?,?,?,strftime('%s','now'),strftime('%s','now'))`).run(DEV, 'Screen', WS);
db.prepare('INSERT OR IGNORE INTO device_groups (id,name,workspace_id,user_id) VALUES (?,?,?,?)').run(G, 'Group', WS, U);
db.prepare('INSERT OR IGNORE INTO device_group_members (group_id,device_id) VALUES (?,?)').run(G, DEV);
db.prepare(`INSERT OR IGNORE INTO schedules (id,user_id,workspace_id,group_id,title,start_time,end_time,timezone,priority,enabled)
            VALUES ('sg-1',?,?,?, 'Morning menu','09:00','17:00','UTC',1,1)`).run(U, WS, G);

const app = express();
app.use(express.json());
app.set('io', null);
app.use('/api/groups', requireAuth, resolveTenancy, require('../routes/device-groups'));
const server = app.listen(0);
const token = generateToken(db.prepare('SELECT id,email,role FROM users WHERE id = ?').get(U), WS);

async function deleteGroup() {
  await new Promise(r => (server.listening ? r() : server.once('listening', r)));
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/groups/${G}`, {
    method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

test('THE BUG: a schedule that survives a group deletion keeps its workspace', async () => {
  const { status, body } = await deleteGroup();
  assert.equal(status, 200);
  assert.ok(body.schedules_converted >= 1, 'the schedule should have been converted, not dropped');

  const converted = db.prepare('SELECT * FROM schedules WHERE device_id = ? AND group_id IS NULL').all(DEV);
  assert.equal(converted.length, 1);
  assert.equal(converted[0].workspace_id, WS, 'a null workspace makes the row invisible AND undeletable AND live');
});

test('the converted schedule is therefore visible to the workspace it controls', () => {
  // This is the query the schedule list and the calendar both use.
  const visible = db.prepare('SELECT COUNT(*) n FROM schedules WHERE workspace_id = ? AND device_id = ?').get(WS, DEV).n;
  assert.equal(visible, 1);
});

test('the programming itself is preserved, not just the ownership', () => {
  const s = db.prepare('SELECT * FROM schedules WHERE device_id = ? AND group_id IS NULL').get(DEV);
  assert.equal(s.title, 'Morning menu');
  assert.equal(s.start_time, '09:00');
  assert.equal(s.end_time, '17:00');
  assert.equal(s.enabled, 1);
});

test('the repair recovers rows orphaned before this fix existed', () => {
  // Simulate the old behaviour, then run the same statement the boot migration runs.
  db.prepare(`INSERT INTO schedules (id,user_id,workspace_id,device_id,title,start_time,end_time,timezone,priority,enabled)
              VALUES ('legacy-orphan',?,NULL,?, 'Orphan','06:00','08:00','UTC',1,1)`).run(U, DEV);
  assert.equal(db.prepare("SELECT workspace_id FROM schedules WHERE id='legacy-orphan'").get().workspace_id, null);

  db.prepare(`UPDATE schedules SET workspace_id = (SELECT d.workspace_id FROM devices d WHERE d.id = schedules.device_id)
              WHERE workspace_id IS NULL AND device_id IS NOT NULL
                AND (SELECT d.workspace_id FROM devices d WHERE d.id = schedules.device_id) IS NOT NULL`).run();

  assert.equal(db.prepare("SELECT workspace_id FROM schedules WHERE id='legacy-orphan'").get().workspace_id, WS,
    'an operator must be able to see and delete it from the dashboard');
});

test.after(() => { server.close(); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {} });
