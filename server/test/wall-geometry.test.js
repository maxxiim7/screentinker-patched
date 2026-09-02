'use strict';

// #236: a wall of PORTRAIT panels side by side could not be described as side by side.
//
// The editor canvas was secretly framebuffer space rather than wall space, so a customer with two
// portrait-mounted panels next to each other had to stack them VERTICALLY in the editor and ship a
// pre-rotated copy of every video to get correct output. It worked, but only after trial and error,
// and it meant portrait walls could never reuse existing content.
//
// The maths below is the whole fix, so it is pinned here rather than eyeballed on a wall. The tests
// are written as one invariant applied to each rotation:
//
//     the panel's viewport must map onto EXACTLY its own rect of wall space
//
// which is checked by independently re-simulating the CSS box (rotate about centre, then translate)
// and inverting it — not by re-running the module's own arithmetic.
//
// The single most important test in this file is the regression one: every wall in the field today
// is rotation 0, and an operator who upgrades must not find a wall that was aligned yesterday has
// moved. That one asserts byte-identical output against the pre-#236 expression.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeWallRotation,
  orientationForWallMember,
  wallStageGeometry,
  wallStageStyle,
  rotatedFootprint,
} = require('../lib/wall-geometry');
const { ROTATION_DEG } = require('../lib/orientation-style');

// ---------------------------------------------------------------------------
// An independent simulation of what the browser will actually do with the styles.
// ---------------------------------------------------------------------------

function toPx(value, vw, vh) {
  const m = /^(-?[\d.]+)(vw|vh|%)$/.exec(value);
  assert.ok(m, `unhandled CSS length: ${value}`);
  const n = Number(m[1]) / 100;
  if (m[2] === 'vw') return n * vw;
  if (m[2] === 'vh') return n * vh;
  return n; // % handled by the caller
}

/**
 * Where does a wall-space point end up in the panel's framebuffer, given these styles?
 * The stage box's own local coordinates span the PLAYER rect, so wall -> local is a plain
 * proportional map, and local -> framebuffer is the CSS transform re-implemented by hand.
 */
function makeMapper(style, playerRect, vw, vh) {
  const bw = toPx(style.width, vw, vh);
  const bh = toPx(style.height, vw, vh);
  const left = toPx(style.left, vw, vh);
  const top = toPx(style.top, vw, vh);

  const hasTranslate = /translate\(-50%, -50%\)/.test(style.transform || '');
  // Without the translate, left/top position the box's TOP-LEFT; with it, its centre.
  const cx = hasTranslate ? left : left + bw / 2;
  const cy = hasTranslate ? top : top + bh / 2;

  const rotM = /rotate\((-?\d+)deg\)/.exec(style.transform || '');
  const deg = rotM ? Number(rotM[1]) : 0;
  const rad = (deg * Math.PI) / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);

  // CSS rotate() in a y-down space: (x,y) -> (x cos - y sin, x sin + y cos)
  const fwd = (lx, ly) => {
    const dx = lx - bw / 2, dy = ly - bh / 2;
    return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
  };
  const inv = (fx, fy) => {
    const dx = fx - cx, dy = fy - cy;
    return { x: bw / 2 + dx * cos + dy * sin, y: bh / 2 - dx * sin + dy * cos };
  };

  return {
    // wall-space point -> framebuffer pixel
    wallToFb(wx, wy) {
      const lx = ((wx - playerRect.x) / playerRect.w) * bw;
      const ly = ((wy - playerRect.y) / playerRect.h) * bh;
      return fwd(lx, ly);
    },
    // framebuffer pixel -> wall-space point
    fbToWall(fx, fy) {
      const l = inv(fx, fy);
      return {
        x: playerRect.x + (l.x / bw) * playerRect.w,
        y: playerRect.y + (l.y / bh) * playerRect.h,
      };
    },
  };
}

