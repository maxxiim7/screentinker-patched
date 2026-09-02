package com.remotedisplay.player.service

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * #139: coverage for the OTA throttle state machine (the stateful core that the OTA
 * re-download-loop fix depends on), independent of Android. UpdateChecker is just the shell.
 */
class OtaThrottleTest {

    private val V = "1.9.1-beta6"
    private val MAX = OtaThrottle.MAX_INSTALL_ATTEMPTS
    private val WINDOW = OtaThrottle.BACKOFF_MS

    // Launch `n` installs from `start`, returning the resulting state.
    private fun launch(start: OtaThrottle.State, n: Int, now: Long = 1000L): OtaThrottle.State {
        var s = start
        repeat(n) { s = OtaThrottle.onInstallLaunched(s, now + it).first }
        return s
    }

    @Test fun newTargetResetsBudget() {
        val stale = OtaThrottle.State(targetVersion = "1.9.1-beta5", attempts = 2, lastAttemptAt = 1000, backoffReported = true)
        assertTrue(OtaThrottle.isNewTarget(stale, V))
        val (s, action) = OtaThrottle.onUpdateAvailable(stale, V, now = 5000)
        assertEquals(V, s.targetVersion)
        assertEquals(0, s.attempts)
        assertEquals(0L, s.lastAttemptAt)
        assertFalse(s.backoffReported)
        assertEquals(OtaThrottle.Action.ATTEMPT, action)
    }

    @Test fun aCheckNeverConsumesBudget_onlyInstallLaunchedDoes() {
        var s = OtaThrottle.State(targetVersion = V, attempts = 0)
        // Repeated checks (e.g. each followed by a failed download) must not advance the counter.
        repeat(5) {
            val (ns, action) = OtaThrottle.onUpdateAvailable(s, V, now = 100)
            assertEquals(OtaThrottle.Action.ATTEMPT, action)
            assertEquals(0, ns.attempts)
            s = ns
        }
        // Only a launched install increments.
        assertEquals(1, OtaThrottle.onInstallLaunched(s, now = 200).first.attempts)
    }

    @Test fun capThenBackoffWithinWindow() {
        val s = launch(OtaThrottle.State(targetVersion = V), MAX, now = 1000L)
        assertEquals(MAX, s.attempts)
        assertTrue(s.backoffReported)
        // A check inside the window → BACKOFF, no further attempt, state unchanged.
        val (ns, action) = OtaThrottle.onUpdateAvailable(s, V, now = 1000L + WINDOW - 1)
        assertEquals(OtaThrottle.Action.BACKOFF, action)
        assertEquals(MAX, ns.attempts)
    }

    @Test fun enterBackoffSignalsExactlyOnce() {
        var s = OtaThrottle.State(targetVersion = V)
        var crossings = 0
        repeat(MAX + 3) { i ->
            val (ns, entered) = OtaThrottle.onInstallLaunched(s, now = i.toLong())
            if (entered) crossings++
            s = ns
        }
        assertEquals("enter-backoff fires only on the crossing", 1, crossings)
    }

    @Test fun retryAfterWindowElapsedDoesNotReReport() {
        val capped = OtaThrottle.State(targetVersion = V, attempts = MAX, lastAttemptAt = 0L, backoffReported = true)
        val (afterCheck, action) = OtaThrottle.onUpdateAvailable(capped, V, now = WINDOW + 1)
        assertEquals(OtaThrottle.Action.ATTEMPT, action) // window elapsed → one retry allowed
        val (_, entered) = OtaThrottle.onInstallLaunched(afterCheck, now = WINDOW + 2)
        assertFalse("already reported entering backoff — must not report again", entered)
    }

    @Test fun clearsOnSuccessOnlyWhenPending() {
        assertTrue(OtaThrottle.shouldClearOnUpToDate(OtaThrottle.State(targetVersion = V, attempts = 2)))
        assertFalse(OtaThrottle.shouldClearOnUpToDate(OtaThrottle.State())) // nothing pending
    }

    @Test fun statusForFlagsEarlyAndStaysFlaggedWhileStillRetrying() {
        val now = 10_000L
        val FLAG = OtaThrottle.ATTEMPTS_BEFORE_FLAGGING
        // no target → none
        assertEquals("none", OtaThrottle.statusFor(OtaThrottle.State(), now))
        // below the flagging threshold → pending (it may still just work)
        assertEquals("pending", OtaThrottle.statusFor(
            OtaThrottle.State(targetVersion = V, attempts = FLAG - 1, lastAttemptAt = now), now))
        // at the threshold → a human is demonstrably needed, say so IMMEDIATELY. This is now far
        // below the cap, so the dashboard flags in ~1h instead of waiting ~20h for the give-up.
        assertEquals("manual_update_required", OtaThrottle.statusFor(
            OtaThrottle.State(targetVersion = V, attempts = FLAG, lastAttemptAt = now), now))
        // ...and STAYS flagged while the device keeps retrying. It used to drop back to 'pending'
        // once the backoff window elapsed, so a panel needing hands looked healthy between retries.
        assertEquals("manual_update_required", OtaThrottle.statusFor(
            OtaThrottle.State(targetVersion = V, attempts = FLAG, lastAttemptAt = now), now + WINDOW + 1))
        assertEquals("manual_update_required", OtaThrottle.statusFor(
            OtaThrottle.State(targetVersion = V, attempts = MAX, lastAttemptAt = now), now + WINDOW * 5))
    }

