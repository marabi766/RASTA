import { OutboxShutdown } from '@rasta/nest-common';
import { describeDatabaseTeardown } from '@rasta/testing';
import { PrismaClient } from '../generated/prisma';
import { PrismaService } from './prisma.service';

describeDatabaseTeardown(
  () => new PrismaService('postgresql://test:test@127.0.0.1:1/test', 30_000),
  PrismaClient.prototype,
  (prisma) =>
    new OutboxShutdown({
      relay: { stop: async () => undefined },
      databases: [prisma],
      budgetMs: 23_000,
    }).stop(),
);
