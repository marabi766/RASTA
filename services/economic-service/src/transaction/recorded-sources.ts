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
 * A source type its owner records by calling the route itself (`ORDER`,
 * marketplace-service) is not one of these: there the caller is the owner,
 * and `OWNER_RECORDED_SOURCE_TYPES` below reserves it to that caller.
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
   * `STATEMENT_APPROVED` consumer (`StatementSettlementConsumer`), from
   * contract-service's answer; its database guard is
   * `ck_transaction_statement_obligation`.
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

/**
 * Source types their owning service records through `POST /v1/transactions`
 * itself, each with the one transaction type it is recorded as.
 *
 * The same pre-emption, from the other side. marketplace-service's order saga
 * records an order's obligation as `ORDER/<order id>`, and when that call
 * ends without a definite answer — a 409 for the key included — it looks the
 * obligation up and carries on with what it finds. While an order was still
 * PENDING, the buyer's administrator could record `ORDER/<order id>` first, 1
 * rial to an accomplice: the saga's own creation got 409, and the saga then
 * authorised and settled the administrator's row as the order's payment
 * (review of #334 round 1, F1).
 *
 * So `ORDER` is recorded only by marketplace-service, signed as itself
 * (`callerService`, inside the internal token's signature), and only as
 * `MARKETPLACE_ORDER`. Everyone else — every person, every other service —
 * gets the same 400 as for the types above. The database holds the person
 * half of the line (`ck_transaction_order_source`: a person's row names the
 * person in `created_by`, a service's names economic-service); which service
 * signed is known only here. marketplace-service, for its part, adopts a
 * found obligation only on exactly the terms it would have recorded.
 */
export const OWNER_RECORDED_SOURCE_TYPES: Readonly<
  Record<string, { readonly service: string; readonly transactionType: string }>
> = {
  ORDER: { service: 'marketplace-service', transactionType: 'MARKETPLACE_ORDER' },
};

/**
 * Whether this caller may record a transaction of `transactionType` under
 * `sourceType`: false for a type economic-service records itself, and for an
 * owner's type unless the caller is that owner — a service, signed as it —
 * recording it as the owner's transaction type.
 */
export function mayRecordSource(
  caller: { authType?: string; callerService?: string },
  sourceType: string | undefined,
  transactionType: string,
): boolean {
  if (sourceType === undefined) return true;
  if (isEconomicRecordedSource(sourceType)) return false;
  if (!Object.hasOwn(OWNER_RECORDED_SOURCE_TYPES, sourceType)) return true;
  const owner = OWNER_RECORDED_SOURCE_TYPES[sourceType]!;
  return (
    caller.authType === 'SERVICE' &&
    caller.callerService === owner.service &&
    transactionType === owner.transactionType
  );
}
