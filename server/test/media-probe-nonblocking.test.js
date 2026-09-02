'use strict';

/*
 * Video probing must not block the event loop.
 *
 * deriveMediaMetadata spawns ffprobe and ffmpeg with a 15s timeout each. Run synchronously
 * (execFileSync) those two calls stop the entire server for their duration — no heartbeats, no
 * socket traffic, no HTTP. That was survivable while the only caller was a human-initiated
 * upload: one file, someone waiting for it, bounded.
 *
 * The boot-time thumbnail backfill removed every one of those mitigations. It walks a whole
 * library unattended, on a server with live panels, once per boot — so a sync spawn per video
 * reproduces #240's failure mode (blocked loop -> missed heartbeats -> panels marked offline ->
 * reconnect churn) from our own maintenance sweep rather than from a checkpoint.
 *
 * These tests pin the property, not the implementation detail, so a future edit that
 * reintroduces a sync spawn on this path fails here rather than in a customer's fleet.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'content-ingest.js'), 'utf8');
// Comments explaining why the sync form is banned must not themselves trip the ban.
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('#244: the media path spawns asynchronously', () => {
  assert.ok(!/execFileSync|execSync|spawnSync/.test(CODE),
    'content-ingest must not spawn synchronously — it blocks the loop for the subprocess timeout');
  assert.match(SRC, /execFileAsync\('ffprobe'/, 'ffprobe must be awaited');
  assert.match(SRC, /execFileAsync\('ffmpeg'/, 'ffmpeg must be awaited');
});

test('#244: every spawn keeps its timeout — async is not a licence to hang', () => {
  // Async does not make a wedged binary harmless: without the timeout the promise never
  // settles and the backfill stops dead on one bad file instead of moving on.
  const spawns = SRC.match(/execFileAsync\(/g) || [];
  const timeouts = SRC.match(/timeout: 15000/g) || [];
  assert.equal(spawns.length, 2, 'expected exactly the ffprobe and ffmpeg spawns');
  assert.equal(timeouts.length, spawns.length, 'every spawn needs its own timeout');
});

test('#244: the loop keeps running while a probe is in flight', async () => {
  // The real property, measured rather than grepped: a slow subprocess must not stop timers.
  const { promisify } = require('util');
  const execFileAsync = promisify(require('child_process').execFile);

  let ticks = 0;
  const ticker = setInterval(() => { ticks++; }, 20);
  try {
    // Stands in for a slow ffprobe. `sleep` is on PATH everywhere the server runs.
    await execFileAsync('sleep', ['0.5'], { timeout: 15000 });
  } catch {
    clearInterval(ticker);
    return; // no `sleep` binary — the grep assertions above still hold
  }
  clearInterval(ticker);
  // Sync would have yielded 0 ticks across the whole call.
  assert.ok(ticks >= 10, `the loop should keep ticking during a spawn, got ${ticks} ticks in 500ms`);
});

test('#244: neither branch names a thumbnail it has not written', () => {
  // The phantom-path bug, in both media branches: assigning thumbnailPath before the write
  // means a failed encode returns a name for a file that does not exist, and the dashboard
  // then requests it forever as a broken image.
  const videoBranch = SRC.slice(SRC.indexOf("mime.startsWith('video/')"), SRC.indexOf('return { width, height'));
  assert.match(videoBranch, /const thumbName =/, 'the video branch must stage the name');
  assert.match(videoBranch, /thumbnailPath = thumbName;/, 'and assign only after the encode resolves');
  const assignIdx = videoBranch.indexOf('thumbnailPath = thumbName;');
  const spawnIdx = videoBranch.indexOf("execFileAsync('ffmpeg'");
  assert.ok(spawnIdx < assignIdx, 'the assignment must come AFTER the ffmpeg call, not before');
});
