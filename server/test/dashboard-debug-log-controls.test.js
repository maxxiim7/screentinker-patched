'use strict';

/*
 * Freeze / Copy / Clear on the live debug panel, and the gap between the control row and the info
 * grid.
 *
 * Freeze is the one with a real design decision in it. A log you froze to read something is the
 * exact moment the lines that EXPLAIN it are still arriving, so freezing holds the view still and
 * keeps buffering underneath — it does not pause the stream. Dropping them would throw away the
 * part the operator was about to want, and the panel would have lied about being a live log.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const DETAIL = read('frontend/js/views/device-detail.js');
const EN = read('frontend/js/i18n/en.js');

// ------------------------------------------------------------------ layout

test('the control row is separated from the info grid', () => {
  // They rendered flush against each other: the buttons sat directly on top of the STATUS card
  // with no gap, so the destructive ones read as part of the status panel.
  const row = DETAIL.slice(DETAIL.indexOf('<!-- The actions an operator opens this page to take'), DETAIL.indexOf('rebootBtn'));
  assert.match(row, /margin:20px 0/, 'the row needs room BELOW it, not just above');
  assert.ok(!/margin-top:20px;display:flex/.test(row), 'margin-top alone leaves the grid flush against the buttons');
});

// ------------------------------------------------------------------ freeze

/* Run the real panel logic against a minimal DOM. */
function harness() {
  const rows = [];
  const panel = {
    children: rows,
    get childElementCount() { return rows.length; },
    get firstChild() { return rows[0]; },
    appendChild: (el) => rows.push(el),
    removeChild: (el) => rows.splice(rows.indexOf(el), 1),
    scrollTop: 0, scrollHeight: 0, style: {}, textContent: '',
  };
  const els = { debugLogPanel: panel, debugFreezeBtn: { textContent: '' }, debugLogStatus: { textContent: '' } };
  const src = DETAIL.slice(DETAIL.indexOf('const DEBUG_LEVEL_COLOR'), DETAIL.indexOf('async function copyToClipboard'));
  const state = { debugFrozen: false, debugHeld: [] };
  const api = new Function('document', 't', 'state', `
    const DEBUG_PANEL_MAX = 500;
    let debugFrozen = state.debugFrozen, debugHeld = state.debugHeld;
    ${src}
    return {
      appendDebugLine, setDebugFrozen, updateDebugTools, debugLineText,
      push: (d) => { if (debugFrozen) { debugHeld.push(d); if (debugHeld.length > DEBUG_PANEL_MAX) debugHeld.shift(); updateDebugTools(); return; } appendDebugLine(d); },
      held: () => debugHeld.length,
    };`)(
    { getElementById: (id) => els[id] || null, createElement: () => ({ textContent: '', style: {} }) },
    (k, v) => `${k}:${v ? v.n : ''}`,
    state,
  );
  return { ...api, panel, els, text: () => rows.map((r) => r.textContent) };
}

test('freezing HOLDS incoming lines rather than dropping them', () => {
  const h = harness();
  h.push({ message: 'before', ts: 1 });
  h.setDebugFrozen(true);
  h.push({ message: 'during-1', ts: 2 });
  h.push({ message: 'during-2', ts: 3 });
  assert.equal(h.panel.childElementCount, 1, 'the view must not move while frozen');
  assert.equal(h.held(), 2, 'but the lines must be kept');
});

test('resuming replays what was missed, in order', () => {
  const h = harness();
  h.setDebugFrozen(true);
  h.push({ message: 'a', ts: 1 });
  h.push({ message: 'b', ts: 2 });
  h.setDebugFrozen(false);
  const shown = h.text().join('|');
  assert.match(shown, /a.*b/, 'order must survive the freeze');
  assert.equal(h.held(), 0, 'and the buffer must be drained, not replayed twice');
  h.push({ message: 'c', ts: 3 });
  assert.equal(h.panel.childElementCount, 3, 'live appending resumes');
});

