import { RastaError, runWithContext, type RequestContext } from '@rasta/nest-common';
import { TEST_ORG_A, TEST_ORG_B, TEST_USER_A, TEST_USER_B } from '@rasta/testing';
import { IdentityService } from './identity.service';
import type { IdentityRepository } from './identity.repository';
import type { KeycloakAdminClient } from '../keycloak/keycloak.client';
import { KeycloakProjector } from '../keycloak/keycloak.projector';
import { IDENTITY_EVENTS } from './events';
import { REFUSAL_SITES, refusalSiteOf } from '../security-events/refusal-sites';
import { DEFAULT_ROLE_GRANT_POLICY, assertMayGrantRoles } from './role-grants';
import type { PlatformRole } from './dto';

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
    organizationIds: [],
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
    membership: {
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(async () => ({ count: 1 })),
      findFirst: jest.fn(async () => null),
    },
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
    lockUserProjection: jest.fn(async () => undefined),
    findOrganizationRefs: jest.fn(async () => []),
    listUsersInOrganization: jest.fn(),
    ...overrides,
  } as unknown as jest.Mocked<IdentityRepository>;

  const keycloak = {
    enabled: true,
    createUser: jest.fn(async () => 'kc-new'),
    replacePlatformAttributes: jest.fn(async () => undefined),
    getPlatformAttributes: jest.fn(),
    isHealthy: jest.fn(async () => true),
  } as unknown as jest.Mocked<KeycloakAdminClient>;

  // The real projector over the mocked repository and client, so these tests
  // see exactly the attribute set a membership change writes.
  const projector = new KeycloakProjector(repository, keycloak);

  return {
    service: new IdentityService(repository, keycloak, projector),
    repository,
    keycloak,
    enqueued,
  };
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

  it.each([
    ['no membership', null],
    ['a revoked membership', membershipRow({ organizationId: TEST_ORG_B, status: 'REVOKED' })],
  ])(
    'marks the refusal for %s as the allowlisted audit site, changing nothing else (ADR-053 § 4)',
    async (_label, membership) => {
      const h = harness();
      h.repository.findMembership.mockResolvedValue(membership as never);

      const refusal = await runWithContext(context(), () =>
        h.service.switchActiveOrganization({ organizationId: TEST_ORG_B }),
      ).then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(refusal).toBeInstanceOf(RastaError);
      expect(refusal).toMatchObject({ status: 403, code: 'TENANT_MISMATCH' });
      expect(refusalSiteOf(refusal)).toBe(REFUSAL_SITES.SWITCH_ACTIVE_ORGANIZATION);
      // The active organization was not changed.
      expect(
        (h.repository.client as unknown as { user: { update: jest.Mock } }).user.update,
      ).not.toHaveBeenCalled();
    },
  );
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

