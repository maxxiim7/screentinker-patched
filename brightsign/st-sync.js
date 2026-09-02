/*
 * ScreenTinker — BrightSign native synchronisation (SyncManager).
 *
 * The alternative to our own clock-derived group sync, for groups where every member is a
 * BrightSign. Frame-accurate, because it is the player's own video pipeline doing the aligning:
 * setSyncParams() is a BrightSign extension on the standard <video> element, and once it is set
 * the element keeps itself in step without further help.
 *
 * Shape of the protocol (docs.brightsign.biz/developers/syncmanager, and the dev-cookbook
 * examples/browser/syncmanager-js example):
 *
 *   - One member is the LEADER. It calls synchronize(id, msDelay), which multicasts a timestamped
 *     event. Everyone else listens. Ours is leaderless; this one is not, so the group needs a
 *     designated leader and goes unsynchronised if that member is off.
 *   - The leader receives its OWN broadcast and starts from it too. That is what stops it running
 *     ahead of the followers by the width of the network.
 *   - synchronize() REPEATS AT 1Hz so a player powered on late still joins the session. Acting on
 *     every repeat would reload the video once a second forever, which on screen looks like a
 *     stutter or a restart loop rather than a sync fault. Dedupe on the id — mandatory.
 *   - Multicast, so every member must share one L2 network. A group spanning sites or VLANs
 *     cannot use this at all.
 *
 * Requires BrightSignOS 8.2.10+, and networking/ptp_domain = "0" (autorun.brs applies that, with
 * the one reboot it needs).
 *
 * Video only: images and widgets have no setSyncParams, so they get item-boundary alignment from
 * the sync event and nothing finer. That is a real functional difference from our own protocol,
 * not just an accuracy one.
 *
 * Safe to load anywhere — with no SyncManager module every method is a no-op and available()
 * reports false, so the player falls back to its own sync.
 */
(function (global) {
  'use strict';

  // The cookbook's defaults. Kept as defaults rather than constants so a site with its own
  // multicast policy can be pointed elsewhere without a code change.
  var DEFAULTS = {
    networkInterface: '',            // '' = let the OS choose
    domain: 'ScreenTinkerSync',
    multicastAddress: '224.0.126.10',
    multicastPort: 1539,
    prepareMs: 1000                  // lead time so every member can load before playback starts
  };

  function tryRequire(name) {
    try {
      if (typeof require !== 'function') return null;
      return require(name);
    } catch (e) { return null; }
  }

  var SyncManagerClass = tryRequire('@brightsign/syncmanager');

  function Sync(options) {
    var opts = options || {};
    this.config = {
      networkInterface: opts.networkInterface !== undefined ? opts.networkInterface : DEFAULTS.networkInterface,
      domain: opts.domain || DEFAULTS.domain,
      multicastAddress: opts.multicastAddress || DEFAULTS.multicastAddress,
      multicastPort: opts.multicastPort || DEFAULTS.multicastPort,
      prepareMs: opts.prepareMs !== undefined ? opts.prepareMs : DEFAULTS.prepareMs
    };
    this.sm = null;
    this.isLeader = false;
    this.lastId = null;              // the dedupe that makes the 1Hz repeat harmless
    this.onItem = null;              // (syncEvent) => void, fired once per NEW id
    this.lastEvent = null;
  }

  Sync.prototype.available = function () { return !!SyncManagerClass; };

  /*
   * Join the sync session. `leader` designates this member as the one that broadcasts.
   * Returns false when the module is absent, so the caller can fall back rather than assume.
   */
  Sync.prototype.start = function (leader) {
    if (!SyncManagerClass) return false;
    if (this.sm) this.stop();

    try {
      this.sm = new SyncManagerClass(
        this.config.networkInterface,
        this.config.domain,
        this.config.multicastAddress,
        this.config.multicastPort
      );
    } catch (e) {
      this.sm = null;
      return false;
    }

    this.isLeader = !!leader;
    try {
      // A follower must NOT set this. Assigning false is harmless per the API, but the examples
      // simply omit it on followers, so match that.
      if (this.isLeader) this.sm.leader = true;
      this.sm.encrypted = false;
    } catch (e) { /* an older build may not expose every property */ }

    var self = this;
    try {
      this.sm.addEventListener('syncevent', function (e) { self._onEvent(e); });
    } catch (e) {
      this.stop();
      return false;
    }
    return true;
  };

  /* Internal. Both roles land here — including the leader, for its own broadcast. */
  Sync.prototype._onEvent = function (e) {
    if (!e || e.id === undefined || e.id === null) return;
    // THE trap: synchronize() repeats at 1Hz so late players can join. Only the first occurrence
    // of an id is a new session; every repeat after it must be ignored or the video reloads
    // once a second, forever.
    if (e.id === this.lastId) return;
    this.lastId = e.id;
    this.lastEvent = e;
    if (typeof this.onItem === 'function') {
      try { this.onItem(e); } catch (err) { /* a bad handler must not kill the session */ }
    }
  };

  /*
   * Bind a video element to the current sync session. Call from the onItem handler.
   * After this the element keeps itself aligned; nothing further is required per frame.
   */
  Sync.prototype.attachVideo = function (video, event) {
    var ev = event || this.lastEvent;
    if (!video || !ev) return false;
    if (typeof video.setSyncParams !== 'function') return false;   // not a BrightSign <video>
    try {
      video.setSyncParams(ev.domain, ev.id, ev.iso_timestamp);
      video.load();
      var p = video.play();
      if (p && typeof p.catch === 'function') p.catch(function () { /* autoplay guard */ });
      return true;
    } catch (e) { return false; }
  };

  /*
   * LEADER ONLY: open a new sync session for a playlist item. `itemKey` should identify the item
   * so the id changes on every advance — a repeated id would be swallowed by the dedupe above and
   * the group would sit on the previous item.
   */
  Sync.prototype.announce = function (itemKey, nowMs) {
    if (!this.sm || !this.isLeader) return false;
    var id = 'st_' + String(itemKey) + '_' + String(nowMs || Date.now());
    try {
      this.sm.synchronize(id, this.config.prepareMs);
      return id;
    } catch (e) { return false; }
  };

  Sync.prototype.stop = function () {
    if (!this.sm) return;
    try { if (typeof this.sm.close === 'function') this.sm.close(); } catch (e) { /* ignore */ }
    this.sm = null;
    this.lastId = null;
    this.lastEvent = null;
  };

  global.ScreenTinkerBSSync = {
    create: function (options) { return new Sync(options); },
    available: function () { return !!SyncManagerClass; },
    DEFAULTS: DEFAULTS
  };
})(typeof window !== 'undefined' ? window : this);
