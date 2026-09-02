#!/usr/bin/env node
// Phase 1 multitenancy parity check.
//
// Compares per-user resource counts between the pre-migration snapshot and
// the current DB. Every row must end up in exactly one workspace owned by
// the original user. Drift = bug.
//
// Usage:
//   node scripts/parity-multitenancy.js
//
// Exits non-zero on any drift.

'use strict';

const path = require('path');
const SERVER_DIR = path.resolve(__dirname, '..', 'server');
process.chdir(SERVER_DIR);
const { Database } = require(path.join(SERVER_DIR, 'db', 'sqlite-driver.js'));
const config = require(path.join(SERVER_DIR, 'config'));

const PRE  = path.resolve(SERVER_DIR, 'db', 'remote_display.pre-multitenancy.db');
const POST = config.dbPath;

console.log(`[parity] pre  = ${PRE}`);
console.log(`[parity] post = ${POST}`);

const pre  = new Database(PRE,  { readonly: true });
const post = new Database(POST, { readonly: true });

const TABLES = ['devices','content','playlists','layouts','widgets','schedules','video_walls','device_groups','white_labels','kiosk_pages','alert_configs'];
const users = pre.prepare('SELECT id, email FROM users').all();
let pass = 0, fail = 0;

console.log('\n--- per-user, per-table row counts ---');
for (const u of users) {
  for (const t of TABLES) {
    const preN  = pre.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE user_id = ?`).get(u.id).n;
    // Post: rows belonging to any workspace owned by an org owned by this user.
    let postN;
    try {
      postN = post.prepare(`
        SELECT COUNT(*) AS n FROM ${t} r
        WHERE r.workspace_id IN (
          SELECT w.id FROM workspaces w
          JOIN organizations o ON w.organization_id = o.id
          WHERE o.owner_user_id = ?
        )
      `).get(u.id).n;
    } catch (e) {
      postN = '<no workspace_id col>';
    }
    const ok = preN === postN;
    if (preN === 0 && postN === 0) continue;
    console.log(`  ${u.email.padEnd(30)} ${t.padEnd(16)} pre=${String(preN).padStart(4)} post=${String(postN).padStart(4)}  ${ok ? 'PASS' : 'FAIL'}`);
    if (ok) pass++; else fail++;
  }
}

console.log('\n--- platform-wide totals ---');
const totalsPre  = {};
const totalsPost = {};
for (const t of TABLES) {
  totalsPre[t]  = pre .prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
  totalsPost[t] = post.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
  const ok = totalsPre[t] === totalsPost[t];
  console.log(`  ${t.padEnd(16)} pre=${String(totalsPre[t]).padStart(4)} post=${String(totalsPost[t]).padStart(4)}  ${ok ? 'PASS' : 'FAIL'}`);
  if (ok) pass++; else fail++;
}

console.log('\n--- new tables populated ---');
const newTables = ['organizations', 'organization_members', 'workspaces', 'workspace_members'];
for (const t of newTables) {
  const n = post.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
  console.log(`  ${t.padEnd(24)} rows=${n}`);
}

console.log('\n--- orphan check: rows with NON-NULL user_id but NULL workspace_id ---');
console.log('(rows with NULL user_id are unclaimed devices or platform templates - expected NULL workspace_id)');
for (const t of TABLES) {
  try {
    const realOrphans = post.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE user_id IS NOT NULL AND workspace_id IS NULL`).get().n;
    const expectedNulls = post.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE user_id IS NULL`).get().n;
    const tag = realOrphans > 0 ? 'FAIL' : 'PASS';
    console.log(`  ${t.padEnd(16)} bug_orphans=${realOrphans}  expected_nulls(user_id IS NULL)=${expectedNulls}  ${tag}`);
    if (realOrphans > 0) fail++; else pass++;
  } catch { /* no column */ }
}

console.log('\n--- role migration ---');
const sa  = post.prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'superadmin'`).get().n;
const pa  = post.prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'platform_admin'`).get().n;
const adm = post.prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin'`).get().n;
console.log(`  superadmin (should be 0)     : ${sa}`);
console.log(`  platform_admin (should be > 0 if any pre had superadmin): ${pa}`);
console.log(`  admin (should be 0)          : ${adm}`);
if (sa === 0 && adm === 0) pass++; else fail++;

console.log(`\n--- summary: ${pass} pass, ${fail} fail ---`);
pre.close(); post.close();
process.exit(fail === 0 ? 0 : 1);
