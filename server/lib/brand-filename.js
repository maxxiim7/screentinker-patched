'use strict';

/*
 * Turn an operator-chosen brand name into something safe to put in a download filename.
 *
 * ⚠️ THIS IS SECURITY CODE, not cosmetics. brand_name is arbitrary operator-supplied text and it
 * lands in a Content-Disposition header. A quote closes the filename parameter early, and a CR or LF
 * ends the header line entirely — letting whatever follows be parsed as a header of its own. So this
 * is a WHITELIST of characters that are safe in both a filename and a header value, not a blacklist
 * of the ones we happened to think of.
 *
 * It also matters commercially, which is why it exists at all (#292): a partner reselling this
 * platform had every download land on their customer's disk as "ScreenTinker.apk", naming the
 * upstream product to the very people they were selling to.
 */

/**
 * @param {string} brand    the configured brand name, or anything at all
 * @param {string} fallback used when the brand is empty or sanitises away to nothing
 * @returns {string} a bare filename stem — no extension, no separators, no quotes
 */
function brandToFilenameStem(brand, fallback = 'ScreenTinker') {
  const stripped = String(brand == null ? '' : brand)
    // Decompose accents so "Café" yields "Cafe" rather than "Caf".
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    // The whitelist. Note '/' and '\' are absent, so no path traversal can survive either.
    .replace(/[^A-Za-z0-9._-]+/g, '')
    // A leading dot would make it a hidden file; a trailing one is invalid on Windows.
    .replace(/^\.+/, '')
    .replace(/\.+$/, '');
  // Keep it to something a filesystem will accept: 64 is far beyond any real brand name.
  return stripped.slice(0, 64) || fallback;
}

module.exports = { brandToFilenameStem };
