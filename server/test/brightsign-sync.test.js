'use strict';

// BrightSign's SyncManager is frame-accurate but it has one property that turns a correct-looking
// integration into a visible fault: synchronize() REPEATS AT 1Hz, so a player powered on late can
// still join the session. Acting on every repeat reloads the video once a second, forever — on
// screen that reads as a stutter or a restart loop, not as a sync bug, which is exactly the kind of
// thing that gets misdiagnosed for days. Both cookbook examples carry the same warning comment.
//
// The other half is the leader. Ours is leaderless; this protocol is not. The leader receives its
// OWN broadcast and starts from it, which is what stops it running ahead of its followers by the
// width of the network — so "leader ignores its own event" would be a subtle desync, not a
// harmless optimisation.
//
// Run against a fake @brightsign/syncmanager, so the protocol contract is checked without hardware.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'brightsign', 'st-sync.js'), 'utf8');

function load({ withModule = true } = {}) {
  const instances = [];

  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    Date,
    String,
    __instances: instances,
  };
  sandbox.window = sandbox;

  if (withModule) {
    sandbox.require = (name) => {
      if (name !== '@brightsign/syncmanager') throw new Error('no such module ' + name);
      return function (iface, domain, addr, port) {
        const self = {
          args: { iface, domain, addr, port },
          leader: undefined,
          encrypted: undefined,
          listeners: {},
          announced: [],
          closed: false,
          addEventListener(evt, fn) { (self.listeners[evt] = self.listeners[evt] || []).push(fn); },
          synchronize(id, msDelay) { self.announced.push({ id, msDelay }); },
          close() { self.closed = true; },
          // test helper: deliver a multicast event to this member
          emit(e) { (self.listeners.syncevent || []).forEach((fn) => fn(e)); },
        };
        instances.push(self);
        return self;
      };
    };
  }

  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  return { api: sandbox.ScreenTinkerBSSync, instances };
}

/** A fake BrightSign <video> — the real one gains setSyncParams from the platform. */
function fakeVideo() {
  return {
    params: null, loaded: 0, played: 0,
    setSyncParams(domain, id, ts) { this.params = { domain, id, ts }; },
    load() { this.loaded++; },
    play() { this.played++; return Promise.resolve(); },
  };
}

test('without the module it reports unavailable and start() fails cleanly', () => {
  const { api } = load({ withModule: false });
  assert.equal(api.available(), false);
  const s = api.create();
  assert.equal(s.available(), false);
  assert.equal(s.start(true), false, 'the caller must be able to fall back to our own sync');
  assert.equal(s.announce('item1'), false);
  assert.doesNotThrow(() => s.stop());
});

test('constructor is given interface, domain, multicast address and port', () => {
  const { api, instances } = load();
  const s = api.create({ domain: 'Wall1', multicastPort: 1600 });
  assert.equal(s.start(false), true);
  assert.equal(instances.length, 1);
  assert.equal(instances[0].args.domain, 'Wall1');
  assert.equal(instances[0].args.port, 1600);
  assert.equal(instances[0].args.addr, '224.0.126.10', 'the documented default');
});

test('only the leader sets .leader — followers omit it, as the examples do', () => {
  const { api, instances } = load();
  api.create().start(true);
  assert.equal(instances[0].leader, true);

  const { api: api2, instances: inst2 } = load();
  api2.create().start(false);
  assert.equal(inst2[0].leader, undefined, 'a follower must not claim leadership');
});

test('THE TRAP: the 1Hz repeat of one id fires the handler exactly once', () => {
  const { api, instances } = load();
  const s = api.create();
  s.start(false);
  let fired = 0;
  s.onItem = () => { fired++; };

  const e = { domain: 'ScreenTinkerSync', id: 'st_item7_123', iso_timestamp: '2026-08-04T21:00:00Z' };
  for (let i = 0; i < 10; i++) instances[0].emit(e);   // ten seconds of rebroadcast

  assert.equal(fired, 1, 'ten repeats must not be ten video reloads');
});

