'use strict';

// #233: the upload ceiling was hard-coded at 500MB, which is too low for video. Making it an
// env var is right, but env vars are STRINGS — `process.env.MAX_FILE_SIZE || default` hands
// multer's limits.fileSize a string where it wants a number. That survives some comparisons by
// coercion and misbehaves in others, which is the worst kind of bug to track down later.
//
// The other half is that a bad value must not become NaN or 0. Either would reject every upload
// on the instance, from a typo in an env file, with nothing on screen explaining why. Falling
// back to the documented default is the only safe reading of an unparseable limit.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseSize } = require('../lib/parse-size');

const MB = 1024 * 1024;
const GB = 1024 * MB;
const DEFAULT = 500 * MB;

test('THE BUG: the result is a number, never the raw string', () => {
  const v = parseSize('2000000000', DEFAULT);
  assert.equal(typeof v, 'number', 'multer wants a number');
  assert.equal(v, 2000000000);
});

test('a bare number is bytes, which is what the variable meant before suffixes', () => {
  assert.equal(parseSize('1500000000', DEFAULT), 1500000000);
  assert.equal(parseSize(1500000000, DEFAULT), 1500000000);
});

test('a suffix is understood, because nobody should have to type 2147483648', () => {
  assert.equal(parseSize('2GB', DEFAULT), 2 * GB);
  assert.equal(parseSize('2gb', DEFAULT), 2 * GB);
  assert.equal(parseSize('1500MB', DEFAULT), 1500 * MB);
  assert.equal(parseSize('750kb', DEFAULT), 750 * 1024);
  assert.equal(parseSize('900b', DEFAULT), 900);
});

test('spacing and case do not matter', () => {
  assert.equal(parseSize(' 2 GB ', DEFAULT), 2 * GB);
  assert.equal(parseSize('2Gb', DEFAULT), 2 * GB);
});

test('a fractional size is allowed and floored to whole bytes', () => {
  assert.equal(parseSize('1.5GB', DEFAULT), Math.floor(1.5 * GB));
  assert.equal(Number.isInteger(parseSize('1.5GB', DEFAULT)), true);
});

test('THE SAFETY RULE: an unparseable value falls back, it does not become NaN or 0', () => {
  // A NaN or zero limit rejects every upload on the instance. A typo in an env file must not
  // do that silently.
  for (const bad of ['nonsense', '2 gigabytes', 'GB', '-5MB', '0', '0GB', '', '   ', null, undefined, NaN, {}]) {
    const v = parseSize(bad, DEFAULT);
    assert.equal(v, DEFAULT, `${JSON.stringify(bad)} should fall back`);
    assert.ok(Number.isFinite(v) && v > 0);
  }
});

test('the shipped default is unchanged at 500MB', () => {
  // Raising the ceiling for everyone silently is not the point of this change.
  delete process.env.MAX_FILE_SIZE;
  delete require.cache[require.resolve('../config')];
  const config = require('../config');
  assert.equal(config.maxFileSize, DEFAULT);
  assert.equal(typeof config.maxFileSize, 'number');
});

test('config honours the env var end to end', () => {
  process.env.MAX_FILE_SIZE = '3GB';
  delete require.cache[require.resolve('../config')];
  const config = require('../config');
  assert.equal(config.maxFileSize, 3 * GB);
  assert.equal(typeof config.maxFileSize, 'number');
  delete process.env.MAX_FILE_SIZE;
  delete require.cache[require.resolve('../config')];
});
