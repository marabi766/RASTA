import type { ChannelDefaults } from './precedence';

/**
 * What a channel does when nobody has expressed a preference.
 *
 * ADR-054 § 5 states it: *«`IN_APP` روشن؛ `EMAIL` روشن برای `WARNING` و
 * `CRITICAL`، خاموش برای `INFO`. پیکربندی، نه ثابت.»*
 *
 * The email half was written here before the email channel existed, on the
 * grounds that a default is policy and policy is worth recording when it is
 * decided rather than reconstructing from memory later. NTF-004 read it
 * unchanged, which is the whole of what that was for: the rule that shipped is
 * the rule the document describes, and nobody had to remember it.
 */
export const CHANNEL_DEFAULTS: ChannelDefaults = (channel, severity) => {
  switch (channel) {
    case 'IN_APP':
      // Always on. An in-app notification does not interrupt anybody: it waits
      // in an inbox. Defaulting it off would mean a new user sees nothing at
      // all until they find a settings page they have no reason to look for.
      return true;
    default:
      // Email. Routine information is not worth an unrequested message in
      // somebody's inbox; a warning or a failure is.
      return severity !== 'INFO';
  }
};
