'use strict';

// Muting a playlist item was implemented three times and agreed nowhere.
//
// A `<video>` honoured the per-item mute flag. A YouTube item did not — it is a cross-origin
// iframe, so setting `el.muted` reaches nothing, and the web player never consulted the flag when
// building the embed. An item an operator deliberately silenced in the admin console therefore
// played WITH SOUND. Tizen failed the opposite way: it hardcoded `mute=1` into the embed URL, so
// YouTube there was permanently silent and could not be unmuted by anything.
//
// Neither failure is visible from a dashboard. You find out when a shop floor gets audio it should
// not have, or when a customer says the sound never works.
//
// The ORDER of these rules is the substance, so each precedence step is pinned separately.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveMuted, shouldOfferUnmute } = require('../lib/media-mute');

const base = { wallFollower: false, remoteMuted: null, itemMuted: false, userGesture: true };

test('THE BUG: an item flagged muted is silent — including a YouTube embed', () => {
  assert.equal(resolveMuted({ ...base, itemMuted: true }), true);
});

test('an unflagged item with a gesture plays audio', () => {
  assert.equal(resolveMuted(base), false);
});

test('a wall follower is ALWAYS silent — one wall, one audio source', () => {
  // Otherwise a room gets the same track from six panels a few milliseconds apart.
  assert.equal(resolveMuted({ ...base, wallFollower: true }), true);
  assert.equal(resolveMuted({ ...base, wallFollower: true, itemMuted: false, remoteMuted: false }), true,
    'not even an explicit operator unmute may break a wall');
});

test('autoplay policy outranks an operator unmute, because it is not a preference', () => {
  // Unmuted playback without a gesture is REFUSED by the browser: asking for it loses the video,
  // not just the audio. So it can never be granted, however it was requested.
  assert.equal(resolveMuted({ ...base, userGesture: false, remoteMuted: false }), true);
  assert.equal(resolveMuted({ ...base, userGesture: false, itemMuted: false }), true);
});

test('a live operator toggle outranks the item setting — they are looking at the screen', () => {
  assert.equal(resolveMuted({ ...base, itemMuted: true, remoteMuted: false }), false, 'unmute a muted item');
  assert.equal(resolveMuted({ ...base, itemMuted: false, remoteMuted: true }), true, 'mute an unmuted item');
});

test('remoteMuted null means "not set" and defers to the item, rather than reading as false', () => {
  assert.equal(resolveMuted({ ...base, itemMuted: true, remoteMuted: null }), true);
  assert.equal(resolveMuted({ ...base, itemMuted: true, remoteMuted: undefined }), true);
});

test('a missing or empty state is silent rather than blaring', () => {
  // Called before config exists, or with a half-built item: silence is the safe failure.
  assert.equal(resolveMuted(undefined), true);
  assert.equal(resolveMuted({}), true);
});

// ---------------------------------------------------------------- the unmute prompt

test('the unmute prompt appears only when a gesture is the ONLY thing in the way', () => {
  assert.equal(shouldOfferUnmute({ ...base, userGesture: false }), true);
});

test('THE TRAP: no prompt on an item an operator deliberately muted', () => {
  // Otherwise the prompt trains viewers to click a button that un-mutes something silenced on
  // purpose — worse than never offering it.
  assert.equal(shouldOfferUnmute({ ...base, userGesture: false, itemMuted: true }), false);
  assert.equal(shouldOfferUnmute({ ...base, userGesture: false, remoteMuted: true }), false);
});

test('no prompt on a wall follower — audio there is not the viewer to grant', () => {
  assert.equal(shouldOfferUnmute({ ...base, userGesture: false, wallFollower: true }), false);
});

test('no prompt once audio is already unlocked', () => {
  assert.equal(shouldOfferUnmute(base), false);
});
