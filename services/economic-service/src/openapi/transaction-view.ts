import type { JsonSchema } from './zod-schema';

/**
 * The transaction a response carries, as `shared/views.ts` writes it.
 *
 * Hand-written, because the view is a TypeScript interface and not a Zod
 * schema, so there is nothing to derive it from. `transaction-view.spec.ts`
 * holds the two together: every property documented here is one the view
 * writes, of the type written here. Not `additionalProperties: false` — a
 * field added to the view before it is documented is an omission, never a
 * broken client.
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
    'When a dispute was last resolved. Older than `disputedAt`: it resolved an earlier dispute.',
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
