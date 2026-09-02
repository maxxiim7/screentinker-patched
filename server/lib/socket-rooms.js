// Phase 2.3: helpers for resolving socket.io room names per workspace /
// device / wall. Extracted from ws/dashboardSocket.js to break a circular
// dependency: dashboardSocket already requires services/heartbeat, so
// heartbeat can't require dashboardSocket. Everything goes through this
// neutral module instead.
const { db } = require('../db/database');

const ROOM_PREFIX = 'workspace:';

function workspaceRoom(workspaceId) {
  return workspaceId ? ROOM_PREFIX + workspaceId : null;
}

function deviceRoom(deviceId) {
  if (!deviceId) return null;
  const d = db.prepare('SELECT workspace_id FROM devices WHERE id = ?').get(deviceId);
  return d?.workspace_id ? workspaceRoom(d.workspace_id) : null;
}

function wallRoom(wallId) {
  if (!wallId) return null;
  const w = db.prepare('SELECT workspace_id FROM video_walls WHERE id = ?').get(wallId);
  return w?.workspace_id ? workspaceRoom(w.workspace_id) : null;
}

// Emit to a workspace room with no-op on missing room. Centralized so callers
// don't have to remember the "skip if null room" guard - silent drop is safer
// than the pre-2.3 platform-wide broadcast.
function emitToWorkspace(ns, room, event, payload) {
  if (!room) return;
  ns.to(room).emit(event, payload);
}

module.exports = { workspaceRoom, deviceRoom, wallRoom, emitToWorkspace };
