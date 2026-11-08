import { inspect } from 'node:util';
import { createSystemContext, runWithContext } from '@rasta/nest-common';
import { Logger } from '@nestjs/common';
import { WorkflowExecutionAlreadyStartedError, WorkflowNotFoundError } from '@temporalio/client';
import { foreignFailure } from './foreign-failure';
import type { SagaStartStore } from './saga-start.store';
import { OrderSagaClient } from './saga.client';
import { installTemporalRuntimeLogger } from './runtime-logger';
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

jest.mock('./runtime-logger', () => ({ installTemporalRuntimeLogger: jest.fn() }));

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

const store = {} as SagaStartStore;

function env(overrides: Partial<MarketplaceEnv> = {}): MarketplaceEnv {
  return {
    MARKETPLACE_TEMPORAL_ENABLED: true,
    TEMPORAL_ADDRESS: 'temporal.invalid:7233',
    TEMPORAL_NAMESPACE: 'rasta',
    MARKETPLACE_TEMPORAL_TASK_QUEUE: 'marketplace-orders',
    MARKETPLACE_FULFILLMENT_WINDOW_DAYS: 7,
    MARKETPLACE_RECEIPT_WINDOW_DAYS: 3,
    MARKETPLACE_REMINDER_INTERVAL_DAYS: 2,
    MARKETPLACE_SAGA_RECHECK_HOURS: 24,
    ...overrides,
    // JUSTIFIED-ANY: only the Temporal-related settings are read by this class,
    // and building the whole environment here would couple a test about
    // signalling to every unrelated variable the service happens to need.
  } as any as MarketplaceEnv;
}

const economicReady = { provesHeldFunds: async () => true };

