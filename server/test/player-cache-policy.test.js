'use strict';

// Content bytes were never persistently cached. The service worker skipped `/uploads/content/` and
// leaned on the browser's HTTP cache, which is fine on a desktop and is NOT a documented-persistent
// store on BrightSign — they guarantee persistence across reboots for IndexedDB, localStorage and
// SQLite, and their own answer for offline video is to cache the bytes explicitly. A panel that lost
// its uplink could therefore come back with a playlist (which survives in localStorage) and no media
// to play it with.
//
// Intercepting content is only safe if range requests keep working, which is exactly why it was
// avoided before. Two failure modes make video WORSE than not caching at all:
//
//   * storing a 206 as though it were the whole file — every later full request gets a fragment,
//     and it stays broken until something evicts it
//   * answering a Range request with a 200 — some media stacks treat the mismatch as fatal and the
//     video never starts
//
// These tests pin both, plus the range arithmetic that a seeking player depends on.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const P = require('../lib/player-cache-policy');

// ---------------------------------------------------------------- what gets cached

test('content under /uploads/content is cacheable — that is the media a dark player needs', () => {
  assert.equal(P.isCacheableContent('https://s.example/uploads/content/abc.mp4', 'GET'), true);
  assert.equal(P.isCacheableContent('https://s.example/uploads/content/nested/x.jpg', 'GET'), true);
});

test('everything else is left alone, so API calls and sockets are never served stale', () => {
  assert.equal(P.isCacheableContent('https://s.example/api/status', 'GET'), false);
  assert.equal(P.isCacheableContent('https://s.example/uploads/thumbs/x.jpg', 'GET'), false);
  assert.equal(P.isCacheableContent('https://s.example/player', 'GET'), false);
});

test('a non-GET is never cached — you cannot replay a POST', () => {
  assert.equal(P.isCacheableContent('https://s.example/uploads/content/a.mp4', 'POST'), false);
});

test('a malformed URL is declined rather than throwing inside a fetch handler', () => {
  // A throw here takes down the fetch handler and the page loses every request, not just this one.
  assert.doesNotThrow(() => P.isCacheableContent('::::not a url::::', 'GET'));
  assert.equal(P.isCacheableContent('::::not a url::::', 'GET'), false);
});

// ---------------------------------------------------------------- what gets STORED

test('THE CORRUPTION BUG: a 206 is never stored as if it were the whole file', () => {
  // Storing a fragment under the full-file key means every later full request is answered with part
  // of a video, and it stays broken until eviction. This is the single most damaging mistake here.
  assert.equal(P.isStorable({ status: 206, type: 'basic' }), false);
});

test('an opaque response is never stored — status 0, unreadable body, unsliceable', () => {
  assert.equal(P.isStorable({ status: 0, type: 'opaque' }), false);
  assert.equal(P.isStorable({ status: 200, type: 'opaque' }), false);
});

test('errors and redirects are not stored, so an outage cannot poison the cache', () => {
  assert.equal(P.isStorable({ status: 404, type: 'basic' }), false);
  assert.equal(P.isStorable({ status: 503, type: 'basic' }), false);
  assert.equal(P.isStorable({ status: 200, type: 'opaqueredirect' }), false);
  assert.equal(P.isStorable(null), false);
});

test('a complete 200 IS stored — otherwise nothing is ever available offline', () => {
  assert.equal(P.isStorable({ status: 200, type: 'basic' }), true);
  assert.equal(P.isStorable({ status: 200, type: 'cors' }), true);
});

// ---------------------------------------------------------------- range arithmetic

test('an open range "bytes=0-" spans the whole body — the common video start', () => {
  assert.deepEqual(P.parseRange('bytes=0-', 1000), { start: 0, end: 999 });
});

test('a closed range is honoured exactly', () => {
  assert.deepEqual(P.parseRange('bytes=100-200', 1000), { start: 100, end: 200 });
});

test('THE SEEK BUG: a suffix range is the LAST n bytes, not the first n', () => {
  // "bytes=-500" means the final 500 bytes. Reading it as 0-500 hands a seeking player the start of
  // the file when it asked for the end — MP4 moov-atom probing does exactly this.
  assert.deepEqual(P.parseRange('bytes=-500', 1000), { start: 500, end: 999 });
});

