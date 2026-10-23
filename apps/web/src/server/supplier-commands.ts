import { z } from 'zod';

import {
  ALREADY_REGISTERED_MESSAGE,
  BUSINESS_RULE_MESSAGE,
  INVALID_INPUT_MESSAGE,
  MAX_EVIDENCE_ITEMS,
  SUPPLIER_422_PATTERNS,
  SUPPLIER_VALIDATION_MESSAGES,
  isSupplierCommand,
  type ApproveBody,
  type ApproveField,
  type ReasonField,
  type RegisterBody,
  type RegisterField,
  type RejectBody,
  type RejectField,
  type SubmitBody,
  type SubmitField,
  type SupplierCommand,
} from '@/lib/supplier-commands';
import { SUPPLIER_CAPABILITIES, type SupplierCapability } from '@/lib/supplier-fields';

import { tokenAuthority, tokenMemberships } from './realm-roles';
import type { WebSession } from './session';
import { signPayload, verifyPayload } from './signed-payload';
import { writeThroughGateway, type FieldMapping, type WriteResult } from './write';

/**
 * Registering a supplier, submitting, approving and rejecting a qualification,
 * suspending and reinstating, through the gateway (EXP-004; ADR-058 § 3,
 * ADR-059 § 3).
 *
 * The same split as `asset-lifecycle-commands.ts`: the form's own schema says
 * what a person may type and in what words a mistake is reported;
 * supplier-service decides what is true. A rule copied here saves a round trip
 * and is never the enforcement.
 *
 * ## No Idempotency-Key, and so no retry
 *
 * None of the six endpoints takes one — the controller reads none, the OpenAPI
 * document lists none, and the gateway's `suppliers` route does not require one.
 * So no key is sent, a lost answer is `UNCONFIRMED` (look at the record, then
 * decide), and what makes a double press harmless is the service's own state
 * rules: a second registration is `409`, a second submission, decision,
 * suspension or reinstatement is `422`. The page then says the record changed and
 * that nothing was written this time (`STALE_MESSAGE`).
 *
 * ## What a command acts on
 *
 * Not a field of any form. The page signs `{supplier, command, qualification}`
 * for this session (`sealSupplierBaseline`); the action takes the supplier, and
 * for a decision the qualification, from that token alone.
 */

// ---------------------------------------------------------------------------
// Who is offered the forms
// ---------------------------------------------------------------------------

/**
 * The supplier-service role sets (`access/access.ts`, pinned by the contract
 * spec). The service answers **no** `availableActions` or permission list, so
 * these are the portal's mirror of its rules, exactly as `canManageAssets` is
 * for assets: a form drawn for nobody who could use it is a lie, a form hidden
 * from somebody who could is a missing feature, and the service refuses again on
 * every send.
 */
export const SUPPLIER_SIDE_ROLES: readonly string[] = [
  'ORGANIZATION_ADMIN',
  'SUPPLIER',
  'WORKSHOP',
  'CONTRACTOR',
];
export const PLATFORM_ROLES: readonly string[] = ['SYSTEM_ADMIN', 'UNION_ADMIN'];

/** The oversight role is refused by every route here whatever else its holder has. */
const OVERSIGHT_ROLE = 'AUDITOR';

/** What the token says about who is acting. Null when it cannot be read. */
export interface SupplierActor {
  readonly roles: readonly string[];
  /** The organization the request acts for; null for a token with no `org_id`. */
  readonly organizationId: string | null;
  /** Every organization the person belongs to (`org_ids`). */
  readonly memberships: readonly string[];
}

export function supplierActor(accessToken: string): SupplierActor | null {
  const authority = tokenAuthority(accessToken);
  if (!authority) return null;
  return {
    roles: authority.roles,
    organizationId: authority.organizationId,
    memberships: tokenMemberships(accessToken),
  };
}

/**
 * `hasAnyRole` of the service: **no** administrator bypass (unlike the route
 * guard's `rolesGuardAdmits`), because every command here checks the role set
 * again in `access.ts` — a `SYSTEM_ADMIN` is not a supplier-side role.
 */
function holds(actor: SupplierActor, required: readonly string[]): boolean {
  if (actor.roles.includes(OVERSIGHT_ROLE)) return false;
  return required.some((role) => actor.roles.includes(role));
}

/** `assertCanRegisterSupplier`: a supplier-side role and an organization to own the profile. */
export const canRegisterSupplier = (actor: SupplierActor): boolean =>
  actor.organizationId !== null && holds(actor, SUPPLIER_SIDE_ROLES);

