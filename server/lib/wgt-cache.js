'use strict';

// Resolve the Tizen .wgt for the SSSP URL-Launcher install flow (mirrors lib/apk-cache.js).
// The path/size/mtime are resolved once at boot and refreshed on an interval, so a panel
// polling /tizen/sssp_config.xml can never turn into a per-request statSync flood.
//
// The SIGNED .wgt is provided out-of-band (like the APK): container operators mount it at
// /data/ScreenTinker.wgt. The in-repo tizen/ copy (usually unsigned, inspection-only) is a
// last-resort fallback so a dev box still serves *something*.
//
// size is the load-bearing field — sssp_config.xml must report the EXACT byte length of the
// file the panel then downloads, or the install fails. We always derive it from the real file.

const fs = require('fs');
const path = require('path');
const config = require('../config');

function candidates() {
  return [
    path.join(config.dataDir, 'ScreenTinker.wgt'),          // operator mount (signed) — wins
    path.join(__dirname, '..', '..', 'ScreenTinker.wgt'),   // repo root (release artifact)
    path.join(__dirname, '..', '..', 'tizen', 'ScreenTinker.wgt'), // in-repo build (usually unsigned)
  ];
}

// Version reported in sssp_config.xml <ver>. A panel re-installs when this changes, so it must
// bump on each release — hence the app version (single source: package.json), overridable via env
// when an operator hosts a differently-versioned signed build.
const VERSION = process.env.TIZEN_WGT_VER || (() => {
  try { return require('../package.json').version; } catch (_) { return '1.0.0'; }
})();

let cache = { path: null, exists: false, size: 0, mtime: 0, version: VERSION };

function refresh() {
  for (const p of candidates()) {
    try {
      const st = fs.statSync(p);
      cache = { path: p, exists: true, size: st.size, mtime: st.mtimeMs, version: VERSION };
      return cache;
    } catch (_) { /* next candidate */ }
  }
  cache = { path: null, exists: false, size: 0, mtime: 0, version: VERSION };
  return cache;
}

function get() { return cache; }

let timer = null;
function start() {
  refresh();
  if (!timer) {
    timer = setInterval(refresh, config.otaApkRefreshMs);  // reuse the APK refresh cadence
    if (timer.unref) timer.unref();
  }
  return cache;
}

// The SSSP manifest the panel fetches at <entered-url>/sssp_config.xml. widgetname (no extension)
// tells the panel to download <widgetname>.wgt from the same directory — we serve it at
// /tizen/ScreenTinker.wgt. webtype=tizen marks it a Tizen web app.
function ssspConfigXml(wgt = cache) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<widget>
\t<ver>${wgt.version}</ver>
\t<size>${wgt.size}</size>
\t<widgetname>ScreenTinker</widgetname>
\t<webtype>tizen</webtype>
</widget>
`;
}

module.exports = { start, refresh, get, ssspConfigXml, WIDGET_NAME: 'ScreenTinker' };