test('an end past EOF is clamped, because that is what open-ended seeks rely on', () => {
  assert.deepEqual(P.parseRange('bytes=900-99999', 1000), { start: 900, end: 999 });
});

test('a start past EOF is UNSATISFIABLE, not clamped — clamping loops a seeking player forever', () => {
  assert.equal(P.parseRange('bytes=1000-', 1000), 'unsatisfiable');
  assert.equal(P.parseRange('bytes=5000-6000', 1000), 'unsatisfiable');
});

test('a reversed range is unsatisfiable rather than silently swapped', () => {
  assert.equal(P.parseRange('bytes=800-100', 1000), 'unsatisfiable');
});

test('no header, junk, or multipart falls back to the full body instead of guessing', () => {
  assert.equal(P.parseRange(null, 1000), null);
  assert.equal(P.parseRange('', 1000), null);
  assert.equal(P.parseRange('bytes=abc-def', 1000), null);
  assert.equal(P.parseRange('bytes=0-99,200-299', 1000), null, 'multipart: serving one part would be wrong');
  assert.equal(P.parseRange('items=0-10', 1000), null);
  assert.equal(P.parseRange('bytes=-', 1000), null);
});

test('a zero-length body has no satisfiable range', () => {
  assert.equal(P.parseRange('bytes=0-', 0), null);
});

// ---------------------------------------------------------------- 206 headers

test('THE DURATION BUG: Content-Range reports the ORIGINAL size, not the slice length', () => {
  // The player learns how long the media is from this. Reporting the slice size makes a 90-minute
  // video look a few seconds long and kills seeking entirely.
  const h = P.partialHeaders(100, 199, 5000, 'video/mp4');
  assert.equal(h['Content-Range'], 'bytes 100-199/5000');
  assert.equal(h['Content-Length'], '100', 'length is the slice, inclusive of both ends');
  assert.equal(h['Accept-Ranges'], 'bytes');
  assert.equal(h['Content-Type'], 'video/mp4');
});

test('a single-byte range still reports length 1', () => {
  assert.equal(P.partialHeaders(0, 0, 10)['Content-Length'], '1');
});

// ---------------------------------------------------------------- quota

test('eviction is decided BEFORE the write, not after a QuotaExceededError', () => {
  // A full cache throws on write, and the throw lands on whatever item came next rather than the
  // largest — so the player loses an arbitrary item mid-playlist. Deciding in advance keeps it ours.
  const GB = 1024 * 1024 * 1024;
  assert.equal(P.needsEviction(0, 10 * 1024 * 1024, GB), false);
  assert.equal(P.needsEviction(GB * 0.85, 100 * 1024 * 1024, GB), true);
});

test('headroom leaves room to breathe rather than filling to the brim', () => {
  const GB = 1024 * 1024 * 1024;
  assert.equal(P.needsEviction(GB * 0.89, 1, GB), false);
  assert.equal(P.needsEviction(GB * 0.91, 1, GB), true);
});

test('an unknown quota never triggers eviction — absence of a number is not a full disk', () => {
  assert.equal(P.needsEviction(999, 999, 0), false);
  assert.equal(P.needsEviction(999, 999, undefined), false);
});

// ---------------------------------------------------------------------------------------------
// Resumable transfer. The arithmetic below is what stops a resumed download from being corrupt,
// and it is shared by the service worker and the Tizen media cache — neither of which can be
// tested without a device, which is exactly why the decisions live here.
// ---------------------------------------------------------------------------------------------

test('chunkRanges covers every byte exactly once, with an inclusive final range', () => {
  const r = P.chunkRanges(10, 4);
  assert.deepEqual(r, [{ start: 0, end: 3 }, { start: 4, end: 7 }, { start: 8, end: 9 }]);
  // The gap-or-overlap check: a one-byte error here corrupts the middle of a video in a way that
  // only shows up on playback, long after the download "succeeded".
  const big = P.chunkRanges(1000, 256);
  let cursor = 0;
  for (const c of big) { assert.equal(c.start, cursor); cursor = c.end + 1; }
  assert.equal(cursor, 1000);
});

