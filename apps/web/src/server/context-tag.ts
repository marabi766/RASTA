import { createHmac } from 'node:crypto';

/**
 * The page-context tag of an organization (`server/page-context.ts`): a keyed
 * digest under the session secret, 12 bytes in base64url. On its own, with no
 * other import, so the browser suites' session harness (`e2e/live-session.ts`)
 * draws the same tag the server checks.
 */

const PURPOSE = 'rasta-web/page-context/v1';
const TAG_BYTES = 12;

/** The tag of `organizationId` (null: a platform-wide session) under `secret`. */
export function contextTagFor(secret: string, organizationId: string | null): string {
  const key = createHmac('sha256', secret).update(PURPOSE).digest();
  return createHmac('sha256', key)
    .update(organizationId ?? '')
    .digest()
    .subarray(0, TAG_BYTES)
    .toString('base64url');
}
