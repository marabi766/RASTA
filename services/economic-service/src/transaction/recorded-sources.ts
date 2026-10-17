/**
 * Source types economic-service records itself, from the owner's own record —
 * never from a caller's word.
 *
 * `(organizationId, sourceType, sourceReference)` is unique
 * (`ux_transaction_source_fact`), and each recorder below finds an existing
 * row under its key before it writes. So a row written first under one of
 * these keys by anyone else would hold that key: the owner's real fact would
 * then find it — with the writer's amount and payee — and record nothing, or
 * fail on it for good. `POST /v1/transactions` lets its caller choose
 * `sourceType` freely, which made that pre-emption open to any organization
 * administrator of the payer and to every service allowed on the route.
 *
 * One rule closes it: no caller of `POST /v1/transactions` — person or
 * service — may claim any of these types (400 `VALIDATION_FAILED` on
 * `sourceType`, `createTransactionSchema`). Each type has exactly one writer,
 * named below, and none of them goes through that route. The database holds
 * the same line for `MAINTENANCE_REQUEST` and `PAYMENT_INTENT`
 * (`ck_transaction_recorded_source`, migration
 * `20261017130000_transaction_recorded_source`) and, with its consumer, for
 * `STATEMENT` (`ck_transaction_statement_obligation`).
 *
 * A source type an owner records by calling the route itself (`ORDER`,
 * marketplace-service) is not one of these: there the caller is the owner.
 */
export const ECONOMIC_RECORDED_SOURCE_TYPES = {
  /**
   * An approved repair (ADR-032). Written by `SettlementAuthorityConsumer`
   * from `MAINTENANCE_APPROVED`, with every figure read from
   * maintenance-service (ADR-061 § 4).
   */
  MAINTENANCE_REQUEST: 'MAINTENANCE_REQUEST',
  /**
   * A captured payment intent's `WALLET_TOP_UP`, written by
   * `PaymentService` in the transaction that credits the wallet. A row held
   * under the intent's id first would make every capture of it fail on the
   * unique key, and its reconciliation report the intent as disagreeing with
   * its top-up.
   */
  PAYMENT_INTENT: 'PAYMENT_INTENT',
  /**
   * An approved contract statement (ADR-068 § 6 (2)). Written only by the
   * `STATEMENT_APPROVED` consumer, from contract-service's answer (CON-003 PR
   * 6b, which also adds its own database guard). Reserved here already, so no
   * row can claim a statement before that consumer runs.
   */
  STATEMENT: 'STATEMENT',
} as const;

export type EconomicRecordedSourceType =
  (typeof ECONOMIC_RECORDED_SOURCE_TYPES)[keyof typeof ECONOMIC_RECORDED_SOURCE_TYPES];

const RECORDED: ReadonlySet<string> = new Set(Object.values(ECONOMIC_RECORDED_SOURCE_TYPES));

/** Whether only economic-service itself may record a transaction under this source type. */
export function isEconomicRecordedSource(sourceType: string): boolean {
  return RECORDED.has(sourceType);
}

/** The refusal's text: fixed, it never echoes what the caller sent. */
export const RECORDED_SOURCE_REFUSAL = 'This source type is recorded only from its owning service';
