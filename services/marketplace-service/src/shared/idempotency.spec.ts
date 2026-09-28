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

function throughTheFilter(error: unknown): { logged: string; body: string; status: number } {
  const lines: unknown[] = [];
  const record = (...args: unknown[]) => {
    lines.push(args);
  };
  const logger = { debug: record, warn: record, error: record } as unknown as Logger;
  const sent: { status: number; body: unknown } = { status: 0, body: undefined };
  const response = {
    status: (code: number) => {
      sent.status = code;
      return response;
    },
    json: (body: unknown) => {
      sent.body = body;
    },
  };
  new AllExceptionsFilter(logger).catch(error, {
    switchToHttp: () => ({ getResponse: () => response }),
  } as unknown as ArgumentsHost);
  return { logged: dump(lines), body: dump(sent.body), status: sent.status };
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
      const { logged, body: answered, status } = throughTheFilter(error);
      expect(status).toBe(409);
      expect(logged).toContain(code); // the line was written
      for (const text of [dump(error.internalContext ?? {}), logged, answered]) {
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

    expect(error.internalContext).toEqual({ endpoint: 'POST /v1/orders', retryAfterSeconds: 1 });
  });
});
