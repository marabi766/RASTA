import { RastaError, createSystemContext, isRastaError, runWithContext } from '@rasta/nest-common';
import { Prisma } from '../generated/prisma';
import type { PrismaService } from '../prisma/prisma.service';
import {
  IDEMPOTENCY_KEY_MAX_LENGTH,
  IDEMPOTENCY_KEY_MIN_LENGTH,
  IdempotencyStore,
  completedExpiryMs,
  hashRequest,
  idempotentRequest,
  parseReplayDeadline,
  requiredIdempotencyKey,
} from './idempotency';

const ENV = {
  INVENTORY_IDEMPOTENCY_TTL_HOURS: 24,
  INVENTORY_IDEMPOTENCY_CLAIM_LEASE_SECONDS: 120,
  INVENTORY_CLOCK_SKEW_SECONDS: 30,
};

/** A request without a deadline never reads the fence's clock. */
const unusedClock = (): Promise<Date> => Promise.reject(new Error('the clock was read'));

/**
 * The pure halves of the idempotency store; its behaviour against PostgreSQL — claim, replay,
 * concurrent duplicates, release — is `test/idempotency.int-spec.ts`.
 */
describe('requiredIdempotencyKey (docs/06 § 6.8)', () => {
  const refusalOf = (value: string | undefined) => {
    try {
      requiredIdempotencyKey(value);
      return null;
    } catch (error) {
      return isRastaError(error) ? { code: error.code, details: error.details } : String(error);
    }
  };

  it('is trimmed, and 8 to 255 characters', () => {
    expect(requiredIdempotencyKey('  abcdefgh  ')).toBe('abcdefgh');
    expect(requiredIdempotencyKey('x'.repeat(IDEMPOTENCY_KEY_MAX_LENGTH))).toHaveLength(255);
    expect(requiredIdempotencyKey('x'.repeat(IDEMPOTENCY_KEY_MIN_LENGTH))).toHaveLength(8);
  });

  it('is required: none or blank is 400 `required`', () => {
    for (const value of [undefined, '', '   ']) {
      expect(refusalOf(value)).toEqual({
        code: 'VALIDATION_FAILED',
        details: [expect.objectContaining({ path: 'Idempotency-Key', code: 'required' })],
      });
    }
  });

  it('is bounded: too short or too long is 400 `invalid`', () => {
    for (const value of ['short', 'x'.repeat(IDEMPOTENCY_KEY_MAX_LENGTH + 1)]) {
      expect(refusalOf(value)).toEqual({
        code: 'VALIDATION_FAILED',
        details: [expect.objectContaining({ path: 'Idempotency-Key', code: 'invalid' })],
      });
    }
  });

  it('never repeats the key in the refusal', () => {
    expect(JSON.stringify(refusalOf('short'))).not.toContain('short');
  });
});

/**
 * A transaction Prisma could not give the claim in time — the pool exhausted (`P2028` from
 * `$transaction`'s `maxWait`, `P2024` from a statement outside one) — is the request's budget
 * spent, answered like a lock wait: `409 CONFLICT` with `Retry-After`, never a 500. The real
 * exhausted pool is `test/idempotency.int-spec.ts`; these reach the paths it cannot isolate.
 */
