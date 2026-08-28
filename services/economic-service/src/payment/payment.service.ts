import { Inject, Injectable, Logger } from '@nestjs/common';
import { ulid } from 'ulid';
import { ID_PREFIXES } from '@rasta/contracts';
import { RastaError, getContext, getOrganizationId, runUnscoped } from '@rasta/nest-common';
import { PrismaService } from '../prisma/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { WalletService } from '../wallet/wallet.service';
import { WalletRepository } from '../wallet/wallet.repository';
import { assertSufficient, balancesFrom } from '../wallet/balances';
import { ECONOMIC_EVENTS } from '../events/events';
import { formatMinor, parseMinor } from '../shared/money';
import {
  financialTransactionDuration,
  paymentIntentsTotal,
  transactionsCreatedTotal,
} from '../observability/metrics';
import { PAYMENT_PROVIDER } from '../tokens';
import { SERVICE_NAME } from '../config/env';
import type { PaymentProvider } from './provider';
import type { TopUpDto } from './dto';

/**
 * Payments — the boundary between this platform and money it does not hold
 * (ADR-024, docs/10 § 10.6).
 *
 * **Nothing here moves real money.** The provider is `MockPaymentProvider`;
 * there is no bank, no PSP and no custody of funds. Every intent this service
 * writes carries `simulated = true`, every event it publishes says so on the
 * wire, and every API response repeats it. That is a requirement, not a
 * courtesy: ADR-024 forbids any claim of a bank connection "در کد، UI، مستند،
 * Demo یا ارائه", and a response that looks like a real payment is such a
 * claim.
 *
 * ## The lifecycle, and why the ledger only moves at the end
 *
 * ```
 *   CREATED ──authorize──► AUTHORIZED ──capture──► CAPTURED
 *      │                        │                     │
 *      └──────────► FAILED ◄────┘                     └──refund──► REFUNDED
 * ```
 *
 * The wallet is credited **only on capture**, in the same database transaction
 * that records the capture. An authorisation is a promise from a provider, not
 * money; crediting on authorise would put value in a wallet that a failed
 * capture then has to claw back — the compensating movement this platform
 * deliberately does not do (docs/08 § 8.6).
 */
@Injectable()
export class PaymentService {
  private readonly logger = new Logger(PaymentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly wallets: WalletService,
    private readonly walletRepository: WalletRepository,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
  ) {}

  /**
   * What the running service will tell anyone who asks.
   *
   * Exposed through the API rather than kept internal, because "is this real
   * money?" must be answerable by a UI, an operator and a demo audience
   * without reading configuration (ADR-024).
   */
  describeProvider() {
    return {
      provider: this.provider.name,
      simulated: this.provider.simulated,
      notice: this.provider.simulated
        ? 'Simulated payment provider. No bank connection, no real funds, no custody of money.'
        : 'Live payment provider.',
    };
  }

