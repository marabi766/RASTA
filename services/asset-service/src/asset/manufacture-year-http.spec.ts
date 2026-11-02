import { inspect } from 'node:util';
import { VersioningType, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AllExceptionsFilter } from '@rasta/nest-common';
import { ClaimService } from '../insurance/claim.service';
import { InsuranceService } from '../insurance/insurance.service';
import { AssetController } from './asset.controller';
import { AssetService } from './asset.service';
import { IdempotencyStore } from './idempotency';

/**
 * `manufactureYear` at the HTTP boundary, through the real controller,
 * validation pipe and exception filter (#393 r1 F1).
 *
 * It was `z.coerce.number()`, which calls `Number(input)` before any type
 * check: `{"toString":null}` threw a TypeError out of the pipe — a 500
 * INTERNAL_ERROR — and `[1402]` quietly became 1402. Now only text is
 * converted; any other non-number is a 400 VALIDATION_FAILED naming the field,
 * and nothing is registered or changed.
 */
describe('an asset’s manufacture year (HTTP)', () => {
  const QUIET_LOGGER = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() };
  const assets = { create: jest.fn(), update: jest.fn() };
  const idempotency = { execute: jest.fn() };
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AssetController],
      providers: [
        { provide: AssetService, useValue: assets },
        { provide: InsuranceService, useValue: {} },
        { provide: ClaimService, useValue: {} },
        { provide: IdempotencyStore, useValue: idempotency },
      ],
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
    for (const mock of Object.values(assets)) mock.mockReset().mockResolvedValue({ id: 'AST_1' });
    // Runs the work, as the real store does for a new key.
    idempotency.execute
      .mockReset()
      .mockImplementation(
        async (_e: string, _k: string, _b: unknown, _s: number, work: (f: object) => unknown) => ({
          result: await work({}),
        }),
      );
  });

  const WRITES = [
    {
      name: 'POST /v1/assets',
      handler: assets.create,
      send: (body: object) =>
        request(app.getHttpServer())
          .post('/v1/assets')
          .set('Idempotency-Key', 'create-asset-0001')
          .send({ name: 'گریدر شماره یک', type: 'GRADER', ...body }),
    },
    {
      name: 'PATCH /v1/assets/:id',
      handler: assets.update,
      send: (body: object) =>
        request(app.getHttpServer())
          .patch('/v1/assets/AST_1')
          .send({ expectedVersion: 3, ...body }),
    },
  ];

  describe.each(WRITES)('$name', ({ handler, send }) => {
    it.each([
      ['an object whose toString is null', { toString: null }],
      ['an object whose valueOf is null', { valueOf: null, toString: null }],
      ['an empty object', {}],
      ['an array of one year', [1402]],
      ['an empty array', []],
      ['true', true],
      ['false', false],
    ])('refuses %s with a 400 naming the field, and writes nothing', async (_what, value) => {
      const response = await send({ manufactureYear: value });

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('VALIDATION_FAILED');
      expect(response.body.details).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: 'manufactureYear', code: 'invalid_type' }),
        ]),
      );
      expect(idempotency.execute).not.toHaveBeenCalled();
      expect(handler).not.toHaveBeenCalled();
    });

    it.each([
      ['a JSON number', 1402],
      ['text, as before', '1402'],
    ])('accepts %s', async (_what, value) => {
      const response = await send({ manufactureYear: value });

      expect(response.status).toBeLessThan(300);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][handler === assets.update ? 1 : 0]).toMatchObject({
        manufactureYear: 1402,
      });
    });
  });

  it('a registration refuses null — it was read as 0 — and an edit takes it as "clear"', async () => {
    const created = await WRITES[0].send({ manufactureYear: null });
    expect(created.status).toBe(400);
    expect(created.body.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'manufactureYear', code: 'invalid_type' }),
      ]),
    );
    expect(assets.create).not.toHaveBeenCalled();

    const edited = await WRITES[1].send({ manufactureYear: null });
    expect(edited.status).toBe(200);
    expect(assets.update).toHaveBeenCalledWith('AST_1', {
      expectedVersion: 3,
      manufactureYear: null,
    });
  });

  it('repeats nothing of the refused value in the answer or a log line (S-09)', async () => {
    const SENTINEL = 'private-asset-note-123';
    for (const level of Object.values(QUIET_LOGGER)) level.mockClear();

    const response = await WRITES[0].send({ manufactureYear: { [SENTINEL]: SENTINEL } });

    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).not.toContain(SENTINEL);
    const logged = Object.values(QUIET_LOGGER).flatMap((level) => level.mock.calls);
    expect(logged.length).toBeGreaterThan(0);
    expect(inspect(logged, { depth: null })).not.toContain(SENTINEL);
    expect(QUIET_LOGGER.error).not.toHaveBeenCalled();
  });
});
