import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import type { WorkflowHandle } from '@temporalio/client';
import { RastaError, runUnscoped } from '@rasta/nest-common';
import { ulid } from 'ulid';
import { createActivities } from '../src/temporal/activities';
import { orderSaga, type OrderSagaInput } from '../src/temporal/workflows';
import type { EconomicClient } from '../src/economic/economic.client';
import type { PrismaService } from '../src/prisma/prisma.service';
import type { OrderStatus } from '../src/generated/prisma';
import {
  asActor,
  cleanup,
  key,
  newPrisma,
  publishOffer,
  resolveOpenDispute,
  tenants,
  wire,
  type Wiring,
} from './helpers';

/**
 * An operator's SETTLE of a dispute raised before receipt resumes the order
 * where the dispute found it (D-083, marketplace audit F1) — end to end
 * through the real saga, on the real database.
 *
 * The workflow is `orderSaga` itself, on Temporal's time-skipping test server;
 * its activities are `createActivities` over the real `OrderService`, row
 * lock, state machine, triggers and CHECKs. The parties act through the same
 * service methods the HTTP layer calls, then signal, as the controller does.
 *
 * Only economic-service is a stand-in ({@link EconomicLedger}), and it is a
 * strict one: it keeps the obligation's state as economic-service's state
 * machine does since D-083 (a resolution returns an obligation never
 * authorised to HELD), refuses what that machine refuses, and — the point of
 * this file — records, at the moment each settlement authority is given,
 * whether the order row then held the buyer's recorded receipt. That is read
 * from the database, not from what the saga believes. economic-service's own
 * rows for the same sequences are asserted against its database in
 * `economic-service/test/dispute-resolution-authority.int-spec.ts`.
 */

jest.setTimeout(240_000);

const INPUT: Omit<OrderSagaInput, 'orderId'> = {
  fulfillmentWindowDays: 7,
  receiptWindowDays: 3,
  reminderIntervalDays: 3,
  // Long, so the only reads are the ones a signal asks for: every case here
  // signals, as the controller does.
  recheckIntervalHours: 24 * 365,
};

type Origin = 'FUNDS_HELD' | 'CONFIRMED' | 'AWAITING_RECEIPT_CONFIRMATION';
const ORIGINS: readonly Origin[] = ['FUNDS_HELD', 'CONFIRMED', 'AWAITING_RECEIPT_CONFIRMATION'];

type EconomicStatus = 'HELD' | 'DISPUTED' | 'PENDING_SETTLEMENT' | 'SETTLED' | 'REFUNDED';

/** economic-service as the saga meets it, strictly, with a record of every effect. */
class EconomicLedger {
  status: EconomicStatus = 'HELD';
  authorised = false;
  transactionId = `TXN_${ulid()}`;
  disputeId: string | null = null;
  disputedAt: string | null = null;
  disputeReason: string | null = null;
  disputeResolution: string | null = null;
  private disputes = 0;
  /** Each effect, in order, as economic-service would journal it. */
  readonly effects: string[] = [];
  /** For each authorisation: whether the order then held the buyer's receipt. */
  readonly authorisedWithReceipt: boolean[] = [];

  constructor(
    private readonly prisma: PrismaService,
    private readonly buyer: string,
  ) {}

  private refuse(what: string): never {
    throw RastaError.invalidStateTransition('Transaction', this.status, what);
  }

  private async receiptRecorded(orderId: string): Promise<boolean> {
    const row = await runUnscoped('the economic stand-in reads the order it is asked about', () =>
      this.prisma.client.order.findUnique({
        where: { id: orderId },
        select: { receiptConfirmedAt: true, receiptConfirmedBy: true },
      }),
    );
    return row?.receiptConfirmedAt != null && row.receiptConfirmedBy != null;
  }

  view(orderId: string) {
    return {
      id: this.transactionId,
      organizationId: this.buyer,
      transactionType: 'MARKETPLACE_ORDER',
      status: this.status,
      // This stand-in places its hold for real, so what HELD says is proven.
      heldProven: this.status === 'HELD',
      sourceReference: orderId,
      disputeId: this.disputeId,
      disputedAt: this.disputedAt,
      disputeReason: this.disputeReason,
      disputeResolution: this.disputeResolution,
      settlement: null,
    };
  }

