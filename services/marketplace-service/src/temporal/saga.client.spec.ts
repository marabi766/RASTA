import { WorkflowNotFoundError } from '@temporalio/client';
import { OrderSagaClient } from './saga.client';
import type { MarketplaceEnv } from '../config/env';

/**
 * The saga client's own decisions.
 *
 * Every one of them is about what happens **after** a command has already
 * committed. The database write comes first and the signal second, so by the
 * time this class runs, the order is correct and the user's request has
 * succeeded — which makes "what do we do when Temporal is unreachable" a
 * question with exactly one right answer: log it, and do not fail a command
 * that worked.
 *
 * That is easy to write and easy to break. A `throw` added here would turn a
 * placed order into a 500 for the buyer whose order exists, and no test of the
 * domain would notice. Hence this file.
 *
 * The Temporal SDK is stubbed, because it is a network client to a server in
 * another process. What is *not* stubbed is any of this class's own logic: the
 * disabled short-circuit, the connection cache, the workflow id, the argument
 * it starts the saga with, and the two different ways a failure is treated.
 */

const connect = jest.fn();
const ClientMock = jest.fn();

jest.mock('@temporalio/client', () => {
  const actual = jest.requireActual('@temporalio/client');
  return {
    ...actual,
    Connection: { connect: (...args: unknown[]) => connect(...args) },
    Client: function (...args: unknown[]) {
      return ClientMock(...args);
    },
  };
});

function env(overrides: Partial<MarketplaceEnv> = {}): MarketplaceEnv {
  return {
    MARKETPLACE_TEMPORAL_ENABLED: true,
    TEMPORAL_ADDRESS: 'temporal.invalid:7233',
    TEMPORAL_NAMESPACE: 'rasta',
    MARKETPLACE_TEMPORAL_TASK_QUEUE: 'marketplace-orders',
    MARKETPLACE_FULFILLMENT_WINDOW_DAYS: 7,
    MARKETPLACE_RECEIPT_WINDOW_DAYS: 3,
    MARKETPLACE_REMINDER_INTERVAL_DAYS: 2,
    ...overrides,
    // JUSTIFIED-ANY: only the Temporal-related settings are read by this class,
    // and building the whole environment here would couple a test about
    // signalling to every unrelated variable the service happens to need.
  } as any as MarketplaceEnv;
}

