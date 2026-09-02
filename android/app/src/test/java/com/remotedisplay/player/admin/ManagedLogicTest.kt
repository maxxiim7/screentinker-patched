package com.remotedisplay.player.admin

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * #166: what counts as "someone else's DPC owns this panel", and therefore when self-OTA may stand
 * down and stop updating.
 *
 * Grounded in a real stock Fire TV stick (AFTKRT, Fire OS 7, nothing enrolled, no MDM):
 *
 *     Profile Owner (User 0): com.amazon.tv.parentalcontrols  → policies: wipe-data
 *     Device Owner:           (none)
 *
 * Reading that as "managed" is how a retail stick opted itself out of updates permanently and sat
 * 12 versions behind while reporting no update pending. Parental controls was never going to
 * install our APK. Only a genuine device owner implies a DPC that provisions packages.
 */
class ManagedLogicTest {

    private val OURS = "com.remotedisplay.player"
    private val AMAZON_PCON = "com.amazon.tv.parentalcontrols"

    @Test fun no_admins_at_all_is_not_managed() {
        assertFalse(ManagedLogic.foreignDpcOwnsInstalls(false, OURS, emptyList()))
    }

    @Test fun THE_BUG_stock_fire_tv_profile_owner_is_not_managed() {
        // Exactly the dump above: sole admin, profile owner of user 0, no device owner anywhere.
        val admins = listOf(ManagedLogic.Admin(AMAZON_PCON, isDeviceOwner = false, isProfileOwner = true))
        assertFalse(
            "a stock Fire TV must keep updating itself",
            ManagedLogic.foreignDpcOwnsInstalls(false, OURS, admins)
        )
    }

    @Test fun THE_BUG_a_foreign_active_admin_that_owns_nothing_is_not_managed() {
        // The weaker shape the check originally matched: merely an enabled admin.
        val admins = listOf(ManagedLogic.Admin("com.oem.factorytool"))
        assertFalse(ManagedLogic.foreignDpcOwnsInstalls(false, OURS, admins))
    }

    @Test fun several_foreign_admins_and_profile_owners_still_do_not_add_up_to_an_owner() {
        val admins = listOf(
            ManagedLogic.Admin(AMAZON_PCON, isProfileOwner = true),
            ManagedLogic.Admin("com.google.android.gms"),
            ManagedLogic.Admin("com.oem.factorytool")
        )
        assertFalse(ManagedLogic.foreignDpcOwnsInstalls(false, OURS, admins))
    }

    @Test fun a_foreign_device_owner_IS_managed() {
        // A real enrolment: the DPC provisions packages, so self-install must stand down.
        val admins = listOf(ManagedLogic.Admin("com.airwatch.androidagent", isDeviceOwner = true))
        assertTrue(ManagedLogic.foreignDpcOwnsInstalls(false, OURS, admins))
    }

    @Test fun a_foreign_owner_is_still_found_when_listed_after_harmless_admins() {
        val admins = listOf(
            ManagedLogic.Admin(AMAZON_PCON, isProfileOwner = true),
            ManagedLogic.Admin("com.mdm.dpc", isDeviceOwner = true)
        )
        assertTrue(ManagedLogic.foreignDpcOwnsInstalls(false, OURS, admins))
    }

    @Test fun we_are_never_foreign_to_ourselves() {
        val admins = listOf(ManagedLogic.Admin(OURS, isDeviceOwner = true, isProfileOwner = true))
        assertFalse(ManagedLogic.foreignDpcOwnsInstalls(false, OURS, admins))
    }

    @Test fun if_we_can_install_silently_we_never_stand_down() {
        // Tier 2: we are owner, or a foreign owner delegated DELEGATION_PACKAGE_INSTALLATION to us.
        // Standing down would defeat the very delegation that was granted to let us install.
        val admins = listOf(ManagedLogic.Admin("com.mdm.dpc", isDeviceOwner = true))
        assertFalse(ManagedLogic.foreignDpcOwnsInstalls(true, OURS, admins))
    }

    // ---- #166 escape hatch: OTA_ALLOW_MANAGED_DEVICES -> server `allow_managed` ----------------

    @Test fun a_managed_panel_stands_down_when_the_operator_has_not_overridden() {
        assertTrue(ManagedLogic.standDownFromSelfOta(foreignDpcOwnsInstalls = true, serverAllowsManaged = false))
    }

    @Test fun the_override_lets_a_managed_panel_self_update() {
        assertFalse(ManagedLogic.standDownFromSelfOta(foreignDpcOwnsInstalls = true, serverAllowsManaged = true))
    }

    @Test fun an_unmanaged_panel_never_stands_down_either_way() {
        assertFalse(ManagedLogic.standDownFromSelfOta(foreignDpcOwnsInstalls = false, serverAllowsManaged = false))
        assertFalse(ManagedLogic.standDownFromSelfOta(foreignDpcOwnsInstalls = false, serverAllowsManaged = true))
    }

    @Test fun ABSENCE_IS_NOT_CONSENT_an_old_server_that_omits_the_field_reads_as_false() {
        // The caller parses it with optBoolean("allow_managed", false). A server predating the
        // flag says nothing, and that silence must mean "stand down", not "go ahead" — otherwise
        // upgrading a PLAYER against an older SERVER would silently switch the safe default off.
        val serverSaidNothing = false
        assertTrue(ManagedLogic.standDownFromSelfOta(true, serverSaidNothing))
    }
}