  /**
   * Tops a wallet up through the provider.
   *
   * The idempotency key is required and is passed to the provider as well as
   * stored, so a retry is deduplicated on both sides of the boundary
   * (docs/06 § 6.8).
   *
   * The provider calls happen **outside** the database transaction, and
   * deliberately: an external call inside a transaction holds row locks for
   * the duration of somebody else's network, and a provider that hangs would
   * take the wallet with it. The write that follows is short and atomic.
   */
  async topUp(walletId: string, dto: TopUpDto): Promise<TopUpResult> {
    const organizationId = getOrganizationId();
    const actor = getContext().userId ?? SERVICE_NAME;
    const amountMinor = parseMinor(dto.amountMinor, 'amountMinor');

    const wallet = await this.wallets.getById(walletId);
    if (wallet.organizationId !== organizationId) {
      throw RastaError.notFound('Wallet', walletId);
    }
    if (wallet.status !== 'ACTIVE') {
      throw RastaError.businessRule('This wallet cannot be topped up', { walletId });
    }

    const intentId = `${ID_PREFIXES.payment}_${ulid()}`;
    await this.prisma.client.paymentIntent.create({
      data: {
        id: intentId,
        organizationId,
        walletId,
        provider: this.provider.name,
        simulated: this.provider.simulated,
        amountMinor,
        currency: wallet.currency,
        status: 'CREATED',
        idempotencyKey: dto.idempotencyKey,
        correlationId: getContext().correlationId,
        createdBy: actor,
      },
    });

    const authorization = await this.provider.authorize({
      paymentIntentId: intentId,
      organizationId,
      amountMinor,
      currency: wallet.currency,
      idempotencyKey: dto.idempotencyKey,
      instrument: dto.instrument,
    });

    if (authorization.outcome === 'FAILED') {
      return this.fail(
        intentId,
        organizationId,
        amountMinor,
        wallet.currency,
        authorization.failureCode ?? 'PROVIDER_DECLINED',
      );
    }

    const authorizedAt = new Date();
    await this.prisma.client.paymentIntent.update({
      where: { id: intentId },
      data: {
        status: 'AUTHORIZED',
        authorizedAt,
        providerReference: authorization.providerReference,
      },
    });

    await this.prisma.transaction((tx) =>
      this.ledger.enqueue(tx, {
        eventName: ECONOMIC_EVENTS.PAYMENT_AUTHORIZED,
        aggregateId: intentId,
        organizationId,
        payload: {
          paymentIntentId: intentId,
          organizationId,
          walletId,
          amountMinor: formatMinor(amountMinor),
          currency: wallet.currency,
          provider: this.provider.name,
          simulated: this.provider.simulated,
          authorizedAt: authorizedAt.toISOString(),
        },
      }),
    );

    paymentIntentsTotal.inc({
      service: SERVICE_NAME,
      provider: this.provider.name,
      simulated: String(this.provider.simulated),
      outcome: 'AUTHORIZED',
    });

    const capture = await this.provider.capture({
      paymentIntentId: intentId,
      providerReference: dto.instrument ?? authorization.providerReference,
      amountMinor,
      currency: wallet.currency,
      idempotencyKey: dto.idempotencyKey,
    });

    if (capture.outcome === 'FAILED') {
      return this.fail(
        intentId,
        organizationId,
        amountMinor,
        wallet.currency,
        capture.failureCode ?? 'CAPTURE_DECLINED',
      );
    }

    return this.completeCapture(
      intentId,
      walletId,
      organizationId,
      amountMinor,
      wallet.currency,
      actor,
    );
  }

