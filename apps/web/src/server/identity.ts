import { z } from 'zod';
import { callGateway, GatewayRequestError } from './gateway';
import { webServerEnv } from './env';
import type { WebSession } from './session';

/**
 * Who the signed-in person is, according to identity-service.
 *
 * The session cookie already carries a subject and a username from the id
 * token, and this asks anyway. The two answer different questions: the id
 * token says who authenticated, identity-service says what they may do *here*
 * — which organization is active, which memberships exist, which roles apply
 * in the one they are acting for. Only the second changes when an
 * administrator changes it, and only the second is the platform's own record.
 *
 * ## The schema keeps what the screen uses, and Zod drops the rest
 *
 * identity's view carries an email and a phone number. Neither is declared
 * below, so neither survives parsing and neither can reach a React tree — and
 * a React tree is serialized into the page. `docs/07 § 7.3`: carry an
 * identifier, not personal data.
 */

const membershipSchema = z.object({
  organizationId: z.string(),
  /**
   * `null` on the wire, not absent: `MembershipView.organizationName` is
   * `string | null`, and `toMembershipView` sends `?? null` whenever the
   * organization's name has not replicated into identity yet.
   *
   * `.optional()` accepts `undefined` and rejects `null`, so a legitimate,
   * documented response failed the schema and the whole call came back
   * `MALFORMED` — the dashboard and `/organizations` both blank for a reason
   * neither could explain. `.nullable()` is the contract; `.optional()` is
   * kept beside it because a future trimmed response may omit the key.
   */
  organizationName: z.string().nullable().optional(),
  roles: z.array(z.string()).default([]),
  status: z.string(),
});

const currentUserSchema = z.object({
  id: z.string(),
  username: z.string(),
  firstName: z.string().default(''),
  lastName: z.string().default(''),
  status: z.string(),
  activeOrganizationId: z.string().nullable().default(null),
  memberships: z.array(membershipSchema).default([]),
  effectiveRoles: z.array(z.string()).default([]),
  /**
   * Which roles this person may grant, straight from the service's configured
   * ladder (`docs/24` Q-60). The member-management form renders its options
   * from this and from nothing else.
   *
   * `.default([])` rather than required: an older identity-service that does
   * not send it leaves the picker empty, which offers nothing rather than
   * guessing — and guessing is the whole failure mode this field exists to
   * remove. The service refuses an ungrantable role regardless.
   */
  grantableRoles: z.array(z.string()).default([]),
});

export type CurrentUser = z.infer<typeof currentUserSchema>;

export type CurrentUserResult =
  | { readonly kind: 'USER'; readonly user: CurrentUser }
  /** The gateway or identity refused or failed. The id is for support. */
  | { readonly kind: 'UNAVAILABLE'; readonly status: number; readonly correlationId: string }
  /** The answer did not match the contract. Not rendered as data. */
  | { readonly kind: 'MALFORMED'; readonly correlationId: string };

/**
 * Fetches the caller's own record through the gateway.
 *
 * Returns a result rather than throwing, because every one of these outcomes
 * is something the page has to *render*: a screen that threw on a 503 would
 * replace a working shell with a framework error page, and the person would
 * lose the navigation they were about to use.
 */
export async function fetchCurrentUser(session: WebSession): Promise<CurrentUserResult> {
  const env = webServerEnv();
  try {
    const response = await callGateway<unknown>({
      baseUrl: env.API_GATEWAY_URL,
      path: '/v1/users/me',
      accessToken: session.accessToken,
    });

    const parsed = currentUserSchema.safeParse(response.data);
    if (!parsed.success) return { kind: 'MALFORMED', correlationId: response.correlationId };
    return { kind: 'USER', user: parsed.data };
  } catch (error) {
    if (error instanceof GatewayRequestError) {
      return { kind: 'UNAVAILABLE', status: error.status, correlationId: error.correlationId };
    }
    throw error;
  }
}

/** The display name, falling back through what is actually present. */
export function displayName(user: CurrentUser): string {
  const full = `${user.firstName} ${user.lastName}`.trim();
  return full.length > 0 ? full : user.username;
}

/** The membership for the organization this session is acting in, if any. */
export function activeMembership(user: CurrentUser) {
  return user.memberships.find(
    (membership) => membership.organizationId === user.activeOrganizationId,
  );
}
