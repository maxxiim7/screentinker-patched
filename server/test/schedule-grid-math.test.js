'use strict';

// The week calendar now supports direct manipulation — drag empty space to create, drag a block to
// move it, drag its grip to resize. The gestures are only as good as the arithmetic underneath,
// and that arithmetic fails quietly: an off-by-one hour, a block that ends before it starts, or a
// UTC conversion that moves a schedule to the previous day all LOOK fine on screen and only show
// up as a screen playing at the wrong time.
//
// So the maths lives in frontend/js/lib/schedule-grid.js as pure functions and is pinned here.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const MOD = pathToFileURL(path.join(__dirname, '..', '..', 'frontend', 'js', 'lib', 'schedule-grid.js')).href;
let G;
test('load the module', async () => { G = await import(MOD); assert.ok(G.HOUR_PX > 0); });

test('pixels and minutes round-trip', async () => {
  G = G || await import(MOD);
  for (const min of [0, 15, 90, 447, 1439]) {
    assert.ok(Math.abs(G.pxToMinutes(G.minutesToPx(min)) - min) < 0.001, `${min} survives`);
  }
});

test('snapping goes to the NEAREST quarter, not the one below', async () => {
  // Dragging to 10:58 means 11:00. Flooring would silently give 10:45 and read as a broken drag.
  assert.equal(G.snapMinutes(658), 660);
  assert.equal(G.snapMinutes(652), 645);
  assert.equal(G.snapMinutes(0), 0);
});

test('a drag upward is still a valid range', async () => {
  // Anchor at 14:00, drag up to 12:00 — Outlook treats the anchor as the end. Without this the
  // range inverts and the schedule is nonsense.
  const r = G.rangeFromDrag(840, 720);
  assert.equal(r.startMin, 720);
  assert.equal(r.endMin, 840);
});

test('a click without movement still yields a usable block, not a zero-height one', async () => {
  const r = G.rangeFromDrag(600, 600);
  assert.equal(r.endMin - r.startMin, G.MIN_DURATION_MIN, 'a minimum length is enforced');
});

test('a range cannot escape the day', async () => {
  const late = G.rangeFromDrag(1430, 1600);
  assert.ok(late.endMin <= G.DAY_MIN, 'clamped to midnight');
  assert.ok(late.startMin < late.endMin, 'and still valid');
  const early = G.rangeFromDrag(-120, 30);
  assert.ok(early.startMin >= 0);
});

test('MOVING a block keeps its length — that is what makes it a move', async () => {
  const r = G.moveRange(9 * 60, 90);
  assert.equal(r.startMin, 540);
  assert.equal(r.endMin, 630);
  assert.equal(r.endMin - r.startMin, 90);
});

test('a move near midnight slides back instead of being truncated', async () => {
  // Truncating would quietly shorten a 2h schedule to 10 minutes.
  const r = G.moveRange(23 * 60 + 50, 120);
  assert.equal(r.endMin, G.DAY_MIN);
  assert.equal(r.endMin - r.startMin, 120, 'length preserved');
});

test('RESIZING moves only the end', async () => {
  const r = G.resizeRange(540, 700);
  assert.equal(r.startMin, 540);
  assert.equal(r.endMin, 705, 'snapped');
});

test('resizing above the start does not invert the block', async () => {
  const r = G.resizeRange(600, 300);
  assert.equal(r.startMin, 600);
  assert.equal(r.endMin, 600 + G.MIN_DURATION_MIN);
});

test('THE TIMEZONE TRAP: the stamp is LOCAL, not UTC', async () => {
  // toISOString() would render 00:30 local as the PREVIOUS day for anyone west of Greenwich —
  // the same class of bug as storing a schedule in the wrong zone.
  const d = new Date(2026, 6, 28, 12, 0, 0);          // 28 Jul 2026, local
  assert.equal(G.toLocalStamp(d, 30), '2026-07-28T00:30:00', 'early morning stays on the 28th');
  assert.equal(G.toLocalStamp(d, 23 * 60 + 45), '2026-07-28T23:45:00', 'late evening too');
});

test('the stamp is minute-accurate across the day', async () => {
  const d = new Date(2026, 0, 5, 8, 0, 0);
  assert.equal(G.toLocalStamp(d, 0), '2026-01-05T00:00:00');
  assert.equal(G.toLocalStamp(d, 13 * 60 + 15), '2026-01-05T13:15:00');
});

test('a one-off may be dragged to another DAY; a repeating one may not', async () => {
  // A one-off's day IS its date. A repeating schedule's day comes from its rule, so dragging an
  // instance sideways would rewrite the recurrence for every other occurrence too — that belongs
  // in the dialog, not in a mouse gesture.
  assert.equal(G.canMoveAcrossDays({ id: 1 }), true);
  assert.equal(G.canMoveAcrossDays({ id: 2, recurrence: 'FREQ=WEEKLY' }), false);
});

test('editing a repeating schedule is flagged as editing the series', async () => {
  assert.equal(G.editsWholeSeries({ recurrence: 'FREQ=DAILY' }), true);
  assert.equal(G.editsWholeSeries({}), false);
});

test('THE CLICK TRAP: a jiggle is not a drag', async () => {
  // Every click carries a pixel or two of movement. Treating that as a drag would suppress
  // click-to-edit — the most-used interaction on the calendar — and read as "clicking is broken".
  assert.equal(G.isDrag(0, 0), false, 'a still click');
  assert.equal(G.isDrag(1, 1), false, 'ordinary hand tremor');
  assert.equal(G.isDrag(2, 2), false, 'still inside the threshold');
  assert.equal(G.isDrag(0, 6), true, 'a deliberate pull IS a drag');
  assert.equal(G.isDrag(-6, 0), true, 'in any direction');
});

