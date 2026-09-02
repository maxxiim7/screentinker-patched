// Offline content caching policy for the web player's service worker.
//
// WHY THIS EXISTS: content bytes were never persistently cached. The service worker deliberately
// skipped `/uploads/content/` and leaned on `Cache-Control: public, max-age=2592000, immutable`,
// letting the browser's own HTTP cache hold the media. On a desktop browser that is reasonable.
// On BrightSign it is not a guarantee: BrightSign documents persistence across reloads, app
// restarts and REBOOTS for IndexedDB, localStorage and SQLite only — the HTTP disk cache is not on
// that list, and their canonical answer for offline video is to cache the bytes explicitly. So a
// panel that lost its server could come back up with a playlist (that survives in localStorage) and
// no media to play, which is the exact failure signage cannot have.
//
// The service worker's Cache API is the mechanism this repo already trusts for exactly this: widget
// renders are cache-first precisely so a widget keeps rendering when the uplink is gone. This
// extends the same treatment to content.
//
// THE REASON CONTENT WAS SKIPPED IN THE FIRST PLACE IS REAL, and this module is what makes
// intercepting it safe: video elements issue RANGE requests when they seek, and naive caching
// breaks playback in two well-known ways.
//
//   1. Caching a 206 partial as if it were the whole file. A later full request then gets a
//      fragment and the video is corrupt — worse than not caching, and it persists until eviction.
//   2. Answering a Range request with a 200 full body. Some media stacks accept it; others treat
//      the mismatch as a fatal error and the video simply never plays.
//
// So: only ever STORE complete 200 responses, and when a Range request arrives, slice the stored
// body into a correct 206 ourselves. Both halves are pure functions here, tested without a browser.
//
// Dependency-free UMD: Node (require) + service worker (importScripts -> self.PlayerCachePolicy).

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PlayerCachePolicy = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /*
   * Is this a request for playable content we should hold for offline use?
   *
   * Deliberately narrow. `/uploads/content/` is the media the playlist points at; everything else
   * on /uploads (thumbnails aside) is dashboard-facing and not needed by a dark player. Non-GET
   * never caches — a POST is not a thing you can replay.
   */
  function isCacheableContent(url, method) {
    if (method && method !== 'GET') return false;
    var path;
    try {
      path = typeof url === 'string' ? new URL(url, 'http://x').pathname : url.pathname;
    } catch (e) {
      return false;
    }
    return path.indexOf('/uploads/content/') === 0;
  }

  /*
   * Parse a Range header against a known body size.
   *
   * Returns {start, end} INCLUSIVE, or null when the header is absent/unparseable (caller then
   * serves the whole thing), or the string 'unsatisfiable' when the range lies outside the body —
   * which must become a 416, not a silent clamp, or a seeking player can loop forever asking for
   * bytes that do not exist.
   *
   * Only single ranges are honoured. Multipart ranges are legal HTTP and essentially never used by
   * media elements; answering one wrongly is worse than declining to, so those return null and fall
   * through to the full body.
   */
  function parseRange(rangeHeader, size) {
    if (!rangeHeader || typeof rangeHeader !== 'string') return null;
    if (!(size > 0)) return null;

    var m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
    if (!m) return null;                       // multipart, or junk: serve whole
    var startRaw = m[1];
    var endRaw = m[2];
    if (startRaw === '' && endRaw === '') return null;

    var start, end;
    if (startRaw === '') {
      // Suffix form: "bytes=-500" means the LAST 500 bytes, not "from 0 to 500". Getting this
      // backwards hands the player the beginning of the file when it asked for the end.
      var suffix = parseInt(endRaw, 10);
      if (!(suffix > 0)) return 'unsatisfiable';
      start = Math.max(0, size - suffix);
      end = size - 1;
    } else {
      start = parseInt(startRaw, 10);
      end = endRaw === '' ? size - 1 : parseInt(endRaw, 10);
      if (isNaN(start) || isNaN(end)) return null;
      // A start at or past EOF is unsatisfiable. An END past EOF is not — it is clamped, which is
      // what every media player relies on when it asks for "bytes=0-" style open ranges.
      if (start >= size) return 'unsatisfiable';
      if (end >= size) end = size - 1;
      if (end < start) return 'unsatisfiable';
    }
    return { start: start, end: end };
  }

  /*
   * Headers for the 206 we build from a cached full body. Content-Range must describe the ORIGINAL
   * size, not the slice length — a player uses it to learn how long the media is, and reporting the
   * slice size makes a long video look like a fragment and stops seeking dead.
   */
  function partialHeaders(start, end, size, contentType) {
    var h = {
      'Content-Range': 'bytes ' + start + '-' + end + '/' + size,
      'Content-Length': String(end - start + 1),
      'Accept-Ranges': 'bytes'
    };
    if (contentType) h['Content-Type'] = contentType;
    return h;
  }

  /*
   * Is a network response safe to STORE?
   *
   * A 206 must never be stored: it is a fragment, and storing it means a later full request is
   * answered with part of a file. An opaque response (no-cors) has an unreadable body and a status
   * of 0, so it cannot be validated or sliced. Both were the reason content caching was avoided;
   * refusing them here is what makes it safe.
   */
  function isStorable(response) {
    if (!response) return false;
    if (response.status !== 200) return false;
    if (response.type === 'opaque' || response.type === 'opaqueredirect') return false;
    return true;
  }

  /*
   * Should we evict to make room? Callers pass current usage and the incoming size.
   *
   * The player's widget is created with a fixed storage_quota (1GB) and a full cache does not fail
   * gracefully — writes throw QuotaExceededError, and the failure lands on whichever item happened
   * to be next, not on the biggest one. Keeping a headroom margin means eviction happens on our
   * terms, in advance, instead of as a surprise mid-playlist.
   */
  function needsEviction(usedBytes, incomingBytes, quotaBytes, headroomRatio) {
    if (!(quotaBytes > 0)) return false;
    var headroom = typeof headroomRatio === 'number' ? headroomRatio : 0.9;
    return (usedBytes + incomingBytes) > (quotaBytes * headroom);
  }

  /*
   * ---------------------------------------------------------------------------------------------
   * RESUMABLE TRANSFER
   *
   * Storing a complete 200 is only safe once you can GET a complete 200. A single fetch() of a
   * 200MB asset over a one-bar link does not finish, and every retry starts again from nothing —
   * which is how a site ends up with an empty cache and a screen showing the waiting state. The
   * Android player hit exactly this and was fixed by resuming; these helpers are the same idea for
   * the browser-based players, where there is no file handle to append to and progress has to be
   * accumulated as separate cache entries instead.
   * ---------------------------------------------------------------------------------------------
   */

  // 4MB. Small enough that a marginal link finishes one inside a stall timeout, large enough that a
  // 200MB asset is 50 requests rather than 1600 — per-request overhead on a slow uplink is not free.
  var CHUNK_BYTES = 4 * 1024 * 1024;

  /*
   * The byte ranges an asset of [total] bytes decomposes into. Inclusive ends, because that is what
   * both the Range header and Content-Range use, and converting between the two conventions is
   * where off-by-one corruption comes from.
   */
  function chunkRanges(total, chunkSize) {
    var size = chunkSize > 0 ? chunkSize : CHUNK_BYTES;
    var out = [];
    if (!(total > 0)) return out;
    for (var start = 0; start < total; start += size) {
      out.push({ start: start, end: Math.min(start + size, total) - 1 });
    }
    return out;
  }

  /*
   * "bytes <start>-<end>/<total>" -> {start, end, total}. Null for anything we cannot verify a
   * total from, including the "*" form: without the total there is nothing to decide completeness
   * against, and guessing produces a cache entry that is confidently short.
   */
  function parseContentRange(header) {
    if (!header || typeof header !== 'string') return null;
    var m = /^\s*bytes\s+(\d+)-(\d+)\/(\d+)\s*$/.exec(header);
    if (!m) return null;
    return { start: Number(m[1]), end: Number(m[2]), total: Number(m[3]) };
  }

  /*
   * The validator to send back as If-Range on the next chunk.
   *
   * Without one, a resume splices the tail of a NEW asset onto the head of an old one and produces
   * a file of exactly the right length that is nonetheless corrupt — it would pass every
   * completeness check and be played. ETag first (it changes on any byte change); Last-Modified is
   * the weaker fallback, and no validator at all means the transfer is not resumable.
   */
  function validatorOf(headers) {
    if (!headers || typeof headers.get !== 'function') return null;
    return headers.get('ETag') || headers.get('Last-Modified') || null;
  }

  /*
   * Is a stored partial still usable, given what the server just said?
   *
   * A 206 at the offset we asked for, with a matching validator and the same total, continues. A
   * 200 means the server declined the range (changed asset, or no range support) and the transfer
   * restarts. Anything else is discarded rather than reasoned about.
   */
  function resumeVerdict(status, contentRange, expectStart, expectTotal, validatorSent, validatorNow) {
    if (status === 200) return 'restart';
    if (status === 416) return 'discard';
    if (status !== 206) return 'discard';
    var cr = parseContentRange(contentRange);
    if (!cr) return 'discard';
    if (cr.start !== expectStart) return 'discard';
    if (expectTotal > 0 && cr.total !== expectTotal) return 'discard';
    // A server that honours If-Range should not answer 206 with a different validator, but the
    // check costs nothing and the failure it prevents is a silent splice.
    if (validatorSent && validatorNow && validatorSent !== validatorNow) return 'discard';
    return 'continue';
  }

  /*
   * The asset a URL refers to, ignoring the revision.
   *
   * Cache entries are keyed with the revision in the query string so that replacing an asset is a
   * MISS everywhere rather than a copy nobody can invalidate. The flip side is that the superseded
   * entries would sit there until the quota evicted them — on a 1GB panel quota, a few replaced
   * videos is the whole budget. This is what lets a store sweep its own predecessors.
   */
  function assetKey(url) {
    try {
      var u = typeof url === 'string' ? new URL(url, 'http://x') : url;
      return u.origin + u.pathname;
    } catch (e) {
      return String(url).split('?')[0];
    }
  }

  /*
   * Is [url] a chunk/bookkeeping entry rather than a playable asset? Those must never be returned
   * to a media element, and must never be mistaken for "the asset is cached".
   */
  function isInternalKey(url) {
    return String(url).indexOf(INTERNAL_MARK) !== -1;
  }

  var INTERNAL_MARK = '__st_part';

  function chunkKey(url, start) {
    return url + (url.indexOf('?') === -1 ? '?' : '&') + INTERNAL_MARK + '=' + start;
  }

  return {
    isCacheableContent: isCacheableContent,
    parseRange: parseRange,
    partialHeaders: partialHeaders,
    isStorable: isStorable,
    needsEviction: needsEviction,
    CHUNK_BYTES: CHUNK_BYTES,
    chunkRanges: chunkRanges,
    parseContentRange: parseContentRange,
    validatorOf: validatorOf,
    resumeVerdict: resumeVerdict,
    assetKey: assetKey,
    isInternalKey: isInternalKey,
    chunkKey: chunkKey
  };
});
