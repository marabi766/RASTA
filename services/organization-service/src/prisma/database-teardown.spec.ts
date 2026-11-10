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
  const originalUrl = process.env.DATABASE_URL;
  const originalExit = process.exitCode;
  let release!: (report: { drained: boolean }) => void;
  const closing = {
    then: jest.fn((resolve) => {
      release = resolve;
    }),
  };
  const upsert = async () => undefined;
  jest.doMock('@rasta/config', () => ({
    ...jest.requireActual('@rasta/config'),
    assertDemoSeedAllowed: () => undefined,
    assertDemoSeedDatabase: upsert,
  }));
  jest.doMock('@rasta/nest-common', () => ({
    ...jest.requireActual('@rasta/nest-common'),
    assertDemoSeedRuntimeRole: upsert,
  }));
  jest.doMock('../organization/seed-organization', () => ({
    seedOrganization: async () => ({ depth: 0 }),
  }));
  jest.doMock('./prisma.service', () => ({
    PrismaService: class {
      client = {
        organizationLocation: { upsert },
        organizationPolicy: { upsert },
        organizationContact: { upsert },
        $executeRaw: upsert,
      };
      stop = () => closing;
    },
  }));
  jest.spyOn(console, 'warn').mockImplementation();
  const error = jest.spyOn(console, 'error').mockImplementation();
  process.env.DATABASE_URL = 'postgresql://test:test@127.0.0.1:1/test';
  process.exitCode = undefined;
  try {
    await jest.isolateModulesAsync(async () => {
      await import('../../prisma/seed');
      await new Promise((resolve) => setImmediate(resolve));
      expect(closing.then).toHaveBeenCalledTimes(1); // the real entry point awaited cleanup
      expect(process.exitCode).toBeUndefined();
      release({ drained });
      await new Promise((resolve) => setImmediate(resolve));
      expect(process.exitCode).toBe(drained ? undefined : 1);
      if (!drained) expect(error).toHaveBeenCalledWith(expect.stringContaining('UNCONFIRMED'));
    });
  } finally {
    if (originalUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalUrl;
    process.exitCode = originalExit;
    jest.dontMock('@rasta/config');
    jest.dontMock('@rasta/nest-common');
    jest.dontMock('../organization/seed-organization');
    jest.dontMock('./prisma.service');
    jest.restoreAllMocks();
  }
});
