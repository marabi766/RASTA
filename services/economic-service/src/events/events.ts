import { z } from 'zod';

/**
 * Events published by economic-service, on `rasta.economic.v1`.
 *
 * The names come from the platform catalogue (docs/events/README.md § Economic
 * and docs/07 § 7.5) rather than being coined here. Every one of them is in
 * `NEVER_AUTO_REPLAY` in `@rasta/contracts`, which is not decoration: replaying
 * a settlement out of a dead-letter topic without first establishing what
 * actually happened to the money is a larger risk than the original failure
 * (docs/runbooks/replay-dlq.md).
 *
 * ## Money on these events
 *
 * Amounts are **strings in minor units** beside an explicit `currency`, never
 * JSON numbers — a rial figure past `Number.MAX_SAFE_INTEGER` does not survive
 * a JSON round trip (ADR-022). Rates are integer basis points.
 *
 * The flat `amountMinor` + `currency` pair is used rather than the nested
 * `{ amountMinor, currency }` object, matching the shape maintenance-service
 * already publishes and asset-service already reads. One representation on the
 * wire is worth more than the tidier of two.
 *
 * ## What these payloads never carry
 *
 * No account numbers, no provider tokens, no personal data. An event lives in
 * a durable log every service reads and retains for seven days (docs/07 §
 * 7.3), and a financial payload sitting there is a liability rather than a
 * convenience (AGENTS.md S-09). Consumers that need detail read it back
 * through the API, under authorization.
 */

export const ECONOMIC_EVENTS = {
  WALLET_OPENED: 'WALLET_OPENED',
  FUNDS_HELD: 'FUNDS_HELD',
  FUNDS_RELEASED: 'FUNDS_RELEASED',
  PAYMENT_AUTHORIZED: 'PAYMENT_AUTHORIZED',
  PAYMENT_COMPLETED: 'PAYMENT_COMPLETED',
  PAYMENT_FAILED: 'PAYMENT_FAILED',
  COMMISSION_APPLIED: 'COMMISSION_APPLIED',
  REWARD_GRANTED: 'REWARD_GRANTED',
  REWARD_LEVEL_CHANGED: 'REWARD_LEVEL_CHANGED',
  SETTLEMENT_COMPLETED: 'SETTLEMENT_COMPLETED',
  JOURNAL_POSTED: 'JOURNAL_POSTED',
  COMMISSION_RULE_CHANGED: 'COMMISSION_RULE_CHANGED',
  REWARD_RULE_CHANGED: 'REWARD_RULE_CHANGED',
  TRANSACTION_STATUS_CHANGED: 'TRANSACTION_STATUS_CHANGED',
} as const;

export type EconomicEventName = (typeof ECONOMIC_EVENTS)[keyof typeof ECONOMIC_EVENTS];

/** A non-negative integer amount in minor units, as a string (ADR-022). */
const amountMinor = z.string().regex(/^\d{1,30}$/);

const currency = z.string().min(3).max(8);

// ---------------------------------------------------------------------------
// Wallet
// ---------------------------------------------------------------------------

/**
 * An organization now has a wallet.
 *
 * notification-service is the catalogue's consumer. Carries no balance,
 * because a newly opened wallet has none and an event that announces "0" would
 * be read by somebody as a balance update.
 */
export const walletOpenedPayload = z.object({
  walletId: z.string(),
  organizationId: z.string(),
  currency,
  openedAt: z.string(),
});

/**
 * Funds moved into escrow against an obligation.
 *
 * The Saga event: marketplace-service advances an order on it. `reference` is
 * the transaction the hold secures, which is how a consumer correlates it back
 * to its own order without this service knowing what an order is.
 */
export const fundsHeldPayload = z.object({
  holdId: z.string(),
  walletId: z.string(),
  organizationId: z.string(),
  transactionId: z.string(),
  reference: z.string(),
  referenceType: z.string(),
  amountMinor,
  currency,
  heldAt: z.string(),
});

/**
 * An escrow hold was resolved.
 *
 * `resolution` distinguishes the two outcomes — `RELEASED` to the payee as
 * part of a settlement, `REFUNDED` back to the payer — because a consumer
 * compensating a cancelled order and a consumer completing a fulfilled one
 * need opposite reactions, and inferring which from the absence of a later
 * event is how a Saga hangs.
 */
export const fundsReleasedPayload = z.object({
  holdId: z.string(),
  walletId: z.string(),
  organizationId: z.string(),
  transactionId: z.string(),
  reference: z.string(),
  amountMinor,
  currency,
  resolution: z.enum(['RELEASED', 'REFUNDED']),
  resolvedAt: z.string(),
});

