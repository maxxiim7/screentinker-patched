'use strict';

// st-bridge.js is loaded by EVERY player, not just BrightSigns, because gating it on a user agent
// would mean a panel reporting an unexpected UA silently loses restart-instead-of-reload — the one
// thing it most needs. That makes its behaviour in a plain browser a correctness requirement, not a
// nicety: it must not throw, must report isBrightSign() false, and must tell the caller it could NOT
// take a restart so the player falls back to location.reload() instead of doing nothing.
//
// The other half is the dual-output collision. autorun.brs gives the second HDMI output its own
// widget, and both widgets share an origin, a registry and one SD storage_path. Un-namespaced keys
// would have output 2 read output 1's identity, and the two would collapse into a single device row
// — the same duplicate-row failure the hardware-only fingerprint once caused, in reverse.
//
// Run in a vm with a fake global rather than a browser, so the contract is checked without hardware.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'brightsign', 'st-bridge.js'), 'utf8');

/** Load the bridge into a fake window. `mods` present => pretend we are on a BrightSign. */
function load({ search = '', mods = null, ua = 'Mozilla/5.0 Chrome/150', seed = {}, storageEstimate = null, temperature = null, os = null, fs = null, edid = null, activeMode = null } = {}) {
  const posted = [];
  const registryStore = new Map(Object.entries(seed));
  const cec = { sent: [] };
  const cecConnectors = [];

  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    // navigator.storage.estimate() is a REAL browser API the bridge reads for the cache quota,
    // and it is async — modelled as such so a synchronous stand-in cannot hide a pending-Promise
    // bug the way one previously did for the registry.
    navigator: {
      userAgent: ua,
      storage: storageEstimate ? { estimate: () => Promise.resolve(storageEstimate) } : undefined,
    },
    location: { search, reload() { sandbox.__reloaded = true; } },
    setInterval: () => 1,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (t) => clearTimeout(t),
    Error,
    Promise,
    Object,
    Array,
    Uint8Array,
    Number,
    isFinite,
    Math,
    Date,
    RegExp,
    parseInt,
    isNaN,
    String,
    decodeURIComponent,
    __reloaded: false,
    __posted: posted,
    __registry: registryStore,
    localStorage: { getItem: () => null, setItem() {} },
  };
  sandbox.__inbound = [];
  sandbox.__deliver = (msg) => sandbox.__inbound.forEach((fn) => fn(msg));
  sandbox.window = sandbox;

  if (mods) {
    sandbox.require = (name) => {
      // Node's standard library, present because the widget runs with nodejs_enabled.
      // Not an @brightsign module, so it is answered before the platform ones.
      if (name === 'os') { if (!os) throw new Error("Cannot find module 'os'"); return os; }
      if (name === 'fs') { if (!fs) throw new Error("Cannot find module 'fs'"); return fs; }
      // The attached panel's EDID, per OUTPUT. `edid` maps an output name to a monitor name;
      // anything not in it behaves like a real player asked for an output it does not have —
      // "hdmi2" throws from the constructor, "HDMI-2" rejects. Both observed on an XT245.
      if (name === '@brightsign/videooutput') {
        if (!edid) throw new Error('no videooutput');
        return function (outputName) {
          if (!(outputName in edid)) {
            if (/^hdmi\d/.test(outputName)) throw new Error('no such output');
            return { getEdidIdentity: () => Promise.reject(new Error('Output not connected')) };
          }
          return { getEdidIdentity: () => Promise.resolve({ monitorName: edid[outputName] }) };
        };
      }
      if (name === '@brightsign/videomodeconfiguration') {
        if (!activeMode) throw new Error('no videomodeconfiguration');
        return function () { return { getActiveMode: () => Promise.resolve(activeMode) }; };
      }
      if (name === '@brightsign/messageport') {
        return function () {
          return {
            PostBSMessage: (o) => posted.push(o),
            // Keep the handler so a test can deliver an inbound message, which is how the host
            // answers a snapshot request.
            addEventListener: (evt, fn) => { if (evt === 'bsmessage') sandbox.__inbound.push(fn); },
          };
        };
      }
      if (name === '@brightsign/registry') {
        // The real API is async and section-oriented:
        //   read(section, key) -> Promise<string>;  write(section, {k: v}) -> Promise
        // Modelling that exactly is the point of this fake — a synchronous stand-in would have
        // hidden the bug where the bridge cached a Promise object as the device id.
        return function () {
          return {
            read: (section, k) => Promise.resolve(registryStore.get(section + ':' + k)),
            write: (section, values) => {
              Object.keys(values).forEach((k) => registryStore.set(section + ':' + k, values[k]));
              return Promise.resolve();
            },
          };
        };
      }
      if (name === '@brightsign/cec') {
        return function (connector) {
          cecConnectors.push(connector);
          return { send: (bytes) => { cec.sent.push(Array.from(bytes)); return Promise.resolve(); },
                   addEventListener: () => {} };
        };
      }
      if (name === '@brightsign/deviceinfo') {
        return function () {
          return {
            model: 'XT1145', osVersion: '9.1.92.2', serialNumber: 'SN-TEST-1',
            // getTemperature() resolves a PROMISE on real hardware. Modelled async on purpose.
            getTemperature: () => (temperature == null
              ? Promise.reject(new Error('no sensor'))
              : Promise.resolve({ celsius: temperature })),
          };
        };
      }
      throw new Error('no such module ' + name);
    };
  }

  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  const api = sandbox.ScreenTinkerBS;
  // onReady always fires, so this resolves off-platform too.
  const ready = new Promise((resolve) => api.onReady(resolve));
  return { api, sandbox, posted, registryStore, ready, cec, cecConnectors };
}

