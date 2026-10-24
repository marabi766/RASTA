import { VersioningType, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AllExceptionsFilter } from '@rasta/nest-common';
import { MAX_METADATA_KEYS } from './dto';
import { OrganizationController } from './organization.controller';
import { OrganizationService } from './organization.service';

/**
 * `metadata` is a free-form record, and a record parses every entry before
 * any refinement sees the whole (GHSA-mrhx-c7xc-m3w5 is the same flaw for
 * arrays). Its keys are now counted first: through the real
 * `OrganizationController`, one key over {@link MAX_METADATA_KEYS} answers 400
 * `VALIDATION_FAILED` in the normal envelope, names no key, and reaches no
 * service; at the cap the write goes through unchanged.
 */
describe('organization metadata is capped by key count (HTTP)', () => {
  const QUIET_LOGGER = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() };
  const organizations = { create: jest.fn(), update: jest.fn() };
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [OrganizationController],
      providers: [{ provide: OrganizationService, useValue: organizations }],
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
    for (const mock of Object.values(organizations)) {
      mock.mockReset().mockResolvedValue({ id: 'ORG_1' });
    }
  });

  const keys = (count: number, value: unknown = 1) =>
    Object.fromEntries(Array.from({ length: count }, (_, i) => [`SENTINEL-${i}`, value]));

  function expectRefused(response: request.Response, handler: jest.Mock): void {
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('VALIDATION_FAILED');
    // The pipe's echo backstop cannot check more than 200 keys and values,
    // so it keeps its fixed message rather than the schema's (S-09).
    expect(response.body.details).toEqual([
      { path: 'metadata', code: 'custom', message: 'Invalid input' },
    ]);
    expect(JSON.stringify(response.body)).not.toContain('SENTINEL');
    expect(handler).not.toHaveBeenCalled();
  }

  it('POST /v1/organizations refuses one key over the cap', async () => {
    const response = await request(app.getHttpServer())
      .post('/v1/organizations')
      .send({ name: 'شرکت نمونه', type: 'COMPANY', metadata: keys(MAX_METADATA_KEYS + 1) });
    expectRefused(response, organizations.create);
  });

  it('PATCH /v1/organizations/:id refuses one key over the cap, with one detail however many keys', async () => {
    const response = await request(app.getHttpServer())
      .patch('/v1/organizations/ORG_1')
      .send({ metadata: keys(2000, 'ok') });
    expectRefused(response, organizations.update);
  });

  it('PATCH /v1/organizations/:id accepts metadata at the cap, unchanged', async () => {
    const metadata = keys(MAX_METADATA_KEYS);
    const response = await request(app.getHttpServer())
      .patch('/v1/organizations/ORG_1')
      .send({ metadata });

    expect(response.status).toBeLessThan(300);
    expect(organizations.update).toHaveBeenCalledWith(
      'ORG_1',
      expect.objectContaining({ metadata }),
    );
  });
});
