import { createTemporalTestEnvironment } from '../../test/temporal-environment';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { MockActivityEnvironment } from '@temporalio/testing';
import { CancelledFailure, Context } from '@temporalio/activity';
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
    // The capability question, answered as the D-150 release does (FU-233).
    if (req.method === 'GET' && req.url === '/v1/transactions/capabilities') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ heldProven: true, orderHoldDeadlineRequired: true }));
      return;
    }
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
    // The hold's intent is recorded before the call (#836 r1 R2a).
    openSagaCall: async () => ({ generation: 1, started: true }),
    confirmSagaCall: async () => undefined,
    claimHoldSend: async (_order: unknown, proposed?: string) => ({
      holdNotAfter: proposed ?? null,
      claims: 1,
    }),
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

/**
 * Review of #948 r1, L4: the D-150 question (FU-233) is asked inside the activity's
 * heartbeat and cancellation handling. A cancelled activity is cancelled: never an
 * answer of `false`, never a retryable "no answer".
 */
describe('the hold-deadline question in a cancelled activity', () => {
  const closedOrder = {
    describe: async () => ({ id: 'ORD_Q', buyerOrganizationId: 'ORG_BUY', correlationId: 'c' }),
    sagaView: async () => ({
      status: 'FAILED',
      economicTransactionId: null,
      cancellationReason: null,
      dispute: null,
      holdNotAfter: null,
      holdSendsClosed: true,
      holdMayHaveSent: true,
    }),
    closeHoldSendsIfNoneCanLand: async () => true,
  } as unknown as OrderService;
  /**
   * Unanswered twice, then asked a last time, which waits; cancelled, that request fails as
   * an aborted fetch does. The last ask has no pause after it to notice the cancellation.
   */
  const hanging = (lastAsk: () => void) => {
    let asks = 0;
    return {
      requiresOrderHoldDeadline: () =>
        new Promise((_resolve, reject) => {
          if ((asks += 1) < 3) {
            reject(new Error('timed out'));
            return;
          }
          lastAsk();
          const { cancellationSignal } = Context.current();
          cancellationSignal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    } as unknown as EconomicClient;
  };

  it.each([
    ['noHoldCanLand', (a: ReturnType<typeof createActivities>) => a.noHoldCanLand('ORD_Q')],
    ['readOrder', (a: ReturnType<typeof createActivities>) => a.readOrder('ORD_Q')],
  ])('%s: cancelled, and heartbeating while it asks', async (_name, run) => {
    const env = new MockActivityEnvironment({ heartbeatTimeoutMs: 10_000 });
    const heartbeat = jest.fn();
    env.on('heartbeat', heartbeat);
    let lastAsk: () => void = () => undefined;
    const asked = new Promise<void>((resolve) => {
      lastAsk = resolve;
    });
    const activities = createActivities({ orders: closedOrder, economic: hanging(lastAsk) });
    const running = env.run(() => run(activities));
    await asked;
    // Past the pauses between the asks: the activity's own heartbeat ran through them.
    expect(heartbeat.mock.calls.length).toBeGreaterThan(1);
    env.cancel();
    await expect(running).rejects.toBeInstanceOf(CancelledFailure);
  });
});