test('in a plain browser it loads without throwing and reports not-BrightSign', () => {
  const { api } = load();
  assert.equal(api.isBrightSign(), false);
  assert.equal(api.hasHost(), false);
});

test('THE FALLBACK: with no host, restart() returns false so the player can reload instead', () => {
  const { api } = load();
  // Returning false is the whole contract — the player checks it and calls location.reload().
  assert.equal(api.restart('deploy'), false);
});

test('off-platform accessors return null/defaults rather than throwing', () => {
  const { api } = load();
  assert.equal(api.serial(), null);
  assert.equal(api.model(), null);
  assert.equal(api.osVersion(), null);
  assert.equal(api.screen(), 1);
  assert.equal(api.storageSuffix(), '');
  assert.equal(api.setVideoMode({ width: 1920 }), false);
  assert.doesNotThrow(() => api.onHostMessage(null));
});

test('a BrightSign UA alone is enough to identify the platform', () => {
  // A widget built without nodejs_enabled resolves no modules, but the player still needs to know.
  const { api } = load({ ua: 'BrightSign/9.1.92.2 (HD1026) Chrome/120.0.6099.225' });
  assert.equal(api.isBrightSign(), true);
  assert.equal(api.hasHost(), false, 'no modules means no host to take a restart');
});

test('with the host present, restart() posts to BrightScript and reports success', () => {
  const { api, posted } = load({ mods: true });
  assert.equal(api.hasHost(), true);
  assert.equal(api.restart('server code updated'), true);
  const msg = posted.find((m) => m.type === 'restart');
  assert.ok(msg, 'the host must actually receive it');
  assert.equal(msg.reason, 'server code updated');
});

test('identity round-trips through the registry', () => {
  const { api } = load({ mods: true });
  api.setIdentity('dev-123', 'https://screentinker.com');
  assert.equal(api.deviceId(), 'dev-123');
});

test('THE RESET: clearIdentity makes the registry forget, so a reset really resets', () => {
  const { api, posted } = load({ mods: true });
  api.setIdentity('dev-123', null);
  api.clearIdentity();
  assert.equal(api.deviceId(), null, 'otherwise the next boot re-adopts the same display');
  assert.ok(posted.some((m) => m.type === 'identity' && m.clear === true));
});

