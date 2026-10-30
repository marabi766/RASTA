import { InternalHttpClient, withExchangeDeadline } from '@rasta/nest-common';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { InternalTokenService, RastaError } from '@rasta/nest-common';
import { ERROR_CODES, type ApiError, type ErrorCode } from '@rasta/contracts';
import { ENV } from '../tokens';
import { ECONOMIC_SERVICE, SERVICE_NAME, type MarketplaceEnv } from '../config/env';
import { economicCallDuration, economicCallsTotal } from '../observability/metrics';

/**
 * The only way money moves in this service (ADR-040).
 *
 * Every financial effect is a synchronous command to economic-service, sent
 * from a Temporal activity. There is no second path: publishing an `ORDER_*`
 * event **and** calling the API would give one effect two triggers, and one
 * day both would fire.
 *
 * ## Authentication
 *
 * Each call carries an `X-Internal-Token` minted for exactly this target and
 * exactly one organization, with the tenant **inside the signature**
 * (ADR-035). `X-Organization-Id` is deliberately not sent: it would add no
 * authority — the guard only accepts one that agrees with the signed claim —
 * and would add one more way for the two to disagree.
 *
 * Calls do not go through the gateway. The gateway mints `RELAY` tokens and
 * never `SERVICE` ones, precisely so the component exposed to outside traffic
 * cannot forge a service identity (D-007).
 *
 * ## Idempotency
 *
 * Every key is derived from the order id and the operation, never from a
 * timestamp or a random value. A Temporal retry — or a replay after a crash —
 * therefore sends the *same* key, and economic-service returns the original
 * response instead of placing a second hold. A random key would make every
 * retry a fresh financial effect, which is the failure this whole design
 * exists to prevent.
 */

export interface TransactionView {
  id: string;
  organizationId: string;
  counterpartyOrganizationId: string | null;
  transactionType: string;
  status: string;
  grossAmountMinor: string;
  commissionAmountMinor: string;
  netAmountMinor: string;
  currency: string;
  sourceType: string | null;
  sourceReference: string | null;
}

/**
 * What `GET /v1/transactions/{id}` answers with: the transaction as its payer
 * sees it now, with the settlement that closed it, if one did. Only the
 * fields the saga reads.
 */
export interface TransactionDetailView extends TransactionView {
  disputedAt: string | null;
  /**
   * The objection, kept through the resolution. On a transaction resolved
   * before economic-service kept the resolution apart — or by an
   * economic-service older than that — the resolution, written over it.
   */
  disputeReason: string | null;
  /**
   * The resolution, once resolved (docs/23 D-060). Null on a transaction
   * resolved before economic-service kept it apart; absent from an
   * economic-service older than the field.
   */
  disputeResolution?: string | null;
  /**
   * The latest dispute's identity: new each time the transaction is disputed,
   * assigned by economic-service and kept through the resolution. What a
   * resolution names so that it decides that dispute and no other (D-053).
   * Absent from an economic-service older than the field.
   */
  disputeId?: string | null;
  settlement: { id: string; journalId: string; settledAt: string } | null;
  /**
   * When it was authorised for settlement and, if a service did it, which
   * service and under which `Idempotency-Key`. economic-service keeps this for
   * good, unlike the command's stored answer: it is how the saga knows its own
   * authorisation took effect on a transaction disputed since (D-053). Absent
   * from an economic-service older than the field.
   */
  settlementAuthorisation?: {
    authorisedAt: string;
    service: string | null;
    idempotencyKey: string | null;
  } | null;
}

/**
 * What `POST /v1/settlements` answers with.
 *
 * Field names copied from economic-service's controller, not guessed: the id
 * is `settlementId`, not `id`. Guessing it produced an order recorded as
 * COMPLETED with no settlement to reconcile against, which
 * `ck_order_completed_has_settlement` then refused — the constraint doing
 * exactly the job it exists for.
 */
export interface SettlementView {
  settlementId: string;
  transactionId: string;
  journalId: string;
  grossAmountMinor: string;
  commissionAmountMinor: string;
  netAmountMinor: string;
  currency: string;
  /** False when no active commission rule matched, so nothing was charged. */
  commissionRuleMatched: boolean;
  settledAt: string;
}

/** The economic transaction type an order's obligation is recorded as. */
const OBLIGATION_TYPE = 'MARKETPLACE_ORDER';

/** The source type it is recorded under, with the order id as the reference. */
const OBLIGATION_SOURCE_TYPE = 'ORDER';

