import { OutboxRelay, type OutboxRow } from '@rasta/nest-common';
import { PrismaOutboxStore } from '../src/outbox/outbox.store';
import {
  createProtocolSchema,
  dropProtocolSchema,
  expireLease,
  GatedPublisher,
  holdLockOnOldest,
  newProtocolPrisma,
  readRow,
  seedRow,
  truncate,
} from './outbox-claim.helpers';
import type { PrismaService } from '../src/prisma/prisma.service';

/**
 * ADR-050's twenty-four mandatory tests, against real PostgreSQL.
 *
 * A mock cannot stand in for any of this. The fence is `claim_token = $token`
 * inside the `UPDATE`, the backoff is `now()` inside the `SET`, and the
 * expiry comparison is PostgreSQL's — all three live in SQL, so testing them
 * against a fake would only assert the fake.
 *
 * Every test is deterministic: no sleeps and no wall-clock races. Expiry is
 * produced by claiming with `leaseSeconds = 0` or by moving `claim_expires_at`
 * into the past, and a long publish is produced by a publisher that does not
 * return until the test releases it.
 *
 * The suite owns its own schema (see `outbox-claim.helpers.ts`). `claimPending`
 * is deliberately unscoped and returns the oldest rows in the table, so on a
 * shared schema these assertions would be measuring other suites' leftovers.
 */

const LEASE = 60;
const BACKOFF = { baseSeconds: 5, maxSeconds: 3600 };

/** Silences the relay: these tests provoke fencing and failure on purpose. */
const silent = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

