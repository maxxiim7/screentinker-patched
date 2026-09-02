'use strict';

// A synchronised group has to agree with itself about WHICH protocol it is running, across three
// places that never speak to each other: the players, the dashboard, and the stored setting.
//
// The stored setting is only a REQUEST. BrightSign's native sync is frame-accurate but exists only
// between BrightSign players on one multicast L2 network, so "brightsign" on a mixed fleet is a
// request that cannot be honoured. If the server stored it and said nothing, the operator would
// read "BrightSign" in the UI while the screens ran the clock-derived protocol — and the one
// symptom they would eventually notice (a wall that is a second out) has no visible cause.
//
// Worse is the leader. Ours is leaderless and survives anything; native sync has ONE broadcaster,
// so a group whose elected leader is offline sits unsynchronised with every member waiting for an
// announcement that will never come. The dashboard would show a healthy group the whole time.
//
// The invariants: what the players are told and what the dashboard shows both come from the same
// pure resolver, a refused request is reported rather than silently altered, and a group with no
// live leader falls back to the protocol that does not need one.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'st-syncbackend-'));
process.env.DATA_DIR = tmp;
process.env.JWT_SECRET = 'test-secret-sync-backend';

const { db } = require('../db/database');

const O = 'o-sb', WS = 'ws-sb', U = 'u-sb', PL = 'pl-sb';
db.prepare("INSERT OR IGNORE INTO users (id,email,password_hash,role) VALUES (?,?, 'x','user')").run(U, 'sb@t.local');
db.prepare('INSERT OR IGNORE INTO organizations (id,name,owner_user_id) VALUES (?,?,?)').run(O, 'Org', U);
db.prepare('INSERT OR IGNORE INTO workspaces (id,organization_id,name) VALUES (?,?,?)').run(WS, O, 'WS');
db.prepare('INSERT OR IGNORE INTO playlists (id,user_id,name,workspace_id) VALUES (?,?,?,?)').run(PL, U, 'Shared', WS);
// OR IGNORE swallows constraint violations, so a missing NOT NULL column here would leave the row
// absent and every later foreign key fail instead — assert the fixture actually landed.
assert.ok(db.prepare('SELECT 1 FROM playlists WHERE id = ?').get(PL), 'playlist fixture did not insert');

let seq = 0;
/** Build a sync-enabled group on the shared playlist with the given members. */
function makeGroup(backend, members) {
  const gid = 'g-sb-' + (++seq);
  db.prepare(`INSERT INTO device_groups (id,name,user_id,workspace_id,playlist_id,sync_enabled,sync_backend)
              VALUES (?,?,?,?,?,1,?)`).run(gid, 'G' + seq, U, WS, PL, backend);
  members.forEach((m, i) => {
    const did = gid + '-d' + i;
    db.prepare(`INSERT INTO devices (id,name,workspace_id,playlist_id,status,platform,ip_address,created_at,updated_at)
                VALUES (?,?,?,?,?,?,?,strftime('%s','now'),strftime('%s','now'))`)
      .run(did, 'D' + i, WS, PL, m.status || 'online', m.platform, m.ip || '10.0.0.' + (i + 1));
    db.prepare('INSERT INTO device_group_members (group_id,device_id) VALUES (?,?)').run(gid, did);
  });
  return gid;
}

const { __test } = require('../ws/deviceSocket');

test('an all-BrightSign group on one subnet is told to run native sync', () => {
  const g = makeGroup('auto', [
    { platform: 'brightsign', ip: '10.0.5.1' },
    { platform: 'brightsign', ip: '10.0.5.2' },
  ]);
  const first = db.prepare('SELECT device_id FROM device_group_members WHERE group_id = ? ORDER BY device_id').get(g);
  const gs = __test.resolveGroupSync({ playlist_id: PL }, first.device_id);
  assert.equal(gs.backend, 'brightsign');
  assert.equal(gs.sync_downgraded, false);
});

