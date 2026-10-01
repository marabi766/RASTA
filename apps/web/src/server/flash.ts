import { z } from 'zod';

import { signPayload, verifyPayload } from './signed-payload';
import type { WebSession } from './session';

/**
 * The confirmation a write's redirect carries: «ثبت شد», «ذخیره شد».
 *
 * It used to be `?created=1` and `?updated=1`, which anybody can type. Typing
 * it put a success banner on a page the person was allowed to read but had
 * written nothing to, so a screenshot of that page — or a link somebody sent —
 * could assert a write that never happened. This is a token the server signs
 * for **this** session, **this** record and **this** action, good for two
 * minutes, so the banner appears only after a write this person's own request
 * produced (`signed-payload.ts` says what a token does and does not prove).
 *
 * It can be shown again by reloading within the window; that is a banner on a
 * page whose data is read fresh, so it asserts nothing the page does not show.
 */

const PURPOSE = 'flash';

/** Long enough to survive the redirect and a reload; short enough to be useless as a bookmark. */
export const FLASH_TTL_SECONDS = 120;

const flashSchema = z.object({
  subject: z.string().min(1).max(200),
  action: z.string().min(1).max(40),
});

/** The token for `action` having just happened to the record `subject`. */
export function mintFlash(
  session: WebSession,
  subject: string,
  action: string,
  now?: number,
): string {
  return signPayload(session, PURPOSE, { subject, action }, FLASH_TTL_SECONDS, now);
}

/**
 * The action `token` confirms for `subject`, if it is a flash this session was
 * issued for that record and one of `actions`; otherwise `undefined`. Nothing
 * about *why* it failed is returned.
 */
export function readFlash<A extends string>(
  session: WebSession,
  token: unknown,
  subject: string,
  actions: readonly A[],
  now?: number,
): A | undefined {
  const payload = verifyPayload(session, PURPOSE, token, flashSchema, now);
  if (!payload || payload.subject !== subject) return undefined;
  return actions.find((action) => action === payload.action);
}
