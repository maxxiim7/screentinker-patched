'use strict';

// A widget playlist item carries its id in widget_id and has NO content_id. The player sent only
// content_id, so for a widget play the server received nothing identifiable: it wrote a row with
// content_id NULL and widget_id NULL, and closed nothing on play_end because the match bound
// content_id to both columns.
//
// The row existed, so nothing looked broken — but it named neither what played nor which widget,
// and it never gained a duration. Reports read empty for any screen showing a widget. Observed on
// a live screen playing a single widget: one open play_logs row with both columns null.
//
// Pinned here: a widget play is attributed to the widget and closed like any other.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const ioClient = require('../node_modules/socket.io-client');

const { freePort } = require('./helpers/free-port');
let PORT, BASE, proc, db;
const DATA_DIR = path.join(os.tmpdir(), 'st-plw-' + crypto.randomBytes(4).toString('hex'));
const LOG = path.join(os.tmpdir(), 'st-plw-' + crypto.randomBytes(4).toString('hex') + '.log');
const S = {};

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

  S.device = crypto.randomUUID();
  S.token = crypto.randomBytes(32).toString('hex');
  db.prepare(`INSERT INTO devices (id, name, status, device_token, created_at)
              VALUES (?, 'W', 'online', ?, strftime('%s','now'))`).run(S.device, S.token);
  S.widget = crypto.randomUUID();
  db.prepare(`INSERT INTO widgets (id, name, widget_type, config, created_at, updated_at)
              VALUES (?, 'Directory', 'directory', '{}', strftime('%s','now'), strftime('%s','now'))`)
    .run(S.widget);
});
after(() => { try { db && db.close(); } catch { /* */ } try { proc.kill('SIGKILL'); } catch { /* */ } });

function connect() {
  return new Promise((resolve, reject) => {
    const s = ioClient(BASE + '/device', { transports: ['websocket'], reconnection: false });
    s.on('connect', () => s.emit('device:register', { device_id: S.device, device_token: S.token }));
    s.on('device:registered', () => resolve(s));
    s.on('device:auth-error', (e) => reject(new Error(e && e.error)));
    setTimeout(() => reject(new Error('register timeout')), 10000);
  });
}
const rows = () => db.prepare('SELECT * FROM play_logs WHERE device_id = ? ORDER BY id').all(S.device);
const wait = (ms) => new Promise(r => setTimeout(r, ms));
// The server throttles proof-of-play INSERTs to one per device per PLAY_LOG_MIN_GAP_MS (2s) so a
// runaway player cannot flood the table. Tests that expect a NEW row must clear that window, or
// the event is correctly dropped and the assertion fails for the wrong reason.
const clearThrottle = () => wait(2200);

test('THE BUG: a widget play is attributed to the widget', async () => {
  const s = await connect();
  s.emit('device:play-event', {
    device_id: S.device, event: 'play_start',
    content_id: null, widget_id: S.widget, content_name: 'Directory',
  });
  await wait(600);
  const r = rows();
  assert.equal(r.length, 1, 'a row was written');
  assert.equal(r[0].widget_id, S.widget, 'and it names the widget — previously both columns were null');
  assert.equal(r[0].content_id, null);
  assert.equal(r[0].content_name, 'Directory', 'and what played');
  s.close();
});

test('and play_end closes THAT row, giving it a duration', async () => {
  const s = await connect();
  s.emit('device:play-event', {
    device_id: S.device, event: 'play_end',
    content_id: null, widget_id: S.widget, completed: true,
  });
  await wait(600);
  const r = rows();
  assert.equal(r.length, 1);
  assert.ok(r[0].ended_at, 'closed — the match previously bound content_id to BOTH columns, so a widget row could never be found');
  assert.equal(r[0].completed, 1);
  s.close();
});

test('an unknown widget id is not written as a dangling reference', async () => {
  await clearThrottle();
  const s = await connect();
  s.emit('device:play-event', {
    device_id: S.device, event: 'play_start',
    content_id: null, widget_id: crypto.randomUUID(), content_name: 'Ghost',
  });
  await wait(600);
  const r = rows();
  const last = r[r.length - 1];
  assert.equal(last.widget_id, null, 'a vanished widget degrades to NULL rather than failing the insert');
  assert.equal(last.content_name, 'Ghost', 'and the event still records WHAT played');
  s.close();
});

test('an OLDER player, sending a widget id in content_id, still works', async () => {
  await clearThrottle();
  // Backwards compatibility: players predating this send only content_id, sometimes carrying a
  // widget id. The sniff that used to be the only path remains their fallback.
  const before = rows().length;
  const s = await connect();
  s.emit('device:play-event', {
    device_id: S.device, event: 'play_start',
    content_id: S.widget, content_name: 'Legacy',
  });
  await wait(600);
  const r = rows();
  assert.equal(r.length, before + 1);
  assert.equal(r[r.length - 1].widget_id, S.widget, 'still attributed to the widget');
});

test('ordinary content is unaffected', async () => {
  await clearThrottle();
  const cid = crypto.randomUUID();
  db.prepare(`INSERT INTO content (id, filename, filepath, mime_type, file_size, created_at)
              VALUES (?, 'a.jpg', 'a.jpg', 'image/jpeg', 1, strftime('%s','now'))`).run(cid);
  const before = rows().length;
  const s = await connect();
  s.emit('device:play-event', {
    device_id: S.device, event: 'play_start', content_id: cid, widget_id: null, content_name: 'a.jpg',
  });
  await wait(600);
  const r = rows();
  assert.equal(r.length, before + 1);
  assert.equal(r[r.length - 1].content_id, cid);
  assert.equal(r[r.length - 1].widget_id, null);
  s.close();
});