test('THE MIXED FLEET: one Android member drops the whole group back to our protocol', () => {
  // BrightWall cannot include a non-BrightSign screen. Half-syncing is worse than second-accurate
  // everywhere, and it would look perfectly healthy from the dashboard.
  const g = makeGroup('brightsign', [
    { platform: 'brightsign', ip: '10.0.6.1' },
    { platform: 'Android 12', ip: '10.0.6.2' },
  ]);
  const first = db.prepare('SELECT device_id FROM device_group_members WHERE group_id = ? ORDER BY device_id').get(g);
  const gs = __test.resolveGroupSync({ playlist_id: PL }, first.device_id);
  assert.equal(gs.backend, 'screentinker');
  assert.equal(gs.sync_downgraded, true);
  assert.match(gs.sync_reason, /non-BrightSign/);
});

test('THE SILENT SPLIT: BrightSigns on different subnets do not get multicast sync', () => {
  const g = makeGroup('brightsign', [
    { platform: 'brightsign', ip: '10.1.0.9' },
    { platform: 'brightsign', ip: '10.9.0.9' },
  ]);
  const first = db.prepare('SELECT device_id FROM device_group_members WHERE group_id = ? ORDER BY device_id').get(g);
  const gs = __test.resolveGroupSync({ playlist_id: PL }, first.device_id);
  assert.equal(gs.backend, 'screentinker');
  assert.match(gs.sync_reason, /multicast|different networks/);
});

test('THE DEAD LEADER: native sync falls back when nobody is left to broadcast', () => {
  // Ours is leaderless and carries on; native sync has exactly one broadcaster. An all-offline
  // group still elects a leader (stable id), so without this check the members that DO come back
  // would sit waiting for an announcement from a player that is powered down.
  const g = makeGroup('brightsign', [
    { platform: 'brightsign', ip: '10.0.7.1', status: 'offline' },
    { platform: 'brightsign', ip: '10.0.7.2', status: 'offline' },
  ]);
  const first = db.prepare('SELECT device_id FROM device_group_members WHERE group_id = ? ORDER BY device_id').get(g);
  const gs = __test.resolveGroupSync({ playlist_id: PL }, first.device_id);
  assert.equal(gs.backend, 'screentinker');
  assert.equal(gs.sync_downgraded, true);
  assert.match(gs.sync_reason, /leader is offline/);
});

test('exactly one member is told it is the leader, and it is an online one', () => {
  const g = makeGroup('auto', [
    { platform: 'brightsign', ip: '10.0.8.1', status: 'offline' },
    { platform: 'brightsign', ip: '10.0.8.2', status: 'online' },
  ]);
  const ids = db.prepare('SELECT device_id FROM device_group_members WHERE group_id = ? ORDER BY device_id').all(g);
  const flags = ids.map(r => __test.resolveGroupSync({ playlist_id: PL }, r.device_id).is_leader);
  assert.equal(flags.filter(Boolean).length, 1, 'two leaders would both broadcast; none would sync nothing');
  const leaderId = ids[flags.indexOf(true)].device_id;
  const st = db.prepare('SELECT status FROM devices WHERE id = ?').get(leaderId).status;
  assert.equal(st, 'online', 'an offline leader cannot announce');
});

test('an operator choosing our protocol on an all-BrightSign group is obeyed, not overridden', () => {
  const g = makeGroup('screentinker', [
    { platform: 'brightsign', ip: '10.0.9.1' },
    { platform: 'brightsign', ip: '10.0.9.2' },
  ]);
  const first = db.prepare('SELECT device_id FROM device_group_members WHERE group_id = ? ORDER BY device_id').get(g);
  const gs = __test.resolveGroupSync({ playlist_id: PL }, first.device_id);
  assert.equal(gs.backend, 'screentinker');
  assert.equal(gs.sync_downgraded, false);
});