describe('IdempotencyStore under an exhausted pool', () => {
  const REQUEST = idempotentRequest({ 'idempotency-key': 'key-abcdefgh' });
  const ENDPOINT = 'POST /v1/stock/adjustments';
  const BODY = { stockItemId: 'SKI_1', quantityDelta: 1 };
  const context = createSystemContext({
    correlationId: 'corr-1',
    organizationId: 'ORG_1',
    userId: 'USR_1',
  });
  const p2028 = () =>
    new Prisma.PrismaClientKnownRequestError(
      'Transaction API error: Unable to start a transaction in the given time.',
      { code: 'P2028', clientVersion: 'test' },
    );
  const p2024 = () =>
    new Prisma.PrismaClientKnownRequestError(
      'Timed out fetching a new connection from the connection pool.',
      { code: 'P2024', clientVersion: 'test' },
    );
  const uniqueViolation = () =>
    new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: 'test',
    });

  function store(transaction: jest.Mock, findFirst: jest.Mock = jest.fn()) {
    const prisma = {
      transaction,
      client: { idempotencyKey: { findFirst, deleteMany: jest.fn(async () => ({ count: 0 })) } },
    } as unknown as PrismaService;
    return new IdempotencyStore(prisma, ENV, () => undefined, unusedClock);
  }

  const outcomeOf = async (subject: IdempotencyStore) => {
    const work = jest.fn();
    try {
      await runWithContext(context, () =>
        subject.execute(ENDPOINT, REQUEST, BODY, 201, work, jest.fn()),
      );
      return 'RAN';
    } catch (error) {
      expect(work).not.toHaveBeenCalled();
      return isRastaError(error)
        ? { code: error.code, retryAfterSeconds: error.retryAfterSeconds }
        : String(error);
    }
  };

  it('answers a claim that could not get a transaction (withinBudget) 409 CONFLICT, Retry-After 1', async () => {
    const transaction = jest.fn().mockRejectedValue(p2028());
    expect(await outcomeOf(store(transaction))).toEqual({ code: 'CONFLICT', retryAfterSeconds: 1 });
  });

  it('answers a removal of a lapsed claim that could not get a transaction the same way', async () => {
    const transaction = jest
      .fn()
      .mockRejectedValueOnce(uniqueViolation())
      .mockRejectedValue(p2028());
    const findFirst = jest.fn(async () => ({
      requestHash: 'whatever',
      state: 'IN_PROGRESS',
      expiresAt: new Date(Date.now() - 1000),
    }));
    expect(await outcomeOf(store(transaction, findFirst))).toEqual({
      code: 'CONFLICT',
      retryAfterSeconds: 1,
    });
  });

  it('answers a wait for the holder (awaitHolder) that could not get a transaction the same way', async () => {
    const transaction = jest
      .fn()
      .mockRejectedValueOnce(uniqueViolation())
      .mockRejectedValue(p2028());
    const findFirst = jest.fn(async () => ({
      requestHash: runWithContext(context, () => store(jest.fn()).hash(BODY)),
      state: 'IN_PROGRESS',
      expiresAt: new Date(Date.now() + 60_000),
    }));
    expect(await outcomeOf(store(transaction, findFirst))).toEqual({
      code: 'CONFLICT',
      retryAfterSeconds: 1,
    });
    // The wait was attempted, and its failure answered at once rather than retried.
    expect(transaction).toHaveBeenCalledTimes(2);
  });

  it('answers a look at the existing claim that could not get a connection (P2024) the same way', async () => {
    const transaction = jest.fn().mockRejectedValueOnce(uniqueViolation());
    const findFirst = jest.fn().mockRejectedValue(p2024());
    expect(await outcomeOf(store(transaction, findFirst))).toEqual({
      code: 'CONFLICT',
      retryAfterSeconds: 1,
    });
  });

  it('authorizes before anything about the key: a refused caller claims and replays nothing', async () => {
    const transaction = jest.fn();
    const findFirst = jest.fn();
    const refused = new IdempotencyStore(
      { transaction, client: { idempotencyKey: { findFirst } } } as unknown as PrismaService,
      ENV,
      () => {
        throw RastaError.forbidden('Inventory is kept for an organization; act for one');
      },
      unusedClock,
    );
    // No organization at all: the store, reached first, would have thrown a raw Error (a 500).
    const tenantless = createSystemContext({ correlationId: 'corr-2', userId: 'USR_1' });
    const outcome = await runWithContext(tenantless, () =>
      refused.execute(ENDPOINT, REQUEST, BODY, 201, jest.fn(), jest.fn()),
    ).catch((error: unknown) => error);
    expect(isRastaError(outcome) && outcome.code).toBe('FORBIDDEN');
    expect(transaction).not.toHaveBeenCalled();
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('still lets any other failure through as what it is', async () => {
    const transaction = jest.fn().mockRejectedValue(new Error('disk full'));
    expect(await outcomeOf(store(transaction))).toBe('Error: disk full');
  });
});

/**
 * PR-844 r1 F1: a retry that starts before its deadline and only finds the stored response after it.
 * Both the insert that loses and the read of the row can wait, and neither is a replay's licence: the
 * one deadline decision reads the database clock after them, and again after the visibility guard.
 */
