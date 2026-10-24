import { runUnscoped } from '@rasta/nest-common';
import { EventPublisher } from '../src/events/publisher';
import { ProjectAccess } from '../src/access/access';
import { ProjectService, CREATE_PROJECT_ENDPOINT } from '../src/project/project.service';
import { replayFenceBudgetMs } from '../src/config/operation-budgets';
import { IdempotencyStore } from '../src/shared/idempotency';
import {
  PROJECT,
  asAdmin,
  cleanup,
  newOrganizationId,
  newUserId,
  testEnv,
  wire,
  type Wiring,
} from './helpers';

/**
 * The replay fence (PM decision D-065) against PostgreSQL: the owning service
 * compares a request's replay deadline with the SAME clock that expires its
 * idempotency key, so a request that may have committed is never run a second
 * time once the key is gone — whatever the web's clock, a paused process or a
 * replica a minute off believed.
 *
 * "Replicas" are stores over one database with their own clock: true time is
 * `trueMs`, a replica reads it plus its offset (`ReplicaStore.nowMs`). Nothing
 * waits for real time to pass.
 */

const SECOND = 1000;
const TTL_HOURS = 1;
const TTL_MS = TTL_HOURS * 60 * 60 * SECOND;
const SKEW_SECONDS = 30;
/** B = 2·skew + margin, as the service computes it. */
const BUDGET_MS = replayFenceBudgetMs(SKEW_SECONDS);
/**
 * A header later than the stored one but still acceptable (≤ now + TTL − B = 3 533 s from true time
 * zero for a replica reading true time): the stored deadline, not this, must decide. A header beyond
 * the acceptable maximum is refused outright — see 'a header beyond the retention'.
 */
const LATER = 3_000;

class ReplicaStore extends IdempotencyStore {
  constructor(
    prisma: ConstructorParameters<typeof IdempotencyStore>[0],
    env: ConstructorParameters<typeof IdempotencyStore>[1],
    private readonly offsetMs: number,
    private readonly truth: () => number,
  ) {
    super(prisma, env);
  }

  protected override nowMs(): number {
    return this.truth() + this.offsetMs;
  }
}

