import { eligibilityClockWrite } from '@rasta/testing';
import type { ExtendedPrismaClient } from '../src/prisma/prisma.service';
import { PrismaClient } from '../src/generated/prisma';
import { WindowSweepService } from '../src/demand/window-sweep.service';
import { buyer, client, startApi, TestClock, type ApiHarness } from './api-helpers';
import { cleanup, newOrganizationId, newProductId, ownerDatabaseUrl } from './helpers';

/**
 * A window's withdrawn history costs its commands nothing (PR-327 r3 F1).
 *
 * The live-demand limit bounds what a window counts, not what it ever held: a withdrawal frees a
 * place, but the withdrawn row stays. Submitting and withdrawing keeps a window small while its
 * history grows without end — under EXTEND below its threshold, for ever. Every submit and every
 * withdrawal queues the deferred totals check, which rescans the window's counted demands under
 * the window's lock; were that rescan to read the withdrawn rows too, each command would grow with
 * the history until it outran its budget, and the late EXTEND submit that rolled back with it
 * would repeat on the next one.
 *
 * So each window here holds `HISTORY` withdrawn demands and `LIVE` live ones, and every
 * transaction the service runs is measured from inside: the rows and index entries of
 * `demand_request` it read — its statements and, forced at its end, its deferred checks — as
 * PostgreSQL counts them for the transaction itself (`pg_stat_get_xact_tuples_returned`). That
 * number does not depend on the machine, and it must stay a few times `LIVE` while the history is
 * `HISTORY`: before the fix the rescan read every withdrawn row, twice per command.
 *
 * The history is seeded through the owner connection, as `window-close-scale` seeds, then vacuumed
 * and analysed as autovacuum keeps a table of that size. Plans are measured with those statistics,
 * and for an organization whose whole history arrived after the last ANALYZE: the statistics do not
 * know it, which is what made the end's id query read the organization's history in id order.
 *
 * The history is INSERTed as WITHDRAWN, never inserted SUBMITTED and then withdrawn (FU-175). That
 * way leaves 100,000 dead SUBMITTED versions, whose index entries every scan of the window visits
 * until VACUUM removes them — and VACUUM removes none while any transaction or snapshot older than
 * the seed's commit is still open in the database. One such holder made the third case read
 * 200,073 (two scans of the 100,000 entries, one per deferred check) on a plan that reads 7
 * buffers once they are gone: the read bound then measured whoever else was connected, not the
 * code. With no dead version in the seed there is nothing for a holder to keep, and the bound
 * holds whatever else is connected.
 *
 * What is counted is rows, not visits (FU-201). The commands leave dead versions of their own: a
 * withdrawal leaves the SUBMITTED version it replaced, and a scan of the window visits its index
 * entry until VACUUM removes it — which it does not while a snapshot older than the withdrawal is
 * open. Main's run 42326055889 read 47 and 42 where an undisturbed run reads 8 to 18: the planner
 * scans a window's few entries once or three times a statement (its choice follows the last
 * ANALYZE's sample), and each scan met the dead entries of the earlier rounds. `read` therefore
 * counts the rows a transaction actually read — the table's sequential and bitmap rows and the
 * live rows its index scans fetched, as PostgreSQL counts them — and leaves out the index entries
 * that led to a version nobody can see any more (`visited` is the old count, kept to show them).
 * A dead version is not history, and no scan of the withdrawn history can avoid fetching its rows:
 * they are live and visible. That includes an index-only scan, because the snapshot the spec holds
 * (`holdSnapshot`) is older than every seed, so no page of the history is all-visible and the scan
 * fetches each row from the table. The snapshot is held for the whole spec so that the dead
 * versions are there on every run, not only on one that happened to meet a holder, and the last
 * case proves that state: many entries visited, few rows read.
 *
 * PR 2 ends a window in batches (`WindowEnd`, the sweeper): its last case ends a REFER window of
 * `SWEPT_LIVE` live demands with a follow batch of `SWEPT_BATCH`, so the end and each sweep step after
 * it — a batch that follows, a batch of the digest — are each measured over the same history.
 *
 * Not measured: a table of this size with no statistics at all, which autovacuum never leaves it
 * with. There the planner costed every index of the table alike and was seen taking even a
 * lookup by (organization, id) through `ix_demand_request_aggregation`.
 */