  client(): EconomicClient {
    return {
      createObligation: async () => {
        this.effects.push('hold');
        return { id: this.transactionId };
      },
      readObligation: async (input: { orderId: string }) => this.view(input.orderId),
      findObligations: async () => [],
      authoriseSettlement: async (input: { orderId: string }) => {
        if (this.status === 'PENDING_SETTLEMENT' && this.authorised) return undefined;
        if (this.status !== 'HELD') this.refuse('authorise settlement');
        this.authorisedWithReceipt.push(await this.receiptRecorded(input.orderId));
        this.status = 'PENDING_SETTLEMENT';
        this.authorised = true;
        this.effects.push('authorise');
        return undefined;
      },
      settle: async () => {
        if (this.status !== 'PENDING_SETTLEMENT') this.refuse('settle');
        this.status = 'SETTLED';
        this.effects.push('settle');
        return {
          settlementId: `STL_${ulid()}`,
          commissionAmountMinor: '0',
          netAmountMinor: '1',
        };
      },
      refund: async () => {
        if (this.status !== 'HELD' && this.status !== 'PENDING_SETTLEMENT') this.refuse('refund');
        this.status = 'REFUNDED';
        this.effects.push('refund');
        return undefined;
      },
      cancel: async () => this.refuse('cancel'),
      dispute: async (input: { reason: string }) => {
        if (this.status !== 'HELD' && this.status !== 'PENDING_SETTLEMENT') this.refuse('dispute');
        this.disputes += 1;
        this.status = 'DISPUTED';
        this.disputeId = `TXD_${this.disputes}`;
        this.disputedAt = new Date().toISOString();
        this.disputeReason = input.reason;
        this.disputeResolution = null;
        this.effects.push('dispute');
        return { disputeId: this.disputeId };
      },
      resolveDispute: async (input: { economicDisputeId?: string; resolution: string }) => {
        if (this.status !== 'DISPUTED') this.refuse('resolve a dispute');
        if (input.economicDisputeId !== undefined && input.economicDisputeId !== this.disputeId) {
          this.refuse('resolve another dispute');
        }
        // economic-service since D-083: authority decides, a resolution never authorises.
        this.status = this.authorised ? 'PENDING_SETTLEMENT' : 'HELD';
        this.disputeResolution = input.resolution;
        this.effects.push(`resolve->${this.status}`);
        return undefined;
      },
      // JUSTIFIED-ANY: the activities call only these methods; the client's
      // own HTTP behaviour has its own spec.
    } as unknown as EconomicClient;
  }
}

