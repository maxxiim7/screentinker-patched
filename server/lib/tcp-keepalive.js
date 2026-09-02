'use strict';

// #148 Item 4 — enable TCP SO_KEEPALIVE on every accepted connection so a half-open TCP
// (e.g. a connection severed silently by an edge firewall/NAT reap, leaving no FIN) can't
// persist indefinitely at the OS layer, independent of the Engine.IO application ping. The
// http/https server's 'connection' event fires with the raw net.Socket (before TLS), which
// is where setKeepAlive belongs. Best-effort — never let it break connection setup.
function applyTcpKeepAlive(server, idleMs) {
  server.on('connection', (socket) => {
    try { socket.setKeepAlive(true, idleMs); } catch (_) { /* best-effort */ }
  });
}

module.exports = { applyTcpKeepAlive };
