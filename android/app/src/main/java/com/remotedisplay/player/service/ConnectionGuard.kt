package com.remotedisplay.player.service

/**
 * #148 root-cause guard: the SINGLE-SOCKET-PER-DEVICE invariant, extracted from
 * [WebSocketService] so it is unit-testable without a live Socket.IO / Android (the service is
 * just the shell — same pattern as OtaThrottle). It decides whether a connect() request should
 * OPEN a new socket or REUSE the one already held.
 *
 * WHY (#148): every entry point — BOOT_COMPLETED -> service start, Activity bind
 * (onServiceConnected), a foreground re-bind (the MAXHUB PROC_STATE_TOP isBindService:true
 * transition), Socket.IO reconnect — used to call an UNCONDITIONAL connect() that tore down any
 * healthy socket and opened a forceNew one. A ROM that re-binds on foreground therefore produced
 * a burst of sockets for the same device_id (the 8-in-9s storm). Fire TV never re-binds like
 * that, so it never reproduced. This guards the SOCKET (the thing that matters), not the
 * service/bind count (the thing that varies), so it closes every duplication vector at once.
 */
object ConnectionGuard {
    /**
     * Should connect(url) open a NEW socket, or reuse the current one?
     *
     * Reuse (return false) iff we already hold a socket to the SAME url that is live or
     * self-healing — [socketActive] means connected OR Socket.IO is auto-reconnecting it. Open a
     * new one (return true) only when there is none usable: no socket, a different url (a genuine
     * re-provision to another server), or the socket went inert (e.g. after `io server
     * disconnect`, which Socket.IO does not auto-reconnect).
     */
    fun shouldOpenNewSocket(hasSocket: Boolean, sameUrl: Boolean, socketActive: Boolean): Boolean =
        !(hasSocket && sameUrl && socketActive)
}
