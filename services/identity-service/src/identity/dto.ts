import { z } from 'zod';
import { cursorPaginationSchema, seedIdSchema, ID_PREFIXES } from '@rasta/contracts';

/**
 * Request and response shapes.
 *
 * Every input schema is `.strict()`: an unrecognised field is rejected rather
 * than ignored. Silently dropping unknown keys is how mass-assignment bugs and
 * "I set that field, why didn't it save?" support tickets both start.
 */

const organizationId = seedIdSchema(ID_PREFIXES.organization);

/**
 * Persian names are the norm here, so the pattern allows Arabic-script letters,
 * Latin letters, spaces, ZWNJ (نیم‌فاصله) and hyphens. A name is a label, not
 * an identifier — the rule exists to reject control characters and markup, not
 * to police what a person may be called.
 */
const personName = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(
    /^[\p{Script=Arabic}\p{Script=Latin}\p{Mark}\s‌'’\-.]+$/u,
    'Name contains unsupported characters',
  );

export const USER_STATUSES = ['PENDING', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED'] as const;
export const MEMBERSHIP_STATUSES = ['ACTIVE', 'SUSPENDED', 'REVOKED'] as const;

export const PLATFORM_ROLES = [
  'SYSTEM_ADMIN',
  'UNION_ADMIN',
  'ORGANIZATION_ADMIN',
  'FLEET_MANAGER',
  'DRIVER',
  'OPERATOR',
  'PROCUREMENT_USER',
  'SUPPLIER',
  'WORKSHOP',
  'CONTRACTOR',
  'AUDITOR',
] as const;

export const roleSchema = z.enum(PLATFORM_ROLES);
export type PlatformRole = z.infer<typeof roleSchema>;

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export const createUserSchema = z
  .object({
    username: z
      .string()
      .trim()
      .min(3)
      .max(64)
      .regex(/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/, 'Username must be lowercase alphanumeric'),
    email: z.string().trim().toLowerCase().email().max(255),
    firstName: personName,
    lastName: personName,
    /** Iranian mobile, in either local or E.164 form. */
    phone: z
      .string()
      .trim()
      .regex(/^(?:\+98|0)9\d{9}$/, 'Phone must be a valid Iranian mobile number')
      .optional(),
    organizationId,
    roles: z.array(roleSchema).min(1).max(PLATFORM_ROLES.length),
  })
  .strict();

export type CreateUserDto = z.infer<typeof createUserSchema>;

export const updateUserSchema = z
  .object({
    firstName: personName.optional(),
    lastName: personName.optional(),
    phone: z
      .string()
      .trim()
      .regex(/^(?:\+98|0)9\d{9}$/)
      .nullable()
      .optional(),
  })
  .strict()
  // A PATCH with no fields is almost always a client bug, and answering 200
  // hides it.
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field must be provided',
  });

export type UpdateUserDto = z.infer<typeof updateUserSchema>;

export const listUsersQuerySchema = cursorPaginationSchema
  .extend({
    status: z.enum(USER_STATUSES).optional(),
    role: roleSchema.optional(),
    /** Free-text over name, username and email. */
    q: z.string().trim().min(1).max(100).optional(),
  })
  .strict();

export type ListUsersQuery = z.infer<typeof listUsersQuerySchema>;

// ---------------------------------------------------------------------------
// Memberships
// ---------------------------------------------------------------------------

export const createMembershipSchema = z
  .object({
    organizationId,
    roles: z.array(roleSchema).min(1),
    validUntil: z.string().datetime().optional(),
  })
  .strict();

export type CreateMembershipDto = z.infer<typeof createMembershipSchema>;

export const updateMembershipRolesSchema = z
  .object({
    roles: z.array(roleSchema).min(1),
    /** Recorded on the audit event. Role changes need a stated why. */
    reason: z.string().trim().min(3).max(500),
  })
  .strict();

export type UpdateMembershipRolesDto = z.infer<typeof updateMembershipRolesSchema>;

export const revokeMembershipSchema = z
  .object({ reason: z.string().trim().min(3).max(500) })
  .strict();

export type RevokeMembershipDto = z.infer<typeof revokeMembershipSchema>;

export const switchOrganizationSchema = z.object({ organizationId }).strict();
export type SwitchOrganizationDto = z.infer<typeof switchOrganizationSchema>;

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export const submitRegistrationSchema = z
  .object({
    username: z
      .string()
      .trim()
      .min(3)
      .max(64)
      .regex(/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/),
    email: z.string().trim().toLowerCase().email().max(255),
    firstName: personName,
    lastName: personName,
    phone: z
      .string()
      .trim()
      .regex(/^(?:\+98|0)9\d{9}$/)
      .optional(),
    requestedOrganizationId: organizationId,
    requestedRoles: z.array(roleSchema).min(1),
    justification: z.string().trim().max(1000).optional(),
    /** Document ids from document-service. Never file contents. */
    documentRefs: z.array(z.string().min(1)).max(10).default([]),
  })
  .strict();

export type SubmitRegistrationDto = z.infer<typeof submitRegistrationSchema>;

export const approveRegistrationSchema = z
  .object({
    /** Lets the reviewer grant something narrower than what was asked for. */
    roles: z.array(roleSchema).min(1).optional(),
  })
  .strict();

export type ApproveRegistrationDto = z.infer<typeof approveRegistrationSchema>;

export const rejectRegistrationSchema = z
  .object({
    // Required, not optional. A refusal a person cannot understand or appeal
    // is not a decision, and the product document is built on traceability.
    reason: z.string().trim().min(10).max(1000),
  })
  .strict();

export type RejectRegistrationDto = z.infer<typeof rejectRegistrationSchema>;

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export interface MembershipView {
  id: string;
  organizationId: string;
  organizationName: string | null;
  roles: string[];
  status: string;
  validFrom: string;
  validUntil: string | null;
}

export interface UserView {
  id: string;
  username: string;
  email: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  status: string;
  activeOrganizationId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CurrentUserView extends UserView {
  memberships: MembershipView[];
  /** Roles in the organization this request acts for. */
  effectiveRoles: string[];
}

export interface RegistrationRequestView {
  id: string;
  userId: string;
  username: string;
  email: string;
  fullName: string;
  requestedOrganizationId: string;
  requestedRoles: string[];
  justification: string | null;
  status: string;
  reviewedBy: string | null;
  reviewedAt: string | null;
  rejectionReason: string | null;
  createdAt: string;
}
