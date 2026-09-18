import { RastaError, getContext, type RequestContext } from '@rasta/nest-common';

/**
 * Who a notification endpoint acts for, and the layer that does not depend on
 * a decorator staying correct.
 *
 * ADR-054 § 11: every endpoint is "any authenticated user, own rows only".
 * Ownership is the **user**, not only the tenant — two people in one
 * organization must not see each other's rows — so the predicate every read
 * and every transition carries is `userId = ctx.userId AND organizationId =
 * ctx.organizationId`, both taken from the verified token and never from the
 * request. There is no administrative endpoint that reads somebody else's
 * notifications in MVP, and this file is where that stays true even if a
 * route is added by mistake: it resolves an *actor*, and an actor is always
 * exactly one person in exactly one organization.
 *
 * ## Service tokens are refused twice
 *
 * `AuthGuard` already refuses one on an endpoint with no `@AllowService`, and
 * no endpoint here carries that decorator. This is the second layer, written
 * as an explicit refusal: a service has no inbox, so it has nothing to read.
 *
 * ## `AUDITOR` is a user here
 *
 * The oversight role sees its **own** notifications like anybody else
 * (ADR-054 § 11). The aggregate-only restriction on `AUDITOR` is about other
 * tenants' row-level data, and a person's own inbox is not that.
 */

/** The person a request acts for: one user, one organization, both verified. */
export interface NotificationActor {
  readonly userId: string;
  readonly organizationId: string;
}

export function resolveActor(context: RequestContext = getContext()): NotificationActor {
  if (context.authType === 'SERVICE') {
    throw RastaError.forbidden('A service has no notifications of its own to read');
  }

  if (context.authType !== 'USER' || !context.userId) {
    // `AuthGuard` never lets an anonymous caller past a closed endpoint, so
    // reaching here is a wiring fault. Still a refusal rather than a 500:
    // whoever is on the other end learns only that they are not permitted.
    throw RastaError.unauthenticated('Authentication required');
  }

  if (!context.organizationId) {
    // A `RastaError`, not the bare `Error` that `getOrganizationId()` throws:
    // a user whose token names no active organization has no inbox to act on,
    // which is a refusal to state, not a 500 to investigate.
    throw RastaError.forbidden(
      'This request has no active organization, so no notification scope can be established',
    );
  }

  return { userId: context.userId, organizationId: context.organizationId };
}
