#!/usr/bin/env node
'use strict';

// Operator CLI — deliver a device command (default: a FORCED update check) to ONE display.
//
//   node scripts/force-update.js <device-id|8-char-prefix>
//   node scripts/force-update.js abc12345 --as owner@example.com
//   node scripts/force-update.js abc12345 --command reboot
//   node scripts/force-update.js abc12345 --dry-run         # prove auth/handshake, send nothing
//   node scripts/force-update.js --list                     # displays that are online right now
//
// WHY THIS EXISTS: a display whose periodic checker is not firing (seen in the field: no
// /api/update/check for 19h on a device that was awake and playing the whole time) will never
// pull an update on its own, and a beta opt-in alone does not reach it. The dashboard's force
// button is the only lever that does, because `MainActivity`'s "update" handler calls
// `checkForUpdate(forced = true)` — which ignores BOTH the backoff cap and the MDM stand-down,
// and hands the attempt budget back so a parked device acts immediately.
//
// OWNER-ONLY BY CONSTRUCTION, like scripts/mint-billing-token.js: no network endpoint, the access
// control IS shell access to the host. It mints a short-lived session JWT for a platform_admin,
// which clears `canActOnDevice` for any workspace via `ctx.actingAs`.
//
// Force-updating a display that is NOT device-owner provisioned raises the package-installer
// confirm dialog OVER whatever is on screen, and it stays there until a human accepts it. Aim
// this at one display, and only when someone can see it. (An update preserves runtime permissions
// and appops; only an uninstall clears them.)
//
// The command is delivered over the /dashboard socket.io namespace, NOT REST — there is no HTTP
// route for it. socket.io-client is not a dependency of this project, so the engine.io v4 protocol
// is spoken directly over `ws` (present transitively via socket.io, same reach-into-server/
// node_modules convention as scripts/reset-admin.js).

const path = require('path');

const serverDir = path.join(__dirname, '..', 'server');
const config = require(path.join(serverDir, 'config'));
const { db } = require(path.join(serverDir, 'db', 'database'));
const jwt = require(path.join(serverDir, 'node_modules', 'jsonwebtoken'));

let WebSocket;
try {
  WebSocket = require(path.join(serverDir, 'node_modules', 'ws'));
} catch (e) {
  console.error('Cannot load `ws` from server/node_modules — run `npm install` in server/ first.');
  process.exit(1);
}

function arg(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? (process.argv[i + 1] || '') : undefined;
}
const has = (flag) => process.argv.includes(flag);

function listOnline() {
  const rows = db.prepare(
    `SELECT id, name, app_version, status FROM devices WHERE status = 'online' ORDER BY name`
  ).all();
  if (!rows.length) { console.log('No displays are online.'); return; }
  for (const d of rows) {
    console.log(`  ${d.id.slice(0, 8)}  ${String(d.app_version || '?').padEnd(14)}  ${d.name || ''}`);
  }
}

function resolveDevice(ref) {
  // Accept a full id or any unique prefix — 8 chars is what the dashboard and the logs show.
  const rows = db.prepare(
    'SELECT id, name, workspace_id, app_version, status, ota_beta FROM devices WHERE id = ? OR id LIKE ?'
  ).all(ref, `${ref}%`);
  if (!rows.length) throw new Error(`No display matches "${ref}"`);
  if (rows.length > 1) {
    throw new Error(`"${ref}" matches ${rows.length} displays — use more characters:\n` +
      rows.map((r) => `    ${r.id}  ${r.name || ''}`).join('\n'));
  }
  return rows[0];
}

function resolveActor(email) {
  const actor = email
    ? db.prepare('SELECT id, email, role FROM users WHERE email = ?').get(email)
    : db.prepare("SELECT id, email, role FROM users WHERE role = 'platform_admin' ORDER BY created_at LIMIT 1").get();
  if (!actor) throw new Error(email ? `No user ${email}` : 'No platform_admin user exists');
  if (actor.role !== 'platform_admin') {
    // A workspace_editor/admin would also pass canActOnDevice for THEIR workspace, but silently
    // failing the handshake later is a worse experience than refusing clearly here.
    throw new Error(`${actor.email} is ${actor.role}, not platform_admin`);
  }
  return actor;
}

