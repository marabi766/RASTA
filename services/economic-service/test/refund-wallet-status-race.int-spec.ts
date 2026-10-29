import { ulid } from 'ulid';
import { runUnscoped } from '@rasta/nest-common';
import {
  asActor,
  cleanup,
  newPrisma,
  readBalances,
  tenants,
  testEnv,
  wire,
  type Wiring,
} from './helpers';
import { PaymentService } from '../src/payment/payment.service';
import { PaymentReconciler } from '../src/payment/payment-reconciler';
import { PaymentReconciliationSweeper } from '../src/payment/payment-reconciliation.sweeper';
import { MockPaymentProvider } from '../src/payment/mock.provider';
import { ECONOMIC_EVENTS } from '../src/events/events';
import type { EconomicEnv } from '../src/config/env';
import type { ExtendedPrismaClient, PrismaService } from '../src/prisma/prisma.service';
import type { RefundRequest } from '../src/payment/provider';

/**
 * A refund's ACTIVE check must hold where the money moves (Codex PR-480 r1,
 * R1).
 *
 * The request path checks the wallet under lock in its first transaction,
 * commits, asks the provider, and records the reversal in a second
 * transaction. The first check does not survive the interval: an operator's
 * freeze committed during the provider call — or between a
 * `REFUNDED_NOT_REVERSED` retry's two transactions — was reversed past, and
 * money left a frozen wallet. The reconciler already waited for an ACTIVE
 * wallet; the request path now refuses on the row its recording transaction
 * locked, and leaves the state the reconciler waits on:
 *
 *   - the refund hold, still ACTIVE, for the whole amount;
 *   - `REFUNDED_NOT_REVERSED` on the intent, the open task, no reversal, no
 *     `PAYMENT_REFUNDED`;
 *
 * and once the wallet is ACTIVE again, the reconciler (or the operator's
 * retry of the refund) reverses it exactly once.
 */