/** What the saga records an order's obligation with: read from the order alone. */
export interface ObligationTerms {
  orderId: string;
  buyerOrganizationId: string;
  supplierOrganizationId: string;
  totalAmountMinor: bigint;
  currency: string;
}

/**
 * Which of the terms `createObligation` sends `transaction` does not carry,
 * by name; empty when it is exactly the obligation the saga records.
 *
 * Every term, not the key: payer, payee, amount, currency, type, source type
 * and reference. A row under the order's key on other terms is somebody
 * else's — 1 rial to an accomplice, recorded first by the buyer's
 * administrator, was settled as the order's payment (review of #334 round 1,
 * F1). Amounts compare as economic-service writes them, decimal minor units.
 */
export function termsDiffer(terms: ObligationTerms, transaction: TransactionView): string[] {
  const differ: string[] = [];
  if (transaction.organizationId !== terms.buyerOrganizationId) differ.push('payer');
  if (transaction.counterpartyOrganizationId !== terms.supplierOrganizationId) {
    differ.push('payee');
  }
  if (transaction.grossAmountMinor !== terms.totalAmountMinor.toString()) differ.push('amount');
  if (transaction.currency !== terms.currency) differ.push('currency');
  if (transaction.transactionType !== OBLIGATION_TYPE) differ.push('transactionType');
  if (transaction.sourceType !== OBLIGATION_SOURCE_TYPE) differ.push('sourceType');
  if (transaction.sourceReference !== terms.orderId) differ.push('sourceReference');
  return differ;
}

/**
 * What a found obligation's status says about the buyer's money.
 *
 * - `HELD`: in escrow now. The only status that proves it: economic-service
 *   places the hold and moves the obligation to HELD in one transaction, and
 *   every way the money leaves escrow moves it on.
 * - `UNPROVEN`: PENDING_SETTLEMENT or DISPUTED. Reached from HELD with the
 *   hold still in place, but also from CREATED with none (an obligation with
 *   no escrow, ADR-032) — and a status the saga's own creation never leaves
 *   it in, so somebody else moved it.
 * - `RETURNED`: REFUNDED — back with the buyer.
 * - `PAID_OUT`: SETTLED.
 * - `NEVER_HELD`: CREATED, CANCELLED, FAILED.
 *
 * A status this service does not know is `UNPROVEN`, never `HELD`.
 */
export type ObligationFunds = 'HELD' | 'UNPROVEN' | 'RETURNED' | 'PAID_OUT' | 'NEVER_HELD';

export function fundsOf(status: string): ObligationFunds {
  switch (status) {
    case 'HELD':
      return 'HELD';
    case 'REFUNDED':
      return 'RETURNED';
    case 'SETTLED':
      return 'PAID_OUT';
    case 'CREATED':
    case 'CANCELLED':
    case 'FAILED':
      return 'NEVER_HELD';
    default:
      return 'UNPROVEN';
  }
}

/** One page of `GET /v1/transactions`. */
interface TransactionPage {
  items: TransactionView[];
  nextCursor: string | null;
  hasMore: boolean;
}

/** The lookup's page: economic-service's largest. */
const OBLIGATION_LOOKUP_PAGE_SIZE = 100;

/**
 * Pages the lookup reads before it gives up on a complete answer. The exact
 * key has at most one row per payer, so a second page already means
 * economic-service is not answering the question asked.
 */
export const OBLIGATION_LOOKUP_PAGES = 10;

/**
 * The lookup did not reach the end of economic-service's answer. Nothing can
 * be concluded from part of it — not "nothing is held", not "only somebody
 * else's row" — so the saga stops instead (`OBLIGATION_LOOKUP_INCOMPLETE`).
 */
export class ObligationLookupIncomplete extends Error {
  constructor(readonly pagesRead: number) {
    super(
      `economic-service's answer to the obligation lookup did not end within ${pagesRead} page(s)`,
    );
    this.name = 'ObligationLookupIncomplete';
  }
}

/** Keys derived from identity, so a retry is a replay rather than a new act. */
export const idempotencyKeyFor = {
  hold: (orderId: string) => `order:${orderId}:hold`,
  authorise: (orderId: string) => `order:${orderId}:authorise`,
  settle: (orderId: string) => `order:${orderId}:settle`,
  refund: (orderId: string) => `order:${orderId}:refund`,
  cancel: (orderId: string) => `order:${orderId}:cancel`,
  /**
   * Per **dispute**, not per order. An order can be disputed, settled back by
   * an operator, and disputed again (RECEIPT_CONFIRMED -> DISPUTED is legal).
   * With one key per order the second dispute replayed the first one's stored
   * response: economic-service never moved the transaction to DISPUTED, and
   * its own "a disputed transaction never settles" guard was never engaged.
   */
  dispute: (orderId: string, disputeId: string) => `order:${orderId}:dispute:${disputeId}`,
  resolveDispute: (orderId: string, disputeId: string) =>
    `order:${orderId}:resolve-dispute:${disputeId}`,
} as const;

