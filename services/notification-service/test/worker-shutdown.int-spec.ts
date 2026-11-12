import { Test } from '@nestjs/testing';
import {
  OutboxShutdown,
  WorkerBoundary,
  withinDeadline,
  type OutboxStopOptions,
} from '@rasta/nest-common';
import type { ShutdownFactoryProvider } from '@rasta/testing';
import { ulid } from 'ulid';
import { AppModule } from '../src/app.module';
import { ResolutionWorker } from '../src/resolution/resolution.worker';
import { MailWorker } from '../src/channels/mail.worker';
import { PrismaService } from '../src/prisma/prisma.service';
import { ENV } from '../src/tokens';
import { databaseUrl } from './helpers';

// Real Nest destroy order and PostgreSQL commit/rollback; other drains are inert.
it.each([
  [ResolutionWorker, false],
  [ResolutionWorker, true],
  [MailWorker, false],
  [MailWorker, true],
])('FU-321 %s provider destruction: callback after deadline=%s', async (Worker, late) => {
  const prisma = new PrismaService(databaseUrl());
  const inspector = new PrismaService(databaseUrl());
  const boundary = new WorkerBoundary(jest.fn());
  const worker = {
    stop: async ({ deadlineAt }: OutboxStopOptions): Promise<void> => {
      boundary.stopAt(deadlineAt);
      if ((await withinDeadline(boundary.current!, deadlineAt! - Date.now())) === 'abandoned')
        boundary.abandon();
    },
  };
  const provider = Reflect.getMetadata('providers', AppModule).find(
    (p: { provide?: unknown }) => p.provide === OutboxShutdown,
  ) as ShutdownFactoryProvider;
  const args = provider.inject!.map((token) =>
    token === ENV
      ? { SHUTDOWN_TIMEOUT_MS: 5000 }
      : token === PrismaService
        ? prisma
        : token === Worker
          ? worker
          : { stop: async () => undefined },
  );
  const module = await Test.createTestingModule({
    providers: [
      { provide: PrismaService, useValue: prisma },
      { provide: OutboxShutdown, useValue: provider.useFactory(...args) },
    ],
  }).compile();
  const app = module.createNestApplication();
  const partitionKey = ulid();
  let closing = Promise.resolve();
  try {
    await app.init();
    const result = await boundary
      .run(() =>
        prisma.transaction(
          async (tx) => {
            await tx.outboxStreamSequence.create({
              data: { topic: 'shutdown-probe', partitionKey },
            });
            closing = app.close();
            await tx.$queryRaw`SELECT 1 FROM pg_sleep(${late ? 4 : 0})`;
          },
          { timeout: 30_000 },
        ),
      )
      .then(
        () => 'completed',
        () => 'refused',
      );
    await closing;
    expect(result).toBe(late ? 'refused' : 'completed');
    expect(boundary.abandoned).toBe(late);
    expect(await inspector.client.outboxStreamSequence.count({ where: { partitionKey } })).toBe(
      late ? 0 : 1,
    );
  } finally {
    await app.close();
    await Promise.all([prisma.stop(), inspector.stop()]);
  }
});
