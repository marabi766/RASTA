import { z } from 'zod';

import { normalizePersianText } from '@/lib/format';
import type {
  RevokeMembershipField,
  RevokeMembershipFormValues,
  UpdateMemberRolesField,
  UpdateMemberRolesFormValues,
} from '@/lib/organization-fields';

import { callGateway, GatewayRequestError } from './gateway';
import { webServerEnv } from './env';
import type { WebSession } from './session';
import type { ReadResult } from './assets';
import { writeThroughGateway, type FieldMapping, type WriteResult } from './write';

/**
 * The people in the organization this session is acting for, and the two
 * changes an administrator may make to one: which roles they hold, and whether
 * the membership stands at all.
 *
 * ## What this module does not decide
 *
 * Which roles may be granted is identity-service's decision, from deployment
 * configuration (`role-grants.ts`, `docs/24` Q-60). This module never
 * re-derives it; the caller's own grantable set arrives on
 * `GET /v1/users/me` and the form renders that. Sending a role outside it is
 * refused with `403 INSUFFICIENT_ROLE`, which arrives here as `FORBIDDEN` and
 * is rendered — not prevented, because preventing it in a browser is not a
 * control (`docs/16` § ۱۶٫۱۱).
 */

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

const memberSchema = z.object({
  id: z.string(),
  /** Null only for a row whose membership vanished between two queries. */
  membershipId: z.string().nullable().default(null),
  username: z.string(),
  firstName: z.string().default(''),
  lastName: z.string().default(''),
  status: z.string(),
  roles: z.array(z.string()).default([]),
});

export type Member = z.infer<typeof memberSchema>;

const memberPageSchema = z.object({
  items: z.array(memberSchema),
  nextCursor: z.string().nullable().default(null),
  hasMore: z.boolean().default(false),
});

export type MemberPage = z.infer<typeof memberPageSchema>;

export const MEMBERS_PER_PAGE = 20;

export interface MemberListQuery {
  readonly q?: string;
  readonly role?: string;
  readonly cursor?: string;
}

export async function fetchMembers(
  session: WebSession,
  query: MemberListQuery = {},
): Promise<ReadResult<MemberPage>> {
  const search = new URLSearchParams({ limit: String(MEMBERS_PER_PAGE) });
  if (query.q) search.set('q', query.q);
  if (query.role) search.set('role', query.role);
  if (query.cursor) search.set('cursor', query.cursor);

  try {
    const response = await callGateway<unknown>({
      baseUrl: webServerEnv().API_GATEWAY_URL,
      path: `/v1/users?${search.toString()}`,
      accessToken: session.accessToken,
    });

    const parsed = memberPageSchema.safeParse(response.data);
    if (!parsed.success) return { kind: 'MALFORMED', correlationId: response.correlationId };
    return { kind: 'OK', data: parsed.data };
  } catch (error) {
    if (error instanceof GatewayRequestError) {
      if (error.status === 403) return { kind: 'FORBIDDEN' };
      if (error.status === 404) return { kind: 'NOT_FOUND' };
      return { kind: 'UNAVAILABLE', status: error.status, correlationId: error.correlationId };
    }
    throw error;
  }
}

/** The display name, falling back through what is actually present. */
export function memberName(member: Member): string {
  const full = `${member.firstName} ${member.lastName}`.trim();
  return full.length > 0 ? full : member.username;
}

// ---------------------------------------------------------------------------
// Changing a member's roles
// ---------------------------------------------------------------------------

export function updateMemberRolesFormValues(form: FormData): UpdateMemberRolesFormValues {
  const membershipId = form.get('membershipId');
  const reason = form.get('reason');

  return {
    membershipId: typeof membershipId === 'string' ? membershipId.trim() : '',
    // `getAll`, not `get`: the roles are a checkbox group sharing one name, so
    // reading the first one would silently drop every role but one.
    roles: form.getAll('roles').filter((v): v is string => typeof v === 'string'),
    reason: typeof reason === 'string' ? normalizePersianText(reason) : '',
  };
}

/**
 * `reason` is required because identity-service requires it — a role change
 * without a stated why is refused there, and the event carries it into the
 * audit trail. Asking for it in the form is the difference between a person
 * writing a reason and a client inventing one.
 */
export const updateMemberRolesFormSchema = z.object({
  membershipId: z.string().trim().min(1, 'عضویت مشخص نیست'),
  roles: z
    .array(z.string().trim().min(1))
    .min(1, 'دست‌کم یک نقش را انتخاب کنید')
    // A checkbox group can post the same value twice if the page is malformed.
    .transform((roles) => [...new Set(roles)]),
  reason: z
    .string()
    .trim()
    .min(3, 'دلیل تغییر نقش را بنویسید')
    .max(500, 'دلیل نباید بیش از ۵۰۰ نویسه باشد'),
});

