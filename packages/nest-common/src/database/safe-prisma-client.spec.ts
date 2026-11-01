import { inspect } from 'node:util';
import { clientFailureCode } from './client-failure';
import { createSafePrismaClient, DatabaseConnectionError } from './safe-prisma-client';

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
  expect(raw.$transaction).toHaveBeenCalledWith(work, options);
});