test('THE COLLISION: output 2 namespaces its registry key and storage away from output 1', () => {
  const one = load({ mods: true, search: '?screen=1' });
  const two = load({ mods: true, search: '?screen=2' });

  assert.equal(one.api.screen(), 1);
  assert.equal(two.api.screen(), 2);
  assert.equal(one.api.storageSuffix(), '', 'screen 1 must keep the bare keys — existing panels');
  assert.equal(two.api.storageSuffix(), '_s2');

  one.api.setIdentity('display-A', null);
  two.api.setIdentity('display-B', null);
  assert.equal(one.api.deviceId(), 'display-A');
  assert.equal(two.api.deviceId(), 'display-B', 'two outputs must not collapse into one device row');

  // and the underlying keys really are distinct
  assert.deepEqual(
    [...one.registryStore.keys()].sort(),
    ['screentinker:device_id']
  );
  assert.deepEqual(
    [...two.registryStore.keys()].sort(),
    ['screentinker:device_id_s2']
  );
});

test('deviceinfo supplies identity, with the URL as the fallback before modules resolve', () => {
  const withMods = load({ mods: true });
  assert.equal(withMods.api.serial(), 'SN-TEST-1');
  assert.equal(withMods.api.model(), 'XT1145');

  const urlOnly = load({ search: '?serial=SN-URL&model=XC2055', ua: 'BrightSign/9 Chrome/120' });
  assert.equal(urlOnly.api.serial(), 'SN-URL');
  assert.equal(urlOnly.api.model(), 'XC2055');
});

test('sync backend comes from the URL, else the registry, else auto', () => {
  assert.equal(load({ mods: true }).api.syncBackend(), 'auto');
  assert.equal(load({ mods: true, search: '?sync_backend=brightsign' }).api.syncBackend(), 'brightsign');

  const persisted = load({ mods: true });
  persisted.api.setSyncBackend('screentinker');
  assert.equal(persisted.api.syncBackend(), 'screentinker', 'a cold boot with no network still starts right');
});

test('THE ASYNC TRAP: a Promise from registry.read is never cached as the device id', async () => {
  // registry.read() resolves a Promise. Treating it as a value would make deviceId() return the
  // Promise object itself — truthy, non-empty — and the player would register a display called
  // "[object Promise]" while its real row sat unclaimed.
  const { api, ready } = load({ mods: true, seed: { 'screentinker:device_id': 'existing-id' } });
  await ready;
  assert.equal(typeof api.deviceId(), 'string');
  assert.equal(api.deviceId(), 'existing-id', 'a provisioned panel must come back as itself');
});

test('a panel with nothing in the registry becomes ready with no identity, not a stuck one', async () => {
  const { api, ready } = load({ mods: true });
  await ready;
  assert.equal(api.isReady(), true);
  assert.equal(api.deviceId(), null);
});

test('onReady fires off-platform too, so a browser never blocks on hardware that is absent', async () => {
  const { api, ready } = load();
  await ready;
  assert.equal(api.isReady(), true);
});

test('a rejected registry read still lets the player boot', async () => {
  const { api, ready } = load({ mods: true });
  // The fake resolves; what matters is that readiness is reached and nothing throws.
  await ready;
  assert.doesNotThrow(() => api.deviceId());
});

test('THE DUPLICATE-ROW BUG: the token is persisted alongside the id', async () => {
  // Persisting device_id alone looked correct and still spawned a new device row on every boot:
  // the server authenticates a claim to an existing display with the TOKEN, so an id presented
  // without one reads as a brand-new display. Found on an XT245, not in a test — hence this one.
  const { api, ready } = load({ mods: true });
  await ready;
  api.setIdentity('dev-9', 'https://alpha.screentinker.com', 'tok-abc123');
  assert.equal(api.deviceId(), 'dev-9');
  assert.equal(api.deviceToken(), 'tok-abc123', 'without this the display re-pairs every boot');
});

test('an id with no token is still stored — it is better than nothing', async () => {
  // An unpaired display has no token yet; the server issues one at pairing. Storing the id alone
  // must not throw or wipe anything.
  const { api, ready } = load({ mods: true });
  await ready;
  api.setIdentity('dev-10', null, null);
  assert.equal(api.deviceId(), 'dev-10');
  assert.equal(api.deviceToken(), null);
});

test('clearIdentity forgets the token too, or the reset leaks a credential', async () => {
  const { api, ready } = load({ mods: true });
  await ready;
  api.setIdentity('dev-11', null, 'tok-xyz');
  api.clearIdentity();
  assert.equal(api.deviceId(), null);
  assert.equal(api.deviceToken(), null, 'a stale token must not outlive the identity it belongs to');
});

