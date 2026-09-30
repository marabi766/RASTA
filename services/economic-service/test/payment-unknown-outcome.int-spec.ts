import { ulid } from 'ulid';
import { runUnscoped } from '@rasta/nest-common';
import { asActor, cleanup, newPrisma, readBalances, tenants, wire, type Wiring } from './helpers';
import { PaymentService } from '../src/payment/payment.service';
import { walletBalanceLimit } from '../src/wallet/wallet.repository';
import { MockPaymentProvider } from '../src/payment/mock.provider';
import { ECONOMIC_EVENTS } from '../src/events/events';
import type { PrismaService } from '../src/prisma/prisma.service';
import type { RefundRequest } from '../src/payment/provider';

/**
 * Two paths that returned money to the payer and kept it in the wallet
 * (PR #140 STEP 0, R2 and U6; ADR-064). Each was reproduced by a failing test
 * before its fix.
 *
 * R2: an operator refund asked the provider first and checked the balance
 *     after. A top-up already spent was refunded at the provider, the ledger
 *     then refused the reversal, and the wallet kept the credit. A check
 *     before the provider call is not enough on its own (round 1 on #143): the
 *     amount is held until the provider answers.
 *
 * U6: a provider refund that *threw* after a capture the ledger could not
 *     credit was treated as refused. A same-key retry then credited the
 *     wallet without asking whether the provider had in fact refunded.
 */