function send(device, actor, type, payload) {
  const token = jwt.sign(
    { id: actor.id, email: actor.email, role: actor.role, current_workspace_id: device.workspace_id },
    config.jwtSecret,
    { algorithm: 'HS256', expiresIn: '5m' }
  );

  const ACK_ID = 7; // any id; we just have to match it back
  const url = `ws://127.0.0.1:${config.port}/socket.io/?EIO=4&transport=websocket`;
  const ws = new WebSocket(url);

  let settled = false;
  const done = (code, msg) => {
    if (settled) return;
    settled = true;
    if (msg) console[code === 0 ? 'log' : 'error'](msg);
    try { ws.close(); } catch (e) { /* already gone */ }
    process.exit(code);
  };

  const timer = setTimeout(() => done(2, 'TIMEOUT — no ack from the server after 20s'), 20000);
  timer.unref?.();

  ws.on('open', () => { /* wait for the engine.io OPEN frame before doing anything */ });

  ws.on('message', (raw) => {
    const msg = raw.toString();

    if (msg.startsWith('0{')) {                     // OPEN -> connect to the namespace with auth
      ws.send('40/dashboard,' + JSON.stringify({ token }));
      return;
    }
    if (msg === '2') { ws.send('3'); return; }      // engine.io ping -> pong

    if (msg.startsWith('40/dashboard,')) {          // namespace CONNECT accepted
      if (has('--dry-run')) {
        // Everything except the command itself is now proven: lookup, token, handshake, namespace
        // authorisation. Stop here so a rehearsal never puts an install dialog on a live screen.
        done(0, 'Dry run — authenticated and connected; no command sent.');
        return;
      }
      ws.send(`42/dashboard,${ACK_ID}` + JSON.stringify(['dashboard:device-command', {
        device_id: device.id, type, payload: payload || {}
      }]));
      console.log(`-> ${type}`);
      return;
    }
    if (msg.startsWith('44/dashboard')) {           // CONNECT_ERROR (bad/expired token, MFA gate)
      done(3, `Handshake refused: ${msg.slice('44/dashboard,'.length)}`);
      return;
    }
    if (msg.startsWith(`43/dashboard,${ACK_ID}`)) { // ACK
      const body = msg.slice(`43/dashboard,${ACK_ID}`.length);
      let ack;
      try { ack = JSON.parse(body)[0]; } catch (e) { ack = null; }
      if (ack && ack.delivered) return done(0, 'Delivered to the display.');
      if (ack && ack.queued) return done(0, 'Display is offline — command queued for its next connect.');
      return done(4, `Not delivered: ${body}`);
    }
  });

  ws.on('error', (e) => done(5, `Socket error: ${e.message}`));
}

function main() {
  if (has('--help') || has('-h')) {
    console.log(require('fs').readFileSync(__filename, 'utf8')
      .split('\n').filter((l) => l.startsWith('//')).slice(0, 6).join('\n').replace(/^\/\/ ?/gm, ''));
    return;
  }
  if (has('--list')) return listOnline();

  const ref = process.argv[2];
  if (!ref || ref.startsWith('-')) {
    console.error('usage: node scripts/force-update.js <device-id|prefix> [--as <email>] [--command <type>]');
    console.error('       node scripts/force-update.js --list');
    process.exit(1);
  }

  const device = resolveDevice(ref);
  const actor = resolveActor(arg('--as'));
  const type = arg('--command') || 'update';

  console.log(`display: ${device.name || '(unnamed)'} [${device.id.slice(0, 8)}] ` +
    `v${device.app_version || '?'} ${device.status}${device.ota_beta ? ' beta' : ''}`);
  console.log(`as:      ${actor.email}`);

  send(device, actor, type, {});
}

try {
  main();
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
