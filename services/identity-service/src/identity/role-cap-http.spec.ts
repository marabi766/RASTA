import { VersioningType, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AllExceptionsFilter } from '@rasta/nest-common';
import { PLATFORM_ROLES } from './dto';
import {
  MembershipController,
  RegistrationController,
  UserController,
} from './identity.controller';
import { IdentityService } from './identity.service';

/**
 * Every role list a request carries is capped at the platform's role count
 * (GHSA-mrhx-c7xc-m3w5), as `POST /v1/users` already was: the array is
 * refused for its length, not walked element by element first. Through the
 * real controllers and their validation pipes: one role over the cap answers
 * 400 `VALIDATION_FAILED` in the normal envelope and never reaches the
 * service; an oversized array of invalid elements is the same 400, not a 500.
 */
describe('role lists at the HTTP boundary are capped at the platform role count', () => {
  const QUIET_LOGGER = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() };
  const identity = {
    addMembership: jest.fn(),
    updateMembershipRoles: jest.fn(),
    submitRegistration: jest.fn(),
    approveRegistration: jest.fn(),
  };
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [UserController, MembershipController, RegistrationController],
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
    for (const method of Object.values(identity)) method.mockReset().mockResolvedValue({});
  });

  const ALL_ROLES = [...PLATFORM_ROLES];
  const ONE_OVER = [...PLATFORM_ROLES, 'DRIVER'];

  const ROUTES = [
    {
      route: 'POST /v1/users/:id/memberships',
      path: '/v1/users/USR_1/memberships',
      field: 'roles',
      body: (roles: unknown[]) => ({ organizationId: 'ORG-SEED-0001', roles }),
      service: identity.addMembership,
    },
    {
      route: 'POST /v1/memberships/:id/roles',
      path: '/v1/memberships/MBR_1/roles',
      field: 'roles',
      body: (roles: unknown[]) => ({ roles, reason: 'جابه‌جایی مسئولیت' }),
      service: identity.updateMembershipRoles,
    },
    {
      route: 'POST /v1/registration-requests',
      path: '/v1/registration-requests',
      field: 'requestedRoles',
      body: (requestedRoles: unknown[]) => ({
        username: 'applicant.one',
        email: 'applicant@example.test',
        firstName: 'زهرا',
        lastName: 'احمدی',
        requestedOrganizationId: 'ORG-SEED-0001',
        requestedRoles,
      }),
      service: identity.submitRegistration,
    },
    {
      route: 'POST /v1/registration-requests/:id/approve',
      path: '/v1/registration-requests/REG_1/approve',
      field: 'roles',
      body: (roles: unknown[]) => ({ roles }),
      service: identity.approveRegistration,
    },
  ];

  describe.each(ROUTES)('$route', ({ path, field, body, service }) => {
    it(`accepts every platform role once (${PLATFORM_ROLES.length})`, async () => {
      const response = await request(app.getHttpServer()).post(path).send(body(ALL_ROLES));

      expect(response.status).toBeLessThan(300);
      expect(service).toHaveBeenCalledTimes(1);
    });

    it('refuses one role over the cap with 400 VALIDATION_FAILED, before the service', async () => {
      const response = await request(app.getHttpServer()).post(path).send(body(ONE_OVER));

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('VALIDATION_FAILED');
      expect(response.body.details).toEqual([
        {
          path: field,
          code: 'too_big',
          message: `Array must contain at most ${PLATFORM_ROLES.length} element(s)`,
        },
      ]);
      expect(service).not.toHaveBeenCalled();
    });

    it('refuses an oversized array of invalid elements with the same 400, not a 500', async () => {
      const response = await request(app.getHttpServer())
        .post(path)
        .send(body(Array.from({ length: 1000 }, () => 42)));

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('VALIDATION_FAILED');
      // One detail, the length: no element was parsed (zod 3 added one issue per
      // element after it — 1,001 here — which is GHSA-mrhx-c7xc-m3w5).
      expect(response.body.details).toEqual([
        {
          path: field,
          code: 'too_big',
          message: `Array must contain at most ${PLATFORM_ROLES.length} element(s)`,
        },
      ]);
      expect(service).not.toHaveBeenCalled();
    });
  });
});
