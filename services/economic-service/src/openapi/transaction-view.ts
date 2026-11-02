import type { JsonSchema } from '@rasta/nest-common';

/**
 * The transaction a response carries, as `shared/views.ts` writes it.
 *
 * Hand-written, because the view is a TypeScript interface and not a Zod
 * schema, so there is nothing to derive it from. `transaction-view.spec.ts`
 * holds the two together: every property documented here is one the view
 * writes, of the type written here, and every property the view writes is
 * documented here. Not `additionalProperties: false` in the document — to a
 * generated client, a field added before it is documented is an omission,
 * never a break; the spec is what refuses the omission.
 */

const text = (description?: string): JsonSchema => ({
  type: 'string',
  ...(description ? { description } : {}),
});
const nullableText = (description?: string): JsonSchema => ({
  ...text(description),
  nullable: true,
});
const instant = (description?: string): JsonSchema => ({
  type: 'string',
  format: 'date-time',
  ...(description ? { description } : {}),
});
const nullableInstant = (description?: string): JsonSchema => ({
  ...instant(description),
  nullable: true,
});
/** Minor units as a decimal string: a JSON number truncates past 2^53 (ADR-022). */
const minor = (description?: string): JsonSchema => ({
  type: 'string',
  pattern: '^-?[0-9]+$',
  ...(description ? { description } : {}),
});

const TRANSACTION_VIEW_PROPERTIES: Record<string, JsonSchema> = {
  id: text(),
  organizationId: text('The payer.'),
  counterpartyOrganizationId: nullableText('The payee; null for a top-up.'),
  transactionType: text(),
  businessLine: nullableText(
    'Why the platform may earn from it (ADR-045); null where none was sent.',
  ),
  status: text(),
  grossAmountMinor: minor(),
  commissionAmountMinor: minor(),
  netAmountMinor: minor(),
  currency: text(),
  occurredAt: instant(),
  sourceType: nullableText(),
  sourceReference: nullableText(),
  disputedAt: nullableInstant('When the latest dispute was raised.'),
  disputedBy: nullableText(
    'Who raised it: the person, or economic-service when a service mirrored it (the order saga).',
  ),
  disputeReason: nullableText(
    'Why it was raised; kept through the resolution. On a transaction resolved before ' +
      '`disputeResolution` existed, the resolution text instead (docs/23 D-060).',
  ),
  disputeResolvedAt: nullableInstant(
    'When a dispute was last resolved — the latest dispute, or an earlier one: ' +
      '`resolvedDisputeId` on the detail view says which.',
  ),
  disputeResolvedBy: nullableText('Who resolved it, as `disputedBy`.'),
  disputeResolution: nullableText(
    'What the resolver decided. Null before a resolution, and on a transaction resolved ' +
      'before this field existed (docs/23 D-060).',
  ),
  settledAt: nullableInstant(),
  failureReason: nullableText(),
  createdAt: instant(),
  createdBy: text(),
};

const objectOf = (properties: Record<string, JsonSchema>): JsonSchema => ({
  type: 'object',
  required: Object.keys(properties),
  properties,
});

export const TRANSACTION_VIEW_SCHEMAS: Record<string, JsonSchema> = {
  TransactionView: objectOf(TRANSACTION_VIEW_PROPERTIES),
  TransactionDetailView: objectOf({
    ...TRANSACTION_VIEW_PROPERTIES,
    settlementAuthorisation: {
      ...objectOf({
        authorisedAt: instant(),
        service: nullableText(
          'The signed calling service when a service authorised it; null for a person.',
        ),
        idempotencyKey: nullableText(
          'That service command’s `Idempotency-Key`, kept for good; null for a person.',
        ),
      }),
      nullable: true,
      description:
        'When it was authorised for settlement and, if by a service, which and under which ' +
        'key — how the order saga proves its own authorisation took effect once the stored ' +
        'answer has expired (docs/23 D-053). Null if never authorised, or recorded already ' +
        'authorised (ADR-032).',
    },
    disputeId: nullableText(
      'The latest dispute’s identity: a new one each time it is disputed, kept through its ' +
        'resolution. Null if never disputed. What `resolve-dispute` names to decide exactly ' +
        'this dispute (docs/23 D-053).',
    ),
    resolvedDisputeId: nullableText(
      'The dispute the recorded resolution decided. Equal to `disputeId`: the latest ' +
        'dispute’s resolution; different: an earlier dispute’s, and the latest has none. Null ' +
        'if never resolved, and where the resolution is not attributed by identity: a ' +
        'transaction resolved before this field existed that could not be attributed for ' +
        'certain, or not yet, and a command’s answer stored before it existed and replayed ' +
        'under its `Idempotency-Key`. There, which dispute it decided is not recorded, and ' +
        'the instants do not establish it either (docs/23 D-060).',
    ),
    legs: {
      type: 'array',
      items: objectOf({
        role: text(),
        organizationId: text(),
        amountMinor: minor(),
        currency: text(),
      }),
    },
    commission: {
      ...objectOf({
        id: text(),
        rateBasisPoints: { type: 'integer' },
        amountMinor: minor(),
        ruleId: nullableText('Null when no rule matched — zero because unconfigured, not free.'),
        outcome: text('`RULE_APPLIED`, or `NO_ACTIVE_RULE` (ADR-045 § 2).'),
      }),
      nullable: true,
    },
    settlement: {
      ...objectOf({ id: text(), journalId: text(), settledAt: instant() }),
      nullable: true,
    },
  }),
  TransactionPage: objectOf({
    items: { type: 'array', items: { $ref: '#/components/schemas/TransactionView' } },
    nextCursor: nullableText(),
    hasMore: { type: 'boolean' },
  }),
};

/** The success body of each transaction route, by component name. */
export const TRANSACTION_RESPONSES: Record<string, string> = {
  'GET /v1/transactions': 'TransactionPage',
  'GET /v1/transactions/{id}': 'TransactionDetailView',
  'POST /v1/transactions': 'TransactionDetailView',
  'POST /v1/transactions/{id}/authorise-settlement': 'TransactionDetailView',
  'POST /v1/transactions/{id}/dispute': 'TransactionDetailView',
  'POST /v1/transactions/{id}/resolve-dispute': 'TransactionDetailView',
  'POST /v1/transactions/{id}/refund': 'TransactionDetailView',
  'POST /v1/transactions/{id}/cancel': 'TransactionDetailView',
};