/** The rect of wall space that this panel's viewport actually shows. */
function visibleWallRect(style, playerRect, vw, vh) {
  const m = makeMapper(style, playerRect, vw, vh);
  const corners = [m.fbToWall(0, 0), m.fbToWall(vw, 0), m.fbToWall(0, vh), m.fbToWall(vw, vh)];
  const xs = corners.map(c => c.x), ys = corners.map(c => c.y);
  return {
    x: Math.min(...xs), y: Math.min(...ys),
    w: Math.max(...xs) - Math.min(...xs),
    h: Math.max(...ys) - Math.min(...ys),
  };
}

function assertRectClose(actual, expected, msg) {
  for (const k of ['x', 'y', 'w', 'h']) {
    assert.ok(Math.abs(actual[k] - expected[k]) < 1e-6,
      `${msg}: ${k} was ${actual[k]}, expected ${expected[k]}`);
  }
}

// ---------------------------------------------------------------------------
// THE REGRESSION TEST — existing landscape walls must not move.
// ---------------------------------------------------------------------------

// The expression exactly as the web player computed it before #236 existed.
function legacyStyle(s, p) {
  return {
    left: (((p.x - s.x) / s.w) * 100) + 'vw',
    top: (((p.y - s.y) / s.h) * 100) + 'vh',
    width: ((p.w / s.w) * 100) + 'vw',
    height: ((p.h / s.h) * 100) + 'vh',
    transform: '',
    transformOrigin: '',
  };
}

test('REGRESSION: a landscape 2x2 wall produces byte-identical styles to before #236', () => {
  // Four 320x180 tiles, player fitted to the bounding box — the shape Auto-arrange produces.
  const player = { x: 0, y: 0, w: 640, h: 360 };
  const tiles = [
    { x: 0, y: 0, w: 320, h: 180 },
    { x: 320, y: 0, w: 320, h: 180 },
    { x: 0, y: 180, w: 320, h: 180 },
    { x: 320, y: 180, w: 320, h: 180 },
  ];
  for (const s of tiles) {
    // rotation absent, 0, null and a junk value must all land on the untouched path — a wall row
    // written before the column meant anything must not be re-laid-out by an upgrade.
    for (const rot of [undefined, 0, null, 'nonsense']) {
      assert.deepEqual(wallStageStyle(s, player, rot), legacyStyle(s, player),
        `tile ${JSON.stringify(s)} rotation=${rot}`);
    }
  }
});

test('REGRESSION: a bezelled, offset, non-integer landscape wall is also untouched', () => {
  // Free-form drags produce awkward numbers; those are exactly where float drift would show up as a
  // hairline seam, so the untouched path has to cover them too.
  const player = { x: -37, y: 12, w: 1993, h: 1121 };
  const s = { x: 993, y: 12, w: 1000, h: 563 };
  assert.deepEqual(wallStageStyle(s, player, 0), legacyStyle(s, player));
});

test('the unrotated centre-based geometry agrees with the legacy top-left expression', () => {
  // The fast path above is a deliberate duplicate; this proves it is a duplicate and not a fork.
  const player = { x: 0, y: 0, w: 640, h: 360 };
  const s = { x: 320, y: 0, w: 320, h: 180 };
  const g = wallStageGeometry(s, player, 0);
  assert.equal((g.cx - g.w / 2) * 100, -100, 'left');
  assert.equal((g.cy - g.h / 2) * 100, 0, 'top');
  assert.equal(g.w * 100, 200, 'width');
  assert.equal(g.h * 100, 200, 'height');
});

// ---------------------------------------------------------------------------
// THE BUG: two portrait panels, side by side, described as side by side.
// ---------------------------------------------------------------------------

