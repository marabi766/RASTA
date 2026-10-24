import { runUnscoped } from '@rasta/nest-common';
import { EventPublisher } from '../src/events/publisher';
import { ProjectAccess } from '../src/access/access';
import { ProjectService, CREATE_PROJECT_ENDPOINT } from '../src/project/project.service';
import { AWARD_TENDER_ENDPOINT } from '../src/tender/award.service';
import { replayFenceBudgetMs } from '../src/config/operation-budgets';
import { IdempotencyStore, type ClaimPoint } from '../src/shared/idempotency';
import type { ExtendedPrismaClient } from '../src/prisma/prisma.service';
import {
  PROJECT,
  asAdmin,
  cleanup,
  newOrganizationId,
  newUserId,
  outboxFor,
  testEnv,
  wire,
  type Wiring,
} from './helpers';

/**
 * Claim admission is decided AFTER the insert, on the database clock (PR #370 r8 F1; the replay
 * fence in `shared/idempotency.ts`). The reviewer's interleaving, on real PostgreSQL: a retry passes
 * its pre-checks, is suspended between them and the claim transaction's BEGIN, the original row is
 * legally purged meanwhile, and the resumed insert succeeds — before r8 a second project.
 *
 * Replicas are stores over one database. The application clock (`nowMs()`) is simulated per replica,
 * as in `idempotency-forget.int-spec.ts`; the DATABASE clock is the real one unless a test stands one
 * in through the `databaseInstant` seam. A suspension is the `checkpoint` seam.
 */

const SECOND = 1000;
const TTL_HOURS = 1;
const TTL_MS = TTL_HOURS * 60 * 60 * SECOND;
const SKEW_SECONDS = 30;
const BUDGET_MS = replayFenceBudgetMs(SKEW_SECONDS);

type Hook = (point: ClaimPoint, attempt: number) => Promise<void>;

class Replica extends IdempotencyStore {
  readonly points: string[] = [];
  readonly databaseReads: number[] = [];
  hook: Hook | undefined;
  databaseClock: (() => number) | 'real' | 'unreadable' = 'real';

  constructor(
    prisma: ConstructorParameters<typeof IdempotencyStore>[0],
    env: ConstructorParameters<typeof IdempotencyStore>[1],
    private readonly appClock: () => number,
  ) {
    super(prisma, env);
  }

  protected override nowMs(): number {
    return this.appClock();
  }

  protected override async checkpoint(point: ClaimPoint, attempt: number): Promise<void> {
    this.points.push(`${point}:${attempt}`);
    await this.hook?.(point, attempt);
  }

  protected override async databaseInstant(tx: ExtendedPrismaClient): Promise<Date> {
    if (this.databaseClock === 'unreadable') throw new Error('the database clock is unreadable');
    const instant =
      this.databaseClock === 'real'
        ? await super.databaseInstant(tx)
        : new Date(this.databaseClock());
    this.databaseReads.push(instant.getTime());
    return instant;
  }
}

