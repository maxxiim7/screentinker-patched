'use strict';

/*
 * A missing upload must 404, not hand the player the dashboard.
 *
 * express.static calls next() on a miss, and the only thing downstream of /uploads/content was the
 * SPA catch-all. So GET /uploads/content/<gone>.mp4 answered 200 OK, Content-Type: text/html, with
 * 15KB of index.html — under the `public, max-age=2592000, immutable` header the mount had already
 * set on the way in, before it knew whether the file existed.
 *
 * For a player that is the worst possible answer. Every downloader treats 200 as success, so the
 * panel stores the HTML page AS the video, caches it for a month, and renders a black frame with
 * nothing in any log to explain it. And it is reachable exactly when it hurts: a content REPLACE
 * writes a new randomly-named file and unlinks the old one, so every snapshot still pointing at the
 * old name asks for a file that is gone.
 *
 * Whole-server test on purpose — the bug was the ORDER of two mounts, which no unit test can see.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { freePort } = require('./helpers/free-port');

const DATA_DIR = path.join(os.tmpdir(), 'st-uploads404-' + crypto.randomBytes(4).toString('hex'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let proc, BASE;

before(async () => {
  const PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  proc = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(PORT), NODE_ENV: 'test' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(BASE + '/api/status'); if (r.ok) break; } catch { /* booting */ }
    await sleep(150);
  }
});

after(async () => { if (proc) proc.kill('SIGKILL'); await sleep(150); });

test('a missing media file is a 404, not 200 with an HTML page', async () => {
  const res = await fetch(BASE + '/uploads/content/00000000-0000-0000-0000-000000000000.mp4');
  assert.equal(res.status, 404);
  const ct = res.headers.get('content-type') || '';
  assert.ok(!ct.includes('text/html'), `a player must never be handed HTML as a video (got ${ct})`);
});

test('and it is not cached for a month — immutable is a promise about a file that exists', async () => {
  const res = await fetch(BASE + '/uploads/content/also-not-here.png');
  assert.equal(res.status, 404);
  const cc = res.headers.get('cache-control') || '';
  assert.ok(!cc.includes('immutable'), `a 404 must not be cached as the asset (got "${cc}")`);
});

test('a file that IS there still serves, with its own type and the long cache', async () => {
  // The guard must terminate ONLY the miss. A 404 on a present file would black out every screen.
  const contentDir = path.join(DATA_DIR, 'uploads', 'content');
  fs.mkdirSync(contentDir, { recursive: true });
  const name = 'present-' + crypto.randomBytes(4).toString('hex') + '.png';
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  fs.writeFileSync(path.join(contentDir, name), png);

  const res = await fetch(`${BASE}/uploads/content/${name}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.ok((res.headers.get('cache-control') || '').includes('immutable'), 'real assets keep the 30-day cache');
  assert.equal(Buffer.from(await res.arrayBuffer()).length, png.length);
});

test('path traversal out of the content dir is still not reachable', async () => {
  const res = await fetch(BASE + '/uploads/content/..%2f..%2f..%2fetc%2fpasswd');
  assert.notEqual(res.status, 200);
});
