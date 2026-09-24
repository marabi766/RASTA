import 'reflect-metadata';
import {
  Module,
  VersioningType,
  type INestApplication,
  type MiddlewareConsumer,
  type NestModule,
} from '@nestjs/common';
import { APP_FILTER, APP_GUARD, NestFactory } from '@nestjs/core';
import request from 'supertest';
import {
  AllExceptionsFilter,
  AuthGuard,
  AUTH_OPTIONS,
  EXCEPTION_FILTER_LOGGER,
  InternalTokenService,
  RequestContextMiddleware,
  RolesGuard,
  type AuthGuardOptions,
  type TokenVerifier,
  type UserClaims,
} from '@rasta/nest-common';
import {
  MembershipController,
  RegistrationController,
  UserController,
} from './identity.controller';
import { IdentityService } from './identity.service';
import { IdentityRepository } from './identity.repository';
import { KeycloakAdminClient } from '../keycloak/keycloak.client';
import { TEST_ORG_A } from '@rasta/testing';
import { DEFAULT_ROLE_GRANT_POLICY, ROLE_GRANT_POLICY } from './role-grants';
import { DEFAULT_PROVISIONING_SCOPE_POLICY, PROVISIONING_SCOPE_POLICY } from './provisioning-scope';

/**
 * The privilege escalation, performed.
 *
 * Every test here is a request a real attacker could send: a real token
 * through the real `AuthGuard` and `RolesGuard`, into the real controller and
 * the real `IdentityService`, with only the database and Keycloak replaced.
 * Nothing stubs the thing under test — a test that asserts `grantableRoles()`
 * returns the right array proves the ladder function works, not that the hole
 * is closed, and the hole was never in the ladder function.
 *
 * ## What was possible before this
 *
 * `@Roles('ORGANIZATION_ADMIN', 'UNION_ADMIN')` decided *may this kind of user
 * change roles*. Nothing decided *which roles*. So the first test below —
 * `ORGANIZATION_ADMIN` posting `roles: ['SYSTEM_ADMIN']` to their **own**
 * membership, which is inside their own tenant, so every tenant check passes —
 * returned `200` and a role that `RolesGuard.SUPER_ROLE` honours on every
 * service on the platform. One request, from any organization administrator.
 *
 * `docs/09` § RBAC threat **I2** ("ارتقای سطح دسترسی با دستکاری نقش") lists the
 * control as "تخصیص نقش فقط توسط ORGANIZATION_ADMIN+ · هر تغییر در Audit ·
 * **تست مجوزدهی**". The first clause was the route guard, the second the
 * `ROLE_ASSIGNED`/`ROLE_REVOKED` events. This file is the third.
 *
 * ## Why the legitimate cases are here too
 *
 * A ladder that refuses everything would pass every attack test and break the
 * product. Each refusal below is paired with the grant it must not touch.
 */

const SECRET = 'identity_unit_test_internal_secret_32_chars!';
const ISSUER = 'rasta-internal';
/** A real seed-format id: the DTOs validate it, so a placeholder would be
 *  refused as malformed before any authorization decision was reached. */
const ORG_A = TEST_ORG_A;

/** An organization the caller has no authority over. */
const ORG_B = 'ORG_01JBQ8Z4K7M2N5P8R1T3V6X9YB';

/** What the unscoped lookups should pretend to find, per test. */
const lookups = { user: true as boolean, membership: false as boolean };

const ADMIN_USER = 'USR_admin';
/** The attacker's own membership — their organization, their row. */
const OWN_MEMBERSHIP = 'MBR_own';
/** A membership held by the platform operator inside the attacker's tenant. */
const OPERATOR_MEMBERSHIP = 'MBR_operator';
const TARGET_USER = 'USR_colleague';
const REGISTRATION = 'REG_pending';

const userTokens = new Map<string, UserClaims>();