test('displayPower sends the CEC power codes, not just a black overlay', async () => {
  // The overlay only paints the screen black — the panel stays lit, drawing power and at risk of
  // burn-in. This is the difference between a signage player and a browser tab.
  const { api, ready, cec } = load({ mods: true });
  await ready;
  assert.equal(api.displayPower(true), true);
  assert.deepEqual(cec.sent.at(-1), [0x4f, 0x0d], 'Image View On');
  assert.equal(api.displayPower(false), true);
  assert.deepEqual(cec.sent.at(-1), [0x4f, 0x36], 'Standby');
});

test('displayPower reports false with no CEC, so the caller still draws the overlay', async () => {
  const { api, ready } = load();   // plain browser
  await ready;
  assert.equal(api.displayPower(false), false);
});

test('output 2 addresses HDMI-2 — a dual-output player must sleep the screen it paints', async () => {
  const { api, ready, cecConnectors } = load({ mods: true, search: '?screen=2' });
  await ready;
  api.displayPower(true);
  assert.deepEqual(cecConnectors, ['HDMI-2']);
});

// --- telemetry ------------------------------------------------------------------------------
//
// The heartbeat builds its payload SYNCHRONOUSLY every 15s, but the only real number this platform
// exposes — temperature — arrives from a Promise. Awaiting it in the beat would either block the
// beat or serialise a pending Promise into the telemetry object, which is precisely how device_id
// once became "[object Promise]". Hence a cache the beat reads synchronously.

const settle = () => new Promise((r) => setTimeout(r, 10));

test('the snapshot is EMPTY off-platform, so a browser spreads nothing over its telemetry', async () => {
  const { api, ready } = load();
  await ready;
  // Keys, not deepEqual: the object is built inside the vm realm, so a strict structural compare
  // trips on prototype identity rather than on anything about the value.
  assert.equal(Object.keys(api.telemetrySnapshot()).length, 0,
    'nulls here would clobber another family’s values');
});

test('temperature is cached from the promise, never the promise itself', async () => {
  const { api, ready } = load({ mods: true, temperature: 47.26 });
  await ready;
  api.refreshTelemetry();
  await settle();
  const snap = api.telemetrySnapshot();
  assert.equal(typeof snap.temperature_c, 'number', 'a pending Promise here is the bug this guards');
  assert.equal(snap.temperature_c, 47.3, 'rounded to one decimal');
});

test('a model with no temperature sensor reports nothing rather than a bogus reading', async () => {
  const { api, ready } = load({ mods: true, temperature: null });   // getTemperature() rejects
  await ready;
  api.refreshTelemetry();
  await settle();
  assert.equal(api.telemetrySnapshot().temperature_c, undefined);
});

test('storage quota becomes free/total MB', async () => {
  const { api, ready } = load({ mods: true, storageEstimate: { quota: 1073741824, usage: 268435456 } });
  await ready;
  api.refreshTelemetry();
  await settle();
  const snap = api.telemetrySnapshot();
  assert.equal(snap.storage_total_mb, 1024);
  assert.equal(snap.storage_free_mb, 768);
});

test('one failing source does not take the other down with it', async () => {
  // No sensor, but storage is readable: the snapshot must still carry the storage figures.
  const { api, ready } = load({ mods: true, temperature: null, storageEstimate: { quota: 2147483648, usage: 0 } });
  await ready;
  api.refreshTelemetry();
  await settle();
  const snap = api.telemetrySnapshot();
  assert.equal(snap.temperature_c, undefined);
  assert.equal(snap.storage_total_mb, 2048);
});

test('refreshTelemetry never throws when the platform offers neither source', async () => {
  const { api, ready } = load();   // plain browser: no modules, no storage manager
  await ready;
  assert.doesNotThrow(() => api.refreshTelemetry());
});

