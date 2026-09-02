'use strict';

// Nudging one zone in the layout editor and pressing Save destroyed unrelated tenant data.
//
// The handler deleted every zone and re-inserted the same ids, and its comment claimed that was
// safe: "Reuse each zone's id when supplied so device->zone assignments survive an edit." It is
// not. SQLite runs referential actions on the DELETE, and re-inserting the same primary key does
// not resurrect what they took with them:
//
//   playlist_items.zone_id  ON DELETE SET NULL  -> every multi-zone playlist item un-assigned,
//                                                  so those playlists silently fell back to
//                                                  fullscreen across the workspace
//   schedules.zone_id       ON DELETE CASCADE   -> every zone-bound schedule DELETED, permanently
//
// 200 OK, no warning, no undo. The invariant: saving a layout must not change anything that merely
// POINTS at its zones — only removing a zone may do that, which is what the cascades are for.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'st-layoutsave-'));
process.env.DATA_DIR = tmp;
process.env.JWT_SECRET = 'test-secret-layout-save';

const express = require('express');
const { db } = require('../db/database');
const { requireAuth, generateToken } = require('../middleware/auth');
const { resolveTenancy } = require('../lib/tenancy');

const O = 'o-ls', WS = 'ws-ls', U = 'u-ls', L = 'l-ls', PL = 'pl-ls';
db.prepare("INSERT OR IGNORE INTO users (id,email,password_hash,role) VALUES (?,?, 'x','user')").run(U, 'ls@t.local');
db.prepare('INSERT OR IGNORE INTO organizations (id,name,owner_user_id) VALUES (?,?,?)').run(O, 'Org', U);
db.prepare('INSERT OR IGNORE INTO workspaces (id,organization_id,name) VALUES (?,?,?)').run(WS, O, 'WS');
db.prepare("INSERT OR IGNORE INTO organization_members (organization_id,user_id,role) VALUES (?,?, 'org_owner')").run(O, U);
db.prepare('INSERT OR IGNORE INTO layouts (id,workspace_id,user_id,name,width,height) VALUES (?,?,?,?,1920,1080)').run(L, WS, U, 'L');
db.prepare("INSERT OR IGNORE INTO layout_zones (id,layout_id,name,x_percent,y_percent,width_percent,height_percent,z_index,zone_type,fit_mode,background_color,sort_order) VALUES ('z-a',?,'A',0,0,100,50,1,'content','contain','#000000',0)").run(L);
db.prepare("INSERT OR IGNORE INTO layout_zones (id,layout_id,name,x_percent,y_percent,width_percent,height_percent,z_index,zone_type,fit_mode,background_color,sort_order) VALUES ('z-b',?,'B',0,50,100,50,2,'content','contain','#000000',1)").run(L);
db.prepare('INSERT OR IGNORE INTO playlists (id,name,workspace_id,user_id) VALUES (?,?,?,?)').run(PL, 'PL', WS, U);
db.prepare("INSERT OR IGNORE INTO content (id,workspace_id,user_id,filename,filepath,mime_type,file_size) VALUES ('c-1',?,?,'a.jpg','a.jpg','image/jpeg',10)").run(WS, U);
// playlist_items.id is an INTEGER rowid, so let SQLite assign it and remember what it gave us.
const ITEM_ID = db.prepare("INSERT INTO playlist_items (playlist_id,content_id,zone_id,sort_order,duration_sec) VALUES (?, 'c-1','z-a',0,10)").run(PL).lastInsertRowid;
// A schedule must target exactly one of device_id / group_id (CHECK constraint), so give it a device.
db.prepare(`INSERT OR IGNORE INTO devices (id,name,workspace_id,created_at,updated_at)
            VALUES ('dev-ls','Screen',?,strftime('%s','now'),strftime('%s','now'))`).run(WS);
db.prepare(`INSERT OR IGNORE INTO schedules (id,user_id,workspace_id,device_id,layout_id,zone_id,title,start_time,end_time,timezone,priority,enabled)
            VALUES ('s-1',?,?, 'dev-ls',?, 'z-a','Zone schedule','09:00','17:00','UTC',1,1)`).run(U, WS, L);

const app = express();
app.use(express.json());
app.set('io', null);
app.use('/api/layouts', requireAuth, resolveTenancy, require('../routes/layouts'));
const server = app.listen(0);
const token = generateToken(db.prepare('SELECT id,email,role FROM users WHERE id = ?').get(U), WS);

async function saveZones(zones) {
  await new Promise(r => (server.listening ? r() : server.once('listening', r)));
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/layouts/${L}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ zones }),
  });
  return res.status;
}

const itemZone = () => db.prepare('SELECT zone_id FROM playlist_items WHERE id = ?').get(ITEM_ID).zone_id;
const scheduleExists = () => !!db.prepare("SELECT 1 FROM schedules WHERE id = 's-1'").get();
const zoneIds = () => db.prepare('SELECT id FROM layout_zones WHERE layout_id = ? ORDER BY sort_order').all(L).map(r => r.id);

const CURRENT = () => [
  { id: 'z-a', name: 'A', x_percent: 0, y_percent: 0, width_percent: 100, height_percent: 50, z_index: 1, zone_type: 'content', fit_mode: 'contain' },
  { id: 'z-b', name: 'B', x_percent: 0, y_percent: 50, width_percent: 100, height_percent: 50, z_index: 2, zone_type: 'content', fit_mode: 'contain' },
];

test('THE BUG: moving a zone must not un-assign playlist items or delete schedules', async () => {
  assert.equal(itemZone(), 'z-a', 'precondition');
  assert.equal(scheduleExists(), true, 'precondition');

  const zones = CURRENT();
  zones[0].y_percent = 2;                      // the "nudge"
  assert.equal(await saveZones(zones), 200);

  assert.equal(itemZone(), 'z-a', 'the item must still be in its zone');
  assert.equal(scheduleExists(), true, 'the zone-bound schedule must still exist');
});

test('the geometry change is actually applied', async () => {
  const z = db.prepare("SELECT y_percent FROM layout_zones WHERE id = 'z-a'").get();
  assert.equal(z.y_percent, 2);
});

test('adding a zone leaves existing bindings alone', async () => {
  const zones = CURRENT();
  zones[0].y_percent = 2;
  zones.push({ name: 'C', x_percent: 0, y_percent: 90, width_percent: 100, height_percent: 10, z_index: 3, zone_type: 'content', fit_mode: 'contain' });
  assert.equal(await saveZones(zones), 200);
  assert.equal(zoneIds().length, 3);
  assert.equal(itemZone(), 'z-a');
  assert.equal(scheduleExists(), true);
});

test('REMOVING a zone still cascades — that is what the cascades are for', async () => {
  // The fix must not turn deletion into a no-op: dropping the zone an item lives in should
  // un-assign that item and take its schedules with it.
  const zones = CURRENT().filter(z => z.id !== 'z-a');
  assert.equal(await saveZones(zones), 200);
  assert.ok(!zoneIds().includes('z-a'), 'the removed zone is gone');
  assert.equal(itemZone(), null, 'its item is un-assigned');
  assert.equal(scheduleExists(), false, 'its schedule is removed');
});

test.after(() => { server.close(); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {} });
