'use strict';

/*
 * PUT /api/content/:id/replace must re-derive everything the BYTES decide.
 *
 * The route carried its own shorter copy of the ingest logic that handled images only, so:
 *   - replacing a VIDEO left duration_sec at the OLD clip's length and nulled width/height.
 *     That is not cosmetic: lib/item-duration.js defaults a new playlist item to the content's
 *     duration, so after replacing a 32s clip with a 5s one, every later "add to playlist"
 *     scheduled 32 seconds of a 5-second video — 27s of frozen last frame on the screen.
 *   - replacing an IMAGE measured it with raw sharp metadata and thumbnailed without .rotate(),
 *     re-introducing the EXIF-orientation bug (#170) that ingest fixes: a portrait photo came
 *     back recorded as landscape.
 *
 * Driven over real HTTP against the real router, because the bug was in the route, not the lib.
 */

const os = require('node:os');
const path = require('node:path');
const fsp = require('node:fs/promises');
const fs = require('node:fs');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-replace-' + crypto.randomBytes(4).toString('hex'));
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const sharp = require('sharp');
const { db } = require('../db/database');
const config = require('../config');

const WS = 'ws-replace';
const USER = 'u-replace';
let server, base;

function hasFfmpeg() {
  try {
    const { execFileSync } = require('node:child_process');
    execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

// Seed through the SHARED ingest lib (the same call POST /api/content makes) rather than over
// HTTP, so the fixture is a genuine first-class content row and the only thing this suite drives
// over the wire is the route under test.
const { ingestUploadedFile } = require('../lib/content-ingest');
async function upload(bytes, filename) {
  const tmp = path.join(config.contentDir, crypto.randomUUID() + '.part');
  await fsp.mkdir(config.contentDir, { recursive: true });
  await fsp.writeFile(tmp, bytes);
  return ingestUploadedFile({
    file: { path: tmp, originalname: filename, size: bytes.length },
    userId: USER, workspaceId: WS,
  });
}

async function replace(id, bytes, filename, type) {
  const fd = new FormData();
  fd.append('file', new Blob([bytes], { type }), filename);
  const r = await fetch(`${base}/${id}/replace`, { method: 'PUT', body: fd });
  return { status: r.status, body: await r.json() };
}

before(async () => {
  db.prepare("INSERT INTO users (id, email, name, role) VALUES (?, ?, ?, 'platform_admin')").run(USER, 'replace@test', 'QA');
  db.prepare('INSERT INTO organizations (id, name, owner_user_id) VALUES (?, ?, ?)').run('org-replace', 'Org', USER);
  db.prepare('INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, ?)').run(WS, 'org-replace', 'WS');
  const app = express();
  app.use((req, _res, next) => {
    req.workspaceId = WS;
    req.user = { id: USER, role: 'platform_admin' };
    next();
  });
  app.use('/', require('../routes/content'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((r) => server.close(r)));

test('replacing an image re-measures it — a landscape photo does not keep the old portrait dims', async () => {
  const tall = await sharp({ create: { width: 40, height: 90, channels: 3, background: '#123456' } }).png().toBuffer();
  const wide = await sharp({ create: { width: 120, height: 30, channels: 3, background: '#654321' } }).png().toBuffer();

  const row = await upload(tall, 'tall.png', 'image/png');
  assert.equal(row.width, 40);
  assert.equal(row.height, 90);

  const { status, body } = await replace(row.id, wide, 'wide.png', 'image/png');
  assert.equal(status, 200);
  assert.equal(body.width, 120, 'width comes from the NEW bytes');
  assert.equal(body.height, 30, 'height comes from the NEW bytes');
  assert.notEqual(body.filepath, row.filepath, 'a replace writes a new randomly-named file');
});

test('replacing an image honours EXIF orientation, the same way ingest does (#170)', async () => {
  // orientation 6 = "rotate 90° CW to display": a 30x100 stored buffer DISPLAYS as 100x30.
  // The old replace path read sharp's raw metadata and recorded 30x100 — the exact bug that
  // put blue bars down portrait uploads before #172 fixed the ingest path.
  const plain = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#000' } }).jpeg().toBuffer();
  const rotated = await sharp({ create: { width: 30, height: 100, channels: 3, background: '#00ff00' } })
    .withMetadata({ orientation: 6 }).jpeg().toBuffer();

  const row = await upload(plain, 'plain.jpg', 'image/jpeg');
  const { status, body } = await replace(row.id, rotated, 'rotated.jpg', 'image/jpeg');
  assert.equal(status, 200);
  assert.equal(body.width, 100, 'EXIF-rotated image is measured as DISPLAYED, not as stored');
  assert.equal(body.height, 30);
});

test('replacing an image regenerates its thumbnail file, rather than pointing at a deleted one', async () => {
  const a = await sharp({ create: { width: 60, height: 60, channels: 3, background: '#ff0000' } }).png().toBuffer();
  const b = await sharp({ create: { width: 80, height: 80, channels: 3, background: '#0000ff' } }).png().toBuffer();
  const row = await upload(a, 'a.png', 'image/png');
  const { body } = await replace(row.id, b, 'b.png', 'image/png');
  assert.ok(body.thumbnail_path, 'a thumbnail is recorded');
  assert.ok(fs.existsSync(path.join(config.contentDir, body.thumbnail_path)), 'and the file it names EXISTS');
});

test('replacing a video re-probes its duration — a stale one mis-defaults every later playlist add', { skip: hasFfmpeg() ? false : 'ffmpeg/ffprobe not installed' }, async () => {
  const { execFileSync } = require('node:child_process');
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'st-vid-'));
  const long = path.join(dir, 'long.mp4');
  const short = path.join(dir, 'short.mp4');
  const mk = (out, secs, size) => execFileSync('ffmpeg', ['-v', 'quiet', '-y', '-f', 'lavfi', '-i', `color=c=blue:s=${size}:d=${secs}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-t', String(secs), out], { timeout: 60000 });
  mk(long, 8, '320x240');
  mk(short, 2, '240x320');

  const row = await upload(await fsp.readFile(long), 'long.mp4', 'video/mp4');
  assert.ok(row.duration_sec >= 7.5 && row.duration_sec <= 8.5, `seeded 8s clip probed as ${row.duration_sec}`);

  const { status, body } = await replace(row.id, await fsp.readFile(short), 'short.mp4', 'video/mp4');
  assert.equal(status, 200);
  assert.ok(body.duration_sec >= 1.5 && body.duration_sec <= 2.5,
    `duration follows the NEW bytes (got ${body.duration_sec}; the old code left 8)`);
  assert.equal(body.width, 240, 'and the dimensions do too — they used to be nulled for video');
  assert.equal(body.height, 320);

  // The point of all of it: the shared duration default now describes the file that is there.
  const { resolveItemDuration } = require('../lib/item-duration');
  assert.equal(resolveItemDuration(undefined, body), 2,
    'a playlist item added after the replace gets the NEW clip\'s length, not the old one\'s');
});
