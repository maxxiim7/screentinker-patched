'use strict';

/*
 * A register that does not mention `platform` must not erase the one we have.
 *
 * liveness.captureIdentity() coerces a missing platform to the literal string 'unknown', and
 * persistIdentity() wrote that straight over the stored value. So a single register from any
 * client that doesn't send the field — an older build, a downgrade, anything pre-v4 — permanently
 * turned a known Tizen panel into 'unknown'.
 *
 * That column is load-bearing: player-capabilities.platformFamily() reads it to pick a baseline.
 * A cleared Tizen panel falls through to the WEB baseline, which hands it audio.volume (the .wgt
 * has no set_volume handler — that is precisely why BASELINE.tizen omits it) and offline.cache
 * (Tizen caches the playlist JSON, not the media). The same clobber costs a BrightSign its screen
 * power and reboot and gives it screenshots it cannot take.
 *
 * The rule is the one applyCapabilities() already documents one screen up: an ABSENT declaration
 * is not a statement about the device.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const liveness = require('../lib/liveness');
const caps = require('../lib/player-capabilities');

// What persistIdentity does with a register payload, minus the DB round trip.
const resolve = (stored, data) => liveness.preserveKnownIdentity(stored, liveness.captureIdentity(data));

test('a register with no platform leaves a known platform alone', () => {
  const tizen = { client_type: 'wgt', client_version: '1.9.29', platform: 'Tizen 6.0', contract_version: 'v4' };
  assert.equal(resolve(tizen, { device_id: 'x' }).platform, 'Tizen 6.0');

  const bs = { client_type: 'player', client_version: '1.9.29', platform: 'brightsign', contract_version: 'v4' };
  assert.equal(resolve(bs, { device_id: 'x' }).platform, 'brightsign');
});

test('the capability baseline survives that register — which is the whole point', () => {
  const stored = { client_type: 'wgt', client_version: '1.9.29', platform: 'Tizen 6.0', contract_version: 'v4' };
  const after = resolve(stored, { device_id: 'x' });                 // an old client reconnects
  const row = { platform: after.platform, client_type: after.client_type, android_version: null };

  assert.equal(caps.platformFamily(row), 'tizen');
  assert.equal(caps.supports(row, 'audio.volume'), false,
    'a fielded .wgt has no set_volume handler — the web baseline would have offered the slider anyway');
  assert.equal(caps.supports(row, 'offline.cache'), false,
    'Tizen caches the playlist JSON, not the media, so content does NOT survive an outage');

  const bsAfter = resolve({ client_type: 'player', client_version: '1.9.29', platform: 'brightsign', contract_version: 'v4' }, {});
  const bsRow = { platform: bsAfter.platform, client_type: bsAfter.client_type, android_version: null };
  assert.equal(caps.platformFamily(bsRow), 'brightsign');
  // Reboot needs the BrightScript host bridge, and an UNDECLARED unit is exactly the one we cannot
  // know has it — a widget pointed at /player by someone else's tooling has no bridge at all. The
  // point being preserved here is that the row still classifies as brightsign rather than decaying
  // to `web`, which would have handed it the web baseline's screenshot and volume instead.
  assert.equal(caps.supports(bsRow, 'system.reboot'), false, 'the baseline cannot assume a host bridge');
  assert.equal(caps.supports(bsRow, 'remote.screenshot'), false, 'and a canvas cannot read the video plane');
  assert.equal(caps.supports(bsRow, 'playback.video'), true, 'but it certainly plays video');
});

test('a register that DOES declare a platform still updates it', () => {
  // Preserving must not become "the first value wins forever": a genuine change (a panel
  // re-flashed, a row reused for different hardware) has to land.
  const stored = { client_type: 'wgt', client_version: '1.9.29', platform: 'Tizen 6.0', contract_version: 'v4' };
  const i = resolve(stored, { platform: 'Tizen 7.0', client_type: 'wgt', client_version: '2.0', contract_version: 'v4' });
  assert.equal(i.platform, 'Tizen 7.0');
  assert.equal(liveness.identityChanged(stored, i), true, 'and the change is still detected, so it is written');
});

test('a device that never had a platform is not invented one', () => {
  assert.equal(resolve(null, {}).platform, 'unknown', 'still honest about not knowing');
  assert.equal(resolve({ platform: 'unknown' }, {}).platform, 'unknown');
});

test('an unchanged identity still short-circuits the write', () => {
  // The A1 optimisation this function sits inside: a plain reconnect must stay a read with no
  // UPDATE. Preserving the platform must not make every register look like a change.
  const stored = { client_type: 'wgt', client_version: '1.9.29', platform: 'Tizen 6.0', contract_version: 'v4' };
  assert.equal(liveness.identityChanged(stored, resolve(stored, {
    platform: 'Tizen 6.0', client_type: 'wgt', client_version: '1.9.29', contract_version: 'v4',
  })), false);
});

test('client_type wgt is a second, independent signal that this is a Tizen TV', () => {
  // Belt and braces for a row whose platform was already cleared by the old behaviour: the .wgt
  // player sends client_type 'wgt' (tizen/js/app.js), so one lost column is not the end of it.
  const cleared = { platform: 'unknown', client_type: 'wgt', android_version: null };
  assert.equal(caps.platformFamily(cleared), 'tizen');
  assert.equal(caps.supports(cleared, 'audio.volume'), false);
});

test('client_type is preserved too — otherwise the second signal decays with the first', () => {
  // captureIdentity coerces a missing client_type to 'legacy'. Preserving `platform` alone would
  // still leave a panel that reconnects from an older build with NOTHING identifying it.
  const stored = { client_type: 'wgt', client_version: '1.9.29', platform: 'Tizen 6.0', contract_version: 'v4' };
  assert.equal(resolve(stored, {}).client_type, 'wgt');
  assert.equal(resolve({ client_type: 'apk', platform: 'Android 14' }, {}).client_type, 'apk');
});

test('the version fields still decay — a stale build number is not an improvement', () => {
  // The other half of the split: platform/client_type are physical facts, client_version and
  // contract_version are properties of the build currently installed and change with every OTA.
  const stored = { client_type: 'wgt', client_version: '1.9.29', platform: 'Tizen 6.0', contract_version: 'v4' };
  const i = resolve(stored, {});
  assert.equal(i.client_version, 'unknown');
  assert.equal(i.contract_version, 'legacy');
});

test('the Android fleet is untouched by the wgt rule', () => {
  assert.equal(caps.platformFamily({ client_type: 'apk', android_version: '14' }), 'android');
  assert.equal(caps.platformFamily({ android_version: '14' }), 'android');
  assert.equal(caps.platformFamily({ android_version: 'Web/Chrome 120' }), 'web');
  assert.equal(caps.platformFamily({}), 'web');
});
