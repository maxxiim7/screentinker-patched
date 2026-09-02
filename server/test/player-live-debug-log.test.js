'use strict';

/*
 * The dashboard's per-device "Debug logging" checkbox, and the web player's half of it.
 *
 * The checkbox has always sent a `set_debug` command. The ANDROID player honours it — DebugLog.*
 * mirrors its tagged lines over the device socket while the box is ticked. The web player never
 * implemented the command at all: the panel opened, revealed itself, streamed nothing, and read as
 * a display with nothing to say. Only the three unconditional reporters (sync, pip, zone) ever
 * reached it, so a display could be failing loudly in its own console and look silent from here.
 *
 * In a browser that is a nuisance — press F12. On BrightSign it is the entire diagnostic surface:
 * no console, no adb, no logcat, a panel on a wall. Which is why the fix streams the ring buffer
 * the error trap at the top of <head> already fills (console.*, uncaught errors with stacks,
 * rejections, failed resource loads) rather than hand-instrumenting call sites to match Android's
 * tag by tag — and why turning it on REPLAYS the backlog, since the fault the operator came to
 * investigate happened before they opened the screen.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const PLAYER = read('server/player/index.html');
const DETAIL = read('frontend/js/views/device-detail.js');

// ------------------------------------------------------------------ the command is honoured

test('the web player implements set_debug — the whole point', () => {
  const handler = PLAYER.slice(PLAYER.indexOf("socket.on('device:command'"), PLAYER.indexOf("socket.on('device:mute-changed'"));
  assert.match(handler, /data\.type === 'set_debug'/, 'the command the dashboard has always sent must be handled');
  assert.match(handler, /setRemoteDebug/);
  // The relay wraps the flag in `payload`; other delivery paths have been seen to send it flat.
  assert.match(handler, /payload\?\.enabled\s*\?\?\s*data\.enabled/,
    'both payload shapes must be accepted, or the checkbox silently does nothing');
});

test('set_debug is not capability-gated, so a BrightSign can receive it', () => {
  const caps = require('../lib/player-capabilities');
  assert.equal(caps.capabilityForCommand('set_debug'), null);
  assert.equal(caps.commandAllowed({ android_version: 'BrightSign' }, 'set_debug').ok, true);
});

// ------------------------------------------------------------------ the ring buffer, live

/* Run the <head> error trap for real — it is ES5 and self-contained, so it executes standalone. */
function loadTrap() {
  const start = PLAYER.indexOf('<script>');
  const src = PLAYER.slice(PLAYER.indexOf('(function () {', start), PLAYER.indexOf('</script>', start));
  const win = {};
  const console_ = { log() {}, warn() {}, error() {} };
  const doc = { addEventListener() {} };
  win.addEventListener = () => {};
  new Function('window', 'console', 'document', 'navigator', 'screen', 'location', src)(
    win, console_, doc, { userAgent: 'test' }, { width: 1920, height: 1080 }, { href: 'http://x/player' },
  );
  return { win, console: console_ };
}

test('a subscriber receives entries as they are recorded', () => {
  const { win, console: c } = loadTrap();
  const seen = [];
  win.__debugLog_subscribe((e) => seen.push(e));
  c.log('[wall] hello');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].type, 'console.log');
  assert.match(seen[0].message, /\[wall\] hello/);
});

test('THE RECURSION TRAP: a subscriber that logs cannot take the player down', () => {
  // This sink is fed from inside the console wrapper. A subscriber that logs anything at all —
  // directly, or through any library it touches — re-enters pushLog and recurses until the stack
  // gives out, and the player dies of its own diagnostics. The guard is not theoretical.
  const { win, console: c } = loadTrap();
  let calls = 0;
  win.__debugLog_subscribe(() => { calls++; c.log('the subscriber logs too'); });
  assert.doesNotThrow(() => c.log('first'));
  assert.equal(calls, 1, 'the reentrant log must not call subscribers again');
});

test('one throwing subscriber does not eat the others', () => {
  const { win, console: c } = loadTrap();
  const seen = [];
  win.__debugLog_subscribe(() => { throw new Error('bad subscriber'); });
  win.__debugLog_subscribe((e) => seen.push(e));
  assert.doesNotThrow(() => c.log('x'));
  assert.equal(seen.length, 1);
});

