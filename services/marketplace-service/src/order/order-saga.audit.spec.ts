import { createSystemContext, runWithContext } from '@rasta/nest-common';
import type { EventPublisher } from '../events/publisher';
import { MARKETPLACE_EVENTS, validateMarketplacePayload } from '../events/events';
import type { PrismaService } from '../prisma/prisma.service';
import type { MarketplaceEnv } from '../config/env';
import type { OrderStatus } from '../generated/prisma';
import type { LockedOrderRow, OrderRepository } from './order.repository';
import { OrderService } from './order.service';

/**
 * The saga's internal transitions are audited (AGENTS.md S-06, global audit
 * L7-14): holding funds, failing to, starting a settlement attempt and
 * failing one. Each moved the order and published nothing; each now records
 * exactly one event in the transition's own transaction, under the buyer's
 * tenant — and none when the step changed nothing.
 *
 * That the event and the row commit together is proven against PostgreSQL in
 * `test/audit-records.int-spec.ts`.
 */

const BUYER = 'ORG-BUYER';

function order(overrides: Partial<LockedOrderRow> = {}): LockedOrderRow {
  return {
    id: 'ORD_1',
    organizationId: BUYER,
    supplierOrganizationId: 'ORG-SUPPLIER',
    status: 'PENDING',
    totalAmountMinor: 500000n,
    currency: 'IRR',
    economicTransactionId: null,
    correlationId: 'COR_1',
    cancellationCause: null,
    ...overrides,
  };
}

function harness(row: LockedOrderRow) {
  const enqueued: Array<{
    tx: unknown;
    eventName: string;
    organizationId: string;
    payload: unknown;
  }> = [];
  const tx = {
    order: { update: jest.fn(async () => undefined) },
    orderLine: { findMany: jest.fn(async () => []) },
  };
  const prisma = {
    transaction: jest.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
  } as unknown as PrismaService;
  const repository = {
    lockOrder: jest.fn(async () => row),
    recordHistory: jest.fn(async () => undefined),
    restoreAvailability: jest.fn(async () => undefined),
  } as unknown as OrderRepository;
  const events = {
    enqueue: jest.fn(
      async (
        client: unknown,
        input: { eventName: string; organizationId: string; payload: unknown },
      ) => {
        validateMarketplacePayload(input.eventName as never, input.payload);
        enqueued.push({ tx: client, ...input });
      },
    ),
  } as unknown as EventPublisher;

  const service = new OrderService(prisma, repository, events, {} as MarketplaceEnv);
  const asSaga = <T>(fn: () => Promise<T>) =>
    runWithContext(
      createSystemContext({
        correlationId: 'COR_1',
        callerService: 'marketplace-service',
        organizationId: BUYER,
      }),
      fn,
    );

  return { tx, enqueued, service, asSaga };
}

const parties = {
  orderId: 'ORD_1',
  buyerOrganizationId: BUYER,
  supplierOrganizationId: 'ORG-SUPPLIER',
  totalAmountMinor: '500000',
  currency: 'IRR',
};

describe('the saga’s transitions are audited', () => {
  it.each<
    [
      string,
      OrderStatus,
      (s: OrderService) => Promise<OrderStatus>,
      string,
      Record<string, unknown>,
    ]
  >([
    [
      'markFundsHeld',
      'PENDING',
      (s) => s.markFundsHeld('ORD_1', 'TXN_1'),
      MARKETPLACE_EVENTS.ORDER_FUNDS_HELD,
      { transactionId: 'TXN_1', status: 'FUNDS_HELD' },
    ],
    [
      'markFailed',
      'PENDING',
      (s) => s.markFailed('ORD_1', 'wallet empty'),
      MARKETPLACE_EVENTS.ORDER_FAILED,
      {},
    ],
    [
      'markSettling',
      'RECEIPT_CONFIRMED',
      (s) => s.markSettling('ORD_1'),
      MARKETPLACE_EVENTS.ORDER_SETTLEMENT_STARTED,
      {},
    ],
    [
      'markSettlementFailed',
      'SETTLING',
      (s) => s.markSettlementFailed('ORD_1'),
      MARKETPLACE_EVENTS.ORDER_SETTLEMENT_FAILED,
      {},
    ],
  ])(
    '%s records exactly one event, in its transaction, under the buyer',
    async (_step, from, step, eventName, extra) => {
      const h = harness(order({ status: from }));

      await h.asSaga(() => step(h.service));

      expect(h.enqueued).toEqual([
        {
          tx: h.tx,
          eventName,
          aggregateId: 'ORD_1',
          organizationId: BUYER,
          payload: expect.objectContaining({ ...parties, ...extra }),
        },
      ]);
    },
  );

  it('does not put the failure reason on ORDER_FAILED', async () => {
    const h = harness(order({ status: 'PENDING' }));

    await h.asSaga(() => h.service.markFailed('ORD_1', 'connect ECONNREFUSED economic:3112'));

    expect(JSON.stringify(h.enqueued[0].payload)).not.toContain('ECONNREFUSED');
  });

  it('records the hold on an order the buyer cancelled meanwhile, as CANCELLING', async () => {
    // The money is held either way, and that is the fact recorded.
    const h = harness(order({ status: 'CANCELLING' }));

    await expect(h.asSaga(() => h.service.markFundsHeld('ORD_1', 'TXN_1'))).resolves.toBe(
      'CANCELLING',
    );

    expect(h.enqueued).toEqual([
      expect.objectContaining({
        eventName: MARKETPLACE_EVENTS.ORDER_FUNDS_HELD,
        payload: expect.objectContaining({ transactionId: 'TXN_1', status: 'CANCELLING' }),
      }),
    ]);
  });

  it('records nothing when a retry re-runs a hold already recorded on a cancelling order', async () => {
    const h = harness(order({ status: 'CANCELLING', economicTransactionId: 'TXN_1' }));

    await h.asSaga(() => h.service.markFundsHeld('ORD_1', 'TXN_1'));

    expect(h.enqueued).toEqual([]);
  });

  it.each<[string, OrderStatus, (s: OrderService) => Promise<OrderStatus>]>([
    ['a retried hold', 'FUNDS_HELD', (s) => s.markFundsHeld('ORD_1', 'TXN_1')],
    ['a retried failure', 'FAILED', (s) => s.markFailed('ORD_1', 'wallet empty')],
    ['a settlement that yields to a dispute', 'DISPUTED', (s) => s.markSettling('ORD_1')],
  ])('records nothing for %s', async (_label, current, step) => {
    const h = harness(order({ status: current }));

    await h.asSaga(() => step(h.service));

    expect(h.enqueued).toEqual([]);
  });
});
