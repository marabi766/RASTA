import { Inject, Injectable, Logger } from '@nestjs/common';
import { ulid } from 'ulid';
import { ID_PREFIXES, MAX_AMOUNT_MINOR } from '@rasta/contracts';
import { RastaError, getContext, getOrganizationId, runUnscoped } from '@rasta/nest-common';
import { PrismaService } from '../prisma/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { WalletService } from '../wallet/wallet.service';
import {
  WALLET_BALANCE_LIMIT,
  WalletRepository,
  isWalletBalanceLimit,
  walletBalanceLimit,
} from '../wallet/wallet.repository';
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
import type { PaymentIntent } from '../generated/prisma';

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

    // A retry with the same key resumes the intent the first attempt left
    // (Codex round 2 on #121, F2). Inserting another collided with the unique
    // key, so a capture left uncredited could never be finished by a retry.
    const existing = await this.prisma.client.paymentIntent.findUnique({
      where: {
        organizationId_idempotencyKey: { organizationId, idempotencyKey: dto.idempotencyKey },
      },
    });
    if (existing) return this.resume(existing, walletId, amountMinor, actor);

    // The balance this top-up would leave is checked before the provider is
    // asked for anything, and reserved (Codex review of PR #121, finding 1).
    // Each amount fits a BIGINT; their sum need not, and a capture the ledger
    // then cannot record left the provider CAPTURED over an intent that was
    // not. Under the wallet's row lock, so two concurrent top-ups each count
    // the other: intents still CREATED or AUTHORIZED are money on its way in.
    const intentId = `${ID_PREFIXES.payment}_${ulid()}`;
    await this.prisma.transaction(async (tx) => {
      const [locked] = await this.walletRepository.lock(tx, [walletId]);
      if (!locked) throw RastaError.notFound('Wallet', walletId);

      const inFlight = await tx.paymentIntent.aggregate({
        where: { walletId, status: { in: ['CREATED', 'AUTHORIZED'] } },
        _sum: { amountMinor: true },
      });
      const projected = locked.ledgerBalanceMinor + (inFlight._sum.amountMinor ?? 0n) + amountMinor;
      if (projected > MAX_AMOUNT_MINOR) throw walletBalanceLimit(walletId);

      await tx.paymentIntent.create({
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
        failureCodeFrom(authorization.failureCode, 'PROVIDER_DECLINED'),
      );
    }

    // The state change and its event commit together or not at all (ADR-021).
    // They were two transactions: a failure between them left an intent
    // AUTHORIZED that no consumer ever heard of (economic batch 2, item c).
    const authorizedAt = new Date();
    await this.prisma.transaction(async (tx) => {
      await tx.paymentIntent.update({
        where: { id: intentId },
        data: {
          status: 'AUTHORIZED',
          authorizedAt,
          providerReference: authorization.providerReference,
        },
      });

      await this.ledger.enqueue(tx, {
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
      });
    });

    paymentIntentsTotal.inc({
      service: SERVICE_NAME,
      provider: this.provider.name,
      simulated: String(this.provider.simulated),
      outcome: 'AUTHORIZED',
    });

    const capture = await this.provider.capture({
      paymentIntentId: intentId,
      // The reference the provider issued, as with any real provider — never
      // the caller's raw instrument (global audit L7-20).
      providerReference: authorization.providerReference,
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
        failureCodeFrom(capture.failureCode, 'CAPTURE_DECLINED'),
      );
    }

    const intent = { intentId, walletId, organizationId, amountMinor, currency: wallet.currency };
    const recorded = await this.recordCaptureOrFindIt(intent, actor);
    if (recorded.captured) return recorded.captured;
    return this.returnUncreditedCapture(
      intent,
      authorization.providerReference,
      dto.idempotencyKey,
      recorded.cause,
    );
  }

  /**
   * Writes the capture, and when the write reports a failure, finds out
   * whether it committed before anyone compensates (Codex round 2 on #121, F1).
   *
   * An exception from a transaction is not proof it rolled back: PostgreSQL
   * can commit and the connection drop before the acknowledgement arrives.
   * Refunding the provider then left a credited wallet over a returned
   * charge. So the intent is read again in a fresh query: CAPTURED means the
   * write happened and its result is rebuilt; still not captured, with no
   * top-up transaction for it, is the only state that may be compensated.
   * When even the re-read fails, the outcome is unknown and nothing is
   * compensated: the original error propagates, the intent stays AUTHORIZED,
   * and a same-key retry resumes it.
   *
   * The metrics count a capture after this decision, outside it, so a failing
   * counter can never be mistaken for a failed write.
   */
  private async recordCaptureOrFindIt(
    intent: CaptureTarget,
    actor: string,
  ): Promise<{ captured: TopUpResult; cause?: undefined } | { captured: null; cause: unknown }> {
    let captured: TopUpResult | null;
    let cause: unknown;
    try {
      captured = await this.completeCapture(intent, actor);
    } catch (error) {
      cause = error;
      captured = await this.committedCapture(intent.intentId).catch((readError: unknown) => {
        this.logger.error(
          `Payment intent ${intent.intentId}: the capture write failed and its outcome could ` +
            'not be read back; not compensating',
          readError,
        );
        throw error;
      });
      if (captured) {
        this.logger.warn(
          `Payment intent ${intent.intentId}: the capture write reported a failure but had ` +
            'committed; returning the committed result',
        );
      }
    }
    if (!captured) return { captured: null, cause };

    transactionsCreatedTotal.inc({ service: SERVICE_NAME, type: 'WALLET_TOP_UP', source: 'api' });
    paymentIntentsTotal.inc({
      service: SERVICE_NAME,
      provider: this.provider.name,
      simulated: String(this.provider.simulated),
      outcome: 'CAPTURED',
    });
    return { captured };
  }

  /**
   * The committed result of a capture, or `null` when provably none was
   * written: the intent is not CAPTURED and no top-up transaction names it.
   * The two commit together, so disagreement between them is refused rather
   * than guessed at.
   */
  private async committedCapture(intentId: string): Promise<TopUpResult | null> {
    const intent = await this.prisma.client.paymentIntent.findUniqueOrThrow({
      where: { id: intentId },
    });
    const transaction = await this.prisma.client.transaction.findFirst({
      where: { sourceType: 'PAYMENT_INTENT', sourceReference: intentId },
    });
    if (intent.status !== 'CAPTURED' && !transaction) return null;
    if (intent.status !== 'CAPTURED') {
      throw RastaError.internal(`Payment intent ${intentId} disagrees with its top-up transaction`);
    }
    return this.capturedView(intent);
  }

  /**
   * A captured intent as the response that captured it. The balances are the
   * wallet's now, which a retry reads as current; the ids are the originals.
   */
  private async capturedView(intent: PaymentIntent): Promise<TopUpResult> {
    const journal = await this.prisma.client.journal.findFirstOrThrow({
      where: { transactionId: intent.transactionId, journalType: 'WALLET_TOP_UP' },
    });
    const wallet = await this.wallets.getById(intent.walletId);
    return {
      paymentIntentId: intent.id,
      transactionId: intent.transactionId,
      journalId: journal.id,
      status: 'CAPTURED',
      amountMinor: intent.amountMinor,
      currency: intent.currency,
      balances: {
        ledgerBalanceMinor: wallet.ledgerBalanceMinor,
        pendingBalanceMinor: wallet.pendingBalanceMinor,
        availableBalanceMinor: wallet.availableBalanceMinor,
      },
      provider: intent.provider,
      simulated: intent.simulated,
    };
  }

  /**
   * A same-key retry of a top-up (Codex round 2 on #121, F2).
   *
   * The API's idempotency store replays a completed response itself, so this
   * is reached when the first attempt ended in an error and released its
   * claim. A finished intent answers as it finished. One the provider captured
   * and the ledger did not credit (`CAPTURED_NOT_CREDITED`) is credited now,
   * when the wallet has the headroom — the provider already holds the money,
   * so it is not asked again — or refused exactly as before. Anything else is
   * mid-flight with an outcome only a reconciliation can establish (the
   * durable reconciler is a recorded follow-up), and is refused without
   * touching it.
   */
  private async resume(
    intent: PaymentIntent,
    walletId: string,
    amountMinor: bigint,
    actor: string,
  ): Promise<TopUpResult> {
    if (intent.walletId !== walletId || intent.amountMinor !== amountMinor) {
      throw RastaError.idempotencyKeyReused(intent.idempotencyKey);
    }
    if (intent.status === 'CAPTURED' || intent.status === 'REFUNDED') {
      return this.capturedView(intent);
    }
    if (intent.status === 'FAILED') {
      return {
        paymentIntentId: intent.id,
        transactionId: null,
        journalId: null,
        status: 'FAILED',
        amountMinor: intent.amountMinor,
        currency: intent.currency,
        balances: null,
        provider: intent.provider,
        simulated: intent.simulated,
        failureReason: intent.failureReason ?? 'UNKNOWN',
      };
    }
    if (intent.status !== 'AUTHORIZED' || intent.failureReason !== CAPTURED_NOT_CREDITED) {
      throw RastaError.businessRule(
        'A top-up with this idempotency key has not finished; its outcome is being reconciled',
        { paymentIntentId: intent.id, status: intent.status },
      );
    }

    const target = {
      intentId: intent.id,
      walletId,
      organizationId: intent.organizationId,
      amountMinor,
      currency: intent.currency,
    };
    const recorded = await this.recordCaptureOrFindIt(target, actor);
    if (recorded.captured) return recorded.captured;
    // Still uncreditable: the same refusal the first attempt gave, and the
    // intent stays marked. Its unreconciled event was published then.
    throw recorded.cause;
  }

  /**
   * The provider captured the money and the ledger could not record it.
   *
   * The reservation above makes the balance limit unreachable for concurrent
   * top-ups, but another credit (a settlement to this wallet, a reward) can
   * still land between the reservation and the capture, and a database fault
   * can fail the write. Leaving the provider CAPTURED over an intent still
   * AUTHORIZED is the one outcome that must not happen (Codex review of
   * PR #121, finding 1): the payer is charged and nothing is credited.
   *
   * So the capture is refunded at the provider and the intent recorded
   * FAILED, which is the response a retry with the same key then replays. It
   * is not the compensating movement docs/08 § 8.6 forbids: no ledger entry
   * was written, so there is nothing of ours to move — only the provider's
   * charge to return. Should the provider refuse the refund too, the intent
   * keeps `CAPTURED_NOT_CREDITED` as its failure reason, stays AUTHORIZED
   * (the lifecycle constraint forbids calling it FAILED while money is held),
   * holds its reserved headroom, `PAYMENT_CAPTURE_UNRECONCILED` announces it in
   * the same transaction, and the error propagates. A same-key retry credits
   * it once the wallet has room ({@link resume}); a durable reconciler that
   * asks the provider is a recorded follow-up.
   */
  private async returnUncreditedCapture(
    { intentId, walletId, organizationId, amountMinor, currency }: CaptureTarget,
    providerReference: string,
    idempotencyKey: string,
    cause: unknown,
  ): Promise<TopUpResult> {
    const reason = isWalletBalanceLimit(cause) ? WALLET_BALANCE_LIMIT : 'CAPTURE_NOT_CREDITED';
    this.logger.error(
      `Payment intent ${intentId} was captured but could not be credited (${reason}); ` +
        'refunding it at the provider',
      cause instanceof Error ? cause.stack : String(cause),
    );

    const refunded = await this.provider
      .refund({
        paymentIntentId: intentId,
        providerReference,
        amountMinor,
        currency,
        idempotencyKey: `${idempotencyKey}:uncredited`,
        reason: 'the capture could not be credited to the wallet',
      })
      .then(
        (result) => result.outcome === 'REFUNDED',
        () => false,
      );

    if (!refunded) {
      // The mark and its alert commit together (Codex round 2 on #121, F2):
      // a stranded capture is never recorded without being announced.
      await this.prisma.transaction(async (tx) => {
        await tx.paymentIntent.update({
          where: { id: intentId },
          data: { failureReason: CAPTURED_NOT_CREDITED },
        });
        await this.ledger.enqueue(tx, {
          eventName: ECONOMIC_EVENTS.PAYMENT_CAPTURE_UNRECONCILED,
          aggregateId: intentId,
          organizationId,
          payload: {
            paymentIntentId: intentId,
            organizationId,
            walletId,
            amountMinor: formatMinor(amountMinor),
            currency,
            provider: this.provider.name,
            simulated: this.provider.simulated,
            reason,
            detectedAt: new Date().toISOString(),
          },
        });
      });
      paymentIntentsTotal.inc({
        service: SERVICE_NAME,
        provider: this.provider.name,
        simulated: String(this.provider.simulated),
        outcome: CAPTURED_NOT_CREDITED,
      });
      this.logger.error(
        `Payment intent ${intentId} is captured at the provider and not credited (${reason}); ` +
          'the provider refund failed. A same-key retry credits it once the wallet has room; ' +
          'otherwise it needs a person',
      );
      throw cause;
    }

    return this.fail(intentId, organizationId, amountMinor, currency, reason);
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
    { intentId, walletId, organizationId, amountMinor, currency }: CaptureTarget,
    actor: string,
  ): Promise<TopUpResult> {
    const stop = financialTransactionDuration.startTimer({
      service: SERVICE_NAME,
      operation: 'top-up',
    });

    try {
      return await this.prisma.transaction(async (tx) => {
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
        code: failureCodeFrom(providerResult.failureCode, 'REFUND_DECLINED'),
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

/**
 * A provider failure code as this service will store, publish and log it.
 *
 * Codes land in `failure_reason`, on `PAYMENT_FAILED` and in the log, so only
 * a code-shaped value is kept: upper-case letters and underscores. Anything
 * else — a digit string that could be a card number, free text — is replaced
 * by the fallback rather than copied (AGENTS.md S-09; Codex review of PR #121,
 * finding 4).
 */
export function failureCodeFrom(code: string | undefined, fallback: string): string {
  return code !== undefined && FAILURE_CODE.test(code) ? code : fallback;
}

const FAILURE_CODE = /^[A-Z][A-Z_]{0,63}$/;

/**
 * The failure reason an AUTHORIZED intent keeps while the provider holds a
 * capture the ledger has not credited (Codex round 2 on #121, F2).
 */
export const CAPTURED_NOT_CREDITED = 'CAPTURED_NOT_CREDITED';

/** The intent a capture is written for. */
interface CaptureTarget {
  intentId: string;
  walletId: string;
  organizationId: string;
  amountMinor: bigint;
  currency: string;
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
