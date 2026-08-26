import { RastaError, runWithContext, type RequestContext } from '@rasta/nest-common';
import { TEST_ORG_A, TEST_ORG_B, TEST_USER_A, TEST_USER_B } from '@rasta/testing';
import { IdentityService } from './identity.service';
import type { IdentityRepository } from './identity.repository';
import type { KeycloakAdminClient } from '../keycloak/keycloak.client';
import { IDENTITY_EVENTS } from './events';

/**
 * Identity service behaviour, with the repository and Keycloak stubbed.
 *
 * The cases here are the ones where a mistake is a security defect rather than
 * a bug: tenant boundary, account enumeration, and cache invalidation on role
 * removal.
 */

function context(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    correlationId: 'CORR_1',
    requestId: 'REQ_1',
    organizationId: TEST_ORG_A,
    userId: TEST_USER_A,
    roles: ['ORGANIZATION_ADMIN'],
    authType: 'USER',
    startedAt: 0,
    ...overrides,
  };
}

function userRow(overrides: Record<string, unknown> = {}) {
  return {
    id: TEST_USER_A,
    keycloakId: 'kc-1',
    username: 'dehyari.admin',
    email: 'dehyari.admin@rasta.local',
    firstName: 'دهیار',
    lastName: 'نمونه',
    phone: null,
    status: 'ACTIVE',
    activeOrganizationId: TEST_ORG_A,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    version: 1,
    ...overrides,
  };
}

function membershipRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'MBR_1',
    userId: TEST_USER_A,
    organizationId: TEST_ORG_A,
    roles: ['FLEET_MANAGER'],
    status: 'ACTIVE',
    validFrom: new Date(0),
    validUntil: null,
    version: 1,
    ...overrides,
  };
}

interface Harness {
  service: IdentityService;
  repository: jest.Mocked<IdentityRepository>;
  keycloak: jest.Mocked<KeycloakAdminClient>;
  enqueued: Array<{ eventName: string; payload: unknown }>;
}

function harness(overrides: Partial<jest.Mocked<IdentityRepository>> = {}): Harness {
  const enqueued: Array<{ eventName: string; payload: unknown }> = [];

  const tx = {
    user: { create: jest.fn(), update: jest.fn() },
    membership: { create: jest.fn(), update: jest.fn() },
    registrationRequest: { create: jest.fn(), update: jest.fn() },
  };

  const repository = {
    client: tx,
    transaction: jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(tx)),
    enqueueEvent: jest.fn(async (_tx: unknown, input: { eventName: string; payload: unknown }) => {
      enqueued.push({ eventName: input.eventName, payload: input.payload });
      return 'evt-1';
    }),
    findUserById: jest.fn(),
    findUserByUsernameOrEmail: jest.fn(),
    findUserWithMemberships: jest.fn(),
    findMembership: jest.fn(),
    findMembershipById: jest.fn(),
    listMembershipsForUser: jest.fn(async () => []),
    findOrganizationRefs: jest.fn(async () => []),
    listUsersInOrganization: jest.fn(),
    ...overrides,
  } as unknown as jest.Mocked<IdentityRepository>;

  const keycloak = {
    createUser: jest.fn(async () => 'kc-new'),
    syncMemberships: jest.fn(async () => undefined),
    setActiveOrganization: jest.fn(async () => undefined),
    assignRealmRoles: jest.fn(async () => undefined),
    isHealthy: jest.fn(async () => true),
  } as unknown as jest.Mocked<KeycloakAdminClient>;

  return { service: new IdentityService(repository, keycloak), repository, keycloak, enqueued };
}

// ---------------------------------------------------------------------------

describe('switchActiveOrganization', () => {
  it('switches to an organization the user belongs to', async () => {
    const h = harness();
    h.repository.findMembership.mockResolvedValue(
      membershipRow({ organizationId: TEST_ORG_B }) as never,
    );
    (
      h.repository.client as unknown as { user: { update: jest.Mock } }
    ).user.update.mockResolvedValue(userRow({ activeOrganizationId: TEST_ORG_B }));

    const result = await runWithContext(context(), () =>
      h.service.switchActiveOrganization({ organizationId: TEST_ORG_B }),
    );

    expect(result.activeOrganizationId).toBe(TEST_ORG_B);
  });

  it('refuses an organization the user is not a member of', async () => {
    // Without this check the endpoint would be a tenant escape with a
    // friendly name: any caller could simply ask to act for any organization.
    const h = harness();
    h.repository.findMembership.mockResolvedValue(null as never);

    await expect(
      runWithContext(context(), () =>
        h.service.switchActiveOrganization({ organizationId: TEST_ORG_B }),
      ),
    ).rejects.toMatchObject({ code: 'TENANT_MISMATCH' });
  });

  it('refuses an organization whose membership is revoked', async () => {
    const h = harness();
    h.repository.findMembership.mockResolvedValue(
      membershipRow({ organizationId: TEST_ORG_B, status: 'REVOKED' }) as never,
    );

    await expect(
      runWithContext(context(), () =>
        h.service.switchActiveOrganization({ organizationId: TEST_ORG_B }),
      ),
    ).rejects.toMatchObject({ code: 'TENANT_MISMATCH' });
  });
});

