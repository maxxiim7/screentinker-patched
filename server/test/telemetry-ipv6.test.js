'use strict';

/*
 * A panel's own IPv6 address has to survive the trip from the player to the dashboard.
 *
 * It never used to exist: the Android collector filtered to Inet4Address, so a v6-only screen
 * reported no address at all and the dashboard rendered a dash for a panel that was perfectly
 * reachable. The fix is two columns rather than one, because a dual-stack panel genuinely has
 * both and collapsing them would make the field mean "whichever interface enumerated first".
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

test('the Android collector reports BOTH stacks, not whichever it finds first', () => {
  const src = read('android/app/src/main/java/com/remotedisplay/player/telemetry/DeviceInfo.kt');
  assert.match(src, /put\("local_ip6"/, 'telemetry must carry local_ip6');
  assert.match(src, /getLocalIp6/, 'there must be a v6 collector');
  // The v4 one keeps its filter — this is an addition, not a replacement. A v4 panel must keep
  // reporting exactly what it reported before.
  assert.match(src, /addr is java\.net\.Inet4Address/, 'local_ip stays IPv4-only');
});

test('link-local v6 is excluded — it cannot be dialled without a zone index', () => {
  const src = read('android/app/src/main/java/com/remotedisplay/player/telemetry/DeviceInfo.kt');
  const fn = src.slice(src.indexOf('private fun getLocalIp6'), src.indexOf('private fun getWifiRSSI'));
  assert.ok(fn.length > 0, 'getLocalIp6 not found');
  for (const guard of ['isLinkLocalAddress', 'isLoopbackAddress', 'isAnyLocalAddress', 'isMulticastAddress']) {
    assert.ok(fn.includes(guard), `getLocalIp6 must skip ${guard} addresses`);
  }
  // Every interface has an fe80:: address and it is usually enumerated first, so without this the
  // field would fill up with strings nobody can paste anywhere and hide the useful address.
  assert.match(fn, /substringBefore\('%'\)/, 'a %iface suffix must be trimmed before it reaches the UI');
});

test('the column exists, holds a full-length v6 address, and is separate from local_ip', () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE device_telemetry (id INTEGER PRIMARY KEY, device_id TEXT, local_ip TEXT)');
  // The same statement the migration list runs.
  db.exec('ALTER TABLE device_telemetry ADD COLUMN local_ip6 TEXT');

  const v6 = '2001:0db8:85a3:0000:0000:8a2e:0370:7334';
  db.prepare('INSERT INTO device_telemetry (device_id, local_ip, local_ip6) VALUES (?, ?, ?)')
    .run('d1', '192.168.1.42', v6);
  const row = db.prepare('SELECT local_ip, local_ip6 FROM device_telemetry WHERE device_id = ?').get('d1');
  assert.equal(row.local_ip, '192.168.1.42', 'the v4 address is untouched by the addition');
  assert.equal(row.local_ip6, v6);

  // 45 characters is the longest legitimate IPv6 text form (IPv4-mapped, ::ffff:255.255.255.255).
  // The write path caps at 45, so a real address must never be truncated by it.
  assert.ok('::ffff:255.255.255.255'.length <= 45);
  assert.ok(v6.length <= 45, 'a full uncompressed v6 address fits the cap the writer applies');
  db.close();
});

test('the migration is registered, and does not replace the v4 column', () => {
  const src = read('server/db/database.js');
  assert.match(src, /ALTER TABLE device_telemetry ADD COLUMN local_ip6 TEXT/);
  assert.match(src, /ALTER TABLE device_telemetry ADD COLUMN local_ip TEXT/);
});

test('the server stores what the player sends, capped like its neighbour', () => {
  const src = read('server/ws/deviceSocket.js');
  assert.match(src, /local_ip, local_ip6, temperature_c/, 'the INSERT must name the new column');
  assert.match(
    src,
    /typeof telemetry\.local_ip6 === 'string' \? telemetry\.local_ip6\.trim\(\)\.slice\(0, 45\)/,
    'device-supplied text headed for the dashboard must be trimmed and capped',
  );
});

test('both addresses reach the dashboard, and the v6 card only appears when there is one', () => {
  const api = read('server/routes/devices.js');
  assert.match(api, /t\.local_ip, t\.local_ip6/, 'the device list must select the new column');

  const ui = read('frontend/js/views/device-detail.js');
  assert.match(ui, /device\.local_ip6 \?/, 'the card must be conditional — no empty row for a v4-only fleet');
  assert.match(ui, /telLocalIp6/);
  assert.match(ui, /device\.info\.local_ip6/, 'the label must go through i18n, not be hardcoded');
});

test('every locale has the label — a missing key renders as the raw key', () => {
  for (const lang of ['en', 'es', 'fr', 'de', 'pt', 'it']) {
    const src = read(`frontend/js/i18n/${lang}.js`);
    assert.match(src, /'device\.info\.local_ip6':/, `${lang} is missing device.info.local_ip6`);
  }
});
