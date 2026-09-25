import { isIP } from 'node:net';
import { z } from 'zod';

/**
 * Which hops in front of the gateway may state the client's address (L1-03).
 *
 * Behind an ingress, the socket peer of every request is the ingress, so a
 * rate limit keyed on it puts every anonymous caller in the country into one
 * bucket: sixty registrations an hour for the whole platform, and one abusive
 * client locks everyone else out. The real address is in `X-Forwarded-For` —
 * but that header is whatever the sender wrote, so it may only be believed
 * from a hop the operator has named.
 *
 * Express's `trust proxy` does exactly that walk: from the socket peer
 * leftwards through `X-Forwarded-For`, skipping addresses that are trusted,
 * and `req.ip` is the first one that is not. A spoofed entry prepended by the
 * client therefore sits to the left of the address the ingress appended and
 * is never reached.
 *
 * Only explicit addresses and ranges are accepted. Express also takes `true`
 * (trust everyone) and a hop count; both believe a header the client controls
 * whenever the gateway is reached by any path other than the expected one,
 * so neither can be configured here.
 */

/** proxy-addr's named ranges: loopback, link-local and unique-local/private. */
const NAMED_RANGES = ['loopback', 'linklocal', 'uniquelocal'] as const;

function isAddressOrRange(entry: string): boolean {
  if ((NAMED_RANGES as readonly string[]).includes(entry)) return true;

  const [address, prefix, ...rest] = entry.split('/');
  if (rest.length > 0 || !address) return false;

  const family = isIP(address);
  if (family === 0) return false;
  if (prefix === undefined) return true;

  if (!/^\d{1,3}$/.test(prefix)) return false;
  const bits = Number(prefix);
  return bits >= 0 && bits <= (family === 4 ? 32 : 128);
}

/**
 * `GATEWAY_TRUSTED_PROXIES`: comma-separated addresses, CIDR ranges, or the
 * names above. Empty — the default — trusts no hop, which is the pre-existing
 * behaviour: safe against spoofing, but every request behind an ingress is
 * attributed to the ingress.
 */
export const trustedProxiesSchema = z
  .string()
  .default('')
  .transform((raw) =>
    raw
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  )
  .superRefine((entries, context) => {
    for (const entry of entries) {
      if (!isAddressOrRange(entry)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            `"${entry}" is not an IP address, a CIDR range or one of ${NAMED_RANGES.join(', ')}. ` +
            'Trusting every hop or a hop count is refused: both believe a client-written header.',
        });
      }
    }
  });

/** The value handed to Express's `trust proxy` setting. */
export function trustProxySetting(trusted: readonly string[]): false | string[] {
  return trusted.length === 0 ? false : [...trusted];
}

/** Anything with Express's `set`, so the caller need not depend on `express`. */
interface SettingsTarget {
  set(setting: string, value: unknown): unknown;
}

/** Applies the setting. Called once, in `main.ts`, before the app listens. */
export function applyTrustProxy(app: SettingsTarget, trusted: readonly string[]): void {
  app.set('trust proxy', trustProxySetting(trusted));
}
