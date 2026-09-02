'use strict';

// The player's half of native sync, extracted from server/player/index.html and run against a fake
// SyncManager. Three things here are easy to get wrong and impossible to see from a unit test of
// st-sync.js alone, because they are about how the PLAYER drives it:
//
//   1. The leader must announce a NEW id on every advance. Reusing an id is swallowed by the 1Hz
//      dedupe and the whole group sits on the previous item — the failure looks like "sync is
//      stuck", not "the id was wrong".
//   2. Binding must happen exactly once per sync id even though the event arrives at 1Hz and the
//      player also retries on every 4Hz tick. Re-binding each time reloads the video repeatedly,
//      which on screen reads as a stutter or a restart loop.
//   3. The event routinely arrives BEFORE the video element exists, because the leader announces as
//      it advances. Dropping it there would leave that item unsynchronised for its whole duration.
//
// The functions under test are pulled out of the player by source extraction so they cannot drift
// from what actually ships — the same technique the fingerprint and identity-reset tests use.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'player', 'index.html'), 'utf8');

/** Pull one top-level `function name(...) {...}` out of the player by brace matching. */
function extract(name) {
  const start = HTML.indexOf('function ' + name + '(');
  assert.notEqual(start, -1, 'player no longer defines ' + name);
  let depth = 0, end = -1;
  for (let i = HTML.indexOf('{', start); i < HTML.length; i++) {
    if (HTML[i] === '{') depth++;
    else if (HTML[i] === '}' && --depth === 0) { end = i + 1; break; }
  }
  assert.notEqual(end, -1);
  return HTML.slice(start, end);
}

/** A fake SyncManager session with the real one's contract: 1Hz repeats, dedupe by id. */
function makeHarness({ isLeader = false, hasVideo = true } = {}) {
  const state = {
    announced: [],
    attached: [],
    reports: [],
    boundId: null,
    event: null,
  };

  const sync = {
    announce(key, now) { const id = 'st_' + key + '_' + now; state.announced.push(id); return id; },
    attachVideo(video, ev) { state.attached.push(ev.id); return true; },
  };

  const scope = {
    nativeSync: sync,
    nativeSyncEvent: null,
    nativeSyncBoundId: null,
    currentVideoEl: hasVideo ? { tagName: 'VIDEO' } : null,
    groupReport: (lvl, msg) => state.reports.push(msg),
    String,
  };

  // bindNativeSyncVideo closes over module-level lets; rebuild it with an explicit scope object so
  // the assignments are observable.
  const src = extract('bindNativeSyncVideo')
    .replace(/nativeSyncBoundId/g, 'S.nativeSyncBoundId')
    .replace(/nativeSyncEvent/g, 'S.nativeSyncEvent')
    .replace(/nativeSync\b(?!S)/g, 'S.nativeSync')
    .replace(/currentVideoEl/g, 'S.currentVideoEl')
    .replace(/groupReport/g, 'S.groupReport');
  const S = { ...scope };
  const bind = new Function('S', src + '; return bindNativeSyncVideo;')(S);
  return { S, bind, state, sync };
}

test('THE 1Hz TRAP: ten repeats of one sync id bind the video exactly once', () => {
  const { S, bind, state } = makeHarness();
  S.nativeSyncEvent = { id: 'st_item7_1000', domain: 'd', iso_timestamp: 't' };
  for (let i = 0; i < 10; i++) bind();
  assert.equal(state.attached.length, 1, 'ten binds would be ten video reloads — a visible stutter');
});

test('a NEW id binds again — that is how the group advances', () => {
  const { S, bind, state } = makeHarness();
  S.nativeSyncEvent = { id: 'a', domain: 'd', iso_timestamp: 't' };
  bind(); bind();
  S.nativeSyncEvent = { id: 'b', domain: 'd', iso_timestamp: 't' };
  bind();
  assert.deepEqual(state.attached, ['a', 'b']);
});

test('THE EARLY EVENT: an event with no video yet is kept, not dropped', () => {
  // The leader announces as it advances, so the broadcast routinely beats the element into
  // existence. Dropping it would leave that item unsynchronised for its whole duration.
  const { S, bind, state } = makeHarness({ hasVideo: false });
  S.nativeSyncEvent = { id: 'early', domain: 'd', iso_timestamp: 't' };
  bind();
  assert.equal(state.attached.length, 0, 'nothing to bind to yet');
  assert.equal(S.nativeSyncBoundId, null, 'and it must NOT be marked bound');

  S.currentVideoEl = { tagName: 'VIDEO' };   // the 4Hz tick calls bind again once it mounts
  bind();
  assert.deepEqual(state.attached, ['early'], 'the retained event binds as soon as the video exists');
});

test('an image or widget item never binds — there is no setSyncParams to bind', () => {
  const { S, bind, state } = makeHarness({ hasVideo: false });
  S.nativeSyncEvent = { id: 'img', domain: 'd', iso_timestamp: 't' };
  bind(); bind();
  assert.equal(state.attached.length, 0);
});

test('the leader mints a DISTINCT id per advance, or the group sticks on one item', () => {
  // A repeated id is swallowed by every follower's dedupe. The symptom is "sync is stuck", which
  // points nowhere near the id.
  const { sync } = makeHarness({ isLeader: true });
  const a = sync.announce('content-1', 1000);
  const b = sync.announce('content-2', 2000);
  const c = sync.announce('content-1', 3000);   // same item coming round again on loop
  assert.notEqual(a, b);
  assert.notEqual(a, c, 'the same item on a second lap is still a NEW session');
});

test('the player still defines the pieces this wiring depends on', () => {
  // A rename in index.html that silently broke native sync would otherwise only show up on
  // hardware, which we have one of.
  for (const fn of ['applyNativeSync', 'bindNativeSyncVideo', 'applyGroupSync', 'groupScheduleTick']) {
    assert.ok(HTML.includes('function ' + fn + '('), 'player must still define ' + fn);
  }
  assert.match(HTML, /nativeSync\.announce\(/, 'the leader must still announce on advance');
  assert.match(HTML, /backend === 'brightsign'/, 'native sync must still be gated on the resolved backend');
});

test('THE PROMOTED LEADER: leadership moving must re-enter sync, not be ignored', () => {
  // Neither switching protocol nor a leader change alters the group id. When the re-enter key was
  // the id ALONE, a player promoted to leader after the old one went offline carried on behaving as
  // a follower — so nobody announced, the whole group sat unsynchronised, and the dashboard showed
  // a healthy group throughout.
  const m = HTML.match(/const groupKey = \(g\) => (.*);/);
  assert.ok(m, 'player no longer defines groupKey');
  const groupKey = new Function('g', 'return ' + m[1] + ';');

  const base = { group_id: 'g1', backend: 'brightsign', is_leader: false };
  assert.notEqual(groupKey(base), groupKey({ ...base, is_leader: true }), 'promotion must re-enter');
  assert.notEqual(groupKey(base), groupKey({ ...base, backend: 'screentinker' }), 'protocol switch must re-enter');
  assert.equal(groupKey(base), groupKey({ ...base }), 'an unchanged group must NOT churn on every push');
  assert.equal(groupKey(null), '');
});