test('a panel left frozen overnight is bounded', () => {
  const h = harness();
  h.setDebugFrozen(true);
  for (let i = 0; i < 640; i++) h.push({ message: 'x' + i, ts: i });
  assert.equal(h.held(), 500, 'the held buffer must not grow without limit');
  h.setDebugFrozen(false);
  assert.equal(h.panel.childElementCount, 500, 'and the panel stays capped too');
});

test('freezing says how many lines are waiting', () => {
  // Otherwise a frozen panel is indistinguishable from a device that went quiet, and the operator
  // reads silence as a symptom.
  const h = harness();
  h.setDebugFrozen(true);
  h.push({ message: 'x', ts: 1 });
  assert.match(h.els.debugLogStatus.textContent, /device\.debug\.held:1/);
  assert.match(h.els.debugFreezeBtn.textContent, /device\.debug\.resume/, 'the button must offer the way out');
});

test('overflowing while frozen says so, rather than silently discarding', () => {
  const h = harness();
  h.setDebugFrozen(true);
  for (let i = 0; i < 501; i++) h.push({ message: 'x', ts: i });
  assert.match(h.els.debugLogStatus.textContent, /held_max/, 'silent truncation would misrepresent the capture');
});

// ------------------------------------------------------------------ copy

test('copy works on a self-hosted dashboard over plain http', () => {
  // navigator.clipboard is ABSENT outside a secure context — every other copy button in this app
  // quietly does nothing there, and a debug log is exactly what a self-hoster wants to paste.
  const fn = DETAIL.slice(DETAIL.indexOf('async function copyToClipboard'), DETAIL.indexOf('async function copyToClipboard') + 900);
  assert.match(fn, /window\.isSecureContext/, 'the modern path must be gated on the context it requires');
  assert.match(fn, /execCommand\('copy'\)/, 'and there must be a fallback for when it is not');
  assert.match(fn, /removeChild\(ta\)/, 'the scratch textarea must not be left in the DOM');
});

test('copy takes what is on screen, and says how much', () => {
  const h = DETAIL.slice(DETAIL.indexOf("document.getElementById('debugCopyBtn')"), DETAIL.indexOf("document.getElementById('debugCopyBtn')") + 1200);
  assert.match(h, /panel\.children/, 'the copy must come from the rendered panel');
  assert.match(h, /device\.debug\.copied/);
  assert.match(h, /device\.debug\.copy_failed/, 'a clipboard that refuses must say so, not fail silently');
  assert.match(h, /device\.debug\.copy_empty/);
  // A pasted log with no device in it is a log nobody can act on.
  assert.match(h, /device\.name/);
  assert.match(h, /toISOString/);
});

test('unticking the checkbox cannot leave a hidden frozen panel behind', () => {
  const h = DETAIL.slice(DETAIL.indexOf("document.getElementById('debugLogToggle')?.addEventListener"), DETAIL.indexOf("document.getElementById('debugFreezeBtn')?.addEventListener"));
  assert.match(h, /debugFrozen = false/, 're-ticking would otherwise resume into a freeze nobody remembers setting');
  assert.match(h, /debugLogTools/, 'the toolbar must follow the panel');
});

test('leaving the screen resets the freeze state too', () => {
  const fn = DETAIL.slice(DETAIL.indexOf('export function cleanup()'));
  assert.match(fn, /debugFrozen = false/);
  assert.match(fn, /debugHeld = \[\]/, 'held lines from another device must not leak into the next one');
});

// ------------------------------------------------------------------ strings

test('every new string exists', () => {
  for (const k of ['freeze', 'resume', 'copy', 'clear', 'held', 'held_max', 'copied', 'copy_empty', 'copy_failed']) {
    assert.ok(EN.includes(`'device.debug.${k}'`), `missing device.debug.${k}`);
  }
});

test('the hint describes how it actually turns off now', () => {
  // It used to promise "turns off on its own when the device reconnects", which was never what
  // happened and is not what happens now either.
  const hint = /'device\.debug\.hint': '((?:[^'\\]|\\.)*)'/.exec(EN)[1];
  assert.ok(!/reconnects/.test(hint), 'the old claim must be gone');
  assert.match(hint, /30 minutes/, 'the device-side auto-off is the part an operator must be able to rely on');
});