describe('the replay deadline after a wait (FU-171)', () => {
  const ENDPOINT = 'POST /v1/warehouses';
  const BODY = { name: 'Central' };
  const context = createSystemContext({
    correlationId: 'corr-1',
    organizationId: 'ORG_1',
    userId: 'USR_1',
  });
  const uniqueViolation = () =>
    new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: 'test',
    });

  /** A deadline this replica's clock has not reached: only the database clock can refuse. */
  const deadline = () => Date.now() + 60_000;

  function harness(deadlineMs: number) {
    const clockReadings: number[] = [];
    const state = { databaseNow: deadlineMs - 1 };
    const prisma = {
      transaction: jest.fn(() => Promise.reject(uniqueViolation())),
      client: {
        idempotencyKey: {
          findFirst: jest.fn(async () => ({
            requestHash: hashRequest({ caller: 'USR_1', body: BODY }),
            state: 'COMPLETED',
            responseStatus: 201,
            responseBody: { id: 'WHS_original' },
            expiresAt: new Date(Date.now() + 3_600_000),
          })),
        },
      },
    };
    const subject = new IdempotencyStore(
      prisma as unknown as PrismaService,
      ENV,
      () => undefined,
      async () => {
        clockReadings.push(state.databaseNow);
        return new Date(state.databaseNow);
      },
    );
    const work = jest.fn();
    const visible = jest.fn(async () => undefined);
    const run = () =>
      runWithContext(context, () =>
        subject.execute(
          ENDPOINT,
          idempotentRequest({
            'idempotency-key': 'key-abcdefgh',
            'idempotency-replay-deadline': String(deadlineMs),
          }),
          BODY,
          201,
          work,
          visible,
        ),
      ).catch((error: unknown) => error);
    return { prisma, state, clockReadings, work, visible, run };
  }

  const expectClosed = (outcome: unknown) =>
    expect(isRastaError(outcome) && outcome.code).toBe('REPLAY_WINDOW_CLOSED');

  it('replays while the database clock has not passed the deadline, equality included', async () => {
    const h = deadline();
    const { state, run, work, clockReadings } = harness(h);
    state.databaseNow = h;
    expect(await run()).toEqual({ result: { id: 'WHS_original' }, executed: false });
    expect(work).not.toHaveBeenCalled();
    // After the read of the row, and after the visibility guard.
    expect(clockReadings).toEqual([h, h]);
  });

  it('insert wait: the insert that lost finished past the deadline — refused, no replay', async () => {
    const h = deadline();
    const { prisma, state, run, work, visible } = harness(h);
    prisma.transaction.mockImplementation(() => {
      state.databaseNow = h + 1;
      return Promise.reject(uniqueViolation());
    });
    expectClosed(await run());
    expect(work).not.toHaveBeenCalled();
    expect(visible).not.toHaveBeenCalled();
  });

  it('read wait: the read of the stored row finished past the deadline — refused, no replay', async () => {
    const h = deadline();
    const { prisma, state, run, work, visible } = harness(h);
    const read = prisma.client.idempotencyKey.findFirst.getMockImplementation()!;
    prisma.client.idempotencyKey.findFirst.mockImplementation(async () => {
      const row = await read();
      state.databaseNow = h + 1;
      return row;
    });
    expectClosed(await run());
    expect(work).not.toHaveBeenCalled();
    expect(visible).not.toHaveBeenCalled();
  });

  it('guard wait: the visibility guard finished past the deadline — the stored body does not leave', async () => {
    const h = deadline();
    const { state, run, visible } = harness(h);
    visible.mockImplementation(async () => {
      state.databaseNow = h + 1;
    });
    expectClosed(await run());
    expect(visible).toHaveBeenCalledTimes(1);
  });

  it('refuses without looking at the key when this replica is already past the deadline', async () => {
    const { prisma, run, clockReadings } = harness(Date.now() - 1);
    expectClosed(await run());
    expect(prisma.transaction).not.toHaveBeenCalled();
    expect(prisma.client.idempotencyKey.findFirst).not.toHaveBeenCalled();
    expect(clockReadings).toEqual([]);
  });

  it('answers a clock reading with no connection after the guard as the retryable 409', async () => {
    const h = deadline();
    const { prisma } = harness(h);
    const p2024 = new Prisma.PrismaClientKnownRequestError('Timed out', {
      code: 'P2024',
      clientVersion: 'test',
    });
    const clocks = jest
      .fn<Promise<Date>, []>()
      .mockResolvedValueOnce(new Date(h - 1))
      .mockRejectedValue(p2024);
    const store = new IdempotencyStore(
      prisma as unknown as PrismaService,
      ENV,
      () => undefined,
      clocks,
    );
    // The row's hash is the caller's own, so this reaches the replay's last reading.
    const outcome = await runWithContext(context, () =>
      store.execute(
        ENDPOINT,
        idempotentRequest({
          'idempotency-key': 'key-abcdefgh',
          'idempotency-replay-deadline': String(h),
        }),
        BODY,
        201,
        jest.fn(),
        jest.fn(async () => undefined),
      ),
    ).catch((error: unknown) => error);
    expect(isRastaError(outcome) && [outcome.code, outcome.retryAfterSeconds]).toEqual([
      'CONFLICT',
      1,
    ]);
  });

  it('a clock that cannot be read refuses, and never falls back to this replica', async () => {
    const h = deadline();
    const { prisma } = harness(h);
    const store = new IdempotencyStore(
      prisma as unknown as PrismaService,
      ENV,
      () => undefined,
      () => Promise.reject(new Error('no reading')),
    );
    const work = jest.fn();
    const visible = jest.fn();
    const outcome = await runWithContext(context, () =>
      store.execute(
        ENDPOINT,
        idempotentRequest({
          'idempotency-key': 'key-abcdefgh',
          'idempotency-replay-deadline': String(h),
        }),
        BODY,
        201,
        work,
        visible,
      ),
    ).catch((error: unknown) => error);
    expect(String(outcome)).toBe('Error: no reading');
    expect(work).not.toHaveBeenCalled();
    expect(visible).not.toHaveBeenCalled();
  });
});

