'use strict';

// Why this exists: the auth limiters run as app.use middleware BEFORE the handler that writes
// activity_log, so a 429 leaves no trace anywhere. The limit censors the evidence of itself —
// four production IPs sit at exactly 10 logins/min and there is no way to tell whether that is
// one attacker or a NATed site whose staff are colliding on a shared egress IP.
//
// This records rejections so the question becomes measurable. The discriminating signal is NOT
// the rejection count, it is how many DISTINCT accounts a single IP is rejected for:
//
//   1 identifier, many rejections   -> someone hammering one account (the limiter is working)
//   many identifiers, few each      -> a shared egress IP; real users are being denied
//
// Identifiers are salted-hashed and only ever counted, never stored or logged in the clear —
// this is a diagnostic, not an audit trail, and it must not become a place where credentials
// or a roster of a customer's email addresses accumulate.

const crypto = require('crypto');

const MAX_KEYS = 2000;          // distinct endpoint|ip pairs held
const MAX_IDS_PER_KEY = 64;     // enough to tell "one" from "many"; caps memory per key
const IDLE_MS = 60 * 60 * 1000; // drop a key after an hour of quiet

// Per-process salt: makes the digests useless outside this process lifetime, so nothing
// persisted or logged can be walked back to an address.
const SALT = crypto.randomBytes(16);
const digest = (s) => crypto.createHash('sha256').update(SALT).update(String(s).toLowerCase()).digest('hex').slice(0, 16);

const state = new Map();

function prune(now) {
  for (const [k, v] of state) if (now - v.lastSeen > IDLE_MS) state.delete(k);
  if (state.size <= MAX_KEYS) return;
  // Still oversized: evict the least recently seen.
  const byAge = [...state.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen);
  for (let i = 0; i < byAge.length - MAX_KEYS; i++) state.delete(byAge[i][0]);
}

// Returns the running tally for this endpoint+ip, so the caller can log it.
function recordRejection({ endpoint, ip, identifier }, now = Date.now()) {
  const key = `${endpoint}|${ip}`;
  let e = state.get(key);
  if (!e) { e = { rejections: 0, ids: new Set(), idsTruncated: false, firstSeen: now, lastSeen: now }; state.set(key, e); }
  e.rejections++;
  e.lastSeen = now;
  if (identifier) {
    if (e.ids.size < MAX_IDS_PER_KEY) e.ids.add(digest(identifier));
    else e.idsTruncated = true;
  }
  if (state.size > MAX_KEYS) prune(now);
  return {
    endpoint, ip,
    rejections: e.rejections,
    distinctIdentifiers: e.ids.size,
    identifiersTruncated: e.idsTruncated,
    windowMs: now - e.firstSeen,
  };
}

// Read-only view for a debug endpoint or a test. No digests are exposed — only counts.
function snapshot() {
  return [...state.entries()].map(([key, e]) => {
    const i = key.lastIndexOf('|');
    return {
      endpoint: key.slice(0, i),
      ip: key.slice(i + 1),
      rejections: e.rejections,
      distinctIdentifiers: e.ids.size,
      identifiersTruncated: e.idsTruncated,
      firstSeen: e.firstSeen,
      lastSeen: e.lastSeen,
      // The whole point: many identifiers from one IP reads as a shared egress, not an attack.
      likelySharedEgress: e.ids.size >= 3,
    };
  }).sort((a, b) => b.rejections - a.rejections);
}

function reset() { state.clear(); }

module.exports = { recordRejection, snapshot, reset, MAX_IDS_PER_KEY, MAX_KEYS };