/** A stub Temporal client that records what it was asked to do. */
function stubTemporal(
  overrides: {
    start?: () => Promise<unknown>;
    signal?: () => Promise<unknown>;
    describe?: () => Promise<unknown>;
    retention?: number;
  } = {},
) {
  const start = jest.fn(overrides.start ?? (async () => undefined));
  const signal = jest.fn(overrides.signal ?? (async () => undefined));
  const describe = jest.fn(
    overrides.describe ??
      (async () => {
        throw new WorkflowNotFoundError('missing', 'order-test', 'default');
      }),
  );
  const getHandle = jest.fn(() => ({ signal, describe }));
  const close = jest.fn(async () => undefined);

  connect.mockResolvedValue({ close });
  ClientMock.mockReturnValue({
    workflow: { start, getHandle },
    workflowService: {
      describeNamespace: async () => ({
        config: { workflowExecutionRetentionTtl: { seconds: overrides.retention ?? 86400 } },
      }),
    },
    connection: {
      withDeadline: (_deadline: number, fn: () => unknown) => fn(),
      withAbortSignal: (_signal: AbortSignal, fn: () => unknown) => fn(),
    },
  });

  return { start, signal, getHandle, close, describe };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('the economic-service prerequisite (#824 r1, F3)', () => {
  const claim = {
    id: 'ORD_30',
    organization_id: 'ORG_BUYER',
    first_possible_start_at: new Date(0),
    age_ms: 0,
    token: 'token',
  };
  const claims = () =>
    ({
      claim: jest.fn(async () => [claim]),
      finish: jest.fn(async () => 1),
      backlog: jest.fn(async () => ({ count: 1, age: 0 })),
      unresolved: jest.fn(async () => []),
    }) as unknown as jest.Mocked<SagaStartStore>;
  const inContext = (act: () => Promise<void>) =>
    runWithContext(
      createSystemContext({ organizationId: 'ORG_BUYER', correlationId: 'prerequisite-test' }),
      act,
    );

  // Not even claimed: a claim starts the clock after which a start is presumed to have happened.
  it('claims and starts no order against an economic-service that cannot prove a hold', async () => {
    const temporal = stubTemporal();
    const store = claims();
    const client = new OrderSagaClient(env(), store, { provesHeldFunds: async () => false });

    await client.tick();
    await inContext(() => client.start('ORD_30'));
    // Sampling runs on its own timer (#792), independent of the start gate.
    await client.sampleState();

    expect(store.claim).not.toHaveBeenCalled();
    expect(temporal.start).not.toHaveBeenCalled();
    // Still counted: this is what the backlog alert reads.
    expect(store.backlog).toHaveBeenCalledTimes(1);
  });

  it('starts it once economic-service is upgraded', async () => {
    const temporal = stubTemporal();
    const store = claims();
    let upgraded = false;
    const client = new OrderSagaClient(env(), store, { provesHeldFunds: async () => upgraded });
    await client.tick();
    upgraded = true;
    await client.tick();

    expect(temporal.start).toHaveBeenCalledTimes(1);
    expect(store.finish).toHaveBeenCalledWith(claim, true);
  });

  it('claims nothing once stopped while the question was out', async () => {
    const store = claims();
    let answer: (ready: boolean) => void = () => undefined;
    const client = new OrderSagaClient(env(), store, {
      provesHeldFunds: () =>
        new Promise<boolean>((resolve) => {
          answer = resolve;
        }),
    });
    const tick = client.tick();
    const stopping = client.stop();
    answer(true);
    await Promise.all([tick, stopping]);
    expect(store.claim).not.toHaveBeenCalled();
  });
});

describe('when Temporal is disabled', () => {
  it('does not dial anything and says so, rather than failing the order', async () => {
    // The state a developer without a Temporal server gets. The order exists
    // and is PENDING, which is visible and recoverable; a thrown error would
    // instead tell the buyer their order did not happen when it did.
    const client = new OrderSagaClient(
      env({ MARKETPLACE_TEMPORAL_ENABLED: false }),
      store,
      economicReady,
    );

    await client.deliver('ORD_1');
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
    await new OrderSagaClient(env(), store, economicReady).deliver('ORD_7');

    expect(temporal.start).toHaveBeenCalledTimes(1);
    const [workflowName, options] = temporal.start.mock.calls[0] as unknown as [
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
        MARKETPLACE_SAGA_RECHECK_HOURS: 6,
      }),
      store,
      economicReady,
    ).deliver('ORD_8');

    const [, options] = temporal.start.mock.calls[0] as unknown as [
      string,
      { args: [Record<string, unknown>] },
    ];
    expect(options.args[0]).toEqual({
      orderId: 'ORD_8',
      fulfillmentWindowDays: 14,
      receiptWindowDays: 5,
      reminderIntervalDays: 4,
      recheckIntervalHours: 6,
    });
  });

  it('never reuses an order id, so a replayed placement cannot start a second saga', async () => {
    // A replay of `POST /orders` calls start() again. While the first saga
    // runs Temporal refuses by id; after it closes only this policy does.
    const temporal = stubTemporal();
    await new OrderSagaClient(env(), store, economicReady).deliver('ORD_11');

    const [, options] = temporal.start.mock.calls[0] as unknown as [
      string,
      { workflowIdReusePolicy?: string },
    ];
    expect(options.workflowIdReusePolicy).toBe('REJECT_DUPLICATE');
  });

  it('treats an already-started saga as the expected outcome of a replay', async () => {
    stubTemporal({
      start: () =>
        Promise.reject(
          new WorkflowExecutionAlreadyStartedError('already started', 'order-ORD_12', 'orderSaga'),
        ),
    });
    await expect(new OrderSagaClient(env(), store, economicReady).deliver('ORD_12')).resolves.toBe(
      true,
    );
  });

  it('swallows a failure, because the order already exists', async () => {
    // The single most important assertion in this file. `place()` has already
    // committed by the time this runs; raising here would 500 a request that
    // succeeded and invite a retry that places a second order.
    stubTemporal({ start: () => Promise.reject(new Error('temporal is down')) });

    await expect(new OrderSagaClient(env(), store, economicReady).deliver('ORD_9')).resolves.toBe(
      false,
    );
  });

  it('swallows a connection failure too', async () => {
    connect.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(new OrderSagaClient(env(), store, economicReady).deliver('ORD_10')).resolves.toBe(
      false,
    );
  });
});

