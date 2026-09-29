import type { ArgumentsHost } from '@nestjs/common';
import type { Logger } from '@rasta/logging';
import { AllExceptionsFilter, createSystemContext, runWithContext } from '@rasta/nest-common';
import { IdempotencyStore, hashRequestBody } from './idempotency';
import type { PrismaService } from '../prisma/prisma.service';
import type { MarketplaceEnv } from '../config/env';

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
    findUnique: jest.fn().mockResolvedValue({
      requestHash: hashRequestBody({}),
      state,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    }),
  };
  const prisma = { client: { idempotencyKey } } as unknown as PrismaService;
  return new IdempotencyStore(prisma, { MARKETPLACE_IDEMPOTENCY_TTL_HOURS: 24 } as MarketplaceEnv);
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
    const prisma = { client: { idempotencyKey } } as unknown as PrismaService;
    const store = new IdempotencyStore(prisma, {
      MARKETPLACE_IDEMPOTENCY_TTL_HOURS: 24,
    } as MarketplaceEnv);
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

  it('still refuses a live key in flight at once', async () => {
    const { store, idempotencyKey } = storeWith({
      create: jest.fn().mockRejectedValue(uniqueViolation),
      findUnique: jest.fn().mockResolvedValue({
        requestHash: hashRequestBody({}),
        state: 'IN_PROGRESS',
        expiresAt: new Date(Date.now() + hour),
      }),
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