const HOUR = 3_600_000;
const MAX_QUANTITY = 2_147_483_647;
const T0 = new Date('2031-06-01T08:00:00.000Z');
const HISTORY = 100_000;
const LIVE = 3;
/** The most `demand_request` rows and entries one transaction may read: a few times `LIVE`. */
const READ_BOUND = 10 * (LIVE + 1);
/** Submit-and-withdraw rounds the last case runs: enough dead versions to pass `READ_BOUND`. */
const CHURN_ROUNDS = 20;
/** Withdrawn demands of the last case's window: it proves independence, not the scale. */
const SMALL_HISTORY = 1_000;
/** The sweeper's case: more live demands than one batch takes, so the end takes several steps. */
const SWEPT_LIVE = 7;
const SWEPT_BATCH = 2;

jest.setTimeout(180_000);

/**
 * What the current transaction has read of `demand_request` so far. `read`: its rows — those a
 * sequential scan returned or a bitmap scan fetched from the table, and the live rows its index
 * scans fetched. `visited`: every index entry its scans returned, those of dead versions too.
 */
async function demandRowsRead(
  tx: ExtendedPrismaClient,
): Promise<{ read: number; visited: number }> {
  const rows = await tx.$queryRaw<{ read: bigint; visited: bigint }[]>`
    SELECT coalesce(sum(CASE WHEN c.relkind = 'i' THEN pg_stat_get_xact_tuples_fetched(c.oid)
                             ELSE pg_stat_get_xact_tuples_returned(c.oid)
                                  + pg_stat_get_xact_tuples_fetched(c.oid) END), 0)::bigint AS read,
           coalesce(sum(pg_stat_get_xact_tuples_returned(c.oid)), 0)::bigint AS visited
      FROM pg_class AS c
     WHERE c.oid = 'demand_request'::regclass
        OR c.oid IN (SELECT indexrelid FROM pg_index WHERE indrelid = 'demand_request'::regclass)`;
  return { read: Number(rows[0]?.read ?? 0), visited: Number(rows[0]?.visited ?? 0) };
}

const bounded = (read: number) => ({ read, bounded: read <= READ_BOUND });

