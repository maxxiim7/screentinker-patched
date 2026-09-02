'use strict';

/*
 * The brand name on its way into a Content-Disposition header (#292).
 *
 * Two things are being protected. The commercial one: a reseller's customer must not receive a file
 * called ScreenTinker.apk. The security one, which matters more: brand_name is arbitrary
 * operator-supplied text, and a quote or a newline in it would break out of the header — so the
 * cases below are mostly hostile input, not brand names anyone would choose.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { brandToFilenameStem } = require('../lib/brand-filename');

test('an ordinary brand name comes through recognisably', () => {
  assert.equal(brandToFilenameStem('BoldSignage'), 'BoldSignage');
  assert.equal(brandToFilenameStem('Bold Signage'), 'BoldSignage');
  assert.equal(brandToFilenameStem('Bold-Media_Group.v2'), 'Bold-Media_Group.v2');
});

test('nothing configured falls back to the product name', () => {
  for (const empty of ['', '   ', null, undefined]) {
    assert.equal(brandToFilenameStem(empty), 'ScreenTinker');
  }
});

test('a name that sanitises away entirely still yields a usable filename', () => {
  // Otherwise the download would be called ".apk", which some browsers refuse to save at all.
  assert.equal(brandToFilenameStem('日本語'), 'ScreenTinker');
  assert.equal(brandToFilenameStem('***'), 'ScreenTinker');
});

test('⚠️ a quote cannot break out of the header', () => {
  // attachment; filename="<HERE>"  — a quote would end the parameter and let the rest be parsed
  // as further header syntax.
  const out = brandToFilenameStem('Acme" ; filename="evil');
  assert.ok(!out.includes('"'), `a quote survived: ${out}`);
  assert.ok(!out.includes(';'), `a semicolon survived: ${out}`);
  assert.ok(!out.includes(' '), `a space survived: ${out}`);
});

test('⚠️ CR/LF cannot inject another header', () => {
  const out = brandToFilenameStem('Acme\r\nSet-Cookie: admin=1');
  assert.ok(!/[\r\n]/.test(out), `a line break survived: ${out}`);
  assert.equal(out, 'AcmeSet-Cookieadmin1');
});

test('⚠️ path separators cannot escape the filename', () => {
  assert.ok(!brandToFilenameStem('../../etc/passwd').includes('/'));
  assert.ok(!brandToFilenameStem('..\\..\\windows').includes('\\'));
  // Leading dots would also make it a hidden file rather than a download.
  assert.ok(!brandToFilenameStem('...Acme').startsWith('.'));
});

test('accents are transliterated rather than deleted', () => {
  // "Café Media" losing its é is fine; losing the whole word is not.
  assert.equal(brandToFilenameStem('Café Média'), 'CafeMedia');
});

test('an absurdly long name is bounded', () => {
  const out = brandToFilenameStem('A'.repeat(500));
  assert.equal(out.length, 64, 'filenames have limits on every filesystem worth naming');
});

test('a trailing dot is removed', () => {
  // Windows rejects a trailing dot outright, and "Acme..apk" is what naive concatenation gives.
  assert.equal(brandToFilenameStem('Acme.'), 'Acme');
});
