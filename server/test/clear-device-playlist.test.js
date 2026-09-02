'use strict';

// "No playlist" was an option you could select that did nothing.
//
// The dashboard picker offered `<option value="">No playlist</option>`, and its change handler
// opened with `if (!newPlaylistId) return; // Don't allow deselecting for now` — so choosing it
// sent no request, changed nothing, and raised no error. The guard was honest about why: there was
// no way to do it. PUT /devices/:id has never read playlist_id (it returns 200 and ignores it), and
// POST /playlists/:id/assign can only set one.
//
// Reported on #234 as "I also selected No playlist ... it still showed the same video". It did.
//
// The invariant: clearing a display's playlist actually clears it, and only the people allowed to
// change that display can do it.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'st-clearpl-'));
process.env.DATA_DIR = tmp;
process.env.JWT_SECRET = 'test-secret-clear-playlist';

const express = require('express');
const { db } = require('../db/database');
const { requireAuth, generateToken } = require('../middleware/auth');

// devices -> workspaces -> organizations -> users, FK-enforced, so seed the whole chain.
function seed(suffix) {
  const u = 'u-' + suffix, o = 'o-' + suffix, ws = 'ws-' + suffix;
  const dev = 'd-' + suffix, pl = 'p-' + suffix;
  db.prepare("INSERT OR IGNORE INTO users (id, email, password_hash, role) VALUES (?, ?, 'x', 'user')")
    .run(u, suffix + '@test.local');
  db.prepare('INSERT OR IGNORE INTO organizations (id, name, owner_user_id) VALUES (?, ?, ?)').run(o, 'org ' + suffix, u);
  db.prepare('INSERT OR IGNORE INTO workspaces (id, organization_id, name) VALUES (?, ?, ?)').run(ws, o, 'ws ' + suffix);
  // accessContext resolves through the MEMBERSHIP tables, not organizations.owner_user_id —
  // seeding only the owner column gets a legitimate owner a 403 and looks like an authz bug.
  db.prepare("INSERT OR IGNORE INTO organization_members (organization_id, user_id, role) VALUES (?, ?, 'org_owner')").run(o, u);
  db.prepare("INSERT INTO playlists (id, name, workspace_id, user_id) VALUES (?, 'PL', ?, ?)").run(pl, ws, u);
  db.prepare(`INSERT INTO devices (id, name, workspace_id, user_id, playlist_id, created_at, updated_at)
              VALUES (?, 'Screen', ?, ?, ?, strftime('%s','now'), strftime('%s','now'))`).run(dev, ws, u, pl);
  return { u, ws, dev, pl };
}

const mine = seed('mine');
const theirs = seed('theirs');

const app = express();
app.use(express.json());
app.use('/api/devices', requireAuth, require('../routes/devices'));
const server = app.listen(0);

const userRow = (id) => db.prepare('SELECT id, email, role FROM users WHERE id = ?').get(id);
const tokenFor = (u, ws) => generateToken(userRow(u), ws);

async function del(deviceId, token) {
  await new Promise(r => (server.listening ? r() : server.once('listening', r)));
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/devices/${deviceId}/playlist`, {
    method: 'DELETE',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  return res.status;
}

const playlistOf = (id) => db.prepare('SELECT playlist_id FROM devices WHERE id = ?').get(id).playlist_id;

test('THE BUG: PUT /devices/:id silently ignores playlist_id, so it could not clear one', async () => {
  // Pinned so nobody "fixes" the picker by pointing it back at PUT and re-creating the silence.
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'devices.js'), 'utf8');
  const put = src.slice(src.indexOf("router.put('/:id'"));
  const body = put.slice(0, put.indexOf('\nrouter.'));
  assert.ok(!/playlist_id\s*[,=]/.test(body), 'PUT now touches playlist_id — update this test and the picker');
});

test('THE FIX: clearing a playlist actually clears it', async () => {
  assert.equal(playlistOf(mine.dev), mine.pl, 'precondition: a playlist is assigned');
  assert.equal(await del(mine.dev, tokenFor(mine.u, mine.ws)), 200);
  assert.equal(playlistOf(mine.dev), null, 'the display must end up with no playlist');
});

test('clearing an already-clear display is a harmless no-op', async () => {
  // The button is in a dropdown a person can pick twice; it must not 404 or 500 on the second go.
  assert.equal(await del(mine.dev, tokenFor(mine.u, mine.ws)), 200);
  assert.equal(playlistOf(mine.dev), null);
});

test('someone else\'s display cannot be cleared', async () => {
  const before = playlistOf(theirs.dev);
  const status = await del(theirs.dev, tokenFor(mine.u, mine.ws));
  assert.ok(status === 403 || status === 404, `expected refusal, got ${status}`);
  assert.equal(playlistOf(theirs.dev), before, 'a refused call must not have changed anything');
});

test('an unauthenticated caller cannot clear a playlist', async () => {
  const before = playlistOf(theirs.dev);
  assert.equal(await del(theirs.dev), 401);
  assert.equal(playlistOf(theirs.dev), before);
});

test('a display that does not exist is refused, not invented', async () => {
  const status = await del('no-such-device', tokenFor(mine.u, mine.ws));
  assert.ok(status === 403 || status === 404, `expected refusal, got ${status}`);
});

test.after(() => { server.close(); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {} });
