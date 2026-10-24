import { inspect } from 'node:util';
import { VersioningType, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AllExceptionsFilter } from '@rasta/nest-common';
import { ScheduleController } from './schedule.controller';
import { ScheduleService } from './schedule.service';

/**
 * A schedule's day counts at the HTTP boundary, through the real controller,
 * validation pipe and exception filter (#393 r1 F1).
 *
 * `intervalDays` and `leadDays` were `z.coerce.number()`, which calls
 * `Number(input)` before any type check: `{"toString":null}` threw a TypeError
 * out of the pipe — a 500 INTERNAL_ERROR — and `true` or `[30]` quietly became
 * 1 or 30. Now only text is converted; any other non-number is a 400
 * VALIDATION_FAILED naming the field, and nothing is written.
 */
describe('a schedule’s day counts (HTTP)', () => {
  const QUIET_LOGGER = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() };
  const schedules = { create: jest.fn(), update: jest.fn() };
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ScheduleController],
      providers: [{ provide: ScheduleService, useValue: schedules }],
    }).compile();
    app = moduleRef.createNestApplication();
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalFilters(new AllExceptionsFilter(QUIET_LOGGER as never));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    for (const mock of Object.values(schedules))
      mock.mockReset().mockResolvedValue({ id: 'MSC-1' });
  });

  const CREATE = { assetId: 'AST-0001', title: 'تعویض روغن موتور', intervalHours: '250' };

  const WRITES = [
    {
      name: 'POST /v1/maintenance-schedules',
      handler: schedules.create,
      send: (body: object) =>
        request(app.getHttpServer())
          .post('/v1/maintenance-schedules')
          .send({ ...CREATE, ...body }),
    },
    {
      name: 'PATCH /v1/maintenance-schedules/:id',
      handler: schedules.update,
      send: (body: object) =>
        request(app.getHttpServer()).patch('/v1/maintenance-schedules/MSC-1').send(body),
    },
  ];

  const NOT_A_NUMBER: readonly (readonly [string, unknown])[] = [
    ['an object whose toString is null', { toString: null }],
    ['an object whose valueOf is null', { valueOf: null, toString: null }],
    ['an empty object', {}],
    ['an array of one number', [30]],
    ['an empty array', []],
    ['true', true],
    ['false', false],
  ];

  describe.each(WRITES)('$name', ({ handler, send }) => {
    describe.each(['intervalDays', 'leadDays'])('%s', (field) => {
      it.each(NOT_A_NUMBER)(
        'refuses %s with a 400 naming the field, and writes nothing',
        async (_what, value) => {
          const response = await send({ [field]: value });

          expect(response.status).toBe(400);
          expect(response.body.code).toBe('VALIDATION_FAILED');
          expect(response.body.details).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ path: field, code: 'invalid_type' }),
            ]),
          );
          expect(handler).not.toHaveBeenCalled();
        },
      );

      it.each([
        ['a JSON number', 7, 7],
        ['text, as before', '7', 7],
      ])('accepts %s', async (_what, value, parsed) => {
        const response = await send({ intervalDays: 30, [field]: value });

        expect(response.status).toBeLessThan(300);
        expect(handler).toHaveBeenCalledTimes(1);
        expect(JSON.stringify(handler.mock.calls[0])).toContain(`"${field}":${parsed}`);
      });
    });
  });

  it.each(['intervalDays', 'leadDays'])(
    'a creation refuses %s null — it was read as 0 — and an edit takes it as "clear"',
    async (field) => {
      const created = await WRITES[0].send({ [field]: null });
      expect(created.status).toBe(400);
      expect(created.body.details).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: field, code: 'invalid_type' })]),
      );
      expect(schedules.create).not.toHaveBeenCalled();

      const edited = await WRITES[1].send({ [field]: null });
      expect(edited.status).toBe(200);
      expect(schedules.update).toHaveBeenCalledWith('MSC-1', { [field]: null });
    },
  );

  it('repeats nothing of the refused value in the answer or a log line (S-09)', async () => {
    const SENTINEL = 'private-schedule-note-123';
    for (const level of Object.values(QUIET_LOGGER)) level.mockClear();

    const response = await WRITES[1].send({ intervalDays: { [SENTINEL]: SENTINEL } });

    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).not.toContain(SENTINEL);
    const logged = Object.values(QUIET_LOGGER).flatMap((level) => level.mock.calls);
    expect(logged.length).toBeGreaterThan(0);
    expect(inspect(logged, { depth: null })).not.toContain(SENTINEL);
    expect(QUIET_LOGGER.error).not.toHaveBeenCalled();
  });
});
