import { createSystemContext, runWithContext } from '@rasta/nest-common';
import { IdempotencyStore, hashRequestBody, targeted } from './idempotency';
import type { PrismaService } from '../prisma/prisma.service';
import type { EconomicEnv } from '../config/env';

/**
 * Request-body canonicalisation for idempotent writes (docs/06 § 6.8).
 *
 * The failure mode this guards against is subtle and expensive: a client
 * retrying with the *same* request, serialised with its keys in a different
 * order, would hash differently and be refused with
 * `409 IDEMPOTENCY_KEY_REUSED` — a legitimate retry rejected as a conflict,
 * and no clear way for the caller to tell the difference.
 *
 * The opposite failure matters just as much. Two *different* requests must
 * never hash alike, or the second would silently replay the first's response
 * and a caller would be told a payment succeeded that never ran.
 */

describe('hashRequestBody', () => {
  it('is stable for the same body', () => {
    const body = { amountMinor: '10000000', currency: 'IRR' };
    expect(hashRequestBody(body)).toBe(hashRequestBody(body));
  });

  it('ignores key order', () => {
    // The whole reason for canonicalising. Two clients, two JSON serialisers,
    // one request.
    expect(hashRequestBody({ a: 1, b: 2 })).toBe(hashRequestBody({ b: 2, a: 1 }));
  });

  it('ignores key order at any depth', () => {
    expect(hashRequestBody({ outer: { a: 1, b: { c: 3, d: 4 } }, top: 'x' })).toBe(
      hashRequestBody({ top: 'x', outer: { b: { d: 4, c: 3 }, a: 1 } }),
    );
  });

  it('respects array order, which is meaningful', () => {
    // Unlike object keys. `[1,2]` and `[2,1]` are different requests.
    expect(hashRequestBody({ items: [1, 2] })).not.toBe(hashRequestBody({ items: [2, 1] }));
  });

  it('distinguishes a changed amount', () => {
    // The case that must never collide: the same idempotency key with a
    // different amount is a bug or an attack, and it has to be refused.
    expect(hashRequestBody({ amountMinor: '10000000' })).not.toBe(
      hashRequestBody({ amountMinor: '10000001' }),
    );
  });

  it('distinguishes a string from a number', () => {
    // Amounts cross the wire as strings (ADR-022); `"100"` and `100` are not
    // the same request.
    expect(hashRequestBody({ amountMinor: '100' })).not.toBe(hashRequestBody({ amountMinor: 100 }));
  });

  it('distinguishes null from absent', () => {
    expect(hashRequestBody({ a: null })).not.toBe(hashRequestBody({}));
  });

  it('distinguishes an added field', () => {
    expect(hashRequestBody({ a: 1 })).not.toBe(hashRequestBody({ a: 1, b: 2 }));
  });

  it('handles a body that is not an object', () => {
    expect(hashRequestBody('plain')).toBe(hashRequestBody('plain'));
    expect(hashRequestBody(null)).toBe(hashRequestBody(null));
    expect(hashRequestBody('plain')).not.toBe(hashRequestBody(null));
  });

  it('produces a hex digest of the expected length', () => {
    expect(hashRequestBody({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('targeted — the request identity of a route that acts on one resource', () => {
  const reason = { reason: 'the order was cancelled before dispatch' };

  it('tells two resources apart even when the body is identical', () => {
    // The defect: hashing only the DTO made key K + this body on TXN_B look like
    // a retry of TXN_A, so TXN_B got TXN_A's stored response and was never touched.
    expect(hashRequestBody(targeted('TXN_A', reason))).not.toBe(
      hashRequestBody(targeted('TXN_B', reason)),
    );
  });

  it('is still a retry for the same resource and the same body', () => {
    expect(hashRequestBody(targeted('TXN_A', reason))).toBe(
      hashRequestBody(targeted('TXN_A', { ...reason })),
    );
  });

  it('with no body, hashes exactly what authorise-settlement always stored', () => {
    // So keys that route recorded before this change still match after it.
    expect(hashRequestBody(targeted('TXN_A'))).toBe(hashRequestBody({ id: 'TXN_A' }));
  });
});

/**
 * The claim race (economic batch 2, item g), with the database scripted so
 * each interleaving happens exactly, every run. The same property against a
 * real database, under real concurrency, is in `idempotency.int-spec.ts`.
 *
 * The rule under test: `PROCEED` comes only from the insert that wrote the
 * reservation. Anything else that "finds nothing there" has reserved nothing.
 */
describe('IdempotencyStore.claim — who may proceed', () => {
  const uniqueViolation = Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
  const hour = 60 * 60 * 1000;

  function storeWith(script: {
    create: jest.Mock;
    findUnique?: jest.Mock;
    deleteMany?: jest.Mock;
  }) {
    const idempotencyKey = {
      create: script.create,
      findUnique: script.findUnique ?? jest.fn(),
      deleteMany: script.deleteMany ?? jest.fn().mockResolvedValue({ count: 1 }),
    };
    const prisma = { client: { idempotencyKey } } as unknown as PrismaService;
    const store = new IdempotencyStore(prisma, {
      ECONOMIC_IDEMPOTENCY_TTL_HOURS: 24,
    } as EconomicEnv);
    return { store, idempotencyKey };
  }

  const asTenant = <T>(fn: () => Promise<T>) =>
    runWithContext(
      createSystemContext({ correlationId: 'unit-claim', organizationId: 'ORG-UNIT' }),
      fn,
    );

  it('retries the insert, rather than proceeding, when the row it lost to has vanished', async () => {
    // Lost the insert; the winner then released its failed attempt before
    // this read. Proceeding here reserved nothing — a third request could
    // insert and proceed alongside it.
    const { store, idempotencyKey } = storeWith({
      create: jest.fn().mockRejectedValueOnce(uniqueViolation).mockResolvedValueOnce({}),
      findUnique: jest.fn().mockResolvedValueOnce(null),
    });

    await expect(asTenant(() => store.claim('POST /x', 'K', {}))).resolves.toEqual({
      kind: 'PROCEED',
    });
    expect(idempotencyKey.create).toHaveBeenCalledTimes(2);
  });

  it('removes an expired row only while it is still expired, then retries the insert', async () => {
    const { store, idempotencyKey } = storeWith({
      create: jest.fn().mockRejectedValueOnce(uniqueViolation).mockResolvedValueOnce({}),
      findUnique: jest.fn().mockResolvedValueOnce({
        requestHash: 'whatever',
        state: 'COMPLETED',
        expiresAt: new Date(Date.now() - hour),
      }),
    });

    await expect(asTenant(() => store.claim('POST /x', 'K', {}))).resolves.toEqual({
      kind: 'PROCEED',
    });
    // Conditional on expiry, so a fresh claim a racer put in its place — or
    // a row a racer already deleted — is never touched and never a 500.
    expect(idempotencyKey.deleteMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        organizationId: 'ORG-UNIT',
        endpoint: 'POST /x',
        key: 'K',
        expiresAt: { lte: expect.any(Date) },
      }),
    });
    expect(idempotencyKey.create).toHaveBeenCalledTimes(2);
  });

  it('answers 409 in flight, never PROCEED, when the key keeps vanishing', async () => {
    const { store, idempotencyKey } = storeWith({
      create: jest.fn().mockRejectedValue(uniqueViolation),
      findUnique: jest.fn().mockResolvedValue(null),
    });

    await expect(asTenant(() => store.claim('POST /x', 'K', {}))).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(idempotencyKey.create).toHaveBeenCalledTimes(3);
  });

  it('still refuses a live key in flight at once', async () => {
    const { store, idempotencyKey } = storeWith({
      create: jest.fn().mockRejectedValue(uniqueViolation),
      findUnique: jest.fn().mockResolvedValue({
        requestHash: hashRequestBody({}),
        state: 'IN_PROGRESS',
        expiresAt: new Date(Date.now() + hour),
      }),
    });

    await expect(asTenant(() => store.claim('POST /x', 'K', {}))).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(idempotencyKey.create).toHaveBeenCalledTimes(1);
    expect(idempotencyKey.deleteMany).not.toHaveBeenCalled();
  });

  it('passes through an error that is not a lost race', async () => {
    const { store } = storeWith({
      create: jest.fn().mockRejectedValue(new Error('connection reset')),
    });
    await expect(asTenant(() => store.claim('POST /x', 'K', {}))).rejects.toThrow(
      'connection reset',
    );
  });
});
