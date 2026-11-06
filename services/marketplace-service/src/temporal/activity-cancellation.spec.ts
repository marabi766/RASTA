import { createTemporalTestEnvironment } from '../../test/temporal-environment';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { MockActivityEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { InternalTokenService } from '@rasta/nest-common';
import { createActivities } from './activities';
import { EconomicClient } from '../economic/economic.client';
import type { MarketplaceEnv } from '../config/env';
import type { OrderService } from '../order/order.service';

jest.setTimeout(120_000);

it('real Temporal cancellation reaches a financial fetch through heartbeats without inferring a refusal', async () => {
  let sent: () => void = () => undefined;
  let closed: () => void = () => undefined;
  const requested = new Promise<void>((resolve) => {
    sent = resolve;
  });
  const disconnected = new Promise<void>((resolve) => {
    closed = resolve;
  });
  let financialKey: string | undefined;
  const server = createServer((req, res) => {
    financialKey = req.headers['idempotency-key'] as string | undefined;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"id":');
    sent();
    res.on('close', closed);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing test listener');
  const economic = new EconomicClient(
    {
      ECONOMIC_SERVICE_URL: `http://127.0.0.1:${address.port}`,
      ECONOMIC_REQUEST_TIMEOUT_MS: 60_000,
    } as MarketplaceEnv,
    { issue: async () => 'unused-local-token' } as unknown as InternalTokenService,
  );
  const markFailed = jest.fn();
  const orders = {
    describe: async () => ({
      id: 'ORD_CANCEL',
      status: 'PENDING',
      buyerOrganizationId: 'ORG_BUY',
      supplierOrganizationId: 'ORG_SELL',
      totalAmountMinor: '100',
      currency: 'IRR',
      economicTransactionId: null,
      correlationId: 'corr-cancel',
    }),
    sagaView: async () => ({
      status: 'PENDING',
      economicTransactionId: null,
      cancellationReason: null,
      dispute: null,
    }),
    onceForSaga: async (
      _order: unknown,
      _step: unknown,
      _name: unknown,
      effect: () => Promise<unknown>,
    ) => effect(),
    markFailed,
  } as unknown as OrderService;
  const env = await createTemporalTestEnvironment();
  try {
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: 'heartbeat-cancel',
      workflowsPath: require.resolve('./workflows'),
      activities: createActivities({ orders, economic }),
      maxHeartbeatThrottleInterval: '1 second',
      defaultHeartbeatThrottleInterval: '1 second',
    });
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start('orderSaga', {
        workflowId: 'order-ORD_CANCEL',
        taskQueue: 'heartbeat-cancel',
        args: [
          {
            orderId: 'ORD_CANCEL',
            fulfillmentWindowDays: 7,
            receiptWindowDays: 3,
            reminderIntervalDays: 3,
          },
        ],
      });
      await requested;
      await handle.cancel();
      await expect(handle.result()).rejects.toMatchObject({ cause: { name: 'CancelledFailure' } });
      let timeout: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          disconnected,
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(
              () => reject(new Error('heartbeat did not abort financial fetch')),
              10_000,
            );
          }),
        ]);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
      expect(financialKey).toBe('order:ORD_CANCEL:hold');
      expect(markFailed).not.toHaveBeenCalled();
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await env.teardown();
  }
});

it('activity heartbeat interval is cleaned up on a failed owner read', async () => {
  jest.useFakeTimers();
  try {
    const env = new MockActivityEnvironment({ heartbeatTimeoutMs: 10_000 });
    const heartbeat = jest.fn();
    env.on('heartbeat', heartbeat);
    const orders = {
      describe: async () => {
        throw new Error('owner read failed');
      },
    } as unknown as OrderService;
    const activities = createActivities({ orders, economic: {} as EconomicClient });
    await expect(env.run(() => activities.readOrder('ORD_CLEANUP'))).rejects.toThrow(
      'owner read failed',
    );
    expect(heartbeat).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  } finally {
    jest.useRealTimers();
  }
});
