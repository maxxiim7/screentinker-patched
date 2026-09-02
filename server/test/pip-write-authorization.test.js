'use strict';

// A PiP overlay is pushed to a live screen and can render an arbitrary web page across it, at full
// resolution, for as long as the operator wants (duration 0 = persistent). That is a fleet-affecting
// write and must be held to the same bar as every other one.
//
// It was not. The only guard was requireScope('full'), which gates API TOKENS and is a deliberate
// pass-through for dashboard sessions (`if (!req.viaToken) return next()`). Every sibling route
// pairs that scope check with a role check — device-groups.js gates POST /:id/command with
// `requireScope('full'), requireGroupWrite` — but these three routes had only the half that does
// nothing for a logged-in user. A member whose role is read-only everywhere else could push and
// clear overlays on every screen in the workspace.
//
// The invariant: a read-only member cannot change what a screen displays. Pinned for all three
// write routes, because a partial fix here is worthless.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'st-pip-authz-'));
process.env.DATA_DIR = tmp;
process.env.JWT_SECRET = 'test-secret-pip-authz';

const express = require('express');
const { db } = require('../db/database');
const { requireAuth, generateToken } = require('../middleware/auth');
const { resolveTenancy } = require('../lib/tenancy');

// One workspace, one device, three members: an owner, an editor and a viewer.
const O = 'o-pip', WS = 'ws-pip', DEV = 'd-pip';
db.prepare("INSERT OR IGNORE INTO users (id,email,password_hash,role) VALUES ('u-owner','owner@t.local','x','user')").run();
db.prepare("INSERT OR IGNORE INTO users (id,email,password_hash,role) VALUES ('u-editor','editor@t.local','x','user')").run();
db.prepare("INSERT OR IGNORE INTO users (id,email,password_hash,role) VALUES ('u-viewer','viewer@t.local','x','user')").run();
db.prepare('INSERT OR IGNORE INTO organizations (id,name,owner_user_id) VALUES (?,?,?)').run(O, 'Org', 'u-owner');
db.prepare('INSERT OR IGNORE INTO workspaces (id,organization_id,name) VALUES (?,?,?)').run(WS, O, 'WS');
db.prepare("INSERT OR IGNORE INTO organization_members (organization_id,user_id,role) VALUES (?,?, 'org_owner')").run(O, 'u-owner');
db.prepare("INSERT OR IGNORE INTO workspace_members (workspace_id,user_id,role) VALUES (?,?, 'workspace_editor')").run(WS, 'u-editor');
db.prepare("INSERT OR IGNORE INTO workspace_members (workspace_id,user_id,role) VALUES (?,?, 'workspace_viewer')").run(WS, 'u-viewer');
db.prepare(`INSERT OR IGNORE INTO devices (id,name,workspace_id,created_at,updated_at)
            VALUES (?,?,?,strftime('%s','now'),strftime('%s','now'))`).run(DEV, 'Screen', WS);

const app = express();
app.use(express.json());
// Minimal socket stub — the route emits to the device room on a successful push. The deny paths
// never reach it, but the allow paths must not 500 on a missing io.
const emitted = [];
const nsp = {
  adapter: { rooms: new Map([[DEV, new Set(['sock-1'])]]) },
  to: () => ({ emit: (...a) => emitted.push(a) }),
  emit: (...a) => emitted.push(a),
};
app.set('io', { of: () => nsp });
app.use('/api/pip', requireAuth, resolveTenancy, require('../routes/pip'));
const server = app.listen(0);

const row = (id) => db.prepare('SELECT id, email, role FROM users WHERE id = ?').get(id);
const tokenFor = (id) => generateToken(row(id), WS);

async function call(method, pathname, who, body) {
  await new Promise(r => (server.listening ? r() : server.once('listening', r)));
  const res = await fetch(`http://127.0.0.1:${server.address().port}${pathname}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(who ? { Authorization: `Bearer ${tokenFor(who)}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return res.status;
}

const PUSH = { device_id: DEV, type: 'web', uri: 'https://example.com/', width: 800, height: 600, duration: 0 };

test('THE HOLE: a read-only member cannot push an overlay to a screen', async () => {
  assert.equal(await call('POST', '/api/pip', 'u-viewer', PUSH), 403);
});

test('a read-only member cannot clear overlays either', async () => {
  // Both spellings of clear — a fix that covers one and not the other is not a fix.
  assert.equal(await call('POST', '/api/pip/clear', 'u-viewer', { device_id: DEV }), 403);
  assert.equal(await call('DELETE', '/api/pip', 'u-viewer', { device_id: DEV }), 403);
});

test('an unauthenticated caller is refused', async () => {
  assert.equal(await call('POST', '/api/pip', null, PUSH), 401);
});

test('AND THE OTHER HALF: an editor can still push and clear', async () => {
  // The guard must not break the feature. A workspace_editor manages content by definition.
  assert.equal(await call('POST', '/api/pip', 'u-editor', PUSH), 200);
  assert.equal(await call('POST', '/api/pip/clear', 'u-editor', { device_id: DEV }), 200);
});

test('an org owner acting into the workspace can still push', async () => {
  // actingAs true, workspaceRole null — must not be mistaken for a viewer.
  assert.equal(await call('POST', '/api/pip', 'u-owner', PUSH), 200);
});

test.after(() => { server.close(); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {} });
