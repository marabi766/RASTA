import 'reflect-metadata';
import { OutboxShutdown } from '@rasta/nest-common';
import { describeDatabaseTeardown, coordinateDatabaseTeardown } from '@rasta/testing';
import { AppModule } from '../app.module';
import { ENV } from '../tokens';
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
