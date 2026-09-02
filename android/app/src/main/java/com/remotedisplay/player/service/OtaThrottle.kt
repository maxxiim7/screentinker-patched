package com.remotedisplay.player.service

/**
 * #139: pure OTA throttle decision logic — no Android dependencies, so it's unit-testable
 * (see OtaThrottleTest). UpdateChecker is the imperative shell: it reads/writes the persisted
 * fields (ServerConfig / EncryptedSharedPreferences) and performs the actual download + install;
 * this object owns the stateful RULES so they have coverage beyond a compile:
 *
 *  - a new target version resets the attempt budget,
 *  - a check NEVER consumes the budget — only a launched install does (so a transient
 *    download/network failure can't park a healthy device in backoff),
 *  - after MAX_INSTALL_ATTEMPTS failed installs, back off to one retry per BACKOFF_MS,
 *  - the "entering backoff" signal fires on the crossing only (report-on-transition).
 */
object OtaThrottle {
    // Why this is 40 and not 3: an attempt is nearly free. The APK is downloaded and signature-
    // verified ONCE and then reused from cache, so attempts 2..N pull no bytes — the ~8.7MB
    // re-download this throttle was built to stop is already prevented by the cache, not by the
    // cap. What actually blocks these installs is a confirm dialog waiting for a human, and a
    // human may walk past at any hour. Three tries inside one hour, then a day of silence, gave up
    // long before anyone had a chance; ~40 keeps trying across a working day (30-minute cadence
    // ≈ 20 hours) before falling back to the daily retry.
    const val MAX_INSTALL_ATTEMPTS = 40
    // Telling the operator is a SEPARATE decision from giving up, and it has to stay early:
    // flagging only at the cap would push "this panel needs attention" from ~1 hour out to ~20.
    // After this many failed launches a human is demonstrably needed, so say so — and keep
    // retrying anyway, because saying it costs nothing and stopping costs the update.
    const val ATTEMPTS_BEFORE_FLAGGING = 3
    const val BACKOFF_MS = 24L * 60 * 60 * 1000

    /** Persisted OTA state for the version we are currently trying to install. */
    data class State(
        val targetVersion: String = "",
        val attempts: Int = 0,
        val lastAttemptAt: Long = 0L,
        val backoffReported: Boolean = false
    )

    enum class Action { ATTEMPT, BACKOFF }

    /** True when [latestVersion] differs from the persisted target — caller drops stale APKs. */
    fun isNewTarget(state: State, latestVersion: String): Boolean = state.targetVersion != latestVersion

    /**
     * A check found [latestVersion] available. Returns the state to persist (reset on a new
     * target) and whether to attempt now. Does NOT count an attempt: the budget is consumed
     * only once an install is actually launched (see [onInstallLaunched]).
     */
    fun onUpdateAvailable(state: State, latestVersion: String, now: Long): Pair<State, Action> {
        val s = if (isNewTarget(state, latestVersion)) State(targetVersion = latestVersion) else state
        if (s.attempts >= MAX_INSTALL_ATTEMPTS && now - s.lastAttemptAt < BACKOFF_MS) {
            return s to Action.BACKOFF
        }
        return s to Action.ATTEMPT
    }

    /**
     * An install was actually launched (a verified APK was in hand). Consumes one attempt and
     * returns the new state plus whether this attempt is the FIRST to cross the cap into backoff
     * (true => caller reports "manual update required" once; false on all later polls).
     */
    fun onInstallLaunched(state: State, now: Long): Pair<State, Boolean> {
        val attempts = state.attempts + 1
        var s = state.copy(attempts = attempts, lastAttemptAt = now)
        // Flag at ATTEMPTS_BEFORE_FLAGGING, not at the cap — the operator needs to know a human is
        // required long before the device stops trying. Reported once (the latch is re-armed by a
        // new target version or by a forced check, so a genuinely new situation is announced again).
        val shouldFlag = attempts >= ATTEMPTS_BEFORE_FLAGGING && !s.backoffReported
        if (shouldFlag) s = s.copy(backoffReported = true)
        return s to shouldFlag
    }

    /**
     * A check found [latestVersion] available on a panel whose installs belong to a foreign DPC.
     * We must not self-install — but we must not go quiet either: reporting nothing leaves the
     * panel showing "no update pending" forever while it silently rots on an old build, which is
     * precisely how one stayed 12 versions behind unnoticed. Park it in the same
     * manual_update_required state a capped device reaches, and say so ONCE per target version
     * (the check runs every cycle; the operator does not need to hear it every cycle).
     */
    fun onManagedStandDown(state: State, latestVersion: String, now: Long): Pair<State, Boolean> {
        val s = if (isNewTarget(state, latestVersion)) State(targetVersion = latestVersion) else state
        val report = !s.backoffReported
        // attempts pinned at the cap and lastAttemptAt refreshed so statusFor() keeps reading
        // manual_update_required for as long as the update is genuinely outstanding.
        return s.copy(
            attempts = MAX_INSTALL_ATTEMPTS,
            lastAttemptAt = now,
            backoffReported = true
        ) to report
    }

    /**
     * An operator pressed "force update" on THIS device. That is a far stronger signal than the
     * 30-minute timer, so it hands the attempt budget back: a device parked in backoff (or one
     * that already burned all three attempts on an install nobody accepted) tries again straight
     * away instead of waiting out the window.
     *
     * Target version is kept — this is "try again now", not "forget what you were doing".
     * backoffReported resets too, so if it caps out again the operator hears about it again;
     * that report is per-decision, not once per lifetime.
     */
    fun onForcedCheck(state: State): State = state.copy(attempts = 0, backoffReported = false)

    /** A check found us already on the latest. True if there was pending OTA state to clear. */
    fun shouldClearOnUpToDate(state: State): Boolean = state.targetVersion.isNotEmpty()

    /**
     * #139 Phase 2: operator-facing status for the dashboard.
     *  - "none"                    : no update pending.
     *  - "manual_update_required"  : capped AND still inside the backoff window — this device
     *                                can't self-install; a human needs to update it.
     *  - "pending"                 : an update is in progress / will retry (under the cap, or the
     *                                window has elapsed so a retry is due).
     */
    fun statusFor(state: State, now: Long): String = when {
        state.targetVersion.isEmpty() -> "none"
        // Keyed on the FLAGGING threshold, not the cap: after this many launched installs failed to
        // take, a human really is required, and that stays true while the device keeps retrying.
        // Previously this also required being inside the backoff window, so a device that was still
        // trying read as plain 'pending' and never surfaced.
        state.attempts >= ATTEMPTS_BEFORE_FLAGGING -> "manual_update_required"
        else -> "pending"
    }
}