describe('getCurrentUser — the grantable-roles field', () => {
  /**
   * The field a client renders its role picker from (`docs/24` Q-60). It is
   * not a permission check — every write is refused by the ladder whatever a
   * client sends — so what these tests protect is *agreement*: the picker must
   * offer exactly what the service would accept, or it misleads the person
   * using it.
   */
  function withUser(roles: string[], membershipRoles = ['ORGANIZATION_ADMIN']) {
    const h = harness();
    h.repository.findUserWithMemberships.mockResolvedValue({
      ...userRow(),
      memberships: [membershipRow({ roles: membershipRoles })],
    } as never);
    return runWithContext(context({ roles }), () => h.service.getCurrentUser());
  }

  it('gives an organization administrator the five organization roles', async () => {
    await expect(withUser(['ORGANIZATION_ADMIN'])).resolves.toMatchObject({
      grantableRoles: [
        'ORGANIZATION_ADMIN',
        'FLEET_MANAGER',
        'DRIVER',
        'OPERATOR',
        'PROCUREMENT_USER',
      ],
    });
  });

  it('gives a caller who may grant nothing an empty list, not every role', async () => {
    const view = await withUser(['DRIVER'], ['DRIVER']);
    expect(view.grantableRoles).toEqual([]);
  });

  it('never offers SYSTEM_ADMIN, not even to a SYSTEM_ADMIN', async () => {
    const view = await withUser(['SYSTEM_ADMIN'], ['SYSTEM_ADMIN']);
    expect(view.grantableRoles).not.toContain('SYSTEM_ADMIN');
    expect(view.grantableRoles).toContain('UNION_ADMIN');
  });

  it('answers from the token, not the membership row, because enforcement does', async () => {
    // A membership demoted after this token was minted still carries the old
    // claims until it is refreshed. `assertMayGrantRoles` measures the token,
    // so this must too — otherwise the picker offers what the write refuses.
    const view = await withUser(['ORGANIZATION_ADMIN'], ['DRIVER']);

    expect(view.effectiveRoles).toEqual(['DRIVER']);
    expect(view.grantableRoles).toContain('FLEET_MANAGER');
  });

  it('agrees with the ladder the writes enforce', async () => {
    // The point of the field, asserted directly: everything it offers is
    // something `assertMayGrantRoles` accepts from the same caller.
    const view = await withUser(['ORGANIZATION_ADMIN']);

    for (const role of view.grantableRoles) {
      expect(() =>
        runWithContext(context({ roles: ['ORGANIZATION_ADMIN'] }), () =>
          assertMayGrantRoles([role as PlatformRole], DEFAULT_ROLE_GRANT_POLICY),
        ),
      ).not.toThrow();
    }
  });
});

