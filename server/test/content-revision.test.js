'use strict';

// Caching media for offline playback creates a way for a screen to be permanently WRONG.
//
// PUT /api/content/:id/replace is the only operation that changes an asset's bytes without changing
// its id. Every player caches media keyed on that id, so before this the new bytes could not reach
// a panel that already held the old ones — not "until the next refresh", but never. And because a
// replace writes a NEW randomly-named file and unlinks the old one, the filepath baked into the
// published playlist snapshot pointed at a deleted file, so web and BrightSign panels 404'd on the
// item until somebody republished the playlist.
//
// The fix is one idea: the playlist snapshot captures the ARRANGEMENT, not the bytes, so the byte
// facts are refreshed at send time — exactly as widget revs already were.

const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-rev-' + crypto.randomBytes(4).toString('hex'));
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Server } = require('socket.io');
const { db } = require('../db/database');
const setupDeviceSocket = require('../ws/deviceSocket');

// buildPlaylistPayload is only attached to the module once the socket layer is set up, so the
// payload is exercised exactly as the real send path builds it rather than through a copy.
let httpServer, io, buildPlaylistPayload;

const DEV = 'dev-rev';
const PL = 'pl-rev';
const CID = 'content-rev';

function snapshot(items) {
  db.prepare('UPDATE playlists SET published_snapshot = ? WHERE id = ?').run(JSON.stringify(items), PL);
}
function itemFor(deviceId) {
  return buildPlaylistPayload(deviceId).assignments[0];
}

before(() => {
  httpServer = http.createServer(); io = new Server(httpServer); setupDeviceSocket(io);
  buildPlaylistPayload = setupDeviceSocket.buildPlaylistPayload;

  db.prepare('INSERT INTO users (id, email) VALUES (?,?)').run('u', 'rev@example.test');
  db.prepare('INSERT INTO content (id, filename, mime_type, file_size, filepath, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
    .run(CID, 'clip.mp4', 'video/mp4', 100, 'aaaa.mp4', 1000, 1000);
  db.prepare('INSERT INTO playlists (id, user_id, name) VALUES (?,?,?)').run(PL, 'u', 'rev playlist');
  db.prepare('INSERT INTO devices (id, name, playlist_id) VALUES (?,?,?)').run(DEV, 'panel', PL);
  db.prepare('INSERT INTO playlist_items (playlist_id, content_id, sort_order, duration_sec) VALUES (?,?,?,?)')
    .run(PL, CID, 0, 10);
  snapshot([{ content_id: CID, filename: 'clip.mp4', mime_type: 'video/mp4', filepath: 'aaaa.mp4', duration_sec: 10 }]);
});

test('every content item carries a revision the player can key a cache on', () => {
  assert.equal(itemFor(DEV).content_rev, 1000);
});

test('THE BUG: replacing the bytes changes the revision, so a cached copy is a miss', () => {
  // Without a value that moves, a player holding the old bytes has no way to learn they are stale:
  // same id, same URL, same everything.
  const before = itemFor(DEV).content_rev;
  db.prepare("UPDATE content SET filepath = 'bbbb.mp4', updated_at = MAX(CAST(strftime('%s','now') AS INTEGER), updated_at + 1) WHERE id = ?").run(CID);
  const after = itemFor(DEV).content_rev;
  assert.ok(after > before, `revision must advance on replace (${before} -> ${after})`);
});

test('THE OTHER HALF: the refreshed filepath points at the file that now exists', () => {
  // The snapshot still says aaaa.mp4, which was unlinked by the replace. The web player builds its
  // URL from this field, so a stale value is not a caching problem — it is a 404 and a dark screen.
  assert.equal(itemFor(DEV).filepath, 'bbbb.mp4');
});

test('a same-second replace still advances the revision', () => {
  // strftime resolution is one second. A scripted replace, or a small file, lands inside the same
  // second as the previous write — and a revision that does not move is a cache that never updates.
  const first = itemFor(DEV).content_rev;
  for (let i = 0; i < 3; i++) {
    db.prepare("UPDATE content SET updated_at = MAX(CAST(strftime('%s','now') AS INTEGER), COALESCE(NULLIF(updated_at,0), created_at) + 1) WHERE id = ?").run(CID);
  }
  assert.ok(itemFor(DEV).content_rev >= first + 3);
});

test('an untouched asset keeps a STABLE revision across sends', () => {
  // Just as load-bearing as the change case: a revision that moved on its own would re-download the
  // whole playlist on every heartbeat, over the link least able to afford it.
  const a = itemFor(DEV).content_rev;
  const b = itemFor(DEV).content_rev;
  assert.equal(a, b);
});

test('a row migrated in before the column existed resolves to its creation time, not zero', () => {
  // The ALTER lands the column as 0. Collapsing every such asset onto revision "0" would make two
  // different assets look identically fresh to a cache keyed on it.
  db.prepare('INSERT INTO content (id, filename, mime_type, file_size, filepath, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
    .run('legacy', 'old.mp4', 'video/mp4', 10, 'old.mp4', 4242, 0);
  db.prepare('INSERT INTO playlists (id, user_id, name) VALUES (?,?,?)').run('pl-legacy', 'u', 'legacy');
  db.prepare('INSERT INTO devices (id, name, playlist_id) VALUES (?,?,?)').run('dev-legacy', 'legacy panel', 'pl-legacy');
  db.prepare('UPDATE playlists SET published_snapshot = ? WHERE id = ?')
    .run(JSON.stringify([{ content_id: 'legacy', filepath: 'old.mp4' }]), 'pl-legacy');
  assert.equal(itemFor('dev-legacy').content_rev, 4242);
});

test('a widget item is untouched — it has no content row to refresh from', () => {
  db.prepare('INSERT INTO playlists (id, user_id, name) VALUES (?,?,?)').run('pl-w', 'u', 'widget');
  db.prepare('INSERT INTO devices (id, name, playlist_id) VALUES (?,?,?)').run('dev-w', 'w panel', 'pl-w');
  db.prepare('UPDATE playlists SET published_snapshot = ? WHERE id = ?')
    .run(JSON.stringify([{ widget_id: 'w1', widget_rev: 7 }]), 'pl-w');
  const item = itemFor('dev-w');
  assert.equal(item.content_rev, undefined);
  assert.equal(item.widget_id, 'w1');
});

test('an item whose content row was deleted keeps its published fields rather than being blanked', () => {
  // The delete path scrubs the snapshot separately; until it does, silently emptying filepath here
  // would turn a stale item into a broken one.
  db.prepare('INSERT INTO playlists (id, user_id, name) VALUES (?,?,?)').run('pl-gone', 'u', 'gone');
  db.prepare('INSERT INTO devices (id, name, playlist_id) VALUES (?,?,?)').run('dev-gone', 'gone panel', 'pl-gone');
  db.prepare('UPDATE playlists SET published_snapshot = ? WHERE id = ?')
    .run(JSON.stringify([{ content_id: 'never-existed', filepath: 'ghost.mp4' }]), 'pl-gone');
  assert.equal(itemFor('dev-gone').filepath, 'ghost.mp4');
});

after(() => {
  try { setupDeviceSocket.__resetTimers(); } catch { /* */ }
  try { io.close(); httpServer.close(); } catch { /* */ }
});
