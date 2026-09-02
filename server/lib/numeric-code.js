'use strict';

// Six-digit codes that gate access: the on-device settings PIN (devices.settings_pin) and
// the provisioning pairing code (devices.pairing_code).
//
// Both were generated with `Math.floor(100000 + Math.random() * 900000)`. Math.random is
// not a CSPRNG — V8 implements it as xorshift128+, whose internal state is recoverable
// from a handful of consecutive outputs, and every call in a process draws from that one
// shared stream. These two values are also OBSERVABLE by ordinary users (the PIN is
// returned in device API responses today), so an attacker who can collect a few can
// predict the ones minted around them for other tenants.
//
// crypto.randomInt is CSPRNG-backed and rejection-samples, so the distribution stays
// uniform across the range rather than skewing the way a modulo would.
//
// Range is 100000..999999 inclusive — identical to what the old expression produced, so
// the code is always exactly six digits with no leading zero, which is what the on-device
// keypad and the pairing UI expect.

const crypto = require('crypto');

function sixDigitCode() {
  return String(crypto.randomInt(100000, 1000000));
}

module.exports = { sixDigitCode };
