'use strict';

// A player on a bad link cannot download a large asset in one unbroken call. It has to be able to
// come back and ask for "the rest", which means GET /api/content/:id/file must honour Range — and
// must reject a resume against an asset that changed underneath it, or the player would splice two
// different files together and cache the result as whole.
//
// Both behaviours come from res.sendFile / the `send` module rather than from code in this repo,
// which is exactly why they are worth pinning: they are load-bearing for offline resilience and a
// future middleware (compression, a custom Content-Length, a stream wrapper) would silently take
// them away. Nothing in the route would look wrong afterwards — downloads would simply start over
// from zero forever on the sites that need resume most.

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-range-' + crypto.randomBytes(4).toString('hex'));
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { db } = require('../db/database');
const config = require('../config');

const ID = 'range-fixture';
const BODY = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251));  // 1000 known bytes
let server, base, filePath;

/** Raw request so we can see the status line and headers, not just a parsed body. */
function req(headers) {
  return new Promise((resolve, reject) => {
    http.get(`${base}/${ID}/file`, { headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

before(async () => {
  fs.mkdirSync(config.contentDir, { recursive: true });
  filePath = path.join(config.contentDir, 'range-fixture.bin');
  fs.writeFileSync(filePath, BODY);
  // workspace_id NULL is readable by any authenticated caller (checkContentRead), which keeps the
  // fixture to one row.
  db.prepare('INSERT INTO content (id, filename, mime_type, file_size, filepath) VALUES (?,?,?,?,?)')
    .run(ID, 'range-fixture.bin', 'application/octet-stream', BODY.length, 'range-fixture.bin');

  const app = express();
  app.use((r, _res, next) => { r.workspaceId = 'ws'; r.user = { id: 'u', role: 'admin' }; next(); });
  app.use('/', require('../routes/content'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((r) => server.close(r)));

test('the route advertises range support', async () => {
  const r = await req({});
  assert.equal(r.status, 200);
  assert.equal(r.headers['accept-ranges'], 'bytes');
  assert.equal(r.body.length, BODY.length);
});

test('a resume request returns 206 with exactly the remaining bytes', async () => {
  // This is the player's second attempt: 400 bytes already on disk in the .part, ask for the rest.
  const r = await req({ Range: 'bytes=400-' });
  assert.equal(r.status, 206, 'a resume must not be answered with the whole file');
  assert.equal(r.headers['content-range'], `bytes 400-999/${BODY.length}`);
  assert.deepEqual(r.body, BODY.subarray(400), 'the tail must line up byte-for-byte with the head already cached');
});

test('the declared total in Content-Range is what the player validates completeness against', async () => {
  // The player has no other trustworthy source for the full size: Content-Length on a 206 is the
  // length of the CHUNK. Parsing the total out of Content-Range is what stops a resumed download
  // being promoted while still short.
  const r = await req({ Range: 'bytes=999-' });
  assert.equal(r.status, 206);
  assert.match(r.headers['content-range'], /\/1000$/);
  assert.equal(r.body.length, 1);
});

test('a request starting past the end is refused, not answered with an empty body', async () => {
  // The player treats this as "my .part is stale or longer than the asset" and starts over. If the
  // server answered 200/206-with-nothing instead, the bad .part would survive every retry.
  const r = await req({ Range: 'bytes=5000-' });
  assert.equal(r.status, 416);
});

test('If-Range with a stale validator falls back to the WHOLE file instead of a splice', async () => {
  // The one that actually protects the cache. If the asset changed since the .part was started,
  // appending the tail of the new file to the head of the old one produces a corrupt asset whose
  // byte count is nonetheless exactly right — it would pass the completeness check and be played.
  // If-Range makes the server answer 200, and the player restarts from zero.
  const r = await req({ Range: 'bytes=400-', 'If-Range': '"not-the-current-etag"' });
  assert.equal(r.status, 200, 'a changed entity must yield the full body, not a 206 tail');
  assert.equal(r.body.length, BODY.length);
});

test('If-Range with the CURRENT validator still resumes', async () => {
  const head = await req({});
  const etag = head.headers.etag;
  assert.ok(etag, 'no ETag means the player has no validator to send and every resume restarts');
  const r = await req({ Range: 'bytes=400-', 'If-Range': etag });
  assert.equal(r.status, 206);
  assert.deepEqual(r.body, BODY.subarray(400));
});

test('remote-url content still 404s rather than serving a range of nothing', async () => {
  db.prepare('INSERT INTO content (id, filename, mime_type, file_size, remote_url) VALUES (?,?,?,?,?)')
    .run('range-remote', 'feed', 'text/html', 0, 'https://example.com/');
  const r = await new Promise((resolve, reject) => {
    http.get(`${base}/range-remote/file`, { headers: { Range: 'bytes=0-' } }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode }));
    }).on('error', reject);
  });
  assert.equal(r.status, 404);
});
