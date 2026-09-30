import { Inject, Injectable, Logger } from '@nestjs/common';
import { ulid } from 'ulid';
import { ID_PREFIXES, MAX_AMOUNT_MINOR } from '@rasta/contracts';
import { RastaError, getContext, getOrganizationId, runUnscoped } from '@rasta/nest-common';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { WalletService } from '../wallet/wallet.service';
import {
  WALLET_BALANCE_LIMIT,
  WalletRepository,
  isWalletBalanceLimit,
  walletBalanceLimit,
  type LockedWallet,
} from '../wallet/wallet.repository';
import { assertSufficient } from '../wallet/balances';
import { ECONOMIC_EVENTS } from '../events/events';
import { formatMinor, parseMinor } from '../shared/money';
import {
  financialTransactionDuration,
  paymentIntentsTotal,
  transactionsCreatedTotal,
} from '../observability/metrics';
import { PAYMENT_PROVIDER } from '../tokens';
import { SERVICE_NAME } from '../config/env';
import type { PaymentProvider, RefundResult } from './provider';
import type { TopUpDto } from './dto';
import { hashRequestBody } from '../shared/idempotency';
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

    // The request this intent is for, kept on the row (Codex round 3 on #121,
    // H2): by the time a retry reaches `resume`, the API's idempotency record
    // of the first attempt is gone, so this is what proves it is the same one.
    const requestHash = hashRequestBody({
      walletId,
      amountMinor: formatMinor(amountMinor),
      currency: wallet.currency,
      instrument: dto.instrument ?? null,
    });

    // A retry with the same key resumes the intent the first attempt left
    // (Codex round 2 on #121, F2). Inserting another collided with the unique
    // key, so a capture left uncredited could never be finished by a retry.
    const existing = await this.prisma.client.paymentIntent.findUnique({
      where: {
        organizationId_idempotencyKey: { organizationId, idempotencyKey: dto.idempotencyKey },
      },
    });
    if (existing) return this.resume(existing, requestHash, actor);

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
          requestHash,
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
      captured = await this.committedCapture(intent).catch((readError: unknown) => {
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
   *
   * Decided in its own transaction, behind the intent's row lock (Codex round
   * 3 on #121, H1). The capture write takes that lock first, so while its
   * COMMIT is still in flight this waits for it; plain reads could run inside
   * that window, see the old row, and let the caller refund a capture that
   * then became visible. Once the lock is granted the writer has resolved, and
   * the reads after it see what it left.
   */
  private async committedCapture({
    intentId,
    organizationId,
  }: CaptureTarget): Promise<TopUpResult | null> {
    const intent = await this.prisma.transaction(async (tx) => {
      await this.lockIntent(tx, intentId, organizationId);
      const row = await tx.paymentIntent.findUniqueOrThrow({ where: { id: intentId } });
      const transaction = await tx.transaction.findFirst({
        where: { sourceType: 'PAYMENT_INTENT', sourceReference: intentId },
      });
      if (row.status !== 'CAPTURED' && !transaction) return null;
      if (row.status !== 'CAPTURED') {
        throw RastaError.internal(
          `Payment intent ${intentId} disagrees with its top-up transaction`,
        );
      }
      return row;
    });
    return intent ? this.capturedView(intent) : null;
  }

  /**
   * `SELECT … FOR UPDATE` on one intent, and its status. Raw, so the tenant
   * guard cannot scope it; it names the organization itself.
   */
  private async lockIntent(
    tx: ExtendedPrismaClient,
    intentId: string,
    organizationId: string,
  ): Promise<string | undefined> {
    const [row] = await runUnscoped(
      'a raw row lock is filtered by the organization explicitly',
      () =>
        tx.$queryRaw<{ status: string }[]>`
          SELECT status::text AS status FROM payment_intent
          WHERE id = ${intentId} AND organization_id = ${organizationId}
          FOR UPDATE
        `,
    );
    return row?.status;
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
   * when the wallet has the headroom — the provider declined the refund, so
   * it certainly still holds the money and is not asked again — or refused
   * exactly as before. Anything else is mid-flight with an outcome only a
   * reconciliation can establish (ADR-064), and is refused without touching
   * it. That includes `CAPTURED_REFUND_UNKNOWN`: a refund that failed without
   * an answer may have returned the money, and crediting it here gave it
   * twice (U6).
   */
  private async resume(
    intent: PaymentIntent,
    requestHash: string,
    actor: string,
  ): Promise<TopUpResult> {
    // The whole request, first (Codex round 3 on #121, H2): a retry that
    // changed the instrument was resumed as if it were the original. An intent
    // written before the hash existed has none and is never resumed. The key
    // itself stays out of the error entirely (S-09).
    if (intent.requestHash !== requestHash) {
      throw RastaError.idempotencyKeyReused();
    }
    if (intent.status === 'CAPTURED') {
      // Captured, and a refund of it not finished: answering CAPTURED would
      // describe money that may already be back with the payer (round 1 on
      // #143, finding 3).
      if (intent.failureReason && UNFINISHED_REFUND.has(intent.failureReason)) {
        throw RastaError.businessRule(
          'A refund of this top-up has not finished; its outcome is being reconciled',
          { paymentIntentId: intent.id, status: intent.status, outcome: intent.failureReason },
        );
      }
      return this.capturedView(intent);
    }
    // Refunded since: answering CAPTURED would describe money that went back
    // (round 3, M3). Terminal, and not replayable under this key.
    if (intent.status === 'REFUNDED') {
      throw RastaError.invalidStateTransition('PaymentIntent', 'REFUNDED', 'CAPTURED');
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
    // Only a provider that answered "declined" makes a capture creditable
    // here; `CAPTURED_REFUND_UNKNOWN` falls through to the refusal (U6).
    if (intent.status !== 'AUTHORIZED' || intent.failureReason !== CAPTURED_NOT_CREDITED) {
      throw RastaError.businessRule(
        'A top-up with this idempotency key has not finished; its outcome is being reconciled',
        { paymentIntentId: intent.id, status: intent.status },
      );
    }

    const target = {
      intentId: intent.id,
      walletId: intent.walletId,
      organizationId: intent.organizationId,
      amountMinor: intent.amountMinor,
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
   * charge to return.
   *
   * When the refund does not succeed, the intent stays AUTHORIZED (the
   * lifecycle constraint forbids calling it FAILED while money may be held),
   * holds its reserved headroom, `PAYMENT_CAPTURE_UNRECONCILED` announces it in
   * the same transaction, and the error propagates. Which marker it keeps
   * depends on whether the provider *answered* (ADR-064, U6):
   *
   *   - it declined the refund: the capture is certainly still held, so
   *     `CAPTURED_NOT_CREDITED`, and a same-key retry credits it once the
   *     wallet has room ({@link resume});
   *   - the call failed without an answer (a timeout, a lost response): the
   *     provider may have refunded, so `CAPTURED_REFUND_UNKNOWN`, and nothing
   *     credits it. Crediting a capture the payer already has back would give
   *     the money twice. The durable reconciler (ADR-064) establishes the
   *     provider's state; until it exists, the row is for a person.
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

    // Three outcomes, not two (ADR-064, U6): a call that failed without an
    // answer is not a refusal. It was treated as one, and a same-key retry
    // then credited a capture the provider may already have returned.
    const refund: 'REFUNDED' | 'DECLINED' | 'UNKNOWN' = await this.provider
      .refund({
        paymentIntentId: intentId,
        providerReference,
        amountMinor,
        currency,
        idempotencyKey: `${idempotencyKey}:uncredited`,
        reason: 'the capture could not be credited to the wallet',
      })
      .then(
        (result) => (result.outcome === 'REFUNDED' ? 'REFUNDED' : 'DECLINED'),
        () => 'UNKNOWN',
      );

    if (refund !== 'REFUNDED') {
      const marker = refund === 'DECLINED' ? CAPTURED_NOT_CREDITED : CAPTURED_REFUND_UNKNOWN;
      // The mark and its alert commit together (Codex round 2 on #121, F2):
      // a stranded capture is never recorded without being announced.
      await this.prisma.transaction(async (tx) => {
        await tx.paymentIntent.update({
          where: { id: intentId },
          data: { failureReason: marker },
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
            providerRefund: refund,
            detectedAt: new Date().toISOString(),
          },
        });
      });
      paymentIntentsTotal.inc({
        service: SERVICE_NAME,
        provider: this.provider.name,
        simulated: String(this.provider.simulated),
        outcome: marker,
      });
      this.logger.error(
        refund === 'DECLINED'
          ? `Payment intent ${intentId} is captured at the provider and not credited (${reason}); ` +
              'the provider declined the refund. A same-key retry credits it once the wallet ' +
              'has room; otherwise it needs a person'
          : `Payment intent ${intentId} is captured and not credited (${reason}), and the ` +
              'provider refund failed without an answer: the provider may have refunded. ' +
              'Nothing credits it until the provider state is established; it needs a person',
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
        // The intent's row lock first, held to COMMIT: a read-back after an
        // ambiguous failure waits on it (round 3, H1). And only an AUTHORIZED
        // intent is captured, so two resumes of one intent cannot both credit.
        const status = await this.lockIntent(tx, intentId, organizationId);
        if (status !== 'AUTHORIZED') {
          throw RastaError.invalidStateTransition('PaymentIntent', String(status), 'CAPTURED');
        }
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
          // Resolved: a stranded marker does not outlive its recovery (M1).
          data: { status: 'CAPTURED', capturedAt, transactionId, failureReason: null },
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
   * ## Three steps, and why the money is held between them (ADR-064, R2)
   *
   * The balance used to be checked after `provider.refund`: a spent top-up
   * was returned to the payer, the ledger then refused the reversal, and the
   * wallet kept the value. Checking first is not enough on its own, because
   * the provider call holds no lock and a spend can commit while it runs. So:
   *
   *   1. **Request** — under the intent's row lock and then the wallet's, the
   *      amount is **held** in escrow through the ordinary hold path
   *      (ADR-034; `placeHold` refuses `INSUFFICIENT_BALANCE`) and the intent
   *      is marked `REFUND_REQUESTED`. A concurrent spend now fails on the
   *      hold, not the reversal.
   *   2. **Ask** the provider, outside any transaction.
   *   3. **Record** — refunded: the hold is returned to the wallet and the
   *      top-up reversed, in one transaction under the same locks, with the
   *      balance checked again as a defence. Declined: the hold is returned
   *      and the marker cleared.
   *
   * Anything that leaves the outcome unrecorded leaves the hold in place and
   * the intent marked, so it is never lost and never repeated blindly:
   *
   *   - the provider call fails without an answer → `REFUND_UNKNOWN`, with
   *     `PAYMENT_REFUND_UNRECONCILED` in the same transaction; a second refund
   *     is refused until the provider's state is established (the reconciler
   *     or a person, ADR-064);
   *   - the provider refunded and step 3 failed → `REFUNDED_NOT_REVERSED`,
   *     announced the same way; a retry performs step 3 alone, without asking
   *     the provider again;
   *   - the provider declined and returning the hold failed →
   *     `REFUND_DECLINED_RELEASE_PENDING`, announced the same way; a retry
   *     only returns the hold, and the provider is never asked again;
   *   - a crash anywhere after step 1 → `REFUND_REQUESTED` with the hold,
   *     which a second refund also refuses.
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

    // 1. Request: hold the money and mark the intent, together.
    const requested = await this.prisma.transaction(async (tx) => {
      const { intent: row, wallet } = await this.lockForRefund(tx, intentId, organizationId);
      // Declined by the provider, and the held amount not yet returned: this
      // call returns it and does nothing else — the decline is known, so the
      // provider is never asked again (round 2 on #143, finding 1).
      if (row.failureReason === REFUND_DECLINED_RELEASE_PENDING) {
        await this.returnDeclinedHold(tx, row, wallet, actor);
        return { row, next: 'RELEASED' as const };
      }
      // No money leaves a frozen wallet (PM ruling, round 2 on #143). Refused
      // before any hold or provider call; the intent stays refundable once the
      // wallet is active again. Returning a declined refund's hold, above,
      // moves money back *into* the wallet and is still allowed. A reversal
      // still owed after the provider refunded waits too, with its amount
      // held, so nothing can spend it meanwhile.
      if (wallet.status !== 'ACTIVE') {
        throw RastaError.businessRule(
          'This wallet is not active; a refund cannot take money out of it until it is',
          { paymentIntentId: intentId, walletId: wallet.id, walletStatus: wallet.status },
        );
      }
      // Refunded at the provider by an earlier attempt that could not record
      // it: the hold is still there, and only step 3 is retried.
      if (row.failureReason === REFUNDED_NOT_REVERSED) return { row, next: 'RECORD' as const };
      // No automatic way out of these two yet. An aged REFUND_REQUESTED or a
      // REFUND_UNKNOWN keeps its hold (money safe, never lost or credited
      // twice) and every later refund is refused here, because nothing asks
      // the provider what happened. Asking it, escalating and resolving under
      // the intent and wallet locks is ADR-064 step B, NOT implemented yet.
      // Until it ships, an operator resolves them with the provider's answer:
      // docs/runbooks/payment-refund-stuck.md.
      if (row.failureReason === REFUND_REQUESTED || row.failureReason === REFUND_UNKNOWN) {
        throw refundUnresolved(intentId, row.failureReason);
      }
      await this.wallets.placeHold(tx, {
        wallet,
        amountMinor: row.amountMinor,
        reference: intentId,
        referenceType: REFUND_HOLD_REFERENCE_TYPE,
        transactionId: topUpTransactionOf(row),
        placedBy: actor,
      });
      await tx.paymentIntent.update({
        where: { id: intentId },
        data: { failureReason: REFUND_REQUESTED },
      });
      return { row, next: 'ASK' as const };
    });

    if (requested.next === 'RELEASED') {
      throw RastaError.businessRule(
        'The payment provider declined the earlier refund of this payment; its held amount ' +
          'has now been returned to the wallet',
        { paymentIntentId: intentId, outcome: 'REFUND_DECLINED' },
      );
    }

    // 2. Ask the provider.
    if (requested.next === 'ASK') {
      let providerResult: RefundResult;
      try {
        providerResult = await this.provider.refund({
          paymentIntentId: intentId,
          providerReference: requested.row.providerReference ?? intentId,
          amountMinor: requested.row.amountMinor,
          currency: requested.row.currency,
          idempotencyKey: `${requested.row.idempotencyKey}:refund`,
          reason,
        });
      } catch (error) {
        await this.markRefundUnresolved(requested.row, REFUND_UNKNOWN, 'PROVIDER_OUTCOME_UNKNOWN');
        throw error;
      }

      if (providerResult.outcome === 'FAILED') {
        // The decline is known. Should returning the hold fail, that fact is
        // recorded rather than lost: without it the intent would sit in
        // REFUND_REQUESTED, every later refund refused, and nothing announced.
        await this.releaseDeclinedRefund(requested.row, actor).catch(async (error: unknown) => {
          this.logger.error(
            `Payment intent ${intentId}: the provider declined the refund and returning the ` +
              'held amount failed',
            error instanceof Error ? error.stack : String(error),
          );
          await this.markRefundUnresolved(
            requested.row,
            REFUND_DECLINED_RELEASE_PENDING,
            'PROVIDER_DECLINED_RELEASE_PENDING',
          );
        });
        throw RastaError.businessRule('The payment provider refused the refund', {
          intentId,
          code: failureCodeFrom(providerResult.failureCode, 'REFUND_DECLINED'),
        });
      }
    }

    // 3. Record: return the hold and reverse the top-up, together.
    try {
      return await this.prisma.transaction(async (tx) => {
        const { intent: row, wallet } = await this.lockForRefund(tx, intentId, organizationId);
        if (row.failureReason !== REFUND_REQUESTED && row.failureReason !== REFUNDED_NOT_REVERSED) {
          throw RastaError.internal(`Payment intent ${intentId} lost its refund marker`);
        }
        const hold = await this.refundHoldOf(tx, wallet.id, intentId);
        const returned = await this.wallets.refundHold(tx, {
          wallet,
          holdId: hold.id,
          transactionId: topUpTransactionOf(row),
          note: `Returned for the refund of payment ${intentId}`,
          resolvedBy: actor,
        });
        if (!returned) throw RastaError.internal(`The refund hold of ${intentId} is not active`);
        // A defence, not the guard: the hold already reserved this amount.
        assertSufficient(wallet.id, returned.balances, row.amountMinor);

        const topUpJournal = await runUnscoped(
          'the top-up journal is found by the transaction it funded',
          () =>
            tx.journal.findFirst({
              where: { transactionId: topUpTransactionOf(row), journalType: 'WALLET_TOP_UP' },
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

        const balances = await this.walletRepository.recomputeFromLedger(tx, wallet);

        const refundedAt = new Date();
        await tx.paymentIntent.update({
          where: { id: intentId },
          // Resolved: the marker does not outlive the refund it described.
          data: { status: 'REFUNDED', refundedAt, failureReason: null },
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
          amountMinor: row.amountMinor,
          currency: row.currency,
          balances,
          provider: this.provider.name,
          simulated: this.provider.simulated,
          refundedAt,
        };
      });
    } catch (error) {
      const code = (error as { code?: string } | null)?.code;
      await this.markRefundUnresolved(
        requested.row,
        REFUNDED_NOT_REVERSED,
        code === 'INSUFFICIENT_BALANCE' ? 'INSUFFICIENT_BALANCE' : 'REVERSAL_FAILED',
      );
      throw error;
    }
  }

  /**
   * The intent, still CAPTURED, and its wallet — under the intent's row lock
   * and then the wallet's, the order `completeCapture` takes, held to COMMIT.
   */
  private async lockForRefund(
    tx: ExtendedPrismaClient,
    intentId: string,
    organizationId: string,
  ): Promise<{ intent: PaymentIntent; wallet: LockedWallet }> {
    const status = await this.lockIntent(tx, intentId, organizationId);
    if (status === undefined) throw RastaError.notFound('PaymentIntent', intentId);
    if (status !== 'CAPTURED') {
      throw RastaError.invalidStateTransition('PaymentIntent', status, 'REFUNDED');
    }
    const intent = await tx.paymentIntent.findUniqueOrThrow({ where: { id: intentId } });
    const [wallet] = await this.walletRepository.lock(tx, [intent.walletId]);
    if (!wallet) throw RastaError.internal('Wallet vanished while locking it');
    return { intent, wallet };
  }

  /** The active hold a refund of this intent placed. */
  private async refundHoldOf(tx: ExtendedPrismaClient, walletId: string, intentId: string) {
    const hold = await this.walletRepository.findActiveHold(tx, walletId, intentId);
    if (!hold || hold.referenceType !== REFUND_HOLD_REFERENCE_TYPE) {
      throw RastaError.internal(`The refund hold of payment intent ${intentId} is missing`);
    }
    return hold;
  }

  /**
   * The provider declined: the held money goes back to the wallet and the
   * intent is an ordinary CAPTURED top-up again.
   *
   * Should this write fail, the intent keeps `REFUND_REQUESTED` and its hold
   * — money kept safe, and a second refund refused — rather than anything
   * being guessed.
   */
  private async releaseDeclinedRefund(intent: PaymentIntent, actor: string): Promise<void> {
    await this.prisma.transaction(async (tx) => {
      const { intent: row, wallet } = await this.lockForRefund(
        tx,
        intent.id,
        intent.organizationId,
      );
      if (row.failureReason !== REFUND_REQUESTED) return;
      await this.returnDeclinedHold(tx, row, wallet, actor);
    });
  }

  /**
   * Returns the held amount of a declined refund to the wallet and clears the
   * marker. The caller holds the intent's and the wallet's locks.
   *
   * Idempotent: a hold already returned is not returned again (`refundHold`
   * answers `null` for a hold that is no longer ACTIVE, and refuses a
   * concurrent second resolution), so a retry after an ambiguous failure
   * moves nothing twice.
   */
  private async returnDeclinedHold(
    tx: ExtendedPrismaClient,
    intent: PaymentIntent,
    wallet: LockedWallet,
    actor: string,
  ): Promise<void> {
    const hold = await this.walletRepository.findActiveHold(tx, wallet.id, intent.id);
    if (hold && hold.referenceType === REFUND_HOLD_REFERENCE_TYPE) {
      await this.wallets.refundHold(tx, {
        wallet,
        holdId: hold.id,
        transactionId: topUpTransactionOf(intent),
        note: `Returned: the provider declined the refund of payment ${intent.id}`,
        resolvedBy: actor,
      });
    }
    await tx.paymentIntent.update({
      where: { id: intent.id },
      data: { failureReason: null },
    });
  }

  /**
   * A refund whose outcome the ledger could not record: marked and announced
   * together (ADR-064, R2). The hold stays, so the money stays safe.
   *
   * Decided behind the intent's row lock, and only from `REFUND_REQUESTED`:
   * a reversal whose COMMIT was in flight is seen as REFUNDED and left alone,
   * and a retry that fails the same way does not announce it twice. When even
   * this write fails, the intent keeps `REFUND_REQUESTED` and its hold, the
   * original error still propagates, and the log says why.
   */
  private async markRefundUnresolved(
    intent: PaymentIntent,
    marker:
      typeof REFUND_UNKNOWN | typeof REFUNDED_NOT_REVERSED | typeof REFUND_DECLINED_RELEASE_PENDING,
    reason:
      | 'PROVIDER_OUTCOME_UNKNOWN'
      | 'PROVIDER_DECLINED_RELEASE_PENDING'
      | 'INSUFFICIENT_BALANCE'
      | 'REVERSAL_FAILED',
  ): Promise<void> {
    try {
      const marked = await this.prisma.transaction(async (tx) => {
        const status = await this.lockIntent(tx, intent.id, intent.organizationId);
        if (status !== 'CAPTURED') return false;
        const row = await tx.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } });
        if (row.failureReason !== REFUND_REQUESTED) return false;

        await tx.paymentIntent.update({
          where: { id: intent.id },
          data: { failureReason: marker },
        });
        await this.ledger.enqueue(tx, {
          eventName: ECONOMIC_EVENTS.PAYMENT_REFUND_UNRECONCILED,
          aggregateId: intent.id,
          organizationId: intent.organizationId,
          payload: {
            paymentIntentId: intent.id,
            organizationId: intent.organizationId,
            walletId: intent.walletId,
            amountMinor: formatMinor(intent.amountMinor),
            currency: intent.currency,
            provider: this.provider.name,
            simulated: this.provider.simulated,
            reason,
            detectedAt: new Date().toISOString(),
          },
        });
        return true;
      });
      if (!marked) return;
      paymentIntentsTotal.inc({
        service: SERVICE_NAME,
        provider: this.provider.name,
        simulated: String(this.provider.simulated),
        outcome: marker,
      });
      this.logger.error(UNRESOLVED_REFUND_LOG[marker](intent.id, reason));
    } catch (markError) {
      this.logger.error(
        `Payment intent ${intent.id}: a refund outcome (${reason}) could not be recorded; it ` +
          'keeps REFUND_REQUESTED and its hold',
        markError instanceof Error ? markError.stack : String(markError),
      );
    }
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

/**
 * The failure reason an AUTHORIZED intent keeps when the capture could not be
 * credited and the provider refund failed **without an answer** (ADR-064,
 * U6). The provider may have refunded, so no retry credits it: only the
 * provider's own state, or a person, can decide.
 */
export const CAPTURED_REFUND_UNKNOWN = 'CAPTURED_REFUND_UNKNOWN';

/**
 * The failure reason a CAPTURED intent keeps when the provider refunded it
 * and the ledger could not reverse the top-up (ADR-064, R2). The payer has the
 * money back and the wallet still holds the credit, until a retry of the
 * refund reverses it or a person does.
 */
export const REFUNDED_NOT_REVERSED = 'REFUNDED_NOT_REVERSED';

/**
 * The failure reason a CAPTURED intent keeps while an operator refund is in
 * flight: the amount is held and the provider has been, or is about to be,
 * asked (ADR-064, R2). Still present after a crash, which is the point — a
 * second refund is refused rather than asking the provider again.
 */
export const REFUND_REQUESTED = 'REFUND_REQUESTED';

/**
 * The failure reason a CAPTURED intent keeps when the provider refund call
 * failed without an answer (ADR-064, R2). The payer may have the money back;
 * the amount stays held and nothing repeats the refund until the provider's
 * state is established.
 */
export const REFUND_UNKNOWN = 'REFUND_UNKNOWN';

/**
 * The failure reason a CAPTURED intent keeps when the provider **declined**
 * the refund and returning the held amount failed (round 2 on #143, finding
 * 1). The decline is known: a later refund call, or the reconciler, only
 * returns the hold — the provider is never asked again for this attempt.
 */
export const REFUND_DECLINED_RELEASE_PENDING = 'REFUND_DECLINED_RELEASE_PENDING';

/** The markers under which a CAPTURED intent's refund has not finished. */
const UNFINISHED_REFUND: ReadonlySet<string> = new Set([
  REFUND_REQUESTED,
  REFUND_UNKNOWN,
  REFUNDED_NOT_REVERSED,
  REFUND_DECLINED_RELEASE_PENDING,
]);

/** What the log says when each unresolved refund marker is recorded. */
const UNRESOLVED_REFUND_LOG: Record<string, (intentId: string, reason: string) => string> = {
  [REFUND_UNKNOWN]: (id) =>
    `Payment intent ${id}: the provider refund failed without an answer; the amount stays ` +
    'held and a second refund is refused until the outcome is established',
  [REFUNDED_NOT_REVERSED]: (id, reason) =>
    `Payment intent ${id} was refunded at the provider and the ledger could not reverse it ` +
    `(${reason}); the amount stays held and a retry of the refund reverses it`,
  [REFUND_DECLINED_RELEASE_PENDING]: (id) =>
    `Payment intent ${id}: the provider declined the refund and the held amount could not be ` +
    'returned; a retry of the refund returns it without asking the provider',
};

/** `wallet_hold.reference_type` of the hold an operator refund places. */
export const REFUND_HOLD_REFERENCE_TYPE = 'PAYMENT_REFUND';

/** A refund that has not finished, refused rather than repeated. */
function refundUnresolved(intentId: string, marker: string): RastaError {
  return RastaError.businessRule(
    'A refund of this payment has not finished and its outcome is not known yet; it is ' +
      'reconciled before another refund can be made',
    { paymentIntentId: intentId, outcome: marker },
  );
}

/** The top-up transaction a CAPTURED intent funded. */
function topUpTransactionOf(intent: PaymentIntent): string {
  if (!intent.transactionId) {
    throw RastaError.internal(`Captured payment intent ${intent.id} has no transaction`);
  }
  return intent.transactionId;
}

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
