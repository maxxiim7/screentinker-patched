'use strict';

// Parse a human-written size into bytes.
//
// Environment variables are always STRINGS. `process.env.MAX_FILE_SIZE || default` therefore
// yields the string "2000000000", which then travels into multer's limits.fileSize where a
// number is expected — it happens to survive some comparisons through coercion and misbehaves
// in others, which is the worst kind of bug to chase.
//
// A plain byte count is also unfriendly for this particular setting: the person raising an
// upload limit for video is choosing "about 2GB", and 2147483648 is easy to mistype by a
// factor of ten. So a suffix is accepted as well.
//
// Deliberately strict: anything unparseable returns the fallback rather than 0 or NaN. A typo
// in an env var must not silently become "reject every upload", which is what a NaN limit or a
// zero would do.

const UNITS = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4 };

function parseSize(value, fallback) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;

  const raw = String(value).trim().toLowerCase().replace(/\s+/g, '');
  // Bare digits are bytes, which is what the variable meant before suffixes were understood.
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    return n > 0 ? n : fallback;
  }
  const m = raw.match(/^(\d+(?:\.\d+)?)(b|kb|mb|gb|tb)$/);
  if (!m) return fallback;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n * UNITS[m[2]]);
}

module.exports = { parseSize };
