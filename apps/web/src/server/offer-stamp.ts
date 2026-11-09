import { z } from 'zod';

import { webServerEnv } from './env';
import type { Offer } from './marketplace';
import { signPayload, verifyPayload } from './signed-payload';
import type { WebSession } from './session';

/**
 * The offer version the page drew, signed by this server (D-156).
 *
 * marketplace-service places an order only at the offer version the buyer read
 * (`offerVersion`, required; any other is `409 OPTIMISTIC_LOCK_FAILED` /
 * `OFFER_VERSION_CHANGED`). The version a line names is therefore the price the
 * buyer agrees to, and it must be the one this page **showed** — so the action
 * takes it from this stamp, never from a form field, as a bid's
 * `expectedRevision` comes from its replay stamp (`bid-replay.ts`). A posted
 * offer the page did not draw has no stamp and is not sent.
 *
 * One stamp per drawn offer: the person picks the offer after the page is
 * drawn, and a stamp is small whatever the number of offers. Bound to this
 * login (`signed-payload.ts`); readable, not secret — it says only which
 * version of a published offer this page listed. It lives as long as the
 * login may: past that the stamp is refused and nothing is sent, and a stale
 * version within it is refused by the service, so an old stamp can never price
 * an order at anything but the price it was drawn with.
 */

const PURPOSE = 'place-order-offer-version';

const stampSchema = z.object({
  offerId: z.string().min(1).max(64),
  // `offer.version` is an INT column (marketplace-service `createOrderSchema`).
  version: z.number().int().min(1).max(2_147_483_647),
});

export function stampOffer(
  session: WebSession,
  offer: Pick<Offer, 'id' | 'version'>,
  now: number = Date.now(),
): string {
  return signPayload(
    session,
    PURPOSE,
    { offerId: offer.id, version: offer.version },
    webServerEnv().WEB_SESSION_MAX_AGE_SECONDS,
    now,
  );
}

/** The version the page drew for `offerId`, or null: no stamp, another login's, expired, or another offer's. */
export function drawnOfferVersion(
  session: WebSession,
  token: unknown,
  offerId: string,
  now: number = Date.now(),
): number | null {
  const stamp = verifyPayload(session, PURPOSE, token, stampSchema, now);
  return stamp !== null && stamp.offerId === offerId ? stamp.version : null;
}