@Injectable()
export class EconomicClient {
  private readonly logger = new Logger(EconomicClient.name);

  constructor(
    @Inject(ENV) private readonly env: MarketplaceEnv,
    private readonly tokens: InternalTokenService,
  ) {}

  /**
   * Creates the obligation and reserves the funds in one call.
   *
   * `holdFunds: true` matters: creating the obligation and holding the money
   * separately leaves a window in which the buyer can spend what they have
   * just committed (`docs/10` § 10.5).
   *
   * The wallet balance is **not** checked first. economic-service refuses the
   * hold itself, and a separate check would be a TOCTOU: between the check and
   * the hold the money can go.
   */
  async createObligation(
    input: ObligationTerms & { correlationId: string },
  ): Promise<TransactionView> {
    return this.call<TransactionView>('createObligation', {
      method: 'POST',
      path: '/v1/transactions',
      organizationId: input.buyerOrganizationId,
      idempotencyKey: idempotencyKeyFor.hold(input.orderId),
      correlationId: input.correlationId,
      body: {
        transactionType: OBLIGATION_TYPE,
        counterpartyOrganizationId: input.supplierOrganizationId,
        grossAmountMinor: input.totalAmountMinor.toString(),
        currency: input.currency,
        sourceType: OBLIGATION_SOURCE_TYPE,
        sourceReference: input.orderId,
        holdFunds: true,
      },
    });
  }

  /**
   * Every transaction economic-service holds for the buyer under the order's
   * source key — `ORDER/<order id>` — as an order's obligation type.
   *
   * The saga's answer to "did the hold happen?" when `createObligation` ended
   * without a definite reply. A timeout, an exhausted retry or a lost response
   * says nothing about whether economic-service committed the hold, and
   * treating any of them as "nothing moved" failed the order while the
   * buyer's money stayed held. economic-service keeps at most one obligation
   * per payer and source fact (`ux_transaction_source_fact`), so this read is
   * a complete answer, not a best guess.
   *
   * The exact key, not the reference alone: rows naming the order under any
   * other source type are not candidates, and are not read. Asked by
   * reference and type only, the list's first page — 25 rows, newest first —
   * was all the saga saw, and 25 newer rows under other source types, which
   * the buyer's administrator may record freely, hid the genuine obligation
   * behind them: the saga stopped on a mismatch with the funds held (review
   * of #334 round 2, F2). Every page is still read, to `OBLIGATION_LOOKUP_PAGES`;
   * an answer that does not end by then is not taken as complete
   * (`ObligationLookupIncomplete`).
   *
   * Every candidate, not the first: a row under the order's key is not the
   * order's obligation because of the key. Which one is — if any — is decided
   * on its terms (`termsDiffer`) and its status (`fundsOf`), by the caller
   * that knows them.
   */
  async findObligations(input: {
    orderId: string;
    buyerOrganizationId: string;
    correlationId: string;
  }): Promise<TransactionView[]> {
    const found: TransactionView[] = [];
    let cursor: string | null = null;
    for (let page = 1; ; page += 1) {
      const query = new URLSearchParams({
        transactionType: OBLIGATION_TYPE,
        sourceType: OBLIGATION_SOURCE_TYPE,
        sourceReference: input.orderId,
        limit: String(OBLIGATION_LOOKUP_PAGE_SIZE),
        ...(cursor === null ? {} : { cursor }),
      });
      const answer: TransactionPage = await this.call<TransactionPage>('findObligation', {
        method: 'GET',
        path: `/v1/transactions?${query.toString()}`,
        organizationId: input.buyerOrganizationId,
        correlationId: input.correlationId,
      });
      found.push(
        ...answer.items.filter(
          (item) =>
            item.sourceType === OBLIGATION_SOURCE_TYPE &&
            item.sourceReference === input.orderId &&
            item.transactionType === OBLIGATION_TYPE,
        ),
      );
      if (!answer.hasMore) return found;
      if (page === OBLIGATION_LOOKUP_PAGES || !answer.nextCursor) {
        throw new ObligationLookupIncomplete(page);
      }
      cursor = answer.nextCursor;
    }
  }

