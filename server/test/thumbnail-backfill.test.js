'use strict';

// Boot-time thumbnail backfill (lib/thumbnail-backfill): rows that missed ingest-time
// generation — uploads from before thumbnails existed, or videos uploaded while ffmpeg
// was missing — get healed once per boot. The cases that matter:
//   - a local image with no thumbnail gets one, and the row's dims are filled in
//   - rows that already have a thumbnail are not touched (and not even scanned)
//   - remote rows (YouTube/URL) and rows whose file is gone are left alone
//   - a second run finds nothing to do (idempotent)

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-thumb-' + crypto.randomBytes(4).toString('hex'));

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('../db/database');
const config = require('../config');
const { backfillMissingThumbnails } = require('../lib/thumbnail-backfill');

const insertStmt = db.prepare(
  'INSERT INTO content (id, filename, filepath, mime_type, file_size, remote_url, thumbnail_path) VALUES (?,?,?,?,?,?,?)'
);
const insert = (...args) => insertStmt.run(...args);
const row = (id) => db.prepare('SELECT * FROM content WHERE id = ?').get(id);

test('backfill generates missing image thumbnails, skips what it must, and is idempotent', async () => {
  // Generate a real 3x2 PNG with sharp itself — no hand-rolled fixture bytes to rot.
  const sharp = require('sharp');
  const png = await sharp({ create: { width: 3, height: 2, channels: 3, background: { r: 200, g: 30, b: 30 } } })
    .png().toBuffer();

  fs.mkdirSync(config.contentDir, { recursive: true });
  fs.writeFileSync(path.join(config.contentDir, 'bare.png'), png);
  fs.writeFileSync(path.join(config.contentDir, 'has-thumb.png'), png);
  fs.writeFileSync(path.join(config.contentDir, 'corrupt.png'), Buffer.from('not a png at all'));

  insert('img-bare', 'bare.png', 'bare.png', 'image/png', png.length, null, null);
  insert('img-has', 'has-thumb.png', 'has-thumb.png', 'image/png', png.length, null, 'thumb_existing.jpg');
  insert('img-gone', 'gone.png', 'gone.png', 'image/png', 10, null, null);
  insert('img-corrupt', 'corrupt.png', 'corrupt.png', 'image/png', 16, null, null);
  insert('yt', 'promo', '', 'video/youtube', 0, 'https://youtu.be/aaaaaaaaaaa', null);
  insert('html', 'feed', '', 'text/html', 0, 'https://example.com/feed', null);

  const stats = await backfillMissingThumbnails({ delayMs: 0 });

  // Scanned: img-bare + img-gone + img-corrupt. Remote rows and already-thumbed rows never qualify.
  assert.equal(stats.scanned, 3);
  assert.equal(stats.generated, 1);
  assert.equal(stats.skipped, 1); // img-gone: file missing on disk
  assert.equal(stats.failed, 1);  // img-corrupt: sharp can't decode it

  // The phantom-path regression: a failed generation must NOT store a thumbnail_path
  // pointing at a file that was never written.
  assert.equal(row('img-corrupt').thumbnail_path, null, 'failed generation stores nothing');

  const healed = row('img-bare');
  assert.ok(healed.thumbnail_path, 'thumbnail_path filled in');
  assert.ok(fs.existsSync(path.join(config.contentDir, path.basename(healed.thumbnail_path))), 'thumbnail written to disk');
  assert.equal(healed.width, 3);
  assert.equal(healed.height, 2);

  assert.equal(row('img-has').thumbnail_path, 'thumb_existing.jpg', 'existing thumbnail untouched');
  assert.equal(row('yt').thumbnail_path, null, 'remote row untouched');

  // Idempotent: the healed row no longer matches; the missing-file and corrupt rows remain
  // (they'd be retried next boot — correct if the operator fixes the underlying cause).
  const again = await backfillMissingThumbnails({ delayMs: 0 });
  assert.equal(again.scanned, 2);
  assert.equal(again.generated, 0);
});

test('backfill fills a video thumbnail and duration when ffmpeg is present', async (t) => {
  const { mediaToolStatus } = require('../lib/media-tools');
  const tools = await mediaToolStatus();
  if (!tools.ffmpeg || !tools.ffprobe) return t.skip('ffmpeg/ffprobe not installed on this machine');

  // Don't depend on the image test having created the directory first.
  fs.mkdirSync(config.contentDir, { recursive: true });

  // Synthesize a 5s test clip with ffmpeg itself — no fixture binary in the repo.
  // 5s, not shorter: ingest thumbnails the frame at t=2s, which must exist.
  const clip = path.join(config.contentDir, 'clip.mp4');
  require('node:child_process').execFileSync('ffmpeg', [
    '-y', '-f', 'lavfi', '-i', 'testsrc=duration=5:size=64x48:rate=10', clip,
  ], { timeout: 30000, stdio: 'ignore' });

  insert('vid-bare', 'clip.mp4', 'clip.mp4', 'video/mp4', fs.statSync(clip).size, null, null);
  const stats = await backfillMissingThumbnails({ delayMs: 0 });
  assert.equal(stats.generated, 1);

  const healed = row('vid-bare');
  assert.ok(/\.jpg$/.test(healed.thumbnail_path), 'video thumbnail is a jpg frame');
  assert.ok(fs.existsSync(path.join(config.contentDir, path.basename(healed.thumbnail_path))));
  assert.equal(healed.width, 64);
  assert.equal(healed.height, 48);
  assert.ok(healed.duration_sec > 4 && healed.duration_sec <= 6, `duration ${healed.duration_sec} ≈ 5s`);
});
