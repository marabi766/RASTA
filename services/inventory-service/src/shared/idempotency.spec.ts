import { RastaError, createSystemContext, isRastaError, runWithContext } from '@rasta/nest-common';
import { Prisma } from '../generated/prisma';
import type { PrismaService } from '../prisma/prisma.service';
import {
  IDEMPOTENCY_KEY_MAX_LENGTH,
  IDEMPOTENCY_KEY_MIN_LENGTH,
  IdempotencyStore,
  hashRequest,
  requiredIdempotencyKey,
} from './idempotency';

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
    return new IdempotencyStore(
      prisma,
      { INVENTORY_IDEMPOTENCY_TTL_HOURS: 24, INVENTORY_IDEMPOTENCY_CLAIM_LEASE_SECONDS: 120 },
      () => undefined,
    );
  }

  const outcomeOf = async (subject: IdempotencyStore) => {
    const work = jest.fn();
    try {
      await runWithContext(context, () =>
        subject.execute(ENDPOINT, 'key-12345678', BODY, 201, work, jest.fn()),
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
      { INVENTORY_IDEMPOTENCY_TTL_HOURS: 24, INVENTORY_IDEMPOTENCY_CLAIM_LEASE_SECONDS: 120 },
      () => {
        throw RastaError.forbidden('Inventory is kept for an organization; act for one');
      },
    );
    // No organization at all: the store, reached first, would have thrown a raw Error (a 500).
    const tenantless = createSystemContext({ correlationId: 'corr-2', userId: 'USR_1' });
    const outcome = await runWithContext(tenantless, () =>
      refused.execute(ENDPOINT, 'key-12345678', BODY, 201, jest.fn(), jest.fn()),
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
