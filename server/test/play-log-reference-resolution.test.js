'use strict';

// A proof-of-play row must survive an id the player can no longer vouch for.
//
// Players replay a CACHED playlist, so the id reported on play_start can outlive the row it
// names: delete the content and the next play_start still reports its id. `play_logs.content_id`
// carries a foreign key to `content(id)`, so handing the reported id straight to the INSERT made
// it throw — and the whole event was lost, silently, inside a catch that logged no identifiers.
// Observed on production: ~360 failures in six hours and ZERO rows written in 24h, i.e. Reports
// recording nothing at all.
//
// Widgets had a second, quieter version of the same bug: `widget_id` exists and was never
// written, so a widget play could not be attributed even when it did insert.
//
// The rule these tests pin: resolve the reported id against what exists, write whichever column
// it belongs to, and if it matches neither still write the row — content_name preserves WHAT
// played. A row with a null reference beats no row.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');

let db, dir;

// The schema fragment under test, matching db/schema.sql for these tables.
before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-playlog-'));
  db = new Database(path.join(dir, 't.db'));
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE devices (id TEXT PRIMARY KEY);
    CREATE TABLE content (id TEXT PRIMARY KEY);
    CREATE TABLE widgets (id TEXT PRIMARY KEY);
    CREATE TABLE play_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      content_id TEXT REFERENCES content(id) ON DELETE SET NULL,
      widget_id TEXT REFERENCES widgets(id) ON DELETE SET NULL,
      zone_id TEXT,
      content_name TEXT NOT NULL DEFAULT '',
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      duration_sec INTEGER,
      completed INTEGER NOT NULL DEFAULT 0,
      trigger_type TEXT DEFAULT 'playlist',
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    INSERT INTO devices VALUES ('dev-1');
    INSERT INTO content VALUES ('content-live');
    INSERT INTO widgets VALUES ('widget-live');
  `);
});
after(() => { try { db.close(); } catch { /* */ } fs.rmSync(dir, { recursive: true, force: true }); });

// Mirrors the resolution the ws/deviceSocket.js play_start handler performs.
function recordPlayStart({ device_id, reported_id, content_name, zone_id = null }) {
  const contentExists = db.prepare('SELECT 1 FROM content WHERE id = ?').pluck();
  const widgetExists = db.prepare('SELECT 1 FROM widgets WHERE id = ?').pluck();
  const isContent = reported_id ? !!contentExists.get(reported_id) : false;
  const isWidget = (!isContent && reported_id) ? !!widgetExists.get(reported_id) : false;
  db.prepare(`
    INSERT INTO play_logs (device_id, content_id, widget_id, zone_id, content_name, started_at, trigger_type)
    VALUES (?, ?, ?, ?, ?, strftime('%s','now'), 'playlist')
  `).run(device_id, isContent ? reported_id : null, isWidget ? reported_id : null,
         zone_id, content_name || 'Unknown');
  return db.prepare('SELECT * FROM play_logs ORDER BY id DESC LIMIT 1').get();
}

test('a live content id is recorded against content_id', () => {
  const row = recordPlayStart({ device_id: 'dev-1', reported_id: 'content-live', content_name: 'clip.mp4' });
  assert.equal(row.content_id, 'content-live');
  assert.equal(row.widget_id, null);
});

test('a widget id is attributed to widget_id, not silently dropped into content_id', () => {
  const row = recordPlayStart({ device_id: 'dev-1', reported_id: 'widget-live', content_name: 'Directory Search' });
  assert.equal(row.widget_id, 'widget-live', 'the widget is attributed');
  assert.equal(row.content_id, null, 'and does not land in the content reference');
});

test('THE BUG: an id whose row was deleted still produces a row', () => {
  // Exactly the production shape: the player is replaying a cached playlist naming content
  // that no longer exists. Before the fix this threw and the event was lost entirely.
  const row = recordPlayStart({ device_id: 'dev-1', reported_id: 'content-deleted-yesterday', content_name: 'gone.jpg' });
  assert.ok(row, 'a row is written rather than the insert throwing');
  assert.equal(row.content_id, null, 'the dangling reference is dropped');
  assert.equal(row.widget_id, null);
  assert.equal(row.content_name, 'gone.jpg', 'but WHAT played is still recorded');
});

test('a play with no id at all is still recorded', () => {
  const row = recordPlayStart({ device_id: 'dev-1', reported_id: null, content_name: 'unnamed' });
  assert.equal(row.content_id, null);
  assert.equal(row.content_name, 'unnamed');
});

test('an unknown device is still refused — that FK is a real invariant', () => {
  // Not every FK failure is a bug to route around. A play event for a device that does not
  // exist is meaningless, and must not create an orphan row.
  assert.throws(() => recordPlayStart({ device_id: 'dev-does-not-exist', reported_id: 'content-live', content_name: 'x' }),
    /FOREIGN KEY constraint failed/);
});

test('play_end can close a widget row, not only a content row', () => {
  // Its own widget: an earlier test also leaves an open 'widget-live' row, and both land in
  // the same second, so sharing one would make the ORDER BY ambiguous and the test flaky.
  db.prepare('INSERT INTO widgets VALUES (?)').run('widget-close');
  const opened = recordPlayStart({ device_id: 'dev-1', reported_id: 'widget-close', content_name: 'Directory Search' });
  // The handler matches on EITHER column; matching content_id alone could never close this.
  const res = db.prepare(`
    UPDATE play_logs SET ended_at = strftime('%s','now'), completed = 1
    WHERE id = (
      SELECT id FROM play_logs
      WHERE device_id = ? AND ended_at IS NULL AND (content_id = ? OR widget_id = ?)
      ORDER BY started_at DESC LIMIT 1
    )
  `).run('dev-1', 'widget-close', 'widget-close');
  assert.equal(res.changes, 1, 'the open widget row was closed');
  const after = db.prepare('SELECT ended_at, completed FROM play_logs WHERE id = ?').get(opened.id);
  assert.ok(after.ended_at, 'ended_at set');
  assert.equal(after.completed, 1);
});

test('two plays of the same item inside one second close in insertion order', () => {
  // started_at is second-granular, so the pair ties on it. Without the id tiebreak the UPDATE
  // could close either row — which is exactly how the widget test above first went flaky.
  db.prepare('INSERT INTO widgets VALUES (?)').run('widget-tie');
  const first = recordPlayStart({ device_id: 'dev-1', reported_id: 'widget-tie', content_name: 'tie' });
  const second = recordPlayStart({ device_id: 'dev-1', reported_id: 'widget-tie', content_name: 'tie' });
  assert.ok(second.id > first.id, 'both rows exist, inserted in order');

  const close = () => db.prepare(`
    UPDATE play_logs SET ended_at = strftime('%s','now'), completed = 1
    WHERE id = (
      SELECT id FROM play_logs
      WHERE device_id = ? AND ended_at IS NULL AND (content_id = ? OR widget_id = ?)
      ORDER BY started_at DESC, id DESC LIMIT 1
    )
  `).run('dev-1', 'widget-tie', 'widget-tie');

  close();
  assert.ok(db.prepare('SELECT ended_at FROM play_logs WHERE id = ?').get(second.id).ended_at,
    'the newer row closes first');
  close();
  assert.ok(db.prepare('SELECT ended_at FROM play_logs WHERE id = ?').get(first.id).ended_at,
    'then the older one');
});