describe('a refund whose wallet stops being ACTIVE while the provider is asked (real database)', () => {
  let prisma: PrismaService;
  let wiring: Wiring;
  let payments: PaymentService;
  let provider: MockPaymentProvider;
  let env: EconomicEnv;
  const org = tenants();

  beforeAll(() => {
    prisma = newPrisma();
    wiring = wire(prisma);
    env = testEnv();
    provider = new MockPaymentProvider();
    payments = new PaymentService(
      prisma,
      wiring.ledger,
      wiring.wallets,
      wiring.walletRepository,
      provider,
      wiring.paymentReconciliation,
      env,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await cleanup(prisma, [org.a, org.b, org.c]);
    await prisma.onModuleDestroy();
  });

  type Status = 'ACTIVE' | 'FROZEN' | 'CLOSED';

  /** An operator's status change, committed on its own connection. */
  const setStatus = (walletId: string, status: Status) =>
    runUnscoped('the suite changes the wallet status as an operator would', () =>
      prisma.client.wallet.update({ where: { id: walletId }, data: { status } }),
    );

  const sweep = () =>
    new PaymentReconciliationSweeper(
      wiring.paymentReconciliation,
      new PaymentReconciler(
        prisma,
        payments,
        wiring.paymentReconciliation,
        provider,
        wiring.ledger,
        wiring.walletRepository,
        env,
      ),
      env,
    ).runOnce();

  const makeDue = (paymentIntentId: string) =>
    runUnscoped('the suite makes its task due', () =>
      prisma.client.$executeRawUnsafe(
        `UPDATE payment_reconciliation_task SET next_attempt_at = now() - interval '1 second'
          WHERE payment_intent_id = $1 AND status = 'PENDING'`,
        paymentIntentId,
      ),
    );

  const tasksOf = (paymentIntentId: string) =>
    runUnscoped('the suite reads the tasks', () =>
      prisma.client.$queryRawUnsafe<
        {
          status: string;
          attempts: number;
          lastOutcome: string | null;
          resolution: string | null;
        }[]
      >(
        `SELECT status::text AS status, attempts, last_outcome AS "lastOutcome", resolution
           FROM payment_reconciliation_task WHERE payment_intent_id = $1 ORDER BY created_at, id`,
        paymentIntentId,
      ),
    );

  const intentOf = (paymentIntentId: string) =>
    runUnscoped('the suite reads the intent', () =>
      prisma.client.paymentIntent.findUniqueOrThrow({ where: { id: paymentIntentId } }),
    );

  const refundHoldsOf = (walletId: string) =>
    runUnscoped('the suite reads the refund holds', () =>
      prisma.client.walletHold.findMany({
        where: { walletId, referenceType: 'PAYMENT_REFUND' },
        select: { status: true, amountMinor: true },
      }),
    );

  const eventsOf = async (organizationId: string, eventName: string) => {
    const rows = await runUnscoped('the suite reads the outbox', () =>
      prisma.client.outboxMessage.findMany({ where: { organizationId, eventName } }),
    );
    return rows.map((row) => (row.payload as { payload: Record<string, unknown> }).payload);
  };

  /** Every financial table of the organization, counted, with its wallet's figures. */
  const ledgerOf = (organizationId: string, walletId: string) =>
    runUnscoped('the suite snapshots the financial tables', async () => {
      const client = prisma.client;
      const where = { organizationId };
      return {
        journals: await client.journal.count({ where }),
        reversals: await client.journal.count({ where: { ...where, reversesId: { not: null } } }),
        entries: await client.ledgerEntry.count({ where }),
        holds: await client.walletHold.count({ where }),
        transactions: await client.transaction.count({ where }),
        intents: await client.paymentIntent.count({ where }),
        balances: await readBalances(prisma, walletId),
      };
    });

  async function topUp(organizationId: string, amountMinor: bigint) {
    const wallet = await asActor({ organizationId }, () => wiring.wallets.getOrOpen('IRR'));
    const result = await asActor({ organizationId }, () =>
      payments.topUp(wallet.id, {
        amountMinor: amountMinor.toString(),
        idempotencyKey: `RACE-${ulid()}`,
      }),
    );
    return { organizationId, walletId: wallet.id, intentId: result.paymentIntentId, amountMinor };
  }

  const refundBy = (organizationId: string, intentId: string) =>
    asActor({ organizationId }, () => payments.refund(intentId, 'the suite refunds'));

  /** The provider refunds; meanwhile, before it answers, the wallet's status changes. */
  function changeStatusDuringProviderCall(walletId: string, status: Status) {
    const real = provider.refund.bind(provider);
    return jest.spyOn(provider, 'refund').mockImplementation(async (request: RefundRequest) => {
      await setStatus(walletId, status);
      return real(request);
    });
  }

  /**
   * Changes the wallet's status just before the `nth` transaction the service
   * opens from now on — after the previous one committed, before the next
   * takes any lock.
   */
  function changeStatusBeforeTransaction(nth: number, walletId: string, status: Status) {
    const real = prisma.transaction.bind(prisma);
    let opened = 0;
    return jest
      .spyOn(prisma, 'transaction')
      .mockImplementation(async <T>(fn: (tx: ExtendedPrismaClient) => Promise<T>) => {
        opened += 1;
        if (opened === nth) await setStatus(walletId, status);
        return real(fn);
      });
  }

  type Made = Awaited<ReturnType<typeof topUp>>;

  /** The deferred state: held, marked, tasked, nothing reversed or announced as refunded. */
  async function expectHeldNotReversed(made: Made, before: Awaited<ReturnType<typeof ledgerOf>>) {
    const after = await ledgerOf(made.organizationId, made.walletId);
    expect(after).toEqual(before);
    expect(after.reversals).toBe(0);
    expect(after.balances).toMatchObject({
      ledger: made.amountMinor,
      pending: made.amountMinor,
      available: 0n,
    });
    expect(await intentOf(made.intentId)).toMatchObject({
      status: 'CAPTURED',
      failureReason: 'REFUNDED_NOT_REVERSED',
      refundedAt: null,
    });
    expect(await refundHoldsOf(made.walletId)).toEqual([
      { status: 'ACTIVE', amountMinor: made.amountMinor },
    ]);
    expect(await eventsOf(made.organizationId, ECONOMIC_EVENTS.PAYMENT_REFUNDED)).toHaveLength(0);
  }

  /** The reversal, recorded exactly once. */
  async function expectReversedOnce(made: Made, held: Awaited<ReturnType<typeof ledgerOf>>) {
    const after = await ledgerOf(made.organizationId, made.walletId);
    expect(after.reversals).toBe(1);
    expect(after.balances).toMatchObject({ ledger: 0n, pending: 0n, available: 0n });
    // The hold's return and the top-up's reversal: two journals, nothing else.
    expect(after.journals).toBe(held.journals + 2);
    expect(after.holds).toBe(held.holds);
    expect(after.transactions).toBe(held.transactions);
    expect(await intentOf(made.intentId)).toMatchObject({
      status: 'REFUNDED',
      failureReason: null,
    });
    expect(await refundHoldsOf(made.walletId)).toEqual([
      { status: 'REFUNDED', amountMinor: made.amountMinor },
    ]);
    expect(await eventsOf(made.organizationId, ECONOMIC_EVENTS.PAYMENT_REFUNDED)).toHaveLength(1);
    expect(await tasksOf(made.intentId)).toEqual([
      expect.objectContaining({ status: 'DONE', resolution: 'REFUNDED' }),
    ]);
  }

  /** Nothing else happens however often the paths that could reverse it run again. */
  async function expectNoSecondReversal(made: Made) {
    const settled = await ledgerOf(made.organizationId, made.walletId);
    await sweep();
    await expect(refundBy(made.organizationId, made.intentId)).rejects.toMatchObject({
      code: 'INVALID_STATE_TRANSITION',
    });
    expect(await ledgerOf(made.organizationId, made.walletId)).toEqual(settled);
    expect(await eventsOf(made.organizationId, ECONOMIC_EVENTS.PAYMENT_REFUNDED)).toHaveLength(1);
  }

  describe.each<Status>(['FROZEN', 'CLOSED'])('wallet %s', (status) => {
    it('refuses to reverse when the change committed during the provider call; the reconciler reverses it once the wallet is active', async () => {
      const made = await topUp(`${org.a}-${status}-CALL`, 640n);
      const ask = changeStatusDuringProviderCall(made.walletId, status);
      const before = await ledgerOf(made.organizationId, made.walletId);

      await expect(refundBy(made.organizationId, made.intentId)).rejects.toMatchObject({
        code: 'BUSINESS_RULE_VIOLATION',
        status: 422,
        internalContext: { walletStatus: status, outcome: 'WALLET_NOT_ACTIVE' },
      });

      expect(ask).toHaveBeenCalledTimes(1);
      ask.mockRestore();
      // Step 1 wrote the hold and its journal; step 3 wrote nothing.
      const held = await ledgerOf(made.organizationId, made.walletId);
      expect(held.journals).toBe(before.journals + 1);
      expect(held.holds).toBe(before.holds + 1);
      await expectHeldNotReversed(made, held);
      expect(await tasksOf(made.intentId)).toEqual([
        expect.objectContaining({ status: 'PENDING', lastOutcome: 'WALLET_NOT_ACTIVE' }),
      ]);
      expect(
        await eventsOf(made.organizationId, ECONOMIC_EVENTS.PAYMENT_REFUND_UNRECONCILED),
      ).toEqual([expect.objectContaining({ reason: 'WALLET_NOT_ACTIVE' })]);

      // Still not active: the reconciler waits too, counting no attempt.
      await makeDue(made.intentId);
      const waited = await sweep();
      expect(waited.deferred).toBeGreaterThanOrEqual(1);
      await expectHeldNotReversed(made, held);
      expect(await tasksOf(made.intentId)).toEqual([
        expect.objectContaining({
          status: 'PENDING',
          attempts: 0,
          lastOutcome: 'WALLET_NOT_ACTIVE',
        }),
      ]);

      await setStatus(made.walletId, 'ACTIVE');
      await makeDue(made.intentId);
      const refundAsked = jest.spyOn(provider, 'refund');
      await sweep();

      await expectReversedOnce(made, held);
      expect(refundAsked).not.toHaveBeenCalled();
      await expectNoSecondReversal(made);
    });

    it('refuses to reverse when the change committed between a retry’s two transactions; the operator’s retry reverses it once the wallet is active', async () => {
      const made = await topUp(`${org.b}-${status}-RETRY`, 530n);
      jest.spyOn(wiring.ledger, 'reverse').mockRejectedValueOnce(new Error('connection reset'));
      await expect(refundBy(made.organizationId, made.intentId)).rejects.toThrow(
        'connection reset',
      );
      expect((await intentOf(made.intentId)).failureReason).toBe('REFUNDED_NOT_REVERSED');
      const held = await ledgerOf(made.organizationId, made.walletId);
      const unreconciled = await eventsOf(
        made.organizationId,
        ECONOMIC_EVENTS.PAYMENT_REFUND_UNRECONCILED,
      );
      expect(unreconciled).toEqual([expect.objectContaining({ reason: 'REVERSAL_FAILED' })]);

      // The retry's first transaction sees an ACTIVE wallet; the change lands
      // after it commits, before the recording transaction locks anything.
      const refundAsked = jest.spyOn(provider, 'refund');
      changeStatusBeforeTransaction(2, made.walletId, status);
      await expect(refundBy(made.organizationId, made.intentId)).rejects.toMatchObject({
        code: 'BUSINESS_RULE_VIOLATION',
        internalContext: { walletStatus: status, outcome: 'WALLET_NOT_ACTIVE' },
      });
      jest.restoreAllMocks();

      expect(refundAsked).not.toHaveBeenCalled();
      await expectHeldNotReversed(made, held);
      // Already REFUNDED_NOT_REVERSED: nothing re-marked, nothing announced twice.
      expect(await tasksOf(made.intentId)).toEqual([
        expect.objectContaining({ status: 'PENDING', lastOutcome: 'REVERSAL_FAILED' }),
      ]);
      expect(
        await eventsOf(made.organizationId, ECONOMIC_EVENTS.PAYMENT_REFUND_UNRECONCILED),
      ).toHaveLength(1);

      // While it stays inactive, a plain retry is refused in step 1.
      await expect(refundBy(made.organizationId, made.intentId)).rejects.toMatchObject({
        internalContext: { walletStatus: status },
      });
      await expectHeldNotReversed(made, held);

      await setStatus(made.walletId, 'ACTIVE');
      const asked = jest.spyOn(provider, 'refund');
      await refundBy(made.organizationId, made.intentId);

      await expectReversedOnce(made, held);
      expect(asked).not.toHaveBeenCalled();
      await expectNoSecondReversal(made);
    });
  });

  it('a change during the provider call to a still-ACTIVE wallet reverses as before (the control)', async () => {
    const made = await topUp(`${org.c}-CONTROL`, 410n);
    changeStatusDuringProviderCall(made.walletId, 'ACTIVE');
    const before = await ledgerOf(made.organizationId, made.walletId);

    await refundBy(made.organizationId, made.intentId);

    // One hold placed and returned, one reversal: three journals.
    const after = await ledgerOf(made.organizationId, made.walletId);
    expect(after.journals).toBe(before.journals + 3);
    expect(after.reversals).toBe(1);
    expect(after.balances).toMatchObject({ ledger: 0n, pending: 0n, available: 0n });
    expect(await intentOf(made.intentId)).toMatchObject({ status: 'REFUNDED' });
  });
});
