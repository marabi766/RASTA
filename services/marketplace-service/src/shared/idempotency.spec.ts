import { Logger as NestLogger, type ArgumentsHost } from '@nestjs/common';
import type { Logger } from '@rasta/logging';
import {
  AllExceptionsFilter,
  RastaError,
  createSystemContext,
  runWithContext,
} from '@rasta/nest-common';
import { IdempotencyStore, hashRequestBody } from './idempotency';
import type { PrismaService } from '../prisma/prisma.service';
import type { MarketplaceEnv } from '../config/env';

const LEASE_SECONDS = 60;
const ENV = {
  MARKETPLACE_IDEMPOTENCY_TTL_HOURS: 24,
  MARKETPLACE_IDEMPOTENCY_CLAIM_LEASE_SECONDS: LEASE_SECONDS,
} as MarketplaceEnv;

/**
 * The hash a request with `body` has **for the caller in context** — the
 * caller is part of it (#253). Called from inside a mock, so it is evaluated
 * in the context of the claim that reads the row.
 */
const sameRequest = (body: unknown): string =>
  new IdempotencyStore(null as unknown as PrismaService, ENV).hash(body);

/** A guard that lets every replay through. */
const stillVisible = (): Promise<void> => Promise.resolve();

/**
 * A claim-side statement runs in a short transaction of its own, its lock
 * wait bounded (#196): the fake hands that transaction the same delegate.
 */
function withTransaction(idempotencyKey: unknown): PrismaService {
  const tx = { idempotencyKey, $queryRaw: jest.fn().mockResolvedValue([]) };
  return {
    client: {
      idempotencyKey,
      $transaction: jest.fn((fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
    },
  } as unknown as PrismaService;
}

/**
 * S-09 (review of #135, F1): the Idempotency-Key is client text, and a
 * refusal's `internalContext` is logged by the exception filter. Neither
 * conflict — a key in flight, a key reused with another body — may carry it.
 *
 * Driven through the real `AllExceptionsFilter`, so the assertion is about
 * what reaches the log and the client, not only the error object.
 */

const RAW_KEY = 'SENTINEL-marketplace-client-key-5820';

const uniqueViolation = Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });

function storeFinding(state: 'IN_PROGRESS' | 'COMPLETED'): IdempotencyStore {
  const idempotencyKey = {
    create: jest.fn().mockRejectedValue(uniqueViolation),
    findUnique: jest.fn(() =>
      Promise.resolve({
        requestHash: sameRequest({}),
        state,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      }),
    ),
  };
  const prisma = withTransaction(idempotencyKey);
  return new IdempotencyStore(prisma, ENV);
}

/** Everything a value carries, Errors included (`JSON.stringify` drops their message and stack). */
function dump(value: unknown): string {
  return JSON.stringify(value, (_key, field: unknown) =>
    field instanceof Error
      ? { ...field, name: field.name, message: field.message, stack: field.stack }
      : field,
  );
}

function throughTheFilter(error: unknown): {
  logged: string;
  body: string;
  status: number;
  headers: Record<string, string>;
} {
  const lines: unknown[] = [];
  const record = (...args: unknown[]) => {
    lines.push(args);
  };
  const logger = { debug: record, warn: record, error: record } as unknown as Logger;
  const sent: { status: number; body: unknown; headers: Record<string, string> } = {
    status: 0,
    body: undefined,
    headers: {},
  };
  const response = {
    status: (code: number) => {
      sent.status = code;
      return response;
    },
    json: (body: unknown) => {
      sent.body = body;
    },
    setHeader: (name: string, value: string) => {
      sent.headers[name] = value;
    },
  };
  new AllExceptionsFilter(logger).catch(error, {
    switchToHttp: () => ({ getResponse: () => response }),
  } as unknown as ArgumentsHost);
  return {
    logged: dump(lines),
    body: dump(sent.body),
    status: sent.status,
    headers: sent.headers,
  };
}