test('a NEW id does fire again — that is how the group advances', () => {
  const { api, instances } = load();
  const s = api.create();
  s.start(false);
  const seen = [];
  s.onItem = (e) => seen.push(e.id);

  instances[0].emit({ domain: 'd', id: 'item-1', iso_timestamp: 't1' });
  instances[0].emit({ domain: 'd', id: 'item-1', iso_timestamp: 't1' });
  instances[0].emit({ domain: 'd', id: 'item-2', iso_timestamp: 't2' });

  assert.deepEqual(seen, ['item-1', 'item-2']);
});

test('THE LEADER STARTS FROM ITS OWN BROADCAST, not from announce()', () => {
  // If the leader began playing at announce() time it would run ahead of every follower by the
  // network delay. It must wait for the event to come back to it, like everyone else.
  const { api, instances } = load();
  const s = api.create();
  s.start(true);
  let fired = 0;
  s.onItem = () => { fired++; };

  const id = s.announce('item1', 1000);
  assert.ok(id, 'announce returns the id it minted');
  assert.equal(fired, 0, 'announcing alone must not start playback');

  instances[0].emit({ domain: 'd', id, iso_timestamp: 'ts' });
  assert.equal(fired, 1, 'the leader plays when its own event arrives');
});

test('announce() mints a distinct id per item so the dedupe never swallows an advance', () => {
  const { api, instances } = load();
  const s = api.create();
  s.start(true);
  const a = s.announce('item1', 1000);
  const b = s.announce('item1', 2000);   // same item, later — e.g. a loop back round
  assert.notEqual(a, b, 'a repeated id would leave the group stuck on the previous item');
  assert.equal(instances[0].announced.length, 2);
  assert.equal(instances[0].announced[0].msDelay, 1000, 'prepare time is passed through');
});

test('a follower cannot announce — only the leader broadcasts', () => {
  const { api, instances } = load();
  const s = api.create();
  s.start(false);
  assert.equal(s.announce('item1'), false);
  assert.equal(instances[0].announced.length, 0);
});

test('attachVideo sets the sync params from the event, then loads and plays', () => {
  const { api, instances } = load();
  const s = api.create();
  s.start(false);
  const v = fakeVideo();
  s.onItem = (e) => s.attachVideo(v, e);

  instances[0].emit({ domain: 'ScreenTinkerSync', id: 'x1', iso_timestamp: '2026-08-04T21:00:00Z' });

  assert.deepEqual(v.params, { domain: 'ScreenTinkerSync', id: 'x1', ts: '2026-08-04T21:00:00Z' });
  assert.equal(v.loaded, 1);
  assert.equal(v.played, 1);
});

test('a plain <video> without setSyncParams is refused rather than half-synced', () => {
  const { api, instances } = load();
  const s = api.create();
  s.start(false);
  instances[0].emit({ domain: 'd', id: 'x', iso_timestamp: 't' });
  const plain = { load() {}, play() {} };   // an ordinary browser video element
  assert.equal(s.attachVideo(plain), false);
});

test('stop() closes the session and clears the dedupe so a restart re-syncs', () => {
  const { api, instances } = load();
  const s = api.create();
  s.start(false);
  instances[0].emit({ domain: 'd', id: 'x', iso_timestamp: 't' });
  s.stop();
  assert.equal(instances[0].closed, true);

  // Same id after a restart must be honoured — it is a new session from this member's view.
  s.start(false);
  let fired = 0;
  s.onItem = () => { fired++; };
  instances[1].emit({ domain: 'd', id: 'x', iso_timestamp: 't' });
  assert.equal(fired, 1);
});

test('a throwing handler does not kill the session', () => {
  const { api, instances } = load();
  const s = api.create();
  s.start(false);
  s.onItem = () => { throw new Error('boom'); };
  assert.doesNotThrow(() => instances[0].emit({ domain: 'd', id: 'a', iso_timestamp: 't' }));

  let ok = 0;
  s.onItem = () => { ok++; };
  instances[0].emit({ domain: 'd', id: 'b', iso_timestamp: 't' });
  assert.equal(ok, 1, 'the next item still plays');
});