// ---------------------------------------------------------------------------
// Payment
// ---------------------------------------------------------------------------

/**
 * The provider authorised a payment.
 *
 * `simulated` is on the wire, not only in the database. A consumer, a
 * dashboard or an operator reading the topic must be able to tell that no real
 * money moved without knowing which provider was configured at the time —
 * ADR-024 forbids any claim of a bank connection, and silence is a claim.
 */
export const paymentAuthorizedPayload = z.object({
  paymentIntentId: z.string(),
  organizationId: z.string(),
  walletId: z.string(),
  amountMinor,
  currency,
  provider: z.string(),
  simulated: z.boolean(),
  authorizedAt: z.string(),
});

/** The payment completed and the wallet was credited. */
export const paymentCompletedPayload = z.object({
  paymentIntentId: z.string(),
  organizationId: z.string(),
  walletId: z.string(),
  transactionId: z.string(),
  journalId: z.string(),
  amountMinor,
  currency,
  provider: z.string(),
  simulated: z.boolean(),
  completedAt: z.string(),
});

/**
 * The payment failed.
 *
 * `reason` is a provider-supplied code, never a raw provider message: a
 * message can contain a masked card number or an account reference, and this
 * payload is retained for seven days in a log every service can read
 * (AGENTS.md S-09).
 */
export const paymentFailedPayload = z.object({
  paymentIntentId: z.string(),
  organizationId: z.string(),
  amountMinor,
  currency,
  provider: z.string(),
  simulated: z.boolean(),
  reason: z.string(),
  failedAt: z.string(),
});

// ---------------------------------------------------------------------------
// Commission
// ---------------------------------------------------------------------------

/**
 * Commission was charged on a settled transaction.
 *
 * analytics-service builds platform revenue from this, and audit-service keeps
 * it. `rateBasisPoints` and `ruleId` travel with the amount so the charge is
 * explicable years later, after the rule that produced it has been superseded
 * (docs/10 § 10.7).
 *
 * `ruleId` is nullable and that case is real rather than defensive: with no
 * active rule the commission is zero, and a zero commission with no rule is
 * exactly what ADR-023 requires the platform to record instead of guessing.
 */
export const commissionAppliedPayload = z.object({
  commissionId: z.string(),
  transactionId: z.string(),
  organizationId: z.string(),
  ruleId: z.string().nullable(),
  rateBasisPoints: z.number().int().min(0).max(10_000),
  grossAmountMinor: amountMinor,
  amountMinor,
  currency,
  appliedAt: z.string(),
});

// ---------------------------------------------------------------------------
// Reward
// ---------------------------------------------------------------------------

/**
 * A reward was granted.
 *
 * `monetised` says whether it carried rial value (ADR-033). Without it a
 * consumer would have to infer the answer from `creditAmountMinor === "0"`,
 * which is the same shape as a rule whose rate is configured but rounds to
 * nothing — two different facts that must not look identical.
 */
export const rewardGrantedPayload = z.object({
  rewardId: z.string(),
  organizationId: z.string(),
  userId: z.string(),
  ruleId: z.string(),
  triggerEvent: z.string(),
  sourceReference: z.string(),
  points: z.number().int().positive(),
  creditAmountMinor: amountMinor,
  currency,
  monetised: z.boolean(),
  journalId: z.string().nullable(),
  grantedAt: z.string(),
});

/**
 * A subject crossed a level threshold.
 *
 * `from` is nullable for the first level a subject ever reaches — there is no
 * previous level, and an empty string would be a value that looks like one.
 */
export const rewardLevelChangedPayload = z.object({
  organizationId: z.string(),
  userId: z.string(),
  from: z.string().nullable(),
  to: z.string(),
  totalPoints: z.number().int().nonnegative(),
  changedAt: z.string(),
});

// ---------------------------------------------------------------------------
// Transaction lifecycle
// ---------------------------------------------------------------------------

/** Every status a transaction can hold (the Prisma enum, restated for the wire). */
const transactionStatus = z.enum([
  'CREATED',
  'HELD',
  'PENDING_SETTLEMENT',
  'DISPUTED',
  'SETTLED',
  'REFUNDED',
  'CANCELLED',
  'FAILED',
]);