test('THE BUG: two portrait-mounted panels side by side each show their own half', () => {
  // Two 1920x1080 panels turned on their side and hung next to each other. In wall space each is a
  // 1080-wide, 1920-tall rect; the player spans both. Before #236 this arrangement was impossible
  // to express — the operator had to stack them vertically and pre-rotate the video.
  const VW = 1920, VH = 1080;      // the framebuffer is still landscape; the PANEL is turned
  const left  = { x: 0,    y: 0, w: 1080, h: 1920 };
  const right = { x: 1080, y: 0, w: 1080, h: 1920 };
  const player = { x: 0, y: 0, w: 2160, h: 1920 };

  const leftStyle = wallStageStyle(left, player, 90);
  const rightStyle = wallStageStyle(right, player, 90);

  assertRectClose(visibleWallRect(leftStyle, player, VW, VH), left,
    'left panel must show the LEFT half of the wall');
  assertRectClose(visibleWallRect(rightStyle, player, VW, VH), right,
    'right panel must show the RIGHT half of the wall');

  // ...and nothing is mirrored: the wall's top-left corner has to appear at the framebuffer's
  // top-right on a panel turned this way. A sign error here shows a perfect mirror image, which
  // reads as "the panels are in the wrong order" and sends you back to the editor.
  const m = makeMapper(leftStyle, player, VW, VH);
  const topLeft = m.wallToFb(0, 0);
  assert.ok(Math.abs(topLeft.x - VW) < 1e-6, `wall top-left x: ${topLeft.x}`);
  assert.ok(Math.abs(topLeft.y - 0) < 1e-6, `wall top-left y: ${topLeft.y}`);
});

test('a portrait wall needs no pre-rotated content: wall +X runs down the framebuffer', () => {
  // The customer had to rotate every source video so its top faced left. That is only necessary if
  // the renderer ignores the mounting; with rotation applied, wall-right maps to framebuffer-down
  // and unmodified landscape content comes out upright across the panels.
  const player = { x: 0, y: 0, w: 2160, h: 1920 };
  const s = { x: 0, y: 0, w: 1080, h: 1920 };
  const m = makeMapper(wallStageStyle(s, player, 90), player, 1920, 1080);
  const o = m.wallToFb(0, 0);
  const right = m.wallToFb(100, 0);   // move RIGHT along the wall
  const down = m.wallToFb(0, 100);    // move DOWN the wall
  assert.ok(right.y > o.y && Math.abs(right.x - o.x) < 1e-6, 'wall +X must be framebuffer +down');
  assert.ok(down.x < o.x && Math.abs(down.y - o.y) < 1e-6, 'wall +Y must be framebuffer +left');
});

// ---------------------------------------------------------------------------
// Every rotation, and mixtures of them.
// ---------------------------------------------------------------------------

test('every rotation maps the viewport onto exactly the panel\'s own rect of wall space', () => {
  const player = { x: -50, y: -20, w: 1400, h: 900 };
  const s = { x: 100, y: 60, w: 400, h: 300 };
  for (const rot of [0, 90, 180, 270]) {
    // A turned panel's framebuffer is landscape while its wall rect is portrait, so the viewport
    // used here is the framebuffer's, not the tile's.
    const vw = (rot === 90 || rot === 270) ? s.h : s.w;
    const vh = (rot === 90 || rot === 270) ? s.w : s.h;
    assertRectClose(visibleWallRect(wallStageStyle(s, player, rot), player, vw, vh), s,
      `rotation ${rot}`);
  }
});

test('180 turns the content over without swapping the box dimensions', () => {
  // Giving a half-turn the quarter-turn treatment swaps width and height for no reason and squashes
  // the tile — the "wall is right but every panel is stretched" symptom.
  const g = wallStageGeometry({ x: 0, y: 0, w: 320, h: 180 }, { x: 0, y: 0, w: 640, h: 360 }, 180);
  assert.equal(g.wAxis, 'x');
  assert.equal(g.hAxis, 'y');
  const s = wallStageStyle({ x: 0, y: 0, w: 320, h: 180 }, { x: 0, y: 0, w: 640, h: 360 }, 180);
  assert.match(s.width, /vw$/);
  assert.match(s.height, /vh$/);
});

