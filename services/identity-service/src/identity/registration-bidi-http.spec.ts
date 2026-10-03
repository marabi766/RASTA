import { VersioningType, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AllExceptionsFilter } from '@rasta/nest-common';
import { RegistrationController } from './identity.controller';
import { IdentityService } from './identity.service';

/**
 * Bidi controls at the HTTP boundary (#209 r1), through the real
 * `RegistrationController` and its validation pipe. `documentRefs` — document
 * ids stored on the request as given and shown to the reviewer — was an array
 * of bare strings. A reference carrying a control or format character now
 * answers 400 `VALIDATION_FAILED`, repeats nothing of the value, and never
 * reaches the service, so no request is created.
 */
describe('a registration request carrying a bidi control in a document reference (HTTP)', () => {
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
    firstName: 'زهرا',
    lastName: 'احمدی',
    requestedOrganizationId: 'ORG-SEED-0001',
    requestedRoles: ['FLEET_MANAGER'],
  };

  it.each([
    ['U+202E', 'DOC_01‮J9'],
    ['U+2068', 'DOC_⁨01J9'],
    ['U+061C', 'DOC_01؜J9'],
    ['a zero-width space', 'DOC_01​J9'],
  ])(
    'POST /v1/registration-requests refuses a documentRef carrying %s',
    async (_label, reference) => {
      const response = await request(app.getHttpServer())
        .post('/v1/registration-requests')
        .send({ ...BODY, documentRefs: ['DOC_01J8', reference] });

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('VALIDATION_FAILED');
      expect(JSON.stringify(response.body)).not.toContain(reference);
      expect(identity.submitRegistration).not.toHaveBeenCalled();
    },
  );

  it('still accepts clean document references', async () => {
    const response = await request(app.getHttpServer())
      .post('/v1/registration-requests')
      .send({ ...BODY, documentRefs: ['DOC_01J8', 'DOC_01J9'] });

    expect(response.status).toBe(201);
    expect(identity.submitRegistration).toHaveBeenCalledWith(
      expect.objectContaining({ documentRefs: ['DOC_01J8', 'DOC_01J9'] }),
    );
  });
});
