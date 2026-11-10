import 'reflect-metadata';
import { OutboxShutdown } from '@rasta/nest-common';
import { describeDatabaseTeardown, coordinateDatabaseTeardown } from '@rasta/testing';
import { AppModule, ENV } from '../app.module';
import { PrismaClient } from '../generated/prisma';
import { PrismaService } from './prisma.service';

describeDatabaseTeardown(
  () => new PrismaService('postgresql://test:test@127.0.0.1:1/test'),
  PrismaClient.prototype,
  (prisma) =>
    coordinateDatabaseTeardown(
      Reflect.getMetadata('providers', AppModule),
      PrismaService,
      ENV,
      OutboxShutdown,
      prisma,
    ),
);

it.each([true, false])('seed awaits cleanup and requires drained:true (%s)', async (drained) => {
  const { readFileSync } = await import('node:fs');
  const { runInNewContext } = await import('node:vm');
  const source = readFileSync(`${__dirname}/../../prisma/seed.ts`, 'utf8');
  let release!: (report: { drained: boolean }) => void;
  const process = { exitCode: 0 };
  const error = jest.fn();
  const closing = new Promise<{ drained: boolean }>((resolve) => {
    release = resolve;
  });
  let finished = false;
  const completion = runInNewContext(source.slice(source.lastIndexOf('\nmain()')), {
    main: async () => undefined,
    database: { stop: () => closing },
    process,
    console: { error },
  }) as Promise<void>;
  void completion.then(() => {
    finished = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  expect(finished).toBe(false);
  release({ drained });
  await completion;
  expect(process.exitCode).toBe(drained ? 0 : 1);
  if (!drained) expect(error).toHaveBeenCalledWith(expect.stringContaining('UNCONFIRMED'));
});