  /**
   * The order's obligation as economic-service has it now, or null if
   * `transactionId` is not this order's obligation.
   *
   * The saga's answer to "did my command already happen?" when a retry is
   * refused for the transaction's state (D-053). economic-service replays a
   * command's stored answer only for `ECONOMIC_IDEMPOTENCY_TTL_HOURS`; a retry
   * after that is judged against the state the first attempt produced and
   * refused. Read as the payer, with the same service token as the command;
   * checked against the order and the obligation type, so a transaction that
   * is somebody else's — or another order's — can never prove anything.
   */
  async readObligation(input: {
    orderId: string;
    transactionId: string;
    buyerOrganizationId: string;
    correlationId: string;
  }): Promise<TransactionDetailView | null> {
    const transaction = await this.call<TransactionDetailView>('readObligation', {
      method: 'GET',
      path: `/v1/transactions/${input.transactionId}`,
      organizationId: input.buyerOrganizationId,
      correlationId: input.correlationId,
    });
    const ours =
      transaction.id === input.transactionId &&
      transaction.organizationId === input.buyerOrganizationId &&
      transaction.sourceReference === input.orderId &&
      transaction.transactionType === OBLIGATION_TYPE;
    return ours ? transaction : null;
  }

  /** Marks the obligation ready to settle. Only reachable after receipt. */
  async authoriseSettlement(input: {
    orderId: string;
    transactionId: string;
    buyerOrganizationId: string;
    correlationId: string;
  }): Promise<TransactionView> {
    return this.call<TransactionView>('authoriseSettlement', {
      method: 'POST',
      path: `/v1/transactions/${input.transactionId}/authorise-settlement`,
      organizationId: input.buyerOrganizationId,
      idempotencyKey: idempotencyKeyFor.authorise(input.orderId),
      correlationId: input.correlationId,
    });
  }

  /** Moves the money and applies commission, in economic-service's own transaction. */
  async settle(input: {
    orderId: string;
    transactionId: string;
    buyerOrganizationId: string;
    correlationId: string;
  }): Promise<SettlementView> {
    return this.call<SettlementView>('settle', {
      method: 'POST',
      path: '/v1/settlements',
      organizationId: input.buyerOrganizationId,
      idempotencyKey: idempotencyKeyFor.settle(input.orderId),
      correlationId: input.correlationId,
      body: { transactionId: input.transactionId },
    });
  }

  /** Returns held funds to the payer. The compensation for a cancellation. */
  async refund(input: {
    orderId: string;
    transactionId: string;
    buyerOrganizationId: string;
    reason: string;
    correlationId: string;
  }): Promise<TransactionView> {
    return this.call<TransactionView>('refund', {
      method: 'POST',
      path: `/v1/transactions/${input.transactionId}/refund`,
      organizationId: input.buyerOrganizationId,
      idempotencyKey: idempotencyKeyFor.refund(input.orderId),
      correlationId: input.correlationId,
      body: { reason: input.reason },
    });
  }

  /** Closes an obligation nothing has moved against. */
  async cancel(input: {
    orderId: string;
    transactionId: string;
    buyerOrganizationId: string;
    reason: string;
    correlationId: string;
  }): Promise<TransactionView> {
    return this.call<TransactionView>('cancel', {
      method: 'POST',
      path: `/v1/transactions/${input.transactionId}/cancel`,
      organizationId: input.buyerOrganizationId,
      idempotencyKey: idempotencyKeyFor.cancel(input.orderId),
      correlationId: input.correlationId,
      body: { reason: input.reason },
    });
  }

  /**
   * Stops settlement on the economic side too.
   *
   * Both sides are needed: if only marketplace knew, a direct command to
   * economic-service could still settle; if only economic knew, the order
   * would not be able to say why it is stuck (ADR-040 § 5).
   */
  async dispute(input: {
    orderId: string;
    /** The dispute being mirrored. Part of the idempotency key. */
    disputeId: string;
    transactionId: string;
    buyerOrganizationId: string;
    reason: string;
    correlationId: string;
  }): Promise<TransactionDetailView> {
    return this.call<TransactionDetailView>('dispute', {
      method: 'POST',
      path: `/v1/transactions/${input.transactionId}/dispute`,
      organizationId: input.buyerOrganizationId,
      idempotencyKey: idempotencyKeyFor.dispute(input.orderId, input.disputeId),
      correlationId: input.correlationId,
      body: { reason: input.reason },
    });
  }