    @Test fun flagging_happens_far_before_giving_up() {
        // The whole point of splitting the two thresholds.
        assert(OtaThrottle.ATTEMPTS_BEFORE_FLAGGING < OtaThrottle.MAX_INSTALL_ATTEMPTS)
    }

    // ---- #166: managed stand-down (a foreign DPC owns installs on this panel) --------------------

    @Test fun managed_standDown_reports_once_per_target_not_every_cycle() {
        val now = 1_000_000L
        val (s1, first) = OtaThrottle.onManagedStandDown(OtaThrottle.State(), V, now)
        assertTrue("first sighting of this target must be reported", first)

        // The check runs on a timer; the operator hears about it once, not forever.
        val (s2, again) = OtaThrottle.onManagedStandDown(s1, V, now + 60_000)
        assertFalse("same target must not re-report", again)
        val (_, third) = OtaThrottle.onManagedStandDown(s2, V, now + 120_000)
        assertFalse("still must not re-report", third)
    }

    @Test fun managed_standDown_reads_as_manual_update_required_not_none() {
        // THE BUG: standing down before the check left ota_status 'none' — indistinguishable from
        // "up to date", so a rotting panel looked healthy on the dashboard.
        val now = 1_000_000L
        val (s, _) = OtaThrottle.onManagedStandDown(OtaThrottle.State(), V, now)
        assertEquals("manual_update_required", OtaThrottle.statusFor(s, now))
        assertEquals(V, s.targetVersion)
    }

    @Test fun managed_standDown_stays_flagged_across_the_backoff_window() {
        // A capped device flips back to "pending" once the window elapses, because a retry is due.
        // A managed panel has no retry coming: refreshing lastAttemptAt each cycle keeps it honest.
        val now = 1_000_000L
        var (s, _) = OtaThrottle.onManagedStandDown(OtaThrottle.State(), V, now)
        val later = now + WINDOW + 1
        s = OtaThrottle.onManagedStandDown(s, V, later).first
        assertEquals("manual_update_required", OtaThrottle.statusFor(s, later))
    }

    @Test fun a_newer_version_re_reports_because_it_is_news() {
        val now = 1_000_000L
        val (s1, _) = OtaThrottle.onManagedStandDown(OtaThrottle.State(), V, now)
        val (s2, fresh) = OtaThrottle.onManagedStandDown(s1, "1.9.24", now + 5_000)
        assertTrue("a different target is a new thing to say", fresh)
        assertEquals("1.9.24", s2.targetVersion)
    }

    @Test fun managed_standDown_never_consumes_a_healthy_devices_budget() {
        // It pins attempts at the cap by design; the point is that it is reached WITHOUT ever
        // launching an install, so no APK was downloaded and no confirm dialog was thrown up.
        val now = 1_000_000L
        val (s, _) = OtaThrottle.onManagedStandDown(OtaThrottle.State(), V, now)
        assertEquals(MAX, s.attempts)
        assertTrue(s.backoffReported)
    }

    // ---- force update: an operator pressed the button on THIS device ----------------------------

    @Test fun THE_POINT_a_forced_check_un_parks_a_capped_device_immediately() {
        val now = 1_000_000L
        // Capped and well inside the backoff window: the timer would do nothing for ~24h.
        val capped = OtaThrottle.State(targetVersion = V, attempts = MAX, lastAttemptAt = now, backoffReported = true)
        assertEquals(OtaThrottle.Action.BACKOFF, OtaThrottle.onUpdateAvailable(capped, V, now + 60_000).second)

        val forced = OtaThrottle.onForcedCheck(capped)
        assertEquals(OtaThrottle.Action.ATTEMPT, OtaThrottle.onUpdateAvailable(forced, V, now + 60_000).second)
    }

    @Test fun forcing_keeps_the_target_it_is_try_again_not_start_over() {
        val s = OtaThrottle.onForcedCheck(
            OtaThrottle.State(targetVersion = V, attempts = MAX, lastAttemptAt = 5L, backoffReported = true))
        assertEquals(V, s.targetVersion)
        assertEquals(0, s.attempts)
    }

    @Test fun forcing_re_arms_the_backoff_report_so_a_second_cap_is_announced_again() {
        // backoffReported is a once-per-decision latch, not once-per-lifetime: if the operator
        // forces and it caps out AGAIN, that is news again.
        val s = OtaThrottle.onForcedCheck(
            OtaThrottle.State(targetVersion = V, attempts = MAX, lastAttemptAt = 5L, backoffReported = true))
        assertFalse(s.backoffReported)
        val relaunched = generateSequence(s) { OtaThrottle.onInstallLaunched(it, 10L).first }.elementAt(MAX)
        assertEquals(MAX, relaunched.attempts)
        assertTrue(OtaThrottle.onInstallLaunched(
            OtaThrottle.State(targetVersion = V, attempts = MAX - 1, lastAttemptAt = 5L, backoffReported = false), 10L).second)
    }

    @Test fun forcing_gives_a_full_budget_not_a_single_shot() {
        // After forcing, three attempts are available again before it re-caps.
        var s = OtaThrottle.onForcedCheck(
            OtaThrottle.State(targetVersion = V, attempts = MAX, lastAttemptAt = 0L, backoffReported = true))
        var t = 1_000L
        var launched = 0
        repeat(MAX + 2) {
            val (afterCheck, action) = OtaThrottle.onUpdateAvailable(s, V, t)
            s = afterCheck
            if (action == OtaThrottle.Action.ATTEMPT) { s = OtaThrottle.onInstallLaunched(s, t).first; launched++ }
            t += 60_000
        }
        assertEquals(MAX, launched)
    }
}
