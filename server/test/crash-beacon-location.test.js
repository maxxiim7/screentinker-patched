'use strict';

// A crash message with no location is not actionable. Three production players died with
// "Cannot set properties of null (setting 'textContent')" and it could not be traced: the
// message names no file, and every candidate line in the current player was ruled out by
// inspection — which points at an older cached build still served by the service worker,
// exactly the case where reading current source proves nothing.
//
// The ErrorEvent already carries filename/lineno/colno. It was being discarded. This pins that
// the location is kept, that it stays inside the 200 characters the server will store
// (lib/liveness.sanitizeExitReason truncates), and that the two cases which genuinely have no
// location — a cross-origin "Script error." and a promise rejection — say so or fall back to a
// stack frame, rather than reporting :0:0 as if it were an answer.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { sanitizeExitReason } = require('../lib/liveness');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'player', 'index.html'), 'utf8');

// Lift the real helper out of the player so this tests shipped code, not a paraphrase.
function loadCrashDetail() {
  const start = HTML.indexOf('function crashDetail(');
  assert.notEqual(start, -1, 'crashDetail() should exist in the player');
  let depth = 0;
  for (let j = HTML.indexOf('{', start); j < HTML.length; j++) {
    if (HTML[j] === '{') depth++;
    else if (HTML[j] === '}' && --depth === 0) {
      return new Function(`${HTML.slice(start, j + 1)} return crashDetail;`)();
    }
  }
  throw new Error('unbalanced braces');
}
const crashDetail = loadCrashDetail();

test('THE POINT: the crash location survives instead of being discarded', () => {
  const d = crashDetail("Cannot set properties of null (setting 'textContent')",
    'https://screentinker.com/player/index.html', 3087, 41);
  assert.match(d, /index\.html:3087:41/, 'file, line and column are all kept');
  assert.match(d, /textContent/, 'and the message is still there');
});

test('only the basename is sent — the origin is already known from the device', () => {
  const d = crashDetail('boom', 'https://screentinker.com/player/transitions.js', 12, 3);
  assert.match(d, /transitions\.js:12:3/);
  assert.doesNotMatch(d, /screentinker\.com/, 'no redundant origin eating the character budget');
});

test('a cache-busted asset URL does not smuggle a query string in', () => {
  const d = crashDetail('boom', '/player/transitions.js?v=3', 9, 1);
  assert.match(d, /transitions\.js:9:1/);
  assert.doesNotMatch(d, /\?v=3/);
});

test('it fits what the server will actually store', () => {
  const long = 'x'.repeat(400);
  const d = crashDetail(long, '/player/index.html', 1, 1);
  assert.ok(d.length <= 200, 'composed within the limit rather than truncated blindly');
  const stored = sanitizeExitReason('crashed', d);
  assert.equal(stored.detail, d, 'survives the server sanitiser unchanged');
});

test('a real location is never faked when there is none', () => {
  const d = crashDetail('Script error. (no location — cross-origin script)');
  assert.doesNotMatch(d, /:\d+:\d+/, 'no :0:0 masquerading as a location');
  assert.match(d, /cross-origin/, 'says why instead');
});

test('a missing line/column still yields a usable file name', () => {
  const d = crashDetail('boom', '/player/index.html');
  assert.match(d, /index\.html:0:0/, 'the file alone is still worth having');
});

// The player installs TWO window 'error' listeners — an early boot logger and, later, the
// crash beacon. Anchor past crashDetail() so these assertions target the beacon; anchoring on
// the first match reads the boot logger and proves nothing about the beacon.
const BEACON = HTML.slice(HTML.indexOf('function crashDetail('));
const beaconErrorHandler = BEACON.slice(
  BEACON.indexOf("window.addEventListener('error'"),
  BEACON.indexOf("window.addEventListener('unhandledrejection'"));
const beaconRejectionHandler = BEACON.slice(BEACON.indexOf("window.addEventListener('unhandledrejection'"));

test('the handlers are wired to it, not just the helper existing', () => {
  assert.ok(beaconErrorHandler.length > 0 && beaconErrorHandler.length < 2000, 'located the beacon handler');
  assert.match(beaconErrorHandler, /ev\.filename/, 'the error handler reads filename');
  assert.match(beaconErrorHandler, /ev\.lineno/, 'and lineno');
  assert.match(beaconErrorHandler, /ev\.colno/, 'and colno');
  assert.match(beaconErrorHandler, /crashDetail\(/, 'and composes through the helper');
  assert.match(beaconRejectionHandler.slice(0, 900), /\.stack/,
    'the rejection handler falls back to a stack frame, having no filename of its own');
});

test('a resource load failure is still not a crash', () => {
  // Guarding pre-existing behaviour: an <img> that 404s must not report the player dead.
  assert.match(beaconErrorHandler, /isResourceError/);
  assert.match(beaconErrorHandler, /if \(isResourceError\) return;/);
});
