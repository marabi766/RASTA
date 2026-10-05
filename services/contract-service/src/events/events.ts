import { z } from 'zod';

/**
 * Events published by contract-service, on `rasta.contract.v1`.
 *
 * `CONTRACT_DRAFTED` is the one event of CON-003 PR 1: the draft a tender award
 * created. The catalogue (`docs/04` § 4.13) named `CONTRACT_CREATED` with an
 * `amount`; ADR-068 § 4 defines `CONTRACT_DRAFTED` in its place, without the amount
 * (the project manager names it and accepts the change).
 *
 * The payloads are defined here because this service owns them (ADR-032); the
 * only cross-service contract in `packages/contracts` is the audit trail.
 *
 * ## What these payloads never carry
 *
 * **Identifiers and instants only — no amount, no free text, no personal data.**
 * The topic is read by every service that declares a subscription, and by
 * audit-service in full (`docs/07` § 7.3). The contract's price is the winner's bid
 * price, which `TENDER_AWARDED` itself does not carry (round 1 of #199); a consumer
 * that needs it asks this service's API under its own authorization.
 */

export const CONTRACT_EVENTS = {
  CONTRACT_DRAFTED: 'CONTRACT_DRAFTED',
  CONTRACT_SIGNATURE_RECORDED: 'CONTRACT_SIGNATURE_RECORDED',
  CONTRACT_SIGNED: 'CONTRACT_SIGNED',
  CONTRACT_CANCELLED: 'CONTRACT_CANCELLED',
} as const;

export type ContractEventName = keyof typeof CONTRACT_EVENTS;

const id = z.string().min(1).max(128);
/** ISO 8601 in UTC, the form every event of the platform carries a time in. */
const instant = z.string().datetime({ offset: false });

/**
 * A draft contract was made from an awarded tender (ADR-068 § 3). Keyed by
 * `contractId`; one per tender, so a redelivery of the award never publishes a second.
 */
export const contractDraftedPayload = z
  .object({
    contractId: id,
    tenderId: id,
    projectId: id,
    /** The employer — the tender's owner and the tenant of the contract. */
    organizationId: id,
    contractorOrganizationId: id,
    winningBidId: id,
    draftedAt: instant,
  })
  .strict();

/**
 * One side accepted the draft (CON-003 PR 2, Q-95 (1)): the audit fact of a signature, published
 * for **each** of the two, in the transaction that records it. The signer is named by user id —
 * an identifier, like `awardedBy` on `TENDER_AWARDED` — because a signature without a person is
 * no audit record; the identity pair used for the separation-of-duties check stays in this
 * service's database. **No amount.**
 */
export const contractSignatureRecordedPayload = z
  .object({
    contractId: id,
    /** The employer — the tender's owner and the tenant of the contract. */
    organizationId: id,
    side: z.enum(['EMPLOYER', 'CONTRACTOR']),
    /** The organization the signer acted for. */
    signerOrganizationId: id,
    signedBy: id,
    /** The role the signature was accepted under, as the configuration named it. */
    authorityRole: z.string().regex(/^[A-Z][A-Z_]*$/),
    signedAt: instant,
  })
  .strict();

/**
 * Both sides have accepted the contract and it is SIGNED (ADR-068 § 2, CON-003 PR 2): the
 * `DRAFT → SIGNED` transition, which `docs/08` § 8.3 names `AWARDED → CONTRACTED`. Published
 * once, with the second signature, in the transaction that records it. **No amount, no
 * signer** — instants and organizations only; who signed is on each
 * `CONTRACT_SIGNATURE_RECORDED` and in the service's own signature record.
 */
export const contractSignedPayload = z
  .object({
    contractId: id,
    tenderId: id,
    projectId: id,
    /** The employer — the tender's owner and the tenant of the contract. */
    organizationId: id,
    contractorOrganizationId: id,
    winningBidId: id,
    employerSignedAt: instant,
    contractorSignedAt: instant,
    /** When the contract became SIGNED: the later of the two. */
    signedAt: instant,
  })
  .strict();

/**
 * The employer cancelled a draft (`DRAFT → CANCELLED`). The **closed reason code** only: the
 * optional free-text note stays in this service's database and is read through the API by
 * the two parties — it is client free text, and the topic is read by every service.
 */
export const contractCancelledPayload = z
  .object({
    contractId: id,
    tenderId: id,
    projectId: id,
    organizationId: id,
    contractorOrganizationId: id,
    reasonCode: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/),
    cancelledAt: instant,
  })
  .strict();

export const CONTRACT_EVENT_SCHEMAS = {
  CONTRACT_DRAFTED: contractDraftedPayload,
  CONTRACT_SIGNATURE_RECORDED: contractSignatureRecordedPayload,
  CONTRACT_SIGNED: contractSignedPayload,
  CONTRACT_CANCELLED: contractCancelledPayload,
} as const satisfies Record<ContractEventName, z.ZodTypeAny>;

export type ContractEventPayload<N extends ContractEventName> = z.infer<
  (typeof CONTRACT_EVENT_SCHEMAS)[N]
>;

/**
 * Validates a payload against its published contract **before** it reaches the
 * outbox, so a malformed event can never be committed. Throwing here rolls back the
 * caller's transaction: a state change nobody can be told about is not made.
 */
export function validateContractPayload<N extends ContractEventName>(
  eventName: N,
  payload: unknown,
): ContractEventPayload<N> {
  const schema = CONTRACT_EVENT_SCHEMAS[eventName];
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new Error(
      `${eventName} payload does not match its published contract: ${parsed.error.message}`,
    );
  }
  return parsed.data as ContractEventPayload<N>;
}