describe('Keycloak projection (ADR-060 § 5)', () => {
  const put = (h: Harness) => h.keycloak.replacePlatformAttributes as unknown as jest.Mock;
  const tx = (h: Harness) =>
    h.repository.client as unknown as {
      user: { update: jest.Mock };
      membership: { update: jest.Mock; findFirst: jest.Mock };
    };

  it('creates the account with all four attributes, rasta_user_id included', async () => {
    // Before, only the two organization attributes were written — and on
    // Keycloak 26 not even those survived — so every API-provisioned token fell
    // back to `sub` for its user id and carried no organization at all.
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
        roles: ['OPERATOR', 'DRIVER'],
      }),
    );

    const input = (h.keycloak.createUser as unknown as jest.Mock).mock.calls[0]![0] as {
      attributes: Record<string, string[]>;
    };
    const created = (client.user.create.mock.calls[0]![0] as { data: { id: string } }).data;
    expect(input.attributes).toEqual({
      rasta_user_id: [created.id],
      organization_ids: [TEST_ORG_A],
      organization_roles: [`${TEST_ORG_A}:DRIVER`, `${TEST_ORG_A}:OPERATOR`],
      active_organization_id: [TEST_ORG_A],
    });
  });

  it('writes a demotion to Keycloak — the whole set, in one write', async () => {
    // Roles used to reach Keycloak only when the account was created, so a
    // demoted administrator kept administering.
    const h = harness();
    h.repository.findMembershipById.mockResolvedValue(
      membershipRow({ roles: ['ORGANIZATION_ADMIN', 'FLEET_MANAGER'] }) as never,
    );
    tx(h).membership.update.mockResolvedValue(membershipRow({ roles: ['FLEET_MANAGER'] }));
    h.repository.findUserById.mockResolvedValue(userRow() as never);
    h.repository.listMembershipsForUser.mockResolvedValue([
      membershipRow({ roles: ['FLEET_MANAGER'] }),
    ] as never);

    await runWithContext(context(), () =>
      h.service.updateMembershipRoles('MBR_1', { roles: ['FLEET_MANAGER'], reason: 'demoted' }),
    );

    expect(put(h)).toHaveBeenCalledTimes(1);
    expect(put(h)).toHaveBeenCalledWith('kc-1', {
      rasta_user_id: [TEST_USER_A],
      organization_ids: [TEST_ORG_A],
      organization_roles: [`${TEST_ORG_A}:FLEET_MANAGER`],
      active_organization_id: [TEST_ORG_A],
    });
  });

  it('writes a new membership to Keycloak', async () => {
    const h = harness();
    h.repository.findUserById.mockResolvedValue(userRow() as never);
    h.repository.findMembership.mockResolvedValue(null as never);
    (
      h.repository.client as unknown as { membership: { create: jest.Mock } }
    ).membership.create.mockResolvedValue(
      membershipRow({ id: 'MBR_2', organizationId: TEST_ORG_B }),
    );
    h.repository.listMembershipsForUser.mockResolvedValue([
      membershipRow(),
      membershipRow({ id: 'MBR_2', organizationId: TEST_ORG_B, roles: ['DRIVER'] }),
    ] as never);

    await runWithContext(context({ roles: ['SYSTEM_ADMIN'] }), () =>
      h.service.addMembership(TEST_USER_A, { organizationId: TEST_ORG_B, roles: ['DRIVER'] }),
    );

    expect(put(h)).toHaveBeenCalledWith(
      'kc-1',
      expect.objectContaining({
        organization_ids: [TEST_ORG_A, TEST_ORG_B].sort(),
        organization_roles: [`${TEST_ORG_A}:FLEET_MANAGER`, `${TEST_ORG_B}:DRIVER`].sort(),
      }),
    );
  });

  describe('revoking the membership the user is acting for', () => {
    function revokeHarness(next: ReturnType<typeof membershipRow> | null) {
      const h = harness();
      h.repository.findMembershipById.mockResolvedValue(membershipRow() as never);
      // Acting for A — the organization being revoked.
      h.repository.findUserById.mockResolvedValue(userRow() as never);
      tx(h).membership.findFirst.mockResolvedValue(next);
      return h;
    }

    it('moves the active organization to the next remaining membership', async () => {
      const h = revokeHarness(membershipRow({ id: 'MBR_2', organizationId: TEST_ORG_B }));

      await runWithContext(context(), () =>
        h.service.revokeMembership('MBR_1', { reason: 'left' }),
      );

      expect(tx(h).user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ activeOrganizationId: TEST_ORG_B }),
        }),
      );
      // In the revoke's own transaction, so the two never disagree: the first
      // transaction is the revoke, and the move lands before the projection's
      // own transaction takes its lock.
      expect(h.repository.transaction).toHaveBeenCalledTimes(2);
      const lock = h.repository.lockUserProjection as unknown as jest.Mock;
      expect(tx(h).user.update.mock.invocationCallOrder[0]).toBeLessThan(
        lock.mock.invocationCallOrder[0]!,
      );
    });

    it('clears it when no membership remains', async () => {
      const h = revokeHarness(null);

      await runWithContext(context(), () =>
        h.service.revokeMembership('MBR_1', { reason: 'left' }),
      );

      expect(tx(h).user.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ activeOrganizationId: null }) }),
      );
    });

    it('leaves the active organization alone when another membership is revoked', async () => {
      const h = revokeHarness(null);
      h.repository.findMembershipById.mockResolvedValue(
        membershipRow({ organizationId: TEST_ORG_B }) as never,
      );

      await runWithContext(context({ roles: ['SYSTEM_ADMIN'] }), () =>
        h.service.revokeMembership('MBR_1', { reason: 'left' }),
      );

      expect(tx(h).user.update).not.toHaveBeenCalled();
    });

    it('projects the revocation, so the organization leaves org_ids', async () => {
      const h = revokeHarness(null);
      h.repository.listMembershipsForUser.mockResolvedValue([] as never);

      await runWithContext(context(), () =>
        h.service.revokeMembership('MBR_1', { reason: 'left' }),
      );

      expect(put(h)).toHaveBeenCalledWith('kc-1', {
        rasta_user_id: [TEST_USER_A],
        organization_ids: [],
        organization_roles: [],
        active_organization_id: [],
      });
    });
  });

  it('does not fail a committed membership change when Keycloak is down', async () => {
    // The row is committed; failing now would report a change that happened as
    // one that did not. The outbox event from the same transaction retries it.
    const h = harness();
    h.repository.findMembershipById.mockResolvedValue(membershipRow() as never);
    tx(h).membership.update.mockResolvedValue(membershipRow({ roles: ['DRIVER'] }));
    h.repository.findUserById.mockResolvedValue(userRow() as never);
    put(h).mockRejectedValue(RastaError.upstreamUnavailable('keycloak'));

    await expect(
      runWithContext(context(), () =>
        h.service.updateMembershipRoles('MBR_1', { roles: ['DRIVER'], reason: 'reassigned' }),
      ),
    ).resolves.toMatchObject({ roles: ['DRIVER'] });
  });

  it('reports a failed switch, which has no event to retry from', async () => {
    const h = harness();
    h.repository.findMembership.mockResolvedValue(
      membershipRow({ organizationId: TEST_ORG_B }) as never,
    );
    tx(h).user.update.mockResolvedValue(userRow({ activeOrganizationId: TEST_ORG_B }));
    h.repository.findUserById.mockResolvedValue(
      userRow({ activeOrganizationId: TEST_ORG_B }) as never,
    );
    put(h).mockRejectedValue(RastaError.upstreamUnavailable('keycloak'));

    await expect(
      runWithContext(context(), () =>
        h.service.switchActiveOrganization({ organizationId: TEST_ORG_B }),
      ),
    ).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
  });
});

