import { withDatabasePool, withStatementTimeout } from '@rasta/config';
import { RastaError, runUnscoped } from '@rasta/nest-common';
import { ulid } from 'ulid';
import { IdentityRepository } from '../src/identity/identity.repository';
import { IdentityService } from '../src/identity/identity.service';
import type { KeycloakAdminClient, KeycloakWriteContext } from '../src/keycloak/keycloak.client';
import type { KeycloakWriteOperation } from '../src/keycloak/keycloak-write-fence';
import { KeycloakProjector } from '../src/keycloak/keycloak.projector';
import { KEYCLOAK_PROJECTION_OUTCOMES } from '../src/observability/keycloak-projection.metrics';
import {
  provenanceOnly,
  readPlatformAttributes,
  type PlatformAttributes,
} from '../src/keycloak/platform-attributes';
import { PrismaService, type ExtendedPrismaClient } from '../src/prisma/prisma.service';
import { asActor, databaseUrl, newFences, newPrisma, tenants } from './helpers';

/**
 * The Keycloak projection and registration approval keep waiting on each
 * other's locks past the connection's statement timeout (#268 round 3).
 *
 * A runtime connection may carry a statement timeout: `DATABASE_STATEMENT_TIMEOUT_MS`
 * when it is set (`loadEnv` then holds it above these transactions' 65 s), or,
 * behind PgBouncer, the runtime role's own default, which nothing in the
 * service can check (#268 r4). These transactions hold a lock across Keycloak
 * calls of up to 10 s each, inside a 65 s transaction timeout, so a second one
 * for the same user or request may legitimately wait that long: they set their
 * own `statement_timeout` with `SET LOCAL`, for that transaction only.
 *
 * Scaled down to be fast: the service's connection here carries a 1 s
 * statement timeout and the lock is held for 2.5 s. The control proves a plain
 * transaction on that connection is cancelled by the same hold.
 */

const CONNECTION_STATEMENT_TIMEOUT_MS = 1000;
const HOLD_MS = 2500;

interface FakeAccount {
  id: string;
  username: string;
  enabled: boolean;
  attributes: PlatformAttributes;
  activation: string | null;
}

/** Just enough of Keycloak for an approval and its projection, all answering at once. */
class FakeKeycloak {
  readonly enabled = true;
  readonly accounts = new Map<string, FakeAccount>();

  /** As the real client: always disabled, its provenance alone (D-069 addendum D). */
  async createUser(input: { username: string; userId: string }) {
    if ([...this.accounts.values()].some((account) => account.username === input.username)) {
      throw RastaError.alreadyExists('User');
    }
    const id = `kc-${ulid()}`;
    this.accounts.set(id, {
      id,
      username: input.username,
      enabled: false,
      attributes: provenanceOnly(input.userId),
      activation: null,
    });
    return id;
  }

  get requestTimeoutMs(): number {
    return 10_000;
  }

  /** The fence before every PUT, as the real client opens it (D-069): on its own pool. */
  private async dispatch(context: KeycloakWriteContext, operation: KeycloakWriteOperation) {
    (await context.fence(operation)).assertDispatchable();
  }

  async findAccountByUsername(username: string) {
    const found = [...this.accounts.values()].find((account) => account.username === username);
    return found ? this.view(found) : null;
  }

  async getAccount(accountId: string) {
    return this.view(this.account(accountId));
  }

  async activateAccount(accountId: string, registrationId: string, context: KeycloakWriteContext) {
    const found = this.account(accountId);
    await this.dispatch(context, 'activate');
    found.enabled = true;
    found.activation = registrationId;
  }

  async replacePlatformAttributes(
    accountId: string,
    attributes: PlatformAttributes,
    context: KeycloakWriteContext,
  ) {
    const found = this.account(accountId);
    await this.dispatch(context, 'replace_attributes');
    found.attributes = attributes;
  }

  async disable(accountId: string, context: KeycloakWriteContext) {
    const found = this.account(accountId);
    await this.dispatch(context, 'disable');
    found.enabled = false;
  }

  private account(accountId: string): FakeAccount {
    const found = this.accounts.get(accountId);
    if (!found) throw RastaError.notFound('KeycloakUser', accountId);
    return found;
  }

  private view(found: FakeAccount) {
    return {
      id: found.id,
      enabled: found.enabled,
      attributes: readPlatformAttributes(found.attributes),
      activation: found.activation,
    };
  }
}