function userToken(name: string, roles: string[]): string {
  const token = `user-${name}-${roles.join('.')}`;
  userTokens.set(token, {
    sub: `kc-${name}`,
    rastaUserId: `USR_${name}`,
    organizationId: ORG_A,
    organizationIds: [ORG_A],
    roles,
    expiresAt: Date.now() + 60_000,
  });
  return token;
}

/** The attacker: an ordinary organization administrator, nothing more. */
const orgAdmin = () => `Bearer ${userToken('admin', ['ORGANIZATION_ADMIN'])}`;
const unionAdmin = () => `Bearer ${userToken('union', ['UNION_ADMIN'])}`;
const systemAdmin = () => `Bearer ${userToken('system', ['SYSTEM_ADMIN'])}`;

const tokenVerifier = {
  verifyUserToken: async (token: string) => {
    const claims = userTokens.get(token);
    if (!claims) throw new Error('unknown test token');
    return claims;
  },
} as unknown as TokenVerifier;

const internalTokens = new InternalTokenService(SECRET, ISSUER, 300);

// ---------------------------------------------------------------------------
// The database, reduced to what these paths read and write.
//
// `writes` is the assertion that matters on every refusal: a refusal that
// still wrote the row is not a refusal.
// ---------------------------------------------------------------------------

interface Write {
  model: string;
  roles?: string[];
  status?: string;
}

const writes: Write[] = [];

function membershipRow(id: string, roles: string[]) {
  return {
    id,
    userId: id === OWN_MEMBERSHIP ? ADMIN_USER : 'USR_other',
    organizationId: ORG_A,
    roles,
    status: 'ACTIVE',
    validFrom: new Date(0),
    validUntil: null,
    version: 1,
  };
}

/** Role sets by membership id, so a test can say what the row already holds. */
const memberships = new Map<string, string[]>();

const tx = {
  user: {
    create: async (args: { data: Record<string, unknown> }) => {
      writes.push({ model: 'user' });
      return { ...userRow(), ...args.data, createdAt: new Date(0), updatedAt: new Date(0) };
    },
    update: async () => {
      writes.push({ model: 'user' });
      return { ...userRow(), version: 2 };
    },
  },
  membership: {
    create: async (args: { data: { roles: string[] } }) => {
      writes.push({ model: 'membership', roles: args.data.roles });
      return membershipRow('MBR_new', args.data.roles);
    },
    update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
      writes.push({
        model: 'membership',
        roles: args.data.roles as string[] | undefined,
        status: args.data.status as string | undefined,
      });
      return membershipRow(args.where.id, (args.data.roles as string[]) ?? ['DRIVER']);
    },
  },
  registrationRequest: {
    create: async () => {
      writes.push({ model: 'registrationRequest' });
      return {};
    },
    update: async () => {
      writes.push({ model: 'registrationRequest' });
      return registrationRow('APPROVED');
    },
  },
};

function userRow(overrides: Record<string, unknown> = {}) {
  return {
    id: TARGET_USER,
    keycloakId: 'kc-target',
    username: 'colleague',
    email: 'colleague@rasta.local',
    firstName: 'همکار',
    lastName: 'نمونه',
    phone: null,
    status: 'ACTIVE',
    activeOrganizationId: ORG_A,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    version: 1,
    ...overrides,
  };
}

function registrationRow(status: string) {
  return {
    id: REGISTRATION,
    userId: TARGET_USER,
    requestedOrganizationId: registrationOrganizationId,
    requestedRoles: requestedRoles.slice(),
    justification: null,
    status,
    reviewedBy: null,
    reviewedAt: null,
    rejectionReason: null,
    createdAt: new Date(0),
    user: {
      username: 'applicant',
      email: 'applicant@rasta.local',
      firstName: 'متقاضی',
      lastName: 'نمونه',
    },
  };
}

/** What the pending registration asked for — set per test. */
let requestedRoles: string[] = ['FLEET_MANAGER'];
/** Which organization it asked to join — the applicant chooses this. */
let registrationOrganizationId: string = ORG_A;

