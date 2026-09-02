'use strict';

// A player declares what it can do; the dashboard hides the controls it cannot honour.
//
// The failure this guards is the one that would hit hardest: several hundred displays are already
// in the field and declare NOTHING. If an absent declaration were persisted as "supports nothing"
// they would all lose their controls the moment this shipped. So absent must leave the column NULL
// (baseline applies) while an EMPTY declaration is stored as '[]' and honoured — a real statement
// from, say, a BrightSign widget with no host bridge.
//
// Those two cases differ by one character in the payload and by an entire dashboard in effect.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const caps = require('../lib/player-capabilities');

// The exact filter the socket handler applies before writing.
const persistedValue = (raw) => {
  const declared = caps.parseDeclared(raw);
  return declared === null ? null : JSON.stringify(declared);
};

test('THE FLEET CASE: an absent declaration is not persisted, so the baseline still applies', () => {
  assert.equal(persistedValue(undefined), null);
  assert.equal(persistedValue(null), null);
  const legacy = { client_type: 'apk' };            // column stays NULL
  // Was system.reboot until the parity audit: STPolicy.reboot() needs device owner, so the
  // undeclared fleet never had that one. restart_player is a control it genuinely does have.
  assert.ok(caps.supports(legacy, 'system.restart_player'), 'legacy Android keeps its controls');
});

test('an EMPTY declaration IS persisted and is honoured as "nothing"', () => {
  assert.equal(persistedValue([]), '[]');
  assert.deepEqual(caps.capabilitiesFor({ client_type: 'apk', capabilities: '[]' }), []);
});

test('a hostile or malformed declaration never reaches the dashboard', () => {
  // Not persisted at all -> the device keeps its baseline rather than gaining anything.
  for (const bad of ['not json', '{"a":1}', 42, '  ']) assert.equal(persistedValue(bad), null);
});

test('unknown capability names are dropped, known ones survive', () => {
  // A newer player declaring something this server has never heard of must not lose the rest.
  assert.equal(persistedValue(['playback.video', 'quantum.teleport']), '["playback.video"]');
});

test('a stored declaration overrides the baseline in both directions', () => {
  const stripped = { client_type: 'apk', capabilities: persistedValue(['playback.video']) };
  assert.equal(caps.supports(stripped, 'system.reboot'), false, 'declared set wins over baseline');

  const hosted = { platform: 'brightsign', capabilities: persistedValue(['system.reboot', 'sync.native']) };
  assert.ok(caps.supports(hosted, 'sync.native'), 'a BrightSign with SyncManager can declare it');
});

test('the round trip is stable — persisted output re-parses to the same set', () => {
  const declared = ['playback.video', 'audio.mute', 'system.reboot'];
  const stored = persistedValue(declared);
  assert.deepEqual(caps.capabilitiesFor({ capabilities: stored }), declared);
});