  /**
   * Mirrors a dispute resolution back onto the transaction.
   *
   * Without it a dispute decided in the supplier's favour could never settle:
   * economic-service refuses to settle a DISPUTED transaction, and only this
   * call reopens it. The decision itself was made by a platform operator —
   * `assertDisputeResolver` required that before the saga ever got here.
   *
   * With `economicDisputeId`, economic-service applies it only while the
   * transaction still holds that dispute, and refuses it
   * `INVALID_STATE_TRANSITION` otherwise: the operator decided that one, not
   * whichever economic-service holds now (Codex on #318 round 2, N1).
   */
  async resolveDispute(input: {
    orderId: string;
    /** The dispute being resolved. Part of the idempotency key. */
    disputeId: string;
    /** economic-service's identity of the same dispute, when the saga has it. */
    economicDisputeId?: string;
    transactionId: string;
    buyerOrganizationId: string;
    resolution: string;
    correlationId: string;
  }): Promise<TransactionView> {
    return this.call<TransactionView>('resolveDispute', {
      method: 'POST',
      path: `/v1/transactions/${input.transactionId}/resolve-dispute`,
      organizationId: input.buyerOrganizationId,
      idempotencyKey: idempotencyKeyFor.resolveDispute(input.orderId, input.disputeId),
      correlationId: input.correlationId,
      body: {
        resolution: input.resolution,
        ...(input.economicDisputeId === undefined ? {} : { disputeId: input.economicDisputeId }),
      },
    });
  }

  // -------------------------------------------------------------------------

  private async call<T>(
    operation: string,
    request: {
      method: 'POST' | 'GET';
      path: string;
      organizationId: string;
      idempotencyKey?: string;
      correlationId: string;
      body?: unknown;
    },
  ): Promise<T> {
    const sender = await new InternalHttpClient(this.tokens).authorize({
      from: SERVICE_NAME,
      to: ECONOMIC_SERVICE,
      purpose: 'SERVICE',
      organizationId: request.organizationId,
    });

    const url = `${this.env.ECONOMIC_SERVICE_URL}${request.path}`;
    const stop = economicCallDuration.startTimer({ service: SERVICE_NAME, operation });

    // One deadline for the whole exchange, body included: a 200 whose body then
    // stalls is as unresolved as one that never answered, and the activity must
    // not hang on it. The request is not sent again here; whoever retries sends
    // the same idempotency key (derived from the order), so a write that did
    // commit replays instead of being applied twice.
    let received: { ok: boolean; status: number; text: string };
    try {
      received = await withExchangeDeadline(
        this.env.ECONOMIC_REQUEST_TIMEOUT_MS,
        async (signal) => {
          const response = await sender.send(url, {
            method: request.method,
            headers: {
              'content-type': 'application/json',
              'x-correlation-id': request.correlationId,
              ...(request.idempotencyKey ? { 'idempotency-key': request.idempotencyKey } : {}),
            },
            ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
            signal,
          });
          return { ok: response.ok, status: response.status, text: await response.text() };
        },
      );
    } catch (error) {
      stop();
      economicCallsTotal.inc({ service: SERVICE_NAME, operation, outcome: 'UNREACHABLE' });
      // No detail from the error in the message: it can carry a URL with a
      // token in it depending on the runtime (S-09). The activity is retried
      // by Temporal, so what matters is that it failed, not how.
      this.logger.error({ operation, err: error }, 'economic-service could not be reached');
      throw RastaError.upstreamUnavailable(ECONOMIC_SERVICE);
    }

    stop();

    const { ok, text, status } = received;
    const parsed: unknown = text ? JSON.parse(text) : undefined;

    if (ok) {
      economicCallsTotal.inc({ service: SERVICE_NAME, operation, outcome: 'OK' });
      return parsed as T;
    }

    economicCallsTotal.inc({ service: SERVICE_NAME, operation, outcome: 'REFUSED' });

    // Re-raise economic-service's own platform error code rather than a
    // generic one, so "insufficient balance" reaches the buyer as that and not
    // as an internal error. The message is theirs; the status follows from the
    // code, which is how every other refusal on the platform behaves.
    //
    // The body is the platform's `ApiError`, `code` and `message` at its top
    // level, as the shared exception filter writes it. This used to read
    // `error.code`, a shape no service sends: every refusal became
    // UPSTREAM_UNAVAILABLE, and a retry refused for the transaction's state
    // never reached the obligation read that answers it (D-053, review of
    // #287).
    const body = parsed as Partial<Pick<ApiError, 'code' | 'message'>> | undefined;
    const reported = body?.code;
    const code: ErrorCode =
      reported && reported in ERROR_CODES
        ? (reported as ErrorCode)
        : ERROR_CODES.UPSTREAM_UNAVAILABLE;
    const message = body?.message ?? 'The financial service refused this operation';

    throw new RastaError(code, message, {
      internalContext: { operation, status },
    });
  }
}