describe('the replay fence', () => {
  let w: Wiring;
  const organizations: string[] = [];
  /** True time of the test, ms since the epoch; moved by `at(seconds)`. */
  let base = 0;
  let trueMs = 0;
  const at = (seconds: number): void => {
    trueMs = base + seconds * SECOND;
  };
  const truth = (): number => trueMs;

  const env = testEnv({
    CONSTRUCTION_IDEMPOTENCY_TTL_HOURS: String(TTL_HOURS),
    CONSTRUCTION_CLOCK_SKEW_SECONDS: String(SKEW_SECONDS),
  });

  const replica = (offsetSeconds: number, withEnv = env): ReplicaStore =>
    new ReplicaStore(w.prisma, withEnv, offsetSeconds * SECOND, truth);
  const serviceOver = (store: IdempotencyStore, withEnv = env): ProjectService =>
    new ProjectService(
      w.prisma,
      w.repository,
      new EventPublisher(withEnv),
      new ProjectAccess(withEnv),
      store,
      withEnv,
      w.approvalRepository,
      w.tenderRepository,
    );

  beforeAll(() => {
    w = wire();
  });

  beforeEach(() => {
    base = Date.now();
    trueMs = base;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await cleanup(w.prisma, organizations);
    await w.close();
  });

  const org = (): string => {
    const id = newOrganizationId();
    organizations.push(id);
    return id;
  };
  const author = newUserId();
  const asAuthor = <T>(organizationId: string, fn: () => T, userId = author): T =>
    asAdmin(organizationId, fn, userId);

  const projectsOf = (organizationId: string) =>
    runUnscoped('count the organization’s projects', () =>
      w.prisma.client.project.findMany({ where: { organizationId } }),
    );
  const keyRow = (organizationId: string, key: string) =>
    runUnscoped('inspect the idempotency record', () =>
      w.prisma.client.idempotencyKey.findUnique({
        where: {
          organizationId_endpoint_key: { organizationId, endpoint: CREATE_PROJECT_ENDPOINT, key },
        },
      }),
    );
  const ms = (date: Date | null | undefined): number | null => (date ? date.getTime() : null);

  /** The request the web would send: the project, the key, and its deadline in seconds from true time zero. */
  const create = (
    service: ProjectService,
    organizationId: string,
    key: string,
    deadlineSeconds: number | undefined,
    userId = author,
  ) =>
    asAuthor(
      organizationId,
      () =>
        service.create(
          PROJECT,
          key,
          deadlineSeconds === undefined ? undefined : base + deadlineSeconds * SECOND,
        ),
      userId,
    );

  describe('the stored deadline is the header itself, or the request is refused', () => {
    it('stores the header on the first claim, and expiresAt = claim + TTL', async () => {
      const a = org();
      at(0);
      const service = serviceOver(replica(0));

      await create(service, a, 'plain', 600);
      const row = await keyRow(a, 'plain');
      expect(ms(row?.replayDeadlineAt)).toBe(base + 600 * SECOND);
      expect(ms(row?.expiresAt)).toBe(base + TTL_MS);
      // The inequality the forget rule relies on: D + B ≤ expiresAt.
      expect(ms(row?.replayDeadlineAt)! + BUDGET_MS).toBeLessThanOrEqual(ms(row?.expiresAt)!);
    });

    it('a header exactly at now + TTL − B is accepted and stored as is; one millisecond later is refused (400), nothing written', async () => {
      const a = org();
      at(0);
      const service = serviceOver(replica(0));
      const limit = base + TTL_MS - BUDGET_MS;

      await asAuthor(a, () => service.create(PROJECT, 'edge-ok', limit));
      expect(ms((await keyRow(a, 'edge-ok'))?.replayDeadlineAt)).toBe(limit);

      await expect(
        asAuthor(a, () => service.create(PROJECT, 'edge-late', limit + 1)),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 400 });
      expect(await keyRow(a, 'edge-late')).toBeNull();
      expect(await projectsOf(a)).toHaveLength(1);
    });

    it('a ten-years-ahead header is refused at first contact: no clamp, no row, no project', async () => {
      const a = org();
      at(0);
      const service = serviceOver(replica(0));
      const tenYears = 10 * 365 * 24 * 3600;

      const refusal = await create(service, a, 'forged', tenYears).then(
        () => null,
        (error: unknown) => error as { code: string; message: string; details?: unknown },
      );
      expect(refusal).toMatchObject({ code: 'VALIDATION_FAILED' });
      // Fixed message: nothing of the limit, the clock or any stored value.
      expect(JSON.stringify(refusal)).not.toMatch(/\d{6,}/);
      expect(await keyRow(a, 'forged')).toBeNull();
      expect(await projectsOf(a)).toEqual([]);
    });

    it('the limit follows the replica that claims: a −30 s replica accepts less, a +30 s replica more', async () => {
      const a = org();
      at(0);
      const minus = serviceOver(replica(-30));
      const plus = serviceOver(replica(+30));
      // True-time seconds: −30 reads base − 30, so its limit is 3 503; +30 reads base + 30: 3 563.
      await expect(create(minus, a, 'm', 3504)).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
      });
      await create(minus, a, 'm', 3503);
      await expect(create(plus, a, 'p', 3564)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      await create(plus, a, 'p', 3563);
    });

    it('a later claim cannot move the stored deadline: the header of the retry is ignored', async () => {
      const a = org();
      at(0);
      const service = serviceOver(replica(0));
      await create(service, a, 'fixed', 300);

      at(200);
      await create(service, a, 'fixed', LATER); // a replay; the stored deadline stays
      expect(ms((await keyRow(a, 'fixed'))?.replayDeadlineAt)).toBe(base + 300 * SECOND);

      at(301);
      await expect(create(service, a, 'fixed', LATER)).rejects.toMatchObject({
        code: 'REPLAY_WINDOW_CLOSED',
      });
    });
  });

  describe('the r5 sequence: issuer +30, replica A −30, replica B +30', () => {
    // After D-067 the r5 header 3 555 is no longer ACCEPTED by replica A (its limit is
    // 3 570 − 67 = 3 503 s of true time zero), so the sequence is rebuilt with the largest header A
    // accepts. The portal never sends more: its window is held below the shared maximum.
    const header = 3503;

    it('B refuses with REPLAY_WINDOW_CLOSED and no second project is made; the row is untouched', async () => {
      const a = org();
      const replicaA = serviceOver(replica(-30));
      const replicaB = serviceOver(replica(+30));

      at(0);
      const first = await create(replicaA, a, 'r5', header);
      // A's clock reads −30 s: expiresAt = 3570 s, and D = H = 3503 = 3570 − B.
      const row = await keyRow(a, 'r5');
      expect(ms(row?.expiresAt)).toBe(base - 30 * SECOND + TTL_MS);
      expect(ms(row?.replayDeadlineAt)).toBe(base + header * SECOND);

      // True second 3550: B's clock reads 3580 > 3503.
      at(3550);
      await expect(create(replicaB, a, 'r5', header)).rejects.toMatchObject({
        code: 'REPLAY_WINDOW_CLOSED',
        status: 409,
      });
      expect(await projectsOf(a)).toEqual([expect.objectContaining({ id: first.id })]);
      // Nothing of the row changed.
      expect(await keyRow(a, 'r5')).toEqual(row);
    });

    it('the same sequence WITHOUT the header still creates a second project (rollout: stated, not hidden)', async () => {
      const a = org();
      const replicaA = serviceOver(replica(-30));
      const replicaB = serviceOver(replica(+30));

      at(0);
      await create(replicaA, a, 'r5-old', undefined);
      at(3580 - 30); // B reads 3580 s > A's expiresAt 3570 s
      await create(replicaB, a, 'r5-old', undefined);
      expect(await projectsOf(a)).toHaveLength(2);
      expect((await keyRow(a, 'r5-old'))?.replayDeadlineAt).toBeNull();
    });
  });

  describe('a request that arrives late', () => {
    it('delayed dispatch (110 s pause after the reservation): the FIRST claim is refused, nothing is written', async () => {
      const a = org();
      const service = serviceOver(replica(0));
      // Reserved at 3495 s with deadline 3525 s; the process stalls and dispatches at 3605 s.
      at(3605);
      await expect(create(service, a, 'late', 3525)).rejects.toMatchObject({
        code: 'REPLAY_WINDOW_CLOSED',
      });
      expect(await projectsOf(a)).toEqual([]);
      expect(await keyRow(a, 'late')).toBeNull();
    });

    it('equality: now == deadline is allowed, one millisecond later is refused (first claim)', async () => {
      const a = org();
      const service = serviceOver(replica(0));
      trueMs = base + 100 * SECOND;
      await create(service, a, 'edge-ok', 100); // now == header
      expect(await projectsOf(a)).toHaveLength(1);

      trueMs = base + 100 * SECOND + 1;
      await expect(create(service, a, 'edge-late', 100)).rejects.toMatchObject({
        code: 'REPLAY_WINDOW_CLOSED',
      });
    });

    it('a retry past the stored deadline is refused whatever the row is: completed, in flight, or past expiresAt', async () => {
      const a = org();
      const service = serviceOver(replica(0));
      at(0);
      await create(service, a, 'done', 300);
      // An in-flight row of the same request (seeded IN_PROGRESS, with the same hash and a deadline).
      const hash = replica(0).hash({ requester: author, body: PROJECT });
      await runUnscoped('seed an in-flight record with a deadline', () =>
        w.prisma.client.idempotencyKey.create({
          data: {
            organizationId: a,
            endpoint: CREATE_PROJECT_ENDPOINT,
            key: 'flying',
            requestHash: hash,
            claimToken: 'seeded-flying',
            state: 'IN_PROGRESS',
            expiresAt: new Date(base + TTL_MS),
            replayDeadlineAt: new Date(base + 300 * SECOND),
          },
        }),
      );

      // The retry carries a LATER header (a newer one): the stored deadline decides, not the header.
      at(301);
      for (const key of ['done', 'flying']) {
        await expect(create(service, a, key, LATER)).rejects.toMatchObject({
          code: 'REPLAY_WINDOW_CLOSED',
        });
      }
      // And far past expiresAt (the purge has not run): still refused, never the delete-and-proceed path.
      at(TTL_MS / SECOND + 10);
      for (const key of ['done', 'flying']) {
        await expect(create(service, a, key, TTL_MS / SECOND + 1000)).rejects.toMatchObject({
          code: 'REPLAY_WINDOW_CLOSED',
        });
      }
      expect(await projectsOf(a)).toHaveLength(1);
      expect(await keyRow(a, 'flying')).toMatchObject({ claimToken: 'seeded-flying' });
    });
  });

  describe('the deadline, not expiresAt, decides for a row that carries one', () => {
    it('a row whose deadline coincides with its expiry is live up to the deadline: a replay, never delete-and-proceed', async () => {
      const a = org();
      const service = serviceOver(replica(0));
      at(100);
      // The constraint allows deadline == expiresAt (nothing writes it: an accepted header is at least B before expiresAt); a row
      // like that must still answer by its deadline.
      await runUnscoped('seed a row whose deadline equals its expiry', () =>
        w.prisma.client.idempotencyKey.create({
          data: {
            organizationId: a,
            endpoint: CREATE_PROJECT_ENDPOINT,
            key: 'coincide',
            requestHash: replica(0).hash({ requester: author, body: PROJECT }),
            claimToken: 'seeded-coincide',
            state: 'COMPLETED',
            expiresAt: new Date(base + 100 * SECOND),
            replayDeadlineAt: new Date(base + 100 * SECOND),
            responseStatus: 201,
            responseBody: { seeded: true },
            resourceId: 'PRJ_SEEDED',
          },
        }),
      );
      expect(await create(service, a, 'coincide', 1000)).toEqual({ seeded: true });
      expect(await projectsOf(a)).toEqual([]);

      trueMs += 1;
      await expect(create(service, a, 'coincide', 1000)).rejects.toMatchObject({
        code: 'REPLAY_WINDOW_CLOSED',
      });
      expect(await projectsOf(a)).toEqual([]);
    });
  });

  describe('a web release that came too early can at worst re-send the same key', () => {
    it('inside the window the same key meets the in-flight claim (CONFLICT) or the stored answer (replay) — never a second project', async () => {
      const a = org();
      const service = serviceOver(replica(0));
      at(0);

      // The first dispatch is mid-work (its claim committed, its project not yet).
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const createProject = w.repository.createProject.bind(w.repository);
      let held!: () => void;
      const reached = new Promise<void>((resolve) => (held = resolve));
      jest.spyOn(w.repository, 'createProject').mockImplementationOnce(async (tx, input) => {
        held();
        await gate;
        return createProject(tx, input);
      });
      const first = create(service, a, 'twice', 600);
      await reached;

      at(5);
      await expect(create(service, a, 'twice', 600)).rejects.toMatchObject({ code: 'CONFLICT' });
      release();
      const created = await first;

      at(10);
      const again = await create(service, a, 'twice', 600);
      expect(again.id).toBe(created.id);
      expect(await projectsOf(a)).toHaveLength(1);
    });
  });

  describe('nondisclosure: the actor and tenant bindings come first', () => {
    it("another person's same key and body meets IDEMPOTENCY_KEY_REUSED — before and after the deadline, as it always did", async () => {
      const a = org();
      const service = serviceOver(replica(0));
      at(0);
      await create(service, a, 'mine', 300);
      const other = newUserId();

      at(100);
      await expect(create(service, a, 'mine', 300, other)).rejects.toMatchObject({
        code: 'IDEMPOTENCY_KEY_REUSED',
      });
      // Past the stored deadline (row still unexpired): the stranger is told what it was always told,
      // never the stored state of somebody else's key.
      at(400);
      await expect(create(service, a, 'mine', LATER, other)).rejects.toMatchObject({
        code: 'IDEMPOTENCY_KEY_REUSED',
      });
      // Past expiresAt but not yet expiresAt + B (D-067): the row may not be forgotten, so the
      // stranger is still told IDEMPOTENCY_KEY_REUSED — and the row is still there.
      at(TTL_MS / SECOND + 5);
      await expect(create(service, a, 'mine', TTL_MS / SECOND + 1000, other)).rejects.toMatchObject(
        {
          code: 'IDEMPOTENCY_KEY_REUSED',
        },
      );
      expect(await keyRow(a, 'mine')).not.toBeNull();
      // Once the row may be forgotten (expiresAt < now − B) the key is the stranger's to claim.
      at(TTL_MS / SECOND + BUDGET_MS / SECOND + 1);
      const theirs = await create(service, a, 'mine', TTL_MS / SECOND + 1000, other);
      expect(theirs.status).toBe('DRAFT');
      // The original author's retry with its original header is refused: nothing runs twice.
      await expect(create(service, a, 'mine', 300)).rejects.toMatchObject({
        code: 'REPLAY_WINDOW_CLOSED',
      });
      expect(await projectsOf(a)).toHaveLength(2);
    });

    it('another organization with the same key never meets the key: its own first claim', async () => {
      const a = org();
      const b = org();
      const service = serviceOver(replica(0));
      at(0);
      await create(service, a, 'shared', 300);

      at(400); // past A's deadline
      const inB = await create(service, b, 'shared', 1000);
      expect(inB.status).toBe('DRAFT');
      expect(await projectsOf(a)).toHaveLength(1);
      expect(await projectsOf(b)).toHaveLength(1);
      // B's row is its own, with its own deadline (its header, as sent).
      expect(ms((await keyRow(b, 'shared'))?.replayDeadlineAt)).toBe(base + 1000 * SECOND);
    });

    it('a header already behind the clock is refused the same way for anyone, and depends on nothing stored', async () => {
      const a = org();
      const service = serviceOver(replica(0));
      at(0);
      await create(service, a, 'known', 300);
      at(500);
      for (const [key, user] of [
        ['known', author],
        ['known', newUserId()],
        ['never-used', author],
      ] as const) {
        await expect(create(service, a, key, 300, user)).rejects.toMatchObject({
          code: 'REPLAY_WINDOW_CLOSED',
        });
      }
    });
  });

  describe('rows without a deadline behave as they always did', () => {
    const seed = (organizationId: string, key: string, expiresAt: Date) =>
      runUnscoped('seed an old record without a deadline', () =>
        w.prisma.client.idempotencyKey.create({
          data: {
            organizationId,
            endpoint: CREATE_PROJECT_ENDPOINT,
            key,
            requestHash: replica(0).hash({ requester: author, body: PROJECT }),
            claimToken: `seeded-${key}`,
            state: 'COMPLETED',
            expiresAt,
            responseStatus: 201,
            responseBody: { seeded: true },
            resourceId: 'PRJ_SEEDED',
          },
        }),
      );

    it('an expired null-deadline row is reusable, with or without the header; the new row gets a deadline only if one was sent', async () => {
      const a = org();
      const service = serviceOver(replica(0));
      at(0);
      await seed(a, 'old-1', new Date(base - 60 * SECOND));
      await seed(a, 'old-2', new Date(base - 60 * SECOND));

      await create(service, a, 'old-1', undefined);
      expect((await keyRow(a, 'old-1'))?.replayDeadlineAt).toBeNull();
      await create(service, a, 'old-2', 600);
      expect(ms((await keyRow(a, 'old-2'))?.replayDeadlineAt)).toBe(base + 600 * SECOND);
    });

    it('an unexpired null-deadline row replays, and the header does not fence it', async () => {
      const a = org();
      const service = serviceOver(replica(0));
      at(0);
      await seed(a, 'old-live', new Date(base + 3600 * SECOND));
      // The seeded body is not a project view; the replay returns it as stored.
      const replay = await create(service, a, 'old-live', 10);
      expect(replay).toEqual({ seeded: true });
      at(50); // past the first request's header: no stored deadline, so nothing fences the replay
      expect(await create(service, a, 'old-live', 1000)).toEqual({ seeded: true });
    });
  });

  describe('the purge keeps what the fence needs', () => {
    const insert = (organizationId: string, key: string, expiresAt: Date, deadline: Date | null) =>
      runUnscoped('seed a record for the purge', () =>
        w.prisma.client.idempotencyKey.create({
          data: {
            organizationId,
            endpoint: CREATE_PROJECT_ENDPOINT,
            key,
            requestHash: 'x',
            claimToken: `seeded-${key}`,
            state: 'COMPLETED',
            expiresAt,
            replayDeadlineAt: deadline,
            responseStatus: 201,
            responseBody: {},
            resourceId: 'PRJ_SEEDED',
          },
        }),
      );
    const keysLeft = async (organizationId: string) =>
      (
        await runUnscoped('inspect what the purge left', () =>
          w.prisma.client.idempotencyKey.findMany({ where: { organizationId } }),
        )
      )
        .map((row) => row.key)
        .sort();

    it('a row with a deadline goes only when expiresAt < now − B; one without when expiresAt ≤ now (exact boundaries, the one forget rule)', async () => {
      const a = org();
      at(0);
      const now = base;
      const purge = replica(0);
      await insert(
        a,
        'fenced-at-boundary',
        new Date(now - BUDGET_MS),
        new Date(now - 2 * BUDGET_MS),
      );
      await insert(
        a,
        'fenced-past-boundary',
        new Date(now - BUDGET_MS - 1),
        new Date(now - 2 * BUDGET_MS),
      );
      await insert(a, 'fenced-between', new Date(now - 1000), new Date(now - 2 * BUDGET_MS));
      await insert(a, 'plain-at-now', new Date(now), null);
      await insert(a, 'plain-expired', new Date(now - 1), null);

      await purge.purgeExpired();
      expect(await keysLeft(a)).toEqual(['fenced-at-boundary', 'fenced-between']);
    });

    it('a purge between expiresAt and expiresAt + B leaves the row, and the same request is refused, not re-run', async () => {
      const a = org();
      const service = serviceOver(replica(0));
      at(0);
      await create(service, a, 'kept', 600);
      at(TTL_MS / SECOND + 1); // 1 s past expiresAt
      await replica(0).purgeExpired();
      expect(await keyRow(a, 'kept')).not.toBeNull();
      await expect(create(service, a, 'kept', TTL_MS / SECOND + 1000)).rejects.toMatchObject({
        code: 'REPLAY_WINDOW_CLOSED',
      });

      at(TTL_MS / SECOND + BUDGET_MS / SECOND + 1);
      await replica(0).purgeExpired();
      expect(await keyRow(a, 'kept')).toBeNull();
      expect(await projectsOf(a)).toHaveLength(1);
    });

    it('the stored row governs when the configuration changes: a shrunk TTL never shortens it, a larger skew budget only keeps it longer', async () => {
      const a = org();
      at(0);
      // Claimed under a 24 h retention and the default skew.
      const longEnv = testEnv({ CONSTRUCTION_IDEMPOTENCY_TTL_HOURS: '24' });
      await create(serviceOver(replica(0, longEnv), longEnv), a, 'shrink', 600);
      const stored = await keyRow(a, 'shrink');
      expect(ms(stored?.expiresAt)).toBe(base + 24 * 3600 * SECOND);

      // Later the service runs with a 1 h retention: the row is not recomputed, purged or refused early.
      at(2 * 3600);
      const shortEnv = testEnv({ CONSTRUCTION_IDEMPOTENCY_TTL_HOURS: '1' });
      await replica(0, shortEnv).purgeExpired();
      expect(await keyRow(a, 'shrink')).toEqual(stored);

      // A purge with a LARGER skew keeps the row longer than the smaller one would.
      at(24 * 3600 + 100); // 100 s past expiresAt: gone under B(30 s) = 67 s, kept under B(300 s) = 607 s
      const wide = testEnv({ CONSTRUCTION_CLOCK_SKEW_SECONDS: '300' });
      await replica(0, wide).purgeExpired();
      expect(await keyRow(a, 'shrink')).not.toBeNull();
      await replica(0).purgeExpired();
      expect(await keyRow(a, 'shrink')).toBeNull();
    });
  });

  describe('the table refuses a deadline past its own expiry', () => {
    it('ck_idempotency_replay_deadline_within_expiry', async () => {
      const a = org();
      await expect(
        runUnscoped('violate the constraint', () =>
          w.prisma.client.idempotencyKey.create({
            data: {
              organizationId: a,
              endpoint: CREATE_PROJECT_ENDPOINT,
              key: 'bad',
              requestHash: 'x',
              claimToken: 't',
              state: 'IN_PROGRESS',
              expiresAt: new Date(base + 1000),
              replayDeadlineAt: new Date(base + 2000),
            },
          }),
        ),
      ).rejects.toThrow(/ck_idempotency_replay_deadline_within_expiry/);
    });
  });
});