describe('Keycloak projection and approval transactions outlast the connection statement timeout', () => {
  const org = tenants();
  /** The service's connection: one pooled connection, with a 1 s statement timeout. */
  let prisma: PrismaService;
  /** Another session, holding the locks. */
  let holder: PrismaService;
  let repository: IdentityRepository;
  let holderRepository: IdentityRepository;
  let keycloak: FakeKeycloak;
  let projector: KeycloakProjector;
  let service: IdentityService;
  const users: string[] = [];
  let fencing: Awaited<ReturnType<typeof newFences>>;

  beforeAll(async () => {
    prisma = new PrismaService(
      withStatementTimeout(
        withDatabasePool(databaseUrl(), { size: 1 }),
        CONNECTION_STATEMENT_TIMEOUT_MS,
      ),
    );
    holder = newPrisma();
    await prisma.onModuleInit();
    await holder.onModuleInit();
    repository = new IdentityRepository(prisma);
    holderRepository = new IdentityRepository(holder);
    // The business pool here is ONE connection: a fence on that same pool
    // would wait for the connection its own transaction holds (D-069 B).
    fencing = await newFences();
  });

  beforeEach(() => {
    keycloak = new FakeKeycloak();
    const client = keycloak as unknown as KeycloakAdminClient;
    projector = new KeycloakProjector(repository, client, fencing.fences);
    service = new IdentityService(repository, client, projector);
  });

  afterAll(async () => {
    await runUnscoped('the suite removes its own fixtures', async () => {
      await holder.client.outboxMessage.deleteMany({
        where: { organizationId: { in: [org.a, org.b] } },
      });
      await holder.client.membership.deleteMany({ where: { userId: { in: users } } });
      await holder.client.registrationRequest.deleteMany({ where: { userId: { in: users } } });
      await holder.client.user.deleteMany({ where: { id: { in: users } } });
    });
    await fencing.pool.onModuleDestroy();
    await prisma.onModuleDestroy();
    await holder.onModuleDestroy();
  });

  async function submit(): Promise<{ registrationId: string; userId: string; username: string }> {
    const username = `stmt-${ulid().slice(-12)}`.toLowerCase();
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

  /**
   * Takes a lock in the holder's session and keeps it for {@link HOLD_MS};
   * `taken` resolves once it is held.
   */
  function hold(lock: (tx: ExtendedPrismaClient) => Promise<unknown>) {
    let acquired!: () => void;
    const taken = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const released = holderRepository.transaction(
      async (tx) => {
        await lock(tx);
        acquired();
        await new Promise((resolve) => setTimeout(resolve, HOLD_MS));
      },
      { timeout: HOLD_MS + 10_000 },
    );
    return { taken, released };
  }

  /** `fn`'s result and how long it took. */
  async function timed<T>(fn: () => Promise<T>): Promise<{ result: T; ms: number }> {
    const started = Date.now();
    const result = await fn();
    return { result, ms: Date.now() - started };
  }

  const showStatementTimeout = async () =>
    (await prisma.client.$queryRaw<{ statement_timeout: string }[]>`SHOW statement_timeout`)[0]
      ?.statement_timeout;

  it('control: on the same connection, a plain transaction waiting on the same hold is cancelled', async () => {
    const { registrationId, userId } = await submit();
    await approve(registrationId);
    expect(await showStatementTimeout()).toBe('1s');

    const { taken, released } = hold((tx) => holderRepository.lockUserMemberships(tx, userId));
    await taken;
    await expect(
      repository.transaction((tx) => repository.lockUserMemberships(tx, userId), {
        timeout: HOLD_MS + 10_000,
      }),
    ).rejects.toThrow(/statement timeout/);
    await released;
  });

  it('a projection waits on the user lock longer than the connection allows, and projects', async () => {
    const { registrationId, userId, username } = await submit();
    await approve(registrationId);

    const { taken, released } = hold((tx) => holderRepository.lockUserMemberships(tx, userId));
    await taken;
    const { result, ms } = await timed(() => projector.project(userId, 'event'));
    await released;

    expect(result).toBe(KEYCLOAK_PROJECTION_OUTCOMES.PROJECTED);
    expect(ms).toBeGreaterThan(HOLD_MS - 500);
    expect([...keycloak.accounts.values()]).toEqual([
      expect.objectContaining({ username, enabled: true }),
    ]);
  });

  it('an approval waits on the request lock longer than the connection allows, and approves', async () => {
    const { registrationId, userId } = await submit();

    const { taken, released } = hold((tx) =>
      holderRepository.lockRegistrationRequest(tx, registrationId),
    );
    await taken;
    const { result, ms } = await timed(() => approve(registrationId));
    await released;

    expect(result).toMatchObject({ id: registrationId, status: 'APPROVED' });
    expect(ms).toBeGreaterThan(HOLD_MS - 500);
    const user = await runUnscoped('the suite reads the approved user', () =>
      prisma.client.user.findUniqueOrThrow({ where: { id: userId } }),
    );
    expect(user).toMatchObject({ status: 'ACTIVE', accountActivationPending: false });
  });

  it('an orphan repair waits on the request locks longer than the connection allows, and decides', async () => {
    const { userId, username } = await submit();

    const { taken, released } = hold((tx) =>
      holderRepository.lockRegistrationRequestsOfUser(tx, userId),
    );
    await taken;
    const { result, ms } = await timed(() => projector.repairOrphan(userId, username));
    await released;

    // No account under the username: nothing of ours to repair.
    expect(result).toBe('not_ours');
    expect(ms).toBeGreaterThan(HOLD_MS - 500);
  });

  it('the longer timeout ends with each transaction: the pooled connection is back to its own', async () => {
    const { registrationId, userId } = await submit();
    await approve(registrationId);
    await projector.project(userId, 'event');
    await projector.repairOrphan(userId, 'nobody');

    expect(await showStatementTimeout()).toBe('1s');
  });
});
