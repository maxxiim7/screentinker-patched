'use strict';

// Hand-written HTML in the Text/HTML widget was rendered far too small to read.
//
// The Content Designer used to publish absolute sizes as fontSize*10.8 px, and renderText converted
// px/108 back to vw to restore the intended size and let those widgets scale. That rescue is
// correct — but it ran over EVERY text widget, including markup a person typed themselves. So
// `font-size:16px` became 0.15vw: 2.8px on a 1080p screen, 1.9px on a 1280 one. Not clipped, not
// hidden — rendered at a size nobody can read, in the one widget whose entire purpose is
// hand-written HTML.
//
// Today's designer emits cqw, not px (frontend/js/views/designer.js), so the conversion only ever
// needed to apply to legacy designer output. That is identified by absolutely-positioned elements,
// the same signal the dashboard uses to decide whether a text widget can be reopened in the
// designer.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'st-textwidget-'));
process.env.DATA_DIR = tmp;
process.env.JWT_SECRET = 'test-secret-text-widget';

const express = require('express');
const { db } = require('../db/database');
const { requireAuth, generateToken } = require('../middleware/auth');

function seed() {
  const u = 'u-tw', o = 'o-tw', ws = 'ws-tw';
  db.prepare("INSERT OR IGNORE INTO users (id, email, password_hash, role) VALUES (?,?, 'x','user')").run(u, 'tw@test.local');
  db.prepare('INSERT OR IGNORE INTO organizations (id, name, owner_user_id) VALUES (?,?,?)').run(o, 'org', u);
  db.prepare('INSERT OR IGNORE INTO workspaces (id, organization_id, name) VALUES (?,?,?)').run(ws, o, 'ws');
  db.prepare("INSERT OR IGNORE INTO organization_members (organization_id, user_id, role) VALUES (?,?, 'org_owner')").run(o, u);
  return { u, ws };
}
const { u, ws } = seed();

function makeWidget(id, html) {
  db.prepare(`INSERT OR REPLACE INTO widgets (id, user_id, workspace_id, widget_type, name, config, created_at, updated_at)
              VALUES (?, ?, ?, 'text', ?, ?, strftime('%s','now'), strftime('%s','now'))`)
    .run(id, u, ws, id, JSON.stringify({ html, background: '#000' }));
  return id;
}

const app = express();
app.use(express.json());
app.use('/api/widgets', requireAuth, require('../routes/widgets'));
const server = app.listen(0);
const token = generateToken(db.prepare('SELECT id, email, role FROM users WHERE id = ?').get(u), ws);

async function render(id) {
  await new Promise(r => (server.listening ? r() : server.once('listening', r)));
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/widgets/${id}/render`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return res.text();
}

test('THE BUG: hand-written px font sizes must survive untouched', async () => {
  const id = makeWidget('w-hand', '<h1 style="color:#fff;font-size:40px">Notice</h1>');
  const out = await render(id);
  assert.match(out, /font-size:40px/, 'a hand-typed 40px must render as 40px');
  assert.doesNotMatch(out, /font-size:0\.37vw/, '40px/108 = 0.37vw is ~7px on 1080p — unreadable');
});

test('a small hand-written size is not shrunk into invisibility', async () => {
  const id = makeWidget('w-hand-small', '<p style="color:#fff;font-size:16px">Body copy</p>');
  const out = await render(id);
  assert.match(out, /font-size:16px/);
  assert.doesNotMatch(out, /font-size:0\.15vw/, '0.15vw is 2.8px on a 1080p screen');
});

test('LEGACY designer output is still rescued, so old widgets keep scaling', async () => {
  // Absolutely-positioned elements are the designer's signature. 54px was fontSize 5 * 10.8.
  const id = makeWidget('w-designer',
    '<div style="position:absolute;left:10%;top:20%;font-size:54px;color:#fff">Designed</div>');
  const out = await render(id);
  assert.match(out, /font-size:0\.50vw/, 'legacy designer px must still convert back to vw');
  assert.doesNotMatch(out, /font-size:54px/);
});

test('a designer widget with several sizes converts all of them', async () => {
  const id = makeWidget('w-designer-multi',
    '<div style="position:absolute;left:0;font-size:108px">A</div>' +
    '<div style="position:absolute;left:50%;font-size:21.6px">B</div>');
  const out = await render(id);
  assert.match(out, /font-size:1\.00vw/);
  assert.match(out, /font-size:0\.20vw/);
});

test('hand-written markup that merely mentions absolute positioning elsewhere is not misread', async () => {
  // The signal is `position:absolute` immediately followed by `left:` — the designer's own shape.
  // A hand-written absolute element without that pairing keeps its px.
  const id = makeWidget('w-hand-abs', '<div style="position:absolute;top:10px;font-size:32px">X</div>');
  const out = await render(id);
  assert.match(out, /font-size:32px/, 'only the designer\'s left-first shape triggers the rescue');
});

test.after(() => { server.close(); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {} });
