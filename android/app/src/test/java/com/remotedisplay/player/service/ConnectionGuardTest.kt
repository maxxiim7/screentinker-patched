package com.remotedisplay.player.service

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * #148: the single-socket-per-device invariant (root-cause fix for the client opening
 * duplicate/rapid sockets). ConnectionGuard is the testable core; WebSocketService is the shell.
 */
class ConnectionGuardTest {

    @Test fun opensWhenThereIsNoSocket() {
        assertTrue(ConnectionGuard.shouldOpenNewSocket(hasSocket = false, sameUrl = false, socketActive = false))
        assertTrue(ConnectionGuard.shouldOpenNewSocket(hasSocket = false, sameUrl = true, socketActive = false))
    }

    @Test fun reusesALiveSocketToTheSameUrl() {
        // A connected/self-healing socket to the same server -> reuse, never a duplicate.
        assertFalse(ConnectionGuard.shouldOpenNewSocket(hasSocket = true, sameUrl = true, socketActive = true))
    }

    @Test fun opensWhenTheSocketWentInert() {
        // Socket exists but is inert (e.g. after `io server disconnect`, which Socket.IO does
        // not auto-reconnect) -> bring up one new connection.
        assertTrue(ConnectionGuard.shouldOpenNewSocket(hasSocket = true, sameUrl = true, socketActive = false))
    }

    @Test fun opensWhenTheUrlChanged() {
        // Genuine re-provision to a different server -> switch (do not reuse the old one).
        assertTrue(ConnectionGuard.shouldOpenNewSocket(hasSocket = true, sameUrl = false, socketActive = true))
        assertTrue(ConnectionGuard.shouldOpenNewSocket(hasSocket = true, sameUrl = false, socketActive = false))
    }

    /**
     * THE #148 case: repeated connect() from repeated Activity binds / foreground re-binds must
     * never open a second socket while one is active. Simulate the 8-in-9s storm of binds.
     */
    @Test fun idempotentAcrossManyRapidBinds() {
        repeat(8) { i ->
            assertFalse(
                "bind #$i must reuse the live socket, not open a duplicate",
                ConnectionGuard.shouldOpenNewSocket(hasSocket = true, sameUrl = true, socketActive = true)
            )
        }
    }
}