describe('signalling a running saga', () => {
  it('signals the workflow that belongs to the order', async () => {
    const temporal = stubTemporal();
    await new OrderSagaClient(env(), store, economicReady).signal('ORD_11', 'receiptConfirmed', {
      by: 'buyer',
    });

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

    await expect(
      new OrderSagaClient(env(), store, economicReady).signal('ORD_12', 'confirmed'),
    ).resolves.toBeUndefined();
  });

  it('swallows any other signalling failure as well', async () => {
    stubTemporal({ signal: () => Promise.reject(new Error('deadline exceeded')) });

    await expect(
      new OrderSagaClient(env(), store, economicReady).signal('ORD_13', 'confirmed'),
    ).resolves.toBeUndefined();
  });
});

describe('the connection', () => {
  it('is dialled only after the Temporal runtime (Core logs forwarded) is installed', async () => {
    stubTemporal();
    const settings = env();

    await new OrderSagaClient(settings, store, economicReady).deliver('ORD_21');

    const install = installTemporalRuntimeLogger as jest.Mock;
    expect(install).toHaveBeenCalledWith(settings);
    expect(install.mock.invocationCallOrder[0]).toBeLessThan(connect.mock.invocationCallOrder[0]!);
  });

  it('is established once and reused across calls', async () => {
    // One TCP connection per command would be a new connection per order.
    const temporal = stubTemporal();
    const client = new OrderSagaClient(env(), store, economicReady);

    await client.deliver('ORD_14');
    await client.signal('ORD_14', 'confirmed');
    await client.deliver('ORD_15');

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
    stubTemporal({ start });

    const client = new OrderSagaClient(env(), store, economicReady);
    const both = Promise.all([client.deliver('ORD_16'), client.deliver('ORD_17')]);
    release({ close: async () => undefined });
    await both;

    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('is retried after a failed attempt rather than cached as broken', async () => {
    // A failed connect must not poison every later command. The first attempt
    // fails, the second reaches a healthy server.
    connect.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const client = new OrderSagaClient(env(), store, economicReady);
    await client.deliver('ORD_18');

    const temporal = stubTemporal();
    await client.deliver('ORD_19');

    expect(temporal.start).toHaveBeenCalledTimes(1);
  });

  it('is closed on shutdown, and closing an unopened one is not an error', async () => {
    const temporal = stubTemporal();
    const client = new OrderSagaClient(env(), store, economicReady);

    await new OrderSagaClient(env(), store, economicReady).onModuleDestroy();
    expect(temporal.close).not.toHaveBeenCalled();

    await client.deliver('ORD_20');
    await client.onModuleDestroy();
    expect(temporal.close).toHaveBeenCalledTimes(1);
  });
});

describe('what is logged about Temporal (#385 r6)', () => {
  // The two sentinels of scripts/refusal-probes.mjs, as an address's userinfo
  // and in a failure's text, cause and details.
  const USER = 'private-sentinel-79';
  const PASSWORD = 'JZ97-another-secret';
  const SENTINEL = /sentinel|jz97|another[-_]secret/i;
  const ADDRESS = [USER, ':', PASSWORD, '@temporal.invalid:7233'].join('');
  const leaky = (): Error =>
    Object.assign(new Error(`failed to dial ${ADDRESS}`, { cause: new Error(ADDRESS) }), {
      details: ADDRESS,
    });
  const logged = (spy: jest.SpyInstance): string => JSON.stringify(spy.mock.calls);

  it('a replayed start (REJECT_DUPLICATE) still branches on the SDK type: no error is logged', async () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const debug = jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    stubTemporal({
      start: () =>
        Promise.reject(
          new WorkflowExecutionAlreadyStartedError('already started', 'order-ORD_20', 'orderSaga'),
        ),
    });

    await expect(new OrderSagaClient(env(), store, economicReady).deliver('ORD_20')).resolves.toBe(
      true,
    );
    expect(error).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledWith({ orderId: 'ORD_20' }, 'The order saga was already started');
  });

  it('a missing saga on signal still branches on the SDK type: a warning, no error', async () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    stubTemporal({
      signal: () => Promise.reject(new WorkflowNotFoundError('gone', 'order-ORD_21', 'rasta')),
    });

    await new OrderSagaClient(env(), store, economicReady).signal('ORD_21', 'confirmed');
    expect(error).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('a failed start is logged by class only, nothing of its text, cause or details', async () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    stubTemporal({ start: () => Promise.reject(leaky()) });

    await new OrderSagaClient(env({ TEMPORAL_ADDRESS: ADDRESS }), store, economicReady).deliver(
      'ORD_22',
    );
    expect(error).toHaveBeenCalledWith(
      { orderId: 'ORD_22', failure: { type: 'Error' } },
      'Could not start the order saga',
    );
    expect(logged(error)).not.toMatch(SENTINEL);
  });

  it('a failed connection and a failed signal are logged alike', async () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    connect.mockRejectedValue(Object.assign(leaky(), { code: 14 }));
    await new OrderSagaClient(env({ TEMPORAL_ADDRESS: ADDRESS }), store, economicReady).deliver(
      'ORD_23',
    );
    stubTemporal({ signal: () => Promise.reject(leaky()) });
    await new OrderSagaClient(env({ TEMPORAL_ADDRESS: ADDRESS }), store, economicReady).signal(
      'ORD_24',
      'confirmed',
    );

    expect(error).toHaveBeenCalledTimes(2);
    expect(error.mock.calls[0][0]).toEqual({
      orderId: 'ORD_23',
      failure: { type: 'Error', code: 14 },
    });
    expect(logged(error)).not.toMatch(SENTINEL);
  });

  it('a connection is announced by the setting, never the address it dialled', async () => {
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    stubTemporal();
    await new OrderSagaClient(env({ TEMPORAL_ADDRESS: ADDRESS }), store, economicReady).deliver(
      'ORD_25',
    );

    expect(log).toHaveBeenCalledWith('Temporal client connected (TEMPORAL_ADDRESS)');
    expect(logged(log)).not.toMatch(SENTINEL);
  });

  it('foreignFailure keeps a class and a well-formed code, nothing else', () => {
    expect(foreignFailure(Object.assign(new Error(ADDRESS), { code: 'UNAVAILABLE' }))).toEqual({
      type: 'Error',
      code: 'UNAVAILABLE',
    });
    expect(foreignFailure(Object.assign(new Error('x'), { code: ADDRESS }))).toEqual({
      type: 'Error',
    });
    const renamed = Object.assign(new Error('x'), { name: ADDRESS });
    expect(foreignFailure(renamed)).toEqual({ type: 'unknown' });
    expect(foreignFailure(ADDRESS)).toEqual({ type: 'unknown' });
  });
});