describe('a pre-receipt dispute settled by an operator resumes the order (D-083, real saga, real database)', () => {
  let prisma: PrismaService;
  let wiring: Wiring;
  let env: TestWorkflowEnvironment;
  let queues = 0;
  const org = tenants();

  beforeAll(async () => {
    prisma = newPrisma();
    wiring = wire(prisma);
    const downloadDir = process.env.TEMPORAL_TEST_SERVER_DIR;
    env = await TestWorkflowEnvironment.createTimeSkipping(
      downloadDir
        ? { server: { executable: { type: 'cached-download', downloadDir, ttl: '30 days' } } }
        : undefined,
    );
  }, 300_000);

  afterAll(async () => {
    await env?.teardown();
    await cleanup(prisma, [org.buyer, org.supplier, org.other]);
    await prisma.onModuleDestroy();
  });

  const asBuyer = <T>(fn: () => Promise<T>) =>
    asActor({ organizationId: org.buyer, roles: ['PROCUREMENT_USER'], userId: 'USR-D083-B' }, fn);
  const asSupplier = <T>(fn: () => Promise<T>) =>
    asActor({ organizationId: org.supplier, roles: ['SUPPLIER'], userId: 'USR-D083-S' }, fn);
  const asOperator = <T>(fn: () => Promise<T>) =>
    asActor({ organizationId: org.other, roles: ['SYSTEM_ADMIN'], userId: 'USR-D083-OPS' }, fn);

  async function statusOf(orderId: string): Promise<OrderStatus> {
    const row = await runUnscoped('the suite reads the order it drives', () =>
      prisma.client.order.findUniqueOrThrow({ where: { id: orderId }, select: { status: true } }),
    );
    return row.status;
  }

  async function until(what: string, check: () => Promise<boolean> | boolean): Promise<void> {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out waiting for ${what}`);
  }

  /** The parties, through the service methods the controller calls, then the controller's signal. */
  function parties(orderId: string, handle: WorkflowHandle) {
    return {
      confirm: async () => {
        await asSupplier(() => wiring.orders.confirm(orderId));
        await handle.signal('orderConfirmed');
      },
      fulfil: async () => {
        await asSupplier(() => wiring.orders.fulfill(orderId, { trackingReference: 'TRK-D083' }));
        await handle.signal('orderFulfilled');
      },
      confirmReceipt: async () => {
        await asBuyer(() => wiring.orders.confirmReceipt(orderId, {}));
        await handle.signal('receiptConfirmed');
      },
      dispute: async (reason: string) => {
        await asBuyer(() => wiring.orders.raiseDispute(orderId, { reason }));
        await handle.signal('orderDisputed', reason);
      },
      resolve: async (outcome: 'SETTLE' | 'REFUND', resolution: string) => {
        await asOperator(() =>
          resolveOpenDispute(wiring, orderId, {
            outcome,
            resolution,
            responsibility: outcome === 'SETTLE' ? 'BUYER' : 'SUPPLIER',
          }),
        );
        await handle.signal('disputeResolved', outcome);
      },
    };
  }

  type Parties = ReturnType<typeof parties>;

  /** Places an order and runs its real saga while `drive` acts; returns the saga's result. */
  async function saga(
    drive: (ctx: { orderId: string; act: Parties; ledger: EconomicLedger }) => Promise<void>,
  ): Promise<{ result: string; orderId: string; ledger: EconomicLedger }> {
    const { offerId } = await publishOffer(wiring, org.supplier, { unitPriceMinor: '120000' });
    const order = await asBuyer(() =>
      wiring.orders.place({ lines: [{ offerId, quantity: 1 }] }, key('d083')),
    );
    const ledger = new EconomicLedger(prisma, org.buyer);
    const taskQueue = `d083-${(queues += 1)}-${ulid()}`;
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowsPath: require.resolve('../src/temporal/workflows'),
      activities: createActivities({ orders: wiring.orders, economic: ledger.client() }),
    });
    const result = await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(orderSaga, {
        taskQueue,
        workflowId: `d083-${order.id}`,
        args: [{ ...INPUT, orderId: order.id }],
      });
      try {
        await until(
          'the hold to be recorded',
          async () => (await statusOf(order.id)) !== 'PENDING',
        );
        await drive({ orderId: order.id, act: parties(order.id, handle), ledger });
        return await handle.result();
      } catch (error) {
        await handle.terminate('test failed').catch(() => undefined);
        throw error;
      }
    });
    return { result, orderId: order.id, ledger };
  }

  /** What the parties do to bring a held order to `origin`. */
  const REACH: Record<Origin, (act: Parties) => Promise<void>> = {
    FUNDS_HELD: async () => undefined,
    CONFIRMED: (act) => act.confirm(),
    AWAITING_RECEIPT_CONFIRMATION: async (act) => {
      await act.confirm();
      await act.fulfil();
    },
  };
  /** What is left for them from `origin` — the real path, nothing skipped. */
  const REST: Record<Origin, (act: Parties) => Promise<void>> = {
    FUNDS_HELD: async (act) => {
      await act.confirm();
      await act.fulfil();
      await act.confirmReceipt();
    },
    CONFIRMED: async (act) => {
      await act.fulfil();
      await act.confirmReceipt();
    },
    AWAITING_RECEIPT_CONFIRMATION: (act) => act.confirmReceipt(),
  };

  async function transitions(orderId: string): Promise<string[]> {
    const rows = await runUnscoped('the suite reads the order history it caused', () =>
      prisma.client.orderStatusHistory.findMany({
        where: { orderId, kind: 'TRANSITION' },
        orderBy: { occurredAt: 'asc' },
        select: { fromStatus: true, toStatus: true },
      }),
    );
    return rows.map((row) => `${row.fromStatus}->${row.toStatus}`);
  }

  async function disputesOf(orderId: string) {
    return runUnscoped('the suite reads the disputes it raised', () =>
      prisma.client.orderDispute.findMany({
        where: { orderId },
        orderBy: { raisedAt: 'asc' },
        select: { status: true, raisedFromStatus: true },
      }),
    );
  }

  async function completedRow(orderId: string) {
    return runUnscoped('the suite reads the order it completed', () =>
      prisma.client.order.findUniqueOrThrow({
        where: { id: orderId },
        select: {
          status: true,
          receiptConfirmedAt: true,
          receiptConfirmedBy: true,
          economicSettlementId: true,
        },
      }),
    );
  }

  it.each(ORIGINS)(
    'raised at %s: SETTLE returns it there; the parties carry on; it settles once, after the receipt',
    async (origin) => {
      const { result, orderId, ledger } = await saga(async ({ orderId, act, ledger }) => {
        await REACH[origin](act);
        await act.dispute('the parts do not match the offer');
        await until('the dispute to be mirrored', () => ledger.status === 'DISPUTED');
        await act.resolve('SETTLE', 'the supplier showed the parts match the offer');

        // Back where the dispute found it — not RECEIPT_CONFIRMED — and the
        // obligation back in HELD: nothing has authorised settlement.
        expect(await statusOf(orderId)).toBe(origin);
        await until('the decision to be mirrored', () => ledger.status === 'HELD');
        expect(ledger.authorised).toBe(false);

        // The authority rules hold on the resumed order.
        if (origin === 'FUNDS_HELD') {
          await expect(asBuyer(() => wiring.orders.confirm(orderId))).rejects.toThrow();
        }
        if (origin !== 'AWAITING_RECEIPT_CONFIRMATION') {
          await expect(asBuyer(() => wiring.orders.confirmReceipt(orderId, {}))).rejects.toThrow();
        } else {
          await expect(
            asSupplier(() => wiring.orders.confirmReceipt(orderId, {})),
          ).rejects.toThrow();
        }
        expect(await statusOf(orderId)).toBe(origin);

        await REST[origin](act);
      });

      expect(result).toBe('COMPLETED');
      // One hold, the dispute and its release to HELD, then authorisation only
      // after the receipt, and one settlement.
      expect(ledger.effects).toEqual(['hold', 'dispute', 'resolve->HELD', 'authorise', 'settle']);
      expect(ledger.authorisedWithReceipt).toEqual([true]);

      const row = await completedRow(orderId);
      expect(row.status).toBe('COMPLETED');
      expect(row.receiptConfirmedBy).toBe('USR-D083-B');
      expect(row.receiptConfirmedAt).not.toBeNull();
      expect(row.economicSettlementId).not.toBeNull();

      const history = await transitions(orderId);
      expect(history).toContain(`${origin}->DISPUTED`);
      expect(history).toContain(`DISPUTED->${origin}`);
      expect(history).not.toContain('DISPUTED->RECEIPT_CONFIRMED');
      expect(history.slice(-3)).toEqual([
        'AWAITING_RECEIPT_CONFIRMATION->RECEIPT_CONFIRMED',
        'RECEIPT_CONFIRMED->SETTLING',
        'SETTLING->COMPLETED',
      ]);
      expect(await disputesOf(orderId)).toEqual([
        { status: 'RESOLVED_SETTLE', raisedFromStatus: origin },
      ]);
    },
  );

  it('raised after receipt: SETTLE returns it to RECEIPT_CONFIRMED with the buyer’s receipt, and it settles once', async () => {
    const { result, orderId, ledger } = await saga(async ({ orderId, act, ledger }) => {
      await act.confirm();
      await act.fulfil();
      // Disputed in the same breath as the receipt, before the saga settles:
      // the receipt and the dispute commit before the saga's next read.
      await asBuyer(() => wiring.orders.confirmReceipt(orderId, {}));
      await act.dispute('one of the parts was damaged in the box');
      await until('the dispute to be mirrored', () => ledger.status === 'DISPUTED');
      await act.resolve('SETTLE', 'the damage happened after delivery');
    });

    expect(result).toBe('COMPLETED');
    // Two orders are both right, and which one runs is the saga's timing: it
    // read the receipt and authorised before the dispute (the obligation is
    // released back to the settlement queue — D-053), or the dispute came
    // first (released to HELD, authorised after). Either way, authority only
    // with the receipt recorded, and one settlement.
    expect([
      ['hold', 'dispute', 'resolve->HELD', 'authorise', 'settle'],
      ['hold', 'authorise', 'dispute', 'resolve->PENDING_SETTLEMENT', 'settle'],
    ]).toContainEqual(ledger.effects);
    expect(ledger.authorisedWithReceipt).toEqual([true]);
    const history = await transitions(orderId);
    expect(history).toContain('RECEIPT_CONFIRMED->DISPUTED');
    expect(history).toContain('DISPUTED->RECEIPT_CONFIRMED');
    expect(await disputesOf(orderId)).toEqual([
      { status: 'RESOLVED_SETTLE', raisedFromStatus: 'RECEIPT_CONFIRMED' },
    ]);
  });

  it('repeated dispute and resume cycles, then REFUND: one refund, never an authorisation', async () => {
    const { result, orderId, ledger } = await saga(async ({ act, ledger }) => {
      await act.confirm();
      for (const round of [1, 2]) {
        await act.dispute(`the supplier stopped answering, round ${round}`);
        await until(`dispute ${round} to be mirrored`, () => ledger.status === 'DISPUTED');
        await act.resolve('SETTLE', `the supplier answered again, round ${round}`);
        await until(`decision ${round} to be mirrored`, () => ledger.status === 'HELD');
      }
      await act.dispute('the supplier will not deliver at all');
      await until('the last dispute to be mirrored', () => ledger.status === 'DISPUTED');
      await act.resolve('REFUND', 'the supplier admitted it cannot deliver');
    });

    expect(result).toBe('CANCELLED');
    expect(ledger.effects).toEqual([
      'hold',
      'dispute',
      'resolve->HELD',
      'dispute',
      'resolve->HELD',
      'dispute',
      'resolve->HELD',
      'refund',
    ]);
    expect(ledger.authorisedWithReceipt).toEqual([]);
    expect(await statusOf(orderId)).toBe('CANCELLED');
    expect((await disputesOf(orderId)).map((d) => [d.status, d.raisedFromStatus])).toEqual([
      ['RESOLVED_SETTLE', 'CONFIRMED'],
      ['RESOLVED_SETTLE', 'CONFIRMED'],
      ['RESOLVED_REFUND', 'CONFIRMED'],
    ]);
  });

  it('settled back and disputed again before the saga looked: the first decision is mirrored, then the second dispute', async () => {
    const { result, ledger } = await saga(async ({ orderId, act, ledger }) => {
      await act.confirm();
      await act.dispute('the parts are late');
      await until('the dispute to be mirrored', () => ledger.status === 'DISPUTED');
      // Both commit with no signal in between: the saga's next read finds the
      // order DISPUTED again, under a new dispute.
      await asOperator(() =>
        resolveOpenDispute(wiring, orderId, {
          outcome: 'SETTLE',
          resolution: 'the supplier showed a dispatch note',
          responsibility: 'BUYER',
        }),
      );
      await asBuyer(() => wiring.orders.raiseDispute(orderId, { reason: 'still not here' }));
      await act.resolve('REFUND', 'the parts never arrived');
    });

    expect(result).toBe('CANCELLED');
    // The first dispute is released before the second is filed; one refund.
    expect(ledger.effects.filter((e) => e === 'refund')).toHaveLength(1);
    expect(ledger.effects).not.toContain('authorise');
    expect(ledger.effects.slice(0, 3)).toEqual(['hold', 'dispute', 'resolve->HELD']);
  });

  it('refuses a stale decision: one about dispute A after B was raised decides nothing', async () => {
    await saga(async ({ orderId, act, ledger }) => {
      await act.dispute('the offer changed after I ordered');
      await until('the dispute to be mirrored', () => ledger.status === 'DISPUTED');
      const first = await runUnscoped('the suite reads dispute A', () =>
        prisma.client.orderDispute.findFirstOrThrow({ where: { orderId, status: 'OPEN' } }),
      );
      await act.resolve('SETTLE', 'the offer was the same when it was ordered');
      await act.dispute('and now the supplier does not answer');

      // A form drawn for dispute A, posted now.
      const stale = asOperator(() =>
        wiring.orders.resolveDispute(orderId, {
          disputeId: first.id,
          outcome: 'REFUND',
          resolution: 'a refund decided on the first dispute',
          responsibility: 'SUPPLIER',
        }),
      );
      await expect(stale).rejects.toMatchObject({
        code: 'CONFLICT',
        details: [expect.objectContaining({ code: 'DISPUTE_DECISION_STALE' })],
      });
      expect(await statusOf(orderId)).toBe('DISPUTED');
      expect((await disputesOf(orderId)).map((d) => d.status)).toEqual(['RESOLVED_SETTLE', 'OPEN']);

      await act.resolve('REFUND', 'the supplier never answered the second dispute');
    });
  });

  it('refuses a decision about a dispute another operator already decided, with the same typed refusal', async () => {
    await saga(async ({ orderId, act, ledger }) => {
      await act.confirm();
      await act.dispute('the supplier will not say when');
      await until('the dispute to be mirrored', () => ledger.status === 'DISPUTED');
      const decided = await runUnscoped('the suite reads the dispute both operators saw', () =>
        prisma.client.orderDispute.findFirstOrThrow({ where: { orderId, status: 'OPEN' } }),
      );
      await act.resolve('SETTLE', 'the supplier gave a date');

      // The second operator's form, drawn before the first decided: the order
      // holds no dispute now, and is CONFIRMED again.
      await expect(
        asOperator(() =>
          wiring.orders.resolveDispute(orderId, {
            disputeId: decided.id,
            outcome: 'REFUND',
            resolution: 'a refund decided on the same dispute',
            responsibility: 'SUPPLIER',
          }),
        ),
      ).rejects.toMatchObject({
        code: 'CONFLICT',
        details: [expect.objectContaining({ code: 'DISPUTE_DECISION_STALE' })],
      });
      expect(await statusOf(orderId)).toBe('CONFIRMED');

      await act.fulfil();
      await act.confirmReceipt();
    });
  });
});
