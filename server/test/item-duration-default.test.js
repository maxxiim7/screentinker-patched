'use strict';

// #237: adding a video to a playlist gave the item the flat 10s default, so a 32s clip was
// cut off at 10s unless the operator looked up the runtime and typed it in. These tests pin
// the rule that replaces it — and the ways it must NOT misfire:
//   - a video defaults to its own probed length, rounded UP to whole seconds;
//   - content with no trustworthy duration (image, widget, YouTube/remote, failed probe)
//     keeps the 10s default, and a failed re-probe must not break the add;
//   - an explicit duration from the operator always wins;
//   - degenerate stored values (0, negative, NaN, absurd) never reach a device — a 0 makes
//     the players schedule a 0ms advance, which self-loops and black-screens the TV.
// Unit-tests the shared helper (every insert path uses it), then proves it end to end on the
// two routes an operator actually clicks: playlist add and assign-to-display.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');

const { resolveItemDuration, contentDefaultDuration, DEFAULT_ITEM_DURATION, MAX_CONTENT_DURATION } = require('../lib/item-duration');

const { freePort } = require('./helpers/free-port');
let PORT, BASE;
const DATA_DIR = path.join(os.tmpdir(), 'st-itemdur-test-' + crypto.randomBytes(4).toString('hex'));
const LOG = path.join(os.tmpdir(), 'st-itemdur-' + crypto.randomBytes(4).toString('hex') + '.log');
const PW = 'Passw0rd123';
let proc, db;
const S = {};

async function jfetch(p, opts = {}) {
  const res = await fetch(BASE + p, opts);
  let body = null; try { body = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, body };
}
const auth = (tok) => ({ headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' } });
const post = (tok, obj) => ({ method: 'POST', ...auth(tok), body: JSON.stringify(obj || {}) });

// ---------------------------------------------------------------- unit: the shared helper

test('a video defaults to its own length, rounded UP (31.7s -> 32, never a clipped 31)', () => {
  assert.equal(resolveItemDuration(undefined, { duration_sec: 31.7 }), 32);
  assert.equal(resolveItemDuration(null, { duration_sec: 32 }), 32);
  assert.equal(contentDefaultDuration({ duration_sec: 31.7 }), 32);
});

test('content with no known duration keeps the 10s default', () => {
  for (const c of [null, undefined, {}, { duration_sec: null }, { duration_sec: undefined }]) {
    assert.equal(resolveItemDuration(undefined, c), DEFAULT_ITEM_DURATION);
    assert.equal(contentDefaultDuration(c), null);
  }
});

test('an explicit duration always wins over the content length', () => {
  assert.equal(resolveItemDuration(5, { duration_sec: 31.7 }), 5);
  assert.equal(resolveItemDuration(600, { duration_sec: 31.7 }), 600);
  // whole seconds: the Android player reads duration_sec with optInt, which truncates
  assert.equal(resolveItemDuration(12.9, null), 12);
});

test('degenerate stored durations never produce a zero-length item', () => {
  for (const bad of [0, -5, NaN, Infinity, 'abc', {}]) {
    assert.equal(resolveItemDuration(undefined, { duration_sec: bad }), DEFAULT_ITEM_DURATION, `content duration ${String(bad)}`);
    assert.equal(resolveItemDuration(bad, null), DEFAULT_ITEM_DURATION, `requested ${String(bad)}`);
  }
  // sub-second clip: honest about its length, but still at least a whole second
  assert.equal(resolveItemDuration(undefined, { duration_sec: 0.4 }), 1);
});

test('an absurd probe result is treated as a broken probe, not a schedule', () => {
  assert.equal(resolveItemDuration(undefined, { duration_sec: 1e9 }), DEFAULT_ITEM_DURATION);
  assert.equal(resolveItemDuration(undefined, { duration_sec: MAX_CONTENT_DURATION }), MAX_CONTENT_DURATION);
  assert.equal(resolveItemDuration(undefined, { duration_sec: MAX_CONTENT_DURATION + 1 }), DEFAULT_ITEM_DURATION);
  // an operator who deliberately types a very long dwell is still obeyed
  assert.equal(resolveItemDuration(1e6, { duration_sec: 30 }), 1e6);
});

// -------------------------------------------------------------- end to end on the routes

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
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!up) throw new Error('server did not boot:\n' + fs.readFileSync(LOG, 'utf8').slice(-2000));

  const reg = await jfetch('/api/auth/register', post(null, { email: 'd' + crypto.randomBytes(4).toString('hex') + '@x.local', password: PW }));
  S.jwt = reg.body.token;
  S.userId = reg.body.user.id;
  S.wsA = reg.body.current_workspace_id;

  const pl = await jfetch('/api/playlists', post(S.jwt, { name: 'dur-pl' }));
  S.playlistId = pl.body.id;

  // Seed the content library on one connection (FK off, as in mute.test.js) so each row can
  // carry exactly the duration_sec shape under test without needing a real media file.
  db = new Database(path.join(DATA_DIR, 'db', 'remote_display.db'), { timeout: 5000 });
  db.pragma('foreign_keys = OFF');
  const mkContent = (name, mime, duration, filepath = '') => {
    const id = crypto.randomUUID();
    db.prepare('INSERT INTO content (id, filename, filepath, mime_type, file_size, duration_sec, workspace_id) VALUES (?,?,?,?,0,?,?)')
      .run(id, name, filepath, mime, duration, S.wsA);
    return id;
  };
  S.cVideo = mkContent('clip.mp4', 'video/mp4', 31.7);
  S.cVideoExplicit = mkContent('clip2.mp4', 'video/mp4', 31.7);
  S.cImage = mkContent('poster.png', 'image/png', null);
  S.cZero = mkContent('zero.mp4', 'video/mp4', 0);
  S.cAbsurd = mkContent('absurd.mp4', 'video/mp4', 1e9);
  // No stored duration AND a filepath that doesn't exist -> the re-probe runs and fails.
  S.cUnprobeable = mkContent('missing.mp4', 'video/mp4', null, 'does-not-exist-' + crypto.randomBytes(4).toString('hex') + '.mp4');
  S.cAssign = mkContent('assign.mp4', 'video/mp4', 44.2);

  S.deviceId = crypto.randomUUID();
  db.prepare('INSERT INTO devices (id, name, status, workspace_id, user_id) VALUES (?,?,?,?,?)')
    .run(S.deviceId, 'DurDev', 'online', S.wsA, S.userId);
});