/**
 * A transaction was recorded, or moved from one status to another, by whom
 * and when (AGENTS.md S-06; economic batch 2, item b).
 *
 * The audit record of every lifecycle step that has no money event of its
 * own: an obligation recorded with or without a hold, a receipt confirmed,
 * a cancellation, a dispute and its resolution, a refund. Settlement keeps
 * `SETTLEMENT_COMPLETED`, which already says who and when. audit-service
 * keeps it (the economic topic is projected into the trail as a whole).
 *
 * `action` is the state-machine event that caused the move, or `CREATE` /
 * `RECORD_AUTHORISED_OBLIGATION` for a transaction that did not exist
 * before, in which case `fromStatus` is null. No free-text reason travels:
 * a dispute reason is whatever a person typed, and this log is retained
 * where every service can read it (S-09). It stays on the row, under
 * authorization.
 */
export const transactionStatusChangedPayload = z
  .object({
    transactionId: z.string(),
    organizationId: z.string(),
    counterpartyOrganizationId: z.string().nullable(),
    transactionType: z.string(),
    action: z.enum([
      'CREATE',
      'RECORD_AUTHORISED_OBLIGATION',
      'AUTHORISE_SETTLEMENT',
      'DISPUTE',
      'RESOLVE_DISPUTE',
      'CANCEL',
      'REFUND',
    ]),
    fromStatus: transactionStatus.nullable(),
    toStatus: transactionStatus,
    grossAmountMinor: amountMinor,
    currency,
    changedBy: z.string(),
    changedAt: z.string(),
  })
  .refine(
    (change) =>
      (change.fromStatus === null) ===
      (change.action === 'CREATE' || change.action === 'RECORD_AUTHORISED_OBLIGATION'),
    'fromStatus is null exactly when the transaction was created',
  );

// ---------------------------------------------------------------------------
// Settlement and ledger
// ---------------------------------------------------------------------------

/**
 * A transaction was settled: escrow released, payee credited, commission
 * recognised — all in one journal (ADR-031).
 *
 * marketplace-service, supplier-service and notification-service are the
 * catalogue's consumers.
 */
export const settlementCompletedPayload = z.object({
  settlementId: z.string(),
  transactionId: z.string(),
  organizationId: z.string(),
  payerOrganizationId: z.string(),
  payeeOrganizationId: z.string(),
  journalId: z.string(),
  grossAmountMinor: amountMinor,
  commissionAmountMinor: amountMinor,
  netAmountMinor: amountMinor,
  currency,
  settledAt: z.string(),
});

/**
 * A journal was posted.
 *
 * audit-service and analytics-service consume it, and between them they are
 * the reason the entries travel with it: an auditor reconstructing the ledger
 * from the event log must see both sides of every movement, or the log proves
 * nothing.
 *
 * It is the one payload here that grows with the size of the journal. Journals
 * in this domain have two or three legs; a bulk import that produced hundreds
 * would need a different shape, and does not exist.
 */
export const journalPostedPayload = z.object({
  journalId: z.string(),
  organizationId: z.string(),
  transactionId: z.string().nullable(),
  journalType: z.string(),
  currency,
  postedAt: z.string(),
  reversesJournalId: z.string().nullable(),
  entries: z
    .array(
      z.object({
        accountId: z.string(),
        organizationId: z.string(),
        direction: z.enum(['DEBIT', 'CREDIT']),
        amountMinor,
        currency,
      }),
    )
    .min(2),
});

// ---------------------------------------------------------------------------
// Governance configuration
// ---------------------------------------------------------------------------

/**
 * Whether a change record is internally consistent: a rule that was just
 * created had nothing before it, and a rule that was updated did.
 */
const changeIsCoherent = (change: { change: 'CREATED' | 'UPDATED'; before: unknown }) =>
  (change.change === 'CREATED') === (change.before === null);

const CHANGE_KINDS = ['CREATED', 'UPDATED'] as const;

/** A commission rule's terms at one moment — the thing an auditor compares. */
const commissionRuleTerms = z.object({
  organizationId: z.string().nullable(),
  transactionType: z.string(),
  rateBasisPoints: z.number().int().min(0).max(10_000),
  minAmountMinor: amountMinor.nullable(),
  maxAmountMinor: amountMinor.nullable(),
  validFrom: z.string(),
  validTo: z.string().nullable(),
  status: z.string(),
  label: z.string().nullable(),
});

