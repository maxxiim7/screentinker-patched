// Geometry and time maths for the week calendar's direct manipulation (drag to create, drag to
// move, drag to resize). Kept apart from the view so the arithmetic — the part that silently
// produces a schedule an hour off, or one that ends before it starts — is testable without a
// browser.
//
// The grid is 24 rows of HOUR_PX pixels, one column per weekday. A block's vertical position is
// therefore a pure function of minutes-since-midnight, and vice versa.

// 28px/hour made a 15-minute block SEVEN pixels tall — legible, but not something you can
// reliably grab, and its resize grip would have covered the whole block. 44 keeps a full day on
// screen on a laptop while making the smallest schedule an 11px target.
export const HOUR_PX = 44;

// A pointer must travel this far before a press counts as a drag. Without it, the 1px of movement
// in an ordinary click turns every click into a drag and swallows click-to-edit — so the calendar
// would feel broken in the most common interaction of all.
export const DRAG_THRESHOLD_PX = 4;
export const SNAP_MIN = 15;          // what a drag rounds to; matches how people actually schedule
export const MIN_DURATION_MIN = 15;  // a zero-height block is invisible and unselectable
export const DAY_MIN = 24 * 60;

export const minutesToPx = (min) => (min / 60) * HOUR_PX;
export const pxToMinutes = (px) => (px / HOUR_PX) * 60;

// Round to the nearest SNAP_MIN. Nearest rather than floor: dragging to 10:58 should give 11:00,
// not 10:45, because the pointer is a blunt instrument and people aim at the line.
export function snapMinutes(min, snap = SNAP_MIN) {
  return Math.round(min / snap) * snap;
}

// Clamp a dragged range into a valid one: inside the day, at least MIN_DURATION_MIN long, and
// never inverted. Returns {startMin, endMin}.
export function clampRange(startMin, endMin) {
  let s = Math.max(0, Math.min(DAY_MIN - MIN_DURATION_MIN, Math.round(startMin)));
  let e = Math.round(endMin);
  if (e < s + MIN_DURATION_MIN) e = s + MIN_DURATION_MIN;   // dragging up past the start, or a click
  if (e > DAY_MIN) { e = DAY_MIN; s = Math.min(s, e - MIN_DURATION_MIN); }
  return { startMin: s, endMin: e };
}

// A drag that started at anchorMin and is currently at pointerMin, in either direction. Outlook
// lets you drag upward from the anchor and treats the anchor as the END; so do we.
export function rangeFromDrag(anchorMin, pointerMin) {
  const a = snapMinutes(anchorMin);
  const b = snapMinutes(pointerMin);
  return clampRange(Math.min(a, b), Math.max(a, b));
}

// Move a block of fixed length so it now STARTS at startMin, without letting it run off the end
// of the day (it slides back instead of being silently truncated — a move must not change length).
export function moveRange(startMin, durationMin) {
  const dur = Math.max(MIN_DURATION_MIN, Math.round(durationMin));
  let s = snapMinutes(Math.max(0, startMin));
  if (s + dur > DAY_MIN) s = DAY_MIN - dur;
  return { startMin: Math.max(0, s), endMin: Math.max(0, s) + dur };
}

// Resize by dragging the bottom edge: the start is fixed, the end follows the pointer.
export function resizeRange(startMin, pointerMin) {
  return clampRange(startMin, snapMinutes(pointerMin));
}

const pad = (n) => String(n).padStart(2, '0');

// The wire format the API stores: a LOCAL 'YYYY-MM-DDTHH:MM:00'. Deliberately not toISOString(),
// which converts to UTC and would shift every schedule by the browser's offset — the same class of
// bug as storing a schedule in the wrong zone.
export function toLocalStamp(date, minutes) {
  const d = new Date(date.getTime());
  d.setHours(0, 0, 0, 0);
  d.setMinutes(minutes);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
}

export function formatRange(startMin, endMin) {
  const fmt = (m) => {
    const h24 = Math.floor(m / 60) % 24, mm = m % 60;
    const ampm = h24 < 12 ? 'AM' : 'PM';
    const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
    return `${h12}:${pad(mm)} ${ampm}`;
  };
  return `${fmt(startMin)} – ${fmt(endMin)}`;
}

// How long a touch must be held before it becomes a drag. A touchscreen cannot use the mouse
// rule: the browser decides at touch-START whether the gesture is a page scroll, so a drag that
// only declares itself after the finger moves has already lost — the page scrolls and the pointer
// stream is cancelled. Holding still first is the signal that this is a drag and not a scroll.
export const LONG_PRESS_MS = 350;

// Touch arms by holding; a mouse or pen arms as soon as it has travelled. Returning the mode
// rather than branching on pointerType at each site keeps the two paths from drifting apart.
export function dragArmMode(pointerType) {
  return pointerType === 'touch' ? 'longpress' : 'immediate';
}

// A default slot for "I tapped a time" rather than dragging one out — the whole gesture on a
// phone, where dragging out a range is awkward.
export const DEFAULT_NEW_MIN = 60;

// Has the pointer moved far enough to mean "drag" rather than "click"?
export function isDrag(dx, dy, threshold = DRAG_THRESHOLD_PX) {
  return Math.hypot(dx, dy) >= threshold;
}

// Which day a schedule occupies is NOT always its date. A one-off sits on the date in start_time,
// so dragging it sideways is a real date change. A RECURRING one appears on whatever days its rule
// expands to, so dragging an instance sideways is a change to the RULE (BYDAY), not to a time —
// a different operation with different consequences for every other instance. Refuse it here and
// send the user to the dialog rather than silently rewriting a recurrence from a mouse gesture.
export function canMoveAcrossDays(ev) {
  return !(ev && ev.recurrence);
}

// Dragging a recurring event's TIME still edits the whole series, since the series has one
// time-of-day. That is worth confirming out loud rather than assuming.
export function editsWholeSeries(ev) {
  return !!(ev && ev.recurrence);
}

// A window whose end is BEFORE its start crosses midnight — 22:00 to 04:00 is a real and common
// signage schedule (a bar, a hotel lobby, anything running overnight). The playback engine has
// always understood this: schedule-eval treats start > end as a wrap. The calendar did not, and
// computed a negative height, so an overnight schedule appeared as an 18px sliver at 10pm with
// nothing at all after midnight.
export function crossesMidnight(startMin, endMin) {
  return endMin <= startMin;
}

// Split an overnight window into the pieces a week grid can actually draw: the part before
// midnight on its own day, and the part after midnight on the NEXT one. A same-day window is
// returned unchanged as a single piece, so callers have one shape to render.
export function splitAcrossMidnight(dayIdx, startMin, endMin) {
  if (!crossesMidnight(startMin, endMin)) {
    return [{ dayIdx, startMin, endMin, continues: false, continued: false }];
  }
  const out = [{ dayIdx, startMin, endMin: DAY_MIN, continues: true, continued: false }];
  // Sunday-night spill lands on Monday of the SAME grid, which is what a week view shows; a
  // Saturday-night spill would run off the end, so it is simply not drawn rather than wrapping
  // round to Sunday and appearing to be a week early.
  if (dayIdx < 6 && endMin > 0) {
    out.push({ dayIdx: dayIdx + 1, startMin: 0, endMin, continues: false, continued: true });
  }
  return out;
}

// A drag can only express a window inside one day. Moving or resizing an overnight schedule with
// the mouse would therefore clamp it into that day and silently destroy the wrap, so it is
// refused and left to the dialog — the same reasoning as a recurring schedule's day.
export function canDragEvent(ev, startMin, endMin) {
  return !crossesMidnight(startMin, endMin);
}