  /**
   * Records a successful capture: the transaction, the journal, the balance
   * and the event, in one transaction.
   *
   * The `WALLET_TOP_UP` transaction row is written directly in `SETTLED`
   * rather than walked through the lifecycle. The money genuinely arrived and
   * there is no counterparty and nothing pending, so a state walk would be
   * theatre — and every intermediate state would be a state the row was never
   * really in.
   */
  private async completeCapture(
    intentId: string,
    walletId: string,
    organizationId: string,
    amountMinor: bigint,
    currency: string,
    actor: string,
  ): Promise<TopUpResult> {
    const stop = financialTransactionDuration.startTimer({
      service: SERVICE_NAME,
      operation: 'top-up',
    });

    try {
      const result = await this.prisma.transaction(async (tx) => {
        const [locked] = await this.walletRepository.lock(tx, [walletId]);
        if (!locked) throw RastaError.internal('Wallet vanished while locking it');

        const capturedAt = new Date();
        const transactionId = `${ID_PREFIXES.transaction}_${ulid()}`;

        await runUnscoped('a top-up transaction has no counterparty organization', () =>
          tx.transaction.create({
            data: {
              id: transactionId,
              organizationId,
              counterpartyOrganizationId: null,
              transactionType: 'WALLET_TOP_UP',
              status: 'SETTLED',
              grossAmountMinor: amountMinor,
              commissionAmountMinor: 0n,
              netAmountMinor: amountMinor,
              currency,
              occurredAt: capturedAt,
              settledAt: capturedAt,
              sourceType: 'PAYMENT_INTENT',
              sourceReference: intentId,
              correlationId: getContext().correlationId,
              createdBy: actor,
            },
          }),
        );

        const credited = await this.wallets.credit(tx, {
          wallet: locked,
          amountMinor,
          counterpartPurpose: 'PAYMENT_CLEARING',
          journalType: 'WALLET_TOP_UP',
          description: `Top-up ${intentId}`,
          transactionId,
          postedBy: actor,
        });

        await tx.paymentIntent.update({
          where: { id: intentId },
          data: { status: 'CAPTURED', capturedAt, transactionId },
        });

        await this.ledger.enqueue(tx, {
          eventName: ECONOMIC_EVENTS.PAYMENT_COMPLETED,
          aggregateId: intentId,
          organizationId,
          payload: {
            paymentIntentId: intentId,
            organizationId,
            walletId,
            transactionId,
            journalId: credited.journalId,
            amountMinor: formatMinor(amountMinor),
            currency,
            provider: this.provider.name,
            simulated: this.provider.simulated,
            completedAt: capturedAt.toISOString(),
          },
        });

        return {
          paymentIntentId: intentId,
          transactionId,
          journalId: credited.journalId,
          status: 'CAPTURED' as const,
          amountMinor,
          currency,
          balances: credited.balances,
          provider: this.provider.name,
          simulated: this.provider.simulated,
        };
      });

      transactionsCreatedTotal.inc({
        service: SERVICE_NAME,
        type: 'WALLET_TOP_UP',
        source: 'api',
      });
      paymentIntentsTotal.inc({
        service: SERVICE_NAME,
        provider: this.provider.name,
        simulated: String(this.provider.simulated),
        outcome: 'CAPTURED',
      });

      return result;
    } finally {
      stop();
    }
  }

  /**
   * Records a provider failure.
   *
   * No ledger movement at all: nothing arrived, so there is nothing to
   * balance. `PAYMENT_FAILED` carries a failure *code* rather than the
   * provider's message, because the message may contain an instrument
   * reference and this payload is retained in a log every service can read
   * (AGENTS.md S-09).
   */
  private async fail(
    intentId: string,
    organizationId: string,
    amountMinor: bigint,
    currency: string,
    reason: string,
  ): Promise<TopUpResult> {
    const failedAt = new Date();

    await this.prisma.transaction(async (tx) => {
      await tx.paymentIntent.update({
        where: { id: intentId },
        data: { status: 'FAILED', failedAt, failureReason: reason },
      });

      await this.ledger.enqueue(tx, {
        eventName: ECONOMIC_EVENTS.PAYMENT_FAILED,
        aggregateId: intentId,
        organizationId,
        payload: {
          paymentIntentId: intentId,
          organizationId,
          amountMinor: formatMinor(amountMinor),
          currency,
          provider: this.provider.name,
          simulated: this.provider.simulated,
          reason,
          failedAt: failedAt.toISOString(),
        },
      });
    });

    paymentIntentsTotal.inc({
      service: SERVICE_NAME,
      provider: this.provider.name,
      simulated: String(this.provider.simulated),
      outcome: 'FAILED',
    });

    this.logger.warn(`Payment intent ${intentId} failed: ${reason}`);

    return {
      paymentIntentId: intentId,
      transactionId: null,
      journalId: null,
      status: 'FAILED',
      amountMinor,
      currency,
      balances: null,
      provider: this.provider.name,
      simulated: this.provider.simulated,
      failureReason: reason,
    };
  }

