import { z } from 'zod';
import type { AdapterDescriptor } from '../adapter';
import type { GatewayClient } from '../client';

/**
 * Organization reads, used by the tenant switcher.
 *
 * ## The distinction this adapter exists to preserve
 *
 * `GET /v1/organizations` answers "organizations **visible** to the caller",
 * which is a subtree question. Membership is a different question, and the
 * only authoritative answer to it is the signed `org_ids` claim on the access
 * token (`packages/nest-common/src/auth/token-verifier.ts`).
 *
 * Those two sets are not the same, and conflating them is how a tenant
 * switcher ends up offering an organization the gateway will then refuse with
 * `TENANT_MISMATCH`. `membershipOptions` intersects them explicitly, and keeps
 * a membership with no readable organization row rather than dropping it —
 * the token says the user belongs there, so hiding it would be the frontend
 * overruling a signed claim.
 */

export const ORGANIZATION_DIRECTORY_ADAPTER = {
  id: 'organization.directory',
  service: 'organization-service',
  routes: ['GET /v1/organizations'],
} as const satisfies AdapterDescriptor;

/** Mirrors `OrganizationView`. */
export const organizationViewSchema = z.object({
  id: z.string(),
  externalCode: z.string().nullable(),
  name: z.string(),
  shortName: z.string().nullable(),
  type: z.string(),
  status: z.string(),
  parentId: z.string().nullable(),
  path: z.string().nullable(),
  depth: z.number().int(),
  metadata: z.record(z.unknown()),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type OrganizationView = z.infer<typeof organizationViewSchema>;

const listResponseSchema = z.object({
  items: z.array(organizationViewSchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
});

export async function listVisibleOrganizations(
  client: GatewayClient,
  signal?: AbortSignal,
): Promise<OrganizationView[]> {
  const result = await client.request({
    path: '/v1/organizations',
    schema: listResponseSchema,
    signal,
    query: { limit: 100 },
  });

  return result.data.items;
}

export interface MembershipOption {
  readonly organizationId: string;
  /** The organization's name, or `null` when only the membership is known. */
  readonly name: string | null;
  readonly type: string | null;
  readonly status: string | null;
}

/**
 * The organizations a user may actually act as.
 *
 * Driven by the token claim, decorated by the directory — never the other way
 * round. An organization the directory returns but the token does not name is
 * one the user can *see* and not *act as*, and it must not appear here.
 */
export function membershipOptions(
  organizationIds: readonly string[],
  directory: readonly OrganizationView[],
): MembershipOption[] {
  const byId = new Map(directory.map((organization) => [organization.id, organization]));

  return organizationIds.map((organizationId) => {
    const organization = byId.get(organizationId);
    return {
      organizationId,
      name: organization?.name ?? null,
      type: organization?.type ?? null,
      status: organization?.status ?? null,
    };
  });
}
