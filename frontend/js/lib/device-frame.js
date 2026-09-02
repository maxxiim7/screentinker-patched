// #238: show a device's output the way a person standing in front of the panel sees it.
//
// Everywhere the dashboard showed a rotated display — the device preview modal, the Now Playing
// screenshot, the device cards — it showed the framebuffer as captured/rendered, i.e. sideways,
// while the panel on the wall was right. Designers use these surfaces to check their work, so a
// sideways preview turned every anomaly on a portrait screen into "is that real?".
//
// The geometry itself is NOT here: it is the same rule the players rotate by
// (server/lib/orientation-style.js, loaded as window.OrientationStyle), because a second copy of a
// rotation rule is precisely how the dashboard and the panel came to disagree in the first place.
// This file only measures the box and applies the answer.

// stage element -> { inner, orientation }. Weak so a re-rendered dashboard doesn't pin dead nodes.
const framed = new WeakMap();
let observer = null;

// Sizes are in px, so they are wrong the moment the stage resizes — and a stage inside an inactive
// tab measures 0x0 until it is shown, which is the common case for Now Playing. One observer for
// every stage: the callback re-measures whatever actually changed, including 0 -> visible.
function ensureObserver() {
  if (observer || typeof ResizeObserver === 'undefined') return observer;
  observer = new ResizeObserver((entries) => { entries.forEach(e => applyFrame(e.target)); });
  return observer;
}

function applyFrame(stage) {
  const entry = framed.get(stage);
  if (!entry) return;
  if (!stage.isConnected) {   // modal closed / list re-rendered
    framed.delete(stage);
    if (observer) observer.unobserve(stage);
    return;
  }
  const OS = typeof window !== 'undefined' && window.OrientationStyle;
  if (!OS || !OS.previewFrameStyle) return;   // shared rule failed to load: leave today's rendering alone
  const st = OS.previewFrameStyle(entry.orientation, { width: stage.clientWidth, height: stage.clientHeight });
  const el = entry.inner;
  if (!el) return;
  el.style.width = st.width;
  el.style.height = st.height;
  el.style.top = st.top;
  el.style.left = st.left;
  el.style.transform = st.transform;
  el.style.transformOrigin = st.transformOrigin;
  // A rotated screenshot has to be letterboxed rather than cropped: the card's `object-fit: cover`
  // applied to a frame whose axes are swapped fills the box by discarding most of the picture —
  // a "preview" of the middle 30% of the screen.
  el.style.objectFit = (st.transform && OS.swapsAxes(entry.orientation)) ? 'contain' : '';
}

/**
 * Present `inner` (an iframe of the player, or a screenshot img) inside `stage` as the panel's
 * face. Safe to call repeatedly — screenshot handlers replace the img element, and re-registering
 * is how the new one gets framed.
 *
 * @param {Element} stage        fixed box in the dashboard, sized for the AS-DISPLAYED aspect
 * @param {Element} inner        the device's output; positioned and rotated inside the stage
 * @param {string}  orientation  the device row's orientation
 */
export function frameDeviceOutput(stage, inner, orientation) {
  if (!stage || !inner) return;
  // Applied here rather than left to each call site: the frame is absolutely positioned and centred
  // on its offset parent, so a stage that forgets `position: relative` centres it on the PAGE.
  stage.classList.add('display-stage');
  inner.classList.add('display-frame');
  framed.set(stage, { inner, orientation: orientation || 'landscape' });
  applyFrame(stage);
  const ro = ensureObserver();
  if (ro) { ro.unobserve(stage); ro.observe(stage); }
}

/** Stage aspect for a device, as the viewer sees it ('9 / 16' for a portrait-hung 16:9 panel). */
export function displayAspectRatio(orientation) {
  const OS = typeof window !== 'undefined' && window.OrientationStyle;
  return OS && OS.previewAspectRatio ? OS.previewAspectRatio(orientation) : '16 / 9';
}
