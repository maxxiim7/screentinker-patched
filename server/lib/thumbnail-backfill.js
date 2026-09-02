'use strict';

// Retroactive thumbnail generation. Ingest-time generation (lib/content-ingest) is
// best-effort by contract, so a row silently ends up without a thumbnail whenever it
// fails — most commonly video uploads on a host without ffmpeg installed, plus any
// content from before thumbnails existed. Those rows previously stayed bare forever:
// nothing ever looked at them again.
//
// This sweep runs once per boot (kicked off from server.js shortly after listen),
// finds local image/video rows with no thumbnail, and re-derives metadata for each.
// One file at a time with a pause between files: the point is to heal the library
// eventually, not to win a race against playback serving on the same box.
//
// Idempotent by construction — a generated thumbnail fills thumbnail_path, which
// removes the row from the next boot's query. Video rows are skipped wholesale when
// ffmpeg/ffprobe are missing (the [MEDIA] startup diagnostic already told the
// operator) rather than paying a doomed ffmpeg spawn per file per boot.
//
// The sweep can take a long time on a large bare library, and the replace/delete
// flows may touch the same rows meanwhile. Two consequences handled below:
//   - the row UPDATE re-checks that thumbnail_path is STILL empty, so a thumbnail
//     written concurrently by PUT /:id/replace is never clobbered with a frame of
//     the pre-replace bytes;
//   - a row that vanished (or was replaced) mid-derive gets its just-written thumb
//     file removed again — contentDir has no garbage collector.

const path = require('path');
const fs = require('fs');
const { db } = require('../db/database');
const config = require('../config');
const { deriveMediaMetadata } = require('./content-ingest');
const { mediaToolStatus } = require('./media-tools');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Undecodable files fail again every boot (thumbnail_path is the only idempotency
// marker — deliberately, so installing ffmpeg heals them). A video can burn two 15s
// subprocess timeouts, so a library with hundreds of corrupt clips must not turn
// every boot into an hour of doomed ffmpeg spawns: stop after this many failures
// and let the next boot take another bite.
const FAILURE_CAP = 25;

async function backfillMissingThumbnails({ delayMs = 500 } = {}) {
  const tools = await mediaToolStatus();
  // filepath != '' and no remote_url: only content whose bytes live in contentDir.
  // Remote/YouTube/embed rows either carry a remote thumbnail URL already or have
  // nothing local to derive one from.
  const rows = db.prepare(`
    SELECT id, filepath, mime_type FROM content
    WHERE (thumbnail_path IS NULL OR thumbnail_path = '')
      AND filepath != ''
      AND (remote_url IS NULL OR remote_url = '')
      AND (mime_type LIKE 'image/%' OR mime_type LIKE 'video/%')
  `).all();

  const stats = { scanned: rows.length, generated: 0, skipped: 0, failed: 0, aborted: false };
  const updateStmt = db.prepare(`
    UPDATE content SET thumbnail_path = ?,
      width = COALESCE(width, ?), height = COALESCE(height, ?),
      duration_sec = COALESCE(duration_sec, ?)
    WHERE id = ? AND (thumbnail_path IS NULL OR thumbnail_path = '')
  `);
  // Thumbnail failed but the probe worked: keep the dims/duration (item-duration and
  // orientation handling consume them) without marking the row healed — it stays
  // eligible for a thumbnail retry next boot.
  const metadataStmt = db.prepare(`
    UPDATE content SET width = COALESCE(width, ?), height = COALESCE(height, ?),
      duration_sec = COALESCE(duration_sec, ?)
    WHERE id = ?
  `);

  for (const row of rows) {
    if (stats.failed >= FAILURE_CAP) {
      stats.aborted = true;
      console.warn(`[MEDIA] thumbnail backfill: stopping after ${stats.failed} failures — will retry remaining rows next boot`);
      break;
    }
    const isVideo = row.mime_type.startsWith('video/');
    if (isVideo && (!tools.ffmpeg || !tools.ffprobe)) { stats.skipped++; continue; }
    const storedName = path.basename(row.filepath);
    const sourcePath = path.join(config.contentDir, storedName);
    if (!fs.existsSync(sourcePath)) { stats.skipped++; continue; }
    try {
      const { width, height, durationSec, thumbnailPath } =
        await deriveMediaMetadata(sourcePath, storedName, row.mime_type);
      if (thumbnailPath) {
        const res = updateStmt.run(thumbnailPath, width, height, durationSec, row.id);
        if (res.changes === 0 && thumbnailPath !== storedName) {
          // Row deleted/replaced while we were deriving. Don't leave the freshly
          // written file orphaned. (thumbnailPath === storedName is the SVG
          // self-thumbnail case — that file IS the content, never remove it.)
          try { fs.unlinkSync(path.join(config.contentDir, path.basename(thumbnailPath))); } catch { /* best-effort */ }
        }
        stats.generated += res.changes;
      } else {
        if (width || height || durationSec) metadataStmt.run(width, height, durationSec, row.id);
        stats.failed++; // deriveMediaMetadata already warned with the reason
      }
    } catch (e) {
      stats.failed++;
      console.warn(`Thumbnail backfill failed for ${row.id}: ${e.message}`);
    }
    await sleep(delayMs);
  }
  return stats;
}

module.exports = { backfillMissingThumbnails };
