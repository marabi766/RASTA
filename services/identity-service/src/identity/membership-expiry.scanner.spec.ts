import {
  MAX_BACKOFF_INTERVALS,
  MAX_PAGES_PER_PASS,
  MembershipExpiryScanner,
} from './membership-expiry.scanner';
import type { IdentityRepository } from './identity.repository';
import type { IdentityService } from './identity.service';
import type { KeycloakProjector } from '../keycloak/keycloak.projector';
import type { KeycloakWriteFences } from '../keycloak/keycloak-write-fence';
import { membershipLapseFailuresTotal } from '../observability/keycloak-projection.metrics';

/**
 * The sweep that notices a validUntil passing (ADR-060 § 5), and re-asserts
 * users with a Keycloak write fence past takeover (D-069). What it decides
 * lives in `IdentityService.expireLapsedMembership` and the projector; what is
 * asserted here is that a pass visits what it finds with one selection clock;
 * survives any one item failing; makes **fair progress across passes** — a
 * failing prefix of any length never hides the items behind it (#402 r1 F2):
 * durable retry eligibility plus a cursor that continues across passes and
 * wraps round — and that a stop cancels the pass and nothing it would have
 * done next reaches the store once the stop returned (#402 r1 F4).
 *
 * The store is a model of the two queries' contracts — eligibility by retry
 * time on a database clock the test moves, keyset bounds `after`/`until` —
 * with the retry state kept in the rows, as the database keeps it.
 */