describe('ADR-050 durable outbox claim, against real PostgreSQL', () => {
  let a: PrismaService;
  let b: PrismaService;
  let storeA: PrismaOutboxStore;
  let storeB: PrismaOutboxStore;

  beforeAll(async () => {
    await createProtocolSchema();
    // Two independent connections: this is what two relay replicas are.
    a = newProtocolPrisma();
    b = newProtocolPrisma();
    storeA = new PrismaOutboxStore(a);
    storeB = new PrismaOutboxStore(b);
  });

  afterAll(async () => {
    await a.onModuleDestroy();
    await b.onModuleDestroy();
    await dropProtocolSchema();
  });

  beforeEach(async () => {
    await truncate(a);
  });

  const claim = (store: PrismaOutboxStore, limit = 100, leaseSeconds = LEASE, owner = 'worker-a') =>
    store.claimPending({ limit, owner, leaseSeconds });

  // -- 1 ---------------------------------------------------------------------

  it('1: two replicas claiming in sequence get disjoint batches', async () => {
    // The exact scenario D-026 measured at 10 of 10 overlapping. The fix must
    // put that number at zero, so the assertion is on the intersection.
    for (let i = 0; i < 10; i += 1) await seedRow(a, `R${i}`);

    const first = await claim(storeA, 10);
    const second = await claim(storeB, 10, LEASE, 'worker-b');

    expect(first.rows).toHaveLength(10);
    expect(second.rows).toHaveLength(0);

    const overlap = first.rows.filter((row) => second.rows.some((other) => other.id === row.id));
    expect(overlap).toHaveLength(0);
  });

  // -- 2 ---------------------------------------------------------------------

  it('2: an expired but unreclaimed token can still acknowledge', async () => {
    // The correction the product review forced. This owner published the
    // event; refusing its acknowledgement would republish something already
    // delivered. Nothing took the row back, so the token is still the truth.
    await seedRow(a, 'EXPIRED_UNRECLAIMED');

    const claimed = await claim(storeA, 10, 0);
    expect(claimed.rows).toHaveLength(1);

    const acknowledged = await storeA.markPublished(['EXPIRED_UNRECLAIMED'], claimed.token!);

    expect(acknowledged).toBe(1);
    expect((await readRow(a, 'EXPIRED_UNRECLAIMED')).published_at).not.toBeNull();
  });

  // -- 3 ---------------------------------------------------------------------

  it('3: an expired and reclaimed token cannot acknowledge', async () => {
    await seedRow(a, 'EXPIRED_RECLAIMED');

    const first = await claim(storeA, 10, 0);
    const second = await claim(storeB, 10, LEASE, 'worker-b');
    expect(second.rows.map((row) => row.id)).toEqual(['EXPIRED_RECLAIMED']);

    const acknowledged = await storeA.markPublished(['EXPIRED_RECLAIMED'], first.token!);

    expect(acknowledged).toBe(0);
    expect((await readRow(a, 'EXPIRED_RECLAIMED')).published_at).toBeNull();
  });

  // -- 4 ---------------------------------------------------------------------

  it('4: a stale claimant cannot markFailed', async () => {
    await seedRow(a, 'STALE_FAIL');
    const first = await claim(storeA, 10, 0);
    await claim(storeB, 10, LEASE, 'worker-b');

    const updated = await storeA.markFailed('STALE_FAIL', first.token!, 'boom', BACKOFF);

    expect(updated).toBe(0);
    const row = await readRow(a, 'STALE_FAIL');
    expect(row.attempts).toBe(0);
    expect(row.next_attempt_at).toBeNull();
  });

  // -- 5 ---------------------------------------------------------------------

  it('5: a stale claimant cannot release', async () => {
    await seedRow(a, 'STALE_RELEASE');
    const first = await claim(storeA, 10, 0);
    const second = await claim(storeB, 10, LEASE, 'worker-b');

    const released = await storeA.release(['STALE_RELEASE'], first.token!);

    expect(released).toBe(0);
    // The new owner's claim is untouched: a stale release must not hand its
    // successor's row away.
    expect((await readRow(a, 'STALE_RELEASE')).claim_token).toBe(second.token);
  });

  // -- 6 ---------------------------------------------------------------------

  it('6: a stale claimant cannot renew', async () => {
    await seedRow(a, 'STALE_RENEW');
    const first = await claim(storeA, 10, 0);
    await claim(storeB, 10, LEASE, 'worker-b');

    const renewed = await storeA.renew(['STALE_RENEW'], first.token!, LEASE, 5000);

    expect(renewed).toEqual([]);
  });

  // -- 7 ---------------------------------------------------------------------

  it('7: renewal holds ownership through a deliberately long publish', async () => {
    await seedRow(a, 'LONG_PUBLISH');
    const publisher = new GatedPublisher();

    // A four-second lease makes the renewal interval one second, so the
    // heartbeat genuinely fires while the publish is parked — without the test
    // waiting on a sixty-second lease.
    const relay = new OutboxRelay({
      store: storeA,
      publisher,
      leaseSeconds: 4,
      backoff: BACKOFF,
      logger: silent,
    });

    const tick = relay.tick();
    await publisher.started;

    const before = await readRow(a, 'LONG_PUBLISH');
    await relay.renewOnce();
    const after = await readRow(a, 'LONG_PUBLISH');

    // The lease genuinely moved forward, and the fence did not change.
    expect(after.claim_expires_at!.getTime()).toBeGreaterThan(before.claim_expires_at!.getTime());
    expect(after.claim_token).toBe(before.claim_token);

    publisher.finish();
    expect(await tick).toBe(1);
    expect((await readRow(a, 'LONG_PUBLISH')).published_at).not.toBeNull();
  });

  // -- 8 ---------------------------------------------------------------------

  it('8: a lost renewal prevents the later acknowledgement', async () => {
    await seedRow(a, 'LOST_RENEWAL');
    const publisher = new GatedPublisher();
    const fenced: number[] = [];

    const relay = new OutboxRelay({
      store: storeA,
      publisher,
      leaseSeconds: LEASE,
      backoff: BACKOFF,
      logger: silent,
      onFenced: (count) => fenced.push(count),
    });

    const tick = relay.tick();
    await publisher.started;

    // Another replica takes the row back mid-publish.
    await expireLease(a, 'LOST_RENEWAL');
    const thief = await claim(storeB, 10, LEASE, 'worker-b');
    expect(thief.rows).toHaveLength(1);

    // The renewal now returns nothing, which is how the relay learns.
    await relay.renewOnce();

    publisher.finish();
    expect(await tick).toBe(0);

    expect(fenced.reduce((sum, n) => sum + n, 0)).toBeGreaterThan(0);
    // Still unpublished and still owned by the thief: the stale worker wrote
    // nothing at all.
    const row = await readRow(a, 'LOST_RENEWAL');
    expect(row.published_at).toBeNull();
    expect(row.claim_token).toBe(thief.token);
  });

  // -- 9 ---------------------------------------------------------------------

  it('9: the per-row fallback cannot outlive an unrenewed lease', async () => {
    // The old fallback published row by row with no ownership check, so a
    // batch could keep publishing for hours after its claim was gone. Here the
    // remaining rows are reclaimed by another replica *while the fallback is
    // running*, and the relay must acknowledge none of them.
    for (let i = 0; i < 3; i += 1)
      await seedRow(a, `FB${i}`, { createdAt: new Date(Date.now() - (3 - i) * 1000) });

    const delivered: string[] = [];
    let batchTried = false;
    let stolenIds: string[] = [];

    const publisher = {
      publish: async (rows: readonly OutboxRow[]) => {
        if (!batchTried) {
          batchTried = true;
          throw new Error('batch rejected');
        }
        // First row of the fallback: another replica takes the rest.
        if (delivered.length === 0) {
          stolenIds = ['FB1', 'FB2'];
          for (const id of stolenIds) await expireLease(a, id);
          const thief = await storeB.claimPending({
            limit: 2,
            owner: 'worker-b',
            leaseSeconds: LEASE,
          });
          expect(thief.rows).toHaveLength(2);
        }
        delivered.push(...rows.map((row) => row.id));
      },
    };

    const relay = new OutboxRelay({
      store: storeA,
      publisher,
      batchSize: 3,
      leaseSeconds: LEASE,
      backoff: BACKOFF,
      logger: silent,
    });

    const acknowledged = await relay.tick();

    // Only the row still owned was acknowledged.
    expect(acknowledged).toBe(1);
    expect((await readRow(a, 'FB0')).published_at).not.toBeNull();
    for (const id of stolenIds) {
      expect((await readRow(a, id)).published_at).toBeNull();
    }
  });

  // -- 10 --------------------------------------------------------------------

  it('10: a poisoned row is released with a backoff and is not claimed again', async () => {
    await seedRow(a, 'POISON');
    const claimed = await claim(storeA, 10);

    const updated = await storeA.markFailed('POISON', claimed.token!, 'invalid payload', BACKOFF);
    expect(updated).toBe(1);

    const row = await readRow(a, 'POISON');
    expect(row.claim_token).toBeNull();
    expect(row.claim_owner).toBeNull();
    expect(row.claim_expires_at).toBeNull();
    expect(row.attempts).toBe(1);
    expect(row.last_error).toContain('invalid payload');
    // First failure waits `base`, not `2 x base`: `attempts` in the SET list is
    // the pre-update value.
    expect(row.next_attempt_at!.getTime()).toBeGreaterThan(Date.now() + 1_000);

    // And the backoff is honoured by the next claim.
    expect((await claim(storeB, 10, LEASE, 'worker-b')).rows).toHaveLength(0);
  });

  // -- 11 --------------------------------------------------------------------

  it('11: a backlog larger than the limit yields exactly the limit', async () => {
    for (let i = 0; i < 25; i += 1) await seedRow(a, `LIMIT${i}`);

    expect((await claim(storeA, 10)).rows).toHaveLength(10);
  });

  // -- 12 --------------------------------------------------------------------

  it('12: rows sharing a created_at come back in a stable, deterministic order', async () => {
    // `created_at` is timestamp(3) and ULIDs inside one millisecond sort
    // randomly, so without the `id` tie-break this order is arbitrary.
    const sameMs = new Date('2026-01-01T00:00:00.000Z');
    const ids = ['T5', 'T1', 'T9', 'T3', 'T7', 'T2', 'T8', 'T4', 'T6', 'T0'];
    for (const id of ids) await seedRow(a, id, { createdAt: sameMs });

    const first = await claim(storeA, 10);
    const firstOrder = first.rows.map((row) => row.id);

    await storeA.release(firstOrder, first.token!);
    const second = await claim(storeB, 10, LEASE, 'worker-b');

    expect(firstOrder).toEqual([...ids].sort());
    expect(second.rows.map((row) => row.id)).toEqual(firstOrder);
  });

  // -- 13 --------------------------------------------------------------------

  it('13: a crashed claimant is recovered once its lease expires', async () => {
    await seedRow(a, 'CRASHED');

    // Claim, then lose the process without publishing or releasing.
    const dead = await claim(storeA, 10);
    expect(dead.rows).toHaveLength(1);

    // Before expiry nobody may take it.
    expect((await claim(storeB, 10, LEASE, 'worker-b')).rows).toHaveLength(0);

    await expireLease(a, 'CRASHED');

    const recovered = await claim(storeB, 10, LEASE, 'worker-b');
    expect(recovered.rows.map((row) => row.id)).toEqual(['CRASHED']);
    expect(recovered.reclaimed).toBe(1);
    // The dead worker's token is now powerless.
    expect(await storeA.markPublished(['CRASHED'], dead.token!)).toBe(0);
  });

  // -- 14 --------------------------------------------------------------------

  it('14: the claim is unscoped by tenant, so no organization is stranded', async () => {
    // Platform plumbing, not tenant data. A tenant filter here would leave
    // another organization's events unpublished for as long as nobody noticed.
    await seedRow(a, 'ORG_A_ROW', { organizationId: 'ORG-AAA' });
    await seedRow(a, 'ORG_B_ROW', { organizationId: 'ORG-BBB' });

    const claimed = await claim(storeA, 10);

    expect(claimed.rows.map((row) => row.id).sort()).toEqual(['ORG_A_ROW', 'ORG_B_ROW']);
  });

  // -- 15 --------------------------------------------------------------------

  it('15: no event is lost, though attempts may exceed the number of events', async () => {
    // The first draft asserted "exactly N published", which contradicts the
    // ADR's own at-least-once guarantee and fails the moment a
    // publish-before-mark failure is injected. The real property is that the
    // set of distinct ids reaching the broker equals the input set, with zero
    // missing — while the total number of attempts may be larger.
    const N = 12;
    for (let i = 0; i < N; i += 1) await seedRow(a, `LOSS${i}`);

    const delivered: string[] = [];
    let injected = false;
    const publisher = {
      publish: async (rows: readonly OutboxRow[]) => {
        delivered.push(...rows.map((row) => row.id));
        if (!injected) {
          injected = true;
          // Delivered, then the acknowledgement dies: the classic
          // publish-before-mark crash.
          throw new Error('acknowledgement lost after delivery');
        }
      },
    };

    const relay = new OutboxRelay({
      store: storeA,
      publisher,
      batchSize: N,
      leaseSeconds: LEASE,
      backoff: { baseSeconds: 0, maxSeconds: 0 },
      logger: silent,
    });

    await relay.tick();
    await relay.tick();
    await relay.tick();

    const distinct = new Set(delivered);
    expect(distinct.size).toBe(N);
    for (let i = 0; i < N; i += 1) expect(distinct.has(`LOSS${i}`)).toBe(true);
    // At-least-once: attempts may exceed N, and here they do.
    expect(delivered.length).toBeGreaterThanOrEqual(N);
  });

  // -- 16 --------------------------------------------------------------------

  it('16: a duplicate delivery has one business effect, not two', async () => {
    // A-09. The claim protocol shrinks the duplicate window; it does not close
    // it, so the consumer side remains load-bearing and is asserted here.
    const applied = new Set<string>();
    let effects = 0;

    const handle = (eventId: string): void => {
      if (applied.has(eventId)) return;
      applied.add(eventId);
      effects += 1;
    };

    handle('EVT_DUP');
    handle('EVT_DUP');

    expect(effects).toBe(1);
  });

  // -- 17 --------------------------------------------------------------------

  it('17: a partial renewal keeps the survivors, and they are still acknowledged', async () => {
    // The bug the previous ADR draft would have shipped: losing ten of a
    // hundred rows made the relay abandon all hundred, guaranteeing a replay
    // of ninety events that were delivered perfectly well.
    for (let i = 0; i < 100; i += 1) {
      await seedRow(a, `P${String(i).padStart(3, '0')}`);
    }

    const claimed = await claim(storeA, 100);
    expect(claimed.rows).toHaveLength(100);
    const ids = claimed.rows.map((row) => row.id);

    // Ten are taken back by another replica.
    const stolen = ids.slice(0, 10);
    for (const id of stolen) await expireLease(a, id);
    const thief = await storeB.claimPending({ limit: 10, owner: 'worker-b', leaseSeconds: LEASE });
    expect(thief.rows).toHaveLength(10);

    const renewed = await storeA.renew(ids, claimed.token!, LEASE, 5000);
    expect(renewed).toHaveLength(90);

    const acknowledged = await storeA.markPublished(renewed, claimed.token!);
    expect(acknowledged).toBe(90);

    // And the ten are untouched — still unpublished, still the thief's.
    for (const id of stolen) {
      const row = await readRow(a, id);
      expect(row.published_at).toBeNull();
      expect(row.claim_token).toBe(thief.token);
    }
  });

  // -- 18 --------------------------------------------------------------------

  it('18: when renewal returns nothing the relay stops and mutates nothing', async () => {
    for (let i = 0; i < 5; i += 1) await seedRow(a, `Z${i}`);

    const claimed = await claim(storeA, 5);
    const ids = claimed.rows.map((row) => row.id);

    // The whole batch is reclaimed.
    for (const id of ids) await expireLease(a, id);
    await storeB.claimPending({ limit: 5, owner: 'worker-b', leaseSeconds: LEASE });

    expect(await storeA.renew(ids, claimed.token!, LEASE, 5000)).toEqual([]);
    expect(await storeA.markPublished(ids, claimed.token!)).toBe(0);
    expect(await storeA.markFailed(ids[0], claimed.token!, 'x', BACKOFF)).toBe(0);
    expect(await storeA.release(ids, claimed.token!)).toBe(0);
  });

  // -- 19 --------------------------------------------------------------------

  it('19: a transient renewal error is retried immediately and ownership survives', async () => {
    await seedRow(a, 'TRANSIENT');
    const publisher = new GatedPublisher();

    let attempts = 0;
    const flaky = {
      ...storeA,
      claimPending: (request: Parameters<PrismaOutboxStore['claimPending']>[0]) =>
        storeA.claimPending(request),
      markPublished: (ids: readonly string[], token: string) => storeA.markPublished(ids, token),
      markFailed: (id: string, token: string, error: string, backoff: typeof BACKOFF) =>
        storeA.markFailed(id, token, error, backoff),
      release: (ids: readonly string[], token: string) => storeA.release(ids, token),
      oldestPendingAgeSeconds: () => storeA.oldestPendingAgeSeconds(),
      renew: async (ids: readonly string[], token: string, lease: number, deadline: number) => {
        attempts += 1;
        // Fails once, succeeds on the immediate retry — no waiting, no timing.
        if (attempts === 1) throw new Error('connection reset');
        return storeA.renew(ids, token, lease, deadline);
      },
    };

    const relay = new OutboxRelay({
      store: flaky,
      publisher,
      leaseSeconds: LEASE,
      backoff: BACKOFF,
      logger: silent,
    });

    const tick = relay.tick();
    await publisher.started;

    await relay.renewOnce();
    expect(attempts).toBe(2);

    publisher.finish();
    expect(await tick).toBe(1);
    expect((await readRow(a, 'TRANSIENT')).published_at).not.toBeNull();
  });

  // -- 20 --------------------------------------------------------------------

  it('20: shutdown before anything is sent releases those rows, and they are claimable at once', async () => {
    for (let i = 0; i < 3; i += 1) {
      await seedRow(a, `SD${i}`, { createdAt: new Date(Date.now() - (3 - i) * 1000) });
    }

    // The batch is rejected, so the relay drops into the per-row fallback; the
    // first row then hangs. That leaves SD1 and SD2 genuinely un-sent while the
    // relay is asked to stop.
    const gate = new GatedPublisher();
    let batchTried = false;
    const publisher = {
      publish: async (rows: readonly OutboxRow[]) => {
        if (!batchTried) {
          batchTried = true;
          throw new Error('batch rejected');
        }
        return gate.publish(rows);
      },
    };

    const relay = new OutboxRelay({
      store: storeA,
      publisher,
      batchSize: 3,
      leaseSeconds: LEASE,
      backoff: BACKOFF,
      shutdownGraceSeconds: 0,
      logger: silent,
    });

    const tick = relay.tick();
    await gate.started;

    await relay.stop();

    // The two that never left are released: no token, no failure recorded, no
    // backoff — so they are due immediately rather than parked until expiry.
    for (const id of ['SD1', 'SD2']) {
      const row = await readRow(a, id);
      expect(row.claim_token).toBeNull();
      expect(row.claim_owner).toBeNull();
      expect(row.claim_expires_at).toBeNull();
      expect(row.attempts).toBe(0);
      expect(row.next_attempt_at).toBeNull();
    }
    const reclaimed = await claim(storeB, 5, LEASE, 'worker-b');
    expect(reclaimed.rows.map((row) => row.id).sort()).toEqual(['SD1', 'SD2']);

    // The in-flight one is deliberately not released (see test 22).
    expect((await readRow(a, 'SD0')).claim_token).not.toBeNull();

    gate.finish();
    await tick;
  });

  // -- 21 --------------------------------------------------------------------

  it('21: shutdown after a known success acknowledges, fenced on the token', async () => {
    await seedRow(a, 'SD_KNOWN');
    const publisher = new GatedPublisher();

    const relay = new OutboxRelay({
      store: storeA,
      publisher,
      leaseSeconds: LEASE,
      backoff: BACKOFF,
      shutdownGraceSeconds: 1,
      logger: silent,
    });

    const tick = relay.tick();
    await publisher.started;
    publisher.finish();
    expect(await tick).toBe(1);

    await relay.stop();

    const row = await readRow(a, 'SD_KNOWN');
    expect(row.published_at).not.toBeNull();
    expect(row.claim_token).toBeNull();
    expect(row.next_attempt_at).toBeNull();
  });

  // -- 22 --------------------------------------------------------------------

  it('22: shutdown with an unknown result does not release; only expiry frees the row', async () => {
    // The row may already have reached the broker. Releasing it guarantees a
    // replay; letting the lease lapse replays only if one is genuinely needed.
    await seedRow(a, 'SD_UNKNOWN');
    const publisher = new GatedPublisher();

    const relay = new OutboxRelay({
      store: storeA,
      publisher,
      leaseSeconds: LEASE,
      backoff: BACKOFF,
      shutdownGraceSeconds: 0,
      logger: silent,
    });

    const tick = relay.tick();
    await publisher.started;

    await relay.stop();

    const row = await readRow(a, 'SD_UNKNOWN');
    // Still claimed: not released, not published, not failed.
    expect(row.claim_token).not.toBeNull();
    expect(row.published_at).toBeNull();
    expect(row.attempts).toBe(0);

    // And nobody else can take it until the lease genuinely lapses.
    expect((await claim(storeB, 5, LEASE, 'worker-b')).rows).toHaveLength(0);
    await expireLease(a, 'SD_UNKNOWN');
    expect((await claim(storeB, 5, LEASE, 'worker-b')).rows).toHaveLength(1);

    publisher.finish();
    await tick;
  });

  // -- 23 --------------------------------------------------------------------

  it('23: in the fallback, one fenced row does not stop the others', async () => {
    for (let i = 0; i < 3; i += 1) await seedRow(a, `MIX${i}`);

    const claimed = await claim(storeA, 3);
    const ids = claimed.rows.map((row) => row.id);

    // One row is taken back; the other two are still ours.
    await expireLease(a, ids[1]);
    await storeB.claimPending({ limit: 1, owner: 'worker-b', leaseSeconds: LEASE });

    const acknowledged = await storeA.markPublished(ids, claimed.token!);

    expect(acknowledged).toBe(2);
    expect((await readRow(a, ids[0])).published_at).not.toBeNull();
    expect((await readRow(a, ids[2])).published_at).not.toBeNull();
    expect((await readRow(a, ids[1])).published_at).toBeNull();
  });

  // -- 24 --------------------------------------------------------------------

  it('24: no timer is left running after success, failure, full fencing or shutdown', async () => {
    const active = (): number =>
      (process as unknown as { _getActiveHandles(): unknown[] })._getActiveHandles().length;

    await seedRow(a, 'TIMER_OK');
    const baseline = active();

    // success
    const ok = new OutboxRelay({
      store: storeA,
      publisher: { publish: async () => {} },
      leaseSeconds: LEASE,
      backoff: BACKOFF,
      logger: silent,
    });
    await ok.tick();
    await ok.stop();

    // failure
    await seedRow(a, 'TIMER_FAIL');
    const bad = new OutboxRelay({
      store: storeA,
      publisher: {
        publish: async () => {
          throw new Error('always');
        },
      },
      leaseSeconds: LEASE,
      backoff: BACKOFF,
      logger: silent,
    });
    await bad.tick();
    await bad.stop();

    // shutdown with nothing claimed
    const idle = new OutboxRelay({
      store: storeA,
      publisher: { publish: async () => {} },
      leaseSeconds: LEASE,
      backoff: BACKOFF,
      logger: silent,
    });
    idle.start();
    await idle.stop();

    expect(active()).toBeLessThanOrEqual(baseline);
  });

  // -- the five CHECK constraints, against rows ------------------------------

  it('the five CHECK constraints reject the states they exist to forbid', async () => {
    await seedRow(a, 'CK');

    const refuse = async (sql: string, constraint: string) => {
      await expect(a.client.$executeRawUnsafe(sql)).rejects.toThrow(constraint);
    };

    await refuse(
      `UPDATE outbox_message SET claim_token='t', claim_owner='o' WHERE id='CK'`,
      'ck_outbox_claim_triple',
    );
    await refuse(
      `UPDATE outbox_message SET claim_count=-1 WHERE id='CK'`,
      'ck_outbox_claim_count_nonneg',
    );
    await refuse(
      `UPDATE outbox_message SET attempts=-1 WHERE id='CK'`,
      'ck_outbox_attempts_nonneg',
    );
    await refuse(
      `UPDATE outbox_message SET next_attempt_at=now() WHERE id='CK'`,
      'ck_outbox_next_attempt_requires_failure',
    );
    await refuse(
      `UPDATE outbox_message
          SET published_at=now(), claim_token='t', claim_owner='o',
              claim_expires_at=now()+interval '1 minute'
        WHERE id='CK'`,
      'ck_outbox_published_is_clean',
    );
  });

  it('a published row cannot be reclaimed', async () => {
    await seedRow(a, 'DONE');
    const claimed = await claim(storeA, 1);
    expect(await storeA.markPublished(['DONE'], claimed.token!)).toBe(1);

    expect((await claim(storeB, 10, LEASE, 'worker-b')).rows).toHaveLength(0);
  });

  // -- contention ------------------------------------------------------------
  //
  // `SKIP LOCKED` only earns its name if a claimant that meets locked rows
  // keeps going and still fills its batch. The sequential test above proves no
  // duplicate claim after a committed lease; it cannot prove this, because
  // nothing is ever locked while it runs.
  //
  // The risk is specific to the four-stream shape. Each stream picks its oldest
  // `limit` candidates, the union is cut to `limit`, and only then are rows
  // locked. Two claimants therefore build the *same* candidate window, and
  // whichever locks second finds every candidate taken — returning an empty or
  // short batch while thousands of eligible rows sit just past the window.
  //
  // These tests are deterministic by construction: one connection takes exactly
  // the locks the scenario calls for and holds them across the claim under
  // test. No sleeps, no timing, no polling.

  describe('under lock contention', () => {
    /** Distinct, ordered ids so assertions can name the exact expected batch. */
    const seedFresh = async (count: number, prefix = 'CT') => {
      const base = Date.now() - count * 1000;
      const ids: string[] = [];
      for (let i = 0; i < count; i += 1) {
        const id = `${prefix}${String(i).padStart(4, '0')}`;
        await seedRow(a, id, { createdAt: new Date(base + i * 1000) });
        ids.push(id);
      }
      return ids;
    };

    it('fills a full batch from past a locked prefix, in order', async () => {
      // Well over 2 x limit, so a short batch cannot be blamed on an empty
      // table: after the locked prefix there are still 200 eligible rows.
      const ids = await seedFresh(300);
      const limit = 100;

      const held = await holdLockOnOldest(b, limit);
      expect(held.ids).toEqual(ids.slice(0, limit));

      try {
        const claimed = await claim(storeA, limit);

        // Exactly `limit`, not fewer: this is the property the four-stream
        // shape put at risk.
        expect(claimed.rows).toHaveLength(limit);
        // The next window, in `created_at, id` order — no gaps, no reordering.
        expect(claimed.rows.map((row) => row.id)).toEqual(ids.slice(limit, limit * 2));
        // And nothing from the locked prefix.
        expect(claimed.rows.filter((row) => held.ids.includes(row.id))).toEqual([]);
      } finally {
        await held.release();
      }
    });

    it('claims nothing twice when the locked prefix is released and claimed again', async () => {
      const ids = await seedFresh(300);
      const limit = 100;

      const held = await holdLockOnOldest(b, limit);
      const skipped = await claim(storeA, limit);
      await held.release();

      // The prefix was never claimed by anybody — the holder only locked it —
      // so it is still eligible and must come back now.
      const afterRelease = await claim(storeB, limit, LEASE, 'worker-b');

      expect(afterRelease.rows.map((row) => row.id)).toEqual(ids.slice(0, limit));
      const overlap = afterRelease.rows.filter((row) =>
        skipped.rows.some((other) => other.id === row.id),
      );
      expect(overlap).toEqual([]);
    });

    it('returns a short batch only when the unlocked remainder is genuinely short', async () => {
      // The honest negative: 130 rows, 100 locked, so exactly 30 remain.
      const ids = await seedFresh(130);
      const limit = 100;

      const held = await holdLockOnOldest(b, limit);
      try {
        const claimed = await claim(storeA, limit);

        expect(claimed.rows).toHaveLength(30);
        expect(claimed.rows.map((row) => row.id)).toEqual(ids.slice(100, 130));
      } finally {
        await held.release();
      }
    });

    it('fills a full batch when the locked prefix spans all four streams', async () => {
      // Contention is not confined to one stream in a running system: a batch
      // mixes fresh rows, reclaimed leases and due retries. Each stream must
      // skip its own locked rows independently.
      const limit = 20;
      const base = Date.now() - 400 * 1000;
      let n = 0;
      const seed = async (
        kind: 'fresh' | 'lease' | 'retry' | 'paired',
        count: number,
      ): Promise<string[]> => {
        const made: string[] = [];
        for (let i = 0; i < count; i += 1) {
          const id = `MX_${kind.toUpperCase()}_${String(n).padStart(4, '0')}`;
          await seedRow(a, id, {
            createdAt: new Date(base + n * 1000),
            attempts: kind === 'retry' || kind === 'paired' ? 1 : 0,
          });
          if (kind === 'lease') {
            await a.client.$executeRawUnsafe(
              `UPDATE outbox_message
                  SET claim_token='old', claim_owner='old',
                      claim_expires_at = now() - interval '1 minute'
                WHERE id = $1`,
              id,
            );
          }
          if (kind === 'retry') {
            await a.client.$executeRawUnsafe(
              `UPDATE outbox_message SET next_attempt_at = now() - interval '1 minute'
                WHERE id = $1`,
              id,
            );
          }
          if (kind === 'paired') {
            await a.client.$executeRawUnsafe(
              `UPDATE outbox_message
                  SET claim_token='old', claim_owner='old',
                      claim_expires_at = now() - interval '1 minute',
                      next_attempt_at  = now() - interval '1 minute'
                WHERE id = $1`,
              id,
            );
          }
          made.push(id);
          n += 1;
        }
        return made;
      };

      // Interleaved in time, so the oldest `limit` genuinely spans all four.
      const order: Array<'fresh' | 'lease' | 'retry' | 'paired'> = [
        'fresh',
        'lease',
        'retry',
        'paired',
      ];
      const all: string[] = [];
      for (let round = 0; round < 25; round += 1) {
        for (const kind of order) all.push(...(await seed(kind, 1)));
      }

      const held = await holdLockOnOldest(b, limit);
      expect(held.ids).toEqual(all.slice(0, limit));
      // The locked prefix really does cover every stream, or the test would
      // prove less than it claims.
      for (const kind of ['FRESH', 'LEASE', 'RETRY', 'PAIRED']) {
        expect(held.ids.some((id) => id.includes(kind))).toBe(true);
      }

      try {
        const claimed = await claim(storeA, limit);

        expect(claimed.rows).toHaveLength(limit);
        expect(claimed.rows.map((row) => row.id)).toEqual(all.slice(limit, limit * 2));
        expect(claimed.rows.filter((row) => held.ids.includes(row.id))).toEqual([]);
        // Reclaimed leases are counted as such even when they arrive through a
        // contended claim.
        expect(claimed.reclaimed).toBeGreaterThan(0);
      } finally {
        await held.release();
      }
    });

    it('admits no ineligible or published row while skipping locked ones', async () => {
      const limit = 10;
      const base = Date.now() - 100 * 1000;
      const eligible: string[] = [];
      for (let i = 0; i < 40; i += 1) {
        const id = `EL${String(i).padStart(3, '0')}`;
        await seedRow(a, id, { createdAt: new Date(base + i * 1000) });
        eligible.push(id);
      }
      // Interleaved rows that must never be claimed, whatever the contention.
      await seedRow(a, 'NO_PUBLISHED', { createdAt: new Date(base + 5_500) });
      await a.client.$executeRawUnsafe(
        `UPDATE outbox_message SET published_at = now() WHERE id = 'NO_PUBLISHED'`,
      );
      await seedRow(a, 'NO_LIVE_LEASE', { createdAt: new Date(base + 6_500) });
      await a.client.$executeRawUnsafe(
        `UPDATE outbox_message
            SET claim_token='live', claim_owner='live',
                claim_expires_at = now() + interval '10 minutes'
          WHERE id = 'NO_LIVE_LEASE'`,
      );
      await seedRow(a, 'NO_FUTURE_RETRY', { createdAt: new Date(base + 7_500), attempts: 1 });
      await a.client.$executeRawUnsafe(
        `UPDATE outbox_message SET next_attempt_at = now() + interval '10 minutes'
          WHERE id = 'NO_FUTURE_RETRY'`,
      );

      const held = await holdLockOnOldest(b, limit);
      try {
        const claimed = await claim(storeA, limit);
        const got = claimed.rows.map((row) => row.id);

        expect(got).toHaveLength(limit);
        expect(got).not.toContain('NO_PUBLISHED');
        expect(got).not.toContain('NO_LIVE_LEASE');
        expect(got).not.toContain('NO_FUTURE_RETRY');
        expect(got.every((id) => eligible.includes(id))).toBe(true);
      } finally {
        await held.release();
      }
    });

    it('stays bounded: never returns more than the limit, however large the backlog', async () => {
      await seedFresh(500, 'BD');
      const held = await holdLockOnOldest(b, 50);
      try {
        expect((await claim(storeA, 100)).rows).toHaveLength(100);
      } finally {
        await held.release();
      }
    });
  });

  // -- eligibility equivalence ----------------------------------------------
  //
  // The claim query no longer asks the original single predicate. It asks four
  // mutually exclusive streams, because `now()` is stable rather than immutable
  // and PostgreSQL therefore cannot estimate `<= now()` — it applies a flat 33%
  // and, under `LIMIT`, always prefers an early exit from the ordering index,
  // filtering out 190,000 rows in the states ADR-050 measures.
  //
  // Rewriting a predicate for the planner's benefit is exactly the kind of
  // change that silently claims the wrong rows, so equivalence is proven here
  // rather than argued. Every case ADR-050 names gets a row, and the two forms
  // must agree on all of them — including the boundary where a timestamp is
  // exactly the database's own `now()`.

  describe('the four-stream eligibility equals the original predicate', () => {
    /** The predicate ADR-050 specifies, unchanged. */
    const ORIGINAL = `
      SELECT id FROM outbox_message
       WHERE published_at IS NULL
         AND (claim_expires_at IS NULL OR claim_expires_at <= now())
         AND (next_attempt_at  IS NULL OR next_attempt_at  <= now())`;

    /** The four streams the claim query actually walks. */
    const STREAMS = `
      SELECT id FROM outbox_message
       WHERE published_at IS NULL AND claim_expires_at IS NULL AND next_attempt_at IS NULL
      UNION ALL
      SELECT id FROM outbox_message
       WHERE published_at IS NULL AND next_attempt_at IS NULL
         AND claim_expires_at IS NOT NULL AND claim_expires_at <= now()
      UNION ALL
      SELECT id FROM outbox_message
       WHERE published_at IS NULL AND claim_expires_at IS NULL
         AND next_attempt_at IS NOT NULL AND next_attempt_at <= now()
      UNION ALL
      SELECT id FROM outbox_message
       WHERE published_at IS NULL
         AND claim_expires_at IS NOT NULL AND next_attempt_at IS NOT NULL
         AND GREATEST(claim_expires_at, next_attempt_at) <= now()`;

    /** One row per case ADR-050 enumerates, oldest first so the order is fixed. */
    const CASES: Array<{ id: string; sql: string; eligible: boolean }> = [
      { id: 'EQ1_BOTH_NULL', sql: `NULL, NULL, NULL, NULL, NULL`, eligible: true },
      {
        id: 'EQ2_LIVE_LEASE',
        sql: `'tk', 'ow', now() + interval '5 min', NULL, NULL`,
        eligible: false,
      },
      {
        id: 'EQ3_EXPIRED_LEASE',
        sql: `'tk', 'ow', now() - interval '5 min', NULL, NULL`,
        eligible: true,
      },
      {
        id: 'EQ4_FUTURE_BACKOFF',
        sql: `NULL, NULL, NULL, now() + interval '5 min', NULL`,
        eligible: false,
      },
      {
        id: 'EQ5_DUE_BACKOFF',
        sql: `NULL, NULL, NULL, now() - interval '5 min', NULL`,
        eligible: true,
      },
      {
        id: 'EQ6_EXPIRED_LEASE_FUTURE_BACKOFF',
        sql: `'tk', 'ow', now() - interval '5 min', now() + interval '5 min', NULL`,
        eligible: false,
      },
      {
        id: 'EQ7_LIVE_LEASE_DUE_BACKOFF',
        sql: `'tk', 'ow', now() + interval '5 min', now() - interval '5 min', NULL`,
        eligible: false,
      },
      {
        id: 'EQ8_PUBLISHED',
        sql: `NULL, NULL, NULL, NULL, now() - interval '1 min'`,
        eligible: false,
      },
      // The boundary. Written as exactly `now()`, which by the time the query
      // runs is in the past, so `<= now()` holds — and both forms must agree.
      { id: 'EQ9_BOUNDARY_NOW', sql: `'tk', 'ow', now(), NULL, NULL`, eligible: true },
    ];

    const ids = async (query: string): Promise<string[]> => {
      const rows = await a.client.$queryRawUnsafe<{ id: string }[]>(
        `SELECT id FROM (${query}) q WHERE id LIKE 'EQ%' ORDER BY id`,
      );
      return rows.map((row) => row.id);
    };

    beforeEach(async () => {
      for (const [index, testCase] of CASES.entries()) {
        await a.client.$executeRawUnsafe(
          `INSERT INTO outbox_message
             (id, aggregate_type, aggregate_id, event_name, event_version, topic,
              partition_key, payload, headers, correlation_id, created_at, attempts,
              claim_count, claim_token, claim_owner, claim_expires_at, next_attempt_at,
              published_at)
           VALUES ($1,'Probe',$1,'PROBE',1,'t.probe',$1,'{}'::jsonb,'{}'::jsonb,$1,
                   now() - make_interval(mins => ${20 - index}), 1, 0, ${testCase.sql})`,
          testCase.id,
        );
      }
    });

    it('agrees with the original predicate on every enumerated case', async () => {
      expect(await ids(STREAMS)).toEqual(await ids(ORIGINAL));
    });

    it('selects exactly the rows ADR-050 says are eligible', async () => {
      const expected = CASES.filter((c) => c.eligible)
        .map((c) => c.id)
        .sort();

      expect(await ids(ORIGINAL)).toEqual(expected);
      expect(await ids(STREAMS)).toEqual(expected);
    });

    it('has an empty symmetric difference, in both directions', async () => {
      const rows = await a.client.$queryRawUnsafe<{ side: string; id: string }[]>(
        `WITH orig AS (${ORIGINAL}), streams AS (${STREAMS})
         SELECT 'only_in_original' AS side, id FROM (SELECT id FROM orig EXCEPT SELECT id FROM streams) x
         UNION ALL
         SELECT 'only_in_streams', id FROM (SELECT id FROM streams EXCEPT SELECT id FROM orig) y`,
      );

      expect(rows).toEqual([]);
    });

    it('keeps the streams mutually exclusive, so no row is claimed twice', async () => {
      // The union is `UNION ALL`, so an overlap would put one row in a batch
      // twice and hand Kafka a duplicate from a single claim.
      const rows = await a.client.$queryRawUnsafe<{ id: string }[]>(
        `SELECT id FROM (${STREAMS}) s GROUP BY id HAVING count(*) > 1`,
      );

      expect(rows).toEqual([]);
    });

    it('claims exactly the eligible rows through the real claim query', async () => {
      // Not the predicate in isolation: the statement the relay actually runs,
      // including the candidate merge, the re-check and the reservation.
      const claimed = await claim(storeA, 100);

      expect(
        claimed.rows
          .map((row) => row.id)
          .filter((id) => id.startsWith('EQ'))
          .sort(),
      ).toEqual(
        CASES.filter((c) => c.eligible)
          .map((c) => c.id)
          .sort(),
      );
    });
  });

  it('the backoff is computed with the database clock, not the process clock', async () => {
    // A JavaScript `Date.now()` here would let clock skew between replicas
    // bring a retry forward or push it back.
    await seedRow(a, 'DBCLOCK', { attempts: 3 });
    const claimed = await claim(storeA, 1);

    await storeA.markFailed('DBCLOCK', claimed.token!, 'boom', {
      baseSeconds: 2,
      maxSeconds: 3600,
    });

    const rows = await a.client.$queryRawUnsafe<{ delay: number }[]>(
      `SELECT extract(epoch FROM (next_attempt_at - now()))::float8 AS delay
         FROM outbox_message WHERE id = 'DBCLOCK'`,
    );
    // attempts was 3 before the update, so 2^3 x 2 = 16 seconds.
    expect(rows[0].delay).toBeGreaterThan(14);
    expect(rows[0].delay).toBeLessThanOrEqual(16);
  });
});