describe('IdempotencyStore conflicts carry nothing of the key (S-09)', () => {
  it.each([
    ['in flight', 'IN_PROGRESS', {}, 'CONFLICT'],
    ['reused with another body', 'COMPLETED', { other: true }, 'IDEMPOTENCY_KEY_REUSED'],
  ] as const)(
    '%s: not in internalContext, the log line or the body',
    async (_case, state, body, code) => {
      const error = (await runWithContext(
        createSystemContext({ correlationId: 'unit-claim', organizationId: 'ORG-UNIT' }),
        () => storeFinding(state).claim('POST /v1/orders', RAW_KEY, body),
      ).catch((thrown: unknown) => thrown)) as { code: string; internalContext?: unknown };

      expect(error).toMatchObject({ code });
      const { logged, body: answered, status, headers } = throughTheFilter(error);
      expect(status).toBe(409);
      expect(logged).toContain(code); // the line was written
      for (const text of [dump(error.internalContext ?? {}), logged, answered, dump(headers)]) {
        expect(text).not.toContain(RAW_KEY);
        expect(text).not.toContain('SENTINEL');
      }
    },
  );

  it('still says which endpoint is in flight and when to retry', async () => {
    const error = (await runWithContext(
      createSystemContext({ correlationId: 'unit-claim', organizationId: 'ORG-UNIT' }),
      () => storeFinding('IN_PROGRESS').claim('POST /v1/orders', RAW_KEY, {}),
    ).catch((thrown: unknown) => thrown)) as { internalContext?: unknown };

    // The endpoint for the log; the wait as a typed field, never as context.
    expect(error.internalContext).toEqual({ endpoint: 'POST /v1/orders' });
    expect(error).toMatchObject({ retryAfterSeconds: 1 });
    expect(throughTheFilter(error).headers).toEqual({ 'Retry-After': '1' });
  });

  it('a key reused with another body is not a wait: no Retry-After', async () => {
    const error = await runWithContext(
      createSystemContext({ correlationId: 'unit-claim', organizationId: 'ORG-UNIT' }),
      () => storeFinding('COMPLETED').claim('POST /v1/orders', RAW_KEY, { other: true }),
    ).catch((thrown: unknown) => thrown);

    expect(throughTheFilter(error).headers).toEqual({});
  });
});

/**
 * The claim race (review of #141), with the database scripted so each
 * interleaving happens exactly, every run. The same race against the real
 * database and the real order route is `test/idempotency-claim-race.int-spec.ts`.
 *
 * The rule under test: `PROCEED` comes only from the insert that wrote the
 * reservation. Anything else that "finds nothing there" has reserved nothing.
 */
