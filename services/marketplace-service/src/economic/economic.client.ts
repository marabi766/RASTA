import { Inject, Injectable, Logger } from '@nestjs/common';
import { InternalTokenService, RastaError } from '@rasta/nest-common';
import { ERROR_CODES, type ErrorCode } from '@rasta/contracts';
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
  sourceReference: string | null;
}

export interface SettlementView {
  id: string;
  transactionId: string;
  journalId: string;
  grossAmountMinor: string;
  commissionAmountMinor: string;
  netAmountMinor: string;
  currency: string;
  settledAt: string;
}

/** Keys derived from identity, so a retry is a replay rather than a new act. */
export const idempotencyKeyFor = {
  hold: (orderId: string) => `order:${orderId}:hold`,
  authorise: (orderId: string) => `order:${orderId}:authorise`,
  settle: (orderId: string) => `order:${orderId}:settle`,
  refund: (orderId: string) => `order:${orderId}:refund`,
  cancel: (orderId: string) => `order:${orderId}:cancel`,
  dispute: (orderId: string) => `order:${orderId}:dispute`,
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
  async createObligation(input: {
    orderId: string;
    buyerOrganizationId: string;
    supplierOrganizationId: string;
    totalAmountMinor: bigint;
    currency: string;
    correlationId: string;
  }): Promise<TransactionView> {
    return this.call<TransactionView>('createObligation', {
      method: 'POST',
      path: '/v1/transactions',
      organizationId: input.buyerOrganizationId,
      idempotencyKey: idempotencyKeyFor.hold(input.orderId),
      correlationId: input.correlationId,
      body: {
        transactionType: 'MARKETPLACE_ORDER',
        counterpartyOrganizationId: input.supplierOrganizationId,
        grossAmountMinor: input.totalAmountMinor.toString(),
        currency: input.currency,
        sourceType: 'ORDER',
        sourceReference: input.orderId,
        holdFunds: true,
      },
    });
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
    transactionId: string;
    buyerOrganizationId: string;
    reason: string;
    correlationId: string;
  }): Promise<TransactionView> {
    return this.call<TransactionView>('dispute', {
      method: 'POST',
      path: `/v1/transactions/${input.transactionId}/dispute`,
      organizationId: input.buyerOrganizationId,
      idempotencyKey: idempotencyKeyFor.dispute(input.orderId),
      correlationId: input.correlationId,
      body: { reason: input.reason },
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
    const token = await this.tokens.issue(
      SERVICE_NAME,
      ECONOMIC_SERVICE,
      'SERVICE',
      request.organizationId,
    );

    const url = `${this.env.ECONOMIC_SERVICE_URL}${request.path}`;
    const stop = economicCallDuration.startTimer({ service: SERVICE_NAME, operation });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.env.ECONOMIC_REQUEST_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(url, {
        method: request.method,
        headers: {
          'content-type': 'application/json',
          'x-internal-token': token,
          'x-correlation-id': request.correlationId,
          ...(request.idempotencyKey ? { 'idempotency-key': request.idempotencyKey } : {}),
        },
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
        signal: controller.signal,
      });
    } catch (error) {
      stop();
      economicCallsTotal.inc({ service: SERVICE_NAME, operation, outcome: 'UNREACHABLE' });
      // No detail from the error in the message: it can carry a URL with a
      // token in it depending on the runtime (S-09). The activity is retried
      // by Temporal, so what matters is that it failed, not how.
      this.logger.error({ operation, err: error }, 'economic-service could not be reached');
      throw RastaError.upstreamUnavailable(ECONOMIC_SERVICE);
    } finally {
      clearTimeout(timer);
    }

    stop();

    const text = await response.text();
    const parsed: unknown = text ? JSON.parse(text) : undefined;

    if (response.ok) {
      economicCallsTotal.inc({ service: SERVICE_NAME, operation, outcome: 'OK' });
      return parsed as T;
    }

    economicCallsTotal.inc({ service: SERVICE_NAME, operation, outcome: 'REFUSED' });

    // Re-raise economic-service's own platform error code rather than a
    // generic one, so "insufficient balance" reaches the buyer as that and not
    // as an internal error. The message is theirs; the status follows from the
    // code, which is how every other refusal on the platform behaves.
    const body = parsed as { error?: { code?: string; message?: string } } | undefined;
    const reported = body?.error?.code;
    const code: ErrorCode =
      reported && reported in ERROR_CODES
        ? (reported as ErrorCode)
        : ERROR_CODES.UPSTREAM_UNAVAILABLE;
    const message = body?.error?.message ?? 'The financial service refused this operation';

    throw new RastaError(code, message, {
      internalContext: { operation, status: response.status },
    });
  }
}