test('requestSnapshot asks the host and resolves with the captured image', async () => {
  // An in-page canvas cannot read the hardware plane, so the only capture that includes video is
  // the host's — via the player's own DWS against the real framebuffer.
  const { api, ready, posted, sandbox } = load({ mods: true });
  await ready;
  const p = api.requestSnapshot({ width: 320, height: 180 });
  const req = posted.find((m) => m.type === 'snapshot');
  assert.ok(req, 'the host must actually be asked');
  assert.equal(req.width, 320);
  sandbox.__deliver({ type: 'snapshot-result', ok: true, image: 'data:image/jpeg;base64,AAAA' });
  assert.equal(await p, 'data:image/jpeg;base64,AAAA');
});

test("THE STORAGE CASE: a player with no disk rejects with the player's own words", async () => {
  // The DWS writes the full capture to disk before returning a thumbnail, so a unit with no card
  // or SSD answers "No primary storage found." Passing that through verbatim is what lets the
  // dashboard explain the failure instead of showing an empty frame.
  const { api, ready, sandbox } = load({ mods: true });
  await ready;
  const p = api.requestSnapshot();
  sandbox.__deliver({ type: 'snapshot-result', ok: false, error: 'No primary storage found.' });
  await assert.rejects(p, /No primary storage found/);
});

test('with no host it rejects immediately rather than hanging the caller', async () => {
  const { api, ready } = load();   // plain browser
  await ready;
  await assert.rejects(api.requestSnapshot(), /no host bridge/);
});

test('THE ROTATION BUG: setOrientation asks the host to rotate the OUTPUT', async () => {
  // A CSS transform cannot touch the hardware plane the video decodes onto, so rotating in the DOM
  // turns the images and widgets and leaves the video sideways. Tizen hit the same wall and routes
  // portrait video through AVPlay. Here the fix is roVideoMode's transform, which rotates every
  // layer because it happens below the compositor.
  const { api, ready, posted, sandbox } = load({ mods: true });
  await ready;
  const p = api.setOrientation('portrait');
  const req = posted.find((m) => m.type === 'set-orientation');
  assert.ok(req, 'the host must be asked');
  assert.equal(req.orientation, 'portrait');
  sandbox.__deliver({ type: 'orientation-result', ok: true, transform: '90' });
  assert.equal(await p, true, 'true means the caller must CLEAR its CSS transform, or it rotates twice');
});

test('a host that cannot rotate resolves false, so the caller keeps its CSS fallback', async () => {
  // Rotating most of the content beats rotating none of it, and beats a promise that never settles.
  const { api, ready, sandbox } = load({ mods: true });
  await ready;
  const p = api.setOrientation('portrait-flipped');
  sandbox.__deliver({ type: 'orientation-result', ok: false, error: 'no roVideoMode' });
  assert.equal(await p, false);
});

test('off-platform it resolves false immediately rather than hanging the render', async () => {
  const { api, ready } = load();
  await ready;
  assert.equal(await api.setOrientation('portrait'), false);
});

// ---------------------------------------------------------------------------------------------
// The LAN address.
//
// The dashboard has had a "Local IP" field since 1.9.29 and it was NULL for every BrightSign ever
// paired — 6000 consecutive telemetry rows on our XT245 while it sat at a perfectly reachable
// 192.168.1.46. The host half (autorun.brs) does collect it, but nothing the host sends was
// arriving, so the field could only ever be filled from the page.
//
// There is no @brightsign module for this, and looking for one is the trap: on FW 9.1.93.2
// @brightsign/networkconfiguration exists but exposes only callback/getNeighborInformation/
// enableLeds, and @brightsign/hostconfiguration returns host settings with no address in them.
// Both enumerated on the live player. BrightSign's own dev-cookbook (html5-app-template, both the
// .ts and .js variants) uses Node's os.networkInterfaces(), which is available because the widget
// is created with nodejs_enabled.

test('the LAN address comes from os.networkInterfaces(), the way the vendor does it', () => {
  const { api } = load({
    mods: [],
    os: {
      networkInterfaces: () => ({
        lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
        eth0: [{ address: '192.168.1.46', family: 'IPv4', internal: false }],
      }),
    },
  });
  api.refreshTelemetry();
  assert.equal(api.telemetrySnapshot().local_ip, '192.168.1.46');
});

