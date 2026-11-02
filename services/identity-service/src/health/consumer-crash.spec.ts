import { Controller, Get, Res, Module, type INestApplication } from '@nestjs/common';
import type { Response } from 'express';
import { NestFactory } from '@nestjs/core';
import { consumerFailures, AllExceptionsFilter } from '@rasta/nest-common';
import type { Logger } from '@rasta/logging';
import { HealthController } from './health.controller';
import { SERVICE_NAME } from '../config/env';

// Only dependency methods used by readiness. The real controller and HTTP exception handling run.
const databaseHealth = jest.fn(async () => true);
const dependency = new Proxy(
  {},
  {
    get: (_target, key) =>
      key === 'isHealthy'
        ? databaseHealth
        : key === 'isRunning'
          ? () => true
          : key === 'health'
            ? async () => ({})
            : true,
  },
);
const controller = Reflect.construct(
  HealthController,
  Array.from({ length: 10 }, () => dependency),
) as HealthController;
@Controller('health')
class ProbeController {
  @Get('live')
  live() {
    return controller.live();
  }
  @Get('ready')
  ready(@Res({ passthrough: true }) response: Response) {
    return controller.ready(response);
  }
}
@Module({ controllers: [ProbeController] })
class ProbeModule {}

describe('terminal consumer crash readiness', () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await NestFactory.create(ProbeModule, { logger: false, abortOnError: false });
    app.useGlobalFilters(
      new AllExceptionsFilter({
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
      } as unknown as Logger),
    );
    await app.listen(0, '127.0.0.1');
  });
  afterAll(async () => {
    await app?.close();
  });
  afterEach(() => jest.restoreAllMocks());

  it.each(['ready', 'live'])(
    'returns HTTP 503 from %s when any consumer failed terminally',
    async (probe) => {
      jest
        .spyOn(consumerFailures, 'isHealthy')
        .mockImplementation((service) => service !== SERVICE_NAME);
      const response = await fetch(`${await app.getUrl()}/health/${probe}`);
      expect(response.status).toBe(503);
      expect(databaseHealth).not.toHaveBeenCalled();
      expect(await response.json()).toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
    },
  );
});
