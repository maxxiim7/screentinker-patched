'use strict';

// A screenshot that comes back BLANK while the panel is playing perfectly is worse than no
// screenshot at all: it reads as a dead screen and sends someone to site.
//
// That is what a BrightSign did. With hwz enabled the video decodes onto a HARDWARE PLANE outside
// the browser compositor — BrightSign's own documentation says the HTML/JS layer "doesn't see the
// pixels" — so `drawImage(video)` produces a fully TRANSPARENT image and throws nothing. Chromium
// 87 (which this XT245 reports) fails the same way. The capture path set `captured = true` purely
// because drawMediaFit() had not thrown, so the player emitted an empty frame and logged
// "Screenshot sent". Success reported, nothing done.
//
// isMediaReadable() does not catch this: it answers "am I ALLOWED to read this" (same-origin/CORS),
// which is a different question from "did any pixels arrive".
//
// The discriminator is ALPHA, not colour. A scratch canvas starts fully transparent and a real
// decoded frame writes alpha=255 even when the frame is pure black — so a legitimate fade-to-black
// must still read as captured, while "nothing arrived" must not. Both directions are pinned below.
//
// Extracted and run against fake canvas/video objects, in the same style as the other tests that
// exercise player functions without a browser.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'player', 'index.html'), 'utf8');

/** Pull one top-level function out of the player and return it, brace-matched. */
function extract(name) {
  const start = HTML.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} not found in index.html`);
  let depth = 0, end = -1;
  for (let j = HTML.indexOf('{', start); j < HTML.length; j++) {
    if (HTML[j] === '{') depth++;
    else if (HTML[j] === '}' && --depth === 0) { end = j + 1; break; }
  }
  assert.notEqual(end, -1, `${name} braces unbalanced`);
  return HTML.slice(start, end);
}

/**
 * Build videoFrameIsCapturable with a fake document.
 * `alpha` is what getImageData reports for every pixel; `throws` selects a failure mode.
 */
function build({ alpha = 255, drawThrows = false, getImageDataThrows = false, noCtx = false } = {}) {
  const src = extract('videoFrameIsCapturable');
  const calls = { draws: 0, sizes: [] };
  const scope = {
    document: {
      createElement: () => ({
        width: 0, height: 0,
        getContext: () => (noCtx ? null : {
          drawImage: (el, x, y, w, h) => {
            if (drawThrows) throw new Error('InvalidStateError');
            calls.draws++; calls.sizes.push([w, h]);
          },
          getImageData: (x, y, w, h) => {
            if (getImageDataThrows) {
              const e = new Error('The canvas has been tainted'); e.name = 'SecurityError'; throw e;
            }
            const data = new Uint8ClampedArray(w * h * 4);
            for (let i = 0; i < data.length; i += 4) {
              data[i] = 0; data[i + 1] = 0; data[i + 2] = 0; data[i + 3] = alpha;
            }
            return { data };
          },
        }),
      }),
    },
    Uint8ClampedArray,
  };
  const fn = new Function(...Object.keys(scope), `${src} return videoFrameIsCapturable;`)(...Object.values(scope));
  return { fn, calls };
}

const fakeVideo = { videoWidth: 1920, videoHeight: 1080, readyState: 4 };

test('THE BUG: a transparent result means nothing was drawn, not a black frame', () => {
  // This is the BrightSign hwz case: the draw "succeeds", the canvas stays untouched.
  const { fn } = build({ alpha: 0 });
  assert.equal(fn(fakeVideo), false, 'a fully transparent probe must not count as captured');
});

test('a genuinely BLACK frame still counts as captured — colour is not the test', () => {
  // RGB is 0,0,0 here and alpha is 255. A fade-to-black or a letterboxed frame must not be
  // mistaken for a failed capture, or the screenshot would be replaced by a status card at
  // exactly the moment a video dips to black.
  const { fn } = build({ alpha: 255 });
  assert.equal(fn(fakeVideo), true);
});

test('a partially opaque frame counts as captured', () => {
  const { fn } = build({ alpha: 1 });
  assert.equal(fn(fakeVideo), true, 'any non-zero alpha is evidence pixels arrived');
});

test('a tainted canvas counts as captured — tainting PROVES pixels were drawn', () => {
  // getImageData throwing SecurityError only happens once cross-origin content has been drawn,
  // so this failure is evidence of success. Treating it as failure would break screenshots for
  // every legitimately cross-origin video.
  const { fn } = build({ getImageDataThrows: true });
  assert.equal(fn(fakeVideo), true);
});

test('a throwing drawImage counts as NOT captured', () => {
  // Distinct from the tainted case above: here the draw itself failed, so nothing landed.
  const { fn } = build({ drawThrows: true });
  assert.equal(fn(fakeVideo), false);
});

test('no 2d context available is not captured, and does not throw', () => {
  const { fn } = build({ noCtx: true });
  assert.doesNotThrow(() => fn(fakeVideo));
  assert.equal(fn(fakeVideo), false);
});

test('a missing video is not captured', () => {
  const { fn } = build();
  assert.equal(fn(null), false);
  assert.equal(fn(undefined), false);
});

test('the probe is small — this runs once per frame on a 1fps stream', () => {
  // A full-size draw purely to test drawability would double the cost of every streamed frame.
  const { fn, calls } = build({ alpha: 255 });
  fn(fakeVideo);
  assert.deepEqual(calls.sizes[0], [16, 16]);
});

// ---------------------------------------------------------------- wiring, not just the helper

test('both capture paths probe BEFORE drawing, so the placeholder can still be drawn', () => {
  // Probing after the draw would waste a full-size drawImage on every frame, and in the zone path
  // it would leave a black rectangle already painted underneath the placeholder.
  const zone = HTML.slice(HTML.indexOf('function drawZoneComposite'), HTML.indexOf('function renderCaptureCanvas'));
  assert.match(zone, /if \(videoFrameIsCapturable\(el\)\) \{/, 'zone path must gate the draw on the probe');
  assert.match(zone, /Video \(not capturable\)/, 'a video zone that cannot be read must be LABELLED, not left black');

  const full = HTML.slice(HTML.indexOf('function renderCaptureCanvas'), HTML.indexOf('function captureAndSend'));
  assert.match(full, /if \(videoFrameIsCapturable\(video\)\) \{/, 'fullscreen path must gate the draw on the probe');
  assert.match(full, /videoUncapturable = true/, 'fullscreen path must record WHY it fell through');
});

test('the operator is told the panel is fine and the capture is what is limited', () => {
  // The status card is also what shows for "no content". Without this line an operator seeing it
  // would reasonably conclude the screen was blank when the video was playing normally.
  const full = HTML.slice(HTML.indexOf('function renderCaptureCanvas'), HTML.indexOf('function captureAndSend'));
  assert.match(full, /if \(videoUncapturable\) \{/);
  assert.match(full, /hardware plane and cannot be captured/i);
});