test('chunkRanges on an exact multiple does not emit a trailing empty range', () => {
  assert.deepEqual(P.chunkRanges(8, 4), [{ start: 0, end: 3 }, { start: 4, end: 7 }]);
});

test('chunkRanges of an unknown or empty size is no chunks, not one bad one', () => {
  assert.deepEqual(P.chunkRanges(0, 4), []);
  assert.deepEqual(P.chunkRanges(-1, 4), []);
});

test('parseContentRange refuses anything without a verifiable total', () => {
  assert.deepEqual(P.parseContentRange('bytes 4-7/10'), { start: 4, end: 7, total: 10 });
  assert.equal(P.parseContentRange('bytes 4-7/*'), null, 'no total = nothing to check against');
  assert.equal(P.parseContentRange('items 0-1/2'), null);
  assert.equal(P.parseContentRange(null), null);
});

test('resumeVerdict continues only on a verified 206 at the offset we asked for', () => {
  assert.equal(P.resumeVerdict(206, 'bytes 4-7/10', 4, 10, '"v1"', '"v1"'), 'continue');
});

test('resumeVerdict RESTARTS on a 200 — the server declined our range', () => {
  // If-Range with a stale validator produces exactly this, and it is the mechanism that stops a
  // changed asset being spliced. Treating it as a chunk to append is the corruption.
  assert.equal(P.resumeVerdict(200, null, 4, 10, '"v1"', '"v2"'), 'restart');
});

test('resumeVerdict discards a 206 that starts anywhere other than where we asked', () => {
  assert.equal(P.resumeVerdict(206, 'bytes 0-7/10', 4, 10, '"v1"', '"v1"'), 'discard');
});

test('resumeVerdict discards a 206 whose total disagrees with what we are assembling', () => {
  // Same offset, different asset length: appending would leave a file that is complete by our
  // count and wrong by every other measure.
  assert.equal(P.resumeVerdict(206, 'bytes 4-7/99', 4, 10, '"v1"', '"v1"'), 'discard');
});

test('resumeVerdict discards a 206 whose validator changed underneath us', () => {
  assert.equal(P.resumeVerdict(206, 'bytes 4-7/10', 4, 10, '"v1"', '"v2"'), 'discard');
});

test('resumeVerdict discards 416 and every unexpected status', () => {
  assert.equal(P.resumeVerdict(416, null, 4, 10, '"v1"', null), 'discard');
  assert.equal(P.resumeVerdict(500, null, 4, 10, '"v1"', null), 'discard');
  assert.equal(P.resumeVerdict(0, null, 4, 10, '"v1"', null), 'discard');
});

test('validatorOf prefers ETag and reports nothing when there is nothing to trust', () => {
  const h = (o) => ({ get: (k) => o[k.toLowerCase()] || null });
  assert.equal(P.validatorOf(h({ etag: '"v1"', 'last-modified': 'Mon' })), '"v1"');
  assert.equal(P.validatorOf(h({ 'last-modified': 'Mon' })), 'Mon');
  assert.equal(P.validatorOf(h({})), null, 'no validator means the transfer is not resumable');
});

test('assetKey ignores the revision so a store can sweep its own predecessors', () => {
  const a = 'http://s/uploads/content/clip.mp4?rev=100';
  const b = 'http://s/uploads/content/clip.mp4?rev=200';
  assert.equal(P.assetKey(a), P.assetKey(b));
  assert.notEqual(P.assetKey(a), P.assetKey('http://s/uploads/content/other.mp4?rev=100'));
});

test('chunk keys are recognisable as internal, so one can never be served as the asset', () => {
  const k = P.chunkKey('http://s/uploads/content/clip.mp4?rev=100', 4194304);
  assert.ok(P.isInternalKey(k));
  assert.ok(!P.isInternalKey('http://s/uploads/content/clip.mp4?rev=100'));
  // ...and the revision survives into the chunk key, or two revisions would share chunks.
  assert.match(k, /rev=100/);
});
