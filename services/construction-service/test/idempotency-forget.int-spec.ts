import { runUnscoped } from '@rasta/nest-common';
import { EventPublisher } from '../src/events/publisher';
import { ProjectAccess } from '../src/access/access';
import { ProjectService, CREATE_PROJECT_ENDPOINT } from '../src/project/project.service';
import { replayFenceBudgetMs } from '../src/config/operation-budgets';
import { IdempotencyStore } from '../src/shared/idempotency';
import { forgettableWhere, mayForget } from '../src/shared/idempotency-forget';
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
 * One forget rule for every path that removes or reclaims a key row (PM decision D-067), against
 * PostgreSQL: the claim's reclaim (matching AND mismatched claimants), the scheduled purge, and the
 * atomic form of the rule in the DELETE's own WHERE. `idempotency-replay-fence.int-spec.ts` covers
 * the fence itself; this file is the r6 regression set.
 *
 * Replicas are stores over one database with their own clock (`nowMs()` overridden); nothing waits.
 */

const SECOND = 1000;
const TTL_HOURS = 1;
const TTL_MS = TTL_HOURS * 60 * 60 * SECOND;
const SKEW_SECONDS = 30;
const BUDGET_MS = replayFenceBudgetMs(SKEW_SECONDS);
const BUDGET_S = BUDGET_MS / SECOND;
const TTL_S = TTL_MS / SECOND;

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

