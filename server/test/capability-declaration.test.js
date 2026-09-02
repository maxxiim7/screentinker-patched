'use strict';

// End-to-end for the one thing the whole capability model rests on: what the player says at
// registration is what the dashboard renders from.
//
// The trap this guards is a three-state column read as two. NULL means "this display has never
// told us anything" and must fall back to its platform baseline, because several hundred displays
// in the field will not update before the next dashboard deploy and blanking their controls is a
// far worse bug than the one being fixed. '[]' means "I genuinely can do nothing" and must be
// honoured. Anything that collapses those two — COALESCE, a falsy check, `caps || baseline` —
// looks correct in review and takes out either the legacy fleet or the honest players.
//
// Capabilities are also re-read on EVERY register, not once: an Android panel gains real
// screenshots the moment accessibility is switched on and loses Tier-2 when device owner is
// revoked. A first-registration-only write would pin the display to whatever was true at pairing.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const ioClient = require('../node_modules/socket.io-client');

const { freePort } = require('./helpers/free-port');
let PORT, BASE, proc, db;
const DATA_DIR = path.join(os.tmpdir(), 'st-caps-' + crypto.randomBytes(4).toString('hex'));
const LOG = path.join(os.tmpdir(), 'st-caps-' + crypto.randomBytes(4).toString('hex') + '.log');
const S = {};

const jfetch = async (p, opts = {}) => {
  const res = await fetch(BASE + p, opts);
  let body = null; try { body = await res.json(); } catch { /* */ }
  return { status: res.status, body };
};
const auth = () => ({ Authorization: 'Bearer ' + S.token, 'Content-Type': 'application/json' });

before(async () => {
  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  const logFd = fs.openSync(LOG, 'w');
  proc = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(PORT), NODE_ENV: 'test' },
    stdio: ['ignore', logFd, logFd],
  });
  let up = false;
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(BASE + '/api/status'); if (r.ok) { up = true; break; } } catch { /* */ }
    await new Promise(r => setTimeout(r, 250));
  }
  if (!up) throw new Error('server did not boot:\n' + fs.readFileSync(LOG, 'utf8').slice(-2000));
  db = new Database(path.join(DATA_DIR, 'db', 'remote_display.db'));

  const email = 'u' + crypto.randomBytes(5).toString('hex') + '@x.local';
  const reg = await jfetch('/api/auth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'Passw0rd123' }),
  });
  S.token = reg.body.token;
  const me = await jfetch('/api/auth/me', { headers: auth() });
  S.wsId = me.body.accessible_workspaces[0].id;
});
after(() => { try { db && db.close(); } catch { /* */ } try { proc.kill('SIGKILL'); } catch { /* */ } });

function makeDevice() {
  const id = crypto.randomUUID();
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare(`INSERT INTO devices (id, name, status, workspace_id, device_token, client_type, created_at)
              VALUES (?, 'CAPS', 'online', ?, ?, 'apk', strftime('%s','now'))`)
    .run(id, S.wsId, token);
  return { id, token };
}

function register(dev, payload = {}) {
  return new Promise((resolve, reject) => {
    const s = ioClient(BASE + '/device', { transports: ['websocket'], reconnection: false });
    s.on('connect', () => s.emit('device:register', { device_id: dev.id, device_token: dev.token, ...payload }));
    s.on('device:registered', () => resolve(s));
    s.on('device:auth-error', (e) => reject(new Error(e && e.error)));
    setTimeout(() => reject(new Error('register timeout')), 10000);
  });
}
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const stored = (id) => db.prepare('SELECT capabilities FROM devices WHERE id = ?').get(id).capabilities;

test('a player that declares its capabilities has them persisted', async () => {
  const dev = makeDevice();
  const s = await register(dev, { capabilities: ['playback.video', 'system.reboot'] });
  await wait(400);
  assert.deepEqual(JSON.parse(stored(dev.id)), ['playback.video', 'system.reboot']);
  s.close();
});

test('THE DISTINCTION: a player that declares nothing leaves the column NULL', async () => {
  // Not '[]'. The legacy fleet lands here, and NULL is what routes them to their platform
  // baseline instead of to an empty dashboard.
  const dev = makeDevice();
  const s = await register(dev);
  await wait(400);
  assert.equal(stored(dev.id), null,
    'an absent field must stay distinguishable from an empty declaration');
  s.close();
});

test('...while an EMPTY declaration is stored as an empty array and honoured', async () => {
  const dev = makeDevice();
  const s = await register(dev, { capabilities: [] });
  await wait(400);
  assert.equal(stored(dev.id), '[]', 'a player saying "I can do nothing" is a real answer');
  s.close();
});

test('capabilities are re-read on every register, not frozen at pairing', async () => {
  // Accessibility switched on between boots is the concrete case: the panel gains real
  // screenshots and the Remote tab has to appear without a re-pair.
  const dev = makeDevice();
  let s = await register(dev, { capabilities: ['playback.video'] });
  await wait(400);
  s.close();
  await wait(200);

  s = await register(dev, { capabilities: ['playback.video', 'remote.screenshot'] });
  await wait(400);
  assert.deepEqual(JSON.parse(stored(dev.id)), ['playback.video', 'remote.screenshot'],
    'a stale set would keep a working control hidden until someone re-paired the display');
  s.close();
});

test('a capability the server has never heard of is dropped, not stored', async () => {
  // The column feeds a UI gate and a server-side command check. Letting arbitrary strings through
  // would let a player invent its own permissions by naming them.
  const dev = makeDevice();
  const s = await register(dev, { capabilities: ['playback.video', 'system.root_shell_lol'] });
  await wait(400);
  assert.deepEqual(JSON.parse(stored(dev.id)), ['playback.video']);
  s.close();
});

test('a garbage capabilities field does not stop the display registering', async () => {
  // A player mid-rollout with a bug in its declaration must still come online; a screen that
  // refuses to connect is worse than one with the wrong buttons.
  const dev = makeDevice();
  const s = await register(dev, { capabilities: 'not-an-array' });
  await wait(400);
  assert.equal(s.connected, true, 'the register still succeeded');
  s.close();
});

test('the device API returns the RESOLVED list, so the dashboard never re-derives it', async () => {
  // Two implementations of "what can this display do" drift apart, and the one in the browser is
  // the one nobody runs tests against. The server answers; the dashboard only renders.
  const declared = makeDevice();
  const s = await register(declared, { capabilities: ['playback.video'] });
  await wait(400);
  s.close();

  const legacy = makeDevice();          // never registered: NULL column, baseline expected

  const a = await jfetch(`/api/devices/${declared.id}`, { headers: auth() });
  assert.equal(a.status, 200);
  assert.deepEqual(a.body.capabilities, ['playback.video']);

  const b = await jfetch(`/api/devices/${legacy.id}`, { headers: auth() });
  assert.equal(b.status, 200);
  assert.ok(Array.isArray(b.body.capabilities) && b.body.capabilities.length > 0,
    'an undeclared Android panel must come back with its baseline, not an empty list');
  assert.ok(b.body.capabilities.includes('system.restart_player'),
    'and that baseline is what keeps the existing fleet\'s controls on screen');
});
