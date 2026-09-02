'use strict';

/*
 * The capability gate on the dashboard socket's REMOTE handlers.
 *
 * dashboard:device-command has always refused a command the panel cannot honour, and the comment
 * over it is right about why: "Hiding the button is not enforcement. This socket is reachable
 * directly, and an older dashboard tab left open still renders the old controls."
 *
 * Every word of that applied to the four handlers sitting immediately ABOVE it, which had no gate
 * at all. Measured against a real server: a display declaring `[]` still received
 * screenshot-request, remote-touch, remote-key and remote-start. The dashboard even popped a toast
 * ("Screenshot requested — it appears on the panel's device page") for a BrightSign, which has no
 * screenshot capability at all. That is the "reports success and changes nothing" shape the whole
 * capability model was written to end.
 *
 * End-to-end on a real server, because the bug was in the wiring: a real device socket registers, a
 * real dashboard socket sends, and the assertion is on what the DEVICE actually received.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const { io } = require('socket.io-client');
const { freePort } = require('./helpers/free-port');

const DATA_DIR = path.join(os.tmpdir(), 'st-remotegate-' + crypto.randomBytes(4).toString('hex'));
const DBPATH = path.join(DATA_DIR, 'db', 'remote_display.db');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let proc, BASE, PORT, jwt, workspaceId;

// Every device below is an ANDROID panel. The only difference between them is the declaration, so
// a difference in outcome can only come from the declaration — not from a platform baseline.
const DEVICES = [
  ['d-declares-nothing', null],                  // the fielded fleet: NULL => android baseline
  ['d-declares-empty', '[]'],                    // a real statement: I can do nothing
  ['d-declares-shot-only', '["remote.screenshot"]'],
];

before(async () => {
  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  proc = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(PORT), NODE_ENV: 'test' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(BASE + '/api/status'); if (r.ok) break; } catch { /* booting */ }
    await sleep(150);
  }
  const reg = await fetch(BASE + '/api/auth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'gate@test.local', password: 'GatePassw0rd!', name: 'Gate' }),
  }).then((r) => r.json());
  jwt = reg.token;
  workspaceId = reg.current_workspace_id;

  const seed = new Database(DBPATH);
  const ins = seed.prepare(`INSERT INTO devices
    (id, user_id, workspace_id, name, pairing_code, status, client_type, android_version, capabilities, device_token)
    VALUES (?, ?, ?, ?, ?, 'online', 'apk', '14', ?, ?)`);
  let n = 0;
  for (const [id, caps] of DEVICES) ins.run(id, reg.user.id, workspaceId, id, String(900001 + n++), caps, 'tok-' + id);
  seed.close();
});

after(async () => {
  if (proc) proc.kill('SIGKILL');
  await sleep(200);
});

function dashboard() {
  return new Promise((resolve, reject) => {
    const s = io(`${BASE}/dashboard`, { transports: ['websocket'], auth: { token: jwt }, reconnection: false });
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
  });
}

// Connect a real device socket and record every event the SERVER sends it.
function device(deviceId) {
  return new Promise((resolve, reject) => {
    const s = io(`${BASE}/device`, { transports: ['websocket'], reconnection: false });
    const got = [];
    for (const ev of ['device:screenshot-request', 'device:remote-touch', 'device:remote-key', 'device:remote-start', 'device:remote-stop', 'device:command']) {
      s.on(ev, () => got.push(ev));
    }
    s.on('connect', () => s.emit('device:register', { device_id: deviceId, device_token: 'tok-' + deviceId }));
    s.on('device:registered', () => resolve({ sock: s, got }));
    s.on('connect_error', reject);
    setTimeout(() => reject(new Error('register timed out for ' + deviceId)), 10000);
  });
}

test('a display declaring [] receives NONE of the remote requests', async () => {
  const dash = await dashboard();
  const dev = await device('d-declares-empty');
  await sleep(250);
  dev.got.length = 0;
  dash.emit('dashboard:request-screenshot', { device_id: 'd-declares-empty' });
  dash.emit('dashboard:remote-touch', { device_id: 'd-declares-empty', x: 5, y: 5 });
  dash.emit('dashboard:remote-key', { device_id: 'd-declares-empty', keycode: 4 });
  dash.emit('dashboard:remote-start', { device_id: 'd-declares-empty' });
  await sleep(700);
  assert.deepEqual(dev.got, [], 'a panel that says it can do nothing is sent nothing');
  dev.sock.disconnect(); dash.disconnect();
});

