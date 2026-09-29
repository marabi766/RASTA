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
 * (PR #140 STEP 0, R2 and U6; ADR-064). Each test was written first and failed
 * on `main` before the fix beside it.
 *
 * R2: an operator refund asked the provider first and checked the balance
 *     after. A top-up already spent was refunded at the provider, the ledger
 *     then refused the reversal, and the wallet kept the credit.
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

  describe('R2 — an operator refund of a top-up that has been spent', () => {
    it('is refused before the provider is asked, and nothing moves', async () => {
      const organizationId = `${org.a}-R2`;
      const { walletId, result } = await topUp(organizationId, 1_000n, `R2-${ulid()}`);
      expect(result.status).toBe('CAPTURED');
      await spend(organizationId, walletId, 600n);
      const refund = jest.spyOn(provider, 'refund');

      await expect(
        asActor({ organizationId }, () =>
          payments.refund(result.paymentIntentId, 'the suite refunds a spent top-up'),
        ),
      ).rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE' });

      // The provider was never asked: the payer is not refunded while the
      // wallet keeps the credit.
      expect(refund).not.toHaveBeenCalled();
      const [intent] = await intentsOf(organizationId);
      expect(intent).toMatchObject({ status: 'CAPTURED', refundedAt: null });
      expect(await provider.getStatus(intent!.providerReference!)).toBe('CAPTURED');
      expect(await readBalances(prisma, walletId)).toMatchObject({
        ledger: 1_000n,
        available: 400n,
        pending: 600n,
      });

      await cleanup(prisma, [organizationId]);
    });

    it('still refunds a top-up the wallet can return', async () => {
      const organizationId = `${org.a}-R2-OK`;
      const { walletId, result } = await topUp(organizationId, 1_000n, `R2OK-${ulid()}`);
      await spend(organizationId, walletId, 400n);
      await expect(
        asActor({ organizationId }, () => wiring.wallets.getById(walletId)),
      ).resolves.toMatchObject({ availableBalanceMinor: 600n });

      // 600 available cannot return 1 000; a second top-up makes it 1 100.
      await topUp(organizationId, 500n, `R2OK-${ulid()}`);
      const refunded = await asActor({ organizationId }, () =>
        payments.refund(result.paymentIntentId, 'the suite refunds a covered top-up'),
      );
      expect(refunded.balances.availableBalanceMinor).toBe(100n);
      expect(
        (await intentsOf(organizationId)).find((i) => i.id === result.paymentIntentId),
      ).toMatchObject({ status: 'REFUNDED' });

      await cleanup(prisma, [organizationId]);
    });

    it('re-checks under the locks after the provider answers, and marks a refund it could not reverse', async () => {
      // The window the pre-check cannot close without a hold (ADR-064; PR B):
      // the wallet is spent between the check and the ledger write. The
      // provider has refunded, so the row is marked and announced rather
      // than left looking CAPTURED.
      const organizationId = `${org.b}-R2-RACE`;
      const { walletId, result } = await topUp(organizationId, 1_000n, `R2RACE-${ulid()}`);
      const real = provider.refund.bind(provider);
      jest.spyOn(provider, 'refund').mockImplementationOnce(async (request: RefundRequest) => {
        const answer = await real(request);
        await spend(organizationId, walletId, 700n);
        return answer;
      });

      await expect(
        asActor({ organizationId }, () =>
          payments.refund(result.paymentIntentId, 'the suite races a spend'),
        ),
      ).rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE' });

      const [intent] = await intentsOf(organizationId);
      expect(intent).toMatchObject({ status: 'CAPTURED', failureReason: 'REFUNDED_NOT_REVERSED' });
      const [alert] = await eventsOf(organizationId, ECONOMIC_EVENTS.PAYMENT_REFUND_UNRECONCILED);
      expect(alert?.aggregateId).toBe(result.paymentIntentId);
      expect((await readBalances(prisma, walletId)).ledger).toBe(1_000n);

      // A second refund attempt does not ask the provider again or reverse
      // what the wallet cannot return.
      const refund = jest.spyOn(provider, 'refund');
      refund.mockClear();
      await expect(
        asActor({ organizationId }, () =>
          payments.refund(result.paymentIntentId, 'the suite retries the refund'),
        ),
      ).rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE' });
      expect(refund).not.toHaveBeenCalled();

      await cleanup(prisma, [organizationId]);
    });
  });

  describe('R2 — concurrency and tenancy', () => {
    it('reverses a top-up once when two refunds race to it', async () => {
      const organizationId = `${org.b}-R2-TWICE`;
      const { walletId, result } = await topUp(organizationId, 800n, `R2TWICE-${ulid()}`);

      const outcomes = await Promise.allSettled([
        asActor({ organizationId }, () => payments.refund(result.paymentIntentId, 'first')),
        asActor({ organizationId }, () => payments.refund(result.paymentIntentId, 'second')),
      ]);

      expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
      const [refused] = outcomes.filter((o) => o.status === 'rejected');
      expect((refused as PromiseRejectedResult).reason).toMatchObject({
        code: 'INVALID_STATE_TRANSITION',
      });
      expect(await readBalances(prisma, walletId)).toMatchObject({ ledger: 0n, available: 0n });
      const [intent] = await intentsOf(organizationId);
      expect(intent).toMatchObject({ status: 'REFUNDED', failureReason: null });
      expect(
        await eventsOf(organizationId, ECONOMIC_EVENTS.PAYMENT_REFUND_UNRECONCILED),
      ).toHaveLength(0);

      await cleanup(prisma, [organizationId]);
    });

    it('does not let another tenant refund, or learn anything about, an intent', async () => {
      const owner = `${org.a}-R2-OWNER`;
      const other = `${org.b}-R2-OTHER`;
      const { walletId, result } = await topUp(owner, 300n, `R2OWN-${ulid()}`);
      await asActor({ organizationId: other }, () => wiring.wallets.getOrOpen('IRR'));
      const refund = jest.spyOn(provider, 'refund');

      await expect(
        asActor({ organizationId: other }, () =>
          payments.refund(result.paymentIntentId, 'a foreign tenant tries'),
        ),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });

      expect(refund).not.toHaveBeenCalled();
      expect((await intentsOf(owner))[0]).toMatchObject({
        status: 'CAPTURED',
        failureReason: null,
      });
      expect((await readBalances(prisma, walletId)).ledger).toBe(300n);
      expect(await eventsOf(other, ECONOMIC_EVENTS.PAYMENT_REFUND_UNRECONCILED)).toHaveLength(0);

      await cleanup(prisma, [owner, other]);
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
