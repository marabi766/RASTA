import { VersioningType, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AllExceptionsFilter } from '@rasta/nest-common';
import { OrganizationController } from './organization.controller';
import { OrganizationService } from './organization.service';

/**
 * Organisation names are a deliberately narrower class than display text: they
 * gained the Persian comma «،» (a legal name a person types can hold one) and
 * nothing else. Through the real `OrganizationController` and its pipe: «،» is
 * accepted; «؛», «؟», «:», a line break and a bidi control are still refused.
 */
describe('an organization name with Persian punctuation (HTTP)', () => {
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

  const post = (name: string) =>
    request(app.getHttpServer()).post('/v1/organizations').send({ name, type: 'COMPANY' });

  it('accepts «،» in a name', async () => {
    const response = await post('شرکت راه‌سازان، عمران و توسعه');

    expect(response.status).toBe(201);
    expect(organizations.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'شرکت راه‌سازان، عمران و توسعه' }),
    );
  });

  it('keeps the whitespace rule it always had: a line break still validates', async () => {
    expect((await post('شرکت\nنمونه')).status).toBe(201);
  });

  it.each([
    ['«؛»', 'شرکت نمونه؛ دو'],
    ['«؟»', 'شرکت نمونه؟'],
    ['a colon', 'شرکت: نمونه'],
    ['a plus', 'شرکت + نمونه'],
    ['a bidi control', 'شرکت نمونه‮'],
    ['a tatweel', 'شرکـت نمونه'],
  ])('still refuses %s in a name (the class did not loosen)', async (_label, name) => {
    const response = await post(name);

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('VALIDATION_FAILED');
    expect(organizations.create).not.toHaveBeenCalled();
  });
});
