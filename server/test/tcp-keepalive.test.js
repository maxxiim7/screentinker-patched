'use strict';

// #148 Item 4 — SO_KEEPALIVE is applied to every accepted connection.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { applyTcpKeepAlive } = require('../lib/tcp-keepalive');

test('applyTcpKeepAlive enables keepalive on each accepted connection', () => {
  const server = new EventEmitter();
  applyTcpKeepAlive(server, 20000);
  const calls = [];
  server.emit('connection', { setKeepAlive: (enable, ms) => calls.push([enable, ms]) });
  server.emit('connection', { setKeepAlive: (enable, ms) => calls.push([enable, ms]) });
  assert.deepEqual(calls, [[true, 20000], [true, 20000]]);
});

test('a socket that throws on setKeepAlive never breaks connection setup', () => {
  const server = new EventEmitter();
  applyTcpKeepAlive(server, 20000);
  assert.doesNotThrow(() => server.emit('connection', { setKeepAlive: () => { throw new Error('boom'); } }));
});