/**
 * `assertActingAsSupplier`: a supplier-side role **in the supplier's own
 * organization**. Platform scope does not exempt: an operator submitting for a
 * supplier would approve what they submitted.
 */
export const canActAsSupplier = (actor: SupplierActor, supplierOrganizationId: string): boolean =>
  actor.organizationId === supplierOrganizationId && holds(actor, SUPPLIER_SIDE_ROLES);

/**
 * `assertCanDecideAbout`: platform scope, and then — whatever the role — not a
 * member of the supplier's organization, judged on the whole membership set.
 */
export const canDecideAbout = (actor: SupplierActor, supplierOrganizationId: string): boolean =>
  holds(actor, PLATFORM_ROLES) &&
  actor.organizationId !== supplierOrganizationId &&
  !actor.memberships.includes(supplierOrganizationId);

/** Why a person holding a platform role is offered no decision: the one reason the page may say. */
export const isOwnCase = (actor: SupplierActor, supplierOrganizationId: string): boolean =>
  holds(actor, PLATFORM_ROLES) &&
  (actor.organizationId === supplierOrganizationId ||
    actor.memberships.includes(supplierOrganizationId));

/**
 * The capabilities a submission may still be sent for: every one with no
 * qualification awaiting a decision and none approved (`assertNoBlockingQualification`;
 * a rejected one blocks nothing).
 */
export function offerableCapabilities(
  qualifications: readonly { readonly capability: string; readonly state: string }[],
): SupplierCapability[] {
  const blocked = new Set(
    qualifications
      .filter((q) => q.state === 'SUBMITTED' || q.state === 'APPROVED')
      .map((q) => q.capability),
  );
  return SUPPLIER_CAPABILITIES.filter((capability) => !blocked.has(capability));
}

// ---------------------------------------------------------------------------
// What the service says, in Persian
// ---------------------------------------------------------------------------

/** `details[].path` of the service's validation answer → the form's own field. */
function evidencePaths(): Record<string, 'evidence'> {
  const paths: Record<string, 'evidence'> = { evidence: 'evidence' };
  for (let index = 0; index < MAX_EVIDENCE_ITEMS; index += 1) {
    paths[`evidence.${index}`] = 'evidence';
    paths[`evidence.${index}.documentId`] = 'evidence';
    paths[`evidence.${index}.label`] = 'evidence';
  }
  return paths;
}

function mappingOf<F extends string>(paths: Record<string, F>): FieldMapping<F> {
  return {
    paths,
    messages: SUPPLIER_VALIDATION_MESSAGES,
    patterns: SUPPLIER_422_PATTERNS,
    byCode: {
      ALREADY_EXISTS: ALREADY_REGISTERED_MESSAGE,
      BUSINESS_RULE_VIOLATION: BUSINESS_RULE_MESSAGE,
    },
    // Never the service's own sentence: a text field could echo a stranger's
    // characters, so the list of words stays closed.
    fallback: INVALID_INPUT_MESSAGE,
  };
}

export const REGISTER_FIELD_MAPPING = mappingOf<RegisterField>({
  displayName: 'displayName',
  capabilities: 'capabilities',
});
export const SUBMIT_FIELD_MAPPING = mappingOf<SubmitField>({
  capability: 'capability',
  statement: 'statement',
  ...evidencePaths(),
});
export const APPROVE_FIELD_MAPPING = mappingOf<ApproveField>({ note: 'note' });
export const REJECT_FIELD_MAPPING = mappingOf<RejectField>({ reason: 'reason', note: 'note' });
export const REASON_FIELD_MAPPING = mappingOf<ReasonField>({ reason: 'reason' });

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

const answerSchema = z.object({ id: z.string().min(1) });
export type WrittenSupplier = z.infer<typeof answerSchema>;

export const registerSupplier = (
  session: WebSession,
  body: RegisterBody,
  fetchImpl?: typeof fetch,
): Promise<WriteResult<WrittenSupplier, RegisterField>> =>
  writeThroughGateway(session, {
    path: '/v1/suppliers',
    body,
    schema: answerSchema,
    mapping: REGISTER_FIELD_MAPPING,
    fetchImpl,
  });

const supplierPath = (supplierId: string): string =>
  `/v1/suppliers/${encodeURIComponent(supplierId)}`;