describe('payment outcomes that must not be guessed (real database)', () => {
  let prisma: PrismaService;
  let wiring: Wiring;
  let payments: PaymentService;
  let provider: MockPaymentProvider;
  const org = tenants();

  beforeAll(() => {
    prisma = newPrisma();
    wiring = wire(prisma);
    provider = new MockPaymentProvider();
    payments = new PaymentService(
      prisma,
      wiring.ledger,
      wiring.wallets,
      wiring.walletRepository,
      provider,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await cleanup(prisma, [org.a, org.b, org.c]);
    await prisma.onModuleDestroy();
  });

  const intentsOf = (organizationId: string) =>
    runUnscoped('the suite reads the intents it created', () =>
      prisma.client.paymentIntent.findMany({ where: { organizationId } }),
    );

  const eventsOf = (organizationId: string, eventName: string) =>
    runUnscoped('the suite reads the outbox rows it caused', () =>
      prisma.client.outboxMessage.findMany({ where: { organizationId, eventName } }),
    );

  async function topUp(organizationId: string, amountMinor: bigint, idempotencyKey: string) {
    const wallet = await asActor({ organizationId }, () => wiring.wallets.getOrOpen('IRR'));
    const result = await asActor({ organizationId }, () =>
      payments.topUp(wallet.id, { amountMinor: amountMinor.toString(), idempotencyKey }),
    );
    return { walletId: wallet.id, result };
  }

  /** Takes `amountMinor` out of the wallet's available balance with a hold. */
  async function spend(organizationId: string, walletId: string, amountMinor: bigint) {
    await asActor({ organizationId }, () =>
      wiring.prisma.transaction(async (tx) => {
        const [locked] = await wiring.walletRepository.lock(tx, [walletId]);
        await wiring.wallets.placeHold(tx, {
          wallet: locked!,
          amountMinor,
          reference: `TXN_${ulid()}`,
          referenceType: 'TRANSACTION',
          transactionId: `TXN_${ulid()}`,
          placedBy: 'unknown-outcome-itest',
        });
      }),
    );
  }

  /**
   * A provider refund whose response is lost: the provider refunds, and the
   * caller sees an error. The effect is real, the answer never arrives.
   */
  function loseRefundResponse() {
    const real = provider.refund.bind(provider);
    return jest.spyOn(provider, 'refund').mockImplementationOnce(async (request: RefundRequest) => {
      await real(request);
      throw new Error('provider response lost');
    });
  }

  const holdsOf = (walletId: string) =>
    runUnscoped('the suite reads the holds on its wallet', () =>
      prisma.client.walletHold.findMany({ where: { walletId, referenceType: 'PAYMENT_REFUND' } }),
    );

  const refundBy = (organizationId: string, intentId: string, reason = 'the suite refunds') =>
    asActor({ organizationId }, () => payments.refund(intentId, reason));

  /** A promise and the function that settles it. */
  function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((settle) => (resolve = settle));
    return { promise, resolve };
  }

  describe('R2 — an operator refund holds the money until the provider answers', () => {
    it('refuses a top-up that has been spent before the provider is asked, and moves nothing', async () => {
      const organizationId = `${org.a}-R2`;
      const { walletId, result } = await topUp(organizationId, 1_000n, `R2-${ulid()}`);
      expect(result.status).toBe('CAPTURED');
      await spend(organizationId, walletId, 600n);
      const refund = jest.spyOn(provider, 'refund');

      await expect(refundBy(organizationId, result.paymentIntentId)).rejects.toMatchObject({
        code: 'INSUFFICIENT_BALANCE',
      });

      // The payer is not refunded while the wallet keeps the credit.
      expect(refund).not.toHaveBeenCalled();
      const [intent] = await intentsOf(organizationId);
      expect(intent).toMatchObject({ status: 'CAPTURED', refundedAt: null, failureReason: null });
      expect(await provider.getStatus(intent!.providerReference!)).toBe('CAPTURED');
      expect(await holdsOf(walletId)).toHaveLength(0);
      expect(await readBalances(prisma, walletId)).toMatchObject({
        ledger: 1_000n,
        available: 400n,
        pending: 600n,
      });

      await cleanup(prisma, [organizationId]);
    });

    it('makes a spend during the provider call fail on the hold, not the reversal', async () => {
      // Round 1 on #143, finding 1: the pre-check used to commit and release
      // its locks, a spend then committed while the provider refunded, and
      // the reversal was refused — payer refunded, wallet still credited.
      const organizationId = `${org.a}-R2-SPEND`;
      const { walletId, result } = await topUp(organizationId, 1_000n, `R2SPEND-${ulid()}`);
      const real = provider.refund.bind(provider);
      let spendDuringCall: unknown;
      jest.spyOn(provider, 'refund').mockImplementationOnce(async (request: RefundRequest) => {
        // The provider is being asked: the amount is already held.
        expect(await readBalances(prisma, walletId)).toMatchObject({
          available: 0n,
          pending: 1_000n,
        });
        spendDuringCall = await spend(organizationId, walletId, 700n).catch((e: unknown) => e);
        return real(request);
      });

      const refunded = await refundBy(organizationId, result.paymentIntentId);

      expect(spendDuringCall).toMatchObject({ code: 'INSUFFICIENT_BALANCE' });
      expect(refunded.balances).toMatchObject({
        ledgerBalanceMinor: 0n,
        availableBalanceMinor: 0n,
        pendingBalanceMinor: 0n,
      });
      expect((await intentsOf(organizationId))[0]).toMatchObject({
        status: 'REFUNDED',
        failureReason: null,
      });
      const [hold] = await holdsOf(walletId);
      expect(hold).toMatchObject({ status: 'REFUNDED', reference: result.paymentIntentId });
      expect(
        await eventsOf(organizationId, ECONOMIC_EVENTS.PAYMENT_REFUND_UNRECONCILED),
      ).toHaveLength(0);

      await cleanup(prisma, [organizationId]);
    });

    it('returns the held money when the provider declines, and a later refund still works', async () => {
      const organizationId = `${org.a}-R2-DECLINE`;
      const { walletId, result } = await topUp(organizationId, 500n, `R2DECL-${ulid()}`);
      jest.spyOn(provider, 'refund').mockResolvedValueOnce({
        outcome: 'FAILED',
        providerReference: 'x',
        failureCode: 'NOT_PERMITTED',
        simulated: true,
      });

      await expect(refundBy(organizationId, result.paymentIntentId)).rejects.toMatchObject({
        code: 'BUSINESS_RULE_VIOLATION',
      });
      expect((await intentsOf(organizationId))[0]).toMatchObject({
        status: 'CAPTURED',
        failureReason: null,
      });
      expect(await readBalances(prisma, walletId)).toMatchObject({
        ledger: 500n,
        available: 500n,
        pending: 0n,
      });
      expect((await holdsOf(walletId)).map((hold) => hold.status)).toEqual(['REFUNDED']);

      await refundBy(organizationId, result.paymentIntentId);
      expect((await intentsOf(organizationId))[0]).toMatchObject({ status: 'REFUNDED' });
      expect((await readBalances(prisma, walletId)).ledger).toBe(0n);

      await cleanup(prisma, [organizationId]);
    });
  });

  describe('R2 — a refund whose outcome is not recorded is never lost or repeated', () => {
    it('marks a lost provider response REFUND_UNKNOWN, keeps the hold, and refuses a second refund', async () => {
      // Round 1 on #143, finding 2.
      const organizationId = `${org.b}-R2-LOST`;
      const { walletId, result } = await topUp(organizationId, 900n, `R2LOST-${ulid()}`);
      loseRefundResponse();

      await expect(refundBy(organizationId, result.paymentIntentId)).rejects.toThrow(
        'provider response lost',
      );

      const [intent] = await intentsOf(organizationId);
      expect(intent).toMatchObject({ status: 'CAPTURED', failureReason: 'REFUND_UNKNOWN' });
      expect(await provider.getStatus(intent!.providerReference!)).toBe('REFUNDED');
      const [alert] = await eventsOf(organizationId, ECONOMIC_EVENTS.PAYMENT_REFUND_UNRECONCILED);
      expect(alert?.aggregateId).toBe(result.paymentIntentId);
      expect((alert?.payload as { payload?: { reason?: string } })?.payload?.reason).toBe(
        'PROVIDER_OUTCOME_UNKNOWN',
      );
      // The money stays held: it cannot be spent while the payer may have it.
      expect(await readBalances(prisma, walletId)).toMatchObject({
        ledger: 900n,
        available: 0n,
        pending: 900n,
      });
      expect((await holdsOf(walletId)).map((hold) => hold.status)).toEqual(['ACTIVE']);

      const refund = jest.spyOn(provider, 'refund');
      refund.mockClear();
      await expect(refundBy(organizationId, result.paymentIntentId)).rejects.toMatchObject({
        code: 'BUSINESS_RULE_VIOLATION',
      });
      expect(refund).not.toHaveBeenCalled();
      expect(
        await eventsOf(organizationId, ECONOMIC_EVENTS.PAYMENT_REFUND_UNRECONCILED),
      ).toHaveLength(1);

      await cleanup(prisma, [organizationId]);
    });

    it('keeps REFUND_REQUESTED and the hold when even the unknown outcome cannot be recorded', async () => {
      // A crash after the request is committed looks the same: marked, held,
      // and refused on a second attempt.
      const organizationId = `${org.b}-R2-CRASH`;
      const { walletId, result } = await topUp(organizationId, 400n, `R2CRASH-${ulid()}`);
      loseRefundResponse();
      const enqueue = wiring.ledger.enqueue.bind(wiring.ledger);
      jest.spyOn(wiring.ledger, 'enqueue').mockImplementation(async (tx, input) => {
        if (input.eventName === ECONOMIC_EVENTS.PAYMENT_REFUND_UNRECONCILED) {
          throw new Error('outbox down');
        }
        return enqueue(tx, input);
      });

      await expect(refundBy(organizationId, result.paymentIntentId)).rejects.toThrow(
        'provider response lost',
      );
      expect((await intentsOf(organizationId))[0]).toMatchObject({
        status: 'CAPTURED',
        failureReason: 'REFUND_REQUESTED',
      });
      expect((await readBalances(prisma, walletId)).pending).toBe(400n);

      const refund = jest.spyOn(provider, 'refund');
      refund.mockClear();
      await expect(refundBy(organizationId, result.paymentIntentId)).rejects.toMatchObject({
        code: 'BUSINESS_RULE_VIOLATION',
      });
      expect(refund).not.toHaveBeenCalled();

      await cleanup(prisma, [organizationId]);
    });

    it('marks a refund the ledger could not reverse, and a retry reverses it without the provider', async () => {
      const organizationId = `${org.b}-R2-REVERSAL`;
      const { walletId, result } = await topUp(organizationId, 1_000n, `R2REV-${ulid()}`);
      jest.spyOn(wiring.ledger, 'reverse').mockRejectedValueOnce(new Error('connection reset'));

      await expect(refundBy(organizationId, result.paymentIntentId)).rejects.toThrow(
        'connection reset',
      );
      expect((await intentsOf(organizationId))[0]).toMatchObject({
        status: 'CAPTURED',
        failureReason: 'REFUNDED_NOT_REVERSED',
      });
      const [alert] = await eventsOf(organizationId, ECONOMIC_EVENTS.PAYMENT_REFUND_UNRECONCILED);
      expect((alert?.payload as { payload?: { reason?: string } })?.payload?.reason).toBe(
        'REVERSAL_FAILED',
      );
      // Held, so nothing can spend what the payer already has back.
      expect(await readBalances(prisma, walletId)).toMatchObject({
        ledger: 1_000n,
        available: 0n,
        pending: 1_000n,
      });

      const refund = jest.spyOn(provider, 'refund');
      refund.mockClear();
      await refundBy(organizationId, result.paymentIntentId, 'the suite retries the refund');
      expect(refund).not.toHaveBeenCalled();
      expect((await intentsOf(organizationId))[0]).toMatchObject({
        status: 'REFUNDED',
        failureReason: null,
      });
      expect(await readBalances(prisma, walletId)).toMatchObject({
        ledger: 0n,
        available: 0n,
        pending: 0n,
      });
      expect((await holdsOf(walletId)).map((hold) => hold.status)).toEqual(['REFUNDED']);
      expect(
        await eventsOf(organizationId, ECONOMIC_EVENTS.PAYMENT_REFUND_UNRECONCILED),
      ).toHaveLength(1);

      await cleanup(prisma, [organizationId]);
    });

    it('records a known decline whose hold could not be returned, and a retry only returns it, once', async () => {
      // Round 2 on #143, finding 1: the provider declined, returning the hold
      // failed, and the intent sat in REFUND_REQUESTED — every later refund
      // refused, nothing announced.
      const organizationId = `${org.c}-R2-DECLINE-STUCK`;
      const { walletId, result } = await topUp(organizationId, 600n, `R2DS-${ulid()}`);
      jest.spyOn(provider, 'refund').mockResolvedValueOnce({
        outcome: 'FAILED',
        providerReference: 'x',
        failureCode: 'NOT_PERMITTED',
        simulated: true,
      });
      jest.spyOn(wiring.wallets, 'refundHold').mockRejectedValueOnce(new Error('connection reset'));

      // The caller still hears the provider's answer.
      await expect(refundBy(organizationId, result.paymentIntentId)).rejects.toMatchObject({
        code: 'BUSINESS_RULE_VIOLATION',
        internalContext: { code: 'NOT_PERMITTED' },
      });
      expect((await intentsOf(organizationId))[0]).toMatchObject({
        status: 'CAPTURED',
        failureReason: 'REFUND_DECLINED_RELEASE_PENDING',
      });
      const [alert] = await eventsOf(organizationId, ECONOMIC_EVENTS.PAYMENT_REFUND_UNRECONCILED);
      expect(alert?.aggregateId).toBe(result.paymentIntentId);
      expect((alert?.payload as { payload?: { reason?: string } })?.payload?.reason).toBe(
        'PROVIDER_DECLINED_RELEASE_PENDING',
      );
      expect((await holdsOf(walletId)).map((hold) => hold.status)).toEqual(['ACTIVE']);
      expect((await readBalances(prisma, walletId)).pending).toBe(600n);

      // The retry returns the hold and nothing else.
      const refund = jest.spyOn(provider, 'refund');
      refund.mockClear();
      await expect(refundBy(organizationId, result.paymentIntentId)).rejects.toMatchObject({
        code: 'BUSINESS_RULE_VIOLATION',
        internalContext: { outcome: 'REFUND_DECLINED' },
      });
      expect(refund).not.toHaveBeenCalled();
      expect((await intentsOf(organizationId))[0]).toMatchObject({
        status: 'CAPTURED',
        failureReason: null,
      });
      expect(await readBalances(prisma, walletId)).toMatchObject({
        ledger: 600n,
        available: 600n,
        pending: 0n,
      });
      expect((await holdsOf(walletId)).map((hold) => hold.status)).toEqual(['REFUNDED']);
      // Returned exactly once: one release event, one returning journal.
      expect(await eventsOf(organizationId, ECONOMIC_EVENTS.FUNDS_RELEASED)).toHaveLength(1);
      const returningJournals = await runUnscoped('the suite counts the hold journals', () =>
        prisma.client.journal.count({
          where: { organizationId, journalType: 'FUNDS_REFUNDED' },
        }),
      );
      expect(returningJournals).toBe(1);

      // And the intent is an ordinary captured top-up again.
      await refundBy(organizationId, result.paymentIntentId);
      expect((await intentsOf(organizationId))[0]).toMatchObject({ status: 'REFUNDED' });
      expect((await readBalances(prisma, walletId)).ledger).toBe(0n);

      await cleanup(prisma, [organizationId]);
    });

    it('keeps REFUND_REQUESTED and the hold when neither the hold nor the decline can be recorded', async () => {
      // The last resort ADR-064 names: the reconciler escalates this row.
      const organizationId = `${org.c}-R2-DECLINE-LOST`;
      const { walletId, result } = await topUp(organizationId, 350n, `R2DL-${ulid()}`);
      jest.spyOn(provider, 'refund').mockResolvedValueOnce({
        outcome: 'FAILED',
        providerReference: 'x',
        failureCode: 'NOT_PERMITTED',
        simulated: true,
      });
      jest.spyOn(wiring.wallets, 'refundHold').mockRejectedValueOnce(new Error('connection reset'));
      const enqueue = wiring.ledger.enqueue.bind(wiring.ledger);
      jest.spyOn(wiring.ledger, 'enqueue').mockImplementation(async (tx, input) => {
        if (input.eventName === ECONOMIC_EVENTS.PAYMENT_REFUND_UNRECONCILED) {
          throw new Error('outbox down');
        }
        return enqueue(tx, input);
      });

      await expect(refundBy(organizationId, result.paymentIntentId)).rejects.toMatchObject({
        code: 'BUSINESS_RULE_VIOLATION',
      });
      expect((await intentsOf(organizationId))[0]).toMatchObject({
        status: 'CAPTURED',
        failureReason: 'REFUND_REQUESTED',
      });
      expect((await readBalances(prisma, walletId)).pending).toBe(350n);

      const refund = jest.spyOn(provider, 'refund');
      refund.mockClear();
      await expect(refundBy(organizationId, result.paymentIntentId)).rejects.toMatchObject({
        code: 'BUSINESS_RULE_VIOLATION',
        internalContext: { outcome: 'REFUND_REQUESTED' },
      });
      expect(refund).not.toHaveBeenCalled();

      await cleanup(prisma, [organizationId]);
    });

    it.each([
      'REFUND_REQUESTED',
      'REFUND_UNKNOWN',
      'REFUNDED_NOT_REVERSED',
      'REFUND_DECLINED_RELEASE_PENDING',
    ])(
      'answers a same-key top-up retry of an intent marked %s as unfinished, not CAPTURED',
      async (marker) => {
        // Round 1 on #143, finding 3. Each marker is produced for real by the
        // tests above; here it is written directly so the retry is isolated.
        const organizationId = `${org.c}-RESUME-${marker}`;
        const key = `RESUME-${ulid()}`;
        const { result } = await topUp(organizationId, 250n, key);
        await runUnscoped('the suite marks the intent', () =>
          prisma.client.paymentIntent.update({
            where: { id: result.paymentIntentId },
            data: { failureReason: marker },
          }),
        );

        await expect(topUp(organizationId, 250n, key)).rejects.toMatchObject({
          code: 'BUSINESS_RULE_VIOLATION',
        });

        await cleanup(prisma, [organizationId]);
      },
    );
  });

  describe('R2 — concurrency and tenancy', () => {
    it('lets exactly one of two refunds that both passed the first read reach the provider', async () => {
      // Barrier-controlled: both refunds read the intent as CAPTURED and
      // both reach the intent's row lock before either takes it. The loser
      // must be refused before the provider is asked; the winner's provider
      // call waits for that refusal, so no ordering is left to chance.
      const organizationId = `${org.c}-R2-RACE`;
      const { walletId, result } = await topUp(organizationId, 800n, `R2RACE-${ulid()}`);

      const internals = payments as unknown as {
        lockIntent: (...args: unknown[]) => Promise<string | undefined>;
      };
      const lockIntent = internals.lockIntent.bind(payments);
      const bothAtTheLock = deferred();
      let arrived = 0;
      jest.spyOn(internals, 'lockIntent').mockImplementation(async (...args: unknown[]) => {
        if (arrived < 2) {
          arrived += 1;
          if (arrived === 2) bothAtTheLock.resolve();
          await bothAtTheLock.promise;
        }
        return lockIntent(...args);
      });

      const refused = deferred();
      const real = provider.refund.bind(provider);
      const refund = jest
        .spyOn(provider, 'refund')
        .mockImplementation(async (request: RefundRequest) => {
          // A second call means both got through: stop waiting, so the
          // assertion below fails at once instead of the test hanging.
          if (refund.mock.calls.length > 1) refused.resolve();
          await refused.promise;
          return real(request);
        });
      const attempt = () =>
        refundBy(organizationId, result.paymentIntentId).catch((error: unknown) => {
          refused.resolve();
          throw error;
        });

      const outcomes = await Promise.allSettled([attempt(), attempt()]);

      expect(arrived).toBe(2);
      expect(refund).toHaveBeenCalledTimes(1);
      expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
      const [loser] = outcomes.filter((o) => o.status === 'rejected');
      expect((loser as PromiseRejectedResult).reason).toMatchObject({
        code: 'BUSINESS_RULE_VIOLATION',
        internalContext: { outcome: 'REFUND_REQUESTED' },
      });
      expect(await readBalances(prisma, walletId)).toMatchObject({ ledger: 0n, pending: 0n });
      expect((await intentsOf(organizationId))[0]).toMatchObject({
        status: 'REFUNDED',
        failureReason: null,
      });
      expect(await holdsOf(walletId)).toHaveLength(1);

      await cleanup(prisma, [organizationId]);
    });

    it('does not let another tenant refund, or learn anything about, an intent', async () => {
      const owner = `${org.a}-R2-OWNER`;
      const other = `${org.b}-R2-OTHER`;
      const { walletId, result } = await topUp(owner, 300n, `R2OWN-${ulid()}`);
      await asActor({ organizationId: other }, () => wiring.wallets.getOrOpen('IRR'));
      const refund = jest.spyOn(provider, 'refund');

      await expect(refundBy(other, result.paymentIntentId)).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });

      expect(refund).not.toHaveBeenCalled();
      expect((await intentsOf(owner))[0]).toMatchObject({
        status: 'CAPTURED',
        failureReason: null,
      });
      expect((await readBalances(prisma, walletId)).ledger).toBe(300n);
      expect(await holdsOf(walletId)).toHaveLength(0);
      expect(await eventsOf(other, ECONOMIC_EVENTS.PAYMENT_REFUND_UNRECONCILED)).toHaveLength(0);

      await cleanup(prisma, [owner, other]);
    });
  });

  describe('R2 — refusals, and outcomes decided elsewhere', () => {
    const setWalletStatus = (walletId: string, status: 'ACTIVE' | 'FROZEN') =>
      runUnscoped('the suite freezes or thaws its wallet', () =>
        prisma.client.wallet.update({ where: { id: walletId }, data: { status } }),
      );

    it('refuses a refund from a frozen wallet before any hold or provider call, and allows it once active', async () => {
      // PM ruling, round 2 on #143: no money leaves a frozen wallet.
      const organizationId = `${org.a}-R2-FROZEN`;
      const { walletId, result } = await topUp(organizationId, 700n, `R2FRZ-${ulid()}`);
      await setWalletStatus(walletId, 'FROZEN');
      const refund = jest.spyOn(provider, 'refund');

      await expect(refundBy(organizationId, result.paymentIntentId)).rejects.toMatchObject({
        code: 'BUSINESS_RULE_VIOLATION',
        status: 422,
        internalContext: { walletStatus: 'FROZEN' },
      });
      expect(refund).not.toHaveBeenCalled();
      expect(await holdsOf(walletId)).toHaveLength(0);
      expect((await intentsOf(organizationId))[0]).toMatchObject({
        status: 'CAPTURED',
        failureReason: null,
      });
      expect(await readBalances(prisma, walletId)).toMatchObject({
        ledger: 700n,
        available: 700n,
        pending: 0n,
      });

      await setWalletStatus(walletId, 'ACTIVE');
      await refundBy(organizationId, result.paymentIntentId);
      expect((await intentsOf(organizationId))[0]).toMatchObject({ status: 'REFUNDED' });

      await cleanup(prisma, [organizationId]);
    });

    it('does not reverse from a frozen wallet what the provider refunded; it waits, held', async () => {
      const organizationId = `${org.a}-R2-FROZEN-REV`;
      const { walletId, result } = await topUp(organizationId, 450n, `R2FRZR-${ulid()}`);
      jest.spyOn(wiring.ledger, 'reverse').mockRejectedValueOnce(new Error('connection reset'));
      await expect(refundBy(organizationId, result.paymentIntentId)).rejects.toThrow(
        'connection reset',
      );
      await setWalletStatus(walletId, 'FROZEN');

      await expect(refundBy(organizationId, result.paymentIntentId)).rejects.toMatchObject({
        code: 'BUSINESS_RULE_VIOLATION',
        internalContext: { walletStatus: 'FROZEN' },
      });
      expect((await intentsOf(organizationId))[0]).toMatchObject({
        failureReason: 'REFUNDED_NOT_REVERSED',
      });
      expect((await readBalances(prisma, walletId)).pending).toBe(450n);

      await setWalletStatus(walletId, 'ACTIVE');
      await refundBy(organizationId, result.paymentIntentId);
      expect((await readBalances(prisma, walletId)).ledger).toBe(0n);

      await cleanup(prisma, [organizationId]);
    });

    it('marks INSUFFICIENT_BALANCE when the defence check after returning the hold refuses', async () => {
      // The hold makes this unreachable in practice; the defence still
      // records rather than guesses if it ever fires.
      const organizationId = `${org.b}-R2-DEFENCE`;
      const { walletId, result } = await topUp(organizationId, 500n, `R2DEF-${ulid()}`);
      jest.spyOn(wiring.wallets, 'refundHold').mockResolvedValueOnce({
        journalId: 'JRN_STAND_IN',
        amountMinor: 500n,
        balances: {
          ledgerBalanceMinor: 500n,
          availableBalanceMinor: 0n,
          pendingBalanceMinor: 500n,
        },
      });

      await expect(refundBy(organizationId, result.paymentIntentId)).rejects.toMatchObject({
        code: 'INSUFFICIENT_BALANCE',
      });
      expect((await intentsOf(organizationId))[0]).toMatchObject({
        status: 'CAPTURED',
        failureReason: 'REFUNDED_NOT_REVERSED',
      });
      const [alert] = await eventsOf(organizationId, ECONOMIC_EVENTS.PAYMENT_REFUND_UNRECONCILED);
      expect((alert?.payload as { payload?: { reason?: string } })?.payload?.reason).toBe(
        'INSUFFICIENT_BALANCE',
      );
      // Rolled back whole: the hold is still active, nothing reversed.
      expect(await readBalances(prisma, walletId)).toMatchObject({ ledger: 500n, pending: 500n });

      await cleanup(prisma, [organizationId]);
    });

    it('refuses to reverse when its hold is not active, and marks it once', async () => {
      const organizationId = `${org.b}-R2-NOHOLD`;
      const { result } = await topUp(organizationId, 320n, `R2NOH-${ulid()}`);
      jest.spyOn(wiring.wallets, 'refundHold').mockResolvedValueOnce(null);

      await expect(refundBy(organizationId, result.paymentIntentId)).rejects.toMatchObject({
        code: 'INTERNAL_ERROR',
      });
      expect((await intentsOf(organizationId))[0]).toMatchObject({
        failureReason: 'REFUNDED_NOT_REVERSED',
      });

      // The retry finds no hold at all: refused again, not announced twice.
      jest.spyOn(wiring.walletRepository, 'findActiveHold').mockResolvedValueOnce(null);
      await expect(refundBy(organizationId, result.paymentIntentId)).rejects.toMatchObject({
        code: 'INTERNAL_ERROR',
      });
      expect(
        await eventsOf(organizationId, ECONOMIC_EVENTS.PAYMENT_REFUND_UNRECONCILED),
      ).toHaveLength(1);

      await cleanup(prisma, [organizationId]);
    });

    it('marks nothing when its marker was cleared while the provider was asked', async () => {
      // Someone (a person, later the reconciler) resolved it meanwhile: the
      // refund does not overwrite a decision it did not make.
      const organizationId = `${org.b}-R2-CLEARED`;
      const { result } = await topUp(organizationId, 280n, `R2CLR-${ulid()}`);
      const real = provider.refund.bind(provider);
      jest.spyOn(provider, 'refund').mockImplementationOnce(async (request: RefundRequest) => {
        await runUnscoped('the suite clears the marker', () =>
          prisma.client.paymentIntent.update({
            where: { id: result.paymentIntentId },
            data: { failureReason: null },
          }),
        );
        return real(request);
      });

      await expect(refundBy(organizationId, result.paymentIntentId)).rejects.toMatchObject({
        code: 'INTERNAL_ERROR',
      });
      expect((await intentsOf(organizationId))[0]).toMatchObject({
        status: 'CAPTURED',
        failureReason: null,
      });
      expect(
        await eventsOf(organizationId, ECONOMIC_EVENTS.PAYMENT_REFUND_UNRECONCILED),
      ).toHaveLength(0);

      await cleanup(prisma, [organizationId]);
    });

    it('marks nothing when the intent was refunded elsewhere while the provider was asked', async () => {
      const organizationId = `${org.c}-R2-ELSEWHERE`;
      const { result } = await topUp(organizationId, 260n, `R2ELS-${ulid()}`);
      const real = provider.refund.bind(provider);
      jest.spyOn(provider, 'refund').mockImplementationOnce(async (request: RefundRequest) => {
        await runUnscoped('the suite resolves the intent elsewhere', () =>
          prisma.client.paymentIntent.update({
            where: { id: result.paymentIntentId },
            data: { status: 'REFUNDED', refundedAt: new Date(), failureReason: null },
          }),
        );
        return real(request);
      });

      await expect(refundBy(organizationId, result.paymentIntentId)).rejects.toMatchObject({
        code: 'INVALID_STATE_TRANSITION',
      });
      expect(
        await eventsOf(organizationId, ECONOMIC_EVENTS.PAYMENT_REFUND_UNRECONCILED),
      ).toHaveLength(0);

      await cleanup(prisma, [organizationId]);
    });

    it('asks the provider under the intent id when no provider reference was recorded', async () => {
      const organizationId = `${org.c}-R2-NOREF`;
      const { result } = await topUp(organizationId, 240n, `R2NOREF-${ulid()}`);
      await runUnscoped('the suite blanks the reference', () =>
        prisma.client.paymentIntent.update({
          where: { id: result.paymentIntentId },
          data: { providerReference: null },
        }),
      );
      const refund = jest.spyOn(provider, 'refund');

      await refundBy(organizationId, result.paymentIntentId);
      expect(refund).toHaveBeenCalledWith(
        expect.objectContaining({ providerReference: result.paymentIntentId }),
      );

      await cleanup(prisma, [organizationId]);
    });

    it('records the failure even when what failed was not an Error', async () => {
      // A driver or provider SDK may reject with a bare value.
      const organizationId = `${org.c}-R2-NONERROR`;
      const { result } = await topUp(organizationId, 230n, `R2NE-${ulid()}`);
      jest.spyOn(provider, 'refund').mockResolvedValueOnce({
        outcome: 'FAILED',
        providerReference: 'x',
        failureCode: 'NOT_PERMITTED',
        simulated: true,
      });
      jest.spyOn(wiring.wallets, 'refundHold').mockRejectedValueOnce('connection reset');
      const enqueue = wiring.ledger.enqueue.bind(wiring.ledger);
      jest.spyOn(wiring.ledger, 'enqueue').mockImplementation(async (tx, input) => {
        if (input.eventName === ECONOMIC_EVENTS.PAYMENT_REFUND_UNRECONCILED) {
          throw 'outbox down';
        }
        return enqueue(tx, input);
      });

      await expect(refundBy(organizationId, result.paymentIntentId)).rejects.toMatchObject({
        code: 'BUSINESS_RULE_VIOLATION',
      });
      expect((await intentsOf(organizationId))[0]).toMatchObject({
        failureReason: 'REFUND_REQUESTED',
      });

      await cleanup(prisma, [organizationId]);
    });
  });

  describe('U6 — a refund of an uncreditable capture whose answer is lost', () => {
    it('is recorded as unknown, not as refused', async () => {
      const organizationId = `${org.c}-U6-MARK`;
      jest
        .spyOn(wiring.wallets, 'credit')
        .mockRejectedValueOnce(walletBalanceLimit('WLT_STAND_IN'));
      loseRefundResponse();

      await expect(topUp(organizationId, 900n, `U6M-${ulid()}`)).rejects.toMatchObject({
        code: 'BUSINESS_RULE_VIOLATION',
      });

      const [intent] = await intentsOf(organizationId);
      expect(intent).toMatchObject({
        status: 'AUTHORIZED',
        failureReason: 'CAPTURED_REFUND_UNKNOWN',
      });
      const [alert] = await eventsOf(organizationId, ECONOMIC_EVENTS.PAYMENT_CAPTURE_UNRECONCILED);
      expect(alert?.aggregateId).toBe(intent?.id);
      expect(
        (alert?.payload as { payload?: { providerRefund?: string } })?.payload?.providerRefund,
      ).toBe('UNKNOWN');

      await cleanup(prisma, [organizationId]);
    });

    it('is never credited by a same-key retry, and the provider is not asked to act again', async () => {
      const organizationId = `${org.c}-U6-RETRY`;
      const key = `U6R-${ulid()}`;
      jest
        .spyOn(wiring.wallets, 'credit')
        .mockRejectedValueOnce(walletBalanceLimit('WLT_STAND_IN'));
      loseRefundResponse();
      await expect(topUp(organizationId, 750n, key)).rejects.toMatchObject({
        code: 'BUSINESS_RULE_VIOLATION',
      });
      const [intent] = await intentsOf(organizationId);
      // The provider did refund.
      expect(await provider.getStatus(intent!.providerReference!)).toBe('REFUNDED');

      // The spies of the first attempt, with its calls forgotten.
      const credit = jest.spyOn(wiring.wallets, 'credit');
      const authorize = jest.spyOn(provider, 'authorize');
      const capture = jest.spyOn(provider, 'capture');
      const refund = jest.spyOn(provider, 'refund');
      for (const spy of [credit, authorize, capture, refund]) spy.mockClear();
      await expect(topUp(organizationId, 750n, key)).rejects.toMatchObject({
        code: 'BUSINESS_RULE_VIOLATION',
      });

      expect(credit).not.toHaveBeenCalled();
      expect(authorize).not.toHaveBeenCalled();
      expect(capture).not.toHaveBeenCalled();
      expect(refund).not.toHaveBeenCalled();
      const wallet = await asActor({ organizationId }, () => wiring.wallets.getOrOpen('IRR'));
      expect((await readBalances(prisma, wallet.id)).ledger).toBe(0n);
      expect(await eventsOf(organizationId, ECONOMIC_EVENTS.PAYMENT_COMPLETED)).toHaveLength(0);
      expect((await intentsOf(organizationId))[0]).toMatchObject({
        status: 'AUTHORIZED',
        failureReason: 'CAPTURED_REFUND_UNKNOWN',
      });

      await cleanup(prisma, [organizationId]);
    });

    it('still credits on retry when the provider declined the refund outright', async () => {
      // A declined refund is an answer: the provider still holds the capture.
      const organizationId = `${org.c}-U6-DECLINED`;
      const key = `U6D-${ulid()}`;
      jest
        .spyOn(wiring.wallets, 'credit')
        .mockRejectedValueOnce(walletBalanceLimit('WLT_STAND_IN'));
      jest.spyOn(provider, 'refund').mockResolvedValueOnce({
        outcome: 'FAILED',
        providerReference: 'x',
        failureCode: 'PROVIDER_UNAVAILABLE',
        simulated: true,
      });
      await expect(topUp(organizationId, 640n, key)).rejects.toMatchObject({
        code: 'BUSINESS_RULE_VIOLATION',
      });
      expect((await intentsOf(organizationId))[0]).toMatchObject({
        failureReason: 'CAPTURED_NOT_CREDITED',
      });
      const [alert] = await eventsOf(organizationId, ECONOMIC_EVENTS.PAYMENT_CAPTURE_UNRECONCILED);
      expect(
        (alert?.payload as { payload?: { providerRefund?: string } })?.payload?.providerRefund,
      ).toBe('DECLINED');

      const { result } = await topUp(organizationId, 640n, key);
      expect(result).toMatchObject({ status: 'CAPTURED', amountMinor: 640n });

      await cleanup(prisma, [organizationId]);
    });
  });
});