test('loopback and a DHCP-less link-local are never reported', () => {
  // 169.254.x is what a player assigns itself when DHCP never answered. Sending an operator to an
  // address that cannot be reached is worse than showing nothing.
  for (const bad of ['127.0.0.1', '169.254.10.4']) {
    const { api } = load({
      mods: [],
      os: { networkInterfaces: () => ({ eth0: [{ address: bad, family: 'IPv4', internal: bad.startsWith('127.') }] }) },
    });
    api.refreshTelemetry();
    assert.equal(api.telemetrySnapshot().local_ip, undefined, `${bad} must not be reported`);
  }
});

test('family is accepted as the string OR the number', () => {
  // "IPv4" on the Node in this firmware and in the cookbook; the number 4 since Node 18. This file
  // outlives firmwares, so it must not care which it is handed.
  const { api } = load({
    mods: [],
    os: { networkInterfaces: () => ({ eth0: [{ address: '10.0.0.7', family: 4, internal: false }] }) },
  });
  api.refreshTelemetry();
  assert.equal(api.telemetrySnapshot().local_ip, '10.0.0.7');
});

test('a browser has no os module and simply reports no address', () => {
  const { api } = load({ mods: [] });
  assert.doesNotThrow(() => api.refreshTelemetry());
  assert.equal(api.telemetrySnapshot().local_ip, undefined);
});

// ---------------------------------------------------------------------------------------------
// Memory, load, uptime and REAL disk — all from Node's stdlib, all previously NULL on BrightSign.
//
// The storage numbers are the ones that were actively misleading rather than merely absent: the
// page reported navigator.storage.estimate(), so our XT245 answered "1026 MB total" for a 119 GB
// NVMe. That is the browser's cache budget, not the machine, and an operator reading it has been
// told something false. Verified on the player: 119616 MB, which matches the kernel's block count.

const OS_STUB = {
  networkInterfaces: () => ({ eth0: [{ address: '192.168.1.46', family: 'IPv4', internal: false }] }),
  totalmem: () => 3656 * 1048576,
  freemem: () => 2773 * 1048576,
  uptime: () => 149,
  loadavg: () => [0.2, 0.3, 0.3],
  cpus: () => [{}, {}, {}, {}],
};

test('memory and load are reported from os, not left empty', () => {
  const { api } = load({ mods: [], os: OS_STUB });
  api.refreshTelemetry();
  const t = api.telemetrySnapshot();
  assert.equal(t.ram_total_mb, 3656);
  assert.equal(t.ram_free_mb, 2773);
  assert.equal(t.cpu_usage, 5, '0.2 load over 4 cores = 5%');
});

test('uptime is the MACHINE, which is what makes a reboot loop visible', () => {
  // The page sends performance.now()/1000 — how long the PAGE has been up. A widget rebuilt by the
  // watchdog resets that while the player has been running for weeks.
  const { api } = load({ mods: [], os: OS_STUB });
  api.refreshTelemetry();
  assert.equal(api.telemetrySnapshot().uptime_seconds, 149);
});

test('THE MISLEADING ONE: storage is the disk, not the browser cache quota', () => {
  const fsStub = {
    readdirSync: (p) => (p === '/storage' ? ['sd', 'ssd'] : []),
    statfsSync: (p) => {
      if (p === '/storage/ssd') return { blocks: 31258710, bsize: 4096, bavail: 31245000, bfree: 31245000 };
      if (p === '/storage/sd') return { blocks: 1000, bsize: 4096, bavail: 500, bfree: 500 };
      throw new Error('not a mount');
    },
  };
  const { api } = load({ mods: [], os: OS_STUB, fs: fsStub, storageEstimate: { quota: 1026 * 1048576, usage: 2 * 1048576 } });
  api.refreshTelemetry();
  const t = api.telemetrySnapshot();
  assert.equal(t.storage_total_mb, 122104, 'the 119 GB volume, not the 1026 MB quota');
  assert.ok(t.storage_total_mb > 100000, 'a browser quota would be ~1000');
});

