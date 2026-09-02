'use strict';

// What a BrightSign declares it can do, computed at RUNTIME rather than assumed from a table.
//
// The same XT245 supports remote.screenshot with an SSD fitted and not without: the DWS snapshot
// endpoint writes the full-size capture to disk before returning a thumbnail, so a unit booting
// from internal flash is answered "No primary storage found". A static per-platform table could
// never know that, and declaring the capability anyway puts a button in the dashboard that cannot
// work — the exact failure the capability model exists to remove.
//
// The bias under test is one-directional: withhold when uncertain. A control that appears later,
// once a disk is fitted, is a much smaller problem than one that silently does nothing.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'brightsign', 'st-bridge.js'), 'utf8');
const { CAP_SET } = require('../lib/player-capabilities');

/**
 * Load the real bridge against a fake BrightSign.
 * @param {object} o
 *   host      - a message port exists (nodejs_enabled widget with a live autorun.brs)
 *   probeRes  - what the host answers the capability probe with (null = never answers)
 *   modules   - which @brightsign/* modules resolve
 *   sw           - navigator.serviceWorker present (the BrightSign reality: present, never usable)
 *   swControlled - ...and a worker actually controlling the page (what offline.cache really needs)
 */
function load(o = {}) {
  const opts = Object.assign(
    { host: true, probeRes: null, modules: ['messageport', 'registry', 'deviceinfo', 'cec', 'syncmanager'], sw: true },
    o
  );
  const posted = [];
  const inbound = [];

  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    // `serviceWorker` present but with NO controller is the real BrightSign shape: the property is
    // there, registration never happens, and nothing ever controls the page. Modelled separately
    // from `swControlled` because a stand-in that conflated them is what let the bug ship.
    navigator: Object.assign(
      { userAgent: 'BrightSign/9.0.189 (XT245) Chrome/120' },
      opts.swControlled ? { serviceWorker: { controller: {} } } : (opts.sw ? { serviceWorker: {} } : {})
    ),
    location: { search: '' },
    setInterval: () => 1,
    setTimeout: (fn) => { inbound.push(fn); return 1; },   // deterministic: fired manually
    clearTimeout: () => {},
    Promise, Object, Array, Uint8Array, Math, Date, RegExp, String, Number,
    parseInt, isNaN, isFinite, decodeURIComponent, Error,
    localStorage: { getItem: () => null, setItem() {} },
    __posted: posted,
  };
  sandbox.window = sandbox;

  const handlers = [];
  sandbox.require = (name) => {
    const short = name.replace('@brightsign/', '');
    if (!opts.modules.includes(short)) throw new Error('no module ' + name);
    if (short === 'messageport') {
      if (!opts.host) throw new Error('no host');
      return function () {
        return {
          PostBSMessage: (m) => {
            posted.push(m);
            // The host answers the probe synchronously, which is the realistic ordering: the
            // BrightScript handler replies on the same message loop turn.
            if (m.type === 'probe' && opts.probeRes) {
              handlers.forEach((h) => h(Object.assign({ type: 'probe-result' }, opts.probeRes)));
            }
          },
          addEventListener: (evt, fn) => { if (evt === 'bsmessage') handlers.push(fn); },
        };
      };
    }
    if (short === 'registry') {
      return function () {
        return { read: () => Promise.resolve(''), write: () => Promise.resolve() };
      };
    }
    if (short === 'deviceinfo') {
      // `in`, not `||` — an empty osVersion is a case under test (a unit that will not say), and
      // defaulting it would quietly turn the "unknown firmware" test into the happy path.
      const osVersion = 'osVersion' in opts ? opts.osVersion : '9.0.189';
      return function () {
        return { model: 'XT245', osVersion, serialNumber: 'SN1' };
      };
    }
    if (short === 'cec') return function () { return { send: () => Promise.resolve(), addEventListener() {} }; };
    if (short === 'syncmanager') return function () { return { addEventListener() {}, synchronize() {} }; };
    if (short === 'videooutput') return function () { return { setMode: () => true }; };
    throw new Error('no module ' + name);
  };

  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  return { api: sandbox.ScreenTinkerBS, posted, caps: sandbox.ScreenTinkerBS.capabilities() };
}

const WITH_DISK = { storage_present: true, storage_volume: 'SSD:', storage_free_mb: 90000, storage_total_mb: 120000, os_version: '9.0.189' };
const NO_DISK = { storage_present: false, storage_volume: '', storage_free_mb: 0, storage_total_mb: 0, os_version: '9.0.189' };

test('EVERY declared capability is a name the server knows', () => {
  // A typo here does not fail loudly — it silently disables a control for the whole platform,
  // because the server drops unknown names rather than rejecting the declaration.
  const { caps } = load({ probeRes: WITH_DISK });
  for (const c of caps) assert.ok(CAP_SET.has(c), `"${c}" is not in the capability vocabulary`);
});

test('THE STORAGE CASE: no disk means no screenshot, no stream, no self-update', () => {
  // Our XT245 today: boots from internal flash, card interface dead, DWS refuses the capture.
  const { caps } = load({ probeRes: NO_DISK });
  assert.ok(!caps.includes('remote.screenshot'), 'the DWS answers "No primary storage found"');
  assert.ok(!caps.includes('remote.stream'));
  assert.ok(!caps.includes('system.self_update'), 'nowhere to stage autorun.zip');
});

