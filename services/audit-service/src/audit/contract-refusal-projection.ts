import { z } from 'zod';
import { DLQ_REASONS, type EventEnvelope } from '@rasta/contracts';
import { UnprocessableEventError, type EventDelivery } from '@rasta/nest-common';

/**
 * The allow-listed projection of contract-service's refusal events onto the audit row.
 *
 * `CONTRACT_AUTHORITY_REFUSED` (an authority-bound action by a party was refused, for want of
 * authority or for separation of duties), `CONTRACT_SIGNATURE_REFUSED` (the employer's signature
 * was refused for want of a policy) and `APPROVAL_POLICY_APPROVAL_REFUSED` (a policy's approval
 * refused by four eyes) are *published* — they are the durable record of a refusal — so the path-A
 * default of "an event on a topic is a success under its own name" is wrong for them:
 * `outcome=REFUSED` searches missed every contract, amendment, milestone, statement and
 * policy-approval refusal. These events are stored as `REFUSED`, under the closed action the
 * refusal names (`SIGN_CONTRACT`, `SIGN_AMENDMENT`, …, `DRAFT_STATEMENT`, `APPROVE_POLICY`) and the
 * closed reason.
 *
 * Only authority and separation-of-duties refusals are published as refusals; contract-service
 * answers a refusal of a contract's state (a contract no longer a draft) without a record.
 *
 * ## Allow-list, not redaction
 *
 * Only `action` and `reason` are read, by name, from a payload validated against a local, strict
 * schema (services share no source, A-02: `contract-refusal-projection.spec.ts` reads contract's
 * source as text and fails when the two lists disagree). Nothing else of the payload is stored —
 * the contract, subject and policy ids, the side and the actor are already the row's resource and
 * actor, or are not audit-row material. A payload that does not match is not stored in part: it
 * throws {@link UnprocessableEventError}, which the shared consumer dead-letters at once, naming
 * schema paths and issue codes only, never a value.
 */

/** The topic these events arrive on. Delivery metadata, never the envelope. */
export const CONTRACT_TOPIC = 'rasta.contract.v1';

export const CONTRACT_REFUSAL_EVENTS = {
  AUTHORITY: 'CONTRACT_AUTHORITY_REFUSED',
  SIGNATURE: 'CONTRACT_SIGNATURE_REFUSED',
  POLICY_APPROVAL: 'APPROVAL_POLICY_APPROVAL_REFUSED',
} as const;

/** The action a refused policy approval is stored under. */
export const POLICY_APPROVAL_ACTION = 'APPROVE_POLICY';

/** Contract-service's `POLICY_APPROVAL_REFUSED_REASONS`. */
export const POLICY_APPROVAL_REFUSAL_REASONS = ['SELF_APPROVAL'] as const;

/** Contract-service's `AUTHORITY_REFUSED_ACTIONS`. */
export const CONTRACT_REFUSAL_ACTIONS = [
  'SIGN_CONTRACT',
  'CANCEL_CONTRACT',
  'PROPOSE_AMENDMENT',
  'SIGN_AMENDMENT',
  'PLAN_MILESTONE',
  'CHANGE_MILESTONE',
  'DRAFT_STATEMENT',
] as const;

/** Contract-service's `AUTHORITY_REFUSED_REASONS`. */
export const CONTRACT_REFUSAL_REASONS = [
  'ROLE_NOT_PERMITTED',
  'NOT_EMPLOYER',
  'NOT_CONTRACTOR',
  'SIGNATURE_POLICY_REQUIRED',
  'POLICY_AUTHOR_NOT_GOVERNING',
  'MEMBER_OF_BOTH_PARTIES',
  'SAME_PERSON_BOTH_SIDES',
  'PLATFORM_ADMINISTRATOR',
] as const;

const id = z.string().min(1).max(128);
const instant = z.string().datetime({ offset: true });

const authorityRefused = z
  .object({
    contractId: id,
    organizationId: id,
    action: z.enum(CONTRACT_REFUSAL_ACTIONS),
    side: z.enum(['EMPLOYER', 'CONTRACTOR']),
    subjectId: id.nullable(),
    reason: z.enum(CONTRACT_REFUSAL_REASONS),
    policyId: id.nullable(),
    refusedBy: id,
    refusedAt: instant,
  })
  .strict();

/** The employer's signature refused for want of a policy: always the contract's own signature. */
const signatureRefused = z
  .object({
    contractId: id,
    organizationId: id,
    side: z.literal('EMPLOYER'),
    reason: z.enum(['SIGNATURE_POLICY_REQUIRED', 'POLICY_AUTHOR_NOT_GOVERNING']),
    policyId: id.nullable(),
    refusedBy: id,
    refusedAt: instant,
  })
  .strict();

/** A policy's platform approval refused for separation of duties (four eyes). */
const policyApprovalRefused = z
  .object({
    policyId: id,
    organizationId: id,
    workflowKey: z.string().min(1).max(64),
    policyVersion: z.number().int().min(1),
    reason: z.enum(POLICY_APPROVAL_REFUSAL_REASONS),
    refusedBy: id,
    refusedAt: instant,
  })
  .strict();

export interface ContractRefusalProjection {
  readonly action: (typeof CONTRACT_REFUSAL_ACTIONS)[number] | typeof POLICY_APPROVAL_ACTION;
  readonly reason:
    (typeof CONTRACT_REFUSAL_REASONS)[number] | (typeof POLICY_APPROVAL_REFUSAL_REASONS)[number];
}

/**
 * The refusal an envelope records, or `null` for any other envelope — including one of these names
 * arriving on another topic, which is not contract-service's record of anything.
 */
export function toContractRefusalProjection(
  envelope: EventEnvelope,
  delivery: EventDelivery,
): ContractRefusalProjection | null {
  if (delivery.topic !== CONTRACT_TOPIC) return null;
  if (envelope.eventName === CONTRACT_REFUSAL_EVENTS.AUTHORITY) {
    const parsed = authorityRefused.safeParse(envelope.payload);
    if (!parsed.success) throw unprocessable(envelope.eventName, parsed.error);
    return { action: parsed.data.action, reason: parsed.data.reason };
  }
  if (envelope.eventName === CONTRACT_REFUSAL_EVENTS.SIGNATURE) {
    const parsed = signatureRefused.safeParse(envelope.payload);
    if (!parsed.success) throw unprocessable(envelope.eventName, parsed.error);
    return { action: 'SIGN_CONTRACT', reason: parsed.data.reason };
  }
  if (envelope.eventName === CONTRACT_REFUSAL_EVENTS.POLICY_APPROVAL) {
    const parsed = policyApprovalRefused.safeParse(envelope.payload);
    if (!parsed.success) throw unprocessable(envelope.eventName, parsed.error);
    return { action: POLICY_APPROVAL_ACTION, reason: parsed.data.reason };
  }
  return null;
}

function unprocessable(eventName: string, error: z.ZodError): UnprocessableEventError {
  const issues = error.issues.map((issue) => `${issue.path.join('.') || '(root)'}:${issue.code}`);
  return new UnprocessableEventError(
    DLQ_REASONS.VALIDATION_FAILED,
    `${eventName} does not match the contract refusal projection (${issues.join(', ')})`,
  );
}
