'use strict';

// This is the riskiest self-update in the product. An Android OTA that goes wrong leaves a player on
// the old APK. A BrightSign package update that goes wrong replaces THE SCRIPT THAT BOOTS THE
// PLAYER — there is no app underneath to fall back to, so a truncated or half-applied autorun.brs is
// a dark panel and a site visit.
//
// Every test here names a way that happens.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const U = require('../lib/brightsign-update');

const base = {
  currentVersion: '1.9.28',
  manifestVersion: '1.9.29',
  manifestSha256: 'abc123',
  attempts: 0
};

// ---------------------------------------------------------------- the prerelease scar

test('THE REVERT: a release must not overwrite the prerelease someone is testing', () => {
  // 1.9.29-rc1 is semver-OLDER than 1.9.29. Without this the player asks "anything newer?", is
  // correctly told yes, and wipes the build it was handed to test. That cost a reporter an evening
  // on the Android side; here it would overwrite the boot script.
  const r = U.decidePackageUpdate({
    ...base, currentVersion: '1.9.29-rc1', manifestVersion: '1.9.29', allowPrerelease: true
  });
  assert.equal(r.action, 'skip');
});

test('prerelease ordering is right: rc1 < rc2 < release', () => {
  assert.equal(U.compareVersions('1.9.29-rc1', '1.9.29-rc2'), -1);
  assert.equal(U.compareVersions('1.9.29-rc2', '1.9.29'), -1);
  assert.equal(U.compareVersions('1.9.29', '1.9.29-rc1'), 1);
  assert.equal(U.compareVersions('1.9.29', '1.9.29'), 0);
  assert.equal(U.compareVersions('1.10.0', '1.9.99'), 1, 'numeric, not lexicographic');
});

test('a prerelease is never applied without opt-in, mirroring the Android beta channel', () => {
  const r = U.decidePackageUpdate({ ...base, manifestVersion: '1.9.30-rc1' });
  assert.equal(r.action, 'skip');
  assert.match(r.reason, /opt-in/);

  const opted = U.decidePackageUpdate({ ...base, manifestVersion: '1.9.30-rc1', allowPrerelease: true });
  assert.equal(opted.action, 'download');
});

// ---------------------------------------------------------------- refusing to brick

test('THE OUTAGE: no reachable manifest means keep running, never wipe', () => {
  // The common case during exactly the failure this whole feature is meant to survive.
  const r = U.decidePackageUpdate({ ...base, manifestVersion: null });
  assert.equal(r.action, 'skip');
  assert.equal(r.reason, 'no manifest');
});

test('a manifest with no checksum is refused — unverifiable is the truncation risk', () => {
  const r = U.decidePackageUpdate({ ...base, manifestSha256: null });
  assert.equal(r.action, 'skip');
  assert.match(r.reason, /checksum/);
});

test('THE TRUNCATED DOWNLOAD: a staged package that fails its checksum is re-downloaded, not applied', () => {
  // Applying this overwrites autorun.brs with a partial file. The player boots into nothing.
  const r = U.decidePackageUpdate({ ...base, stagedSha256: 'WRONG' });
  assert.equal(r.action, 'download');
  assert.match(r.reason, /failed verification/);
});

test('a staged package that verifies is applied — download and apply are separate gates', () => {
  const r = U.decidePackageUpdate({ ...base, stagedSha256: 'abc123' });
  assert.equal(r.action, 'apply');
});

test('THE RETRY LOOP: repeated failure on one version stops rather than burning the link forever', () => {
  const r = U.decidePackageUpdate({ ...base, attempts: U.MAX_ATTEMPTS_PER_VERSION });
  assert.equal(r.action, 'skip');
  assert.match(r.reason, /too many failed attempts/);
});

test('attempts below the cap still try — one bad download must not park a player permanently', () => {
  assert.equal(U.decidePackageUpdate({ ...base, attempts: 1 }).action, 'download');
  assert.equal(U.decidePackageUpdate({ ...base, attempts: U.MAX_ATTEMPTS_PER_VERSION - 1 }).action, 'download');
});

// ---------------------------------------------------------------- idempotence / no loop

test('THE OTA LOOP: once current, the same version is never offered again', () => {
  // Install, report the old version, get offered it again, forever — the classic loop. Equality is
  // what breaks it, and it must hold for prereleases too.
  assert.equal(U.decidePackageUpdate({ ...base, currentVersion: '1.9.29' }).action, 'skip');
  assert.equal(U.decidePackageUpdate({
    ...base, currentVersion: '1.9.29-rc2', manifestVersion: '1.9.29-rc2', allowPrerelease: true
  }).action, 'skip');
});