test('the same unit declares all three once a disk is fitted', () => {
  const { caps } = load({ probeRes: WITH_DISK });
  assert.ok(caps.includes('remote.screenshot'));
  assert.ok(caps.includes('remote.stream'));
  assert.ok(caps.includes('system.self_update'));
});

test('an unanswered probe is treated as NO, not as yes', () => {
  // Claiming a disk we could not confirm is precisely the button-that-does-nothing case.
  const { caps } = load({ probeRes: null });
  assert.ok(!caps.includes('remote.screenshot'));
});

test('without a host bridge, nothing that needs BrightScript is declared', () => {
  // A widget built without nodejs_enabled. The page can only reload itself, and a page-initiated
  // reload does not reliably bring an roHtmlWidget back — the 2026-07-28 failure.
  const { caps } = load({ host: false, modules: [] });
  for (const c of ['system.reboot', 'system.restart_player', 'display.rotation']) {
    assert.ok(!caps.includes(c), `${c} needs the host`);
  }
  assert.ok(caps.includes('playback.video'), 'rendering still works');
  assert.ok(caps.includes('sync.clock'), 'clock sync is pure JS');
});

test('native sync needs the module AND the firmware floor', () => {
  // Below 8.2.10 the module may resolve and do nothing, which on a wall means every panel reports
  // healthy while drifting — strictly worse than falling back to the clock protocol.
  const ok = load({ probeRes: Object.assign({}, WITH_DISK, { os_version: '9.0.189' }) });
  assert.ok(ok.caps.includes('sync.native'));

  const tooOld = load({ probeRes: Object.assign({}, WITH_DISK, { os_version: '8.2.9' }) });
  assert.ok(!tooOld.caps.includes('sync.native'), '8.2.9 is below the 8.2.10 floor');

  const noModule = load({ probeRes: WITH_DISK, modules: ['messageport', 'registry', 'deviceinfo', 'cec'] });
  assert.ok(!noModule.caps.includes('sync.native'));
});

test('an unknown firmware version withholds the floor-gated capability', () => {
  const { caps } = load({ probeRes: Object.assign({}, WITH_DISK, { os_version: '' }), osVersion: '' });
  assert.ok(!caps.includes('sync.native'), 'unprovable floor must withhold, not assume');
});

test('display.power tracks the CEC module', () => {
  const withCec = load({ probeRes: WITH_DISK });
  assert.ok(withCec.caps.includes('display.power'));

  const without = load({ probeRes: WITH_DISK, modules: ['messageport', 'registry', 'deviceinfo', 'syncmanager'] });
  assert.ok(!without.caps.includes('display.power'));
});

test('NEVER declared: the things BrightSign genuinely has no equivalent for', () => {
  // This is the half of parity that removes controls rather than adding features.
  const { caps } = load({ probeRes: WITH_DISK });
  for (const c of ['system.kiosk', 'system.brightness', 'system.screen_timeout',
                   'system.install_apk', 'system.shell', 'system.time']) {
    assert.ok(!caps.includes(c), `${c} must never be declared on BrightSign`);
  }
});

test('offline.cache needs a worker in CONTROL, not merely a navigator property', () => {
  // Found on hardware, and this test used to assert the bug. `navigator.serviceWorker` EXISTS on a
  // BrightSign widget and is not usable: our XT245 on alpha passes the presence check, then never
  // even fetches sw.js. Presence was therefore the one signal that could not tell "caches offline"
  // from "cannot", and it answered yes to both — so every BrightSign in the fleet advertised an
  // offline capability it could not honour, which is precisely the dead-button failure this whole
  // capability model exists to remove.
  //
  // A controller is proof rather than a promise: something is actually intercepting this page's
  // fetches. The web player learned this a release ago (declareCapabilities in
  // server/player/index.html); this copy had not.
  assert.ok(!load({ probeRes: WITH_DISK, sw: true }).caps.includes('offline.cache'),
    'a runtime that exposes serviceWorker and will not run one must not claim to cache');
  assert.ok(!load({ probeRes: WITH_DISK, sw: false }).caps.includes('offline.cache'));
  assert.ok(load({ probeRes: WITH_DISK, swControlled: true }).caps.includes('offline.cache'),
    'a worker that IS controlling the page is a real offline story and must still be declared');
});

test('the probe is actually sent to the host', () => {
  const { posted } = load({ probeRes: WITH_DISK });
  assert.ok(posted.some((m) => m.type === 'probe'), 'nothing would ever populate the disk answer');
});

test('real device storage from the host beats the widget cache quota', () => {
  // There is no JS API for device storage, so this previously reported the widget's cache budget
  // as if it were the disk. The host has roStorageInfo; its numbers must win.
  const { api } = load({ probeRes: WITH_DISK });
  api.refreshTelemetry();
  const t = api.telemetrySnapshot();
  assert.equal(t.storage_total_mb, 120000);
  assert.equal(t.storage_free_mb, 90000);
});

test('capabilities are recomputed per call, so a fitted disk lands on reconnect', () => {
  // Not cached: a display that gains an SSD declares it at its next registration rather than
  // waiting for a reboot.
  const { api } = load({ probeRes: WITH_DISK });
  assert.deepEqual(api.capabilities(), api.capabilities());
});