export type UpdateMemberRolesRequest = z.infer<typeof updateMemberRolesFormSchema>;

export type ParsedUpdateMemberRolesForm =
  | { readonly ok: true; readonly request: UpdateMemberRolesRequest }
  | { readonly ok: false; readonly fieldErrors: Partial<Record<UpdateMemberRolesField, string>> };

export function parseUpdateMemberRolesForm(
  values: UpdateMemberRolesFormValues,
): ParsedUpdateMemberRolesForm {
  const parsed = updateMemberRolesFormSchema.safeParse(values);
  if (parsed.success) return { ok: true, request: parsed.data };

  const fieldErrors: Partial<Record<UpdateMemberRolesField, string>> = {};
  for (const issue of parsed.error.issues) {
    const field = issue.path[0];
    if (field === 'membershipId' || field === 'roles' || field === 'reason') {
      fieldErrors[field] ??= issue.message;
    }
  }
  return { ok: false, fieldErrors };
}

export const UPDATE_MEMBER_ROLES_FIELD_MAPPING: FieldMapping<UpdateMemberRolesField> = {
  paths: {
    roles: 'roles',
    reason: 'reason',
    membershipId: 'membershipId',
  },
  messages: {},
};

export function updateMemberRoles(
  session: WebSession,
  request: UpdateMemberRolesRequest,
  submissionId: string,
  fetchImpl?: typeof fetch,
): Promise<WriteResult<{ id: string }, UpdateMemberRolesField>> {
  const { membershipId, ...body } = request;
  return writeThroughGateway(session, {
    path: `/v1/memberships/${encodeURIComponent(membershipId)}/roles`,
    body,
    submissionId,
    schema: z.object({ id: z.string() }),
    mapping: UPDATE_MEMBER_ROLES_FIELD_MAPPING,
    fetchImpl,
  });
}

// ---------------------------------------------------------------------------
// Revoking a membership
// ---------------------------------------------------------------------------

export function revokeMembershipFormValues(form: FormData): RevokeMembershipFormValues {
  const read = (field: RevokeMembershipField) => {
    const value = form.get(field);
    return typeof value === 'string' ? normalizePersianText(value) : '';
  };

  return { membershipId: read('membershipId'), reason: read('reason') };
}

export const revokeMembershipFormSchema = z.object({
  membershipId: z.string().trim().min(1, 'عضویت مشخص نیست'),
  reason: z
    .string()
    .trim()
    .min(3, 'دلیل ابطال عضویت را بنویسید')
    .max(500, 'دلیل نباید بیش از ۵۰۰ نویسه باشد'),
});

export type RevokeMembershipRequest = z.infer<typeof revokeMembershipFormSchema>;

export type ParsedRevokeMembershipForm =
  | { readonly ok: true; readonly request: RevokeMembershipRequest }
  | { readonly ok: false; readonly fieldErrors: Partial<Record<RevokeMembershipField, string>> };

export function parseRevokeMembershipForm(
  values: RevokeMembershipFormValues,
): ParsedRevokeMembershipForm {
  const parsed = revokeMembershipFormSchema.safeParse(values);
  if (parsed.success) return { ok: true, request: parsed.data };

  const fieldErrors: Partial<Record<RevokeMembershipField, string>> = {};
  for (const issue of parsed.error.issues) {
    const field = issue.path[0];
    if (field === 'membershipId' || field === 'reason') fieldErrors[field] ??= issue.message;
  }
  return { ok: false, fieldErrors };
}

export const REVOKE_MEMBERSHIP_FIELD_MAPPING: FieldMapping<RevokeMembershipField> = {
  paths: { reason: 'reason', membershipId: 'membershipId' },
  messages: {},
};

/**
 * `204 No Content` on success, so the schema parses "nothing".
 *
 * `z.unknown()` rather than a shape: there is no body to check, and asserting
 * one would fail on the service doing exactly what its contract says.
 */
export function revokeMembership(
  session: WebSession,
  request: RevokeMembershipRequest,
  submissionId: string,
  fetchImpl?: typeof fetch,
): Promise<WriteResult<unknown, RevokeMembershipField>> {
  const { membershipId, ...body } = request;
  return writeThroughGateway(session, {
    path: `/v1/memberships/${encodeURIComponent(membershipId)}/revoke`,
    body,
    submissionId,
    schema: z.unknown(),
    mapping: REVOKE_MEMBERSHIP_FIELD_MAPPING,
    fetchImpl,
  });
}
