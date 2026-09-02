'use strict';

/*
 * Pending framebuffer-capture requests for BrightSign players, held for the host to collect.
 *
 * WHY THIS EXISTS, because it looks like a detour and is not:
 *
 * Every other player is TOLD to take a screenshot — the server emits `device:screenshot-request`
 * over the device socket and the page captures itself. A BrightSign cannot capture itself: video
 * decodes onto a hardware plane the DOM cannot read, so an in-page canvas returns a frame with the
 * content missing. Only the host (BrightScript) can get a real capture, via the player's own DWS.
 *
 * The obvious route to the host is the page: st-bridge.js posts a message over the widget's
 * messageport. On real hardware (XT245, BOS 9.1.93.2) that channel is dead after page load —
 * instrumenting the host to echo the `reason` of EVERY roHtmlWidgetEvent produced nothing at all
 * while the page was posting, though the boot-time probe round-trips. The registry is not an
 * alternative either: a running BrightScript does not observe registry writes made by anyone else,
 * including ones made externally through the DWS.
 *
 * What the host CAN do is HTTP — it already fetches its own package updates that way. So the
 * direction is inverted: the request waits here, and the host collects it on the loop it is
 * already running. The image comes back over a plain POST, so a capture works even when the page
 * is wedged, which is exactly when an operator most wants to see the screen.
 *
 * Deliberately in memory. A capture request is worthless a minute after it was made — an operator
 * clicked a button and is watching for the result — so persisting it would only add a way to
 * deliver a stale screenshot after a restart.
 */

// deviceId -> { width, height, at }
const PENDING = new Map();

// A request nobody collects must not sit here forever waiting to fire at a player that reconnects
// hours later. Comfortably longer than the dashboard's own 15s patience, short enough that the
// answer still refers to what the operator was looking at.
const TTL_MS = 60 * 1000;

// A fleet of BrightSigns that all go offline mid-request must not grow this without bound.
const MAX_PENDING = 500;

function request(deviceId, opts) {
  if (!deviceId) return false;
  const o = opts || {};
  if (!PENDING.has(deviceId) && PENDING.size >= MAX_PENDING) {
    // Drop the OLDEST rather than refuse the newest: the newest is the one someone is watching for.
    const oldest = PENDING.keys().next().value;
    if (oldest !== undefined) PENDING.delete(oldest);
  }
  // Re-requesting replaces rather than queues. A dashboard polling the button, or a 1fps remote
  // stream, must not build a backlog the host then works through long after anyone stopped looking.
  PENDING.set(deviceId, {
    width: Number(o.width) > 0 ? Math.min(3840, Math.round(o.width)) : 960,
    height: Number(o.height) > 0 ? Math.min(2160, Math.round(o.height)) : 540,
    at: Date.now(),
  });
  return true;
}

/* Collect and clear. Returns null when there is nothing pending or it has expired. */
function take(deviceId) {
  const p = PENDING.get(deviceId);
  if (!p) return null;
  PENDING.delete(deviceId);
  if (Date.now() - p.at > TTL_MS) return null;
  return { width: p.width, height: p.height };
}

/* Drop anything expired. Called from the same sweep as the other bounded stores. */
function sweep(now) {
  const t = now || Date.now();
  let dropped = 0;
  for (const [id, p] of PENDING) {
    if (t - p.at > TTL_MS) { PENDING.delete(id); dropped++; }
  }
  return dropped;
}

module.exports = { request, take, sweep, TTL_MS, MAX_PENDING, _size: () => PENDING.size };