describe('getUser — object-level authorization', () => {
  it('returns a user who shares the requesting organization', async () => {
    const h = harness();
    h.repository.findMembership.mockResolvedValue(membershipRow({ userId: TEST_USER_B }) as never);
    h.repository.findUserById.mockResolvedValue(userRow({ id: TEST_USER_B }) as never);

    const result = await runWithContext(context(), () => h.service.getUser(TEST_USER_B));

    expect(result.id).toBe(TEST_USER_B);
  });

  it('returns 404 - not 403 - for a user in another tenant', async () => {
    // A 403 would confirm the user exists, letting an attacker enumerate
    // another organization's members by identifier.
    const h = harness();
    h.repository.findMembership.mockResolvedValue(null as never);

    const error = await runWithContext(context(), () =>
      h.service.getUser(TEST_USER_B).catch((e: unknown) => e),
    );

    expect(error).toBeInstanceOf(RastaError);
    expect((error as RastaError).code).toBe('NOT_FOUND');
    expect((error as RastaError).status).toBe(404);
  });

  it('does not require a membership lookup for self-lookup', async () => {
    const h = harness();
    h.repository.findUserById.mockResolvedValue(userRow() as never);

    await runWithContext(context(), () => h.service.getUser(TEST_USER_A));

    expect(h.repository.findMembership).not.toHaveBeenCalled();
  });
});

describe('createUser', () => {
  it('does not reveal which field collided', async () => {
    // "Email already registered" is an account enumeration oracle.
    const h = harness();
    h.repository.findUserByUsernameOrEmail.mockResolvedValue(userRow() as never);

    const error = await runWithContext(context(), () =>
      h.service
        .createUser({
          username: 'someone',
          email: 'someone@rasta.local',
          firstName: 'A',
          lastName: 'B',
          organizationId: TEST_ORG_A,
          roles: ['OPERATOR'],
        })
        .catch((e: unknown) => e),
    );

    expect((error as RastaError).code).toBe('ALREADY_EXISTS');
    expect((error as RastaError).message).not.toMatch(/email|username/i);
  });

  it('emits activation and membership events in the same transaction', async () => {
    const h = harness();
    h.repository.findUserByUsernameOrEmail.mockResolvedValue(null as never);
    const client = h.repository.client as unknown as {
      user: { create: jest.Mock };
      membership: { create: jest.Mock };
    };
    client.user.create.mockResolvedValue(userRow());
    client.membership.create.mockResolvedValue(membershipRow());

    await runWithContext(context(), () =>
      h.service.createUser({
        username: 'new.user',
        email: 'new.user@rasta.local',
        firstName: 'نو',
        lastName: 'کاربر',
        organizationId: TEST_ORG_A,
        roles: ['OPERATOR'],
      }),
    );

    expect(h.enqueued.map((e) => e.eventName)).toEqual([
      IDENTITY_EVENTS.USER_ACTIVATED,
      IDENTITY_EVENTS.MEMBERSHIP_CREATED,
    ]);
    // The events go through the same transaction callback as the writes, which
    // is what the outbox guarantee rests on.
    expect(h.repository.transaction).toHaveBeenCalledTimes(1);
  });
});

