'use strict';

// The on-device settings PIN was generated once at pairing and never changed.
//
// On a fleet that makes it a shared secret with no expiry: anyone who sees it typed once — an
// installer, a contractor, someone filming a screen — keeps it for the life of the panel, and the
// only way to take it back was to unpair and re-pair every display. A customer asked whether it
// rotates, which is the right question to ask.
//
// The validation is the security-relevant half: a PIN that can be set to "0000" or left empty is a
// gate that is not there. These tests exist so a future "let operators pick any PIN they like"
// change has to argue with them first.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { generatePin, validatePin, PIN_LENGTH, WEAK } = require('../lib/settings-pin');

test('a generated PIN is exactly the length the on-device prompt expects', () => {
  for (let i = 0; i < 50; i++) {
    const p = generatePin();
    assert.equal(p.length, PIN_LENGTH);
    assert.match(p, /^[0-9]+$/);
  }
});

test('generated PINs keep their leading zeros', () => {
  // Generated as a number and padded: dropping the pad would emit 5-digit PINs ~10% of the time,
  // which the device prompt then refuses.
  const seen = new Set();
  for (let i = 0; i < 400; i++) seen.add(generatePin().length);
  assert.deepEqual([...seen], [PIN_LENGTH]);
});

test('the generator never emits a PIN it would refuse on input', () => {
  for (let i = 0; i < 500; i++) assert.ok(!WEAK.has(generatePin()));
});

test('generated PINs are not all the same value', () => {
  const seen = new Set();
  for (let i = 0; i < 50; i++) seen.add(generatePin());
  assert.ok(seen.size > 40, `expected variety, got ${seen.size} distinct in 50`);
});

test('THE GATE: obvious PINs are refused on an explicit set', () => {
  for (const weak of ['000000', '111111', '123456', '654321']) {
    const r = validatePin(weak);
    assert.equal(r.ok, false, `${weak} must be refused`);
  }
});

test('wrong length is refused — a 4-digit PIN would not open the 6-digit prompt', () => {
  assert.equal(validatePin('1234').ok, false);
  assert.equal(validatePin('12345678').ok, false);
});

test('non-digits are refused, including the ones that look like digits', () => {
  assert.equal(validatePin('12 456').ok, false);
  assert.equal(validatePin('abcdef').ok, false);
  assert.equal(validatePin('12.456').ok, false);
  assert.equal(validatePin('-12345').ok, false);
});

test('empty and missing are refused rather than silently clearing the gate', () => {
  assert.equal(validatePin('').ok, false);
  assert.equal(validatePin(null).ok, false);
  assert.equal(validatePin(undefined).ok, false);
  assert.equal(validatePin('      ').ok, false);
});

test('a good PIN is accepted and returned trimmed', () => {
  const r = validatePin('  204815 ');
  assert.equal(r.ok, true);
  assert.equal(r.pin, '204815');
});

test('a numeric PIN is accepted — the API may hand us a number, not a string', () => {
  const r = validatePin(204815);
  assert.equal(r.ok, true);
  assert.equal(r.pin, '204815');
});