describe('claim admission after the insert, on the database clock', () => {
  let w: Wiring;
  const organizations: string[] = [];
  const env = testEnv({
    CONSTRUCTION_IDEMPOTENCY_TTL_HOURS: String(TTL_HOURS),
    CONSTRUCTION_CLOCK_SKEW_SECONDS: String(SKEW_SECONDS),
  });
  const author = newUserId();

  beforeAll(() => {
    w = wire();
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    await cleanup(w.prisma, organizations);
    await w.close();
  });

  const org = (): string => {
    const id = newOrganizationId();
    organizations.push(id);
    return id;
  };
  const replica = (appClock: () => number): Replica => new Replica(w.prisma, env, appClock);
  const serviceOver = (store: IdempotencyStore): ProjectService =>
    new ProjectService(
      w.prisma,
      w.repository,
      new EventPublisher(env),
      new ProjectAccess(env),
      store,
      env,
      w.approvalRepository,
      w.tenderRepository,
    );
  const create = (service: ProjectService, organizationId: string, key: string, header?: number) =>
    asAdmin(organizationId, () => service.create(PROJECT, key, header), author);
  const codeOf = (promise: Promise<unknown>): Promise<string> =>
    promise.then(
      () => 'OK',
      (error: { code?: string }) => error.code ?? 'ERROR',
    );
  const projectsOf = (organizationId: string) =>
    runUnscoped('count the organization projects', () =>
      w.prisma.client.project.findMany({ where: { organizationId } }),
    );
  const keyRow = (organizationId: string, key: string, endpoint = CREATE_PROJECT_ENDPOINT) =>
    runUnscoped('inspect the idempotency record', () =>
      w.prisma.client.idempotencyKey.findUnique({
        where: { organizationId_endpoint_key: { organizationId, endpoint, key } },
      }),
    );
  const databaseNowMs = async (): Promise<number> => {
    const rows = await w.prisma.client.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
    return rows[0]!.now.getTime();
  };
  const untilDatabaseClockPasses = async (instantMs: number): Promise<void> => {
    const limit = Date.now() + 15 * SECOND;
    while ((await databaseNowMs()) <= instantMs) {
      if (Date.now() > limit) throw new Error('the database clock did not advance');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };
  const createdEvents = async (organizationId: string) =>
    (await outboxFor(w.prisma, organizationId)).filter((m) => m.eventName === 'PROJECT_CREATED');

  /**
   * A purge by ANOTHER replica whose clock reads far enough ahead that the original row may legally
   * be forgotten (`expiresAt < now − B`). Returns what it removed.
   */
  const legalPurge = async (original: number): Promise<number> => {
    const later = original + TTL_MS + BUDGET_MS + SECOND;
    return replica(() => later).purgeExpired();
  };

  describe('the reviewer’s interleaving: suspended after the pre-checks, before BEGIN', () => {
    // The header is a few seconds of REAL database time ahead: the resumed request's insert is
    // judged by the real database clock, which only the passing of real time moves past it.
    const HEADER_AHEAD_MS = 3 * SECOND;

    it('initial insert: the original row is purged during the suspension; the resumed request is refused, one project, one event', async () => {
      const a = org();
      const t0 = Date.now();
      const header = t0 + HEADER_AHEAD_MS;
      const first = await create(serviceOver(replica(() => t0)), a, 'k', header);
      const rowBefore = await keyRow(a, 'k');
      expect(rowBefore?.state).toBe('COMPLETED');
      expect(rowBefore?.replayDeadlineAt?.getTime()).toBe(header);
      expect(await databaseNowMs()).toBeLessThanOrEqual(header); // the original was admitted

      const retry = replica(() => t0 + 1); // its own clock: before H, so both pre-checks pass
      let purged = -1;
      let rowGoneAtResume = false;
      retry.hook = async (point, attempt) => {
        if (point !== 'insert' || attempt !== 0) return;
        // The suspension, after the remaining budget was captured and before BEGIN.
        purged = await legalPurge(t0);
        rowGoneAtResume = (await keyRow(a, 'k')) === null;
        await untilDatabaseClockPasses(header);
      };

      expect(await codeOf(create(serviceOver(retry), a, 'k', header))).toBe('REPLAY_WINDOW_CLOSED');
      // It failed for the intended reason: it was suspended at the first insert, the purge really
      // removed the original, the insert went through, and the database clock — read once, after
      // the insert — was past H. Not the pre-checks, not a budget conflict.
      expect(retry.points).toEqual(['insert:0']);
      expect(purged).toBeGreaterThanOrEqual(1);
      expect(rowGoneAtResume).toBe(true);
      expect(retry.databaseReads).toHaveLength(1);
      expect(retry.databaseReads[0]).toBeGreaterThan(header);
      // No claim of the refused attempt survives, and nothing ran twice.
      expect(await keyRow(a, 'k')).toBeNull();
      expect(await projectsOf(a)).toEqual([expect.objectContaining({ id: first.id })]);
      expect(await createdEvents(a)).toHaveLength(1);
    });

    it('re-insert: the first insert collides, the row is purged before it is read, the second insert is the one refused', async () => {
      const a = org();
      const t0 = Date.now();
      const header = t0 + HEADER_AHEAD_MS;
      const first = await create(serviceOver(replica(() => t0)), a, 'k', header);

      const retry = replica(() => t0 + 1);
      let purged = -1;
      retry.hook = async (point, attempt) => {
        if (point === 'read' && attempt === 0) purged = await legalPurge(t0);
        if (point === 'insert' && attempt === 1) await untilDatabaseClockPasses(header);
      };

      expect(await codeOf(create(serviceOver(retry), a, 'k', header))).toBe('REPLAY_WINDOW_CLOSED');
      // insert 0 collided with the original; read found it gone; insert 1 was suspended and refused.
      expect(retry.points).toEqual(['insert:0', 'read:0', 'insert:1']);
      expect(purged).toBeGreaterThanOrEqual(1);
      expect(retry.databaseReads).toHaveLength(1); // only the second insert succeeded to be judged
      expect(retry.databaseReads[0]).toBeGreaterThan(header);
      expect(await keyRow(a, 'k')).toBeNull();
      expect(await projectsOf(a)).toEqual([expect.objectContaining({ id: first.id })]);
      expect(await createdEvents(a)).toHaveLength(1);
    });

    it('re-insert after a reclaim: a mismatched claimant forgets the row legally, then its own insert is judged', async () => {
      const a = org();
      const t0 = Date.now();
      await create(serviceOver(replica(() => t0)), a, 'k', t0 + 600 * SECOND);

      // This replica reads far ahead (the original is forgettable on its clock) and sends another
      // body with a header of its own, 600 s past ITS clock. Its database clock is stood in so the
      // boundary can be placed exactly; the original row is removed by its own reclaim.
      const later = t0 + TTL_MS + BUDGET_MS + SECOND;
      const header = later + 600 * SECOND;
      const claimant = replica(() => later);
      let judged = 0;
      claimant.databaseClock = () => (judged += 1) && header + 1;
      const other = { ...PROJECT, title: 'A different title' };
      const outcome = codeOf(
        asAdmin(a, () => serviceOver(claimant).create(other, 'k', header), author),
      );

      expect(await outcome).toBe('REPLAY_WINDOW_CLOSED');
      expect(claimant.points).toEqual(['insert:0', 'read:0', 'delete:0', 'insert:1']);
      expect(judged).toBe(1);
      expect(await keyRow(a, 'k')).toBeNull(); // the original: forgotten by rule; the new claim: rolled back
      expect(await projectsOf(a)).toHaveLength(1); // the original's, nothing of the refused one
    });
  });

  describe('the database-clock boundary: refused iff T > H, independent of the forget rule', () => {
    it.each([
      ['T = H − 1 ms', -1, 'OK'],
      ['T = H (equality is allowed)', 0, 'OK'],
      ['T = H + 1 ms', 1, 'REPLAY_WINDOW_CLOSED'],
    ])('%s', async (_name, delta, expected) => {
      const a = org();
      const t0 = Date.now();
      const header = t0 + 600 * SECOND;
      const store = replica(() => t0);
      store.databaseClock = () => header + delta;
      expect(await codeOf(create(serviceOver(store), a, 'k', header))).toBe(expected);
      expect(store.databaseReads).toEqual([header + delta]);
      expect(await projectsOf(a)).toHaveLength(expected === 'OK' ? 1 : 0);
      expect(await createdEvents(a)).toHaveLength(expected === 'OK' ? 1 : 0);
      expect(await keyRow(a, 'k')).toEqual(expected === 'OK' ? expect.anything() : null);
    });

    it('the application clock does not decide it: an app clock before H cannot admit a database clock past H', async () => {
      const a = org();
      const t0 = Date.now();
      const store = replica(() => t0 - 10 * SECOND); // reads ten seconds behind
      store.databaseClock = () => t0 + 1;
      expect(await codeOf(create(serviceOver(store), a, 'k', t0))).toBe('REPLAY_WINDOW_CLOSED');
      expect(await projectsOf(a)).toHaveLength(0);
    });

    it('the forget boundary is separate and unchanged: expiresAt = now − B is kept, one ms later it goes', async () => {
      const a = org();
      const t0 = Date.now();
      await create(serviceOver(replica(() => t0)), a, 'k', t0 + 600 * SECOND);
      const expiresAt = (await keyRow(a, 'k'))!.expiresAt.getTime();
      // (Rows of earlier tests are forgettable too, so the count is not asserted: the row is.)
      await replica(() => expiresAt + BUDGET_MS).purgeExpired();
      expect(await keyRow(a, 'k')).not.toBeNull();
      await replica(() => expiresAt + BUDGET_MS + 1).purgeExpired();
      expect(await keyRow(a, 'k')).toBeNull();
    });
  });

  describe('a refusal removes nothing but its own attempt', () => {
    it('another tenant’s row under the same key, a completed row of another key and an in-flight claim are untouched', async () => {
      const a = org();
      const b = org();
      const t0 = Date.now();
      const quiet = replica(() => t0);
      await create(serviceOver(quiet), b, 'shared', t0 + 600 * SECOND);
      await create(serviceOver(quiet), a, 'other-key', t0 + 600 * SECOND);
      const holder = replica(() => t0);
      const claimed = await asAdmin(
        a,
        () => holder.claim(CREATE_PROJECT_ENDPOINT, 'in-flight', { x: 1 }),
        author,
      );
      expect(claimed.kind).toBe('PROCEED');
      const before = [
        await keyRow(b, 'shared'),
        await keyRow(a, 'other-key'),
        await keyRow(a, 'in-flight'),
      ];

      const refused = replica(() => t0);
      refused.databaseClock = () => t0 + 700 * SECOND;
      expect(await codeOf(create(serviceOver(refused), a, 'shared', t0 + 600 * SECOND))).toBe(
        'REPLAY_WINDOW_CLOSED',
      );

      expect([
        await keyRow(b, 'shared'),
        await keyRow(a, 'other-key'),
        await keyRow(a, 'in-flight'),
      ]).toEqual(before);
      expect(await keyRow(a, 'shared')).toBeNull();
      // The in-flight owner still completes its own claim afterwards: nothing took its token.
      expect(claimed.kind === 'PROCEED' && claimed.claim.token).toBe(
        (await keyRow(a, 'in-flight'))?.claimToken,
      );
    });
  });

  describe('fail closed and scope', () => {
    it('an unreadable database clock refuses the claim — no application-clock fallback, nothing written', async () => {
      const a = org();
      const t0 = Date.now();
      const store = replica(() => t0);
      store.databaseClock = 'unreadable';
      expect(await codeOf(create(serviceOver(store), a, 'k', t0 + 600 * SECOND))).toBe('ERROR');
      expect(await keyRow(a, 'k')).toBeNull();
      expect(await projectsOf(a)).toHaveLength(0);
    });

    it('a request with no header never reads the database clock (tender awarding sends none): unchanged', async () => {
      const a = org();
      const store = replica(() => Date.now());
      store.databaseClock = 'unreadable'; // would fail any claim that consulted it
      const run = await asAdmin(
        a,
        () =>
          store.execute(
            AWARD_TENDER_ENDPOINT,
            'award-key',
            { tenderId: 'T-1' },
            200,
            async (record) => {
              await w.prisma.transaction((tx) => record(tx, 'T-1', { ok: true }));
              return { ok: true };
            },
          ),
        author,
      );
      expect(run).toEqual({ result: { ok: true }, executed: true });
      expect(store.databaseReads).toEqual([]);
      expect((await keyRow(a, 'award-key', AWARD_TENDER_ENDPOINT))?.replayDeadlineAt).toBeNull();
      // And its replay is as before.
      const again = await asAdmin(
        a,
        () => store.claim(AWARD_TENDER_ENDPOINT, 'award-key', { tenderId: 'T-1' }),
        author,
      );
      expect(again).toEqual({ kind: 'REPLAY', body: { ok: true } });
    });
  });
});
