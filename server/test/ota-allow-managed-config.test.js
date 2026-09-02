'use strict';

// #166 escape hatch: OTA_ALLOW_MANAGED_DEVICES lets players self-update even when an MDM/DPC owns
// the device. The default has to be OFF, and "off" has to be the answer for every shape of a
// not-set / mistyped value — an operator who fat-fingers the variable must not silently get the
// unsafe behaviour, because the failure mode is an install confirm dialog parked over a customer's
// content on a fleet nobody is standing in front of.
//
// The value is also advertised to players as `allow_managed` in /api/update/check. A player that
// gets no field at all (older server) must read that as NO. Absence is not consent.

const { test } = require('node:test');
const assert = require('node:assert/strict');

function loadConfig(value) {
  if (value === undefined) delete process.env.OTA_ALLOW_MANAGED_DEVICES;
  else process.env.OTA_ALLOW_MANAGED_DEVICES = value;
  delete require.cache[require.resolve('../config')];
  return require('../config');
}

test('THE DEFAULT: unset means managed devices do NOT self-update', () => {
  const config = loadConfig(undefined);
  assert.equal(config.otaAllowManagedDevices, false);
  assert.equal(typeof config.otaAllowManagedDevices, 'boolean');
});

test('the documented ways to turn it on', () => {
  for (const v of ['1', 'true', 'TRUE', 'True']) {
    assert.equal(loadConfig(v).otaAllowManagedDevices, true, `${v} should enable`);
  }
});

test('everything else is OFF — a typo must not enable an unsafe default', () => {
  // '0'/'false' are the explicit no. The rest are the fat-finger cases: they must land on the
  // safe side rather than being treated as "any non-empty string is truthy".
  for (const v of ['0', 'false', 'FALSE', 'no', 'off', 'yes', 'ture', 'enabled', '2', '', ' ']) {
    assert.equal(loadConfig(v).otaAllowManagedDevices, false, `${JSON.stringify(v)} should stay off`);
  }
});

test('it is always a real boolean, never a string, so the JSON field is unambiguous', () => {
  // Players read this over the wire; the string "false" is truthy in every client language.
  for (const v of [undefined, '1', 'nonsense']) {
    assert.equal(typeof loadConfig(v).otaAllowManagedDevices, 'boolean');
  }
});

test.after(() => {
  delete process.env.OTA_ALLOW_MANAGED_DEVICES;
  delete require.cache[require.resolve('../config')];
});