describe('IdempotencyStore.claim — who may proceed', () => {
  const hour = 60 * 60 * 1000;

  function storeWith(script: { create: jest.Mock; findUnique?: jest.Mock }) {
    const idempotencyKey = {
      create: script.create,
      findUnique: script.findUnique ?? jest.fn(),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      delete: jest.fn().mockResolvedValue({}),
    };
    const prisma = withTransaction(idempotencyKey);
    const store = new IdempotencyStore(prisma, ENV);
    return { store, idempotencyKey };
  }

  const asTenant = <T>(fn: () => Promise<T>) =>
    runWithContext(
      createSystemContext({ correlationId: 'unit-claim', organizationId: 'ORG-UNIT' }),
      fn,
    );

  it('retries the insert, rather than proceeding, when the row it lost to has vanished', async () => {
    // Lost the insert; the winner then released its failed attempt before
    // this read. Proceeding here reserved nothing — the next request with the
    // key could insert and place a second order.
    const { store, idempotencyKey } = storeWith({
      create: jest.fn().mockRejectedValueOnce(uniqueViolation).mockResolvedValueOnce({}),
      findUnique: jest.fn().mockResolvedValueOnce(null),
    });

    await expect(asTenant(() => store.claim('POST /v1/orders', 'K', {}))).resolves.toEqual({
      kind: 'PROCEED',
      token: expect.any(String),
    });
    expect(idempotencyKey.create).toHaveBeenCalledTimes(2);
  });

  it('answers 409 in flight with Retry-After, never PROCEED, when the key keeps vanishing', async () => {
    const { store, idempotencyKey } = storeWith({
      create: jest.fn().mockRejectedValue(uniqueViolation),
      findUnique: jest.fn().mockResolvedValue(null),
    });

    const error = await asTenant(() => store.claim('POST /v1/orders', 'K', {})).catch(
      (thrown: unknown) => thrown,
    );
    expect(error).toMatchObject({ code: 'CONFLICT', retryAfterSeconds: 1 });
    expect(idempotencyKey.create).toHaveBeenCalledTimes(3);
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

    await expect(asTenant(() => store.claim('POST /v1/orders', 'K', {}))).resolves.toEqual({
      kind: 'PROCEED',
      token: expect.any(String),
    });
    // Conditional on expiry, so a fresh claim a racer put in its place — or a
    // row a racer already deleted — is never touched and never a 500.
    expect(idempotencyKey.deleteMany).toHaveBeenCalledWith({
      where: {
        organizationId: 'ORG-UNIT',
        endpoint: 'POST /v1/orders',
        key: 'K',
        expiresAt: { lte: expect.any(Date) },
      },
    });
    expect(idempotencyKey.delete).not.toHaveBeenCalled();
    expect(idempotencyKey.create).toHaveBeenCalledTimes(2);
  });

  it('reserves the key for its lease only, not for the retention', async () => {
    const { store, idempotencyKey } = storeWith({ create: jest.fn().mockResolvedValue({}) });
    const before = Date.now();

    await asTenant(() => store.claim('POST /v1/orders', 'K', {}));

    const { data } = (idempotencyKey.create.mock.calls[0] as [{ data: { expiresAt: Date } }])[0];
    expect(data).toMatchObject({ state: 'IN_PROGRESS' });
    expect(data.expiresAt.getTime()).toBeGreaterThanOrEqual(before + LEASE_SECONDS * 1000);
    expect(data.expiresAt.getTime()).toBeLessThan(before + LEASE_SECONDS * 1000 + 5_000);
  });

  it('takes over a claim whose lease lapsed: removed while still lapsed, then a new insert', async () => {
    // The holder's release failed, or its process died: an IN_PROGRESS row
    // past its lease no longer blocks an identical retry (#253).
    const { store, idempotencyKey } = storeWith({
      create: jest.fn().mockRejectedValueOnce(uniqueViolation).mockResolvedValueOnce({}),
      findUnique: jest.fn(() =>
        Promise.resolve({
          requestHash: sameRequest({}),
          state: 'IN_PROGRESS',
          expiresAt: new Date(Date.now() - 1),
        }),
      ),
    });

    await expect(asTenant(() => store.claim('POST /v1/orders', 'K', {}))).resolves.toEqual({
      kind: 'PROCEED',
      token: expect.any(String),
    });
    expect(idempotencyKey.deleteMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ expiresAt: { lte: expect.any(Date) } }),
    });
    // A new token: the old holder's complete and release match nothing.
    const tokens = idempotencyKey.create.mock.calls.map(
      (call) => (call as [{ data: { claimToken: string } }])[0].data.claimToken,
    );
    expect(new Set(tokens).size).toBe(2);
  });

  it('refuses another caller’s identical request as a reused key, even in flight (#253)', async () => {
    // The row was written by user A; user B in the same organization sends the
    // same key and body. Never a replay of A's response, never news of A's
    // request being in flight.
    const asUser = <T>(userId: string, fn: () => Promise<T>) =>
      runWithContext(
        createSystemContext({
          correlationId: 'unit-claim',
          organizationId: 'ORG-UNIT',
          authType: 'USER',
          userId,
        }),
        fn,
      );
    for (const state of ['IN_PROGRESS', 'COMPLETED'] as const) {
      const writtenByA = await asUser('USR_A', () => Promise.resolve(sameRequest({})));
      const { store } = storeWith({
        create: jest.fn().mockRejectedValue(uniqueViolation),
        findUnique: jest.fn().mockResolvedValue({
          requestHash: writtenByA,
          state,
          responseBody: { id: 'OFFER_OF_ANOTHER_ORG' },
          expiresAt: new Date(Date.now() + hour),
        }),
      });

      await expect(
        asUser('USR_B', () => store.claim('PATCH /v1/offers/:id', 'K', {})),
      ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
      // The same user is the same request: replayed, or told it is in flight.
      const own = asUser('USR_A', () => store.claim('PATCH /v1/offers/:id', 'K', {}));
      if (state === 'COMPLETED') await expect(own).resolves.toMatchObject({ kind: 'REPLAY' });
      else await expect(own).rejects.toMatchObject({ code: 'CONFLICT' });
    }
  });

  it('still refuses a live key in flight at once', async () => {
    const { store, idempotencyKey } = storeWith({
      create: jest.fn().mockRejectedValue(uniqueViolation),
      findUnique: jest.fn(() =>
        Promise.resolve({
          requestHash: sameRequest({}),
          state: 'IN_PROGRESS',
          expiresAt: new Date(Date.now() + hour),
        }),
      ),
    });

    await expect(asTenant(() => store.claim('POST /v1/orders', 'K', {}))).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(idempotencyKey.create).toHaveBeenCalledTimes(1);
    expect(idempotencyKey.deleteMany).not.toHaveBeenCalled();
  });

  it('passes through an error that is not a lost race', async () => {
    const { store } = storeWith({
      create: jest.fn().mockRejectedValue(new Error('connection reset')),
    });
    await expect(asTenant(() => store.claim('POST /v1/orders', 'K', {}))).rejects.toThrow(
      'connection reset',
    );
  });
});