  /**
   * Refunds a captured top-up.
   *
   * Posts a **reversal** of the top-up journal, which is the one correction
   * mechanism this ledger has (AGENTS.md A-06): the entries are mirrored, the
   * history is untouched, and the wallet returns to exactly the balance it had
   * before. The `WALLET_TOP_UP` transaction stays `SETTLED` — it really did
   * happen — and the ledger shows both the top-up and its reversal, which is
   * what an auditor needs to see.
   *
   * Refused when the money has since been spent. Allowing it would drive the
   * wallet negative, which `ck_wallet_balances` refuses anyway; checking here
   * turns a constraint violation into `INSUFFICIENT_BALANCE`.
   */
  async refund(intentId: string, reason: string): Promise<RefundResultView> {
    const organizationId = getOrganizationId();
    const actor = getContext().userId ?? SERVICE_NAME;

    const intent = await this.prisma.client.paymentIntent.findUnique({ where: { id: intentId } });
    if (!intent || intent.organizationId !== organizationId) {
      throw RastaError.notFound('PaymentIntent', intentId);
    }
    if (intent.status !== 'CAPTURED') {
      throw RastaError.invalidStateTransition('PaymentIntent', intent.status, 'REFUNDED');
    }

    const providerResult = await this.provider.refund({
      paymentIntentId: intentId,
      providerReference: intent.providerReference ?? intentId,
      amountMinor: intent.amountMinor,
      currency: intent.currency,
      idempotencyKey: `${intent.idempotencyKey}:refund`,
      reason,
    });

    if (providerResult.outcome === 'FAILED') {
      throw RastaError.businessRule('The payment provider refused the refund', {
        intentId,
        code: providerResult.failureCode,
      });
    }

    return this.prisma.transaction(async (tx) => {
      const [locked] = await this.walletRepository.lock(tx, [intent.walletId]);
      if (!locked) throw RastaError.internal('Wallet vanished while locking it');

      assertSufficient(
        locked.id,
        balancesFrom(locked.availableBalanceMinor, locked.pendingBalanceMinor),
        intent.amountMinor,
      );

      const topUpJournal = await runUnscoped(
        'the top-up journal is found by the transaction it funded',
        () =>
          tx.journal.findFirst({
            where: { transactionId: intent.transactionId ?? '', journalType: 'WALLET_TOP_UP' },
            select: { id: true },
          }),
      );
      if (!topUpJournal) {
        throw RastaError.internal('The top-up journal for this payment could not be found');
      }

      const reversal = await this.ledger.reverse(
        tx,
        topUpJournal.id,
        `Refund of payment ${intentId}: ${reason}`,
        actor,
      );

      const balances = await this.walletRepository.recomputeFromLedger(tx, locked);

      const refundedAt = new Date();
      await tx.paymentIntent.update({
        where: { id: intentId },
        data: { status: 'REFUNDED', refundedAt },
      });

      paymentIntentsTotal.inc({
        service: SERVICE_NAME,
        provider: this.provider.name,
        simulated: String(this.provider.simulated),
        outcome: 'REFUNDED',
      });

      return {
        paymentIntentId: intentId,
        reversalJournalId: reversal.id,
        amountMinor: intent.amountMinor,
        currency: intent.currency,
        balances,
        provider: this.provider.name,
        simulated: this.provider.simulated,
        refundedAt,
      };
    });
  }

  async get(intentId: string) {
    const intent = await this.prisma.client.paymentIntent.findUnique({ where: { id: intentId } });
    if (!intent) throw RastaError.notFound('PaymentIntent', intentId);
    return intent;
  }

  list(limit: number, cursor?: string) {
    return this.prisma.client.paymentIntent.findMany({
      where: { organizationId: getOrganizationId() },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
  }
}

export interface TopUpResult {
  paymentIntentId: string;
  transactionId: string | null;
  journalId: string | null;
  status: 'CAPTURED' | 'FAILED';
  amountMinor: bigint;
  currency: string;
  balances: {
    ledgerBalanceMinor: bigint;
    pendingBalanceMinor: bigint;
    availableBalanceMinor: bigint;
  } | null;
  provider: string;
  simulated: boolean;
  failureReason?: string;
}

export interface RefundResultView {
  paymentIntentId: string;
  reversalJournalId: string;
  amountMinor: bigint;
  currency: string;
  balances: {
    ledgerBalanceMinor: bigint;
    pendingBalanceMinor: bigint;
    availableBalanceMinor: bigint;
  };
  provider: string;
  simulated: boolean;
  refundedAt: Date;
}