test('the LARGEST mount wins, because which volume a player boots from varies', () => {
  // Ours runs from an NVMe with a dead card slot; others boot from SD. Picking the first mount
  // would report a 4 MB card as the content volume on exactly those players.
  const fsStub = {
    readdirSync: () => ['sd', 'ssd'],
    statfsSync: (p) => (p === '/storage/sd'
      ? { blocks: 1024, bsize: 4096, bavail: 1000, bfree: 1000 }
      : { blocks: 262144, bsize: 4096, bavail: 200000, bfree: 200000 }),
  };
  const { api } = load({ mods: [], os: OS_STUB, fs: fsStub });
  api.refreshTelemetry();
  assert.equal(api.telemetrySnapshot().storage_total_mb, 1024, 'the 1 GiB ssd, not the 4 MiB sd');
});

test('a firmware without statfs degrades instead of throwing', () => {
  const { api } = load({ mods: [], os: OS_STUB, fs: { readdirSync: () => [] } });
  assert.doesNotThrow(() => api.refreshTelemetry());
  assert.equal(api.telemetrySnapshot().local_ip, '192.168.1.46', 'and the rest still reports');
});

// ---------------------------------------------------------------------------------------------
// Which screen is plugged in, and what the output is driving.
//
// screen_width/height are what the PAGE believes it has — the widget's own geometry. They say
// nothing about the panel. Our XT245 drives a CX101 at 1920x1200@60 while the page reports its own
// canvas, so an operator asking "which display is that and is it even outputting?" had no answer.
//
// The output is chosen by SCREEN NUMBER because a dual-output player registers one device row per
// output (?screen=N → output_index), and each row must report its own panel.

const flush = () => new Promise((r) => setTimeout(r, 0));

test('the attached display is read from EDID', async () => {
  const { api } = load({ mods: true, os: OS_STUB, edid: { 'HDMI-1': 'CX101' } });
  api.refreshTelemetry();
  await flush();
  assert.equal(api.telemetrySnapshot().attached_display, 'CX101');
});

test('MULTI-SCREEN: each output reports its OWN panel, not the box\'s first', async () => {
  // The bug this prevents: a player driving a lobby TV and a menu board showing the lobby TV twice.
  const wiring = { edid: { 'HDMI-1': 'Lobby-55', 'HDMI-2': 'MenuBoard-32' } };
  const one = load({ mods: true, os: OS_STUB, search: '?screen=1', ...wiring });
  const two = load({ mods: true, os: OS_STUB, search: '?screen=2', ...wiring });
  one.api.refreshTelemetry();
  two.api.refreshTelemetry();
  await flush();
  assert.equal(one.api.telemetrySnapshot().attached_display, 'Lobby-55');
  assert.equal(two.api.telemetrySnapshot().attached_display, 'MenuBoard-32');
});

test('a single-output player reports nothing rather than inventing a second screen', async () => {
  // Verified on hardware: "hdmi2" throws from the constructor and "HDMI-2" rejects.
  const { api } = load({ mods: true, os: OS_STUB, search: '?screen=2', edid: { 'HDMI-1': 'CX101' } });
  assert.doesNotThrow(() => api.refreshTelemetry());
  await flush();
  assert.equal(api.telemetrySnapshot().attached_display, undefined);
});

test('screen 1 also accepts the lowercase name the vendor cookbook uses', async () => {
  const { api } = load({ mods: true, os: OS_STUB, edid: { hdmi: 'CX101' } });
  api.refreshTelemetry();
  await flush();
  assert.equal(api.telemetrySnapshot().attached_display, 'CX101');
});

test('the active mode is reported as WxH@Hz, the way an installer says it', async () => {
  const { api } = load({
    mods: true, os: OS_STUB,
    activeMode: { graphicsPlaneWidth: 1920, graphicsPlaneHeight: 1200, frequency: 60 },
  });
  api.refreshTelemetry();
  await flush();
  assert.equal(api.telemetrySnapshot().video_mode, '1920x1200@60');
});

test('a firmware with neither module degrades quietly', async () => {
  const { api } = load({ mods: true, os: OS_STUB });
  assert.doesNotThrow(() => api.refreshTelemetry());
  await flush();
  const t = api.telemetrySnapshot();
  assert.equal(t.attached_display, undefined);
  assert.equal(t.video_mode, undefined);
  assert.equal(t.local_ip, '192.168.1.46', 'and everything else still reports');
});