const repository = {
  client: {
    ...tx,
    registrationRequest: {
      ...tx.registrationRequest,
      findFirst: async () => registrationRow('PENDING'),
    },
  },
  transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx),
  enqueueEvent: async () => 'evt-1',
  findUserById: async () => (lookups.user ? userRow() : null),
  findUserByUsernameOrEmail: async () => null,
  findUserWithMemberships: async () => null,
  findMembership: async () => (lookups.membership ? membershipRow('MBR_x', ['DRIVER']) : null),
  findMembershipById: async (id: string) => membershipRow(id, memberships.get(id) ?? ['DRIVER']),
  listMembershipsForUser: async () => [],
  findOrganizationRefs: async () => [],
  listUsersInOrganization: async () => ({
    users: [],
    memberships: [],
    nextCursor: null,
    hasMore: false,
  }),
} as unknown as IdentityRepository;

/** Accounts Keycloak was asked to create. A refusal must leave this empty. */
const keycloakCreates: unknown[] = [];

const keycloak = {
  createUser: async (input: unknown) => {
    keycloakCreates.push(input);
    return 'kc-new';
  },
  syncMemberships: async () => undefined,
  setActiveOrganization: async () => undefined,
  assignRealmRoles: async () => undefined,
  isHealthy: async () => true,
} as unknown as KeycloakAdminClient;

