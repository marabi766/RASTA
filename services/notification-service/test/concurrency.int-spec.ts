import { ulid } from 'ulid';
import { runUnscoped } from '@rasta/nest-common';
import { DISPATCHER_CONSUMER } from '../src/notification/notification.repository';
import {
  cleanup,
  deliver,
  insuranceExpiring,
  newOrganizationId,
  newUserId,
  rowsFor,
  sleep,
  wire,
  type Wiring,
} from './helpers';

/**
 * The properties a single-threaded test cannot prove (PROJECT_MEMORY § 30).
 *
 * The dedupe decision and the claim are both "first writer wins" rules
 * enforced by the database — a primary-key upsert and `FOR UPDATE SKIP
 * LOCKED`. Fifty concurrent ingests of one fact must produce one intent;
 * fifty concurrent claims of one batch must hand every intent to exactly one
 * worker. Both are asserted with `Promise.all`, not in sequence.
 */
describe('concurrency', () => {
  let w: Wiring;
  const organizations: string[] = [];

  beforeAll(async () => {
    w = wire();
    await w.prisma.onModuleInit();
  });

  afterAll(async () => {
    await cleanup(w.prisma, organizations);
    await w.prisma.onModuleDestroy();
  });

  it('50 concurrent distinct events about one fact produce exactly one intent', async () => {
    const organizationId = newOrganizationId();
    organizations.push(organizationId);
    const policyId = `POL_${ulid()}`;

    const outcomes = await Promise.all(
      Array.from({ length: 50 }, () =>
        deliver(w, insuranceExpiring({ organizationId, policyId, daysRemaining: 20 })),
      ),
    );

    expect(outcomes.filter((outcome) => outcome === undefined)).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === 'SKIPPED')).toHaveLength(49);

    const rows = await rowsFor(w.prisma, organizationId);
    expect(rows.intents).toHaveLength(1);
    expect(rows.dedupe).toHaveLength(1);
    expect(rows.dedupe[0]!.seenCount).toBe(50);
    expect(rows.dedupe[0]!.intentId).toBe(rows.intents[0]!.id);
  }, 120_000);

  it('50 concurrent workers claim a batch of 30 intents with no overlap', async () => {
    const organizationId = newOrganizationId();
    organizations.push(organizationId);
    for (let i = 0; i < 30; i += 1) {
      await deliver(
        w,
        insuranceExpiring({ organizationId, policyId: `POL_${ulid()}`, daysRemaining: 20 }),
      );
    }

    const claims = await Promise.all(
      Array.from({ length: 50 }, (_, i) => w.repository.claimPending(`worker-${i}`, 3, 60)),
    );
    // The claim is cross-tenant by construction, so an earlier test's leftover
    // intent may ride along; the property under test is counted on this
    // organization's rows only.
    const ids = claims
      .flat()
      .filter((intent) => intent.organizationId === organizationId)
      .map((intent) => intent.id);

    expect(ids).toHaveLength(30);
    expect(new Set(ids).size).toBe(30);
    expect(claims.filter((claim) => claim.length > 0).length).toBeGreaterThanOrEqual(10);
  }, 120_000);

  it('concurrent ticks over one backlog dispatch every intent exactly once', async () => {
    const organizationId = newOrganizationId();
    organizations.push(organizationId);
    const user = newUserId();
    w.recipients.answers.set(organizationId, [{ userId: user, role: 'FLEET_MANAGER' }]);
    for (let i = 0; i < 20; i += 1) {
      await deliver(
        w,
        insuranceExpiring({ organizationId, policyId: `POL_${ulid()}`, daysRemaining: 20 }),
      );
    }

    const processed = await Promise.all(Array.from({ length: 8 }, () => w.worker.tick()));
    // At least this organization's twenty; the claim is cross-tenant, so
    // another suite's leftovers may add to the sum but never to the rows below.
    expect(processed.reduce((sum, n) => sum + n, 0)).toBeGreaterThanOrEqual(20);

    const rows = await rowsFor(w.prisma, organizationId);
    expect(rows.intents.every((intent) => intent.status === 'DISPATCHED')).toBe(true);
    expect(rows.deliveries).toHaveLength(20);
    expect(rows.inApp).toHaveLength(20);
    expect(new Set(rows.inApp.map((row) => row.intentId)).size).toBe(20);
  }, 120_000);

  /**
   * The window a transaction that began earlier but wrote later would open
   * backwards.
   *
   * `now()` is `transaction_timestamp()`: fixed when the transaction begins
   * and constant for its whole life. Transactions serialize on the
   * `dedupe_key` conflict in commit order, which has nothing to do with the
   * order they began in — so the `DO UPDATE` branch can run in a transaction
   * whose `now()` is *older* than the `first_seen_at` an already-committed
   * transaction wrote. That pair violates `ck_dedupe_window_ordered`, and
   * before the fix it aborted the ingest with SQLSTATE 23514.
   *
   * The interleaving is forced rather than raced. The blocked ingest is pinned
   * behind an uncommitted `processed_event` row carrying its own event id, so
   * its transaction has already begun — and its `now()` is already fixed —
   * while the other ingest begins, opens the window and commits. Releasing the
   * pin lets it proceed straight to the dedupe upsert with the older clock.
   */
  it('an ingest whose transaction began earlier but updates later keeps the window ordered', async () => {
    const organizationId = newOrganizationId();
    organizations.push(organizationId);
    const policyId = `POL_${ulid()}`;

    const lateEventId = ulid();
    const blocked = insuranceExpiring({
      organizationId,
      policyId,
      daysRemaining: 20,
      eventId: lateEventId,
    });
    const opener = insuranceExpiring({ organizationId, policyId, daysRemaining: 20 });

    class Rollback extends Error {}
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held!: () => void;
    const pinned = new Promise<void>((resolve) => {
      held = resolve;
    });

    // Holds `lateEventId` uncommitted, so the ingest below blocks on it.
    const pin = runUnscoped('the test pins one ingest behind its own idempotency marker', () =>
      w.prisma.transaction(
        async (tx) => {
          await tx.$executeRaw`
            INSERT INTO "processed_event" ("event_id", "consumer_name")
            VALUES (${lateEventId}, ${DISPATCHER_CONSUMER})
          `;
          held();
          await released;
          throw new Rollback();
        },
        { timeout: 60_000, maxWait: 10_000 },
      ),
    ).catch((error: unknown) => {
      if (!(error instanceof Rollback)) throw error;
    });

    // Only once the marker is genuinely held does the ingest begin, or it
    // races the pin and inserts the marker itself.
    await pinned;

    // Begins now and stops at the marker: its `now()` is fixed from here.
    const blockedIngest = deliver(w, blocked);
    await sleep(500);

    // Begins later, so its `now()` is strictly newer, and commits first.
    await deliver(w, opener);
    await sleep(100);

    release();
    await pin;
    await expect(blockedIngest).resolves.not.toThrow();

    const rows = await rowsFor(w.prisma, organizationId);
    expect(rows.intents).toHaveLength(1);
    expect(rows.dedupe).toHaveLength(1);

    const window = rows.dedupe[0]!;
    expect(window.seenCount).toBe(2);
    // The invariant the constraint enforces, asserted here so a regression
    // fails on the assertion rather than only on a 23514 from the database.
    expect(window.firstSeenAt.getTime()).toBeLessThanOrEqual(window.lastSeenAt.getTime());
  }, 120_000);
});
