/**
 * An unsigned access token that acts for `organizationId`, read the way the
 * guard reads one — and so the way `server/session-organization.ts` does:
 * `org_id`, listed in `org_ids`, with a role there in `org_roles`. Null: a
 * platform-wide token with no organization. Never verified in the portal; the
 * gateway and the service do that.
 *
 * A test session's `organizationId` must be this token's, as every stored
 * session's is (`storedOrganizationFor`): `readSession()` refuses one whose
 * copy disagrees with its token, and nothing may be drawn or sent for it.
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
