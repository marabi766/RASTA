import { VersioningType, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AllExceptionsFilter } from '@rasta/nest-common';
import { ClaimService } from '../insurance/claim.service';
import { InsuranceService } from '../insurance/insurance.service';
import { AssetController } from './asset.controller';
import { AssetService } from './asset.service';
import { MAX_SPECIFICATION_KEYS } from './dto';
import { IdempotencyStore } from './idempotency';

/**
 * `specifications` is a free-form record, and a record parses every entry
 * before any refinement sees the whole (GHSA-mrhx-c7xc-m3w5 is the same flaw
 * for arrays). Its keys are now counted first: through the real
 * `AssetController`, one key over {@link MAX_SPECIFICATION_KEYS} answers 400
 * `VALIDATION_FAILED` in the normal envelope, names no key, and reaches no
 * service; at the cap the write goes through unchanged.
 */
describe('asset specifications are capped by key count (HTTP)', () => {
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
    idempotency.execute.mockReset().mockResolvedValue({ result: { id: 'AST_1' } });
  });

  const keys = (count: number, value: unknown = 1) =>
    Object.fromEntries(Array.from({ length: count }, (_, i) => [`SENTINEL-${i}`, value]));

  function expectRefused(response: request.Response, ...untouched: jest.Mock[]): void {
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('VALIDATION_FAILED');
    // The pipe's echo backstop cannot check more than 200 keys and values,
    // so it keeps its fixed message rather than the schema's (S-09).
    expect(response.body.details).toEqual([
      { path: 'specifications', code: 'custom', message: 'Invalid input' },
    ]);
    expect(JSON.stringify(response.body)).not.toContain('SENTINEL');
    for (const mock of untouched) expect(mock).not.toHaveBeenCalled();
  }

  it('POST /v1/assets refuses one key over the cap', async () => {
    const response = await request(app.getHttpServer())
      .post('/v1/assets')
      .set('Idempotency-Key', 'create-asset-0001')
      .send({
        name: 'گریدر شماره یک',
        type: 'GRADER',
        specifications: keys(MAX_SPECIFICATION_KEYS + 1),
      });
    expectRefused(response, idempotency.execute, assets.create);
  });

  it('PATCH /v1/assets/:id refuses one key over the cap, with one detail however many keys', async () => {
    const response = await request(app.getHttpServer())
      .patch('/v1/assets/AST_1')
      .send({ specifications: keys(2000, 'ok'), expectedVersion: 1 });
    expectRefused(response, assets.update);
  });

  it('PATCH /v1/assets/:id accepts specifications at the cap, unchanged', async () => {
    const specifications = keys(MAX_SPECIFICATION_KEYS);
    const response = await request(app.getHttpServer())
      .patch('/v1/assets/AST_1')
      .send({ specifications, expectedVersion: 1 });

    expect(response.status).toBeLessThan(300);
    expect(assets.update).toHaveBeenCalledWith(
      'AST_1',
      expect.objectContaining({ specifications }),
    );
  });
});
