'use strict';

// getClientIp() decides the value every per-IP control keys on: the login/register/pairing
// rate limiters, lib/pair-lockout, and the ip_address column in activity_log. If a caller
// can choose that value, all of those controls are advisory.
//
// The invariant: `CF-Connecting-IP` is only believed when the request genuinely arrived
// through Cloudflare — i.e. the immediate TCP peer is a Cloudflare edge address. A local
// reverse proxy (loopback / LAN / unique-local) is NOT evidence of that: nginx forwards
// whatever header the client sent, so trusting the header on a loopback peer means
// trusting the client.
//
// This matters most for SELF-HOSTED installs, which are the majority and mostly do NOT
// use Cloudflare: for them the header must simply be ignored, and attribution falls back
// to req.ip via each operator's own `trust proxy` setting.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { getClientIp } = require('../services/activity');
const { cloudflareIpv4 } = require('../config/cloudflareIps');

// A real address inside Cloudflare's published v4 ranges (173.245.48.0/20).
const CF_EDGE = '173.245.48.1';
const NOT_CF = '203.0.113.10';   // TEST-NET-3 — never a Cloudflare edge

function reqFrom(peer, headers = {}, reqIp = undefined) {
  return { headers, socket: { remoteAddress: peer }, ip: reqIp === undefined ? peer : reqIp };
}

test('a Cloudflare edge peer IS believed (hosted deployments keep working)', () => {
  assert.ok(cloudflareIpv4.includes('173.245.48.0/20'), 'fixture address is in a published CF range');
  const ip = getClientIp(reqFrom(CF_EDGE, { 'cf-connecting-ip': '198.51.100.7' }, CF_EDGE));
  assert.equal(ip, '198.51.100.7', 'through Cloudflare, the header is the real client');
});

test('a LOOPBACK peer is not evidence of Cloudflare — the header is ignored', () => {
  // This is the self-hosted-behind-nginx shape: nginx is the peer, and it forwards any
  // CF-Connecting-IP the client invented.
  const ip = getClientIp(reqFrom('127.0.0.1', { 'cf-connecting-ip': '203.0.113.77' }, '203.0.113.200'));
  assert.notEqual(ip, '203.0.113.77', 'a forged CF-Connecting-IP must not become the client IP');
  assert.equal(ip, '203.0.113.200', 'attribution falls back to req.ip (operator trust-proxy config)');
});

test('a LAN / unique-local peer is not evidence of Cloudflare either', () => {
  for (const peer of ['10.0.0.5', '192.168.1.10', 'fd00::1']) {
    const ip = getClientIp(reqFrom(peer, { 'cf-connecting-ip': '203.0.113.77' }, '198.51.100.99'));
    assert.notEqual(ip, '203.0.113.77', `forged header honoured for peer ${peer}`);
  }
});

test('a direct, non-proxied caller cannot self-attribute', () => {
  const ip = getClientIp(reqFrom(NOT_CF, { 'cf-connecting-ip': '1.2.3.4' }, NOT_CF));
  assert.equal(ip, NOT_CF, 'the header from an untrusted peer is ignored');
});

test('no CF header at all -> req.ip, unchanged for every non-Cloudflare install', () => {
  assert.equal(getClientIp(reqFrom('203.0.113.5', {}, '203.0.113.5')), '203.0.113.5');
});

test('malformed / empty header values fall through rather than throwing', () => {
  for (const v of ['', '   ', 'not-an-ip', undefined]) {
    const r = reqFrom('127.0.0.1', v === undefined ? {} : { 'cf-connecting-ip': v }, '198.51.100.1');
    assert.doesNotThrow(() => getClientIp(r));
    assert.equal(getClientIp(r), '198.51.100.1');
  }
});
