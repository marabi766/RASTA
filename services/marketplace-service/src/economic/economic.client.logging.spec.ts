import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { createLogger } from '@rasta/logging';
import {
  EXCEPTION_FILTER_LOGGER,
  InternalTokenService,
  installNestLogger,
} from '@rasta/nest-common';
import { ENV, LOGGER } from '../tokens';
import type { MarketplaceEnv } from '../config/env';
import { EconomicClient } from './economic.client';

/**
 * `EconomicClient` logs through Nest's `Logger`, which prints raw unless the
 * application registers the pino adapter (Codex on #290, F4): a credential-
 * bearing URL or an upstream error body reached stdout as it was. These run the
 * real client in a real application context with `installNestLogger` — what
 * `main.ts` does — and read what reaches the logger's destination.
 */

/**
 * Every line any `createLogger` writes: the real logger (serialization,
 * scrubbing, caps) with only its destination replaced — it opens fd 1 itself,
 * so a `process.stdout` spy sees nothing (Codex on #296, r2 F2).
 */
const mockWritten: string[] = [];
jest.mock('@rasta/logging', () => {
  const actual = jest.requireActual<typeof import('@rasta/logging')>('@rasta/logging');
  return {
    ...actual,
    createLogger: (config: import('@rasta/logging').LoggerConfig) =>
      actual.createLogger({
        ...config,
        destination: { write: (line: string) => void mockWritten.push(line) },
      }),
  };
});

const PASSWORD = 'LEAKPASSWORD';
const TOKEN = 'LEAKTOKEN0123456789';

const ENV_VALUES = {
  ECONOMIC_SERVICE_URL: `http://svc:${PASSWORD}@economic.test`,
  ECONOMIC_REQUEST_TIMEOUT_MS: 5_000,
} as MarketplaceEnv;

type Line = Record<string, unknown> & { msg?: string; level?: string; context?: string };

async function captureLines(work: () => Promise<void>): Promise<Line[]> {
  mockWritten.length = 0;
  await work();
  return mockWritten
    .join('')
    .split('\n')
    .filter((text) => text.startsWith('{'))
    .map((text) => JSON.parse(text) as Line)
    .filter((line) => line.context === 'EconomicClient');
}

async function failingCall(error: Error): Promise<Line[]> {
  const fetchSpy = jest.spyOn(globalThis, 'fetch').mockRejectedValue(error);
  try {
    return await captureLines(async () => {
      const logger = createLogger({
        serviceName: 'marketplace-service',
        level: 'debug',
        pretty: false,
      });

      @Module({
        providers: [
          { provide: ENV, useValue: ENV_VALUES },
          { provide: LOGGER, useValue: logger },
          { provide: EXCEPTION_FILTER_LOGGER, useValue: logger },
          { provide: InternalTokenService, useValue: { issue: async () => 'minted-token' } },
          EconomicClient,
        ],
      })
      class TestModule {}

      // As `main.ts` creates the app.
      const app = await NestFactory.createApplicationContext(TestModule, {
        bufferLogs: true,
        logger: false,
      });
      installNestLogger(app);
      await expect(
        app.get(EconomicClient).createObligation({
          orderId: 'o-1',
          buyerOrganizationId: 'org-b',
          supplierOrganizationId: 'org-s',
          totalAmountMinor: 100n,
          currency: 'IRR',
          correlationId: 'c-1',
        }),
      ).rejects.toMatchObject({ code: expect.any(String) as unknown });
      await app.close();
    });
  } finally {
    fetchSpy.mockRestore();
  }
}

describe('EconomicClient error logging goes through the app logger', () => {
  it('logs an unreachable economic-service scrubbed and capped', async () => {
    const error = new TypeError(
      `fetch failed: Request cannot be constructed from a URL that includes credentials: ` +
        `http://svc:${PASSWORD}@economic.test/v1/transactions ` +
        `postgresql://app:${PASSWORD}@db/app Authorization: Bearer ${TOKEN} ` +
        `${'x'.repeat(200_000)}`,
      { cause: new Error(`upstream said Authorization: Bearer ${TOKEN}`) },
    );

    const lines = await failingCall(error);

    expect(lines).toHaveLength(1);
    const text = JSON.stringify(lines[0]);
    expect(lines[0]).toMatchObject({
      level: 'error',
      msg: 'economic-service could not be reached',
      operation: 'createObligation',
      service: 'marketplace-service',
    });
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(`postgresql://app:${PASSWORD}`);
    expect(text).toContain('[REDACTED]');
    expect(text.length).toBeLessThan(40_000);
  });
});
