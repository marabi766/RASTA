import { ERROR_CODES } from '@rasta/contracts';
import { RastaError, runUnscoped } from '@rasta/nest-common';
import { ulid } from 'ulid';
import { IdentityRepository } from '../src/identity/identity.repository';
import { IdentityService, REGISTRATION_APPROVAL_CODES } from '../src/identity/identity.service';
import { IDENTITY_EVENTS } from '../src/identity/events';
import {
  KeycloakCreateUnconfirmedError,
  type KeycloakAdminClient,
} from '../src/keycloak/keycloak.client';
import { KeycloakProjector } from '../src/keycloak/keycloak.projector';
import {
  readPlatformAttributes,
  type PlatformAttributes,
} from '../src/keycloak/platform-attributes';
import { runProjectionCommand } from '../src/keycloak/projection.command';
import type { PrismaService } from '../src/prisma/prisma.service';
import { asActor, id, newPrisma, tenants } from './helpers';

/**
 * Registration decisions against a real database, and the Keycloak account an
 * approval creates (#219 r1 and r2, Codex).
 *
 * The design these prove (r2): approve, reject and the orphan repair decide
 * under the registration request's row lock, on the status read under it; the
 * approval's account is created **disabled, granting nothing** but its
 * provenance (`rasta_user_id`), and only the projector — after the approval
 * committed, once, through `account_activation_pending` — writes its grants
 * and enables it. So no race, lost response or rolled-back transaction can
 * leave an enabled account with roles behind a request that is not approved.
 *
 * Keycloak is a stateful stand-in, so each interleaving is made to happen
 * exactly, rather than hoped for: what is proven is what the service asks of
 * Keycloak and in what order, against rows a real PostgreSQL commits, refuses
 * or makes wait.
 */

interface FakeAccount {
  id: string;
  username: string;
  enabled: boolean;
  attributes: PlatformAttributes;
  /** `rasta_activation`: the registration whose approval enabled it (#219 r3). */
  activation?: string | null;
}

type Step = 'create' | 'lookup' | 'write' | 'activate';

class FakeKeycloak {
  readonly enabled = true;
  readonly accounts = new Map<string, FakeAccount>();
  /** Runs after an account is created and before `createUser` answers. */
  afterCreate: (() => Promise<void>) | null = null;
  /** Keycloak commits the create, and its answer never arrives. */
  dropCreateResponse = false;
  /**
   * Keycloak answers the create with success but no usable id (#219 r3):
   * `'made'` when it did make the account, `'not_made'` when it did not.
   */
  createWithoutId: 'made' | 'not_made' | null = null;
  /** Keycloak applies the activation, and its answer never arrives (#219 r3). */
  dropActivateResponse = false;
  /** Runs when the projector reads the account before activating it. */
  beforeActivate: (() => Promise<void>) | null = null;
  /** Steps that fail as an unreachable Keycloak would. */
  readonly unreachable = new Set<Step>();
  /** Every write after a create, in order: what the service asked of Keycloak. */
  readonly writes: string[] = [];

  async createUser(input: {
    username: string;
    attributes: PlatformAttributes;
    enabled: boolean;
  }): Promise<string> {
    this.fail('create');
    await new Promise((resolve) => setImmediate(resolve));
    if (this.createWithoutId === 'not_made') {
      this.createWithoutId = null;
      throw new KeycloakCreateUnconfirmedError();
    }
    if ([...this.accounts.values()].some((account) => account.username === input.username)) {
      throw RastaError.alreadyExists('User');
    }
    const accountId = `kc-${ulid()}`;
    this.accounts.set(accountId, {
      id: accountId,
      username: input.username,
      enabled: input.enabled,
      attributes: input.attributes,
      activation: null,
    });
    if (this.createWithoutId === 'made') {
      this.createWithoutId = null;
      throw new KeycloakCreateUnconfirmedError();
    }
    if (this.dropCreateResponse) {
      this.dropCreateResponse = false;
      throw RastaError.upstreamUnavailable('keycloak', { operation: 'createUser' });
    }
    await this.afterCreate?.();
    return accountId;
  }

  async findAccountByUsername(username: string) {
    this.fail('lookup');
    const found = [...this.accounts.values()].find((account) => account.username === username);
    return found ? this.view(found) : null;
  }

