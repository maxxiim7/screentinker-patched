'use strict';

// #236: what the SERVER hands a wall panel.
//
// wall-geometry.test.js pins the maths; this pins the wiring — that a wall row saved before
// per-panel rotation existed still produces exactly the rectangles it produced before, and that a
// rotation which somehow got into the column can never reach a player as anything but 0/90/180/270.
// The failure this guards against is the worst kind for this feature: an operator upgrades and one
// panel of a working wall comes back on its side.

const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-wallpayload-' + crypto.randomBytes(4).toString('hex'));
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Server } = require('socket.io');
const { db } = require('../db/database');
const setupDeviceSocket = require('../ws/deviceSocket');

let httpServer, io, buildPlaylistPayload;

function addWall(id, rows) {
  db.prepare(`INSERT INTO video_walls (id, user_id, name, grid_cols, grid_rows, bezel_h_mm, bezel_v_mm, leader_device_id)
              VALUES (?, 'u', ?, 2, 1, 0, 0, ?)`).run(id, id, rows[0].device_id);
  for (const r of rows) {
    db.prepare(`INSERT INTO devices (id, status, wall_id, orientation) VALUES (?, 'online', ?, ?)`)
      .run(r.device_id, id, r.orientation || 'landscape');
    db.prepare(`INSERT INTO video_wall_devices
                  (wall_id, device_id, grid_col, grid_row, rotation, canvas_x, canvas_y, canvas_width, canvas_height)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, r.device_id, r.col, 0, r.rotation, r.x ?? null, r.y ?? null, r.w ?? null, r.h ?? null);
  }
}

before(async () => {
  httpServer = http.createServer(); io = new Server(httpServer); setupDeviceSocket(io);
  buildPlaylistPayload = setupDeviceSocket.buildPlaylistPayload;
  await new Promise((r) => httpServer.listen(0, r));

  db.pragma('foreign_keys = OFF');
  // A wall as it would have been saved before #236: no canvas_* columns at all, rotation 0. The
  // renderer has to derive the rects from grid position and the historic 320x180 base.
  addWall('legacy', [
    { device_id: 'legacy-a', col: 0, rotation: 0 },
    { device_id: 'legacy-b', col: 1, rotation: 0 },
  ]);
  // A wall drawn in the new editor: two portrait-mounted panels genuinely side by side.
  addWall('portrait', [
    { device_id: 'port-a', col: 0, rotation: 90, x: 0, y: 0, w: 1080, h: 1920, orientation: 'portrait' },
    { device_id: 'port-b', col: 1, rotation: 90, x: 1080, y: 0, w: 1080, h: 1920, orientation: 'portrait' },
  ]);
  // A rotation value nothing in the product can produce — a hand-run UPDATE, a bad import.
  addWall('junk', [
    { device_id: 'junk-a', col: 0, rotation: 45, x: 0, y: 0, w: 320, h: 180 },
    { device_id: 'junk-b', col: 1, rotation: 0, x: 320, y: 0, w: 320, h: 180 },
  ]);
  db.pragma('foreign_keys = ON');
});
after(() => { try { io.close(); } catch { /* */ } try { httpServer.close(); } catch { /* */ } });

test('REGRESSION: a pre-#236 wall row still produces the rectangles it always did', () => {
  // Grid-derived from the historic 320x180 base, player rect = bounding box of both tiles.
  const a = buildPlaylistPayload('legacy-a').wall_config;
  const b = buildPlaylistPayload('legacy-b').wall_config;
  assert.deepEqual(a.screen_rect, { x: 0, y: 0, w: 320, h: 180 });
  assert.deepEqual(b.screen_rect, { x: 320, y: 0, w: 320, h: 180 });
  assert.deepEqual(a.player_rect, { x: 0, y: 0, w: 640, h: 180 });
  assert.deepEqual(b.player_rect, a.player_rect, 'every panel gets the SAME player rect');
  assert.equal(a.rotation, 0, 'an untouched wall must stay unrotated');
  assert.equal(b.rotation, 0);
});

test('a portrait wall reaches the player as side-by-side tiles plus a rotation', () => {
  // The whole point of #236: the arrangement in the payload matches the physical arrangement,
  // instead of being transposed by the operator to compensate for the renderer.
  const a = buildPlaylistPayload('port-a').wall_config;
  const b = buildPlaylistPayload('port-b').wall_config;
  assert.deepEqual(a.screen_rect, { x: 0, y: 0, w: 1080, h: 1920 });
  assert.deepEqual(b.screen_rect, { x: 1080, y: 0, w: 1080, h: 1920 }, 'side by side, not stacked');
  assert.deepEqual(a.player_rect, { x: 0, y: 0, w: 2160, h: 1920 });
  assert.equal(a.rotation, 90);
  assert.equal(b.rotation, 90);
});

test('a junk rotation in the column degrades to 0 rather than reaching a live panel', () => {
  // "As drawn" is a recoverable wrong; one panel of a working wall lying on its side is not.
  assert.equal(buildPlaylistPayload('junk-a').wall_config.rotation, 0);
  assert.equal(buildPlaylistPayload('junk-b').wall_config.rotation, 0);
});

test('a device outside any wall still gets wall_config: null', () => {
  db.pragma('foreign_keys = OFF');
  db.prepare("INSERT INTO devices (id, status) VALUES ('solo', 'online')").run();
  db.pragma('foreign_keys = ON');
  assert.equal(buildPlaylistPayload('solo').wall_config, null);
});