// ---------------------------------------------------------------------------

describe('membership validity window (ADR-060 § 5)', () => {
  // A controlled clock: every decision below reads `new Date()`, and the point
  // of these tests is which side of validUntil it is on.
  const VALID_UNTIL = new Date('2026-10-01T00:00:00.000Z');
  const before = new Date(VALID_UNTIL.getTime() - 1000);
  const after = new Date(VALID_UNTIL.getTime() + 1000);

  const put = (h: Harness) => h.keycloak.replacePlatformAttributes as unknown as jest.Mock;
  const tx = (h: Harness) =>
    h.repository.client as unknown as {
      user: { update: jest.Mock };
      membership: { updateMany: jest.Mock; findFirst: jest.Mock };
    };

  const inB = membershipRow({ id: 'MBR_B', organizationId: TEST_ORG_B, validUntil: VALID_UNTIL });
  const inA = membershipRow({ id: 'MBR_A', organizationId: TEST_ORG_A });

  function windowHarness() {
    const h = harness();
    h.repository.findMembership.mockResolvedValue(inB as never);
    h.repository.listMembershipsForUser.mockResolvedValue([inA, inB] as never);
    h.repository.findUserById.mockResolvedValue(
      userRow({ activeOrganizationId: TEST_ORG_B }) as never,
    );
    tx(h).user.update.mockResolvedValue(userRow({ activeOrganizationId: TEST_ORG_B }));
    return h;
  }

  function at<T>(now: Date, fn: () => Promise<T>): Promise<T> {
    jest.setSystemTime(now);
    return fn();
  }

  beforeEach(() => jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] }));
  afterEach(() => jest.useRealTimers());

  it('before validUntil: the switch succeeds and org_ids carries the organization', async () => {
    const h = windowHarness();

    await at(before, () =>
      runWithContext(context(), () =>
        h.service.switchActiveOrganization({ organizationId: TEST_ORG_B }),
      ),
    );

    expect(put(h)).toHaveBeenCalledWith('kc-1', {
      rasta_user_id: [TEST_USER_A],
      organization_ids: [TEST_ORG_A, TEST_ORG_B].sort(),
      organization_roles: [`${TEST_ORG_A}:FLEET_MANAGER`, `${TEST_ORG_B}:FLEET_MANAGER`].sort(),
      active_organization_id: [TEST_ORG_B],
    });
  });

  it.each([
    ['at validUntil (the end is exclusive)', VALID_UNTIL],
    ['after validUntil', after],
  ])('%s: the switch is refused, audited, and changes nothing', async (_label, now) => {
    const h = windowHarness();

    const refusal = await at(now, () =>
      runWithContext(context(), () =>
        h.service.switchActiveOrganization({ organizationId: TEST_ORG_B }),
      ).then(
        () => undefined,
        (error: unknown) => error,
      ),
    );

    expect(refusal).toMatchObject({ status: 403, code: 'TENANT_MISMATCH' });
    expect(refusalSiteOf(refusal)).toBe(REFUSAL_SITES.SWITCH_ACTIVE_ORGANIZATION);
    expect(tx(h).user.update).not.toHaveBeenCalled();
    expect(put(h)).not.toHaveBeenCalled();
  });

  it('refuses a membership whose validFrom has not arrived', async () => {
    const h = windowHarness();
    h.repository.findMembership.mockResolvedValue(
      membershipRow({ organizationId: TEST_ORG_B, validFrom: after }) as never,
    );

    await expect(
      at(before, () =>
        runWithContext(context(), () =>
          h.service.switchActiveOrganization({ organizationId: TEST_ORG_B }),
        ),
      ),
    ).rejects.toMatchObject({ code: 'TENANT_MISMATCH' });
  });

  describe('expireLapsedMembership', () => {
    it('after validUntil: moves the active organization, records the expiry, and drops it from the token', async () => {
      const h = windowHarness();
      // The remaining live membership the active organization moves to.
      tx(h).membership.findFirst.mockResolvedValue(inA);
      // What the projector reads once the lapse has committed.
      h.repository.findUserById
        .mockResolvedValueOnce(userRow({ activeOrganizationId: TEST_ORG_B }) as never)
        .mockResolvedValue(userRow({ activeOrganizationId: TEST_ORG_A }) as never);

      const acted = await at(after, () => h.service.expireLapsedMembership(inB, after));

      expect(acted).toBe(true);
      // Claimed with the guard, so a second replica cannot act on it too.
      expect(tx(h).membership.updateMany).toHaveBeenCalledWith({
        where: { id: 'MBR_B', lapseHandledAt: null, deletedAt: null },
        data: { lapseHandledAt: after },
      });
      expect(tx(h).user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ activeOrganizationId: TEST_ORG_A, updatedBy: 'SYSTEM' }),
        }),
      );
      expect(h.enqueued).toEqual([
        {
          eventName: 'MEMBERSHIP_EXPIRED',
          payload: {
            membershipId: 'MBR_B',
            userId: TEST_USER_A,
            organizationId: TEST_ORG_B,
            validUntil: VALID_UNTIL.toISOString(),
          },
        },
      ]);
      expect(put(h)).toHaveBeenCalledWith('kc-1', {
        rasta_user_id: [TEST_USER_A],
        organization_ids: [TEST_ORG_A],
        organization_roles: [`${TEST_ORG_A}:FLEET_MANAGER`],
        active_organization_id: [TEST_ORG_A],
      });
    });

    it('does nothing when another replica claimed the lapse first', async () => {
      const h = windowHarness();
      tx(h).membership.updateMany.mockResolvedValue({ count: 0 });

      const acted = await at(after, () => h.service.expireLapsedMembership(inB, after));

      expect(acted).toBe(false);
      expect(h.enqueued).toEqual([]);
      expect(tx(h).user.update).not.toHaveBeenCalled();
      expect(put(h)).not.toHaveBeenCalled();
    });

    it('does nothing before validUntil', async () => {
      const h = windowHarness();

      const acted = await at(before, () => h.service.expireLapsedMembership(inB, before));

      expect(acted).toBe(false);
      expect(h.repository.transaction).not.toHaveBeenCalled();
    });
  });
});
