#!/usr/bin/env node
/**
 * Emergency admin access for self-hosted ScreenTinker.
 * Run this on the server to get a temporary admin login token.
 *
 *   node scripts/reset-admin.js              mint a one-hour, single-use token
 *   node scripts/reset-admin.js --list       show outstanding (unused, unexpired) grants
 *   node scripts/reset-admin.js --revoke-all revoke every outstanding grant
 *
 * The token is backed by a row in `recovery_grants`, which is what makes it revocable
 * (--revoke-all, rather than rotating JWT_SECRET and logging everyone out), enumerable
 * (--list), and single-use — redeeming it stamps used_at, so it cannot be replayed.
 *
 * The token is written to a 0600 file rather than printed. It used to go to stdout, which
 * under systemd or Docker means journald / the log driver captured a live admin credential
 * and kept it long past the token's own lifetime.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const config = require(path.join(__dirname, '..', 'server', 'config'));
const jwt = require(path.join(__dirname, '..', 'server', 'node_modules', 'jsonwebtoken'));
const grants = require(path.join(__dirname, '..', 'server', 'lib', 'recovery-grant'));

const arg = process.argv[2];

if (arg === '--list') {
  const rows = grants.listOutstanding();
  if (!rows.length) { console.log('No outstanding recovery grants.'); process.exit(0); }
  console.log(`${rows.length} outstanding recovery grant(s):`);
  for (const r of rows) {
    console.log(`  ${r.jti}  minted ${new Date(r.created_at * 1000).toISOString()}  expires ${new Date(r.expires_at * 1000).toISOString()}  by ${r.minted_by || '-'}`);
  }
  process.exit(0);
}

if (arg === '--revoke-all') {
  const n = grants.revokeAll();
  console.log(`Revoked ${n} recovery grant(s). Any outstanding token is now dead.`);
  process.exit(0);
}

const TTL_SEC = 60 * 60;
const mintedBy = `${os.userInfo().username}@${os.hostname()} pid:${process.pid}`;
const { jti, expiresAt } = grants.mint({ ttlSec: TTL_SEC, mintedBy, note: 'reset-admin.js' });

// `jti` is what middleware/auth.js looks up; without a matching grant the token is refused.
const token = jwt.sign(
  { id: 'recovery-' + jti, email: 'admin@localhost', role: 'admin', recovery: true, jti },
  config.jwtSecret,
  { expiresIn: TTL_SEC }
);

const outFile = path.join(config.certsDir, `recovery-${jti}.token`);
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, token + '\n', { mode: 0o600 });
try { fs.chmodSync(outFile, 0o600); } catch { /* best effort on exotic filesystems */ }

const port = config.port || 3001;

console.log(`
╔══════════════════════════════════════════════════╗
║         ScreenTinker Admin Recovery              ║
╠══════════════════════════════════════════════════╣
║  A single-use admin token has been generated.    ║
║  Valid for 1 hour, or until it is used once.     ║
╚══════════════════════════════════════════════════╝

  grant id : ${jti}
  expires  : ${new Date(expiresAt * 1000).toISOString()}
  token    : ${outFile}   (mode 0600 — deliberately NOT printed here)

Use it:

  TOKEN="$(cat ${outFile})"
  curl -H "Authorization: Bearer $TOKEN" http://localhost:${port}/api/devices

Or in the browser console on your instance:

  localStorage.setItem('token', '<paste the file contents>'); location.reload();

When you are done — or if you think it leaked:

  node scripts/reset-admin.js --revoke-all
  rm -f ${outFile}
`);
