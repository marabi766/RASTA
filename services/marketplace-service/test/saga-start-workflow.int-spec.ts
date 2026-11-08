import { createTemporalTestEnvironment } from './temporal-environment';
import { setTenantEligibilityFixture } from '@rasta/testing';
import { Connection } from '@temporalio/client';
import { Worker } from '@temporalio/worker';
import { installTemporalRuntimeLogger } from '../src/temporal/runtime-logger';
import { createActivities } from '../src/temporal/activities';
import { OrderSagaClient } from '../src/temporal/saga.client';
import { runUnscoped } from '@rasta/nest-common';
import { SagaStartStore } from '../src/temporal/saga-start.store';
import type { EconomicClient } from '../src/economic/economic.client';
import { asActor, cleanup, key, newPrisma, publishOffer, tenants, wire, testEnv } from './helpers';

it('a cancelled order recovered after missed start completes once without creating a hold', async () => {
  installTemporalRuntimeLogger(testEnv());
  const temporal = await createTemporalTestEnvironment();
  // The Java time-skipping server does not expose namespace retention. Stub
  // that metadata only; all starts, workflow tasks and activities are real.
  const connect = jest.spyOn(Connection, 'connect').mockResolvedValue(temporal.connection);
  jest.spyOn(temporal.connection.workflowService, 'describeNamespace').mockResolvedValue({
    config: { workflowExecutionRetentionTtl: { seconds: 86400 } },
    // The wire accepts integral seconds; generated types describe decoded Longs.
  } as unknown as Awaited<ReturnType<Connection['workflowService']['describeNamespace']>>);
  const prisma = newPrisma();
  const wiring = wire(prisma);
  const org = tenants();
  const queue = key('durable-start');
  const store = new SagaStartStore(prisma);
  const client = new OrderSagaClient(
    {
      ...wiring.env,
      MARKETPLACE_TEMPORAL_ENABLED: true,
      TEMPORAL_ADDRESS: temporal.address,
      TEMPORAL_NAMESPACE: temporal.namespace ?? 'default',
      MARKETPLACE_TEMPORAL_TASK_QUEUE: queue,
    },
    store,
    { provesHeldFunds: async () => true },
  );
  const createObligation = jest.fn();
  const findObligations = jest.fn(async () => []);
  // economic-service with the D-150 rule, which the row's proof needs (FU-233).
  const requiresOrderHoldDeadline = async () => true;
  const economic = {
    createObligation,
    findObligations,
    requiresOrderHoldDeadline,
  } as unknown as EconomicClient;
  try {
    const { offerId } = await publishOffer(wiring, org.supplier);
    const order = await asActor({ organizationId: org.buyer }, () =>
      wiring.orders.place(
        { lines: [{ offerId, offerVersion: 1, quantity: 2 }] },
        key('missed-start'),
      ),
    );
    await asActor({ organizationId: org.buyer }, () =>
      wiring.orders.cancel(order.id, { reason: 'cancel before start' }),
    );
    const ack = jest
      .spyOn(store, 'finish')
      .mockRejectedValueOnce(new Error('accepted before ack crash'));
    await asActor({ organizationId: org.buyer }, () => client.start(order.id));
    expect(ack).toHaveBeenCalledTimes(1);
    expect(ack.mock.calls[0]?.[1]).toBe(true);
    ack.mockRestore();
    await setTenantEligibilityFixture(prisma, 'sagaStartExpired', org.buyer, [order.id]);
    // The actual server now answers AlreadyStarted, and the DB records it.
    await asActor({ organizationId: org.buyer }, () => client.start(order.id));
    expect(
      await runUnscoped('test reads its own receipt', async () =>
        prisma.client.order.findUniqueOrThrow({ where: { id: order.id } }),
      ),
    ).toHaveProperty('sagaStartDeliveredAt', expect.any(Date));
    const worker = await Worker.create({
      connection: temporal.nativeConnection,
      taskQueue: queue,
      workflowsPath: require.resolve('../src/temporal/workflows'),
      activities: createActivities({ orders: wiring.orders, economic }),
    });
    await worker.runUntil(async () => {
      await asActor({ organizationId: org.buyer }, () => client.start(order.id));
      const handle = temporal.client.workflow.getHandle(OrderSagaClient.workflowIdFor(order.id));
      expect(await handle.result()).toBe('CANCELLED');
      await client.tick();
      await asActor({ organizationId: org.buyer }, () => client.start(order.id));
      expect(await wiring.orders.sagaView(order.id)).toHaveProperty('status', 'CANCELLED');
      const offer = await asActor({ organizationId: org.supplier }, async () =>
        prisma.client.offer.findUniqueOrThrow({ where: { id: offerId } }),
      );
      expect(offer.availableQuantity).toBe(10);
      expect(createObligation).not.toHaveBeenCalled();
      expect(findObligations).toHaveBeenCalledTimes(1);
    });
  } finally {
    await client.onModuleDestroy();
    await cleanup(prisma, [org.buyer, org.supplier, org.other]);
    await prisma.onModuleDestroy();
    connect.mockRestore();
    await temporal.teardown();
  }
}, 300_000);