after(() => {
  try { db?.close(); } catch { /* */ }
  try { proc?.kill('SIGKILL'); } catch { /* */ }
  for (const f of [DATA_DIR, LOG]) { try { fs.rmSync(f, { recursive: true, force: true }); } catch { /* */ } }
});

test('POST /playlists/:id/items gives a video the clip length', async () => {
  const r = await jfetch(`/api/playlists/${S.playlistId}/items`, post(S.jwt, { content_id: S.cVideo }));
  assert.equal(r.status, 201);
  assert.equal(r.body.duration_sec, 32, '31.7s clip -> a 32s item, not the 10s default');
});

test('POST /playlists/:id/items honors an explicit duration on the same video', async () => {
  const r = await jfetch(`/api/playlists/${S.playlistId}/items`, post(S.jwt, { content_id: S.cVideoExplicit, duration_sec: 5 }));
  assert.equal(r.status, 201);
  assert.equal(r.body.duration_sec, 5, 'the operator asked for 5s and gets 5s');
});

test('content with no duration (image) still gets the 10s default', async () => {
  const r = await jfetch(`/api/playlists/${S.playlistId}/items`, post(S.jwt, { content_id: S.cImage }));
  assert.equal(r.status, 201);
  assert.equal(r.body.duration_sec, DEFAULT_ITEM_DURATION);
});

test('a stored 0 or absurd duration falls back to the default instead of reaching a device', async () => {
  const zero = await jfetch(`/api/playlists/${S.playlistId}/items`, post(S.jwt, { content_id: S.cZero }));
  assert.equal(zero.status, 201);
  assert.equal(zero.body.duration_sec, DEFAULT_ITEM_DURATION, 'a 0 would be a 0ms self-advancing loop');

  const absurd = await jfetch(`/api/playlists/${S.playlistId}/items`, post(S.jwt, { content_id: S.cAbsurd }));
  assert.equal(absurd.status, 201);
  assert.equal(absurd.body.duration_sec, DEFAULT_ITEM_DURATION, 'a nonsense probe must not park the screen for years');
});

test('a failed re-probe degrades to the default — the add still succeeds', async () => {
  const r = await jfetch(`/api/playlists/${S.playlistId}/items`, post(S.jwt, { content_id: S.cUnprobeable }));
  assert.equal(r.status, 201, 'ffprobe failing (or missing) must not break adding an item');
  assert.equal(r.body.duration_sec, DEFAULT_ITEM_DURATION);
});

test('assigning a video straight to a display uses the clip length too, and it reaches the snapshot', async () => {
  const r = await jfetch(`/api/assignments/device/${S.deviceId}`, post(S.jwt, { content_id: S.cAssign }));
  assert.equal(r.status, 201);
  assert.equal(r.body.duration_sec, 45, '44.2s clip -> a 45s item');

  const explicit = await jfetch(`/api/assignments/device/${S.deviceId}`, post(S.jwt, { content_id: S.cVideo, duration_sec: 7 }));
  assert.equal(explicit.status, 201);
  assert.equal(explicit.body.duration_sec, 7, 'an explicit duration still wins on the assign path');

  // The device only ever plays the published snapshot, so the defaulted value has to survive
  // the publish — a correct playlist_items row that never reaches the player is no fix.
  const playlistId = db.prepare('SELECT playlist_id FROM devices WHERE id = ?').get(S.deviceId).playlist_id;
  const pub = await jfetch(`/api/playlists/${playlistId}/publish`, post(S.jwt, {}));
  assert.equal(pub.status, 200);
  const snap = JSON.parse(db.prepare('SELECT published_snapshot FROM playlists WHERE id = ?').get(playlistId).published_snapshot);
  const item = snap.find((i) => i.content_id === S.cAssign);
  assert.ok(item, 'the assigned clip is in the published snapshot');
  assert.equal(item.duration_sec, 45, 'the device payload carries the clip length');
});
