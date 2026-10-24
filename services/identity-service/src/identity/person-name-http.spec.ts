import { VersioningType, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AllExceptionsFilter } from '@rasta/nest-common';
import { RegistrationController } from './identity.controller';
import { IdentityService } from './identity.service';

/**
 * Person names are NOT display text: letters, marks, spaces, ZWNJ, apostrophe,
 * hyphen and full stop only. The shared display-text rule gained the Persian
 * comma «،» and friends; a name must not — this pins that it did not loosen.
 */
describe('a registration request person name (HTTP)', () => {
  const QUIET_LOGGER = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() };
  const identity = { submitRegistration: jest.fn() };
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [RegistrationController],
      providers: [{ provide: IdentityService, useValue: identity }],
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
    identity.submitRegistration.mockReset().mockResolvedValue({ id: 'REG_1' });
  });

  const BODY = {
    username: 'applicant.one',
    email: 'applicant@example.test',
    lastName: 'احمدی',
    requestedOrganizationId: 'ORG-SEED-0001',
    requestedRoles: ['FLEET_MANAGER'],
  };
  const post = (firstName: string) =>
    request(app.getHttpServer())
      .post('/v1/registration-requests')
      .send({ ...BODY, firstName });

  it('accepts an ordinary name, ZWNJ and apostrophe included', async () => {
    expect((await post('علی‌اکبر')).status).toBe(201);
    expect((await post("Mary-Ann O'Neil")).status).toBe(201);
  });

  it('keeps the whitespace rule it always had: a stored line break still validates', async () => {
    expect((await post('علی\nاکبر')).status).toBe(201);
  });

  it.each([
    ['«،»', 'علی،'],
    ['«؛»', 'علی؛'],
    ['«؟»', 'علی؟'],
    ['an ASCII digit', 'علی2'],
    ['a colon', 'علی:'],
    ['a question mark', 'علی?'],
    ['a bidi control', 'علی‮'],
  ])('refuses %s in a name (the class did not loosen)', async (_label, firstName) => {
    identity.submitRegistration.mockClear();
    const response = await post(firstName);

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('VALIDATION_FAILED');
    expect(identity.submitRegistration).not.toHaveBeenCalled();
  });
});
