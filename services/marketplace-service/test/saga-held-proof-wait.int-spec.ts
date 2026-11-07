import { Worker } from '@temporalio/worker';
import { installTemporalRuntimeLogger } from '../src/temporal/runtime-logger';
import { createActivities } from '../src/temporal/activities';
import type { EconomicClient } from '../src/economic/economic.client';
import { createTemporalTestEnvironment } from './temporal-environment';
import { runBounded } from './worker-deadline';
import { asActor, cleanup, key, newPrisma, publishOffer, tenants, wire, testEnv } from './helpers';

/**
 * #824 r1, F3: a hold placed, and an economic-service too old to say whether it is proven. The real
 * workflow on a real test server: the saga waits, and carries on by itself after the upgrade.
 */
it('an order whose hold exists waits out an older economic-service, then adopts it', async () => {
  installTemporalRuntimeLogger(testEnv());
  const temporal = await createTemporalTestEnvironment();
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
    // Under one deadline inside the 300 s of the test: a read or sleep that is
    // never answered stops the worker here instead of outliving the test (FU-192 r2).
    await runBounded(
      worker,
      { what: 'the saga to adopt the hold', ms: 200_000, connection: temporal.client.connection },
      async (deadline) => {
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
        for (;;) {
          const seen = await deadline.call(() => wiring.orders.sagaView(order.id));
          if (seen.economicTransactionId) break;
          await deadline.call(() => temporal.sleep('5 seconds'));
        }
        expect(await wiring.orders.sagaView(order.id)).toMatchObject({
          economicTransactionId: obligation.id,
          status: 'FUNDS_HELD',
        });
        expect(unprovenAnswers).toBeGreaterThanOrEqual(5);
        await handle.terminate('the wait is what this asserts');
      },
    );
  } finally {
    await cleanup(prisma, [org.buyer, org.supplier, org.other]);
    await prisma.onModuleDestroy();
    await temporal.teardown();
  }
}, 300_000);