test('a quarter turn measures wall-horizontal against the framebuffer VERTICAL', () => {
  const g = wallStageGeometry({ x: 0, y: 0, w: 1080, h: 1920 }, { x: 0, y: 0, w: 2160, h: 1920 }, 90);
  assert.equal(g.wAxis, 'y', 'wall width is measured down the framebuffer on a turned panel');
  assert.equal(g.hAxis, 'x');
  const s = wallStageStyle({ x: 0, y: 0, w: 1080, h: 1920 }, { x: 0, y: 0, w: 2160, h: 1920 }, 90);
  assert.match(s.width, /vh$/, 'width in vh, or the tile is sized against the wrong axis');
  assert.match(s.height, /vw$/);
});

test('a MIXED wall works: one landscape panel beside two stacked portrait ones', () => {
  // Real installs are not homogeneous. A landscape 1920x1080 on the left, and to its right two
  // portrait-mounted panels stacked — one turned each way, which is what happens when an installer
  // hangs the top one upside down to keep the cable runs short.
  const player = { x: 0, y: 0, w: 3000, h: 1080 };
  const cases = [
    { rect: { x: 0, y: 0, w: 1920, h: 1080 }, rot: 0, vw: 1920, vh: 1080 },
    { rect: { x: 1920, y: 0, w: 540, h: 540 }, rot: 90, vw: 540, vh: 540 },
    { rect: { x: 2460, y: 0, w: 540, h: 1080 }, rot: 270, vw: 1080, vh: 540 },
  ];
  for (const c of cases) {
    assertRectClose(visibleWallRect(wallStageStyle(c.rect, player, c.rot), player, c.vw, c.vh),
      c.rect, `mixed wall tile rotation ${c.rot}`);
  }
});

test('a tile that only partly overlaps the player still maps its own rect', () => {
  // "Fit to player" is optional — operators deliberately leave a panel hanging off the content so
  // it shows black. The mapping must still be the panel's rect, not the overlap.
  const player = { x: 0, y: 0, w: 1000, h: 600 };
  const s = { x: 800, y: 400, w: 400, h: 400 };
  assertRectClose(visibleWallRect(wallStageStyle(s, player, 90), player, 400, 400), s, 'overhang');
});

// ---------------------------------------------------------------------------
// Conventions and guards.
// ---------------------------------------------------------------------------

test('wall rotation uses the SAME sign convention as the device orientation setting', () => {
  // Two settings that both mean "this panel is mounted turned" but disagree on which way is 90
  // would be a permanent source of upside-down walls.
  assert.equal(ROTATION_DEG.portrait, 90);
  assert.equal(ROTATION_DEG['landscape-flipped'], 180);
  assert.equal(ROTATION_DEG['portrait-flipped'], 270);
  const s = wallStageStyle({ x: 0, y: 0, w: 1080, h: 1920 }, { x: 0, y: 0, w: 1080, h: 1920 }, 90);
  assert.match(s.transform, /rotate\(90deg\)$/);
});

test('the translate comes BEFORE the rotate, or the offset is rotated too', () => {
  const s = wallStageStyle({ x: 0, y: 0, w: 1080, h: 1920 }, { x: 0, y: 0, w: 2160, h: 1920 }, 270);
  assert.equal(s.transform, 'translate(-50%, -50%) rotate(270deg)');
});

test('an unrecognised rotation falls back to 0 rather than turning a live panel sideways', () => {
  for (const bad of [45, -90, '90deg', NaN, undefined, null, {}, 360]) {
    assert.equal(normalizeWallRotation(bad), 0, String(bad));
  }
  for (const good of [0, 90, 180, 270, '90', '270']) {
    assert.equal(normalizeWallRotation(good), Number(good));
  }
});

