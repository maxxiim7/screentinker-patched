'use strict';

// A blocked device stays blocked across a delete + re-pair on purpose (device-settings applyToDevice
// restores `blocked`, so a block cannot be shrugged off by deleting the device). That is the right
// call — but it makes the SAVED copy the real authority, and unblocking only ever wrote `devices`.
//
// So unblock did not stick. The device row said 0, the saved row still said 1, and the next re-pair
// restored the block. From the dashboard there was no way out: a customer unblocked, re-paired, was
// refused again, and had nothing to tell them why. Found on #234 with a real device that had been
// blocked once to see what the button did.
//
// The invariant: after unblock, NOTHING anywhere still claims the device is blocked.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'st-unblock-'));
process.env.DATA_DIR = tmp;

const { db } = require('../db/database');
const deviceSettings = require('../lib/device-settings');

// devices -> workspaces -> organizations -> users, all FK-enforced, so seed the whole chain.
function seedWorkspace(suffix) {
  const u = 'u-' + suffix, o = 'o-' + suffix, ws = 'ws-' + suffix;
  db.prepare("INSERT OR IGNORE INTO users (id, email, password_hash) VALUES (?, ?, 'x')").run(u, suffix + '@test.local');
  db.prepare('INSERT OR IGNORE INTO organizations (id, name, owner_user_id) VALUES (?, ?, ?)').run(o, 'org ' + suffix, u);
  db.prepare('INSERT OR IGNORE INTO workspaces (id, organization_id, name) VALUES (?, ?, ?)').run(ws, o, 'ws ' + suffix);
  return ws;
}

function seedBlockedDevice(id, fp) {
  const ws = seedWorkspace(id);
  db.prepare("INSERT INTO devices (id, name, workspace_id, blocked, created_at, updated_at) VALUES (?, ?, ?, 1, strftime('%s','now'), strftime('%s','now'))")
    .run(id, 'blocked-device', ws);
  db.prepare("INSERT INTO device_fingerprints (fingerprint, device_id, last_seen) VALUES (?, ?, strftime('%s','now'))")
    .run(fp, id);
  // The saved snapshot the re-pair path reads back.
  db.prepare("INSERT INTO device_settings (fingerprint, workspace_id, device_name, blocked, last_seen) VALUES (?, ?, ?, 1, strftime('%s','now'))")
    .run(fp, ws, 'blocked-device');
  return { id, fp, ws };
}

const savedBlocked = (fp) => db.prepare('SELECT blocked FROM device_settings WHERE fingerprint = ?').get(fp)?.blocked;
const liveBlocked = (id) => db.prepare('SELECT blocked FROM devices WHERE id = ?').get(id)?.blocked;

test('THE BUG: clearing devices.blocked alone leaves the saved copy blocked', () => {
  const { id, fp } = seedBlockedDevice('dev-stale', 'fp-stale');
  // What unblock used to do, and only this.
  db.prepare('UPDATE devices SET blocked = 0 WHERE id = ?').run(id);
  assert.equal(liveBlocked(id), 0);
  assert.equal(savedBlocked(fp), 1, 'the saved copy is what re-pair restores from');
});

test('a re-pair after that half-unblock puts the block straight back', () => {
  const { id, fp } = seedBlockedDevice('dev-repair', 'fp-repair');
  db.prepare('UPDATE devices SET blocked = 0 WHERE id = ?').run(id);
  // This is exactly what the register path runs on a re-paired device.
  deviceSettings.applyToDevice(id, fp);
  assert.equal(liveBlocked(id), 1, 'unblock silently reverted — the customer cannot escape this');
});

test('THE FIX: unblocking clears the saved copy, so a re-pair stays unblocked', () => {
  const { id, fp } = seedBlockedDevice('dev-fixed', 'fp-fixed');
  db.prepare('UPDATE devices SET blocked = 0 WHERE id = ?').run(id);
  assert.equal(deviceSettings.setBlockedByDevice(id, false), true);
  assert.equal(savedBlocked(fp), 0);
  deviceSettings.applyToDevice(id, fp);
  assert.equal(liveBlocked(id), 0, 're-pair must not resurrect the block');
});

test('blocking still survives a re-pair — that property is deliberate and must not regress', () => {
  const { id, fp } = seedBlockedDevice('dev-stays', 'fp-stays');
  db.prepare('UPDATE devices SET blocked = 0 WHERE id = ?').run(id);
  deviceSettings.setBlockedByDevice(id, false);
  // Now block it for real, the way the route does.
  db.prepare('UPDATE devices SET blocked = 1 WHERE id = ?').run(id);
  deviceSettings.setBlockedByDevice(id, true);
  // Simulate delete + re-pair: the device row is recreated unblocked, then settings are restored.
  db.prepare('UPDATE devices SET blocked = 0 WHERE id = ?').run(id);
  deviceSettings.applyToDevice(id, fp);
  assert.equal(liveBlocked(id), 1, 'a genuine block must not be escapable by deleting the device');
});

test('a device with no fingerprint yet is a no-op, not a throw', () => {
  const ws = seedWorkspace('nofp');
  db.prepare("INSERT INTO devices (id, name, workspace_id, blocked, created_at, updated_at) VALUES ('dev-nofp','x',?,1,strftime('%s','now'),strftime('%s','now'))").run(ws);
  assert.equal(deviceSettings.setBlockedByDevice('dev-nofp', false), false);
});

test.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {} });
