import { WorkerBoundary, WorkerAbandonedError } from '../worker-boundary';
import { inspect } from 'node:util';
import { clientFailureCode } from './client-failure';
import { createSafePrismaClient, DatabaseConnectionError } from './safe-prisma-client';
import {
  SessionTimeZoneRefusedError,
  UTC_SESSION_CHECK_SQL,
  isSessionCheck,
  isZoneFreeOperation,
  transactionIdentity,
} from './utc-session';

const leaky = () =>
  Object.assign(new Error('private-sentinel-79'), {
    name: 'PrismaClientInitializationError',
    errorCode: 'P1000',
    input: 'JZ97-another-secret',
    cause: new Error('JZ97-another-secret'),
  });
const SENTINEL = /sentinel|JZ97|another.secret/i;

test.each(['P1000', 'P1001', 'ECONNREFUSED', 'AccessDenied'])(
  'recognizes registered code %s',
  (code) => {
    expect(clientFailureCode({ code })).toBe(code);
  },
);

test.each(['PRIVATE_SENTINEL_79', 'JZ97ANOTHERSECRET', 'PrivateSentinel79', 99999])(
  'does not trust the shape of a foreign code/name: %s',
  (code) => {
    expect(clientFailureCode({ code, name: code, errorCode: code })).toBe('unknown');
  },
);

test('a foreign getter cannot escape the diagnostic boundary', () => {
  expect(
    clientFailureCode({
      get code(): never {
        throw leaky();
      },
    }),
  ).toBe('unknown');
});

interface TestClient {
  $connect: jest.Mock<Promise<void>, []>;
  $disconnect: jest.Mock<Promise<void>, []>;
  $transaction: jest.Mock<Promise<unknown>, unknown[]>;
  $on: jest.Mock;
  $extends(extension: unknown): TestClient;
}

function client(): TestClient {
  const raw: TestClient = {
    $connect: jest.fn(async () => {
      throw leaky();
    }),
    $disconnect: jest.fn(async () => {
      throw leaky();
    }),
    $transaction: jest.fn(async (..._args: unknown[]) => {
      throw leaky();
    }),
    $on: jest.fn(),
    $extends: (_extension: unknown): TestClient => raw,
  };
  return raw;
}

function safe(error: unknown): void {
  expect(error).toBeInstanceOf(DatabaseConnectionError);
  expect(inspect(error, { showHidden: true, depth: 10 })).not.toMatch(SENTINEL);
  expect(error).toMatchObject({ setting: 'DATABASE_URL_ASSET', code: 'P1000' });
  expect((error as Error).cause).toBeUndefined();
}

test('constructor failure is replaced and no driver object is retained', () => {
  let failure: unknown;
  try {
    createSafePrismaClient(() => {
      throw leaky();
    }, 'DATABASE_URL_ASSET');
  } catch (error) {
    failure = error;
  }
  safe(failure);
});

test.each(['$connect', '$disconnect', '$transaction'] as const)(
  '%s sanitizes failures even after more extensions',
  async (method) => {
    const raw = client();
    const guarded = createSafePrismaClient(() => raw, 'DATABASE_URL_ASSET').$extends({});
    // Source shape is unchanged, and merely making the client does not connect it.
    expect(raw.$connect).not.toHaveBeenCalled();
    const failure: unknown = await guarded[method]().catch((e: unknown) => e);
    safe(failure);
    expect(raw[method]).toHaveBeenCalledTimes(1);
  },
);

test('transaction query/domain failures and options pass through unchanged', async () => {
  const raw = client();
  const refusal = Object.assign(new Error('unique conflict'), { code: 'P2002' });
  raw.$transaction.mockRejectedValue(refusal);
  const guarded = createSafePrismaClient(() => raw, 'DATABASE_URL_ASSET');
  const work = () => Promise.resolve();
  const options = { timeout: 1234, maxWait: 567 };
  await expect(guarded.$transaction(work, options)).rejects.toBe(refusal);
  expect(raw.$transaction).toHaveBeenCalledWith(expect.any(Function), options);
});