/**
 * A commission rule was created or changed, by whom, and from what to what.
 *
 * docs/10 § 10.7 and ADR-023 require every rate change to be recorded with
 * who applied the steering group's decision. `updatedBy` on the row says who
 * touched it last and nothing about what it was before; this event is the
 * record, and audit-service keeps it (the economic topic is projected into
 * the audit trail as a whole).
 *
 * The rate itself never appears as a change: once a rule exists its rate is
 * fixed, and a new rate is a new rule. So an `UPDATED` record shows a rule
 * closed, deactivated or relabelled — never repriced.
 */
export const commissionRuleChangedPayload = z
  .object({
    ruleId: z.string(),
    change: z.enum(CHANGE_KINDS),
    changedBy: z.string(),
    changedAt: z.string(),
    before: commissionRuleTerms.nullable(),
    after: commissionRuleTerms,
  })
  .refine(changeIsCoherent, 'before is null exactly when the rule was created');

/** A reward rule's terms at one moment. */
const rewardRuleTerms = z.object({
  organizationId: z.string().nullable(),
  triggerEvent: z.string(),
  rewardType: z.string(),
  condition: z.record(z.string(), z.unknown()).nullable(),
  points: z.number().int().positive(),
  creditPerPointMinor: amountMinor.nullable(),
  periodCap: z.number().int().positive().nullable(),
  periodType: z.string().nullable(),
  validFrom: z.string(),
  validTo: z.string().nullable(),
  status: z.string(),
  label: z.string().nullable(),
});

/** The reward counterpart of `COMMISSION_RULE_CHANGED`, for the same reason. */
export const rewardRuleChangedPayload = z
  .object({
    ruleId: z.string(),
    change: z.enum(CHANGE_KINDS),
    changedBy: z.string(),
    changedAt: z.string(),
    before: rewardRuleTerms.nullable(),
    after: rewardRuleTerms,
  })
  .refine(changeIsCoherent, 'before is null exactly when the rule was created');

export const ECONOMIC_EVENT_SCHEMAS = {
  [ECONOMIC_EVENTS.WALLET_OPENED]: walletOpenedPayload,
  [ECONOMIC_EVENTS.FUNDS_HELD]: fundsHeldPayload,
  [ECONOMIC_EVENTS.FUNDS_RELEASED]: fundsReleasedPayload,
  [ECONOMIC_EVENTS.PAYMENT_AUTHORIZED]: paymentAuthorizedPayload,
  [ECONOMIC_EVENTS.PAYMENT_COMPLETED]: paymentCompletedPayload,
  [ECONOMIC_EVENTS.PAYMENT_FAILED]: paymentFailedPayload,
  [ECONOMIC_EVENTS.COMMISSION_APPLIED]: commissionAppliedPayload,
  [ECONOMIC_EVENTS.REWARD_GRANTED]: rewardGrantedPayload,
  [ECONOMIC_EVENTS.REWARD_LEVEL_CHANGED]: rewardLevelChangedPayload,
  [ECONOMIC_EVENTS.SETTLEMENT_COMPLETED]: settlementCompletedPayload,
  [ECONOMIC_EVENTS.JOURNAL_POSTED]: journalPostedPayload,
  [ECONOMIC_EVENTS.COMMISSION_RULE_CHANGED]: commissionRuleChangedPayload,
  [ECONOMIC_EVENTS.REWARD_RULE_CHANGED]: rewardRuleChangedPayload,
  [ECONOMIC_EVENTS.TRANSACTION_STATUS_CHANGED]: transactionStatusChangedPayload,
} as const satisfies Record<EconomicEventName, z.ZodTypeAny>;

/**
 * Validates before the payload reaches the outbox.
 *
 * Publish-time validation is what keeps a malformed event out of the log
 * entirely (docs/07 § 7.8). For this domain the alternative is worse than
 * usual: an unreadable `SETTLEMENT_COMPLETED` is a payment that other services
 * never learn about, discovered in someone else's dead-letter topic where it
 * may not be replayed automatically.
 *
 * Returns the parsed payload typed to the event it belongs to, so that
 * whatever reads a field off it afterwards — the partition-key policy, above
 * all — is checked against that event's own schema rather than against
 * `unknown` (ADR-036).
 */
export function validateEconomicPayload<N extends EconomicEventName>(
  eventName: N,
  payload: unknown,
): z.infer<(typeof ECONOMIC_EVENT_SCHEMAS)[N]> {
  // The schema is selected by the same key as the return type; TypeScript
  // cannot correlate the two through a generic parameter, hence the assertion.
  return ECONOMIC_EVENT_SCHEMAS[eventName].parse(payload) as z.infer<
    (typeof ECONOMIC_EVENT_SCHEMAS)[N]
  >;
}
