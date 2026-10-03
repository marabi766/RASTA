import { VersioningType, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AllExceptionsFilter } from '@rasta/nest-common';
import { OrganizationController } from './organization.controller';
import { OrganizationService } from './organization.service';

/**
 * Bidi controls in free-form JSON at the HTTP boundary (#209 r1), through the
 * real `OrganizationController` and its validation pipes. `metadata` and a
 * policy `value` (which also enters `ORGANIZATION_POLICY_CHANGED`) took any
 * JSON. A bidi control in any key or string value, at any depth and inside
 * arrays, now answers 400 `VALIDATION_FAILED` with a message that names neither
 * the key nor the value, and nothing reaches the service.
 */
describe('an organization write carrying a bidi control in free-form JSON (HTTP)', () => {
  const QUIET_LOGGER = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() };
  const organizations = { create: jest.fn(), update: jest.fn(), setPolicy: jest.fn() };
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

  const MARKER = 'ردیف‌بودجه';
  /** Each hides a bidi control somewhere a shallow check would not look. */
  const SPOOFED: readonly (readonly [string, unknown])[] = [
    ['a top-level value', { registry: `${MARKER}‮12` }],
    ['a top-level key', { [`${MARKER}؜`]: 'x' }],
    ['a nested key', { contact: { [`dept⁦${MARKER}⁩`]: 'x' } }],
    ['a string in a nested array', { codes: [['A-1', `${MARKER}‏`]] }],
    ['an object inside an array', { sites: [{ name: `${MARKER}‪` }] }],
  ];

  function expectRefused(response: request.Response, handler: jest.Mock): void {
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('VALIDATION_FAILED');
    expect(JSON.stringify(response.body)).not.toContain(MARKER);
    expect(handler).not.toHaveBeenCalled();
  }

  it.each(SPOOFED)(
    'POST /v1/organizations refuses metadata with one in %s',
    async (_where, metadata) => {
      const response = await request(app.getHttpServer())
        .post('/v1/organizations')
        .send({ name: 'شرکت نمونه', type: 'COMPANY', metadata });
      expectRefused(response, organizations.create);
    },
  );

  it.each(SPOOFED)(
    'PATCH /v1/organizations/:id refuses metadata with one in %s',
    async (_where, metadata) => {
      const response = await request(app.getHttpServer())
        .patch('/v1/organizations/ORG_1')
        .send({ metadata });
      expectRefused(response, organizations.update);
    },
  );

  it.each([...SPOOFED, ['a bare string value', `${MARKER}⁧`] as const])(
    'POST /v1/organizations/:id/policies refuses a value with one in %s',
    async (_where, value) => {
      const response = await request(app.getHttpServer())
        .post('/v1/organizations/ORG_1/policies')
        .send({ key: 'approval.project.note', value, description: 'دلیل تنظیم این مقدار' });
      expectRefused(response, organizations.setPolicy);
    },
  );

  it('refuses a deeply nested value with a 400, not a stack overflow', async () => {
    let value: unknown = `${MARKER}‮`;
    for (let depth = 0; depth < 2_000; depth += 1) value = [value];
    const response = await request(app.getHttpServer())
      .post('/v1/organizations/ORG_1/policies')
      .send({ key: 'approval.project.note', value, description: 'دلیل تنظیم این مقدار' });
    expectRefused(response, organizations.setPolicy);
  });

  it('still accepts clean nested JSON, Persian with ZWNJ included', async () => {
    const metadata = { نام‌واحد: 'فنی', codes: [['A-1', 'ب-۲']], contact: { floor: 3 } };
    const created = await request(app.getHttpServer())
      .post('/v1/organizations')
      .send({ name: 'شرکت نمونه', type: 'COMPANY', metadata });
    expect(created.status).toBe(201);
    expect(organizations.create).toHaveBeenCalledWith(expect.objectContaining({ metadata }));

    const policy = await request(app.getHttpServer())
      .post('/v1/organizations/ORG_1/policies')
      .send({
        key: 'approval.project.threshold_minor',
        value: { minor: '5000000', levels: [1, 2] },
        description: 'سقف موافقت',
      });
    expect(policy.status).toBeLessThan(300);
    expect(organizations.setPolicy).toHaveBeenCalledTimes(1);
  });
});
