import { Logger } from '@nestjs/common';
import { ERROR_CODES } from '@rasta/contracts';
import { RastaError, runUnscoped } from '@rasta/nest-common';
import { ulid } from 'ulid';
import { IdentityRepository } from '../src/identity/identity.repository';
import { IdentityService, REGISTRATION_APPROVAL_CODES } from '../src/identity/identity.service';
import { IDENTITY_EVENTS } from '../src/identity/events';
import type { KeycloakAdminClient } from '../src/keycloak/keycloak.client';
import { KeycloakProjector } from '../src/keycloak/keycloak.projector';
import type { PlatformAttributes } from '../src/keycloak/platform-attributes';
import { isClean, runProjectionCommand } from '../src/keycloak/projection.command';
import type { PrismaService } from '../src/prisma/prisma.service';
import { asActor, id, newPrisma, tenants } from './helpers';

/**
 * A registration approval that loses to a concurrent membership add, against
 * a real database (#219 r1, Codex HIGH).
 *
 * Approval creates the Keycloak account — enabled, with the approval's roles
 * — and then writes the user, the request and the membership in one
 * transaction. If an administrator gave the pending person a membership in the
 * same organization in between, the membership insert loses to
 * `ux_membership_live_user_org` and the transaction rolls back. Before this,
 * the account stayed enabled with roles nothing in the database granted, and
 * every retry hit Keycloak's 409.
 *
 * Keycloak is a stateful stand-in: what is proven is what the service asks of
 * it and in what order, against rows a real PostgreSQL commits or refuses.
 */

interface FakeAccount {
  id: string;
  username: string;
  enabled: boolean;
  attributes: PlatformAttributes;
}

class FakeKeycloak {
  readonly enabled = true;
  readonly accounts = new Map<string, FakeAccount>();
  /** Runs after an account is created and before `createUser` returns. */
  afterCreate: (() => Promise<void>) | null = null;
  /** When false, every write after `createUser` fails as an unreachable Keycloak would. */
  reachable = true;

  async createUser(input: { username: string; attributes: PlatformAttributes }): Promise<string> {
    await new Promise((resolve) => setImmediate(resolve));
    if ([...this.accounts.values()].some((account) => account.username === input.username)) {
      throw RastaError.alreadyExists('User');
    }
    const accountId = `kc-${ulid()}`;
    this.accounts.set(accountId, {
      id: accountId,
      username: input.username,
      enabled: true,
      attributes: input.attributes,
    });
    await this.afterCreate?.();
    return accountId;
  }

  async findAccountByUsername(username: string) {
    const found = [...this.accounts.values()].find((account) => account.username === username);
    return found ? { id: found.id, enabled: found.enabled, attributes: found.attributes } : null;
  }

  async replacePlatformAttributes(accountId: string, attributes: PlatformAttributes) {
    this.assertReachable();
    this.accounts.get(accountId)!.attributes = attributes;
  }

  async setEnabled(accountId: string | null, enabled: boolean) {
    this.assertReachable();
    this.accounts.get(accountId!)!.enabled = enabled;
  }

  private assertReachable(): void {
    if (!this.reachable) throw RastaError.upstreamUnavailable('keycloak', { operation: 'test' });
  }
}

const NO_GRANTS = { organization_ids: [], organization_roles: [], active_organization_id: [] };