describe('updateMembershipRoles', () => {
  it('emits ROLE_REVOKED when a role is removed', async () => {
    // The gateway consumes this to drop its cached permissions. Without the
    // event, a revoked role keeps working until the cache TTL expires.
    const h = harness();
    h.repository.findMembershipById.mockResolvedValue(
      membershipRow({ roles: ['FLEET_MANAGER', 'PROCUREMENT_USER'] }) as never,
    );
    (
      h.repository.client as unknown as { membership: { update: jest.Mock } }
    ).membership.update.mockResolvedValue(membershipRow({ roles: ['FLEET_MANAGER'] }));

    await runWithContext(context(), () =>
      h.service.updateMembershipRoles('MBR_1', {
        roles: ['FLEET_MANAGER'],
        reason: 'no longer handles procurement',
      }),
    );

    expect(h.enqueued.map((e) => e.eventName)).toContain(IDENTITY_EVENTS.ROLE_REVOKED);
    expect(h.enqueued.map((e) => e.eventName)).not.toContain(IDENTITY_EVENTS.ROLE_ASSIGNED);
  });

  it('emits ROLE_ASSIGNED when a role is added', async () => {
    const h = harness();
    h.repository.findMembershipById.mockResolvedValue(
      membershipRow({ roles: ['OPERATOR'] }) as never,
    );
    (
      h.repository.client as unknown as { membership: { update: jest.Mock } }
    ).membership.update.mockResolvedValue(membershipRow({ roles: ['OPERATOR', 'FLEET_MANAGER'] }));

    await runWithContext(context(), () =>
      h.service.updateMembershipRoles('MBR_1', {
        roles: ['OPERATOR', 'FLEET_MANAGER'],
        reason: 'promoted to fleet manager',
      }),
    );

    expect(h.enqueued.map((e) => e.eventName)).toContain(IDENTITY_EVENTS.ROLE_ASSIGNED);
  });

  it('emits both when roles are exchanged', async () => {
    const h = harness();
    h.repository.findMembershipById.mockResolvedValue(
      membershipRow({ roles: ['OPERATOR'] }) as never,
    );
    (
      h.repository.client as unknown as { membership: { update: jest.Mock } }
    ).membership.update.mockResolvedValue(membershipRow({ roles: ['DRIVER'] }));

    await runWithContext(context(), () =>
      h.service.updateMembershipRoles('MBR_1', { roles: ['DRIVER'], reason: 'role change' }),
    );

    const names = h.enqueued.map((e) => e.eventName);
    expect(names).toContain(IDENTITY_EVENTS.ROLE_ASSIGNED);
    expect(names).toContain(IDENTITY_EVENTS.ROLE_REVOKED);
  });

  it('404s for a membership outside the requesting tenant', async () => {
    // findMembershipById goes through the tenant-scoped client, so another
    // tenant's membership simply is not found.
    const h = harness();
    h.repository.findMembershipById.mockResolvedValue(null as never);

    await expect(
      runWithContext(context(), () =>
        h.service.updateMembershipRoles('MBR_OTHER', { roles: ['DRIVER'], reason: 'x' }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('registration review', () => {
  it('refuses to approve a registration that is not pending', async () => {
    const h = harness();
    (
      h.repository.client as unknown as { registrationRequest: { findFirst: jest.Mock } }
    ).registrationRequest = {
      findFirst: jest.fn().mockResolvedValue({
        id: 'REG_1',
        status: 'APPROVED',
        userId: TEST_USER_B,
        requestedOrganizationId: TEST_ORG_A,
        requestedRoles: ['OPERATOR'],
        user: userRow({ id: TEST_USER_B }),
      }),
      update: jest.fn(),
      create: jest.fn(),
    } as never;

    await expect(
      runWithContext(context({ roles: ['UNION_ADMIN'] }), () =>
        h.service.approveRegistration('REG_1', {}),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION' });
  });

  it('lets the reviewer grant narrower roles than were requested', async () => {
    const h = harness();
    const client = h.repository.client as unknown as Record<string, unknown>;
    client.registrationRequest = {
      findFirst: jest.fn().mockResolvedValue({
        id: 'REG_1',
        status: 'PENDING',
        userId: TEST_USER_B,
        requestedOrganizationId: TEST_ORG_A,
        requestedRoles: ['ORGANIZATION_ADMIN', 'FLEET_MANAGER'],
        user: userRow({ id: TEST_USER_B }),
      }),
      update: jest.fn().mockResolvedValue({
        id: 'REG_1',
        userId: TEST_USER_B,
        requestedOrganizationId: TEST_ORG_A,
        requestedRoles: ['ORGANIZATION_ADMIN', 'FLEET_MANAGER'],
        justification: null,
        status: 'APPROVED',
        reviewedBy: TEST_USER_A,
        reviewedAt: new Date(0),
        rejectionReason: null,
        createdAt: new Date(0),
        user: userRow({ id: TEST_USER_B }),
      }),
    };
    (client.user as { update: jest.Mock }).update.mockResolvedValue(userRow({ id: TEST_USER_B }));
    (client.membership as { create: jest.Mock }).create.mockResolvedValue(membershipRow());

    await runWithContext(context({ roles: ['UNION_ADMIN'] }), () =>
      h.service.approveRegistration('REG_1', { roles: ['FLEET_MANAGER'] }),
    );

    const approved = h.enqueued.find((e) => e.eventName === IDENTITY_EVENTS.REGISTRATION_APPROVED);
    expect((approved?.payload as { grantedRoles: string[] }).grantedRoles).toEqual([
      'FLEET_MANAGER',
    ]);
  });
});