describe('the session check inside every transaction (FU-188)', () => {
  const REFUSAL = Object.assign(
    new Error(
      'Raw query failed. Message: `invalid input syntax: "session TimeZone is not UTC: X"`',
    ),
    { code: 'P2010' },
  );

  function checking() {
    const raw = client() as TestClient & { $queryRawUnsafe: jest.Mock };
    raw.$queryRawUnsafe = jest.fn(() => 'check-statement');
    raw.$transaction.mockImplementation(async (work: unknown, options?: unknown) => {
      void options;
      if (typeof work === 'function') {
        return (work as (tx: unknown) => unknown)({ $queryRawUnsafe: raw.$queryRawUnsafe });
      }
      return (work as unknown[]).map((_, index) => `result-${index}`);
    });
    return { raw, guarded: createSafePrismaClient(() => raw, 'DATABASE_URL_ASSET') };
  }

  test('an interactive transaction runs the check before its own first statement', async () => {
    const { raw, guarded } = checking();
    const order: string[] = [];
    raw.$queryRawUnsafe.mockImplementation((sql: string) => {
      order.push(sql === UTC_SESSION_CHECK_SQL ? 'check' : sql);
      return Promise.resolve([]);
    });
    await guarded.$transaction(async () => {
      order.push('work');
      return 'done';
    });
    expect(order).toEqual(['check', 'work']);
  });

  test('a refused check runs no work and surfaces no driver text', async () => {
    const { raw, guarded } = checking();
    raw.$queryRawUnsafe.mockRejectedValue(REFUSAL);
    const work = jest.fn(async () => 'done');
    const refused: unknown = await guarded.$transaction(work).catch((error: unknown) => error);
    expect(work).not.toHaveBeenCalled();
    expect(refused).toBeInstanceOf(SessionTimeZoneRefusedError);
    expect(inspect(refused, { depth: 10, showHidden: true })).not.toMatch(/invalid input|P2010/);
  });

  test('a batch gets the check first, and answers only its own statements', async () => {
    const { raw, guarded } = checking();
    const statements = ['a', 'b'];
    await expect(guarded.$transaction(statements)).resolves.toEqual(['result-1', 'result-2']);
    expect(raw.$transaction).toHaveBeenCalledWith(['check-statement', 'a', 'b']);
  });

  test('a query error that is not the refusal stays what it is', async () => {
    const { raw, guarded } = checking();
    const other = Object.assign(new Error('session TimeZone is not UTC'), { code: 'P2002' });
    raw.$queryRawUnsafe.mockRejectedValue(other);
    await expect(guarded.$transaction(async () => 'done')).rejects.toBe(other);
  });

  test('every client carries the check as its LAST extension', () => {
    const raw = client();
    const applied: string[] = [];
    const chain = (names: string[]): TestClient => ({
      ...raw,
      $extends: (extension: unknown): TestClient => {
        const name = (extension as { name?: string }).name ?? 'theirs';
        applied.push([...names, name].join(' > '));
        return chain([...names, name]);
      },
    });
    createSafePrismaClient(() => chain([]), 'DATABASE_URL_ASSET').$extends({});
    expect(applied.at(-1)).toBe('database-connection-diagnostics > theirs > utc-session-check');
  });
});

test('a Prisma that stops naming the transaction refuses, it does not guess', () => {
  const lock = {};
  const itx = { kind: 'itx' };
  expect(() => transactionIdentity({})).toThrow(/refused/);
  expect(() => transactionIdentity({ __internalParams: { transaction: {} } })).toThrow(/refused/);
  expect(() =>
    transactionIdentity({ __internalParams: { transaction: { kind: 'batch' } } }),
  ).toThrow(/refused/);
  expect(transactionIdentity({ __internalParams: {} })).toBeUndefined();
  expect(transactionIdentity({ __internalParams: { transaction: itx } })).toBe(itx);
  expect(transactionIdentity({ __internalParams: { transaction: { kind: 'batch', lock } } })).toBe(
    lock,
  );
});