describe('Idempotency-Replay-Deadline (FU-171)', () => {
  const refusalOf = (run: () => unknown) => {
    try {
      run();
      return null;
    } catch (error) {
      return isRastaError(error) ? { code: error.code, details: error.details } : String(error);
    }
  };
  const invalid = {
    code: 'VALIDATION_FAILED',
    details: [expect.objectContaining({ path: 'Idempotency-Replay-Deadline', code: 'invalid' })],
  };

  it('is absent → no fence; one canonical epoch-ms integer → that number', () => {
    expect(parseReplayDeadline(undefined)).toBeUndefined();
    expect(parseReplayDeadline('1767225600000')).toBe(1_767_225_600_000);
    expect(parseReplayDeadline(String(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
  });

  it.each([
    [''],
    ['0'],
    ['01767225600000'],
    ['+1767225600000'],
    ['-1767225600000'],
    [' 1767225600000'],
    ['1767225600000 '],
    ['1.7e12'],
    ['1767225600000.0'],
    ['1767225600000, 1767225600001'],
    ['99999999999999999'],
    [String(Number.MAX_SAFE_INTEGER + 1)],
  ])('refuses %j with 400 invalid, before any claim', (raw) => {
    expect(refusalOf(() => parseReplayDeadline(raw))).toEqual(invalid);
  });

  it('refuses a header sent twice (an array)', () => {
    expect(refusalOf(() => parseReplayDeadline(['1767225600000', '1767225600000']))).toEqual(
      invalid,
    );
  });

  it('is read with the key by idempotentRequest — the only way into the store', () => {
    expect(
      idempotentRequest({
        'idempotency-key': '  key-abcdefgh ',
        'idempotency-replay-deadline': '1767225600000',
      }),
    ).toEqual({ key: 'key-abcdefgh', replayDeadlineMs: 1_767_225_600_000 });
    expect(idempotentRequest({ 'idempotency-key': 'key-abcdefgh' })).toEqual({
      key: 'key-abcdefgh',
      replayDeadlineMs: undefined,
    });
    expect(
      refusalOf(() => idempotentRequest({ 'idempotency-replay-deadline': '1767225600000' })),
    ).toEqual({
      code: 'VALIDATION_FAILED',
      details: [expect.objectContaining({ path: 'Idempotency-Key', code: 'required' })],
    });
    expect(
      refusalOf(() =>
        idempotentRequest({
          'idempotency-key': 'key-abcdefgh',
          'idempotency-replay-deadline': '-5',
        }),
      ),
    ).toEqual(invalid);
  });
});

describe('completedExpiryMs (FU-171)', () => {
  const hour = 3_600_000;

  it('is the retention from completion without a deadline', () => {
    expect(completedExpiryMs(1_000, 1, undefined, 67_000)).toBe(1_000 + hour);
  });

  it('is never earlier than B past the deadline, whatever the completing clock read', () => {
    const h = 10 * hour;
    const behind = h - hour + 1_000;
    expect(completedExpiryMs(behind, 1, h, 67_000)).toBe(h + 67_000);
    expect(completedExpiryMs(h, 1, h, 67_000)).toBe(h + hour);
  });
});

describe('hashRequest', () => {
  it('is the same for the same request in another key order, at any depth', () => {
    expect(hashRequest({ a: 1, b: { c: 2, d: [1, { e: 3, f: 4 }] } })).toBe(
      hashRequest({ b: { d: [1, { f: 4, e: 3 }], c: 2 }, a: 1 }),
    );
  });

  it('differs for another request, another target and another caller', () => {
    const base = hashRequest({ caller: 'USR_1', body: { stockItemId: 'SKI_1', quantity: 2 } });
    expect(hashRequest({ caller: 'USR_2', body: { stockItemId: 'SKI_1', quantity: 2 } })).not.toBe(
      base,
    );
    expect(hashRequest({ caller: 'USR_1', body: { stockItemId: 'SKI_2', quantity: 2 } })).not.toBe(
      base,
    );
    expect(hashRequest({ caller: 'USR_1', body: { stockItemId: 'SKI_1', quantity: 3 } })).not.toBe(
      base,
    );
  });

  it('hashes a key named __proto__ like any other: two bodies never hash alike', () => {
    const plain = JSON.parse('{"a":1}') as unknown;
    const proto = JSON.parse('{"a":1,"__proto__":{"x":1}}') as unknown;
    expect(hashRequest(proto)).not.toBe(hashRequest(plain));
  });
});
