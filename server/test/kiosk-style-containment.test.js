'use strict';

// A kiosk's style values are interpolated into a <style> block, so they must be validated as CSS,
// not as HTML.
//
// escapeHtml() is the wrong tool there twice over: it escapes & < > " ' but NOT { } ;, and inside
// a raw-text <style> element the entities it does produce are never decoded — so it neither
// contains the value nor renders it. A value like
//     red} body{background:url(https://attacker/x)
// closes the declaration, closes the rule, and appends an arbitrary one. There is no XSS
// (</style> cannot be reached), but every panel displaying that kiosk page then fetches an
// attacker-chosen URL — an outbound beacon, and a tracking channel across sites.
//
// The containment is STRUCTURAL, not an allowlist of values: `background` is a free-text field in
// the editor, so linear-gradient(), rgb() and url() are all legitimate and must keep working.
// Only characters that could terminate the declaration or open a new rule are refused.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');

const { freePort } = require('./helpers/free-port');
let PORT, BASE, proc;
const DATA_DIR = path.join(os.tmpdir(), 'st-kioskcss-' + crypto.randomBytes(4).toString('hex'));
const LOG = path.join(os.tmpdir(), 'st-kioskcss-' + crypto.randomBytes(4).toString('hex') + '.log');
const S = {};

const jfetch = async (p, opts = {}) => {
  const res = await fetch(BASE + p, opts);
  const raw = await res.text();
  let body = null; try { body = JSON.parse(raw); } catch { /* html */ }
  return { status: res.status, body, text: raw };
};
const auth = () => ({ Authorization: 'Bearer ' + S.token, 'Content-Type': 'application/json' });

before(async () => {
  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  const logFd = fs.openSync(LOG, 'w');
  proc = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(PORT), NODE_ENV: 'test' },
    stdio: ['ignore', logFd, logFd],
  });
  let up = false;
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(BASE + '/api/status'); if (r.ok) { up = true; break; } } catch { /* */ }
    await new Promise(r => setTimeout(r, 250));
  }
  if (!up) throw new Error('server did not boot:\n' + fs.readFileSync(LOG, 'utf8').slice(-2000));
  const reg = await jfetch('/api/auth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'k' + crypto.randomBytes(5).toString('hex') + '@x.local', password: 'Passw0rd123' }),
  });
  S.token = reg.body.token;
});
after(() => { try { proc.kill('SIGKILL'); } catch { /* */ } });

async function renderWithStyle(style) {
  const r = await jfetch('/api/kiosk', {
    method: 'POST', headers: auth(),
    body: JSON.stringify({ name: 'k' + crypto.randomBytes(4).toString('hex'), config: { title: 'T', style, buttons: [] } }),
  });
  assert.ok(r.body && r.body.id, `kiosk created (got ${r.status})`);
  const page = await jfetch(`/api/kiosk/${r.body.id}/render`);
  assert.equal(page.status, 200);
  const block = (page.text.match(/<style[^>]*>([\s\S]*?)<\/style>/i) || [])[1] || '';
  assert.ok(block.length > 0, 'a style block was rendered');
  return block;
}

test('THE BUG: a value cannot close the declaration and append its own rule', async () => {
  const block = await renderWithStyle({
    background: 'red} body{background:url(https://attacker.invalid/beacon)} .x{color:blue',
  });
  assert.ok(!block.includes('attacker.invalid'), 'the attacker URL must not reach the style block');
  // NOTE: a bare /}\s*body\s*{/ would match the LEGITIMATE stylesheet (`* { ... }` precedes
  // `body { ... }`), so assert on the payload's own fragments instead.
  assert.ok(!block.includes('.x{color:blue'), 'no injected selector');
  assert.ok(!block.includes('url(https://attacker'), 'no injected url()');
  assert.ok(block.includes('background:#111827'), 'the value fell back to the default background');
});

test('font-family cannot inject either', async () => {
  const block = await renderWithStyle({ fontFamily: 'Arial} .pwn{content:"x"' });
  assert.ok(!block.includes('.pwn'), 'no injected selector');
  assert.ok(block.includes('-apple-system'), 'fell back to the default font stack');
});

test('a CSS comment cannot swallow the declarations that follow', async () => {
  const block = await renderWithStyle({ background: '#fff /* ' });
  assert.ok(!block.includes('/*'), 'comment syntax is refused');
});

test('newlines and control characters are refused', async () => {
  const block = await renderWithStyle({ background: '#fff\n} body{color:red' });
  assert.ok(!block.includes('body{color:red'), 'a newline does not smuggle a rule through');
  assert.ok(block.includes('background:#111827'), 'and the value fell back');
});

// The containment must not break the field's legitimate use — `background` is free text.
test('gradients, rgb() and url() backgrounds still work', async () => {
  for (const value of [
    'linear-gradient(180deg, #111827 0%, #1f2937 100%)',
    'rgb(17, 24, 39)',
    'rgba(17,24,39,0.9)',
    '#111827',
    'url(https://cdn.example.com/bg.png) center/cover no-repeat',
  ]) {
    const block = await renderWithStyle({ background: value });
    assert.ok(block.includes(value), `legitimate background preserved: ${value}`);
  }
});

test('ordinary font stacks still work', async () => {
  for (const value of ['-apple-system,sans-serif', '"Helvetica Neue", Arial, sans-serif', 'Roboto']) {
    const block = await renderWithStyle({ fontFamily: value });
    assert.ok(block.includes(value), `legitimate font-family preserved: ${value}`);
  }
});

test('an absent style still renders the defaults', async () => {
  const block = await renderWithStyle({});
  assert.ok(block.includes('#111827') && block.includes('-apple-system'), 'defaults applied');
});
