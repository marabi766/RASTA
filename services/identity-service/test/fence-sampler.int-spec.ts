import { runUnscoped } from '@rasta/nest-common';
import { IdentityRepository } from '../src/identity/identity.repository';
import type { IdentityService } from '../src/identity/identity.service';
import { MembershipExpiryScanner } from '../src/identity/membership-expiry.scanner';
import {
  FENCE_SAMPLE_BUDGET_MS,
  FENCE_SAMPLE_INTERVAL_MS,
  FENCE_SAMPLE_STALE_SECONDS,
  KeycloakFenceSampler,
  pooledFenceSampleSource,
} from '../src/keycloak/keycloak-fence-sampler';
import type { KeycloakProjector } from '../src/keycloak/keycloak.projector';
import { FENCE_POOL_CONNECTIONS } from '../src/keycloak/keycloak-write-fence';
import {
  keycloakFenceSampleAge,
  keycloakFenceSampleDuration,
  keycloakFenceSamplesTotal,
  keycloakWriteFences,
} from '../src/observability/keycloak-projection.metrics';
import { PrismaService } from '../src/prisma/prisma.service';
import { databaseUrl, id, newPrisma, tenants, waitFor } from './helpers';

/**
 * #402 r3 R3-2, against a real PostgreSQL: the fence sampler of production
 * (`pooledFenceSampleSource` on a pool of one, as `app.module.ts` builds it)
 * keeps sampling while the sweep is busy and both other pools are exhausted;
 * and when its own query cannot answer — a lock it waits on, its one
 * connection taken — each sample ends within its budget and the age the
 * stale alert reads keeps growing at every scrape.
 */

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('R3-2: the fence sampler on a real database', () => {
  let prisma: PrismaService;
  let other: PrismaService;
  let repository: IdentityRepository;
  let own: PrismaService;
  let sampler: KeycloakFenceSampler;
  const inserted: string[] = [];

  beforeAll(async () => {
    prisma = newPrisma();
    other = newPrisma();
    await prisma.onModuleInit();
    await other.onModuleInit();
    repository = new IdentityRepository(prisma);
  });

  beforeEach(async () => {
    own = new PrismaService(databaseUrl(), { connections: 1, waitSeconds: 1 });
    await own.onModuleInit();
    sampler = new KeycloakFenceSampler(pooledFenceSampleSource(own, repository));
  });

  afterEach(async () => {
    await sampler.stop();
    // Its pool closes after it, as OutboxShutdown closes it (#458 r2 F2).
    await own.stop();
    jest.restoreAllMocks();
    if (inserted.length > 0) {
      await prisma.client
        .$executeRaw`DELETE FROM keycloak_write_attempt WHERE attempt_id = ANY(${inserted})`;
      inserted.length = 0;
    }
  });

  afterAll(async () => {
    await other.stop();
    await prisma.stop();
  });

  /** A fence past its deadline plus half its settle window, not yet past takeover: overdue. */
  async function overdueFence(): Promise<string> {
    const attemptId = `KWA_${id('OVD')}`;
    inserted.push(attemptId);
    await prisma.client.$executeRaw`
      INSERT INTO keycloak_write_attempt
             (attempt_id, user_id, keycloak_id, operation,
              started_at, deadline_at, takeover_at, next_reassert_at)
      SELECT ${attemptId}, ${id('USR-SMP')}, 'kc-sampler', 'replace_attributes',
             c - interval '40 seconds', c - interval '30 seconds', c + interval '20 seconds', c + interval '20 seconds'
        FROM (SELECT clock_timestamp() AT TIME ZONE 'UTC' AS c) t`;
    return attemptId;
  }

  const gauge = async (state: string) =>
    (await keycloakWriteFences.get()).values.find((v) => v.labels.state === state)?.value;
  const age = async () => (await keycloakFenceSampleAge.get()).values[0]?.value;
  const samples = async (outcome: string) =>
    (await keycloakFenceSamplesTotal.get()).values.find((v) => v.labels.outcome === outcome)
      ?.value ?? 0;
  /** The slowest sample of `outcome` so far, as an upper bucket bound, seconds. */
  const slowest = async (outcome: string) => {
    const buckets = (await keycloakFenceSampleDuration.get()).values
      .filter((v) => v.labels.outcome === outcome && v.metricName?.endsWith('_bucket'))
      .map((v) => ({ value: v.value, labels: v.labels as { le?: string | number } }));
    const total = buckets.find((v) => v.labels.le === '+Inf')?.value ?? 0;
    const under = buckets
      .filter((v) => v.labels.le !== '+Inf' && v.value === total)
      .map((v) => Number(v.labels.le));
    return Math.min(...under);
  };

  /** Holds `count` connections of `pool` in transactions until released. */
  function exhaust(pool: PrismaService, count: number) {
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let ready = 0;
    let allIn!: () => void;
    const held = new Promise<void>((resolve) => (allIn = resolve));
    const done = Promise.all(
      Array.from({ length: count }, () =>
        pool.transaction(
          async (tx) => {
            await tx.$queryRaw`SELECT 1`;
            ready += 1;
            if (ready === count) allIn();
            await released;
          },
          { timeout: 60_000, maxWait: 10_000 },
        ),
      ),
    );
    return { held, release, done };
  }

  it('samples on its own timer and its own connection while the sweep is busy in a lapse (its overlap guard skipping ticks) and the fence pool’s connections are all taken', async () => {
    await overdueFence();

    // The sweep: busy in a lapse that does not end until the test says so.
    let finishLapse!: () => void;
    const lapseHeld = new Promise<void>((resolve) => (finishLapse = resolve));
    let inLapse!: () => void;
    const lapsing = new Promise<void>((resolve) => (inLapse = resolve));
    const org = tenants();
    const lapsedUser = id('USR-SMP');
    const membershipId = id('MBR-SMP');
    await runUnscoped('test fixture', async () => {
      await prisma.client.user.create({
        data: {
          id: lapsedUser,
          username: `smp-${lapsedUser.slice(-12)}`.toLowerCase(),
          email: `smp-${lapsedUser.slice(-12)}@example.test`.toLowerCase(),
          firstName: 'آزمون',
          lastName: 'نمونه',
          status: 'ACTIVE',
          activeOrganizationId: org.a,
          createdBy: 'ITEST',
          updatedBy: 'ITEST',
        },
      });
      await prisma.client.membership.create({
        data: {
          id: membershipId,
          userId: lapsedUser,
          organizationId: org.a,
          roles: ['OPERATOR'],
          validFrom: new Date(Date.now() - 3_600_000),
          validUntil: new Date(Date.now() - 1_000),
          createdBy: 'ITEST',
          updatedBy: 'ITEST',
        },
      });
    });
    const scopedRepository = Object.create(repository) as IdentityRepository;
    scopedRepository.findLapsedMemberships = async (at, take, after, until) =>
      (await repository.findLapsedMemberships(at, 1000, after, until))
        .filter((row) => row.userId === lapsedUser)
        .slice(0, take);
    const identity = {
      expireLapsedMembership: jest.fn(async () => {
        inLapse();
        await lapseHeld;
        return true;
      }),
    };
    const scanner = new MembershipExpiryScanner(
      scopedRepository,
      identity as unknown as IdentityService,
      { enabled: false, intervalSeconds: 60, batchSize: 50 },
      { project: jest.fn() } as unknown as Pick<KeycloakProjector, 'project'>,
      {
        dueUsers: async () => [],
        deferReassert: async () => undefined,
        recoverOwed: async () => 0,
      },
    );
    const pass = scanner.scan();
    await lapsing;
    // Its overlap guard: a tick now does nothing.
    await expect(scanner.scan()).resolves.toBe(0);

    // The fence pool's two connections, both taken.
    const fencePool = new PrismaService(databaseUrl(), { connections: FENCE_POOL_CONNECTIONS });
    await fencePool.onModuleInit();
    const fencesHeld = exhaust(fencePool, FENCE_POOL_CONNECTIONS);
    await fencesHeld.held;

    const ok = await samples('ok');
    sampler.start();
    await waitFor('two samples while the sweep is busy', async () =>
      (await samples('ok')) >= ok + 2 ? true : null,
    );
    expect(await gauge('overdue')).toBeGreaterThanOrEqual(1);
    expect(await age()).toBeLessThan(FENCE_SAMPLE_STALE_SECONDS);
    expect(identity.expireLapsedMembership).toHaveBeenCalledTimes(1);

    fencesHeld.release();
    await fencesHeld.done;
    await fencePool.stop();
    finishLapse();
    await pass;
    await scanner.stop();
  });

  it('a sample waiting on a lock fails within its budget; the age keeps growing at every scrape past the stale threshold, and stays reported for the retention window after recovery', async () => {
    await overdueFence();
    sampler.start();
    await waitFor('a first sample', async () =>
      (await gauge('live')) !== undefined ? true : null,
    );
    const failed = await samples('failed');

    // The database stalls for the sampler: an ACCESS EXCLUSIVE lock on the
    // table, as a down migration would take.
    let unlock!: () => void;
    const unlocked = new Promise<void>((resolve) => (unlock = resolve));
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => (locked = resolve));
    const holding = other.transaction(
      async (tx) => {
        await tx.$executeRawUnsafe('LOCK TABLE keycloak_write_attempt IN ACCESS EXCLUSIVE MODE');
        locked();
        await unlocked;
      },
      { timeout: 60_000, maxWait: 10_000 },
    );
    await isLocked;
    const lockedAt = Date.now();

    const ages: number[] = [];
    for (let scrape = 0; scrape < 4; scrape += 1) {
      await sleep(2_000);
      ages.push((await age())!);
    }
    // Computed at scrape: it never stops growing while no sample succeeds.
    for (let index = 1; index < ages.length; index += 1) {
      expect(ages[index]!).toBeGreaterThan(ages[index - 1]!);
    }
    expect(ages[ages.length - 1]!).toBeGreaterThan(FENCE_SAMPLE_STALE_SECONDS);
    expect(await samples('failed')).toBeGreaterThan(failed);
    // Each failed within its budget (the next bucket up from 1 s is 2 s).
    expect(await slowest('failed')).toBeLessThanOrEqual(2);
    expect(Date.now() - lockedAt).toBeGreaterThan(FENCE_SAMPLE_STALE_SECONDS * 1000);

    unlock();
    await holding;
    const okBefore = await samples('ok');
    await waitFor('a sample after the stall', async () =>
      (await samples('ok')) > okBefore ? true : null,
    );
    // Sampling recovered, but the gap stays reported (retention window), so a
    // stale period between two scrapes is still seen by the alert.
    expect(await age()).toBeGreaterThan(FENCE_SAMPLE_STALE_SECONDS);
    expect(await gauge('overdue')).toBeGreaterThanOrEqual(1);
  });

  it('its one connection taken: the wait for it is bounded too, and counted a failure', async () => {
    sampler.start();
    await waitFor('a first sample', async () =>
      (await gauge('live')) !== undefined ? true : null,
    );
    const failed = await samples('failed');
    const taken = exhaust(own, 1);
    await taken.held;
    await sleep(FENCE_SAMPLE_INTERVAL_MS * 2 + FENCE_SAMPLE_BUDGET_MS);
    expect(await samples('failed')).toBeGreaterThan(failed);
    expect(await slowest('failed')).toBeLessThanOrEqual(2);
    taken.release();
    await taken.done;
  });

  it('exports no fence series before its first success on an unreachable database, and its age from its start', async () => {
    sampler = new KeycloakFenceSampler(
      {
        fences: () => Promise.reject(new Error('the database is unreachable')),
        lapseBacklog: () => Promise.reject(new Error('the database is unreachable')),
      },
      {},
    );
    sampler.start();
    await sleep(FENCE_SAMPLE_INTERVAL_MS + 200);
    expect(await gauge('overdue')).toBeUndefined();
    expect(await gauge('live')).toBeUndefined();
    expect(await age()).toBeGreaterThanOrEqual(FENCE_SAMPLE_INTERVAL_MS / 1000);
  });
});
