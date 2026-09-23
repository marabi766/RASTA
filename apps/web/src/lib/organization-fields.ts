/**
 * The shape of every `/organizations` form: field names, blank value sets, and
 * the Persian labels for the roles a member can hold.
 *
 * Separate from `server/organizations.ts` and `server/members.ts` for the
 * reason `usage-fields.ts` documents: those modules reach the gateway client
 * and pull in `node:crypto` transitively, and the build refuses a client
 * component that imports it.
 */

// ---------------------------------------------------------------------------
// The organization's own profile
// ---------------------------------------------------------------------------

/**
 * Exactly the three fields `updateOrganizationSchema` accepts, and no others.
 *
 * `type`, `parentId` and `status` are absent because moving an organization in
 * the hierarchy and changing its status are `UNION_ADMIN` operations
 * (`@Roles` on `:id/move` and `:id/status`), and this is the
 * `ORGANIZATION_ADMIN` page — `docs/16` § ۱۶٫۶ puts hierarchy management on
 * the admin console's own `/organizations`, which does not exist yet.
 *
 * `metadata` is absent because it is a free-form record with no agreed keys;
 * a form cannot edit a shape nobody has defined. Contacts and locations have
 * endpoints of their own (`:id/contacts`, `:id/locations`) and are not in this
 * screen's first version.
 */
export const UPDATE_ORGANIZATION_FIELDS = ['name', 'shortName', 'externalCode'] as const;

export type UpdateOrganizationField = (typeof UPDATE_ORGANIZATION_FIELDS)[number];
export type UpdateOrganizationFormValues = Readonly<Record<UpdateOrganizationField, string>>;

export const EMPTY_UPDATE_ORGANIZATION_FORM: UpdateOrganizationFormValues = {
  name: '',
  shortName: '',
  externalCode: '',
};

// ---------------------------------------------------------------------------
// A member's roles
// ---------------------------------------------------------------------------

/**
 * `membershipId` rides in the form because one page renders one of these per
 * member; the row being changed has to say which it is.
 *
 * `roles` is repeated — a set of checkboxes with one name — so the form reads
 * it with `getAll`, not `get`.
 */
export const UPDATE_MEMBER_ROLES_FIELDS = ['membershipId', 'roles', 'reason'] as const;

export type UpdateMemberRolesField = (typeof UPDATE_MEMBER_ROLES_FIELDS)[number];

export interface UpdateMemberRolesFormValues {
  readonly membershipId: string;
  readonly roles: readonly string[];
  readonly reason: string;
}

export const EMPTY_UPDATE_MEMBER_ROLES_FORM: UpdateMemberRolesFormValues = {
  membershipId: '',
  roles: [],
  reason: '',
};

// ---------------------------------------------------------------------------
// Revoking a membership
// ---------------------------------------------------------------------------

export const REVOKE_MEMBERSHIP_FIELDS = ['membershipId', 'reason'] as const;

export type RevokeMembershipField = (typeof REVOKE_MEMBERSHIP_FIELDS)[number];
export type RevokeMembershipFormValues = Readonly<Record<RevokeMembershipField, string>>;

export const EMPTY_REVOKE_MEMBERSHIP_FORM: RevokeMembershipFormValues = {
  membershipId: '',
  reason: '',
};

// ---------------------------------------------------------------------------
// Role labels
// ---------------------------------------------------------------------------

/**
 * Persian names for the platform roles, for rendering only.
 *
 * **Not a list of what may be granted.** That comes from the service, per
 * caller, on `GET /v1/users/me` — the ladder is deployment configuration
 * (`docs/24` Q-60) and a hardcoded list here would disagree with it the moment
 * anyone changes `ROLE_GRANTS_BY_*`. This map only answers "what do I call
 * this role on screen", and `roleLabel` falls back to the raw name so a role
 * the platform gains before this map does still renders as something.
 */
export const ROLE_LABELS: Readonly<Record<string, string>> = {
  SYSTEM_ADMIN: 'مدیر سامانه',
  UNION_ADMIN: 'مدیر اتحادیه',
  ORGANIZATION_ADMIN: 'مدیر سازمان',
  FLEET_MANAGER: 'مدیر ناوگان',
  DRIVER: 'راننده',
  OPERATOR: 'اپراتور',
  PROCUREMENT_USER: 'کاربر تدارکات',
  SUPPLIER: 'تأمین‌کننده',
  WORKSHOP: 'تعمیرگاه',
  CONTRACTOR: 'پیمانکار',
  AUDITOR: 'حسابرس',
};

export function roleLabel(role: string): string {
  return ROLE_LABELS[role] ?? role;
}

/** Persian names for membership status, same fallback rule. */
export const MEMBERSHIP_STATUS_LABELS: Readonly<Record<string, string>> = {
  ACTIVE: 'فعال',
  SUSPENDED: 'معلق',
  REVOKED: 'باطل‌شده',
};

export function membershipStatusLabel(status: string): string {
  return MEMBERSHIP_STATUS_LABELS[status] ?? status;
}