/** A stub Temporal client that records what it was asked to do. */
function stubTemporal(
  overrides: { start?: () => Promise<unknown>; signal?: () => Promise<unknown> } = {},
) {
  const start = jest.fn(overrides.start ?? (async () => undefined));
  const signal = jest.fn(overrides.signal ?? (async () => undefined));
  const getHandle = jest.fn(() => ({ signal }));
  const close = jest.fn(async () => undefined);

  connect.mockResolvedValue({ close });
  ClientMock.mockReturnValue({ workflow: { start, getHandle } });

  return { start, signal, getHandle, close };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('when Temporal is disabled', () => {
  it('does not dial anything and says so, rather than failing the order', async () => {
    // The state a developer without a Temporal server gets. The order exists
    // and is PENDING, which is visible and recoverable; a thrown error would
    // instead tell the buyer their order did not happen when it did.
    const client = new OrderSagaClient(env({ MARKETPLACE_TEMPORAL_ENABLED: false }));

    await client.start('ORD_1');
    await client.signal('ORD_1', 'confirmed');

    expect(connect).not.toHaveBeenCalled();
  });
});

describe('starting a saga', () => {
  it('uses the order id as the workflow id, so a race cannot start two', async () => {
    // Temporal refuses a second workflow with a running id. That makes "one
    // saga per order" a property of the system rather than a rule this code
    // has to keep, which is why the id is derived and not random.
    const temporal = stubTemporal();
    await new OrderSagaClient(env()).start('ORD_7');

    expect(temporal.start).toHaveBeenCalledTimes(1);
    const [workflowName, options] = temporal.start.mock.calls[0] as [
      string,
      { workflowId: string; taskQueue: string; args: [Record<string, number | string>] },
    ];
    expect(workflowName).toBe('orderSaga');
    expect(options.workflowId).toBe('order-ORD_7');
    expect(OrderSagaClient.workflowIdFor('ORD_7')).toBe(options.workflowId);
  });

  it('passes the configured windows, so a deployment can change them', async () => {
    // The windows are governance, not code (AGENTS.md § 9). Hard-coding them
    // in the workflow would make a policy change a release.
    const temporal = stubTemporal();
    await new OrderSagaClient(
      env({
        MARKETPLACE_FULFILLMENT_WINDOW_DAYS: 14,
        MARKETPLACE_RECEIPT_WINDOW_DAYS: 5,
        MARKETPLACE_REMINDER_INTERVAL_DAYS: 4,
      }),
    ).start('ORD_8');

    const [, options] = temporal.start.mock.calls[0] as [
      string,
      { args: [Record<string, unknown>] },
    ];
    expect(options.args[0]).toEqual({
      orderId: 'ORD_8',
      fulfillmentWindowDays: 14,
      receiptWindowDays: 5,
      reminderIntervalDays: 4,
    });
  });

  it('swallows a failure, because the order already exists', async () => {
    // The single most important assertion in this file. `place()` has already
    // committed by the time this runs; raising here would 500 a request that
    // succeeded and invite a retry that places a second order.
    stubTemporal({ start: () => Promise.reject(new Error('temporal is down')) });

    await expect(new OrderSagaClient(env()).start('ORD_9')).resolves.toBeUndefined();
  });

  it('swallows a connection failure too', async () => {
    connect.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(new OrderSagaClient(env()).start('ORD_10')).resolves.toBeUndefined();
  });
});

describe('signalling a running saga', () => {
  it('signals the workflow that belongs to the order', async () => {
    const temporal = stubTemporal();
    await new OrderSagaClient(env()).signal('ORD_11', 'receiptConfirmed', { by: 'buyer' });

    expect(temporal.getHandle).toHaveBeenCalledWith('order-ORD_11');
    expect(temporal.signal).toHaveBeenCalledWith('receiptConfirmed', { by: 'buyer' });
  });

  it('treats a missing saga as a gap to see, not a command to fail', async () => {
    // The order's state change committed. A saga that is not running is
    // something an operator can restart; failing the user's command after it
    // succeeded fixes nothing and loses the change they can see.
    stubTemporal({
      signal: () => Promise.reject(new WorkflowNotFoundError('gone', 'order-ORD_12', 'rasta')),
    });

    await expect(new OrderSagaClient(env()).signal('ORD_12', 'confirmed')).resolves.toBeUndefined();
  });

  it('swallows any other signalling failure as well', async () => {
    stubTemporal({ signal: () => Promise.reject(new Error('deadline exceeded')) });

    await expect(new OrderSagaClient(env()).signal('ORD_13', 'confirmed')).resolves.toBeUndefined();
  });
});

describe('the connection', () => {
  it('is established once and reused across calls', async () => {
    // One TCP connection per command would be a new connection per order.
    const temporal = stubTemporal();
    const client = new OrderSagaClient(env());

    await client.start('ORD_14');
    await client.signal('ORD_14', 'confirmed');
    await client.start('ORD_15');

    expect(connect).toHaveBeenCalledTimes(1);
    expect(temporal.start).toHaveBeenCalledTimes(2);
  });

  it('is not established twice when two commands race for it', async () => {
    // Both callers await the same in-flight connect rather than opening one
    // each. Without the shared promise, a burst of orders at start-up opens a
    // connection per order and discards all but the last.
    let release: (value: unknown) => void = () => undefined;
    connect.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const start = jest.fn(async () => undefined);
    ClientMock.mockReturnValue({ workflow: { start, getHandle: () => ({ signal: start }) } });

    const client = new OrderSagaClient(env());
    const both = Promise.all([client.start('ORD_16'), client.start('ORD_17')]);
    release({ close: async () => undefined });
    await both;

    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('is retried after a failed attempt rather than cached as broken', async () => {
    // A failed connect must not poison every later command. The first attempt
    // fails, the second reaches a healthy server.
    connect.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const client = new OrderSagaClient(env());
    await client.start('ORD_18');

    const temporal = stubTemporal();
    await client.start('ORD_19');

    expect(temporal.start).toHaveBeenCalledTimes(1);
  });

  it('is closed on shutdown, and closing an unopened one is not an error', async () => {
    const temporal = stubTemporal();
    const client = new OrderSagaClient(env());

    await new OrderSagaClient(env()).onModuleDestroy();
    expect(temporal.close).not.toHaveBeenCalled();

    await client.start('ORD_20');
    await client.onModuleDestroy();
    expect(temporal.close).toHaveBeenCalledTimes(1);
  });
});