test('a 15-minute block is big enough to actually grab', async () => {
  // At the old 28px/hour it was 7px tall — legible but not a usable pointer target, and its
  // resize grip would have covered the entire block.
  assert.ok(G.minutesToPx(G.MIN_DURATION_MIN) >= 10,
    `smallest block is ${G.minutesToPx(G.MIN_DURATION_MIN)}px`);
});

test('a whole day still fits a laptop screen', async () => {
  // The other half of the trade: taller rows must not turn the week view into a scrolling chore.
  assert.ok(24 * G.HOUR_PX <= 1100, `full day is ${24 * G.HOUR_PX}px`);
});

test('MOBILE: touch arms by HOLDING, a mouse arms by moving', async () => {
  // The two cannot share a rule. A browser decides at touch-start whether a gesture scrolls the
  // page, so a touch drag that only declares itself after the finger moves has already lost — the
  // page scrolls and the pointer stream is cancelled. That is exactly why the first version did
  // nothing on a phone: it set touch-action only AFTER the move threshold.
  assert.equal(G.dragArmMode('touch'), 'longpress');
  assert.equal(G.dragArmMode('mouse'), 'immediate');
  assert.equal(G.dragArmMode('pen'), 'immediate');
  assert.equal(G.dragArmMode(undefined), 'immediate', 'unknown input behaves like a mouse');
});

test('the hold is long enough to mean intent, short enough not to feel stuck', async () => {
  assert.ok(G.LONG_PRESS_MS >= 250 && G.LONG_PRESS_MS <= 600, `${G.LONG_PRESS_MS}ms`);
});

test('a tap with no drag still yields a sensible slot', async () => {
  // On a phone this is the only create gesture — dragging a range with a finger is awkward.
  assert.equal(G.DEFAULT_NEW_MIN, 60);
  const r = G.clampRange(9 * 60, 9 * 60 + G.DEFAULT_NEW_MIN);
  assert.equal(r.endMin - r.startMin, 60);
});

test('a tap late in the day does not produce an invalid slot', async () => {
  const start = 23 * 60 + 30;
  const r = G.clampRange(start, Math.min(start + G.DEFAULT_NEW_MIN, G.DAY_MIN));
  assert.ok(r.endMin <= G.DAY_MIN && r.endMin > r.startMin);
});

test('the drag readout is human, not 24h minutes', async () => {
  assert.equal(G.formatRange(540, 630), '9:00 AM – 10:30 AM');
  assert.equal(G.formatRange(0, 45), '12:00 AM – 12:45 AM');
  assert.equal(G.formatRange(720, 780), '12:00 PM – 1:00 PM');
});

// ---------------------------------------------------------------- crossing midnight

test('THE GAP: a window ending before it starts crosses midnight', async () => {
  // 22:00 -> 04:00 is an ordinary signage schedule. The playback engine has always understood
  // it (schedule-eval treats start > end as a wrap); the calendar computed 4 - 22 = -18 hours,
  // so it drew an 18px sliver at 10pm and nothing at all after midnight.
  assert.equal(G.crossesMidnight(22 * 60, 4 * 60), true);
  assert.equal(G.crossesMidnight(9 * 60, 17 * 60), false);
  assert.equal(G.crossesMidnight(9 * 60, 9 * 60), true, 'equal ends is a full 24h wrap, not zero');
});

test('an overnight window is drawn as two pieces on consecutive days', async () => {
  const segs = G.splitAcrossMidnight(2, 22 * 60, 4 * 60);   // Tuesday 22:00 -> Wednesday 04:00
  assert.equal(segs.length, 2);
  assert.deepEqual(
    segs.map(s => [s.dayIdx, s.startMin, s.endMin]),
    [[2, 1320, 1440], [3, 0, 240]]);
  assert.equal(segs[0].continues, true, 'the first piece runs into the next day');
  assert.equal(segs[1].continued, true, 'and the second is a continuation');
});

test('the two pieces add up to the real duration', async () => {
  const segs = G.splitAcrossMidnight(1, 22 * 60 + 30, 6 * 60 + 15);
  const total = segs.reduce((n, s) => n + (s.endMin - s.startMin), 0);
  assert.equal(total, (24 * 60 - (22 * 60 + 30)) + (6 * 60 + 15), '7h45m');
});

test('a same-day window is still one piece', async () => {
  const segs = G.splitAcrossMidnight(4, 9 * 60, 17 * 60);
  assert.equal(segs.length, 1);
  assert.equal(segs[0].continues, false);
  assert.equal(segs[0].endMin, 17 * 60);
});

test('a Saturday-night spill is not wrapped round to Sunday', async () => {
  // Wrapping would draw the after-midnight part at the START of the same week, making it look
  // like it played six days early.
  const segs = G.splitAcrossMidnight(6, 23 * 60, 2 * 60);
  assert.equal(segs.length, 1, 'only the part that fits this grid is drawn');
  assert.equal(segs[0].endMin, G.DAY_MIN);
});

test('an overnight schedule cannot be dragged, because a drag cannot express it', async () => {
  // A drag describes a window inside ONE day; applying it to a wrap would clamp it and silently
  // destroy the schedule.
  assert.equal(G.canDragEvent({}, 22 * 60, 4 * 60), false);
  assert.equal(G.canDragEvent({}, 9 * 60, 17 * 60), true);
});