test('the refusal names the missing capability when the caller asks for an ack', async () => {
  const dash = await dashboard();
  const dev = await device('d-declares-empty');
  await sleep(250);
  const ack = (event) => new Promise((res) => {
    let done = false;
    dash.emit(event, { device_id: 'd-declares-empty', x: 1, y: 1, keycode: 4 }, (a) => { done = true; res(a); });
    setTimeout(() => { if (!done) res(null); }, 800);
  });
  assert.deepEqual(await ack('dashboard:request-screenshot'), { delivered: false, reason: 'unsupported', capability: 'remote.screenshot' });
  assert.deepEqual(await ack('dashboard:remote-touch'), { delivered: false, reason: 'unsupported', capability: 'remote.input' });
  assert.deepEqual(await ack('dashboard:remote-key'), { delivered: false, reason: 'unsupported', capability: 'remote.input' });
  assert.deepEqual(await ack('dashboard:remote-start'), { delivered: false, reason: 'unsupported', capability: 'remote.stream' });
  dev.sock.disconnect(); dash.disconnect();
});

test('THE FLEET: a display that has never declared anything still gets everything it always had', async () => {
  // The failure that would be worse than the bug. Several hundred Android panels declare nothing;
  // if "declared nothing" resolved to "supports nothing", this gate would strip remote control
  // from the entire installed base on the day it deployed.
  const dash = await dashboard();
  const dev = await device('d-declares-nothing');
  await sleep(250);
  dev.got.length = 0;
  dash.emit('dashboard:request-screenshot', { device_id: 'd-declares-nothing' });
  dash.emit('dashboard:remote-touch', { device_id: 'd-declares-nothing', x: 5, y: 5 });
  dash.emit('dashboard:remote-key', { device_id: 'd-declares-nothing', keycode: 4 });
  dash.emit('dashboard:remote-start', { device_id: 'd-declares-nothing' });
  await sleep(700);
  assert.deepEqual(dev.got.sort(), [
    'device:remote-key', 'device:remote-start', 'device:remote-touch', 'device:screenshot-request',
  ], 'the undeclared Android baseline keeps the whole remote surface');
  dev.sock.disconnect(); dash.disconnect();
});

test('the gate is per-capability, not all-or-nothing', async () => {
  // A panel with accessibility on but no input injection declares screenshot alone. It must keep
  // the screenshot and lose the pad, not lose both or keep both.
  const dash = await dashboard();
  const dev = await device('d-declares-shot-only');
  await sleep(250);
  dev.got.length = 0;
  dash.emit('dashboard:request-screenshot', { device_id: 'd-declares-shot-only' });
  dash.emit('dashboard:remote-touch', { device_id: 'd-declares-shot-only', x: 5, y: 5 });
  dash.emit('dashboard:remote-start', { device_id: 'd-declares-shot-only' });
  await sleep(700);
  assert.deepEqual(dev.got, ['device:screenshot-request']);
  dev.sock.disconnect(); dash.disconnect();
});

test('remote-stop is never refused — it is the way out of a stuck stream', async () => {
  const dash = await dashboard();
  const dev = await device('d-declares-empty');
  await sleep(250);
  dev.got.length = 0;
  dash.emit('dashboard:remote-stop', { device_id: 'd-declares-empty' });
  await sleep(600);
  assert.deepEqual(dev.got, ['device:remote-stop'],
    'a panel whose declaration changed mid-stream must still be stoppable');
  dev.sock.disconnect(); dash.disconnect();
});

test('GET /api/devices ships the RESOLVED capability array, not the raw column', async () => {
  // The list used to carry the raw TEXT column: '[]' or null. Array.isArray('[]') is false, so the
  // dashboard's `can()` helper read a device that declared "I can do nothing" as "pre-capability
  // server — show everything", which is the wrong answer in the one case that matters.
  const rows = await fetch(BASE + '/api/devices', { headers: { Authorization: 'Bearer ' + jwt } }).then((r) => r.json());
  const byId = Object.fromEntries(rows.map((d) => [d.id, d]));
  assert.ok(Array.isArray(byId['d-declares-empty'].capabilities), 'an array, not a JSON string');
  assert.deepEqual(byId['d-declares-empty'].capabilities, [], 'an empty declaration is honoured');
  assert.ok(byId['d-declares-nothing'].capabilities.includes('remote.screenshot'),
    'and an absent declaration still resolves to its platform baseline');
});