test('an older advertised version is ignored, so a rolled-back server cannot downgrade a fleet', () => {
  const r = U.decidePackageUpdate({ ...base, currentVersion: '1.9.30', manifestVersion: '1.9.28' });
  assert.equal(r.action, 'skip');
  assert.match(r.reason, /older/);
});

test('a genuinely newer package is downloaded', () => {
  assert.equal(U.decidePackageUpdate(base).action, 'download');
});

test('missing state is treated as "do nothing" rather than throwing in a boot path', () => {
  // A throw here happens before the player starts; it must degrade, not explode.
  assert.doesNotThrow(() => U.decidePackageUpdate(undefined));
  assert.equal(U.decidePackageUpdate(undefined).action, 'skip');
  assert.equal(U.decidePackageUpdate({}).action, 'skip');
});

test('holding a prerelease is NARROW: a newer core still lands on an opted-in player', () => {
  // Otherwise "opt into testing" would quietly mean "never update again", which is how testers get
  // stranded on a branch nobody maintains.
  const r = U.decidePackageUpdate({
    ...base, currentVersion: '1.9.29-rc1', manifestVersion: '1.9.30', allowPrerelease: true
  });
  assert.equal(r.action, 'download');
});

test('a player that never opted in rejoins the release line from a stale test build', () => {
  // It is not testing anything, so leaving it on an orphaned build is worse than updating it.
  const r = U.decidePackageUpdate({
    ...base, currentVersion: '1.9.29-rc1', manifestVersion: '1.9.29', allowPrerelease: false
  });
  assert.equal(r.action, 'download');
});

// ---------------------------------------------------------------- the last gate

test('the apply gate demands a matching checksum', () => {
  assert.equal(U.isPackageSafeToApply('aaa', 'aaa', 50000), true);
  assert.equal(U.isPackageSafeToApply('aaa', 'bbb', 50000), false);
  assert.equal(U.isPackageSafeToApply(null, 'aaa', 50000), false);
  assert.equal(U.isPackageSafeToApply('aaa', null, 50000), false);
});

test('THE CAPTIVE PORTAL: a tiny file is refused even if the hash is somehow satisfied', () => {
  // A network that serves a login page in place of the download produces a small HTML body. It has
  // a hash like anything else; what it does not have is a plausible size for a player package.
  assert.equal(U.isPackageSafeToApply('aaa', 'aaa', 800), false);
  assert.equal(U.isPackageSafeToApply('aaa', 'aaa', 800, 1024), false);
  assert.equal(U.isPackageSafeToApply('aaa', 'aaa', 2048, 1024), true);
});

test('THE STUCK TESTER: an opted-in player moves forward rc1 -> rc3', () => {
  // The hold rule exists so a test build is not dragged BACK to its release. Applied to another
  // PRERELEASE of the same core it froze testers on whichever build they were first handed, which
  // is the opposite of what opting in is for — and would have stopped our own XT245 ever receiving
  // the next candidate.
  const d = U.decidePackageUpdate({
    currentVersion: '1.9.29-rc1',
    manifestVersion: '1.9.29-rc3',
    manifestSha256: 'abc',
    allowPrerelease: true,
  });
  assert.equal(d.action, 'download', d.reason);
});

test('but it still holds against the RELEASE of its own core — the original scar', () => {
  const d = U.decidePackageUpdate({
    currentVersion: '1.9.29-rc1',
    manifestVersion: '1.9.29',
    manifestSha256: 'abc',
    allowPrerelease: true,
  });
  assert.equal(d.action, 'skip');
  assert.match(d.reason, /holding prerelease/);
});

test('and a newer CORE still lands, so opting in never means never updating', () => {
  const d = U.decidePackageUpdate({
    currentVersion: '1.9.29-rc1',
    manifestVersion: '1.9.30',
    manifestSha256: 'abc',
    allowPrerelease: true,
  });
  assert.equal(d.action, 'download');
});

test('a player NOT opted in is still refused a prerelease', () => {
  const d = U.decidePackageUpdate({
    currentVersion: '1.9.28',
    manifestVersion: '1.9.29-rc3',
    manifestSha256: 'abc',
    allowPrerelease: false,
  });
  assert.equal(d.action, 'skip');
  assert.match(d.reason, /requires opt-in/);
});