describe('the one forget rule', () => {
  let w: Wiring;
  const organizations: string[] = [];
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

  const replica = (offsetSeconds: number, prisma = w.prisma): ReplicaStore =>
    new ReplicaStore(prisma, env, offsetSeconds * SECOND, truth);
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
  const ms = (date: Date | null | undefined): number | null => (date ? date.getTime() : null);
  const create = (
    service: ProjectService,
    organizationId: string,
    key: string,
    deadlineSeconds: number | undefined,
    userId = author,
    dto = PROJECT,
  ) =>
    asAdmin(
      organizationId,
      () =>
        service.create(
          dto,
          key,
          deadlineSeconds === undefined ? undefined : base + deadlineSeconds * SECOND,
        ),
      userId,
    );
  const codeOf = async (promise: Promise<unknown>): Promise<string> =>
    promise.then(
      () => 'OK',
      (error: { code?: string }) => error.code ?? 'ERROR',
    );

  /**
   * Interleaving harness: a store whose Nth claim-side transaction parks until released. `reached`
   * settles when it parks; `calls()` counts the transactions the claim opened.
   */
  const gatedPrisma = (parkAt: number) => {
    const gated = Object.create(w.prisma) as typeof w.prisma;
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let reach!: () => void;
    const reached = new Promise<void>((resolve) => (reach = resolve));
    gated.transaction = (async (fn: never, opts: never) => {
      calls += 1;
      if (calls === parkAt) {
        reach();
        await gate;
      }
      return w.prisma.transaction(fn, opts);
    }) as typeof w.prisma.transaction;
    return { prisma: gated, release: () => release(), reached, calls: () => calls };
  };

  describe('(a) reviewer instance 1, rebuilt with accepted inputs: a mismatched claimant forgets nothing', () => {
    // r5 clocks: replica A reads true − 30, replica B true + 30. The largest header A accepts is
    // 3 570 − B = 3 503 s of true time zero (the r6 value 3 555 is no longer ACCEPTED).
    const HEADER = 3503;

    it.each([
      ['a different actor', 'actor'],
      ['a different body', 'body'],
      ['a different actor, no header', 'actor-headerless'],
      ['a different body, no header', 'body-headerless'],
    ])(
      '%s at true 3 550 on the +30 replica: nothing is deleted, no second project',
      async (_name, kind) => {
        const a = org();
        const stranger = newUserId();
        const original = serviceOver(replica(-30));
        at(0);
        const first = await create(original, a, 'k', HEADER);
        const rowBefore = await keyRow(a, 'k');
        expect(ms(rowBefore?.expiresAt)).toBe(base - 30 * SECOND + TTL_MS); // 3 570
        expect(ms(rowBefore?.replayDeadlineAt)).toBe(base + HEADER * SECOND);

        // B parks before its THIRD transaction — the insert after a delete — if it ever gets there.
        const gate = gatedPrisma(3);
        const b = serviceOver(replica(+30, gate.prisma));
        at(3550); // B reads 3 580 ≥ 3 570: the r6 deletion time
        const header = kind.endsWith('headerless') ? undefined : HEADER + 100;
        const dto = kind.startsWith('body') ? { ...PROJECT, title: 'A different title' } : PROJECT;
        const user = kind.startsWith('actor') ? stranger : author;
        const outcome = create(b, a, 'k', header, user, dto).then(
          () => 'OK',
          (error: { code?: string }) => error.code ?? 'ERROR',
        );
        const settled = outcome.then(() => 'settled');
        expect(await Promise.race([gate.reached.then(() => 'parked'), settled])).toBe('settled');
        expect(await outcome).toBe('IDEMPOTENCY_KEY_REUSED');
        // One transaction: the failed insert. No delete was attempted at all.
        expect(gate.calls()).toBe(1);
        gate.release();
        expect(await keyRow(a, 'k')).toEqual(rowBefore);

        // The original retry on a −30 replica (reads 3 520, past its own 3 503): refused, not run again.
        expect(await codeOf(create(serviceOver(replica(-30)), a, 'k', HEADER))).toBe(
          'REPLAY_WINDOW_CLOSED',
        );
        expect(await projectsOf(a)).toEqual([expect.objectContaining({ id: first.id })]);
        expect(await keyRow(a, 'k')).toEqual(rowBefore);
      },
    );
  });

  describe('(b) reviewer instance 2: the header is bounded at first contact', () => {
    it('ten years ahead is refused before any claim; exactly now + TTL − B is accepted, +1 ms refused', async () => {
      const a = org();
      at(0);
      const service = serviceOver(replica(0));
      const limit = TTL_S - BUDGET_S;

      expect(await codeOf(create(service, a, 'ten', 10 * 365 * 24 * 3600))).toBe(
        'VALIDATION_FAILED',
      );
      expect(await keyRow(a, 'ten')).toBeNull();

      await asAdmin(a, () => service.create(PROJECT, 'edge', base + limit * SECOND), author);
      expect(ms((await keyRow(a, 'edge'))?.replayDeadlineAt)).toBe(base + limit * SECOND);
      expect(
        await codeOf(
          asAdmin(a, () => service.create(PROJECT, 'edge+1', base + limit * SECOND + 1), author),
        ),
      ).toBe('VALIDATION_FAILED');
      expect(await keyRow(a, 'edge+1')).toBeNull();
      expect(await projectsOf(a)).toHaveLength(1);
    });
  });

  describe('(c) the purge-then-replay sequence', () => {
    it('legal purge, then the identical resend with the original header: REPLAY_WINDOW_CLOSED, no project', async () => {
      const a = org();
      const service = serviceOver(replica(0));
      at(0);
      // The largest header the replica accepts: the worst case for the sequence.
      const header = TTL_S - BUDGET_S;
      await create(service, a, 'seq', header);
      expect(await projectsOf(a)).toHaveLength(1);

      at(TTL_S + BUDGET_S + 0.001); // expiresAt < now − B by a millisecond
      expect(await replica(0).purgeExpired()).toBeGreaterThanOrEqual(1);
      expect(await keyRow(a, 'seq')).toBeNull();

      expect(await codeOf(create(service, a, 'seq', header))).toBe('REPLAY_WINDOW_CLOSED');
      expect(await projectsOf(a)).toHaveLength(1);
    });

    it('the guarantee’s boundary: a NEW header for the same key after a legal forget is a new request by that user', async () => {
      const a = org();
      const service = serviceOver(replica(0));
      at(0);
      await create(service, a, 'again', 600);
      at(TTL_S + BUDGET_S + 1);
      await replica(0).purgeExpired();
      // Same actor, same body, a header chosen now: accepted as a first claim. Not a duplicate of the
      // old request — the old header is the only thing the fence can pin to it.
      await create(service, a, 'again', TTL_S + BUDGET_S + 1000);
      expect(await projectsOf(a)).toHaveLength(2);
      expect(await codeOf(create(service, a, 'again', 600))).toBe('REPLAY_WINDOW_CLOSED');
    });
  });

  describe('the reclaim and the purge agree with mayForget on the boundary (real PostgreSQL)', () => {
    it('forgettableWhere (SQL) and mayForget (TypeScript) select the same rows over a boundary grid', async () => {
      const a = org();
      at(0);
      const now = base;
      const offsets = [-BUDGET_MS - 1, -BUDGET_MS, -BUDGET_MS + 1, -1, 0, 1, BUDGET_MS];
      const rows: { key: string; expiresAt: Date; replayDeadlineAt: Date | null }[] = [];
      for (const [i, offset] of offsets.entries()) {
        rows.push({ key: `null-${i}`, expiresAt: new Date(now + offset), replayDeadlineAt: null });
        rows.push({
          key: `dl-${i}`,
          expiresAt: new Date(now + offset),
          replayDeadlineAt: new Date(now + offset - BUDGET_MS),
        });
      }
      await runUnscoped('seed the boundary grid', () =>
        w.prisma.client.idempotencyKey.createMany({
          data: rows.map((r) => ({
            organizationId: a,
            endpoint: CREATE_PROJECT_ENDPOINT,
            key: r.key,
            requestHash: 'x',
            claimToken: `t-${r.key}`,
            state: 'COMPLETED' as const,
            expiresAt: r.expiresAt,
            replayDeadlineAt: r.replayDeadlineAt,
            responseStatus: 201,
            responseBody: {},
            resourceId: 'PRJ_SEEDED',
          })),
        }),
      );
      const bySql = (
        await runUnscoped('select by the forget predicate', () =>
          w.prisma.client.idempotencyKey.findMany({
            where: { organizationId: a, ...forgettableWhere(now, BUDGET_MS) },
          }),
        )
      )
        .map((r) => r.key)
        .sort();
      const byTs = rows
        .filter((r) => mayForget(r, now, BUDGET_MS))
        .map((r) => r.key)
        .sort();
      expect(bySql).toEqual(byTs);
      // And the grid is not trivial: both rules and both sides of each boundary are present.
      expect(byTs).toEqual(
        expect.arrayContaining(['null-0', 'null-4', 'null-3', 'dl-0']), // null: ≤ now; deadline: < now − B
      );
      expect(byTs).not.toContain('null-5');
      expect(byTs).not.toContain('dl-1'); // expiresAt == now − B: kept
      expect(byTs).not.toContain('dl-4');
    });
  });

  describe('(E) nondisclosure: both mismatch dimensions, headerless, the boundary, another tenant', () => {
    const KINDS = [
      ['another actor, with a header', 'actor', true],
      ['another actor, headerless', 'actor', false],
      ['another body, with a header', 'body', true],
      ['another body, headerless', 'body', false],
    ] as const;

    it.each(KINDS)(
      '%s: IDEMPOTENCY_KEY_REUSED until expiresAt + B (inclusive), then the key is theirs; the error carries nothing stored',
      async (_name, dimension, withHeader) => {
        const a = org();
        const service = serviceOver(replica(0));
        at(0);
        await create(service, a, 'nd', 600);
        const row = await keyRow(a, 'nd');
        const dto = dimension === 'body' ? { ...PROJECT, title: 'Another title' } : PROJECT;
        const user = dimension === 'actor' ? newUserId() : author;
        const header = (secondsNow: number) => (withHeader ? secondsNow + 1000 : undefined);

        // Live key, past the stored deadline, at expiresAt, at expiresAt + B exactly: the same answer.
        for (const t of [400, TTL_S, TTL_S + BUDGET_S]) {
          at(t);
          const error = await create(service, a, 'nd', header(t), user, dto).then(
            () => null,
            (e: unknown) => e as { code: string; message: string },
          );
          expect(error).toMatchObject({
            code: 'IDEMPOTENCY_KEY_REUSED',
            message: 'This Idempotency-Key was already used with a different request body',
          });
          const text = JSON.stringify({ ...error, stack: undefined });
          expect(text).not.toContain(String(ms(row?.replayDeadlineAt)));
          expect(text).not.toContain(String(ms(row?.expiresAt)));
          expect(text).not.toContain(row!.requestHash);
          expect(await keyRow(a, 'nd')).toEqual(row);
        }

        // One millisecond past expiresAt + B the row may be forgotten: the claim is the stranger's.
        trueMs = base + (TTL_S + BUDGET_S) * SECOND + 1;
        const theirs = await create(
          service,
          a,
          'nd',
          withHeader ? TTL_S + BUDGET_S + 1000 : undefined,
          user,
          dto,
        );
        expect(theirs.status).toBe('DRAFT');
        expect(await projectsOf(a)).toHaveLength(2);
      },
    );

    it('another tenant’s identical key never meets the row, whatever its age, and leaves it alone', async () => {
      const a = org();
      const b = org();
      const service = serviceOver(replica(0));
      at(0);
      await create(service, a, 'shared', 600);
      const row = await keyRow(a, 'shared');
      at(100);
      await create(service, b, 'shared', 1000); // B's own first claim, with its own deadline
      const rowB = await keyRow(b, 'shared');
      for (const t of [1100, TTL_S + 5, TTL_S + BUDGET_S + 1]) {
        at(t);
        // B's own retry meets B's own row (stored deadline 1000 has passed) — never A's.
        expect(await codeOf(create(service, b, 'shared', t + 1000))).toBe('REPLAY_WINDOW_CLOSED');
        expect(await keyRow(a, 'shared')).toEqual(row);
        expect(await keyRow(b, 'shared')).toEqual(rowB);
      }
      expect(await projectsOf(a)).toHaveLength(1);
      expect(await projectsOf(b)).toHaveLength(1);
    });
  });

  describe('(D) atomicity: the rule rides in the DELETE’s own WHERE, with the tenant and the token', () => {
    const seedExpired = (organizationId: string, key: string, hash: string) =>
      runUnscoped('seed an expired record without a deadline', () =>
        w.prisma.client.idempotencyKey.create({
          data: {
            organizationId,
            endpoint: CREATE_PROJECT_ENDPOINT,
            key,
            requestHash: hash,
            claimToken: `old-${key}`,
            state: 'IN_PROGRESS',
            expiresAt: new Date(base - 10 * SECOND),
          },
        }),
      );

    it('a row replaced between the read and the delete is not deleted: the stranger meets the new one', async () => {
      const a = org();
      at(0);
      await seedExpired(a, 'swap', 'old-hash');

      // The stranger parks right before its DELETE (second claim-side transaction).
      const gate = gatedPrisma(2);
      const stranger = serviceOver(replica(0, gate.prisma));
      const outcome = codeOf(create(stranger, a, 'swap', undefined, newUserId()));
      await gate.reached;

      // Meanwhile the old row is replaced by a fresh claim of somebody else (new token, live expiry).
      await runUnscoped('replace the row behind the stranger', async () => {
        await w.prisma.client.idempotencyKey.deleteMany({
          where: { organizationId: a, endpoint: CREATE_PROJECT_ENDPOINT, key: 'swap' },
        });
        await w.prisma.client.idempotencyKey.create({
          data: {
            organizationId: a,
            endpoint: CREATE_PROJECT_ENDPOINT,
            key: 'swap',
            requestHash: 'fresh-hash',
            claimToken: 'fresh-token',
            state: 'IN_PROGRESS',
            expiresAt: new Date(base + TTL_MS),
          },
        });
      });
      gate.release();

      expect(await outcome).toBe('IDEMPOTENCY_KEY_REUSED');
      expect(await keyRow(a, 'swap')).toMatchObject({ claimToken: 'fresh-token' });
      expect(await projectsOf(a)).toEqual([]);
    });

    it('a delete re-states the rule: the same token whose row was renewed (expiry moved) is not deleted', async () => {
      const a = org();
      at(0);
      await seedExpired(a, 'renew', 'old-hash');
      const gate = gatedPrisma(2);
      const stranger = serviceOver(replica(0, gate.prisma));
      const outcome = codeOf(create(stranger, a, 'renew', undefined, newUserId()));
      await gate.reached;
      // Same token, same row — but it is no longer forgettable.
      await runUnscoped('renew the expiry of the same row', () =>
        w.prisma.client.idempotencyKey.updateMany({
          where: { organizationId: a, endpoint: CREATE_PROJECT_ENDPOINT, key: 'renew' },
          data: { expiresAt: new Date(base + TTL_MS) },
        }),
      );
      gate.release();
      expect(await outcome).toBe('IDEMPOTENCY_KEY_REUSED');
      expect(await keyRow(a, 'renew')).toMatchObject({ claimToken: 'old-renew' });
    });

    it('the rule is decided on the row as it is at delete time: a null-deadline row that gains a deadline meanwhile is kept', async () => {
      const a = org();
      at(0);
      await seedExpired(a, 'gains', 'old-hash'); // expired 10 s ago, no deadline: forgettable at read
      const gate = gatedPrisma(2);
      const stranger = serviceOver(replica(0, gate.prisma));
      const outcome = codeOf(create(stranger, a, 'gains', undefined, newUserId()));
      await gate.reached;
      // Same token, same expiry — but now it carries a deadline, so expiresAt < now − B is the rule.
      await runUnscoped('give the same row a deadline', () =>
        w.prisma.client.idempotencyKey.updateMany({
          where: { organizationId: a, endpoint: CREATE_PROJECT_ENDPOINT, key: 'gains' },
          data: { replayDeadlineAt: new Date(base - 20 * SECOND) },
        }),
      );
      gate.release();
      expect(await outcome).toBe('IDEMPOTENCY_KEY_REUSED');
      expect(await keyRow(a, 'gains')).toMatchObject({ claimToken: 'old-gains' });
    });

    it('completion rollback: the work holding the row rolls back; a row that may not be forgotten stays, and the queued stranger is refused', async () => {
      const a = org();
      const store = replica(0);
      at(0);
      const body = { n: 1 };
      const claim = await asAdmin(a, () =>
        store.claim(CREATE_PROJECT_ENDPOINT, 'hold', body, undefined, base + 600 * SECOND),
      );
      if (claim.kind !== 'PROCEED') throw new Error('expected a first claim');
      const rowBefore = await keyRow(a, 'hold');

      // The work's transaction locks the row (its completion), then rolls back.
      let locked!: () => void;
      const holding = new Promise<void>((resolve) => (locked = resolve));
      let finish!: () => void;
      const done = new Promise<void>((resolve) => (finish = resolve));
      const work = asAdmin(a, () =>
        w.prisma
          .transaction(async (tx) => {
            await store.complete(tx, claim.claim, 201, 'PRJ_X', { id: 'PRJ_X' });
            locked();
            await done;
            throw new Error('rollback');
          })
          .catch(() => 'rolled back'),
      );
      await holding;

      // A stranger arrives while the lock is held, past the stored deadline. Its INSERT queues behind
      // the work's lock (as it always did); it must not turn into a delete when the lock goes.
      at(700);
      const stranger = codeOf(
        asAdmin(a, () => store.claim(CREATE_PROJECT_ENDPOINT, 'hold', { n: 2 }), newUserId()),
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      finish();
      expect(await work).toBe('rolled back');
      // The row (IN_PROGRESS, deadline 600 s, expiry 3 600 s) may not be forgotten at 700 s.
      expect(await stranger).toBe('IDEMPOTENCY_KEY_REUSED');
      expect(await keyRow(a, 'hold')).toEqual(rowBefore);
    });

    it('completion commit: the work completes while a stranger’s reclaim is queued; the completed row of a null-deadline key follows today’s rule', async () => {
      const a = org();
      const store = replica(0);
      at(0);
      // A first claim without a deadline that EXPIRES under the work: the old rule, unchanged.
      await seedExpired(a, 'commit', 'old-hash');
      const row = await keyRow(a, 'commit');
      expect(row?.replayDeadlineAt).toBeNull();
      const claimToken = row!.claimToken;

      let locked!: () => void;
      const holding = new Promise<void>((resolve) => (locked = resolve));
      let finish!: () => void;
      const done = new Promise<void>((resolve) => (finish = resolve));
      const work = asAdmin(a, () =>
        w.prisma.transaction(async (tx) => {
          await store.complete(
            tx,
            {
              organizationId: a,
              endpoint: CREATE_PROJECT_ENDPOINT,
              key: 'commit',
              token: claimToken,
            },
            201,
            'PRJ_Y',
            { id: 'PRJ_Y' },
          );
          locked();
          await done;
        }),
      );
      await holding;
      const stranger = codeOf(
        asAdmin(a, () => store.claim(CREATE_PROJECT_ENDPOINT, 'commit', { n: 3 }), newUserId()),
      );
      finish();
      await work;
      // The queued delete re-evaluates its WHERE on the committed row: still expired, null deadline.
      expect(await stranger).toBe('OK');
    });
  });
});