test('subscribing does not disturb the buffer the debug overlay reads', () => {
  const { win, console: c } = loadTrap();
  win.__debugLog_subscribe(() => {});
  c.log('a');
  assert.ok(win.__debugLog.length >= 2, 'init + the line');
  assert.equal(typeof win.__debugLog_push, 'function', 'debug-overlay.js pusher must survive');
});

// ------------------------------------------------------------------ what actually goes out

// Pull the sink's helpers out of the player and run them against real ring-buffer entries.
function loadSink() {
  const from = PLAYER.indexOf('const DEBUG_TAG_RE');
  const to = PLAYER.indexOf('function debugSink(');
  const src = PLAYER.slice(from, to);
  return new Function(`${src}; return { debugTagFor, debugLevelFor, debugMessageFor };`)();
}

test('a bracketed prefix becomes the tag, so the panel reads like Android\'s', () => {
  const { debugTagFor, debugMessageFor } = loadSink();
  const e = { type: 'console.log', message: '[group-sync] drift 42ms' };
  assert.equal(debugTagFor(e), 'group-sync');
  assert.equal(debugMessageFor(e), 'drift 42ms', 'the prefix must not be repeated in the message');
});

test('an untagged line still lands somewhere sensible', () => {
  const { debugTagFor } = loadSink();
  assert.equal(debugTagFor({ type: 'console.log', message: 'Playing: clip.mp4' }), 'player');
  assert.equal(debugTagFor({ type: 'rejection', message: 'boom' }), 'error');
});

test('levels survive, because an error that looks like a log is not a diagnostic', () => {
  const { debugLevelFor } = loadSink();
  assert.equal(debugLevelFor({ type: 'console.error' }), 'e');
  assert.equal(debugLevelFor({ type: 'console.warn' }), 'w');
  assert.equal(debugLevelFor({ type: 'error' }), 'e');
  assert.equal(debugLevelFor({ type: 'rejection' }), 'e');
  assert.equal(debugLevelFor({ type: 'console.log' }), 'i');
  assert.equal(debugLevelFor({ type: 'console.log', level: 'w' }), 'w', 'an explicit level wins');
});

test('an uncaught error carries its location and stack, or it is not worth sending', () => {
  const { debugMessageFor } = loadSink();
  const msg = debugMessageFor({
    type: 'error', message: 'x is not a function',
    source: 'http://h/player/index.html', line: 42, col: 7, stack: 'at a\n  at b',
  });
  assert.match(msg, /@http:\/\/h\/player\/index\.html:42:7/);
    assert.match(msg, /at a at b/, 'the stack must be flattened onto one line, not dropped');
});

test('the panel is told what kind of player it is looking at', () => {
  const fn = PLAYER.slice(PLAYER.indexOf('function debugPlatformLine'), PLAYER.indexOf('function debugFlushBacklog'));
  assert.match(fn, /screen\.width/);
  assert.match(fn, /BS\.isBrightSign\(\)/, 'a BrightSign must identify itself — it is the platform with no other console');
  assert.match(fn, /userAgent/);
});

// ------------------------------------------------------------------ the backlog

