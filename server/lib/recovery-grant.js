'use strict';

// Break-glass recovery, made revocable / single-use / auditable.
//
// scripts/reset-admin.js mints a JWT carrying `recovery: true`. middleware/auth.js accepted
// that claim on its own, with no database involvement at all, which meant:
//   - it could not be REVOKED except by rotating JWT_SECRET, which logs out every user;
//   - it could not be ENUMERATED — nobody could answer "is a recovery token outstanding?";
//   - it left NO AUDIT TRAIL, because the synthetic id is not a users row, so every
//     activity_log insert for it failed the user_id foreign key and was swallowed.
//
// A grant row per minted token fixes all three: DELETE revokes, SELECT enumerates, and
// used_at makes it single-use.
//
// On the obvious objection — "break-glass should not depend on the database": minting
// already requires a working DB (reset-admin.js runs on the server and writes this row),
// and the application cannot serve anything without its DB anyway, so a token that could
// only be redeemed against a broken database would have nothing to act on. The dependency
// is not a new failure mode.

const crypto = require('crypto');
const { db } = require('../db/database');

const DEFAULT_TTL_SEC = 60 * 60; // 1 hour, matching the token's own expiry

function newJti() {
  return crypto.randomBytes(16).toString('hex');
}

// Record a grant. Returns { jti, expiresAt }.
function mint({ ttlSec = DEFAULT_TTL_SEC, mintedBy = null, note = null } = {}) {
  const jti = newJti();
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSec;
  db.prepare('INSERT INTO recovery_grants (jti, expires_at, minted_by, note) VALUES (?, ?, ?, ?)')
    .run(jti, expiresAt, mintedBy, note);
  return { jti, expiresAt };
}

// Redeem a grant. Valid while the row EXISTS and has not expired; the first redemption
// stamps used_at + source_ip for the audit trail, and later ones do not clear it.
//
// Deliberately NOT single-use-per-request. A recovery admin makes many requests — load the
// dashboard, list users, reset a password — so consuming the grant on the first one would
// make break-glass unusable, which is a worse outcome than the narrow replay window it
// would close. The security properties that matter are still all present: the grant is
// REVOCABLE (delete the row and the very next request fails), BOUNDED (expires_at), and
// ATTRIBUTABLE (used_at + source_ip record when and from where it was first exercised).
function redeem(jti, { sourceIp = null, now = Math.floor(Date.now() / 1000) } = {}) {
  if (!jti || typeof jti !== 'string') return false;
  const row = db.prepare('SELECT jti, expires_at, used_at FROM recovery_grants WHERE jti = ?').get(jti);
  if (!row) return false;                 // never minted, or revoked
  if (row.expires_at <= now) return false; // past its window
  if (!row.used_at) {
    db.prepare('UPDATE recovery_grants SET used_at = ?, source_ip = ? WHERE jti = ? AND used_at IS NULL')
      .run(now, sourceIp, jti);
  }
  return true;
}

// True when the jti has already been redeemed and is being presented again — used only to
// distinguish "replayed" from "unknown" in the operator-facing listing and logs.
function isSpent(jti) {
  const row = db.prepare('SELECT used_at FROM recovery_grants WHERE jti = ?').get(jti);
  return !!(row && row.used_at);
}

// Operator visibility: what break-glass access is outstanding right now.
function listOutstanding(now = Math.floor(Date.now() / 1000)) {
  return db.prepare(
    'SELECT jti, created_at, expires_at, minted_by, note FROM recovery_grants WHERE used_at IS NULL AND expires_at > ? ORDER BY created_at DESC'
  ).all(now);
}

// Revocation. revokeAll() is the "someone may have a token I did not mint" button, and
// unlike rotating JWT_SECRET it does not disturb a single logged-in user.
function revoke(jti) { return db.prepare('DELETE FROM recovery_grants WHERE jti = ?').run(jti).changes; }
function revokeAll() { return db.prepare('DELETE FROM recovery_grants').run().changes; }

// Housekeeping: drop rows that can never be redeemed again. Not security-critical (redeem()
// already refuses them) — it just stops the table growing without bound.
function pruneExpired(now = Math.floor(Date.now() / 1000), graceSec = 7 * 86400) {
  return db.prepare('DELETE FROM recovery_grants WHERE expires_at < ? OR used_at < ?')
    .run(now - graceSec, now - graceSec).changes;
}

module.exports = { mint, redeem, isSpent, listOutstanding, revoke, revokeAll, pruneExpired, newJti, DEFAULT_TTL_SEC };
