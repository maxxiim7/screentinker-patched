'use strict';

// Hiding a button is not enforcement, and the dashboard is not the only way to send a command.
// The socket is reachable directly, a group send fans out to a mixed-platform fleet, and an
// operator with a tab open from before the panel declared anything still has the old controls on
// screen. In every one of those paths a command the player cannot honour used to be DELIVERED and
// silently dropped — the "reports success and changes nothing" shape again, one layer down.
//
// So the refusal lives on the server and names the capability, and the group route reports the
// skipped devices separately from the ones it actually reached. A group toast that counts an
// unreachable web player as "sent" is how an operator walks away believing the whole group
// rebooted.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const caps = require('../lib/player-capabilities');

test('a browser tab is refused reboot, and the refusal says which capability was missing', () => {
  const web = { android_version: 'Web/Chrome' };
  const verdict = caps.commandAllowed(web, 'reboot');
  assert.equal(verdict.ok, false);
  assert.equal(verdict.capability, 'system.reboot', 'the operator has to be told WHY, not just "no"');
});

test('the legacy fleet is not locked out of the commands it has always accepted', () => {
  // The failure mode that would be worse than the bug: several hundred Android displays declare
  // nothing, and a refusal keyed off "declared nothing => supports nothing" bricks every control
  // in the product at once.
  const legacy = { client_type: 'apk', android_version: '9' };
  for (const cmd of ['launch', 'refresh', 'update', 'set_volume', 'set_brightness',
    // screen_off blanks a fielded panel for real, and screen_on shares its capability. The pair
    // stays reachable so scheduled blank-at-night keeps working on displays that have not updated;
    // see the display.power note in lib/player-capabilities.js for the accepted trade-off.
    'screen_off', 'screen_on']) {
    assert.equal(caps.commandAllowed(legacy, cmd).ok, true, `${cmd} must still reach a legacy Android panel`);
  }
  // reboot IS refused, and that is the parity audit's finding rather than an oversight:
  // STPolicy.reboot() needs device owner, and the off-owner fallback paints an accessibility power
  // DIALOG over the signage that a human has to dismiss. That is worse than a refusal.
  assert.equal(caps.commandAllowed(legacy, 'reboot').ok, false, 'reboot needs device owner');
});

test('a command with no capability requirement is never refused', () => {
  // set_debug is diagnostics. Gating it would take away the tool you reach for precisely when a
  // panel is misreporting what it can do.
  assert.equal(caps.capabilityForCommand('set_debug'), null);
  assert.equal(caps.commandAllowed({ android_version: 'Web/Chrome' }, 'set_debug').ok, true);
});

test('an unrecognised command type is passed through, not silently swallowed', () => {
  // New player features ship before the server learns their names. Refusing by default would make
  // every such command fail with a confusing "unsupported" instead of reaching the panel.
  assert.equal(caps.capabilityForCommand('some_future_command'), null);
  assert.equal(caps.commandAllowed({ client_type: 'apk' }, 'some_future_command').ok, true);
});

test('shutdown and reboot share one privilege, so a panel cannot be half-refused', () => {
  // They are the same "device power lifecycle" authority. Splitting them produced a UI with
  // Shutdown present and Reboot missing on the same display, which reads as a broken dashboard.
  assert.equal(caps.capabilityForCommand('shutdown'), caps.capabilityForCommand('reboot'));
});

test('the per-window dim is NOT the backlight — conflating them hides a working slider', () => {
  // set_brightness is the player's own overlay (Android Tier 0, no device owner);
  // set_system_brightness writes the real backlight and needs settings-write. Mapping both to
  // system.brightness — which is deliberately absent from every baseline because it is
  // conditional — would have removed the overlay slider from the entire undeclared Android fleet.
  const legacy = { client_type: 'apk', android_version: '11' };
  assert.equal(caps.commandAllowed(legacy, 'set_brightness').ok, true, 'overlay dim has always worked here');
  assert.equal(caps.commandAllowed(legacy, 'set_system_brightness').ok, false, 'backlight is conditional');
  assert.notEqual(caps.capabilityForCommand('set_brightness'), caps.capabilityForCommand('set_system_brightness'));
});

test('every command in the map points at a capability that actually exists', () => {
  // A typo here does not fail loudly: supports() returns false for an unknown name, so the command
  // is refused for EVERY device on every platform, forever.
  for (const cmd of Object.keys(caps.COMMAND_CAPABILITY)) {
    // A command may name several capabilities, any of which is enough; all of them must be real.
    for (const cap of caps.capabilitiesForCommand(cmd)) {
      assert.ok(caps.CAP_SET.has(cap), `${cmd} maps to unknown capability ${cap}`);
    }
  }
});

test('a device row that failed to load refuses everything rather than guessing', () => {
  // A missing row would otherwise fall through platformFamily() to the web baseline and cheerfully
  // authorise commands against a device that does not exist.
  assert.equal(caps.commandAllowed(null, 'reboot').ok, false);
  assert.equal(caps.commandAllowed(undefined, 'set_volume').ok, false);
});

test('a player declaring nothing at all is refused every gated command', () => {
  const mute = { client_type: 'apk', capabilities: '[]' };
  assert.equal(caps.commandAllowed(mute, 'reboot').ok, false);
  assert.equal(caps.commandAllowed(mute, 'set_volume').ok, false);
  assert.equal(caps.commandAllowed(mute, 'set_debug').ok, true, 'ungated commands still pass');
});
