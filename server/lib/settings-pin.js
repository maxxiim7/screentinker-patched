'use strict';

const crypto = require('crypto');

/*
 * The PIN that gates the on-device settings menu (two taps of Back, then a PIN).
 *
 * It was generated once at pairing and never changed. On a fleet that makes it a shared secret
 * with no expiry: anyone who watches it typed once — an installer, a contractor, someone filming
 * a screen — keeps it for the life of the panel, and the only way to take it back was to unpair
 * and re-pair every affected display. A customer asked whether it rotates. It did not.
 *
 * So: settable and rotatable from the dashboard, pushed to the panel live.
 *
 * Kept pure and separate because the VALIDATION is the security-relevant part and deserves tests
 * that do not need a fleet: a PIN that can be set to "0000" or to an empty string is a gate that
 * is not there.
 */

// Six digits, matching what the Android menu prompts for. Not configurable: a length that varies
// per device is a support burden, and the keypad on a signage panel is often a remote control.
const PIN_LENGTH = 6;

/*
 * Sequences and repeats are the PINs people actually pick, and the ones an onlooker guesses first.
 * Rejected on explicit SET; never produced by the generator.
 */
const WEAK = new Set(['000000', '111111', '222222', '333333', '444444', '555555', '666666',
  '777777', '888888', '999999', '123456', '654321', '012345', '543210']);

/**
 * Generate a fresh PIN.
 *
 * Uses crypto.randomInt, not Math.random: this is a credential. The previous generator used
 * SQLite's random() at provisioning time, which is fine, but a rotation the operator asked for
 * because a PIN leaked must not be predictable from any other value.
 */
function generatePin() {
  for (let attempt = 0; attempt < 20; attempt++) {
    const pin = String(crypto.randomInt(0, 1000000)).padStart(PIN_LENGTH, '0');
    if (!WEAK.has(pin)) return pin;
  }
  // Exhausting 20 draws against a 14-entry blocklist is essentially impossible; if it somehow
  // happens, a non-weak constant beats returning something weak or throwing during provisioning.
  return '481920';
}

/**
 * Validate an operator-supplied PIN.
 * @returns {{ok: true, pin: string} | {ok: false, error: string}}
 */
function validatePin(input) {
  if (input === null || input === undefined) return { ok: false, error: 'PIN is required' };
  const pin = String(input).trim();
  if (!/^[0-9]+$/.test(pin)) return { ok: false, error: 'PIN must be digits only' };
  if (pin.length !== PIN_LENGTH) return { ok: false, error: `PIN must be ${PIN_LENGTH} digits` };
  if (WEAK.has(pin)) return { ok: false, error: 'PIN is too easily guessed' };
  return { ok: true, pin };
}

module.exports = { generatePin, validatePin, PIN_LENGTH, WEAK };