test('a zero-sized screen rect yields null instead of dividing by zero', () => {
  // A wall row saved with canvas_width 0 would otherwise produce Infinity styles and a blank panel.
  const p = { x: 0, y: 0, w: 100, h: 100 };
  assert.equal(wallStageStyle({ x: 0, y: 0, w: 0, h: 100 }, p, 0), null);
  assert.equal(wallStageStyle({ x: 0, y: 0, w: 100, h: 0 }, p, 90), null);
  assert.equal(wallStageGeometry({ x: 0, y: 0, w: 0, h: 0 }, p, 90), null);
  assert.equal(wallStageStyle(null, p, 0), null);
});

test('wall rotation suppresses the device orientation transform, but only when set', () => {
  // Both settings describe the same physical fact; applying both turns the content twice.
  assert.equal(orientationForWallMember('portrait', 90), 'landscape');
  assert.equal(orientationForWallMember('portrait-flipped', 270), 'landscape');
  // Rotation 0 must change nothing at all — that is what keeps today's walls behaving as today.
  assert.equal(orientationForWallMember('portrait', 0), 'portrait');
  assert.equal(orientationForWallMember('landscape-flipped', undefined), 'landscape-flipped');
  assert.equal(orientationForWallMember(undefined, 0), 'landscape');
});

test('the Tizen player\'s hand-ported copy of this rule still agrees with it', () => {
  // The .wgt is packaged and cannot load the shared script the web player pulls, so Tizen carries a
  // hand-written copy. Two players disagreeing by a pixel is a visible line down the middle of a
  // wall, and nothing else in the build would notice the drift — so the copy is executed here
  // against the canonical rule rather than trusted.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'tizen', 'js', 'player.js'), 'utf8');
  const m = /WallController\.prototype\.styleStage = function \(config\) \{[\s\S]*?\n\};/.exec(src);
  assert.ok(m, 'could not find WallController.prototype.styleStage in the Tizen player');

  const WallController = { prototype: {} };
  // eslint-disable-next-line no-new-func
  new Function('WallController', m[0])(WallController);

  const cases = [
    { s: { x: 0, y: 0, w: 320, h: 180 }, p: { x: 0, y: 0, w: 640, h: 360 }, rot: 0 },
    { s: { x: 320, y: 180, w: 320, h: 180 }, p: { x: 0, y: 0, w: 640, h: 360 }, rot: 0 },
    { s: { x: 1080, y: 0, w: 1080, h: 1920 }, p: { x: 0, y: 0, w: 2160, h: 1920 }, rot: 90 },
    { s: { x: 0, y: 0, w: 400, h: 300 }, p: { x: -50, y: -20, w: 1400, h: 900 }, rot: 180 },
    { s: { x: 2460, y: 0, w: 540, h: 1080 }, p: { x: 0, y: 0, w: 3000, h: 1080 }, rot: 270 },
    { s: { x: 0, y: 0, w: 320, h: 180 }, p: { x: 0, y: 0, w: 640, h: 360 }, rot: 45 }, // junk -> 0
  ];
  for (const c of cases) {
    const ctx = { stage: { classList: { add() {}, remove() {} }, style: {} } };
    WallController.prototype.styleStage.call(ctx, { screen_rect: c.s, player_rect: c.p, rotation: c.rot });
    const want = wallStageStyle(c.s, c.p, c.rot);
    for (const k of ['left', 'top', 'width', 'height', 'transform', 'transformOrigin']) {
      assert.equal(ctx.stage.style[k], want[k], `rotation ${c.rot}: ${k}`);
    }
  }
});

test('a turned panel\'s wall footprint is its framebuffer with the sides swapped', () => {
  assert.deepEqual(rotatedFootprint(1920, 1080, 0), { w: 1920, h: 1080 });
  assert.deepEqual(rotatedFootprint(1920, 1080, 90), { w: 1080, h: 1920 });
  assert.deepEqual(rotatedFootprint(1920, 1080, 180), { w: 1920, h: 1080 });
  assert.deepEqual(rotatedFootprint(1920, 1080, 270), { w: 1080, h: 1920 });
});
