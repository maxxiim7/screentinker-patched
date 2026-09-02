'use strict';

// Rotating a box does not move it, and that is the whole bug.
//
// The web player set `width:100vh; height:100vw` and `rotate(90deg)` on a container pinned
// `inset: 0`. The box stayed in the top-left corner and spun about ITS OWN centre rather than the
// viewport's, so on a 1920x1080 panel the content landed 420px off-screen left and 420px off the
// bottom — correctly rotated, wrongly placed, cropped on two edges. Reported as "rotation doesn't
// work"; it looked like a rendering bug rather than a geometry one.
//
// Tizen already did this correctly (top/left 50% + translate(-50%,-50%)) and Android does the
// equivalent with translationX/Y of (w-h)/2. The web player was the odd one out, which is why the
// rule now lives in one place with the arithmetic pinned below.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { orientationStyle } = require('../lib/orientation-style');

/** Where does the rotated box actually land, given these styles on a viewport? */
function occupies(style, vw, vh) {
  const px = (v) => {
    if (v === '100vh') return vh;
    if (v === '100vw') return vw;
    return null;
  };
  const bw = px(style.width) ?? vw;
  const bh = px(style.height) ?? vh;
  // top/left 50% place the box's ORIGIN at the viewport centre; translate(-50%,-50%) then pulls it
  // back by half its own size, so the box centre coincides with the viewport centre.
  const centreX = style.left === '50%' ? vw / 2 : bw / 2;
  const centreY = style.top === '50%' ? vh / 2 : bh / 2;
  const rot = /rotate\((\d+)deg\)/.exec(style.transform || '');
  const deg = rot ? Number(rot[1]) : 0;
  const swap = deg === 90 || deg === 270;
  const spanX = swap ? bh : bw;
  const spanY = swap ? bw : bh;
  return {
    x0: centreX - spanX / 2, x1: centreX + spanX / 2,
    y0: centreY - spanY / 2, y1: centreY + spanY / 2,
  };
}

test('THE BUG: portrait covers the viewport exactly, instead of hanging off two edges', () => {
  const box = occupies(orientationStyle('portrait'), 1920, 1080);
  assert.equal(box.x0, 0, 'left edge — was -420 before the fix');
  assert.equal(box.x1, 1920);
  assert.equal(box.y0, 0, 'top edge — was 420 before the fix');
  assert.equal(box.y1, 1080);
});

test('portrait-flipped lands identically — only the content direction differs', () => {
  const box = occupies(orientationStyle('portrait-flipped'), 1920, 1080);
  assert.deepEqual(box, { x0: 0, x1: 1920, y0: 0, y1: 1080 });
});

test('the translate comes BEFORE the rotate, or the offset is rotated too', () => {
  // transform functions apply right-to-left: rotate about the box centre, THEN move that centre.
  // Swapping them turns the -50%,-50% correction by 90 degrees and puts the content back off-screen.
  const t = orientationStyle('portrait').transform;
  assert.match(t, /^translate\(-50%, -50%\) rotate\(90deg\)$/);
});

test('portrait swaps the box dimensions', () => {
  const s = orientationStyle('portrait');
  assert.equal(s.width, '100vh');
  assert.equal(s.height, '100vw');
});

test('180 does NOT swap dimensions — the box already fits, it just turns over', () => {
  // Giving it the portrait treatment would swap width and height for no reason and letterbox it.
  const s = orientationStyle('landscape-flipped');
  assert.equal(s.transform, 'rotate(180deg)');
  assert.equal(s.width, '');
  assert.equal(s.height, '');
  const box = occupies(s, 1920, 1080);
  assert.deepEqual(box, { x0: 0, x1: 1920, y0: 0, y1: 1080 });
});

test('landscape clears EVERY property the rotated state set', () => {
  // A half-reset leaves the container stuck at 100vh wide — rotation appears to "stick" after
  // switching back, which is its own bug report.
  const rotated = orientationStyle('portrait');
  const reset = orientationStyle('landscape');
  for (const k of Object.keys(rotated)) {
    assert.equal(reset[k], '', `${k} must be cleared, or it survives the switch back to landscape`);
  }
});

test('an unknown orientation falls back to landscape rather than throwing', () => {
  // A bad value from the server should leave a readable screen, not a blank or sideways one.
  assert.deepEqual(orientationStyle('sideways-ish'), orientationStyle('landscape'));
  assert.deepEqual(orientationStyle(undefined), orientationStyle('landscape'));
});

test('the geometry holds on a non-16:9 panel too', () => {
  const box = occupies(orientationStyle('portrait'), 1280, 1024);
  assert.deepEqual(box, { x0: 0, x1: 1280, y0: 0, y1: 1024 });
});