  async getAccount(accountId: string) {
    this.fail('lookup');
    const found = this.accounts.get(accountId);
    if (!found) throw RastaError.notFound('KeycloakUser', accountId);
    await this.beforeActivate?.();
    return this.view(found);
  }

  /** `enabled: true` and the marker, applied together as one representation update. */
  async activateAccount(accountId: string, registrationId: string) {
    this.fail('activate');
    const found = this.accounts.get(accountId);
    if (!found) throw RastaError.notFound('KeycloakUser', accountId);
    found.enabled = true;
    found.activation = registrationId;
    this.writes.push(`activate:${accountId}`);
    if (this.dropActivateResponse) {
      this.dropActivateResponse = false;
      throw RastaError.upstreamUnavailable('keycloak', { operation: 'activateAccount' });
    }
  }

  private view(found: FakeAccount) {
    return {
      id: found.id,
      enabled: found.enabled,
      attributes: readPlatformAttributes(found.attributes),
      activation: found.activation ?? null,
    };
  }

  async getPlatformAttributes(accountId: string): Promise<PlatformAttributes> {
    this.fail('lookup');
    const found = this.accounts.get(accountId);
    if (!found) throw RastaError.notFound('KeycloakUser', accountId);
    return readPlatformAttributes(found.attributes);
  }

  async replacePlatformAttributes(accountId: string, attributes: PlatformAttributes) {
    this.fail('write');
    const found = this.accounts.get(accountId);
    if (!found) throw RastaError.notFound('KeycloakUser', accountId);
    found.attributes = attributes;
    this.writes.push(`attributes:${accountId}`);
  }

  async setEnabled(accountId: string | null, enabled: boolean) {
    this.fail('write');
    const found = this.accounts.get(accountId!);
    if (!found) throw RastaError.notFound('KeycloakUser', accountId ?? '');
    found.enabled = enabled;
    this.writes.push(`${enabled ? 'enable' : 'disable'}:${accountId}`);
  }

  private fail(step: Step): void {
    if (this.unreachable.has(step)) {
      throw RastaError.upstreamUnavailable('keycloak', { operation: step });
    }
  }
}

const NO_GRANTS = { organization_ids: [], organization_roles: [], active_organization_id: [] };