describe('MembershipExpiryScanner', () => {
  const now = new Date('2026-10-01T00:01:00.000Z');
  const INTERVAL_SECONDS = 60;

  interface Row {
    id: string;
    userId: string;
    organizationId: string;
    validUntil: Date;
  }
  const lapse = (n: number, userId = `USR_${n}`): Row => ({
    id: `MBR_${String(n).padStart(3, '0')}`,
    userId,
    organizationId: n % 2 ? 'ORG-A' : 'ORG-B',
    validUntil: new Date(n),
  });

  /** The two tables the sweep reads, as the database answers them. */
  function model(rows: Row[], dueUsers: string[] = []) {
    const db = {
      /** The database's clock, in ms. */
      clock: now.getTime(),
      handled: new Set<string>(),
      claimed: new Set<string>(),
      lapseRetry: new Map<string, { failures: number; retryAt: number }>(),
      fence: new Map<string, { failures: number; nextAt: number }>(
        dueUsers.map((userId) => [userId, { failures: 0, nextAt: 0 }]),
      ),
    };
    const key = (row: Row) => [row.validUntil.getTime(), row.id] as const;
    const after = (row: Row, bound: { validUntil: Date | null; id: string } | null) =>
      !bound?.validUntil ||
      key(row)[0] > bound.validUntil.getTime() ||
      (key(row)[0] === bound.validUntil.getTime() && row.id > bound.id);
    const upTo = (row: Row, bound: { validUntil: Date | null; id: string } | null) =>
      !bound?.validUntil ||
      key(row)[0] < bound.validUntil.getTime() ||
      (key(row)[0] === bound.validUntil.getTime() && row.id <= bound.id);
    const eligible = () =>
      rows
        .filter((row) => !db.handled.has(row.id))
        .filter((row) => (db.lapseRetry.get(row.id)?.retryAt ?? 0) <= db.clock);

    const repository = {
      findLapsedMemberships: jest.fn(
        async (
          at: Date,
          take: number,
          from: { validUntil: Date | null; id: string } | null = null,
          until: { validUntil: Date | null; id: string } | null = null,
        ) =>
          eligible()
            .filter((row) => row.validUntil <= at && after(row, from) && upTo(row, until))
            .sort(
              (a, b) => a.validUntil.getTime() - b.validUntil.getTime() || (a.id < b.id ? -1 : 1),
            )
            .slice(0, take),
      ),
      deferLapse: jest.fn(async (id: string, interval: number, max: number) => {
        const failures = (db.lapseRetry.get(id)?.failures ?? 0) + 1;
        db.lapseRetry.set(id, {
          failures,
          retryAt: db.clock + interval * 1000 * Math.min(2 ** failures, max),
        });
      }),
      countLapsedMemberships: jest.fn(async () => rows.filter((r) => !db.handled.has(r.id)).length),
    };
    const fences = {
      dueUsers: jest.fn(async (from: string | null, take: number, until: string | null = null) =>
        [...db.fence.entries()]
          .filter(([, state]) => state.nextAt <= db.clock)
          .map(([userId]) => userId)
          .filter(
            (userId) => (from === null || userId > from) && (until === null || userId <= until),
          )
          .sort()
          .slice(0, take),
      ),
      deferReassert: jest.fn(async (userId: string, interval: number, max: number) => {
        const state = db.fence.get(userId);
        if (!state) return;
        state.failures += 1;
        state.nextAt = db.clock + interval * 1000 * Math.min(2 ** state.failures, max);
      }),
      /** The late senders' owed fences (D-070 D): nothing owed here. */
      recoverOwed: jest.fn(async () => 0),
    };
    return { db, repository, fences };
  }

  function scannerWith(
    expire: (membership: Row, at: Date, options: { signal?: AbortSignal }) => Promise<boolean>,
    rows: Row[] = [lapse(1), lapse(2), lapse(3)],
    options: {
      batchSize?: number;
      due?: string[];
      project?: (userId: string, options: { signal?: AbortSignal }) => Promise<string>;
      store?: ReturnType<typeof model>;
    } = {},
  ) {
    const store = options.store ?? model(rows, options.due);
    const identity = {
      expireLapsedMembership: jest.fn(
        async (membership: Row, at: Date, opts: { signal?: AbortSignal } = {}) => {
          // The claim: one replica acts on a lapse, whoever comes first; a
          // failure rolls the claim back with the rest of its transaction.
          if (store.db.handled.has(membership.id) || store.db.claimed.has(membership.id)) {
            return false;
          }
          store.db.claimed.add(membership.id);
          try {
            const acted = await expire(membership, at, opts);
            if (acted) store.db.handled.add(membership.id);
            return acted;
          } finally {
            store.db.claimed.delete(membership.id);
          }
        },
      ),
    };
    const projector = {
      project: jest.fn(
        async (userId: string, _trigger: string, opts: { signal?: AbortSignal } = {}) => {
          const outcome = await (options.project ?? (async () => 'projected'))(userId, opts);
          store.db.fence.delete(userId);
          return outcome;
        },
      ),
    };
    const scanner = new MembershipExpiryScanner(
      store.repository as unknown as IdentityRepository,
      identity as unknown as IdentityService,
      { enabled: true, intervalSeconds: INTERVAL_SECONDS, batchSize: options.batchSize ?? 50 },
      projector as unknown as Pick<KeycloakProjector, 'project'>,
      store.fences as unknown as Pick<
        KeycloakWriteFences,
        'dueUsers' | 'deferReassert' | 'recoverOwed'
      >,
    );
    return { scanner, identity, projector, ...store };
  }

  const failing = (ids: Set<string>) => async (membership: Row) => {
    if (ids.has(membership.id)) throw new Error('KEYCLOAK_UNAVAILABLE');
    return true;
  };

  it('selects lapses as of one clock and hands each that clock and the stop signal', async () => {
    const expire = jest.fn(async (_m: Row, _at: Date, _opts: { signal?: AbortSignal }) => true);
    const { scanner, repository } = scannerWith(expire);

    await expect(scanner.scan(now)).resolves.toBe(3);
    expect(repository.findLapsedMemberships).toHaveBeenCalledWith(now, 50, null, null);
    expect(expire.mock.calls.map(([m, at, opts]) => [m.id, at, opts.signal])).toEqual([
      ['MBR_001', now, expect.any(AbortSignal)],
      ['MBR_002', now, expect.any(AbortSignal)],
      ['MBR_003', now, expect.any(AbortSignal)],
    ]);
  });

  it('counts only the lapses it claimed', async () => {
    const { scanner } = scannerWith(async (membership) => membership.id !== 'MBR_002');
    await expect(scanner.scan(now)).resolves.toBe(2);
  });

  it('keeps going past a lapse it could not handle, and defers that one in its row', async () => {
    const expire = jest.fn(failing(new Set(['MBR_002'])));
    const { scanner, repository } = scannerWith(expire);

    await expect(scanner.scan(now)).resolves.toBe(2);
    expect(expire).toHaveBeenCalledTimes(3);
    expect(repository.deferLapse).toHaveBeenCalledWith(
      'MBR_002',
      INTERVAL_SECONDS,
      MAX_BACKOFF_INTERVALS,
    );
  });

  it('never throws, even when the lapse query fails', async () => {
    const { scanner, repository } = scannerWith(jest.fn());
    repository.findLapsedMemberships.mockRejectedValueOnce(new Error('connection reset'));
    await expect(scanner.scan(now)).resolves.toBe(0);
  });

  it('never runs two passes at once', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const expire = jest.fn(async () => {
      await gate;
      return true;
    });
    const { scanner } = scannerWith(expire);
    const first = scanner.scan(now);
    await expect(scanner.scan(now)).resolves.toBe(0);
    release();
    await expect(first).resolves.toBe(3);
  });

  describe('fair progress across passes (#402 r1 F2)', () => {
    it('a failing prefix longer than the page cap never hides the healthy lapse behind it', async () => {
      // batchSize 1, MAX_PAGES_PER_PASS pages: one pass could reach at most
      // that many lapses. A prefix of failing lapses three times as long.
      const prefix = MAX_PAGES_PER_PASS * 3;
      const rows = Array.from({ length: prefix + 1 }, (_, i) => lapse(i + 1));
      const healthy = rows.at(-1)!.id;
      const expire = jest.fn(failing(new Set(rows.slice(0, prefix).map((row) => row.id))));
      const { scanner, db } = scannerWith(expire, rows, { batchSize: 1 });

      // The database clock never moves: no failed lapse becomes eligible again.
      for (let pass = 0; pass < prefix + 1 && !db.handled.has(healthy); pass += 1) {
        await scanner.scan(now);
      }
      expect(db.handled.has(healthy)).toBe(true);
      // Each failing lapse was tried exactly once, then sat out its backoff.
      expect(expire.mock.calls.filter(([m]) => m.id !== healthy)).toHaveLength(prefix);
    });

    it('even when every failing lapse is eligible again each pass, the cursor reaches the healthy one', async () => {
      const prefix = MAX_PAGES_PER_PASS * 3;
      const rows = Array.from({ length: prefix + 1 }, (_, i) => lapse(i + 1));
      const healthy = rows.at(-1)!.id;
      const expire = jest.fn(failing(new Set(rows.slice(0, prefix).map((row) => row.id))));
      const { scanner, db } = scannerWith(expire, rows, { batchSize: 1 });

      let passes = 0;
      while (!db.handled.has(healthy) && passes < prefix + 2) {
        await scanner.scan(now);
        passes += 1;
        // Past the longest backoff: every failed lapse may be tried again.
        db.clock += INTERVAL_SECONDS * 1000 * MAX_BACKOFF_INTERVALS + 1;
      }
      expect(db.handled.has(healthy)).toBe(true);
      // Visited in turn, never the oldest again and again: ⌈31 / 1⌉ passes.
      expect(passes).toBe(prefix + 1);
    });

    it('backs a failing lapse off in its row, doubling, capped, and never gives it up', async () => {
      const rows = [lapse(1)];
      const { scanner, db, repository } = scannerWith(failing(new Set(['MBR_001'])), rows);
      const waits: number[] = [];
      for (let attempt = 0; attempt < 6; attempt += 1) {
        await scanner.scan(now);
        const retryAt = db.lapseRetry.get('MBR_001')!.retryAt;
        waits.push((retryAt - db.clock) / (INTERVAL_SECONDS * 1000));
        db.clock = retryAt;
      }
      expect(waits).toEqual([2, 4, 8, 16, 16, 16]);
      expect(repository.deferLapse).toHaveBeenCalledTimes(6);
    });

    it('survives a restart: the backoff is in the row, so a fresh scanner does not retry sooner', async () => {
      const rows = [lapse(1), lapse(2)];
      const store = model(rows);
      const expire = jest.fn(failing(new Set(['MBR_001'])));
      const first = scannerWith(expire, rows, { batchSize: 1, store });
      await first.scanner.scan(now);
      expect(expire.mock.calls.map(([m]) => m.id)).toEqual(['MBR_001']);

      // A new process: cursor gone, retry state not.
      const second = scannerWith(expire, rows, { batchSize: 1, store });
      await second.scanner.scan(now);
      expect(expire.mock.calls.map(([m]) => m.id)).toEqual(['MBR_001', 'MBR_002']);
      expect(store.db.handled.has('MBR_002')).toBe(true);
    });

    it('two replicas sweeping together: every healthy lapse acted on once, none starved', async () => {
      const rows = Array.from({ length: 12 }, (_, i) => lapse(i + 1));
      const bad = new Set(rows.slice(0, 6).map((row) => row.id));
      const store = model(rows);
      const acted: string[] = [];
      const expire = async (membership: Row) => {
        await new Promise((resolve) => setImmediate(resolve));
        if (bad.has(membership.id)) throw new Error('KEYCLOAK_UNAVAILABLE');
        acted.push(membership.id);
        return true;
      };
      const a = scannerWith(expire, rows, { batchSize: 2, store });
      const b = scannerWith(expire, rows, { batchSize: 2, store });
      for (let pass = 0; pass < 6; pass += 1) {
        await Promise.all([a.scanner.scan(now), b.scanner.scan(now)]);
      }
      expect([...acted].sort()).toEqual(rows.slice(6).map((row) => row.id));
      expect(new Set(acted).size).toBe(acted.length);
    });

    it('wraps round: a lapse that becomes eligible behind the cursor is reached', async () => {
      const rows = [lapse(1), lapse(2), lapse(3), lapse(4)];
      const store = model(rows);
      // MBR_001 fails once, then succeeds.
      let failedOnce = false;
      const expire = jest.fn(async (membership: Row) => {
        if (membership.id === 'MBR_001' && !failedOnce) {
          failedOnce = true;
          throw new Error('KEYCLOAK_UNAVAILABLE');
        }
        // MBR_003 and MBR_004 are not acted on (another replica's claim pending).
        return membership.id === 'MBR_001' || membership.id === 'MBR_002';
      });
      const { scanner, db } = scannerWith(expire, rows, { batchSize: 2, store });

      await scanner.scan(now); // 001 (fails), 002 — cursor after 002
      await scanner.scan(now); // 003, 004 — cursor after 004
      db.clock = db.lapseRetry.get('MBR_001')!.retryAt; // 001 eligible again, behind the cursor
      await scanner.scan(now); // the end, so round from the oldest: 001, 003
      expect(expire.mock.calls.map(([m]) => m.id)).toEqual([
        'MBR_001',
        'MBR_002',
        'MBR_003',
        'MBR_004',
        'MBR_001',
        'MBR_003',
      ]);
      expect(db.handled.has('MBR_001')).toBe(true);
    });

    it('a pass visits each eligible lapse at most once, wrap-round included', async () => {
      const rows = [lapse(1), lapse(2), lapse(3)];
      const expire = jest.fn(async (_m: Row) => false);
      const { scanner } = scannerWith(expire, rows, { batchSize: 2 });
      await scanner.scan(now); // 1, 2
      await scanner.scan(now); // 3, then wrap: 1
      await scanner.scan(now); // 2, 3
      expect(expire.mock.calls.map(([m]) => m.id)).toEqual([
        'MBR_001',
        'MBR_002',
        'MBR_003',
        'MBR_001',
        'MBR_002',
        'MBR_003',
      ]);
      expect(expire.mock.calls.length).toBeLessThanOrEqual(6);
    });

    it('counts each failed attempt, and samples no gauge: the sampler does, on its own timer (#402 r3 R3-2)', async () => {
      const before = (await membershipLapseFailuresTotal.get()).values[0]?.value ?? 0;
      const { scanner, repository } = scannerWith(failing(new Set(['MBR_002'])), undefined, {
        due: ['USR_X'],
      });
      await scanner.scan(now);
      expect((await membershipLapseFailuresTotal.get()).values[0]?.value).toBe(before + 1);
      expect(repository.countLapsedMemberships).not.toHaveBeenCalled();
    });
  });

  describe('re-assertion (D-069)', () => {
    it('projects every user with a fence past takeover, as the reassert trigger, with the stop signal', async () => {
      const { scanner, projector } = scannerWith(async () => true, [], {
        due: ['USR_A', 'USR_B'],
      });
      await scanner.scan(now);
      expect(projector.project.mock.calls).toEqual([
        ['USR_A', 'reassert', { signal: expect.any(AbortSignal) }],
        ['USR_B', 'reassert', { signal: expect.any(AbortSignal) }],
      ]);
    });

    it('a permanently failing user ahead of a healthy one: the healthy one is re-asserted, the failing one deferred', async () => {
      const project = jest.fn(async (userId: string) => {
        if (userId === 'USR_A') throw new Error('KEYCLOAK_UNAVAILABLE');
        return 'projected';
      });
      const { scanner, db, fences } = scannerWith(async () => true, [], {
        batchSize: 1,
        due: ['USR_A', 'USR_B'],
        project,
      });
      await scanner.scan(now);
      await scanner.scan(now);
      expect(project.mock.calls.map(([userId]) => userId)).toEqual(['USR_A', 'USR_B']);
      expect(db.fence.has('USR_B')).toBe(false);
      expect(fences.deferReassert).toHaveBeenCalledWith(
        'USR_A',
        INTERVAL_SECONDS,
        MAX_BACKOFF_INTERVALS,
      );
      // Still there, and tried again once its backoff passes: never dropped.
      db.clock = db.fence.get('USR_A')!.nextAt;
      await scanner.scan(now);
      expect(project.mock.calls.map(([userId]) => userId)).toEqual(['USR_A', 'USR_B', 'USR_A']);
    });

    it('even when the failing user is due again every pass, the cursor reaches the healthy one', async () => {
      const project = jest.fn(async (userId: string) => {
        if (userId === 'USR_A') throw new Error('KEYCLOAK_UNAVAILABLE');
        return 'projected';
      });
      const { scanner, db } = scannerWith(async () => true, [], {
        batchSize: 1,
        due: ['USR_A', 'USR_B'],
        project,
      });
      await scanner.scan(now);
      db.clock += INTERVAL_SECONDS * 1000 * MAX_BACKOFF_INTERVALS + 1;
      await scanner.scan(now);
      expect(project.mock.calls.map(([userId]) => userId)).toEqual(['USR_A', 'USR_B']);
    });

    it('an outcome — account_missing included — is not a failure: nothing deferred (the projector made it terminal)', async () => {
      const { scanner, fences } = scannerWith(async () => true, [], {
        due: ['USR_A'],
        project: async () => 'account_missing',
      });
      await scanner.scan(now);
      expect(fences.deferReassert).not.toHaveBeenCalled();
    });
  });

  /**
   * D-052: an `OutboxShutdown` worker. #402 r1 F4: the stop cancels the pass,
   * and nothing the pass would do next reaches the store once it returned —
   * also when the work in flight **resumes** after the stop gave up on it.
   */
  describe('the stop', () => {
    it('cancels the pass: the signal handed to the lapse in flight aborts, and no further lapse starts', async () => {
      let seen: AbortSignal | undefined;
      const expire = jest.fn(
        (_m: Row, _at: Date, opts: { signal?: AbortSignal }) =>
          new Promise<boolean>((_resolve, reject) => {
            seen = opts.signal;
            opts.signal?.addEventListener('abort', () => reject(opts.signal?.reason));
          }),
      );
      const { scanner, repository } = scannerWith(expire);
      const pass = scanner.scan(now);
      await new Promise((resolve) => setImmediate(resolve));

      await scanner.stop({ deadlineAt: Date.now() + 5000 });
      expect(seen?.aborted).toBe(true);
      await expect(pass).resolves.toBe(0);
      expect(expire).toHaveBeenCalledTimes(1);
      // A cancelled lapse is not a failed one: no retry bookkeeping after the stop.
      expect(repository.deferLapse).not.toHaveBeenCalled();
    });

    it('work that resumes after the stop gave up on it starts nothing further — no query, no gauge, no defer', async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      // Ignores the signal, as a statement waiting on a lock would.
      const expire = jest.fn(async () => {
        await gate;
        throw new Error('KEYCLOAK_UNAVAILABLE');
      });
      const { scanner, repository, fences } = scannerWith(expire, undefined, { due: ['USR_A'] });
      const warn = jest
        .spyOn(
          (scanner as unknown as { logger: { warn: (message: string) => void } }).logger,
          'warn',
        )
        .mockImplementation(() => undefined);

      const pass = scanner.scan(now);
      await new Promise((resolve) => setImmediate(resolve));
      await scanner.stop({ deadlineAt: Date.now() + 100 });
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/abandoned/));
      const callsAtStop = {
        lapses: repository.findLapsedMemberships.mock.calls.length,
        due: fences.dueUsers.mock.calls.length,
      };

      // The work resumes, after shutdown returned.
      release();
      await pass;
      expect(expire).toHaveBeenCalledTimes(1);
      expect(repository.findLapsedMemberships).toHaveBeenCalledTimes(callsAtStop.lapses);
      expect(repository.deferLapse).not.toHaveBeenCalled();
      expect(fences.dueUsers).toHaveBeenCalledTimes(callsAtStop.due);
      expect(fences.dueUsers).not.toHaveBeenCalled();
      // The stop's own flush of owed late fences (D-070 D), before it
      // returned, besides the pass's first one; the resumed pass adds none.
      expect(fences.recoverOwed).toHaveBeenCalledTimes(2);
    });

    it('a stop during re-assertion: the projection is cancelled, and nothing more is read', async () => {
      const project = jest.fn(
        (_userId: string, opts: { signal?: AbortSignal }) =>
          new Promise<string>((_resolve, reject) =>
            opts.signal?.addEventListener('abort', () => reject(opts.signal?.reason)),
          ),
      );
      const { scanner, repository, fences } = scannerWith(async () => true, [], {
        due: ['USR_A', 'USR_B'],
        project,
      });
      const pass = scanner.scan(now);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(project).toHaveBeenCalledTimes(1);
      await scanner.stop({ deadlineAt: Date.now() + 5000 });
      await pass;
      expect(project).toHaveBeenCalledTimes(1);
      expect(fences.deferReassert).not.toHaveBeenCalled();
      expect(repository.countLapsedMemberships).not.toHaveBeenCalled();
      expect(fences.recoverOwed).toHaveBeenCalledTimes(2);
    });

    it('starts no pass once stopping, and a later stop joins the first', async () => {
      const { scanner, repository } = scannerWith(jest.fn(async () => true));
      const first = scanner.stop({ deadlineAt: Date.now() + 1000 });
      expect(scanner.stop()).toBe(first);
      expect(scanner.onApplicationShutdown()).toBe(first);
      await first;

      await expect(scanner.scan(now)).resolves.toBe(0);
      expect(repository.findLapsedMemberships).not.toHaveBeenCalled();
    });

    it('with nothing in flight, returns at once', async () => {
      const { scanner } = scannerWith(jest.fn());
      const startedAt = Date.now();
      await scanner.stop({ deadlineAt: Date.now() + 5000 });
      expect(Date.now() - startedAt).toBeLessThan(100);
    });
  });
  describe('late senders’ owed fences (D-070 option D)', () => {
    it('a pass writes them first, so a due one is re-asserted by that same pass', async () => {
      const order: string[] = [];
      const { scanner, fences, projector } = scannerWith(async () => true, [], { due: ['USR_A'] });
      fences.recoverOwed.mockImplementation(async () => {
        order.push('recoverOwed');
        return 0;
      });
      projector.project.mockImplementation(async () => {
        order.push('project');
        return 'projected';
      });
      await scanner.scan(now);
      expect(order).toEqual(['recoverOwed', 'project']);
    });

    it('a stop writes them before it returns, after the pass unwound — outside the stopped scope', async () => {
      const order: string[] = [];
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const { scanner, fences } = scannerWith(async () => {
        await gate;
        order.push('pass unwound');
        return true;
      });
      fences.recoverOwed.mockImplementation(async () => {
        order.push('recoverOwed');
        return 0;
      });
      const pass = scanner.scan(now);
      await new Promise((resolve) => setImmediate(resolve));
      const stopped = scanner.stop({ deadlineAt: Date.now() + 5_000 }).then(() => {
        order.push('stop returned');
      });
      release();
      await stopped;
      await pass;
      expect(order).toEqual(['recoverOwed', 'pass unwound', 'recoverOwed', 'stop returned']);
    });

    it('a flush that outlives the shutdown deadline does not hold the stop past it', async () => {
      const { scanner, fences } = scannerWith(async () => true, []);
      fences.recoverOwed.mockImplementation(() => new Promise<number>(() => undefined));
      const error = jest
        .spyOn(
          (scanner as unknown as { logger: { error: (message: string) => void } }).logger,
          'error',
        )
        .mockImplementation(() => undefined);
      const started = Date.now();
      await scanner.stop({ deadlineAt: started + 150 });
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(error).toHaveBeenCalledWith(expect.stringMatching(/unknown late Keycloak write fences/));
    });
  });
});
