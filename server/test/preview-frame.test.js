'use strict';

// #238: the dashboard preview of a 90/270 display was sideways while the panel itself was right.
//
// A portrait panel is a landscape framebuffer that the player rotates content INSIDE (+90), hung on
// the wall turned the other way (-90). The two cancel and a person in front of it sees upright
// portrait. The dashboard modelled only the first half: it iframed the player into a box it had
// already given the finished 9/16 shape, so the player rotated a second time inside it and the
// preview came out at 90 degrees to the panel. Designers verify their work on these surfaces, so
// every anomaly on a portrait screen became "is that the screen or the preview?".
//
// The frame therefore stands in for the mount and turns by the INVERSE angle. The tempting mistake
// is to turn it the SAME way: 90+90 lands upside-down, which reads as nearly-right and ships.
//
// Geometry, not CSS strings: what matters is where the rotated box lands and which way the content
// ends up pointing.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { previewFrameStyle, previewAspectRatio, orientationStyle, ROTATION_DEG } = require('../lib/orientation-style');

const px = (v) => Number(String(v).replace('px', ''));
const rotationOf = (style) => {
  const m = /rotate\((-?\d+)deg\)/.exec(style.transform || '');
  return m ? ((Number(m[1]) % 360) + 360) % 360 : 0;
};

/** Where does the frame land inside the stage, and is it centred on it? */
function occupies(style, stageW, stageH) {
  const bw = style.width ? px(style.width) : stageW;
  const bh = style.height ? px(style.height) : stageH;
  // top/left 50% put the box ORIGIN at the stage centre; translate(-50%,-50%) pulls it back by half
  // its own size, so the box centre lands on the stage centre.
  const centreX = style.left === '50%' ? stageW / 2 : bw / 2;
  const centreY = style.top === '50%' ? stageH / 2 : bh / 2;
  const deg = rotationOf(style);
  const swap = deg === 90 || deg === 270;
  const spanX = swap ? bh : bw;
  const spanY = swap ? bw : bh;
  return {
    x0: centreX - spanX / 2, x1: centreX + spanX / 2,
    y0: centreY - spanY / 2, y1: centreY + spanY / 2,
  };
}

/**
 * Which way the CONTENT points for a viewer of the dashboard: the player's own rotation inside the
 * framebuffer, plus whatever the dashboard does to the frame. 0 means it matches the panel.
 */
const contentAngle = (orientation, frameStyle) =>
  (ROTATION_DEG[orientation] + rotationOf(frameStyle)) % 360;

// A portrait stage as the viewer sees it: a 16:9 panel hung on its side.
const STAGE = { width: 405, height: 720 };

test('THE BUG: portrait preview points the same way as the panel, not 90 degrees off', () => {
  const style = previewFrameStyle('portrait', STAGE);
  assert.equal(contentAngle('portrait', style), 0);

  // What the dashboard used to do: give the iframe the as-displayed shape and no rotation of its
  // own. The player still rotated inside it, so the content sat at 90 degrees to the panel.
  assert.equal(contentAngle('portrait', { transform: '' }), 90);
});

test('the frame turns the OTHER way from the player — same way lands upside-down', () => {
  const inverse = { 'portrait': 270, 'portrait-flipped': 90, 'landscape-flipped': 180 };
  for (const [orientation, deg] of Object.entries(inverse)) {
    const style = previewFrameStyle(orientation, STAGE);
    assert.equal(rotationOf(style), deg, orientation);
    assert.equal(contentAngle(orientation, style), 0, orientation);
  }
  // The near-miss this exists to catch: repeating the player's angle instead of cancelling it.
  assert.equal(contentAngle('portrait', { transform: 'rotate(90deg)' }), 180);
});

test('the rotated frame covers the stage exactly — no bleed, no letterbox', () => {
  for (const orientation of Object.keys(ROTATION_DEG)) {
    const stage = orientation.includes('portrait') ? STAGE : { width: 720, height: 405 };
    const box = occupies(previewFrameStyle(orientation, stage), stage.width, stage.height);
    assert.deepEqual(box, { x0: 0, x1: stage.width, y0: 0, y1: stage.height }, orientation);
  }
});

test('the frame is the FRAMEBUFFER shape, so the player composes into the panel\'s own box', () => {
  // Not a cosmetic detail: the player lays zones, aspect and object-fit out against its viewport.
  // Handing it the portrait 405x720 stage would compose the content for a canvas no panel has.
  const style = previewFrameStyle('portrait', STAGE);
  assert.equal(px(style.width), STAGE.height);
  assert.equal(px(style.height), STAGE.width);
  // ...and inside that landscape frame the player's own rule builds the portrait container back.
  const player = orientationStyle('portrait');
  assert.equal(player.width, '100vh');   // = frame height = 405, the stage width
  assert.equal(player.height, '100vw');  // = frame width  = 720, the stage height
});

test('180 does not swap the axes — the frame already fits, it just turns over', () => {
  const stage = { width: 720, height: 405 };
  const style = previewFrameStyle('landscape-flipped', stage);
  assert.equal(px(style.width), 720);
  assert.equal(px(style.height), 405);
  assert.equal(rotationOf(style), 180);
});

test('the translate comes BEFORE the rotate, or the centring offset is rotated too', () => {
  assert.match(previewFrameStyle('portrait', STAGE).transform, /^translate\(-50%, -50%\) rotate\(270deg\)$/);
});

test('landscape clears EVERY property the rotated state set', () => {
  // A device switched back to landscape must not keep a stale swapped size: a half-reset leaves the
  // frame pinned at the old height and the preview looks broken until a reload.
  const rotated = previewFrameStyle('portrait', STAGE);
  const landscape = previewFrameStyle('landscape', STAGE);
  for (const key of Object.keys(rotated)) {
    assert.equal(landscape[key], '', key + ' must be cleared');
  }
});

test('an unmeasured stage (hidden tab) clears rather than pinning a 0px frame', () => {
  // Now Playing lives in an inactive tab and measures 0x0 until it is shown. Sizing to that would
  // render an invisible preview that never recovers; the resize observer re-applies when it is.
  for (const box of [{ width: 0, height: 0 }, { width: 400, height: 0 }, null]) {
    const style = previewFrameStyle('portrait', box);
    assert.equal(style.width, '');
    assert.equal(style.transform, '');
  }
});

test('an unknown orientation falls back to no rotation, never to a blank frame', () => {
  const style = previewFrameStyle('sideways-ish', STAGE);
  assert.deepEqual(occupies(style, STAGE.width, STAGE.height), { x0: 0, x1: 405, y0: 0, y1: 720 });
});

test('stage aspect is the panel as the viewer sees it', () => {
  assert.equal(previewAspectRatio('landscape'), '16 / 9');
  assert.equal(previewAspectRatio('landscape-flipped'), '16 / 9');
  assert.equal(previewAspectRatio('portrait'), '9 / 16');
  assert.equal(previewAspectRatio('portrait-flipped'), '9 / 16');
});
