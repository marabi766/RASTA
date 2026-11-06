import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { installTemporalRuntimeLogger } from '../src/temporal/runtime-logger';
import { createActivities } from '../src/temporal/activities';
import type { EconomicClient } from '../src/economic/economic.client';
import { asActor, cleanup, key, newPrisma, publishOffer, tenants, wire, testEnv } from './helpers';

/**
 * #824 r1, F3: a hold placed, and an economic-service too old to say whether it is proven. The real
 * workflow on a real test server: the saga waits, and carries on by itself after the upgrade.
 */
it('an order whose hold exists waits out an older economic-service, then adopts it', async () => {
  installTemporalRuntimeLogger(testEnv());
  const downloadDir = process.env.TEMPORAL_TEST_SERVER_DIR;
  const temporal = await TestWorkflowEnvironment.createTimeSkipping(
    downloadDir
      ? { server: { executable: { type: 'cached-download', downloadDir, ttl: '30 days' } } }
      : undefined,
  );
  const prisma = newPrisma();
  const wiring = wire(prisma);
  const org = tenants();
  const queue = key('held-proof-wait');
  try {
    const { offerId } = await publishOffer(wiring, org.supplier);
    const order = await asActor({ organizationId: org.buyer }, () =>
      wiring.orders.place({ lines: [{ offerId, quantity: 2 }] }, key('held-proof-wait')),
    );

    const obligation = {
      id: 'TXN_HELD_PROOF_WAIT',
      organizationId: org.buyer,
      counterpartyOrganizationId: org.supplier,
      transactionType: 'MARKETPLACE_ORDER',
      status: 'HELD',
      grossAmountMinor: String(order.totalAmountMinor),
      commissionAmountMinor: '0',
      netAmountMinor: String(order.totalAmountMinor),
      currency: order.currency,
      sourceType: 'ORDER',
      sourceReference: order.id,
    };
    // Older, for as long as this says so.
    let upgraded = false;
    let unprovenAnswers = 0;
    const answer = () => {
      if (upgraded) return { ...obligation, heldProven: true };
      unprovenAnswers += 1;
      if (unprovenAnswers >= 5) upgraded = true;
      return obligation;
    };
    const economic = {
      createObligation: async () => obligation,
      readObligation: async () => answer(),
      findObligations: async () => [answer()],
    } as unknown as EconomicClient;

    const worker = await Worker.create({
      connection: temporal.nativeConnection,
      taskQueue: queue,
      workflowsPath: require.resolve('../src/temporal/workflows'),
      activities: createActivities({ orders: wiring.orders, economic }),
    });
    await worker.runUntil(async () => {
      const handle = await temporal.client.workflow.start('orderSaga', {
        taskQueue: queue,
        workflowId: `order-${order.id}`,
        args: [
          {
            orderId: order.id,
            fulfillmentWindowDays: 7,
            receiptWindowDays: 7,
            reminderIntervalDays: 1,
            recheckIntervalHours: 1,
          },
        ],
      });
      for (let i = 0; i < 600; i += 1) {
        const seen = await wiring.orders.sagaView(order.id);
        if (seen.economicTransactionId) break;
        await temporal.sleep('5 seconds');
      }
      expect(await wiring.orders.sagaView(order.id)).toMatchObject({
        economicTransactionId: obligation.id,
        status: 'FUNDS_HELD',
      });
      expect(unprovenAnswers).toBeGreaterThanOrEqual(5);
      await handle.terminate('the wait is what this asserts');
    });
  } finally {
    await cleanup(prisma, [org.buyer, org.supplier, org.other]);
    await prisma.onModuleDestroy();
    await temporal.teardown();
  }
}, 300_000);