describe('history retention reconciliation', () => {
  const old = 2 * 86400_000;
  it('never starts from absent history outside retention', async () => {
    const temporal = stubTemporal();
    expect(await new OrderSagaClient(env(), store, economicReady).deliver('ORD_OLD', old)).toBe(
      false,
    );
    expect(temporal.start).not.toHaveBeenCalled();
    expect(temporal.describe).toHaveBeenCalledTimes(1);
  });
  it('records existing failed or closed executions as delivered, without restarting', async () => {
    const temporal = stubTemporal({ describe: async () => ({ status: 'FAILED' }) });
    expect(await new OrderSagaClient(env(), store, economicReady).deliver('ORD_OLD', old)).toBe(
      true,
    );
    expect(temporal.start).not.toHaveBeenCalled();
  });
  it('unknown retention fails closed', async () => {
    const temporal = stubTemporal({ retention: 0 });
    expect(await new OrderSagaClient(env(), store, economicReady).deliver('ORD_OLD', 0)).toBe(
      false,
    );
    expect(temporal.start).not.toHaveBeenCalled();
  });
});

describe('starter shutdown', () => {
  it('joins every delivery when another acknowledgment fails', async () => {
    let finishSecond: () => void = () => undefined;
    let secondEntered: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => {
      secondEntered = resolve;
    });
    const finish = jest.fn(async (claim: { id: string }) => {
      if (claim.id === 'ORD_FIRST') throw new Error('ack unavailable');
      secondEntered();
      await new Promise<void>((resolve) => {
        finishSecond = resolve;
      });
      return 1;
    });
    const persistence = {
      claim: async () => ['ORD_FIRST', 'ORD_SECOND'].map((id) => ({ id })),
      finish,
      backlog: async () => ({ count: 0, age: 0 }),
    } as unknown as SagaStartStore;
    const client = new OrderSagaClient(env(), persistence, economicReady);
    jest.spyOn(client, 'deliver').mockResolvedValue(true);
    let joined = false;
    const tick = client.tick().then(() => {
      joined = true;
    });
    await entered;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(joined).toBe(false);
    finishSecond();
    await tick;
    await client.stop();
  });

  it('disabled polling samples backlog without marking an unattempted intent as attempted', async () => {
    const claim = jest.fn();
    const backlog = jest.fn(async () => ({ count: 2, age: 60 }));
    const client = new OrderSagaClient(
      env({ MARKETPLACE_TEMPORAL_ENABLED: false }),
      {
        claim,
        backlog,
        unresolved: async () => [],
      } as unknown as SagaStartStore,
      economicReady,
    );
    await runWithContext(
      createSystemContext({ organizationId: 'ORG_DISABLED', correlationId: 'disabled-start-test' }),
      () => client.start('ORD_DISABLED'),
    );
    await client.tick();
    expect(claim).not.toHaveBeenCalled();
    // On its own timer since #792 r1 F3, not the claim tick's.
    expect(backlog).not.toHaveBeenCalled();
    await client.sampleState();
    expect(backlog).toHaveBeenCalledTimes(1);
    await client.stop();
  });

  it('joins an in-flight claim and starts no delivery or DB work after stopping', async () => {
    let resolve: (value: []) => void = () => undefined;
    const claim = jest.fn(
      () =>
        new Promise<[]>((done) => {
          resolve = done;
        }),
    );
    const backlog = jest.fn();
    const finish = jest.fn();
    const persistence = { claim, backlog, finish } as unknown as SagaStartStore;
    const client = new OrderSagaClient(env(), persistence, economicReady);
    const deliver = jest.spyOn(client, 'deliver');
    const tick = client.tick();
    await new Promise<void>((entered) => setImmediate(entered));
    const stop = client.stop();
    resolve([]);
    await Promise.all([tick, stop]);
    await client.tick();
    expect(claim).toHaveBeenCalledTimes(1);
    expect(deliver).not.toHaveBeenCalled();
    expect(backlog).not.toHaveBeenCalled();
    expect(finish).not.toHaveBeenCalled();
  });
});

test('foreignFailure rejects identifier-shaped secrets in names and codes', () => {
  const failure = Object.assign(new Error('private-sentinel-79'), {
    name: 'PrivateSentinel79',
    code: 'JZ97_ANOTHER_SECRET',
  });
  expect(JSON.stringify(foreignFailure(failure))).not.toMatch(/sentinel|JZ97|another.secret/i);
});

test('Temporal close failures expose fixed diagnostics only', async () => {
  const { close } = stubTemporal();
  close.mockRejectedValue(
    Object.assign(new Error('private-sentinel-79 JZ97-another-secret'), {
      name: 'PrivateSentinel79',
      code: 'JZ97_ANOTHER_SECRET',
      cause: new Error('private-sentinel-79'),
    }),
  );
  const client = new OrderSagaClient(env(), store, economicReady);
  await client.deliver('ORD_CLOSE');
  const failure: unknown = await client.onModuleDestroy().catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  expect(String(failure)).toContain('TEMPORAL_ADDRESS: Temporal close failed');
  expect(inspect(failure, { showHidden: true, depth: 10 })).not.toMatch(/sentinel|JZ97/i);
});