@Module({
  controllers: [UserController, MembershipController, RegistrationController],
  providers: [
    { provide: IdentityRepository, useValue: repository },
    { provide: KeycloakAdminClient, useValue: keycloak },
    // The shipped default, not a test-only ladder: these tests assert what a
    // deployment that configures nothing actually does.
    { provide: ROLE_GRANT_POLICY, useValue: DEFAULT_ROLE_GRANT_POLICY },
    { provide: PROVISIONING_SCOPE_POLICY, useValue: DEFAULT_PROVISIONING_SCOPE_POLICY },
    IdentityService,
    { provide: InternalTokenService, useValue: internalTokens },
    {
      provide: AUTH_OPTIONS,
      useValue: {
        serviceName: 'identity-service',
        tokenVerifier,
        internalTokens,
      } satisfies AuthGuardOptions,
    },
    {
      provide: EXCEPTION_FILTER_LOGGER,
      useValue: {
        error: () => undefined,
        warn: () => undefined,
        info: () => undefined,
        debug: () => undefined,
      },
    },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
class TestModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }
}

describe('privilege escalation through role assignment (docs/09 threat I2)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await NestFactory.create(TestModule, { logger: false });
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    writes.length = 0;
    memberships.clear();
    memberships.set(OWN_MEMBERSHIP, ['ORGANIZATION_ADMIN']);
    memberships.set(OPERATOR_MEMBERSHIP, ['SYSTEM_ADMIN']);
    requestedRoles = ['FLEET_MANAGER'];
    registrationOrganizationId = ORG_A;
    keycloakCreates.length = 0;
    lookups.user = true;
    lookups.membership = false;
  });

  const server = () => app.getHttpServer();

  const newUser = (roles: string[]) => ({
    username: 'newcomer',
    email: 'newcomer@rasta.local',
    firstName: 'تازه',
    lastName: 'وارد',
    organizationId: ORG_A,
    roles,
  });

  // -------------------------------------------------------------------------
  // The attack
  // -------------------------------------------------------------------------

  describe('the attack itself', () => {
    it('refuses an ORGANIZATION_ADMIN granting themselves SYSTEM_ADMIN on their own membership', async () => {
      const response = await request(server())
        .post(`/v1/memberships/${OWN_MEMBERSHIP}/roles`)
        .set('authorization', orgAdmin())
        .send({ roles: ['SYSTEM_ADMIN'], reason: 'routine administrative adjustment' });

      expect(response.status).toBe(403);
      expect(response.body.code).toBe('INSUFFICIENT_ROLE');
      expect(writes).toHaveLength(0);
    });

    it('refuses the same grant to a colleague, which is the same escalation one step removed', async () => {
      const response = await request(server())
        .post(`/v1/memberships/MBR_colleague/roles`)
        .set('authorization', orgAdmin())
        .send({ roles: ['SYSTEM_ADMIN'], reason: 'colleague needs broader access' });

      expect(response.status).toBe(403);
      expect(writes).toHaveLength(0);
    });

    it('refuses SYSTEM_ADMIN smuggled in beside a role the caller may grant', async () => {
      const response = await request(server())
        .post(`/v1/memberships/${OWN_MEMBERSHIP}/roles`)
        .set('authorization', orgAdmin())
        .send({
          roles: ['FLEET_MANAGER', 'SYSTEM_ADMIN'],
          reason: 'adding fleet responsibilities',
        });

      expect(response.status).toBe(403);
      expect(writes).toHaveLength(0);
    });

    it('refuses the same escalation through user creation', async () => {
      const response = await request(server())
        .post('/v1/users')
        .set('authorization', orgAdmin())
        .send(newUser(['SYSTEM_ADMIN']));

      expect(response.status).toBe(403);
      expect(response.body.code).toBe('INSUFFICIENT_ROLE');
      expect(writes).toHaveLength(0);
    });

    it('refuses the same escalation through adding a membership', async () => {
      const response = await request(server())
        .post(`/v1/users/${TARGET_USER}/memberships`)
        .set('authorization', orgAdmin())
        .send({ organizationId: ORG_A, roles: ['SYSTEM_ADMIN'] });

      expect(response.status).toBe(403);
      expect(response.body.code).toBe('INSUFFICIENT_ROLE');
      expect(writes).toHaveLength(0);
    });

    it('refuses SYSTEM_ADMIN even to a SYSTEM_ADMIN — nobody grants it through this API', async () => {
      const response = await request(server())
        .post(`/v1/memberships/${OWN_MEMBERSHIP}/roles`)
        .set('authorization', systemAdmin())
        .send({ roles: ['SYSTEM_ADMIN'], reason: 'provisioning a second operator' });

      expect(response.status).toBe(403);
      expect(writes).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // The quiet one: a public endpoint choosing what a reviewer grants
  // -------------------------------------------------------------------------

  describe('escalation through the registration queue', () => {
    it('refuses an anonymous applicant asking for SYSTEM_ADMIN', async () => {
      const response = await request(server())
        .post('/v1/registration-requests')
        .send({
          username: 'applicant',
          email: 'applicant@rasta.local',
          firstName: 'متقاضی',
          lastName: 'نمونه',
          requestedOrganizationId: ORG_A,
          requestedRoles: ['SYSTEM_ADMIN'],
        });

      expect(response.status).toBe(403);
      expect(writes).toHaveLength(0);
    });

    it('refuses approval of a request that asks for a role the reviewer may not grant', async () => {
      // The confused deputy: the roles came from an unauthenticated stranger,
      // and `approveRegistration` grants `dto.roles ?? requestedRoles`. Nothing
      // on the reviewer's screen says the click hands over the platform.
      requestedRoles = ['SYSTEM_ADMIN'];

      const response = await request(server())
        .post(`/v1/registration-requests/${REGISTRATION}/approve`)
        .set('authorization', unionAdmin())
        .send({});

      expect(response.status).toBe(403);
      expect(writes).toHaveLength(0);
    });

    it('lets the reviewer approve the same request with a role they may grant', async () => {
      requestedRoles = ['SYSTEM_ADMIN'];

      const response = await request(server())
        .post(`/v1/registration-requests/${REGISTRATION}/approve`)
        .set('authorization', unionAdmin())
        .send({ roles: ['FLEET_MANAGER'] });

      expect(response.status).toBe(200);
      expect(
        writes.some((w) => w.model === 'membership' && w.roles?.includes('FLEET_MANAGER')),
      ).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // The scope column of docs/09, enforced
  // -------------------------------------------------------------------------

  describe('roles outside the caller scope', () => {
    it.each([['UNION_ADMIN'], ['AUDITOR'], ['SUPPLIER'], ['WORKSHOP'], ['CONTRACTOR']])(
      'refuses an ORGANIZATION_ADMIN granting %s',
      async (role) => {
        const response = await request(server())
          .post(`/v1/memberships/${OWN_MEMBERSHIP}/roles`)
          .set('authorization', orgAdmin())
          .send({ roles: [role], reason: 'expanding responsibilities' });

        expect(response.status).toBe(403);
        expect(writes).toHaveLength(0);
      },
    );

    it.each([['AUDITOR'], ['SUPPLIER'], ['WORKSHOP'], ['CONTRACTOR']])(
      'refuses a UNION_ADMIN granting %s, which belongs to another scope (Q-60)',
      async (role) => {
        const response = await request(server())
          .post(`/v1/memberships/${OWN_MEMBERSHIP}/roles`)
          .set('authorization', unionAdmin())
          .send({ roles: [role], reason: 'expanding responsibilities' });

        expect(response.status).toBe(403);
        expect(writes).toHaveLength(0);
      },
    );
  });

  // -------------------------------------------------------------------------
  // Reaching the other way: demotion and eviction
  // -------------------------------------------------------------------------

  describe('a membership above the caller ladder', () => {
    it('refuses an ORGANIZATION_ADMIN demoting the platform operator to DRIVER', async () => {
      const response = await request(server())
        .post(`/v1/memberships/${OPERATOR_MEMBERSHIP}/roles`)
        .set('authorization', orgAdmin())
        .send({ roles: ['DRIVER'], reason: 'reorganising the team' });

      expect(response.status).toBe(403);
      expect(writes).toHaveLength(0);
    });

    it('refuses an ORGANIZATION_ADMIN revoking the platform operator membership', async () => {
      const response = await request(server())
        .post(`/v1/memberships/${OPERATOR_MEMBERSHIP}/revoke`)
        .set('authorization', orgAdmin())
        .send({ reason: 'no longer with the organization' });

      expect(response.status).toBe(403);
      expect(writes).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // What must still work
  // -------------------------------------------------------------------------

  describe('the grants the product depends on', () => {
    it('lets an ORGANIZATION_ADMIN grant FLEET_MANAGER', async () => {
      const response = await request(server())
        .post(`/v1/memberships/${OWN_MEMBERSHIP}/roles`)
        .set('authorization', orgAdmin())
        .send({ roles: ['FLEET_MANAGER'], reason: 'taking over the fleet' });

      expect(response.status).toBe(200);
      expect(writes).toEqual([
        { model: 'membership', roles: ['FLEET_MANAGER'], status: undefined },
      ]);
    });

    it.each([['DRIVER'], ['OPERATOR'], ['PROCUREMENT_USER']])(
      'lets an ORGANIZATION_ADMIN grant %s',
      async (role) => {
        const response = await request(server())
          .post(`/v1/memberships/${OWN_MEMBERSHIP}/roles`)
          .set('authorization', orgAdmin())
          .send({ roles: [role], reason: 'assigning duties' });

        expect(response.status).toBe(200);
      },
    );

    it('lets an ORGANIZATION_ADMIN promote a peer to ORGANIZATION_ADMIN (Q-60 temporary decision)', async () => {
      const response = await request(server())
        .post(`/v1/memberships/${OWN_MEMBERSHIP}/roles`)
        .set('authorization', orgAdmin())
        .send({ roles: ['ORGANIZATION_ADMIN'], reason: 'second administrator for cover' });

      expect(response.status).toBe(200);
    });

    it('lets a UNION_ADMIN grant ORGANIZATION_ADMIN', async () => {
      const response = await request(server())
        .post(`/v1/memberships/${OWN_MEMBERSHIP}/roles`)
        .set('authorization', unionAdmin())
        .send({
          roles: ['ORGANIZATION_ADMIN'],
          reason: 'appointing the organization administrator',
        });

      expect(response.status).toBe(200);
    });

    it('lets a SYSTEM_ADMIN grant UNION_ADMIN', async () => {
      const response = await request(server())
        .post(`/v1/memberships/${OWN_MEMBERSHIP}/roles`)
        .set('authorization', systemAdmin())
        .send({ roles: ['UNION_ADMIN'], reason: 'appointing the union administrator' });

      expect(response.status).toBe(200);
    });

    it('lets an ORGANIZATION_ADMIN create a user and add a membership with grantable roles', async () => {
      const created = await request(server())
        .post('/v1/users')
        .set('authorization', orgAdmin())
        .send(newUser(['DRIVER']));
      expect(created.status).toBe(201);

      writes.length = 0;
      const added = await request(server())
        .post(`/v1/users/${TARGET_USER}/memberships`)
        .set('authorization', orgAdmin())
        .send({ organizationId: ORG_A, roles: ['OPERATOR'] });
      expect(added.status).toBe(201);
      expect(writes.some((w) => w.model === 'membership' && w.roles?.includes('OPERATOR'))).toBe(
        true,
      );
    });

    it('lets an ORGANIZATION_ADMIN revoke an ordinary membership', async () => {
      memberships.set('MBR_driver', ['DRIVER']);
      const response = await request(server())
        .post('/v1/memberships/MBR_driver/revoke')
        .set('authorization', orgAdmin())
        .send({ reason: 'left the organization' });

      expect(response.status).toBe(204);
      expect(writes.some((w) => w.status === 'REVOKED')).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // The other axis: whose organization (docs/24 Q-61)
  // -------------------------------------------------------------------------

  describe('provisioning into an organization the caller has no authority over', () => {
    it('refuses an ORGANIZATION_ADMIN creating a user in another organization', async () => {
      // The attack: every role in this body is one the ladder permits. What is
      // not permitted is the organization, and before this nothing looked.
      const response = await request(server())
        .post('/v1/users')
        .set('authorization', orgAdmin())
        .send({ ...newUser(['FLEET_MANAGER']), organizationId: ORG_B });

      expect(response.status).toBe(403);
      expect(response.body.code).toBe('TENANT_MISMATCH');
      expect(writes).toHaveLength(0);
      // The one that would have been hardest to undo: a real, enabled account
      // in another organization's realm, created before any row is written.
      expect(keycloakCreates).toHaveLength(0);
    });

    it('refuses an ORGANIZATION_ADMIN adding a membership in another organization', async () => {
      const response = await request(server())
        .post(`/v1/users/${TARGET_USER}/memberships`)
        .set('authorization', orgAdmin())
        .send({ organizationId: ORG_B, roles: ['DRIVER'] });

      expect(response.status).toBe(403);
      expect(response.body.code).toBe('TENANT_MISMATCH');
      expect(writes).toHaveLength(0);
    });

    it('refuses a UNION_ADMIN too, by default (Q-61 temporary decision)', async () => {
      // Narrow until the product says otherwise: `docs/09` calls UNION_ADMIN
      // platform-scoped, which is not the same claim as "may provision into
      // any organization on the platform". One environment value widens it.
      const response = await request(server())
        .post('/v1/users')
        .set('authorization', unionAdmin())
        .send({ ...newUser(['FLEET_MANAGER']), organizationId: ORG_B });

      expect(response.status).toBe(403);
      expect(writes).toHaveLength(0);
    });

    it('lets a SYSTEM_ADMIN provision across organizations', async () => {
      const response = await request(server())
        .post('/v1/users')
        .set('authorization', systemAdmin())
        .send({ ...newUser(['FLEET_MANAGER']), organizationId: ORG_B });

      expect(response.status).toBe(201);
      expect(keycloakCreates).toHaveLength(1);
    });

    it('closes the registration-approval way around it', async () => {
      // `submitRegistration` is `@Public`, so the organization on a pending
      // request is attacker-chosen. Checking only the two direct paths would
      // have left this one open: file a request naming any organization, then
      // approve your own filing.
      registrationOrganizationId = ORG_B;

      const response = await request(server())
        .post(`/v1/registration-requests/${REGISTRATION}/approve`)
        .set('authorization', unionAdmin())
        .send({ roles: ['FLEET_MANAGER'] });

      expect(response.status).toBe(403);
      expect(writes).toHaveLength(0);
      expect(keycloakCreates).toHaveLength(0);
    });
  });

  describe('the cross-tenant membership oracle', () => {
    /**
     * `addMembership` answered three ways for an organization the caller has
     * no business naming — 404 for no such user, 409 for one already a member,
     * 201 otherwise — which told an outsider whether any given person belonged
     * to any given organization. And the 201 was not a read: it *granted* the
     * membership it was probing for.
     *
     * Checking the tenant before either lookup collapses all three into one
     * answer.
     */
    const probe = () =>
      request(server())
        .post(`/v1/users/${TARGET_USER}/memberships`)
        .set('authorization', orgAdmin())
        .send({ organizationId: ORG_B, roles: ['DRIVER'] });

    it('answers identically whether or not the user exists', async () => {
      lookups.user = true;
      const found = await probe();
      lookups.user = false;
      const missing = await probe();

      expect(found.status).toBe(missing.status);
      expect(found.body.code).toBe(missing.body.code);
      expect(found.status).toBe(403);
    });

    it('answers identically whether or not the membership already exists', async () => {
      lookups.membership = false;
      const absent = await probe();
      lookups.membership = true;
      const present = await probe();

      expect(absent.status).toBe(present.status);
      expect(absent.body.code).toBe(present.body.code);
    });

    it('never grants the membership it was probing for', async () => {
      lookups.user = true;
      lookups.membership = false;
      await probe();
      expect(writes).toHaveLength(0);
    });

    it('names no organization in the body it returns', async () => {
      // The refusal must not become the oracle it was written to close.
      const response = await probe();
      const body = JSON.stringify(response.body);
      expect(body).not.toContain(ORG_B);
      expect(body).not.toContain(ORG_A);
    });
  });

  describe('what must still work in the caller own organization', () => {
    it('lets an ORGANIZATION_ADMIN create a user in their own organization', async () => {
      const response = await request(server())
        .post('/v1/users')
        .set('authorization', orgAdmin())
        .send(newUser(['FLEET_MANAGER']));

      expect(response.status).toBe(201);
      expect(keycloakCreates).toHaveLength(1);
    });

    it('lets an ORGANIZATION_ADMIN add a membership in their own organization', async () => {
      const response = await request(server())
        .post(`/v1/users/${TARGET_USER}/memberships`)
        .set('authorization', orgAdmin())
        .send({ organizationId: ORG_A, roles: ['OPERATOR'] });

      expect(response.status).toBe(201);
    });

    it('lets a UNION_ADMIN approve a registration for their own organization', async () => {
      registrationOrganizationId = ORG_A;

      const response = await request(server())
        .post(`/v1/registration-requests/${REGISTRATION}/approve`)
        .set('authorization', unionAdmin())
        .send({ roles: ['FLEET_MANAGER'] });

      expect(response.status).toBe(200);
    });
  });

  // -------------------------------------------------------------------------
  // What the refusal says

  // -------------------------------------------------------------------------

  it('never names the refused roles in the response body (S-09)', async () => {
    const response = await request(server())
      .post(`/v1/memberships/${OWN_MEMBERSHIP}/roles`)
      .set('authorization', orgAdmin())
      .send({ roles: ['SYSTEM_ADMIN'], reason: 'routine administrative adjustment' });

    expect(JSON.stringify(response.body)).not.toContain('SYSTEM_ADMIN');
    expect(JSON.stringify(response.body)).not.toContain('ORGANIZATION_ADMIN');
  });
});