describe("a window's withdrawn history", () => {
  const organizations: string[] = [];
  const harnesses: ApiHarness[] = [];
  const owner = new PrismaClient({ datasources: { db: { url: ownerDatabaseUrl() } } });
  let extendWindow: Seeded;
  let referWindow: Seeded;
  let releaseSnapshot: () => Promise<void> = async () => undefined;

  type Seeded = { organizationId: string; productId: string; aggregationId: string };

  /**
   * A REPEATABLE READ transaction of the owner connection that has taken its snapshot and holds it
   * until released: what an analyst's session, a long report or a backup leaves open. VACUUM keeps
   * every version a snapshot could still see, so from here on the commands' dead versions stay.
   */
  async function holdSnapshot(): Promise<() => Promise<void>> {
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let taken!: () => void;
    const snapshotTaken = new Promise<void>((resolve) => (taken = resolve));
    const ended = owner.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
        await tx.$queryRaw`SELECT count(*) FROM demand_request WHERE false`;
        taken();
        await released;
      },
      { timeout: 600_000, maxWait: 10_000 },
    );
    await Promise.race([snapshotTaken, ended]);
    return async () => {
      release();
      await ended;
    };
  }

  beforeAll(async () => {
    releaseSnapshot = await holdSnapshot();
    extendWindow = await seedWindow('EXTEND');
    referWindow = await seedWindow('REFER');
    await owner.$executeRawUnsafe('VACUUM ANALYZE "demand_request"');
  }, 300_000);

  afterAll(async () => {
    try {
      await releaseSnapshot();
      // The seeded history first, in a transaction of its own size; then the usual cleanup.
      await owner.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(
            'ALTER TABLE "demand_request" DISABLE TRIGGER "tg_demand_request_guard"',
          );
          await tx.$executeRaw`
            DELETE FROM demand_request
             WHERE organization_id = ANY(${organizations}::text[]) AND status = 'WITHDRAWN'`;
          await tx.$executeRawUnsafe(
            'ALTER TABLE "demand_request" ENABLE TRIGGER "tg_demand_request_guard"',
          );
        },
        { timeout: 120_000, maxWait: 10_000 },
      );
      await cleanup(organizations);
    } finally {
      await owner.$disconnect();
      for (const harness of harnesses) await harness.close();
    }
  });

  /**
   * An OPEN window opened at `opened` for 10 h under `policy`, never reaching its threshold:
   * `history` demands submitted and withdrawn, then `live` still SUBMITTED.
   */
  async function seedWindow(
    policy: 'EXTEND' | 'REFER',
    opened: Date = T0,
    live: number = LIVE,
    history: number = HISTORY,
  ): Promise<Seeded> {
    const organizationId = newOrganizationId();
    organizations.push(organizationId);
    const productId = newProductId();
    const tag = organizationId.slice(4);
    const aggregationId = `AGG_HIST_${tag}`;
    await owner.$transaction(
      async (tx) => {
        // The insert guard admits only SUBMITTED, version 1: a history born WITHDRAWN needs it off.
        for (const trigger of ['tg_demand_request_totals_check', 'tg_demand_request_guard']) {
          await tx.$executeRawUnsafe(`ALTER TABLE "demand_request" DISABLE TRIGGER "${trigger}"`);
        }
        await eligibilityClockWrite(tx)`
          INSERT INTO demand_aggregation
            (id, organization_id, product_id, status, opened_at, closes_at, window_hours,
             min_quantity, shortfall_policy, setting_version, total_quantity, demand_count,
             extension_count, created_at, updated_at, version)
          VALUES (${aggregationId}, ${organizationId}, ${productId}, 'OPEN', ${opened},
                  ${new Date(opened.getTime() + 10 * HOUR)}, 10, ${MAX_QUANTITY}, ${policy}, NULL,
                  ${live}, ${live}, 0, ${opened}, ${opened}, 1)`;
        // Demand n is submitted `n` ms after the opening; the first HISTORY were withdrawn a second
        // later, the rest are live. Each row is written once, in the state it is measured in.
        const withdrawn = await tx.$executeRaw`
          INSERT INTO demand_request
            (id, organization_id, aggregation_id, product_id, quantity, status, submitted_at,
             submitted_by, submitted_correlation_id, withdrawn_at, withdrawn_by, withdraw_reason,
             created_at, updated_at, version)
          SELECT 'DMD_HIST_' || lpad(n::text, 8, '0') || '_' || ${tag},
                 ${organizationId}, ${aggregationId}, ${productId}, 1, 'WITHDRAWN',
                 ${opened}::timestamptz + make_interval(secs => n / 1000.0),
                 'USR-HISTORY-SEED', 'corr-history-seed',
                 ${opened}::timestamptz + make_interval(secs => n / 1000.0) + interval '1 second',
                 'USR-HISTORY-SEED', 'seeded withdrawal history',
                 ${opened}::timestamptz + make_interval(secs => n / 1000.0),
                 ${opened}::timestamptz + make_interval(secs => n / 1000.0) + interval '1 second', 2
            FROM generate_series(1, ${history}::int) AS n`;
        expect(withdrawn).toBe(history);
        const submitted = await tx.$executeRaw`
          INSERT INTO demand_request
            (id, organization_id, aggregation_id, product_id, quantity, status, submitted_at,
             submitted_by, submitted_correlation_id, created_at, updated_at, version)
          SELECT 'DMD_HIST_' || lpad(n::text, 8, '0') || '_' || ${tag},
                 ${organizationId}, ${aggregationId}, ${productId}, 1, 'SUBMITTED',
                 ${opened}::timestamptz + make_interval(secs => n / 1000.0),
                 'USR-HISTORY-SEED', 'corr-history-seed',
                 ${opened}::timestamptz + make_interval(secs => n / 1000.0),
                 ${opened}::timestamptz + make_interval(secs => n / 1000.0), 1
            FROM generate_series(${history + 1}::int, ${history + live}::int) AS n`;
        expect(submitted).toBe(live);
        // Nothing of the history was rewritten: a row updated or deleted here leaves a dead version
        // for the measured scans to visit (see the header), so a seed that does fails at once.
        const rewritten = await tx.$queryRaw<{ n: bigint }[]>`
          SELECT (pg_stat_get_xact_tuples_updated('demand_request'::regclass)
                  + pg_stat_get_xact_tuples_deleted('demand_request'::regclass))::bigint AS n`;
        expect(Number(rewritten[0]?.n)).toBe(0);
        for (const trigger of ['tg_demand_request_guard', 'tg_demand_request_totals_check']) {
          await tx.$executeRawUnsafe(`ALTER TABLE "demand_request" ENABLE TRIGGER "${trigger}"`);
        }
      },
      { timeout: 120_000, maxWait: 10_000 },
    );
    return { organizationId, productId, aggregationId };
  }

  /** The API, every transaction of which records the `demand_request` rows it read. */
  async function measuredApi(
    policy: 'EXTEND' | 'REFER',
    clock: TestClock,
    env: Record<string, string> = {},
  ) {
    const harness = await startApi(
      {
        PROCUREMENT_AGGREGATION_WINDOW_HOURS: '10',
        PROCUREMENT_AGGREGATION_MIN_QUANTITY: String(MAX_QUANTITY),
        PROCUREMENT_AGGREGATION_SHORTFALL_POLICY: policy,
        ...env,
      },
      { clock },
    );
    harnesses.push(harness);
    const reads: number[] = [];
    const visits: number[] = [];
    const transaction = harness.prisma.transaction.bind(harness.prisma);
    jest.spyOn(harness.prisma, 'transaction').mockImplementation(((fn, options) =>
      transaction(async (tx) => {
        const before = await demandRowsRead(tx);
        const result = await fn(tx);
        // The deferred checks run here instead of at commit, so they are counted too.
        await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
        const after = await demandRowsRead(tx);
        reads.push(after.read - before.read);
        visits.push(after.visited - before.visited);
        return result;
      }, options)) as typeof harness.prisma.transaction);
    /** The most rows any transaction since the last call read; cleared. */
    const mostRead = () => Math.max(0, ...reads.splice(0));
    /** The most index entries any transaction since the last call visited; cleared. */
    const mostVisited = () => Math.max(0, ...visits.splice(0));
    return { harness, mostRead, mostVisited, reads };
  }

  /** The late submit that ends a REFER window; what its transactions read at most. */
  async function referLate(seeded: Seeded): Promise<number> {
    const clock = new TestClock();
    const { harness, mostRead } = await measuredApi('REFER', clock);
    const as = client(harness, buyer(seeded.organizationId));
    clock.set(new Date(T0.getTime() + 10 * HOUR));
    const late = await as.submit({ productId: seeded.productId, quantity: 1 });
    expect(late.status).toBe(201);
    expect(late.body.aggregationId).not.toBe(seeded.aggregationId);
    const read = mostRead();
    expect((await as.aggregation(seeded.aggregationId)).body).toMatchObject({
      status: 'REFERRED',
      demandCount: LIVE,
      totalQuantity: LIVE,
    });
    return read;
  }

  it(`EXTEND below its threshold: with ${HISTORY} withdrawn demands and ${LIVE} live, submits, withdrawals and the late submit that extends the window each read at most ${READ_BOUND} demand rows`, async () => {
    const seeded = extendWindow;
    const clock = new TestClock();
    const { harness, mostRead } = await measuredApi('EXTEND', clock);
    const as = client(harness, buyer(seeded.organizationId));

    clock.set(new Date(T0.getTime() + 9 * HOUR));
    const churn: { submit: number; withdraw: number }[] = [];
    for (let round = 0; round < 3; round += 1) {
      const submitted = await as.submit({ productId: seeded.productId, quantity: 1 });
      expect(submitted.status).toBe(201);
      expect(submitted.body.aggregationId).toBe(seeded.aggregationId);
      const submit = mostRead();
      const withdrawn = await as.withdraw(submitted.body.id, submitted.body.version);
      expect(withdrawn.status).toBe(200);
      churn.push({ submit, withdraw: mostRead() });
    }

    // The window's end, under EXTEND short of its threshold: it moves on, and the demand joins.
    clock.set(new Date(T0.getTime() + 10 * HOUR));
    const late = await as.submit({ productId: seeded.productId, quantity: 1 });
    expect(late.status).toBe(201);
    expect(late.body.aggregationId).toBe(seeded.aggregationId);
    const extend = mostRead();

    const reads = [...churn.flatMap(({ submit, withdraw }) => [submit, withdraw]), extend];
    expect(reads.map(bounded)).toEqual(reads.map((read) => ({ read, bounded: true })));
    expect((await as.aggregation(seeded.aggregationId)).body).toMatchObject({
      status: 'OPEN',
      extensionCount: 1,
      demandCount: LIVE + 1,
      totalQuantity: LIVE + 1,
    });
  });

  it(`REFER: with ${HISTORY} withdrawn demands and ${LIVE} live, the late submit that ends the window reads at most ${READ_BOUND} demand rows`, async () => {
    expect(bounded(await referLate(referWindow))).toEqual(
      expect.objectContaining({ bounded: true }),
    );
  });

  it(`REFER, for an organization whose ${HISTORY} withdrawn demands arrived after the last ANALYZE: the late submit that ends its window reads at most ${READ_BOUND} demand rows`, async () => {
    const unseen = await seedWindow('REFER');
    // Vacuumed, not analysed: the pages are marked as autovacuum leaves them, and the statistics
    // still do not know this organization.
    await owner.$executeRawUnsafe('VACUUM "demand_request"');
    expect(bounded(await referLate(unseen))).toEqual(expect.objectContaining({ bounded: true }));
  });

  it(`REFER, ended in batches of ${SWEPT_BATCH} (PR 2): with ${HISTORY} withdrawn demands and ${SWEPT_LIVE} live, the late submit and every sweep step after it read at most ${READ_BOUND} demand rows`, async () => {
    // Opened three days ago: due by the database clock the sweeper claims with.
    const seeded = await seedWindow('REFER', new Date(Date.now() - 72 * HOUR), SWEPT_LIVE);
    await owner.$executeRawUnsafe('VACUUM "demand_request"');
    const clock = new TestClock();
    const { harness, mostRead, reads } = await measuredApi('REFER', clock, {
      PROCUREMENT_WINDOW_FOLLOW_BATCH_SIZE: String(SWEPT_BATCH),
    });
    const as = client(harness, buyer(seeded.organizationId));

    clock.set(null);
    const late = await as.submit({ productId: seeded.productId, quantity: 1 });
    expect(late.status).toBe(201);
    expect(late.body.aggregationId).not.toBe(seeded.aggregationId);
    const end = mostRead();

    // Each step of this window, and only this window: the claim spans tenants.
    const service = harness.app.get(WindowSweepService);
    const step = service.step.bind(service);
    const steps: number[] = [];
    jest.spyOn(service, 'step').mockImplementation(async (target, lease) => {
      reads.splice(0);
      const done = await step(target, lease);
      const taken = reads.splice(0);
      if (target.aggregationId === seeded.aggregationId) steps.push(Math.max(0, ...taken));
      return done;
    });
    const sweeper = harness.sweeper();
    for (let round = 0; round < 50 && (await sweeper.runOnce()).claimed > 0; round += 1);

    const window = await owner.demandAggregation.findFirst({
      where: { organizationId: seeded.organizationId, id: seeded.aggregationId },
    });
    expect(window).toMatchObject({ status: 'REFERRED', demandsToFollow: 0, endDigestState: null });
    expect(window?.demandIdsSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(steps.length).toBeGreaterThanOrEqual(Math.ceil(SWEPT_LIVE / SWEPT_BATCH) - 1);
    const all = [end, ...steps];
    expect(all.map(bounded)).toEqual(all.map((read) => ({ read, bounded: true })));
  });

  it(`FU-201: beside an open snapshot, ${CHURN_ROUNDS} submit and withdraw rounds leave dead versions that a scan visits past ${READ_BOUND}, and every command still reads at most ${READ_BOUND} rows`, async () => {
    const seeded = await seedWindow('EXTEND', T0, LIVE, SMALL_HISTORY);
    // Analysed, as autovacuum leaves a window that has been there a while (see the third case).
    await owner.$executeRawUnsafe('ANALYZE "demand_request"');
    const clock = new TestClock();
    const { harness, mostRead, mostVisited } = await measuredApi('EXTEND', clock);
    const as = client(harness, buyer(seeded.organizationId));

    clock.set(new Date(T0.getTime() + 9 * HOUR));
    const reads: number[] = [];
    for (let round = 0; round < CHURN_ROUNDS; round += 1) {
      const submitted = await as.submit({ productId: seeded.productId, quantity: 1 });
      expect(submitted.status).toBe(201);
      reads.push(mostRead());
      const withdrawn = await as.withdraw(submitted.body.id, submitted.body.version);
      expect(withdrawn.status).toBe(200);
      reads.push(mostRead());
    }
    mostVisited();
    // One more: its scans of the window meet the dead version of every round.
    const last = await as.submit({ productId: seeded.productId, quantity: 1 });
    expect(last.status).toBe(201);
    reads.push(mostRead());

    // Proof that the case is in the state it is about: the snapshot kept the dead versions, and
    // counting the entries visited, as this spec used to, would have failed the bound with them.
    expect(mostVisited()).toBeGreaterThan(READ_BOUND);
    expect(reads.map(bounded)).toEqual(reads.map((read) => ({ read, bounded: true })));
  });
});