describe('a registration approval that loses to a concurrent membership add', () => {
  const org = tenants();
  let prisma: PrismaService;
  let repository: IdentityRepository;
  let keycloak: FakeKeycloak;
  let service: IdentityService;
  const users: string[] = [];

  beforeAll(async () => {
    prisma = newPrisma();
    await prisma.onModuleInit();
    repository = new IdentityRepository(prisma);
  });

  beforeEach(() => {
    keycloak = new FakeKeycloak();
    const client = keycloak as unknown as KeycloakAdminClient;
    service = new IdentityService(repository, client, new KeycloakProjector(repository, client));
  });

  afterAll(async () => {
    await runUnscoped('the suite removes its own fixtures', async () => {
      await prisma.client.outboxMessage.deleteMany({
        where: { organizationId: { in: [org.a, org.b] } },
      });
      await prisma.client.membership.deleteMany({ where: { userId: { in: users } } });
      await prisma.client.registrationRequest.deleteMany({ where: { userId: { in: users } } });
      await prisma.client.user.deleteMany({ where: { id: { in: users } } });
    });
    await prisma.onModuleDestroy();
  });

  async function submit(): Promise<{ registrationId: string; userId: string; username: string }> {
    const username = `reg-${ulid().slice(-12)}`.toLowerCase();
    const { registrationId } = await service.submitRegistration({
      username,
      email: `${username}@example.test`,
      firstName: 'متقاضی',
      lastName: 'آزمون',
      requestedOrganizationId: org.a,
      requestedRoles: ['FLEET_MANAGER'],
      documentRefs: [],
    } as never);
    const request = await runUnscoped('the suite reads the request it filed', () =>
      prisma.client.registrationRequest.findUniqueOrThrow({ where: { id: registrationId } }),
    );
    users.push(request.userId);
    return { registrationId, userId: request.userId, username };
  }

  const approve = (registrationId: string) =>
    asActor({ organizationId: org.a, roles: ['SYSTEM_ADMIN'] }, () =>
      service.approveRegistration(registrationId, {}),
    );

  /** What an administrator did while the request waited: a live membership in the same organization. */
  const grantMembership = (userId: string) =>
    runUnscoped('an administrator adds a membership for the pending person', () =>
      prisma.client.membership.create({
        data: {
          id: id('MBR-ADMIN'),
          userId,
          organizationId: org.a,
          roles: ['DRIVER'],
          status: 'ACTIVE',
          createdBy: 'ITEST',
          updatedBy: 'ITEST',
        },
      }),
    );

  const state = (registrationId: string, userId: string) =>
    runUnscoped('the suite reads what the approval left', async () => ({
      request: (
        await prisma.client.registrationRequest.findUniqueOrThrow({
          where: { id: registrationId },
        })
      ).status,
      user: await prisma.client.user.findUniqueOrThrow({
        where: { id: userId },
        select: { status: true, keycloakId: true },
      }),
      approvedEvents: (
        await prisma.client.outboxMessage.findMany({
          where: { eventName: IDENTITY_EVENTS.REGISTRATION_APPROVED, aggregateId: registrationId },
        })
      ).length,
    }));

  const accountOf = (username: string) =>
    [...keycloak.accounts.values()].filter((account) => account.username === username);

  it('answers 409 MEMBERSHIP_ALREADY_LIVE, keeps the request pending, and leaves no enabled account with roles', async () => {
    const { registrationId, userId, username } = await submit();
    keycloak.afterCreate = async () => {
      await grantMembership(userId);
    };

    const refusal = await approve(registrationId).catch((error: unknown) => error);

    expect(refusal).toMatchObject({
      code: ERROR_CODES.ALREADY_EXISTS,
      details: [
        expect.objectContaining({ code: REGISTRATION_APPROVAL_CODES.MEMBERSHIP_ALREADY_LIVE }),
      ],
    });
    expect(await state(registrationId, userId)).toEqual({
      request: 'PENDING',
      user: { status: 'PENDING', keycloakId: null },
      approvedEvents: 0,
    });
    // The account the approval created: disabled, its grants cleared, its
    // provenance kept so the next attempt can prove it is this request's own.
    expect(accountOf(username)).toEqual([
      expect.objectContaining({
        enabled: false,
        attributes: { rasta_user_id: [userId], ...NO_GRANTS },
      }),
    ]);
  });

  it('refuses a retry cleanly while the conflict stands, and approves once it is resolved — with the same account', async () => {
    const { registrationId, userId, username } = await submit();
    let membershipId = '';
    keycloak.afterCreate = async () => {
      membershipId = (await grantMembership(userId)).id;
    };
    await expect(approve(registrationId)).rejects.toMatchObject({
      code: ERROR_CODES.ALREADY_EXISTS,
    });
    keycloak.afterCreate = null;

    // Retry: Keycloak answers 409, the account is proven this request's own
    // and adopted, and the conflict refuses again — leaving it disabled again.
    await expect(approve(registrationId)).rejects.toMatchObject({
      details: [
        expect.objectContaining({ code: REGISTRATION_APPROVAL_CODES.MEMBERSHIP_ALREADY_LIVE }),
      ],
    });
    expect(accountOf(username)).toEqual([expect.objectContaining({ enabled: false })]);
    expect((await state(registrationId, userId)).request).toBe('PENDING');

    // The reviewer resolves it: the administrator's membership is revoked.
    await runUnscoped('the suite revokes the conflicting membership', () =>
      prisma.client.membership.update({
        where: { id: membershipId },
        data: { deletedAt: new Date(), status: 'REVOKED' },
      }),
    );
    await approve(registrationId);

    const [account] = accountOf(username);
    expect(accountOf(username)).toHaveLength(1);
    expect(account).toMatchObject({
      enabled: true,
      attributes: {
        rasta_user_id: [userId],
        organization_ids: [org.a],
        organization_roles: [`${org.a}:FLEET_MANAGER`],
      },
    });
    expect(await state(registrationId, userId)).toEqual({
      request: 'APPROVED',
      user: { status: 'ACTIVE', keycloakId: account!.id },
      approvedEvents: 1,
    });
  });

  it('never adopts an account under the username that this request did not create', async () => {
    const { registrationId, userId, username } = await submit();
    keycloak.accounts.set('kc-foreign', {
      id: 'kc-foreign',
      username,
      enabled: true,
      attributes: { rasta_user_id: ['USR_SOMEBODY_ELSE'], ...NO_GRANTS },
    });

    await expect(approve(registrationId)).rejects.toMatchObject({
      code: ERROR_CODES.ALREADY_EXISTS,
      details: [
        expect.objectContaining({
          code: REGISTRATION_APPROVAL_CODES.ACCOUNT_NOT_FROM_THIS_REGISTRATION,
        }),
      ],
    });
    expect(keycloak.accounts.get('kc-foreign')).toMatchObject({
      enabled: true,
      attributes: { rasta_user_id: ['USR_SOMEBODY_ELSE'] },
    });
    expect(await state(registrationId, userId)).toMatchObject({ request: 'PENDING' });
  });

  it('logs by id when Keycloak cannot be reached to compensate, and reconcile reports the account', async () => {
    const { registrationId, userId, username } = await submit();
    keycloak.afterCreate = async () => {
      await grantMembership(userId);
      keycloak.reachable = false;
    };
    const errors = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    try {
      await expect(approve(registrationId)).rejects.toMatchObject({
        details: [
          expect.objectContaining({ code: REGISTRATION_APPROVAL_CODES.MEMBERSHIP_ALREADY_LIVE }),
        ],
      });
      const [account] = accountOf(username);
      expect(account).toMatchObject({ enabled: true });
      expect(errors).toHaveBeenCalledWith(
        { registrationId, userId, keycloakId: account!.id },
        expect.stringContaining('could not be disabled'),
      );
      expect(JSON.stringify(errors.mock.calls)).not.toContain(username);

      const report = await runProjectionCommand('reconcile', {
        repository,
        projector: { project: jest.fn(), reconcile: jest.fn(async () => null) },
        keycloak,
      });
      expect(report.orphans).toContainEqual({
        userId,
        keycloakId: account!.id,
        enabled: true,
        grants: true,
      });
      expect(isClean(report)).toBe(false);
    } finally {
      errors.mockRestore();
    }
  });

  it('never lets a concurrent second approval of the same request disable the account the first committed', async () => {
    for (let round = 0; round < 6; round += 1) {
      const { registrationId, userId, username } = await submit();
      const outcomes = await Promise.allSettled([approve(registrationId), approve(registrationId)]);

      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
      const [account] = accountOf(username);
      expect(accountOf(username)).toHaveLength(1);
      expect(account).toMatchObject({ enabled: true });
      expect(await state(registrationId, userId)).toEqual({
        request: 'APPROVED',
        user: { status: 'ACTIVE', keycloakId: account!.id },
        approvedEvents: 1,
      });
    }
  });
});