/**
 * Where the response is stored, and which failure frees the key. The response
 * is written by the work's own transaction, as its last statement (docs/06
 * § 6.8), so a failure to store it is a failure of the work: the transaction
 * rolls back — no order — and the claim is released for a retry. Stored after
 * the commit, the same failure answered 500 for an order that existed. The
 * same faults against the real database and the real order route are
 * `test/idempotency-response-in-transaction.int-spec.ts`.
 */
describe('IdempotencyStore.execute — the response is stored in the work’s transaction', () => {
  function claimedStore() {
    const idempotencyKey = {
      create: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn(),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    };
    const prisma = withTransaction(idempotencyKey);
    const store = new IdempotencyStore(prisma, ENV);
    // The work's own transaction: a delegate of its own, so a write through
    // the store's client instead of `tx` would not count.
    const workTx = { idempotencyKey: { updateMany: jest.fn() } };
    return { store, idempotencyKey, workTx };
  }

  const asTenant = <T>(fn: () => Promise<T>) =>
    runWithContext(
      createSystemContext({ correlationId: 'unit-execute', organizationId: 'ORG-UNIT' }),
      fn,
    );

  const released = {
    where: {
      organizationId: 'ORG-UNIT',
      endpoint: 'POST /v1/orders',
      key: 'K',
      claimToken: expect.any(String),
      state: 'IN_PROGRESS',
    },
  };

  it('stores the response through the work’s transaction, on this claim’s own row', async () => {
    const { store, idempotencyKey, workTx } = claimedStore();
    workTx.idempotencyKey.updateMany.mockResolvedValue({ count: 1 });

    const guard = jest.fn(stillVisible);
    const before = Date.now();
    const outcome = await asTenant(() =>
      store.execute(
        'POST /v1/orders',
        'K',
        {},
        201,
        async (record) => {
          await record(workTx as never, { id: 'ORD_UNIT' });
          return { id: 'ORD_UNIT' };
        },
        guard,
      ),
    );

    expect(outcome).toEqual({ result: { id: 'ORD_UNIT' }, executed: true });
    expect(workTx.idempotencyKey.updateMany).toHaveBeenCalledWith({
      where: released.where,
      data: {
        state: 'COMPLETED',
        responseStatus: 201,
        responseBody: { id: 'ORD_UNIT' },
        expiresAt: expect.any(Date),
      },
    });
    // The response lives the retention from now — the lease is over.
    const { data } = (
      workTx.idempotencyKey.updateMany.mock.calls[0] as [{ data: { expiresAt: Date } }]
    )[0];
    expect(data.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 24 * 60 * 60 * 1000);
    // The work ran: there was nothing to replay, so nothing to re-authorize.
    expect(guard).not.toHaveBeenCalled();
    // Nothing through the store's own client: no second, after-commit write.
    expect(idempotencyKey.updateMany).not.toHaveBeenCalled();
    expect(idempotencyKey.deleteMany).not.toHaveBeenCalled();
  });

  it('a failure to store the response fails the work, and the claim is released', async () => {
    const { store, idempotencyKey, workTx } = claimedStore();
    workTx.idempotencyKey.updateMany.mockRejectedValue(
      new Error('connection reset while recording'),
    );

    await expect(
      asTenant(() =>
        store.execute(
          'POST /v1/orders',
          'K',
          {},
          201,
          async (record) => {
            // A real transaction rolls the order back with this rejection.
            await record(workTx as never, { id: 'ORD_UNIT' });
            return { id: 'ORD_UNIT' };
          },
          stillVisible,
        ),
      ),
    ).rejects.toThrow('connection reset while recording');
    expect(idempotencyKey.deleteMany).toHaveBeenCalledWith(released);
  });

  it('a claim lost under the work refuses the commit with a retryable 409', async () => {
    // Expired and purged, perhaps re-taken: completing it would commit a
    // second execution under one key.
    const { store, idempotencyKey, workTx } = claimedStore();
    workTx.idempotencyKey.updateMany.mockResolvedValue({ count: 0 });

    const error = await asTenant(() =>
      store.execute(
        'POST /v1/orders',
        'K',
        {},
        201,
        async (record) => {
          await record(workTx as never, { id: 'ORD_UNIT' });
          return { id: 'ORD_UNIT' };
        },
        stillVisible,
      ),
    ).catch((thrown: unknown) => thrown);

    expect(error).toMatchObject({ code: 'CONFLICT', retryAfterSeconds: 1 });
    expect(dump(error)).not.toContain('"K"');
    expect(idempotencyKey.deleteMany).toHaveBeenCalledWith(released);
  });

  it('a work that returns without recording is a defect, and its claim is kept for the retention', async () => {
    const { store, idempotencyKey } = claimedStore();
    idempotencyKey.updateMany.mockResolvedValue({ count: 1 });
    const before = Date.now();

    await expect(
      asTenant(() =>
        store.execute(
          'POST /v1/orders',
          'K',
          {},
          201,
          () => Promise.resolve({ id: 'ORD_UNIT' }),
          stillVisible,
        ),
      ),
    ).rejects.toThrow('did not record its response');
    // Released — or left to lapse with its lease — a retry would run the
    // committed work a second time.
    expect(idempotencyKey.deleteMany).not.toHaveBeenCalled();
    expect(idempotencyKey.updateMany).toHaveBeenCalledWith({
      where: released.where,
      data: { expiresAt: expect.any(Date) },
    });
    const { data } = (
      idempotencyKey.updateMany.mock.calls[0] as [{ data: { expiresAt: Date } }]
    )[0];
    expect(data.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 24 * 60 * 60 * 1000);
  });

  it('releases the claim when the work itself fails, so a corrected retry can run', async () => {
    const { store, idempotencyKey, workTx } = claimedStore();
    const work = jest.fn().mockRejectedValue(new Error('insufficient stock'));

    await expect(
      asTenant(() => store.execute('POST /v1/orders', 'K', {}, 201, work, stillVisible)),
    ).rejects.toThrow('insufficient stock');
    expect(idempotencyKey.deleteMany).toHaveBeenCalledWith(released);
    expect(workTx.idempotencyKey.updateMany).not.toHaveBeenCalled();
  });

  it('a release that fails too keeps the original error, and logs nothing of the request (#253)', async () => {
    // The domain transaction rolled back and the database is now down: the
    // release fails as well. The caller must get the work's error, not the
    // release's; the claim lapses with its lease.
    const { store, idempotencyKey } = claimedStore();
    idempotencyKey.deleteMany.mockRejectedValue(
      Object.assign(new Error(`Can't reach database server: ${RAW_KEY}`), { code: 'P1001' }),
    );
    const original = RastaError.businessRule('Offer is not available in that quantity');
    const logged = jest.spyOn(NestLogger.prototype, 'error').mockImplementation(() => undefined);

    try {
      const error = await asTenant(() =>
        store.execute(
          'POST /v1/orders',
          RAW_KEY,
          { note: 'SENTINEL-body' },
          201,
          () => Promise.reject(original),
          stillVisible,
        ),
      ).catch((thrown: unknown) => thrown);

      expect(error).toBe(original);
      expect(idempotencyKey.deleteMany).toHaveBeenCalledTimes(1);
      expect(logged).toHaveBeenCalledTimes(1);
      expect(logged.mock.calls[0]?.[0]).toEqual({
        endpoint: 'POST /v1/orders',
        errorName: 'Error',
        errorCode: 'P1001',
      });
      expect(dump(logged.mock.calls)).not.toContain('SENTINEL');
    } finally {
      logged.mockRestore();
    }
  });

  function storeReplaying(responseBody: unknown) {
    const idempotencyKey = {
      create: jest.fn().mockRejectedValue(uniqueViolation),
      findUnique: jest.fn(() =>
        Promise.resolve({
          requestHash: sameRequest({}),
          state: 'COMPLETED',
          responseStatus: 201,
          responseBody,
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        }),
      ),
      updateMany: jest.fn(),
      deleteMany: jest.fn(),
    };
    return { store: new IdempotencyStore(withTransaction(idempotencyKey), ENV), idempotencyKey };
  }

  it('a replay runs nothing and stores nothing, once the guard has seen the stored response', async () => {
    const { store, idempotencyKey } = storeReplaying({ id: 'ORD_STORED' });
    const work = jest.fn();
    const guard = jest.fn(stillVisible);

    await expect(
      asTenant(() => store.execute('POST /v1/orders', 'K', {}, 201, work, guard)),
    ).resolves.toEqual({ result: { id: 'ORD_STORED' }, executed: false });
    expect(guard).toHaveBeenCalledWith({ id: 'ORD_STORED' });
    expect(work).not.toHaveBeenCalled();
    expect(idempotencyKey.updateMany).not.toHaveBeenCalled();
    expect(idempotencyKey.deleteMany).not.toHaveBeenCalled();
  });

  it('a replay the caller may no longer see answers the guard’s refusal, never the stored body (#253)', async () => {
    const { store } = storeReplaying({ id: 'OFFER_STORED', unitPriceMinor: 'SENTINEL-price' });
    const refusal = RastaError.notFound('Offer', 'OFFER_STORED');

    const error = await asTenant(() =>
      store.execute('PATCH /v1/offers/:id', 'K', {}, 200, jest.fn(), () => Promise.reject(refusal)),
    ).catch((thrown: unknown) => thrown);

    expect(error).toBe(refusal);
    expect(dump(error)).not.toContain('SENTINEL');
  });
});

describe('hashRequestBody — every own key, whatever its name (#194)', () => {
  // JSON.parse makes the name an own key, as the request body parser does.
  const body = (name: string, x: number): unknown =>
    JSON.parse(`{"note":"n","details":{"${name}":{"x":${x}}}}`);

  it.each(['__proto__', 'constructor'])(
    'tells bodies apart that differ only under a %s key',
    (name) => {
      expect(hashRequestBody(body(name, 1))).not.toBe(hashRequestBody(body(name, 2)));
      expect(hashRequestBody(body(name, 1))).toBe(hashRequestBody(body(name, 1)));
    },
  );

  it('tells a body with a __proto__ key from the same body without it', () => {
    expect(hashRequestBody(JSON.parse('{"a":1,"__proto__":{"b":2}}'))).not.toBe(
      hashRequestBody({ a: 1 }),
    );
  });
});
