import { VersioningType, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AllExceptionsFilter, toJsonSchema } from '@rasta/nest-common';
import { ScheduleController } from './schedule.controller';
import { ScheduleService } from './schedule.service';
import { createScheduleSchema, updateScheduleSchema } from './dto';

describe('cumulative anchor HTTP and OpenAPI bounds', () => {
  let app: INestApplication;
  const schedules = {
    create: jest.fn().mockResolvedValue({}),
    update: jest.fn().mockResolvedValue({}),
  };
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [ScheduleController],
      providers: [{ provide: ScheduleService, useValue: schedules }],
    }).compile();
    app = module.createNestApplication();
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalFilters(
      new AllExceptionsFilter({
        error: jest.fn(),
        warn: jest.fn(),
        info: jest.fn(),
        debug: jest.fn(),
      } as never),
    );
    await app.init();
  });
  afterAll(async () => {
    await app.close();
  });
  for (const field of ['lastServicedHourMeter', 'lastServicedOdometer']) {
    it.each(['create', 'update'])(
      '%s accepts 18 digit ' + field + ' and refuses 19 with 400',
      async (operation) => {
        for (const [value, status] of [
          ['999999999999999999.99', operation === 'create' ? 201 : 200],
          ['1000000000000000000', 400],
        ] as const) {
          const response =
            operation === 'create'
              ? await request(app.getHttpServer())
                  .post('/v1/maintenance-schedules')
                  .send({
                    assetId: 'AST-0001',
                    title: 'Meter precision',
                    intervalHours: '1',
                    [field]: value,
                  })
              : await request(app.getHttpServer())
                  .patch('/v1/maintenance-schedules/MSC-1')
                  .send({ [field]: value });
          expect(response.status).toBe(status);
        }
      },
    );
    it('OpenAPI publishes the 18 digit ' + field + ' bound on create/update', () => {
      for (const schema of [createScheduleSchema, updateScheduleSchema]) {
        const props = toJsonSchema(schema).properties as Record<string, unknown>;
        // quantity canonicalizes, so the converter may describe its post-transform bound.
        expect(JSON.stringify(props[field])).toContain('18');
      }
    });
  }
});