test('only the verbatim statement counts as the check', () => {
  expect(isSessionCheck('$queryRawUnsafe', [UTC_SESSION_CHECK_SQL])).toBe(true);
  expect(isSessionCheck('$executeRawUnsafe', [UTC_SESSION_CHECK_SQL])).toBe(false);
  expect(isSessionCheck('$queryRawUnsafe', [UTC_SESSION_CHECK_SQL, 1])).toBe(false);
  expect(isSessionCheck('$queryRawUnsafe', ['SELECT 1'])).toBe(false);
  expect(isSessionCheck('$queryRaw', UTC_SESSION_CHECK_SQL)).toBe(false);
});

test.each([
  [undefined, '$queryRaw', false],
  [undefined, '$executeRawUnsafe', false],
  ['Order', 'create', false],
  ['Order', 'updateMany', false],
  ['Order', 'somethingNew', false],
  ['Order', 'findMany', true],
  ['Order', 'count', true],
])('only a plain model read skips the check: %s.%s', (model, operation, free) => {
  expect(isZoneFreeOperation(model, operation)).toBe(free);
});

// Connection acquisition can fail after a pool was initialized successfully.
test.each(['P1001', 'P1002', 'P1017', 'P2024', 'P2037'])(
  '%s known-request acquisition failures are replaced independently of initialization',
  async (code) => {
    const raw = client();
    const failure = Object.assign(leaky(), {
      name: 'PrismaClientKnownRequestError',
      errorCode: undefined,
      code,
    });
    raw.$transaction.mockRejectedValue(failure);
    const guarded = createSafePrismaClient(() => raw, 'DATABASE_URL_ASSET');
    const safeFailure: unknown = await guarded.$transaction().catch((error: unknown) => error);
    expect(safeFailure).toBeInstanceOf(DatabaseConnectionError);
    expect(safeFailure).toMatchObject({ code });
    expect(inspect(safeFailure, { depth: 10, showHidden: true })).not.toMatch(SENTINEL);
    expect(raw.$transaction).toHaveBeenCalledTimes(1);
  },
);

test('FU-321: nested transaction continuations and late outcomes are refused', async () => {
  const raw = client();
  const guarded = createSafePrismaClient(() => raw, 'DATABASE_URL_ASSET').$extends({});
  const warn = jest.fn();
  const worker = new WorkerBoundary(warn);
  let finish = (): void => undefined;
  raw.$transaction.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = () => resolve('late');
      }),
  );
  const running = worker.run(async () => {
    await guarded.$transaction(() => Promise.resolve());
  });
  worker.abandon();
  finish();
  await expect(running).rejects.toBeInstanceOf(WorkerAbandonedError);
  await expect(
    worker.run(() => guarded.$transaction(() => Promise.resolve())),
  ).rejects.toBeInstanceOf(WorkerAbandonedError);
  expect(raw.$transaction).toHaveBeenCalledTimes(1);
  expect(warn).toHaveBeenCalled();
});

test('FU-321: disconnect permanently refuses worker operations across extensions', async () => {
  const raw = client();
  raw.$disconnect.mockResolvedValue();
  const guarded = createSafePrismaClient(() => raw, 'DATABASE_URL_ASSET');
  await guarded.$disconnect();
  const worker = new WorkerBoundary(jest.fn());
  await expect(
    worker.run(() => guarded.$extends({}).$transaction(() => Promise.resolve())),
  ).rejects.toThrow('Database shutdown');
  await expect(worker.run(() => guarded.$connect())).rejects.toThrow('Database shutdown');
  expect(raw.$transaction).not.toHaveBeenCalled();
  expect(raw.$connect).not.toHaveBeenCalled();
});

test('CI: an already submitted result outside an abandoned worker survives disconnect', async () => {
  const raw = client();
  raw.$disconnect.mockResolvedValue();
  let finish = (): void => undefined;
  raw.$transaction.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = () => resolve('submitted');
      }),
  );
  const guarded = createSafePrismaClient(() => raw, 'DATABASE_URL_ASSET');
  const pending = guarded.$transaction(() => Promise.resolve());
  await guarded.$disconnect();
  finish();
  await expect(pending).resolves.toBe('submitted');
  const worker = new WorkerBoundary(jest.fn());
  await expect(worker.run(() => guarded.$transaction(() => Promise.resolve()))).rejects.toThrow(
    'Database shutdown',
  );
});
