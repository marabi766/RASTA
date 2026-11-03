/**
 * An unsigned access token that acts for `organizationId`, read the way the
 * guard reads one — and so the way `server/session-organization.ts` does:
 * `org_id`, listed in `org_ids`, with a role there in `org_roles`. Null: a
 * platform-wide token with no organization. Never verified in the portal; the
 * gateway and the service do that.
 *
 * A test session is pinned to this organization (`organizationId`), as a
 * sign-in pins it (`pinnedOrganizationFor`): `readSession()` refuses a session
 * whose token grants its pinned organization no role, and nothing may be drawn
 * or sent for it.
 */
export function actingAccessToken(
  organizationId: string | null,
  roles: readonly string[] = ['OPERATOR'],
  extra: Record<string, unknown> = {},
): string {
  const claims: Record<string, unknown> =
    organizationId === null
      ? { realm_access: { roles: [] }, ...extra }
      : {
          org_id: organizationId,
          org_ids: [organizationId],
          org_roles: roles.map((role) => `${organizationId}:${role}`),
          ...extra,
        };
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none' })}.${encode(claims)}.signature`;
}

/**
 * The token half of a session, pinned as a sign-in would pin it — for the
 * server helpers that read a session's authority (`sessionAuthority`) and are
 * tested with a bare token.
 */
export function pinnedTokens(accessToken: string): {
  readonly accessToken: string;
  readonly organizationId: string | null;
} {
  const payload = accessToken.split('.')[1];
  let organizationId: string | null = null;
  try {
    const claims = JSON.parse(Buffer.from(payload ?? '', 'base64url').toString('utf8')) as {
      org_id?: unknown;
    };
    organizationId = typeof claims.org_id === 'string' ? claims.org_id : null;
  } catch {
    organizationId = null;
  }
  return { accessToken, organizationId };
}