export const submitQualification = (
  session: WebSession,
  supplierId: string,
  body: SubmitBody,
  fetchImpl?: typeof fetch,
): Promise<WriteResult<WrittenSupplier, SubmitField>> =>
  writeThroughGateway(session, {
    path: `${supplierPath(supplierId)}/qualifications`,
    body,
    schema: answerSchema,
    mapping: SUBMIT_FIELD_MAPPING,
    fetchImpl,
  });

const decisionPath = (supplierId: string, qualificationId: string, verb: string): string =>
  `${supplierPath(supplierId)}/qualifications/${encodeURIComponent(qualificationId)}/${verb}`;

export const approveQualification = (
  session: WebSession,
  supplierId: string,
  qualificationId: string,
  body: ApproveBody,
  fetchImpl?: typeof fetch,
): Promise<WriteResult<WrittenSupplier, ApproveField>> =>
  writeThroughGateway(session, {
    path: decisionPath(supplierId, qualificationId, 'approve'),
    body,
    schema: answerSchema,
    mapping: APPROVE_FIELD_MAPPING,
    fetchImpl,
  });

export const rejectQualification = (
  session: WebSession,
  supplierId: string,
  qualificationId: string,
  body: RejectBody,
  fetchImpl?: typeof fetch,
): Promise<WriteResult<WrittenSupplier, RejectField>> =>
  writeThroughGateway(session, {
    path: decisionPath(supplierId, qualificationId, 'reject'),
    body,
    schema: answerSchema,
    mapping: REJECT_FIELD_MAPPING,
    fetchImpl,
  });

export const suspendSupplier = (
  session: WebSession,
  supplierId: string,
  body: { readonly reason: string },
  fetchImpl?: typeof fetch,
): Promise<WriteResult<WrittenSupplier, ReasonField>> =>
  writeThroughGateway(session, {
    path: `${supplierPath(supplierId)}/suspend`,
    body,
    schema: answerSchema,
    mapping: REASON_FIELD_MAPPING,
    fetchImpl,
  });

export const reinstateSupplier = (
  session: WebSession,
  supplierId: string,
  body: { readonly reason: string },
  fetchImpl?: typeof fetch,
): Promise<WriteResult<WrittenSupplier, ReasonField>> =>
  writeThroughGateway(session, {
    path: `${supplierPath(supplierId)}/reinstate`,
    body,
    schema: answerSchema,
    mapping: REASON_FIELD_MAPPING,
    fetchImpl,
  });

// ---------------------------------------------------------------------------
// What a command was drawn from
// ---------------------------------------------------------------------------

const BASELINE_PURPOSE = 'supplier-baseline';

/**
 * Half an hour, like the asset lifecycle baseline: a decision about another
 * organization is read and thought about before it is sent, but a page left open
 * for a morning is not what the person decided on. The service decides again on
 * every send, so this bounds how stale a *confirmation* can be, not how stale a
 * write can be.
 */
const BASELINE_TTL_SECONDS = 30 * 60;

const baselineSchema = z.object({
  supplierId: z.string().min(1).max(200),
  command: z.string().refine(isSupplierCommand),
  /** The qualification a decision is about; null for every other command. */
  qualificationId: z.string().min(1).max(200).nullable(),
});

export interface SupplierBaseline {
  readonly supplierId: string;
  readonly command: SupplierCommand;
  readonly qualificationId: string | null;
}

/**
 * The supplier a command is for, the command and — for a decision — the
 * qualification, signed for this session. Bound to the **command** too, so the
 * token minted beside "approve" cannot be posted to the form that rejects, and
 * to the **qualification**, so approving one cannot be redirected to another.
 */
export function sealSupplierBaseline(session: WebSession, baseline: SupplierBaseline): string {
  return signPayload(session, BASELINE_PURPOSE, { ...baseline }, BASELINE_TTL_SECONDS);
}

/**
 * The baseline, if `token` is one this session was given for `command`;
 * otherwise `null` — one answer for forged, somebody else's, expired, minted for
 * another command, and from an earlier login.
 */
export function openSupplierBaseline(
  session: WebSession,
  token: unknown,
  command: SupplierCommand,
): SupplierBaseline | null {
  const payload = verifyPayload(session, BASELINE_PURPOSE, token, baselineSchema);
  if (!payload || payload.command !== command) return null;
  return {
    supplierId: payload.supplierId,
    command,
    qualificationId: payload.qualificationId,
  };
}
