import type { ChannelDefaults } from './precedence';

/**
 * What a channel does when nobody has expressed a preference.
 *
 * ADR-054 § 5 states it: *«`IN_APP` روشن؛ `EMAIL` روشن برای `WARNING` و
 * `CRITICAL`، خاموش برای `INFO`. پیکربندی، نه ثابت.»*
 *
 * The email half is written here although no email channel exists yet, and
 * that is deliberate rather than premature: it is the **rule** that is being
 * recorded, not a capability. A default is a piece of policy, and policy
 * written down at the moment it is decided is policy that does not have to be
 * reconstructed from memory later. Nothing reads the `EMAIL` branch today —
 * `NotificationChannel` holds `IN_APP` alone, so the type system keeps it
 * unreachable — and the day NTF-004 widens the enum this stays correct without
 * anyone having to remember what the document said.
 *
 * The distinction that matters: an enum value nothing can write is a claim of
 * a capability the platform does not have (Q-07), and there is none here. A
 * function that already knows the answer for a channel that does not exist yet
 * claims nothing at all.
 */
export const CHANNEL_DEFAULTS: ChannelDefaults = (channel, severity) => {
  switch (channel) {
    case 'IN_APP':
      // Always on. An in-app notification does not interrupt anybody: it waits
      // in an inbox. Defaulting it off would mean a new user sees nothing at
      // all until they find a settings page they have no reason to look for.
      return true;
    default:
      // The email rule, kept for the channel that will read it. Routine
      // information is not worth an email nobody asked for; a warning or a
      // failure is.
      return severity !== 'INFO';
  }
};
