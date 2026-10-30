import { eligibilityClockWrite, setEligibilityFixture } from '@rasta/testing';
import { runUnscoped } from '@rasta/nest-common';
import { IdentityRepository } from '../src/identity/identity.repository';
import type { IdentityService } from '../src/identity/identity.service';
import { MembershipExpiryScanner } from '../src/identity/membership-expiry.scanner';
import {
  FENCE_SAMPLE_INTERVAL_MS,
  FENCE_SAMPLE_STALE_SECONDS,
  KeycloakFenceSampler,
  pooledFenceSampleSource,
} from '../src/keycloak/keycloak-fence-sampler';
import type { KeycloakProjector } from '../src/keycloak/keycloak.projector';
import { FENCE_POOL_CONNECTIONS } from '../src/keycloak/keycloak-write-fence';
import {
  keycloakFenceSampleAge,
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
 *
 * The sampler's clock is the test's (#912), and so is when it samples: its
 * timers are an hour apart and each sample is a tick the test asks for. So
 * an age, a gap and its retention are what the test set them to, never how
 * long the runner took between a sample and a scrape; and the fence fixture
 * stays overdue for an hour — its state is the test's, not a window the
 * test consumes. Its own timer and the ages' arithmetic: on fake timers in
 * `keycloak-fence-sampler.spec.ts`.
 */

const HOUR_MS = 3_600_000;

describe('R3-2: the fence sampler on a real database', () => {
  let prisma: PrismaService;
  let other: PrismaService;
  let repository: IdentityRepository;
  let own: PrismaService;
  let sampler: KeycloakFenceSampler;
  /** The sampler's monotonic clock, in ms: it moves only when a test moves it. */
  let now = 0;
  const inserted: string[] = [];
  const onTheTestsClock = { clock: () => now, intervalMs: HOUR_MS, lapseIntervalMs: HOUR_MS };

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
    now = 0;
    sampler = new KeycloakFenceSampler(pooledFenceSampleSource(own, repository), onTheTestsClock);
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

  /**
   * A fence past its deadline plus half its settle window, not yet past
   * takeover: overdue — for the next hour, so for the whole test.
   */
  async function overdueFence(): Promise<string> {
    const attemptId = `KWA_${id('OVD')}`;
    inserted.push(attemptId);
    await eligibilityClockWrite(prisma.client)`
      INSERT INTO keycloak_write_attempt
             (attempt_id, user_id, keycloak_id, operation,
              started_at, deadline_at, takeover_at, next_reassert_at)
      SELECT ${attemptId}, ${id('USR-SMP')}, 'kc-sampler', 'replace_attributes',
             c - interval '3 hours', c - interval '2 hours', c + interval '1 hour', c + interval '1 hour'
        FROM (SELECT clock_timestamp() AT TIME ZONE 'UTC' AS c) t`;
    return attemptId;
  }

  const gauge = async (state: string) =>
    (await keycloakWriteFences.get()).values.find((v) => v.labels.state === state)?.value;
  const age = async () => (await keycloakFenceSampleAge.get()).values[0]?.value;
  const samples = async (outcome: string) =>
    (await keycloakFenceSamplesTotal.get()).values.find((v) => v.labels.outcome === outcome)
      ?.value ?? 0;
  /**
   * Ticks the sampler — again while one is still in flight (counted busy) —
   * until one more sample ended with `outcome`; the clock stands still, so it
   * started at `now`.
   */
  async function sampled(outcome: 'ok' | 'failed'): Promise<void> {
    const before = await samples(outcome);
    await waitFor(`a sample ${outcome} at ${now} ms`, async () => {
      if ((await samples(outcome)) > before) return true;
      sampler.tick();
      return null;
    });
  }

  /**
   * The budget each transaction of the sampler on `pool` was given from now
   * on — what the database enforces on it (its connection wait, its lock,
   * its statement, its transaction) — read off the calls, not off a duration
   * a loaded runner can stretch (#910).
   */
  function budgetsOn(pool: PrismaService): number[] {
    const budgets: number[] = [];
    const real = pool.transaction.bind(pool);
    jest.spyOn(pool, 'transaction').mockImplementation((fn, options) => {
      budgets.push(options?.budgetMs ?? Number.POSITIVE_INFINITY);
      return real(fn, options);
    });
    return budgets;
  }

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

  it('samples on its own connection, fresh at every scrape, while the sweep is busy in a lapse (its overlap guard skipping ticks) and the fence pool’s connections are all taken', async () => {
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
          createdBy: 'ITEST',
          updatedBy: 'ITEST',
        },
      });
      // Begun an hour ago and lapsed a minute ago, by the database clock that judges it.
      await setEligibilityFixture(prisma, 'membershipStartedHourAgo', [membershipId]);
      await setEligibilityFixture(prisma, 'membershipEndedMinuteAgo', [membershipId]);
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

    // Two more samples while the sweep is busy, 4 s apart on its clock.
    sampler.start();
    await sampled('ok');
    now = 4_000;
    await sampled('ok');
    now = 8_000;
    await sampled('ok');
    expect(await gauge('overdue')).toBeGreaterThanOrEqual(1);
    // Fresh: the longest gap between two successes, 4 s — had the last one
    // not succeeded, 8 s, past the stale threshold.
    const fresh = await age();
    expect(fresh).toBe(4);
    expect(fresh).toBeLessThan(FENCE_SAMPLE_STALE_SECONDS);
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
    const budgets = budgetsOn(own);
    sampler.start();
    await sampled('ok');

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

    // A scrape every 2 s on its clock, a sample failing under the lock before
    // each — counted failed while the lock is still held: bounded, it did not
    // wait for the lock.
    const ages: number[] = [];
    for (let scrape = 0; scrape < 4; scrape += 1) {
      now += 2_000;
      await sampled('failed');
      ages.push((await age())!);
    }
    // Computed at scrape: it never stops growing while no sample succeeds.
    expect(ages).toEqual([2, 4, 6, 8]);
    expect(ages[ages.length - 1]!).toBeGreaterThan(FENCE_SAMPLE_STALE_SECONDS);
    // Each within its budget, 1 s at most (#910: the budget the database
    // enforced, not a duration a loaded runner can stretch; the client
    // side's own bound is that same budget, on the fake clock in
    // `keycloak-fence-sampler.spec.ts`).
    expect(budgets.length).toBeGreaterThan(0);
    expect(Math.max(...budgets)).toBeLessThanOrEqual(1_000);

    unlock();
    await holding;
    await sampled('ok');
    // Sampling recovered, but the 8 s gap stays reported (retention window),
    // so a stale period between two scrapes is still seen by the alert ...
    expect(await age()).toBe(8);
    // ... a fresh sample 2 s later does not hide it ...
    now += 2_000;
    await sampled('ok');
    expect(await age()).toBe(8);
    expect(await gauge('overdue')).toBeGreaterThanOrEqual(1);
  });

  it('its one connection taken: the wait for it is bounded too, and counted a failure', async () => {
    sampler.start();
    await sampled('ok');
    const taken = exhaust(own, 1);
    await taken.held;
    const budgets = budgetsOn(own);
    // Counted failed while the connection is still taken: its wait did not
    // outlast the holder, and was within its budget, 1 s at most (#910: the
    // budget given, not a duration).
    await sampled('failed');
    expect(budgets.length).toBeGreaterThan(0);
    expect(Math.max(...budgets)).toBeLessThanOrEqual(1_000);
    taken.release();
    await taken.done;
  });

  it('exports no fence series before its first success on an unreachable database, and its age from its start', async () => {
    sampler = new KeycloakFenceSampler(
      {
        fences: () => Promise.reject(new Error('the database is unreachable')),
        lapseBacklog: () => Promise.reject(new Error('the database is unreachable')),
      },
      onTheTestsClock,
    );
    sampler.start();
    await sampled('failed');
    now = FENCE_SAMPLE_INTERVAL_MS;
    await sampled('failed');
    expect(await gauge('overdue')).toBeUndefined();
    expect(await gauge('live')).toBeUndefined();
    expect(await age()).toBe(FENCE_SAMPLE_INTERVAL_MS / 1000);
  });
});