describe('registration decisions and the Keycloak account an approval creates', () => {
  const org = tenants();
  let prisma: PrismaService;
  let repository: IdentityRepository;
  let keycloak: FakeKeycloak;
  let projector: KeycloakProjector;
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
    projector = new KeycloakProjector(repository, client);
    service = new IdentityService(repository, client, projector);
  });

  afterEach(() => {
    jest.restoreAllMocks();
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

  const reviewer = <T>(fn: () => Promise<T>) =>
    asActor({ organizationId: org.a, roles: ['SYSTEM_ADMIN'] }, fn);
  const approve = (registrationId: string) =>
    reviewer(() => service.approveRegistration(registrationId, {}));
  const reject = (registrationId: string) =>
    reviewer(() => service.rejectRegistration(registrationId, { reason: 'مدارک ناقص است' }));

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

  const events = async (eventName: string, aggregateId: string) =>
    (
      await runUnscoped('the suite reads the outbox', () =>
        prisma.client.outboxMessage.findMany({ where: { eventName, aggregateId } }),
      )
    ).length;

  const state = (registrationId: string, userId: string) =>
    runUnscoped('the suite reads what the decision left', async () => ({
      request: (
        await prisma.client.registrationRequest.findUniqueOrThrow({
          where: { id: registrationId },
        })
      ).status,
      user: await prisma.client.user.findUniqueOrThrow({
        where: { id: userId },
        select: { status: true, keycloakId: true, accountActivationPending: true },
      }),
      approved: await events(IDENTITY_EVENTS.REGISTRATION_APPROVED, registrationId),
      rejected: await events(IDENTITY_EVENTS.REGISTRATION_REJECTED, registrationId),
      activated: await events(IDENTITY_EVENTS.USER_ACTIVATED, userId),
    }));

  const accountsOf = (username: string) =>
    [...keycloak.accounts.values()].filter((account) => account.username === username);

  /** The one account under the username, disabled and granting nothing but its provenance. */
  const expectHarmless = (username: string, userId: string) =>
    expect(accountsOf(username)).toEqual([
      expect.objectContaining({
        enabled: false,
        attributes: { rasta_user_id: [userId], ...NO_GRANTS },
      }),
    ]);

  /** The one account under the username, enabled with this approval's grants. */
  const expectActivated = (username: string, userId: string) =>
    expect(accountsOf(username)).toEqual([
      expect.objectContaining({
        enabled: true,
        attributes: {
          rasta_user_id: [userId],
          organization_ids: [org.a],
          organization_roles: [`${org.a}:FLEET_MANAGER`],
          active_organization_id: [org.a],
        },
      }),
    ]);

  const APPROVED_STATE = (keycloakId: string) => ({
    request: 'APPROVED',
    user: { status: 'ACTIVE', keycloakId, accountActivationPending: false },
    approved: 1,
    rejected: 0,
    activated: 1,
  });

  describe('the account is harmless until the database decides', () => {
    it('is created disabled, with its provenance only, and enabled with its grants after commit', async () => {
      const { registrationId, userId, username } = await submit();
      let atCreate: FakeAccount | undefined;
      keycloak.afterCreate = async () => {
        atCreate = structuredClone(accountsOf(username)[0]);
      };

      await approve(registrationId);

      expect(atCreate).toMatchObject({
        enabled: false,
        attributes: { rasta_user_id: [userId], ...NO_GRANTS },
      });
      const [account] = accountsOf(username);
      // The grants first, then enabled: the first token is already right.
      expect(keycloak.writes).toEqual([`attributes:${account!.id}`, `activate:${account!.id}`]);
      expectActivated(username, userId);
      expect(await state(registrationId, userId)).toEqual(APPROVED_STATE(account!.id));
    });

    it('a membership conflict answers 409 MEMBERSHIP_ALREADY_LIVE, keeps the request pending, and never touches the account again', async () => {
      const { registrationId, userId, username } = await submit();
      keycloak.afterCreate = () => grantMembership(userId).then(() => undefined);

      await expect(approve(registrationId)).rejects.toMatchObject({
        code: ERROR_CODES.ALREADY_EXISTS,
        details: [
          expect.objectContaining({ code: REGISTRATION_APPROVAL_CODES.MEMBERSHIP_ALREADY_LIVE }),
        ],
      });
      expect(await state(registrationId, userId)).toMatchObject({
        request: 'PENDING',
        user: { status: 'PENDING', keycloakId: null, accountActivationPending: false },
        approved: 0,
        activated: 0,
      });
      expectHarmless(username, userId);
      expect(keycloak.writes).toEqual([]);
    });

    it('a retry adopts the same account while the conflict stands, refuses cleanly, and approves once it is resolved', async () => {
      const { registrationId, userId, username } = await submit();
      let membershipId = '';
      keycloak.afterCreate = async () => {
        membershipId = (await grantMembership(userId)).id;
      };
      await expect(approve(registrationId)).rejects.toMatchObject({
        code: ERROR_CODES.ALREADY_EXISTS,
      });
      keycloak.afterCreate = null;

      await expect(approve(registrationId)).rejects.toMatchObject({
        details: [
          expect.objectContaining({ code: REGISTRATION_APPROVAL_CODES.MEMBERSHIP_ALREADY_LIVE }),
        ],
      });
      expectHarmless(username, userId);

      await runUnscoped('the reviewer resolves it: the conflicting membership is revoked', () =>
        prisma.client.membership.update({
          where: { id: membershipId },
          data: { deletedAt: new Date(), status: 'REVOKED' },
        }),
      );
      await approve(registrationId);

      expectActivated(username, userId);
      expect(await state(registrationId, userId)).toEqual(
        APPROVED_STATE(accountsOf(username)[0]!.id),
      );
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
      expect(keycloak.writes).toEqual([]);
      expect(await state(registrationId, userId)).toMatchObject({ request: 'PENDING' });
    });
  });

  describe('reject and approve, decided one after the other on the request lock (HIGH 1)', () => {
    it('a rejection that commits between the approval’s read and its write wins; the approval is refused and writes nothing', async () => {
      const { registrationId, userId, username } = await submit();
      // The approval has read PENDING and created its account; the rejection
      // runs to completion before the approval's transaction begins.
      keycloak.afterCreate = () => reject(registrationId).then(() => undefined);

      await expect(approve(registrationId)).rejects.toMatchObject({
        code: ERROR_CODES.INVALID_STATE_TRANSITION,
      });
      expect(await state(registrationId, userId)).toEqual({
        request: 'REJECTED',
        user: { status: 'PENDING', keycloakId: null, accountActivationPending: false },
        approved: 0,
        rejected: 1,
        activated: 0,
      });
      expectHarmless(username, userId);
    });

    it('an approval that commits between the rejection’s read and its write wins; the rejection is refused and emits nothing', async () => {
      const { registrationId, userId, username } = await submit();
      // The rejection has read PENDING; the approval runs to completion before
      // the rejection's transaction begins.
      const transaction = repository.transaction.bind(repository);
      jest.spyOn(repository, 'transaction').mockImplementationOnce(async (fn, options) => {
        await approve(registrationId);
        return transaction(fn, options);
      });

      await expect(reject(registrationId)).rejects.toMatchObject({
        code: ERROR_CODES.INVALID_STATE_TRANSITION,
      });
      expect(await state(registrationId, userId)).toEqual(
        APPROVED_STATE(accountsOf(username)[0]!.id),
      );
      expectActivated(username, userId);
    });

    it('two concurrent decisions on one request: exactly one wins, and the other neither overwrites nor emits', async () => {
      for (let round = 0; round < 6; round += 1) {
        const { registrationId, userId, username } = await submit();
        const [approval, rejection] = await Promise.allSettled([
          approve(registrationId),
          reject(registrationId),
        ]);
        const decided = await state(registrationId, userId);
        if (approval.status === 'fulfilled') {
          expect(rejection.status).toBe('rejected');
          expect(decided).toEqual(APPROVED_STATE(accountsOf(username)[0]!.id));
        } else {
          expect(rejection.status).toBe('fulfilled');
          expect(decided).toMatchObject({ request: 'REJECTED', approved: 0, rejected: 1 });
          expect(decided.user).toMatchObject({ status: 'PENDING', keycloakId: null });
        }
      }
    });
  });

  describe('a failed approval never touches an account a concurrent approval adopted (HIGH 2)', () => {
    it('A fails after B adopted A’s account and committed: the account stays enabled with B’s grants', async () => {
      const { registrationId, userId, username } = await submit();
      // A created the account; B adopts it and commits before A's
      // transaction; A then finds the request decided.
      keycloak.afterCreate = async () => {
        keycloak.afterCreate = null;
        await approve(registrationId);
      };

      await expect(approve(registrationId)).rejects.toMatchObject({
        code: ERROR_CODES.INVALID_STATE_TRANSITION,
      });
      expectActivated(username, userId);
      expect(await state(registrationId, userId)).toEqual(
        APPROVED_STATE(accountsOf(username)[0]!.id),
      );
    });

    it('A’s transaction fails for its own reason after B committed: nothing is disabled or cleared', async () => {
      const { registrationId, userId, username } = await submit();
      // A's transaction is the first one; B runs inside it, then A fails.
      jest.spyOn(repository, 'transaction').mockImplementationOnce(async () => {
        await approve(registrationId);
        throw new Error('the database went away under A');
      });

      await expect(approve(registrationId)).rejects.toThrow('the database went away under A');
      expectActivated(username, userId);
      expect(keycloak.writes.filter((write) => write.startsWith('disable'))).toEqual([]);
      expect(await state(registrationId, userId)).toEqual(
        APPROVED_STATE(accountsOf(username)[0]!.id),
      );
    });
  });

  describe('a create whose answer is lost (HIGH 3)', () => {
    it('leaves a disabled account with nothing granted, and the retry adopts it', async () => {
      const { registrationId, userId, username } = await submit();
      keycloak.dropCreateResponse = true;

      await expect(approve(registrationId)).rejects.toMatchObject({
        code: ERROR_CODES.UPSTREAM_UNAVAILABLE,
      });
      expectHarmless(username, userId);
      expect(await state(registrationId, userId)).toMatchObject({
        request: 'PENDING',
        user: { keycloakId: null },
      });

      await approve(registrationId);
      expectActivated(username, userId);
      expect(await state(registrationId, userId)).toEqual(
        APPROVED_STATE(accountsOf(username)[0]!.id),
      );
    });
  });

  describe('Keycloak unreachable at each step', () => {
    it('at the create: nothing is written anywhere, and a retry approves', async () => {
      const { registrationId, userId, username } = await submit();
      keycloak.unreachable.add('create');
      await expect(approve(registrationId)).rejects.toMatchObject({
        code: ERROR_CODES.UPSTREAM_UNAVAILABLE,
      });
      expect(accountsOf(username)).toEqual([]);
      expect(await state(registrationId, userId)).toMatchObject({ request: 'PENDING' });

      keycloak.unreachable.clear();
      await approve(registrationId);
      expectActivated(username, userId);
    });

    it('at the lookup after a 409: nothing is written, the account stays harmless', async () => {
      const { registrationId, userId, username } = await submit();
      keycloak.dropCreateResponse = true;
      await expect(approve(registrationId)).rejects.toBeDefined();
      keycloak.unreachable.add('lookup');

      await expect(approve(registrationId)).rejects.toMatchObject({
        code: ERROR_CODES.UPSTREAM_UNAVAILABLE,
      });
      expectHarmless(username, userId);
      expect(await state(registrationId, userId)).toMatchObject({ request: 'PENDING' });
    });

    it('after the commit: the approval stands, the account stays disabled, reconcile reports it, backfill enables it', async () => {
      const { registrationId, userId, username } = await submit();
      keycloak.afterCreate = async () => {
        keycloak.unreachable.add('write');
      };

      await approve(registrationId);
      const [account] = accountsOf(username);
      expect(await state(registrationId, userId)).toEqual({
        ...APPROVED_STATE(account!.id),
        user: { status: 'ACTIVE', keycloakId: account!.id, accountActivationPending: true },
      });
      expectHarmless(username, userId);

      keycloak.unreachable.clear();
      const reconciled = await runProjectionCommand('reconcile', {
        repository,
        projector,
        keycloak,
      });
      expect(reconciled.activationPending).toContain(userId);

      const backfilled = await runProjectionCommand('backfill', {
        repository,
        projector,
        keycloak,
      });
      expect(backfilled.failed).not.toContain(userId);
      expectActivated(username, userId);
      expect(await state(registrationId, userId)).toEqual(APPROVED_STATE(account!.id));

      const again = await runProjectionCommand('reconcile', { repository, projector, keycloak });
      expect(again.activationPending).not.toContain(userId);
    });

    it('enables once: a replayed event after an administrator disabled the account leaves it disabled', async () => {
      const { registrationId, userId, username } = await submit();
      await approve(registrationId);
      const [account] = accountsOf(username);
      account!.enabled = false; // an administrator, in the Keycloak console

      await projector.project(userId, 'event');
      expect(accountsOf(username)[0]).toMatchObject({ enabled: false });
    });
  });

  describe('recovery: the orphan sweep and repair', () => {
    /** An enabled orphan with grants, as nothing in this design creates but the code before it could. */
    const plantOrphan = (username: string, userId: string) => {
      keycloak.accounts.set(`kc-orphan-${userId}`, {
        id: `kc-orphan-${userId}`,
        username,
        enabled: true,
        attributes: {
          rasta_user_id: [userId],
          organization_ids: [org.a],
          organization_roles: [`${org.a}:FLEET_MANAGER`],
          active_organization_id: [org.a],
        },
      });
    };

    it('reconcile reports an enabled orphan; backfill disables it and clears its grants — kept, not deleted', async () => {
      const { registrationId, userId, username } = await submit();
      plantOrphan(username, userId);

      const reconciled = await runProjectionCommand('reconcile', {
        repository,
        projector,
        keycloak,
      });
      expect(reconciled.orphans).toContainEqual(
        expect.objectContaining({ userId, enabled: true, grants: true, repaired: false }),
      );

      const backfilled = await runProjectionCommand('backfill', {
        repository,
        projector,
        keycloak,
      });
      expect(backfilled.orphans).toContainEqual(
        expect.objectContaining({ userId, repaired: true }),
      );
      expectHarmless(username, userId);

      // Kept for the request: its approval adopts the repaired account.
      await approve(registrationId);
      expectActivated(username, userId);
    });

    it('repairs an orphan of a rejected request too', async () => {
      const { registrationId, userId, username } = await submit();
      await reject(registrationId);
      plantOrphan(username, userId);

      await runProjectionCommand('backfill', { repository, projector, keycloak });
      expectHarmless(username, userId);
    });

    it('finds the account owned once the approval committed, and leaves it alone', async () => {
      const { registrationId, userId, username } = await submit();
      await approve(registrationId);
      await expect(projector.repairOrphan(userId, username)).resolves.toBe('owned');
      expectActivated(username, userId);
    });

    it('waits on the request lock: an approval holding it commits first, and the repair then finds it owned', async () => {
      const { registrationId, userId, username } = await submit();
      let repair: Promise<string> | undefined;
      // The approval is inside its transaction, holding the request lock,
      // when the repair starts; the repair can only decide after it commits.
      const transaction = repository.transaction.bind(repository);
      jest.spyOn(repository, 'transaction').mockImplementationOnce(async (fn, options) =>
        transaction(async (tx) => {
          const result = await fn(tx);
          repair = projector.repairOrphan(userId, username);
          await new Promise((resolve) => setTimeout(resolve, 200));
          return result;
        }, options),
      );

      await approve(registrationId);
      await expect(repair).resolves.toBe('owned');
      expectActivated(username, userId);
    });

    it('reports a user it could not repair as failed when Keycloak is unreachable', async () => {
      const { userId, username } = await submit();
      plantOrphan(username, userId);
      keycloak.unreachable.add('write');

      const backfilled = await runProjectionCommand('backfill', {
        repository,
        projector,
        keycloak,
      });
      expect(backfilled.failed).toContain(userId);
      expect(accountsOf(username)[0]).toMatchObject({ enabled: true });
    });
  });

  describe('round 3: one-shot activation, harmless adoption, and an unconfirmed create', () => {
    const reconcile = () => runProjectionCommand('reconcile', { repository, projector, keycloak });
    const backfill = () => runProjectionCommand('backfill', { repository, projector, keycloak });

    it('HIGH 1: an activation whose answer was lost is never repeated — an account an administrator disabled since stays disabled', async () => {
      const { registrationId, userId, username } = await submit();
      // The enable lands in Keycloak; its answer does not reach the projector,
      // so the flag stays set.
      keycloak.dropActivateResponse = true;

      await approve(registrationId);
      const [account] = accountsOf(username);
      expect(account).toMatchObject({ enabled: true, activation: registrationId });
      expect(await state(registrationId, userId)).toMatchObject({
        user: { accountActivationPending: true },
      });

      account!.enabled = false; // an administrator, in the Keycloak console

      // Every retry path: an event, then the backfill.
      await projector.project(userId, 'event');
      expect(accountsOf(username)[0]).toMatchObject({ enabled: false });
      await backfill();
      expect(accountsOf(username)[0]).toMatchObject({ enabled: false });
      expect(keycloak.writes.filter((write) => write.startsWith('activate'))).toHaveLength(1);
      // The marker proved the activation: the flag is cleared, reconcile is clean.
      expect(await state(registrationId, userId)).toMatchObject({
        user: { accountActivationPending: false },
      });
      expect((await reconcile()).activationPending).not.toContain(userId);
    });

    it('HIGH 2: an enabled, granted account of this request is repaired before it is adopted — and stays harmless when the approval then loses', async () => {
      const { registrationId, userId, username } = await submit();
      // What a failed compensation of an earlier version left behind.
      keycloak.accounts.set(`kc-legacy-${userId}`, {
        id: `kc-legacy-${userId}`,
        username,
        enabled: true,
        attributes: {
          rasta_user_id: [userId],
          organization_ids: [org.a],
          organization_roles: [`${org.a}:FLEET_MANAGER`],
          active_organization_id: [org.a],
        },
      });
      // The approval then loses to a membership conflict.
      await grantMembership(userId);

      await expect(approve(registrationId)).rejects.toMatchObject({
        details: [
          expect.objectContaining({ code: REGISTRATION_APPROVAL_CODES.MEMBERSHIP_ALREADY_LIVE }),
        ],
      });
      expect(keycloak.writes).toEqual([
        `disable:kc-legacy-${userId}`,
        `attributes:kc-legacy-${userId}`,
      ]);
      expectHarmless(username, userId);
      expect(await state(registrationId, userId)).toMatchObject({
        request: 'PENDING',
        user: { status: 'PENDING', keycloakId: null },
      });
    });

    it('HIGH 2: when that repair does not land, the approval fails closed and nothing commits', async () => {
      const { registrationId, userId, username } = await submit();
      keycloak.accounts.set(`kc-legacy-${userId}`, {
        id: `kc-legacy-${userId}`,
        username,
        enabled: true,
        attributes: { rasta_user_id: [userId], ...NO_GRANTS },
      });
      keycloak.unreachable.add('write');

      await expect(approve(registrationId)).rejects.toMatchObject({
        code: ERROR_CODES.UPSTREAM_UNAVAILABLE,
      });
      expect(await state(registrationId, userId)).toMatchObject({
        request: 'PENDING',
        user: { status: 'PENDING', keycloakId: null, accountActivationPending: false },
        approved: 0,
        activated: 0,
      });

      keycloak.unreachable.clear();
      await approve(registrationId);
      expectActivated(username, userId);
    });

    it('MED 3: a membership revoked before the projection recovers withholds the first enable, clears nothing, and is reported', async () => {
      const { registrationId, userId, username } = await submit();
      keycloak.afterCreate = async () => {
        keycloak.unreachable.add('write');
      };
      await approve(registrationId);
      keycloak.unreachable.clear();

      const membership = await runUnscoped('the suite finds the approval membership', () =>
        prisma.client.membership.findFirstOrThrow({ where: { userId, deletedAt: null } }),
      );
      await runUnscoped('the membership is revoked before the projection recovers', () =>
        prisma.client.membership.update({
          where: { id: membership.id },
          data: { deletedAt: new Date(), status: 'REVOKED' },
        }),
      );

      await backfill();
      expect(accountsOf(username)[0]).toMatchObject({ enabled: false, activation: null });
      expect(await state(registrationId, userId)).toMatchObject({
        user: { accountActivationPending: true },
      });
      expect((await reconcile()).activationPending).toContain(userId);
    });

    it('MED 3: a revocation that starts during the first enable waits for it, and its own projection then clears the grants', async () => {
      const { registrationId, userId, username } = await submit();
      keycloak.afterCreate = async () => {
        keycloak.unreachable.add('write');
      };
      await approve(registrationId);
      keycloak.unreachable.clear();
      const membership = await runUnscoped('the suite finds the approval membership', () =>
        prisma.client.membership.findFirstOrThrow({ where: { userId, deletedAt: null } }),
      );

      let revocation: Promise<void> | undefined;
      let revoked = false;
      keycloak.beforeActivate = async () => {
        keycloak.beforeActivate = null;
        revocation = reviewer(() =>
          service.revokeMembership(membership.id, { reason: 'left the organization' }),
        ).then(() => {
          revoked = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 200));
        // Still waiting on the user row the activation holds: not committed.
        expect(revoked).toBe(false);
        const live = await runUnscoped('the suite reads the membership from outside', () =>
          prisma.client.membership.findUniqueOrThrow({ where: { id: membership.id } }),
        );
        expect(live.deletedAt).toBeNull();
      };

      await projector.project(userId, 'command');
      expect(accountsOf(username)[0]).toMatchObject({ enabled: true, activation: registrationId });
      await revocation;
      expect(revoked).toBe(true);
      // The revocation's own projection ran after it committed.
      expect(accountsOf(username)[0]!.attributes).toEqual({
        rasta_user_id: [userId],
        ...NO_GRANTS,
      });
    });

    it('MED 4: a create answered without an id, whose account exists, is resolved by lookup before the approval commits', async () => {
      const { registrationId, userId, username } = await submit();
      keycloak.createWithoutId = 'made';

      await approve(registrationId);
      const [account] = accountsOf(username);
      expectActivated(username, userId);
      expect(await state(registrationId, userId)).toEqual(APPROVED_STATE(account!.id));
    });

    it('MED 4: a create answered without an id, whose account cannot be found, commits nothing; the retry approves', async () => {
      const { registrationId, userId, username } = await submit();
      keycloak.createWithoutId = 'not_made';

      await expect(approve(registrationId)).rejects.toMatchObject({
        code: ERROR_CODES.UPSTREAM_UNAVAILABLE,
        details: [
          expect.objectContaining({ code: REGISTRATION_APPROVAL_CODES.ACCOUNT_NOT_CONFIRMED }),
        ],
      });
      expect(await state(registrationId, userId)).toMatchObject({
        request: 'PENDING',
        user: { status: 'PENDING', keycloakId: null, accountActivationPending: false },
        approved: 0,
      });
      expect(accountsOf(username)).toEqual([]);

      await approve(registrationId);
      expectActivated(username, userId);
    });
  });
});
