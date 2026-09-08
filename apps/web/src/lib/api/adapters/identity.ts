import { z } from 'zod';
import type { AdapterDescriptor } from '../adapter';
import type { ApiClient } from '../client';

/**
 * The authenticated user, from `identity-service`.
 *
 * ADR-008 splits identity from membership: Keycloak owns authentication,
 * `identity-service` owns organizational membership and domain roles. That
 * split is exactly why this adapter exists. The access token carries a signed
 * `org_ids` claim — which is what the gateway enforces `X-Organization-Id`
 * against — but it carries no organization *names* and no membership records.
 * `GET /v1/users/me` has both.
 *
 * So the two are used for different jobs and neither is asked to do the
 * other's: the claim decides which organizations may be selected, and this
 * response decides how they are labelled and what roles are shown.
 *
 * Shapes read from `services/identity-service/src/identity/dto.ts`
 * (`CurrentUserView`).
 */

export const IDENTITY_ME_ADAPTER = {
  id: 'identity.me',
  service: 'identity-service',
  routes: ['GET /v1/users/me'],
} as const satisfies AdapterDescriptor;

export const IDENTITY_DIRECTORY_ADAPTER = {
  id: 'identity.directory',
  service: 'identity-service',
  routes: ['GET /v1/users'],
} as const satisfies AdapterDescriptor;

export const membershipViewSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  organizationName: z.string().nullable(),
  roles: z.array(z.string()),
  status: z.string(),
  validFrom: z.string(),
  validUntil: z.string().nullable(),
});

export type MembershipView = z.infer<typeof membershipViewSchema>;

const userViewSchema = z.object({
  id: z.string(),
  username: z.string(),
  email: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  phone: z.string().nullable(),
  status: z.string(),
  activeOrganizationId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type UserView = z.infer<typeof userViewSchema>;

export const currentUserSchema = userViewSchema.extend({
  memberships: z.array(membershipViewSchema),
  /** Roles held in the organization this request acted for. */
  effectiveRoles: z.array(z.string()),
});

export type CurrentUser = z.infer<typeof currentUserSchema>;

export async function fetchCurrentUser(
  client: ApiClient,
  signal?: AbortSignal,
): Promise<CurrentUser> {
  const result = await client.request({
    path: '/v1/users/me',
    schema: currentUserSchema,
    signal,
  });

  return result.data;
}

/**
 * The list adds the roles each user holds in the acting organization.
 *
 * `identity.service.ts` merges them onto the user row from the membership
 * records; the single-user view has no such field, which is why this is a
 * separate schema rather than a reuse of `userViewSchema`.
 */
export const organizationUserSchema = userViewSchema.extend({
  roles: z.array(z.string()),
});

export type OrganizationUser = z.infer<typeof organizationUserSchema>;

const userPageSchema = z.object({
  items: z.array(organizationUserSchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
});

/**
 * Users in the acting organization.
 *
 * Route roles are `ORGANIZATION_ADMIN` and `UNION_ADMIN`; every other role is
 * refused, and the screen renders that refusal as a refusal rather than as a
 * fault.
 */
export async function listUsers(
  client: ApiClient,
  signal?: AbortSignal,
): Promise<OrganizationUser[]> {
  const result = await client.request({
    path: '/v1/users',
    schema: userPageSchema,
    signal,
    query: { limit: 50 },
  });

  return result.data.items;
}
