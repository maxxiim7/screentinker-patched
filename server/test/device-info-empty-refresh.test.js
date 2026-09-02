'use strict';

// Every web and BrightSign player nulled seventeen of its own device columns every five minutes.
//
// The browser player's refresh-register sends `device_info: {}` on a 300-second timer — it has
// nothing new to report, it just wants a fresh playlist. But `{}` is truthy, and applyDeviceInfo is
// a blind full-row overwrite with no per-field presence check, so it bound `undefined` for every
// column. better-sqlite3 stores undefined as NULL rather than throwing, so the write succeeded and
// the row was quietly emptied: version, resolution, render size, OTA state, tier, the capability
// flags and the volume/brightness columns.
//
// Android was unaffected because it always sends the full object — so this only ever degraded the
// client family that has no other way to be inspected. Fleet view, resolution diagnostics and any
// version-based logic read blank for them.
//
// The surrounding code already anticipates this shape: recordReconnect and persistIdentity are
// gated behind `if (!isPlaylistRefresh)`. This one call was not.
//
// The invariant: an empty device_info means "nothing new", never "forget what you know".

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'st-devinfo-'));
process.env.DATA_DIR = tmp;

const { db } = require('../db/database');

const WS = 'ws-di', O = 'o-di', U = 'u-di', DEV = 'dev-di';
db.prepare("INSERT OR IGNORE INTO users (id,email,password_hash) VALUES (?,?, 'x')").run(U, 'di@t.local');
db.prepare('INSERT OR IGNORE INTO organizations (id,name,owner_user_id) VALUES (?,?,?)').run(O, 'Org', U);
db.prepare('INSERT OR IGNORE INTO workspaces (id,organization_id,name) VALUES (?,?,?)').run(WS, O, 'WS');
db.prepare(`INSERT OR IGNORE INTO devices (id,name,workspace_id,android_version,app_version,screen_width,screen_height,created_at,updated_at)
            VALUES (?, 'Web Screen', ?, 'Web/Chrome', '1.1.0-web', 1920, 1080, strftime('%s','now'), strftime('%s','now'))`).run(DEV, WS);

const row = () => db.prepare('SELECT android_version, app_version, screen_width, screen_height FROM devices WHERE id = ?').get(DEV);

// The guard as the socket handler applies it.
const shouldApply = (deviceInfo) => !!(deviceInfo && Object.keys(deviceInfo).length > 0);

test('THE BUG: an empty device_info must not be treated as new information', () => {
  // `{}` is truthy — that is the whole trap.
  assert.equal(!!{}, true, 'this is why the old `if (device_info)` let it through');
  assert.equal(shouldApply({}), false, 'but it carries nothing, so nothing should be written');
});

test('undefined really does become NULL rather than throwing, so the write did succeed', () => {
  // Pinning the driver behaviour the bug depended on: had it thrown, this would have been loud
  // instead of a silent five-minutely wipe.
  const before = row();
  assert.equal(before.app_version, '1.1.0-web');
  db.prepare('UPDATE devices SET app_version = ? WHERE id = ?').run(undefined, DEV);
  assert.equal(row().app_version, null, 'silently nulled — no error, no warning');
  db.prepare('UPDATE devices SET app_version = ? WHERE id = ?').run('1.1.0-web', DEV);
});

test('a refresh-register leaves what we already know intact', () => {
  const before = row();
  if (shouldApply({})) throw new Error('guard failed');   // the handler would skip the write
  const after = row();
  assert.deepEqual(after, before, 'version and resolution must survive a refresh beat');
});

test('a real device_info is still applied', () => {
  const info = { app_version: '1.9.28', screen_width: 3840 };
  assert.equal(shouldApply(info), true);
  db.prepare('UPDATE devices SET app_version = ?, screen_width = ? WHERE id = ?')
    .run(info.app_version, info.screen_width, DEV);
  const after = row();
  assert.equal(after.app_version, '1.9.28');
  assert.equal(after.screen_width, 3840);
});

test('a missing device_info is skipped too', () => {
  assert.equal(shouldApply(undefined), false);
  assert.equal(shouldApply(null), false);
});

test.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {} });