test('turning the stream on replays what already happened', () => {
  // The operator is investigating a fault that is already over. A stream that starts empty makes
  // them reproduce it, which on a panel on a wall may mean waiting days for it to recur.
  const fn = PLAYER.slice(PLAYER.indexOf('function debugFlushBacklog'), PLAYER.indexOf('function setRemoteDebug'));
  assert.match(fn, /window\.__debugLog/);
  assert.match(fn, /__stSent/, 'a replayed line must be marked so the live sink does not send it twice');
  assert.match(fn, /debugSend\(/, 'the replay must bypass the per-second cap');
  assert.ok(!/debugEmitLine\(/.test(fn), 'rate-limiting the replay would drop the history it exists to deliver');
});

test('a replayed line admits it is old rather than claiming to be now', () => {
  // The dashboard stamps each line on arrival, so a 200-line replay would all read as this second
  // and an operator would date the crash to when they opened the panel.
  const fn = PLAYER.slice(PLAYER.indexOf('function debugFlushBacklog'), PLAYER.indexOf('function setRemoteDebug'));
  assert.match(fn, /-\$\{\(\(now - entry\.t\)/, 'the real age must travel in the text');
});

// ------------------------------------------------------------------ bounded

test('the stream is rate-limited, and says so when it drops lines', () => {
  // Fed by console.*: a video that fails to decode and retries every frame would otherwise flood
  // the socket that also carries playback.
  const fn = PLAYER.slice(PLAYER.indexOf('function debugEmitLine'), PLAYER.indexOf('const DEBUG_TAG_RE'));
  assert.match(fn, /DEBUG_MAX_LINES_PER_SEC/);
  assert.match(fn, /suppressed/, 'silent truncation would read as a player that went quiet');
  assert.ok(!/push\(|\.shift\(/.test(fn), 'dropped lines must be counted, not queued and replayed later');
  const cap = /const DEBUG_MAX_LINES_PER_SEC = (\d+)/.exec(PLAYER);
  assert.ok(cap && Number(cap[1]) > 0 && Number(cap[1]) <= 200, `cap must be real, got ${cap && cap[1]}`);
});

test('a forgotten checkbox does not stream forever', () => {
  const fn = PLAYER.slice(PLAYER.indexOf('function setRemoteDebug'), PLAYER.indexOf('function emitDeviceEvent'));
  assert.match(fn, /DEBUG_AUTO_OFF_MS/);
  assert.match(fn, /auto-disabled/, 'the stream stopping on its own must be visible, not mysterious');
  const ms = /const DEBUG_AUTO_OFF_MS = ([^;]+);/.exec(PLAYER);
  const value = new Function(`return ${ms[1]}`)();
  assert.ok(value >= 5 * 60 * 1000 && value <= 60 * 60 * 1000, `auto-off must outlast a real session, got ${value}ms`);
});

test('leaving the device screen turns the device stream off', () => {
  const fn = DETAIL.slice(DETAIL.indexOf('export function cleanup()'));
  assert.match(fn, /set_debug'?,\s*\{ enabled: false \}/, 'the dashboard must stop what it started');
  assert.ok(
    fn.indexOf('set_debug') < fn.indexOf('currentDevice = null'),
    'sent after currentDevice is cleared, this would address nobody',
  );
});

// ------------------------------------------------------------------ BrightSign host lines

test('host lines are not sent twice while the stream is on', () => {
  // wireHostDiagnostics emits directly AND console.logs; with the sink live the console.log is
  // already a second path to the dashboard, so the direct emit has to stand down.
  const fn = PLAYER.slice(PLAYER.indexOf('function wireHostDiagnostics'), PLAYER.indexOf('/* ==================== Live remote debug'));
  assert.match(fn, /!remoteDebug && socket\?\.connected/, 'the direct emit must yield to the sink');
  assert.match(fn, /console\.log\(`\[host\/\$\{line\.tag\}\]/, 'and the console path must remain, since that is what the sink reads');
});

test('the boot report still goes out with the stream OFF', () => {
  // It is the one diagnostic nobody can ask for in advance: it is over before the operator has a
  // device to open. Gating it behind the checkbox would lose it permanently.
  const fn = PLAYER.slice(PLAYER.indexOf('function wireHostDiagnostics'), PLAYER.indexOf('/* ==================== Live remote debug'));
  assert.match(fn, /socket\.emit\('device:log'/);
  assert.ok(!/if \(!remoteDebug\) return/.test(fn), 'host logs must not be suppressed when debug is off');
});

// ------------------------------------------------------------------ it cannot break playback

test('nothing in the sink can stop the player', () => {
  const from = PLAYER.indexOf('/* ==================== Live remote debug');
  const to = PLAYER.indexOf('function emitDeviceEvent');
  const block = PLAYER.slice(from, to);
  assert.match(block, /function debugSend/);
  const send = block.slice(block.indexOf('function debugSend'), block.indexOf('function debugEmitLine'));
  assert.match(send, /try \{/, 'the socket emit must be guarded');
  assert.match(send, /catch \(e\)/);
  // Every field is bounded before the wire; the server truncates too, but a player in a bad state
  // should not be pushing megabytes at it.
  assert.match(send, /slice\(0, 64\)/);
  assert.match(send, /slice\(0, 2000\)/);
});
