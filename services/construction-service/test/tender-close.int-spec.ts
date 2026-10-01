import { eventEnvelopeSchema } from '@rasta/contracts';
import { runUnscoped } from '@rasta/nest-common';
import { ulid } from 'ulid';
import {
  asAdmin,
  asBidder,
  bidContent,
  cleanup,
  loadStanding,
  newOrganizationId,
  outboxFor,
  publishedForBids,
  qualify,
  untilASessionWaitsOnALock,
  wire,
  type Wiring,
} from './helpers';

/**
 * Closing a tender (ADR-065 § 3), against PostgreSQL: the sweeper claims overdue tenders
 * with a lease and a fencing token, judges the deadline on the database clock after the
 * tender lock, closes each once and announces it once; and a bid is refused by the same
 * clock whether or not the sweeper ever ran. Every race is ordered by a barrier on the
 * tender clock or by a held row lock, never by a sleep.
 */

const SYSTEM = 'system:construction-service';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};

describe('tender close sweeper', () => {
  let w: Wiring;
  const organizations: string[] = [];

  const org = (): string => {
    const id = newOrganizationId();
    organizations.push(id);
    return id;
  };

  /** A tender of a fresh owner that bidders may bid on now, plus a qualified contractor. */
  const setup = async () => {
    const owner = org();
    const bidder = org();
    await qualify(w, bidder);
    const { tenderId } = await publishedForBids(w, owner);
    return { owner, bidder, tenderId };
  };

  const sql = (reason: string, statement: string) =>
    runUnscoped(reason, () => w.prisma.client.$executeRawUnsafe(statement));

  /** The window ended a minute ago, by the database's clock. */
  const makeOverdue = (tenderId: string) =>
    sql(
      'the suite lets the deadline pass',
      `UPDATE "tender" SET "bid_opening_at" = now() - interval '2 hours',
         "bid_closing_at" = now() - interval '1 minute' WHERE "id" = '${tenderId}'`,
    );

  const rowOf = (tenderId: string) =>
    runUnscoped('the suite reads the tender it made', () =>
      w.prisma.client.tender.findFirstOrThrow({ where: { id: tenderId } }),
    );

  const closedEvents = async (owner: string) =>
    (await outboxFor(w.prisma, owner)).filter((row) => row.eventName === 'TENDER_CLOSED');

  const submit = (bidder: string, tenderId: string) =>
    asBidder(bidder, () => w.bids.submit(tenderId, { content: bidContent() }));

  const refusalOf = async (call: Promise<unknown>): Promise<string> => {
    const error = (await call.then(
      () => undefined,
      (e: unknown) => e,
    )) as { code?: string; message?: string } | undefined;
    expect(error?.code).toBe('BUSINESS_RULE_VIOLATION');
    return error?.message ?? '';
  };

  /**
   * Claims as a sweeper would and returns the claim on `tenderId`; whatever else was
   * overdue in the shared database is given back, so no other test's tender stays leased.
   */
  const claimOnly = async (tenderId: string, fence: string, leaseSeconds = 600) => {
    const claimed = await w.tenderCloses.claimDue(500, leaseSeconds, fence);
    const mine = claimed.find((c) => c.id === tenderId);
    expect(mine).toBeDefined();
    await sql(
      'the suite gives back the claims it did not mean to take',
      `UPDATE "tender" SET "close_lease_until" = NULL, "close_fence" = NULL
        WHERE "close_fence" = '${fence}' AND "id" <> '${tenderId}'`,
    );
    return mine!;
  };

  const expireLease = (tenderId: string) =>
    sql(
      'the suite lets a lease run out',
      `UPDATE "tender" SET "close_lease_until" = now() - interval '1 second' WHERE "id" = '${tenderId}'`,
    );

  /** Waits (bounded, on the database's own clock) for a tender's deadline to pass. */
  const untilDeadlinePassed = async (tenderId: string, timeoutMs = 10_000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const rows = await runUnscoped('the suite reads the database clock', () =>
        w.prisma.client.$queryRawUnsafe<{ past: boolean }[]>(
          `SELECT clock_timestamp() >= "bid_closing_at" AS "past" FROM "tender" WHERE "id" = '${tenderId}'`,
        ),
      );
      if (rows[0]?.past) return;
      if (Date.now() > deadline) throw new Error('the deadline did not pass in time');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };

  beforeAll(async () => {
    w = wire();
    await loadStanding(w);
  });

  afterEach(() => {
    w.clock.fixed = undefined;
    w.clock.onDecision = undefined;
  });

  afterAll(async () => {
    await cleanup(w.prisma, organizations);
    await w.close();
  });

  describe('closing', () => {
    it('closes an overdue tender once, in the owner tenant, and announces it', async () => {
      const { owner, bidder, tenderId } = await setup();
      await submit(bidder, tenderId);
      const before = await rowOf(tenderId);
      await makeOverdue(tenderId);

      await w.tenderCloseSweeper.runOnce();

      const row = await rowOf(tenderId);
      expect(row).toMatchObject({
        status: 'CLOSED',
        closedBy: SYSTEM,
        statusChangedBy: SYSTEM,
        version: before.version + 1,
        closeLeaseUntil: null,
        closeFence: null,
      });
      expect(row.closedAt!.getTime()).toBeGreaterThanOrEqual(row.bidClosingAt!.getTime());
      expect(row.statusChangedAt).toEqual(row.closedAt);

      const [event, ...rest] = await closedEvents(owner);
      expect(rest).toHaveLength(0);
      expect(event).toMatchObject({
        aggregateType: 'Tender',
        aggregateId: tenderId,
        partitionKey: tenderId,
        organizationId: owner,
      });
      expect(eventEnvelopeSchema.parse(event!.payload).payload).toEqual({
        tenderId,
        projectId: before.projectId,
        organizationId: owner,
        bidCount: 1,
        closedAt: row.closedAt!.toISOString(),
        closedBy: SYSTEM,
      });
    });

    it('counts the bids standing, not the withdrawn ones, and carries nothing of them', async () => {
      const { owner, bidder, tenderId } = await setup();
      const second = org();
      await qualify(w, second);
      await submit(bidder, tenderId);
      const withdrawing = await submit(second, tenderId);
      await asBidder(second, () =>
        w.bids.withdraw(tenderId, withdrawing.bidId, { expectedRevision: 1 }),
      );
      await makeOverdue(tenderId);

      await w.tenderCloseSweeper.runOnce();

      const [event] = await closedEvents(owner);
      const payload = eventEnvelopeSchema.parse(event!.payload).payload;
      expect(payload).toMatchObject({ bidCount: 1 });
      expect(JSON.stringify(event!.payload)).not.toMatch(/1250000000|Mobilisation|bidder/i);
    });

    it('leaves a tender whose deadline has not passed alone', async () => {
      const { owner, tenderId } = await setup();

      await w.tenderCloseSweeper.runOnce();

      expect(await rowOf(tenderId)).toMatchObject({
        status: 'PUBLISHED',
        closeFence: null,
        closeLeaseUntil: null,
      });
      expect(await closedEvents(owner)).toHaveLength(0);
    });

    it('is idempotent: a second sweep, a direct close and a replay add no event', async () => {
      const { owner, tenderId } = await setup();
      await makeOverdue(tenderId);
      await w.tenderCloseSweeper.runOnce();
      const closed = await rowOf(tenderId);

      await w.tenderCloseSweeper.runOnce();
      expect(await w.tenderClose.close({ organizationId: owner, tenderId })).toBe('NOOP');
      expect(await w.tenderClose.close({ organizationId: owner, tenderId, fence: ulid() })).toBe(
        'NOT_OWNER',
      );

      expect(await rowOf(tenderId)).toEqual(closed);
      expect(await closedEvents(owner)).toHaveLength(1);
    });

    it('refuses to close before the deadline, judged on the clock after the lock', async () => {
      const { owner, tenderId } = await setup();
      await makeOverdue(tenderId);
      const fence = ulid();
      await claimOnly(tenderId, fence);
      // The deadline is moved out after the claim: the claim was a first cut, not the decision.
      await sql(
        'the owner moves the deadline out',
        `UPDATE "tender" SET "bid_closing_at" = now() + interval '1 hour' WHERE "id" = '${tenderId}'`,
      );

      expect(await w.tenderClose.close({ organizationId: owner, tenderId, fence })).toBe('NOT_DUE');

      expect(await rowOf(tenderId)).toMatchObject({
        status: 'PUBLISHED',
        closeFence: null,
        closeLeaseUntil: null,
      });
      expect(await closedEvents(owner)).toHaveLength(0);
    });
  });

  describe('two sweepers', () => {
    it('close every tender once between them, and one event each', async () => {
      const made = [await setup(), await setup(), await setup(), await setup()];
      for (const { tenderId } of made) await makeOverdue(tenderId);
      const a = w.tenderCloseSweeperWith({ batchSize: 2 });
      const b = w.tenderCloseSweeperWith({ batchSize: 2 });

      for (let round = 0; round < 10; round += 1) {
        await Promise.all([a.runOnce(), b.runOnce()]);
        const states = await Promise.all(made.map(({ tenderId }) => rowOf(tenderId)));
        if (states.every((row) => row.status === 'CLOSED')) break;
      }

      for (const { owner, tenderId } of made) {
        expect(await rowOf(tenderId)).toMatchObject({ status: 'CLOSED', closeFence: null });
        expect(await closedEvents(owner)).toHaveLength(1);
      }
    });

    it('skip a tender another session holds, instead of waiting for it', async () => {
      const { owner, tenderId } = await setup();
      await makeOverdue(tenderId);
      const held = deferred();
      const free = deferred();
      const holder = runUnscoped('the suite holds the tender row', () =>
        w.prisma.client.$transaction(async (tx) => {
          await tx.$queryRawUnsafe(`SELECT 1 FROM "tender" WHERE "id" = '${tenderId}' FOR UPDATE`);
          held.resolve();
          await free.promise;
        }),
      );
      await held.promise;

      await w.tenderCloseSweeper.runOnce(); // returns at once: the held row is skipped
      expect(await rowOf(tenderId)).toMatchObject({ status: 'PUBLISHED', closeFence: null });

      free.resolve();
      await holder;
      await w.tenderCloseSweeper.runOnce();
      expect(await rowOf(tenderId)).toMatchObject({ status: 'CLOSED' });
      expect(await closedEvents(owner)).toHaveLength(1);
    });
  });

  describe('a crash between the claim and the close', () => {
    it('leaves the tender claimed until the lease ends, then another sweeper closes it', async () => {
      const { owner, tenderId } = await setup();
      await makeOverdue(tenderId);
      const crashed = await claimOnly(tenderId, ulid()); // claimed, then the process died

      await w.tenderCloseSweeper.runOnce(); // the lease is live: not taken
      expect(await rowOf(tenderId)).toMatchObject({
        status: 'PUBLISHED',
        closeFence: crashed.fence,
      });

      await expireLease(tenderId);
      await w.tenderCloseSweeper.runOnce();

      expect(await rowOf(tenderId)).toMatchObject({ status: 'CLOSED', closeFence: null });
      expect(await closedEvents(owner)).toHaveLength(1);
    });

    it('turns a worker whose lease was taken back into a no-op: no change, no event', async () => {
      const { owner, tenderId } = await setup();
      await makeOverdue(tenderId);
      const stale = await claimOnly(tenderId, ulid());
      await expireLease(tenderId);
      const current = await claimOnly(tenderId, ulid());
      expect(current.fence).not.toBe(stale.fence);

      // The slow first worker wakes up while the second holds the claim.
      expect(
        await w.tenderClose.close({ organizationId: owner, tenderId, fence: stale.fence }),
      ).toBe('NOT_OWNER');
      expect(await rowOf(tenderId)).toMatchObject({
        status: 'PUBLISHED',
        closeFence: current.fence,
      });
      expect(await closedEvents(owner)).toHaveLength(0);

      expect(
        await w.tenderClose.close({ organizationId: owner, tenderId, fence: current.fence }),
      ).toBe('CLOSED');
      // And once it is closed the stale worker still cannot add a second.
      expect(
        await w.tenderClose.close({ organizationId: owner, tenderId, fence: stale.fence }),
      ).toBe('NOT_OWNER');
      expect(await closedEvents(owner)).toHaveLength(1);
    });
  });

  describe('closing against a last-second bid', () => {
    it('a bid that committed before the deadline is counted when the tender is closed', async () => {
      const { owner, bidder, tenderId } = await setup();
      const receipt = await submit(bidder, tenderId);
      // The deadline as it stood when the bid was accepted; the suite then lets it pass.
      const deadline = (await rowOf(tenderId)).bidClosingAt!;
      await makeOverdue(tenderId);

      await w.tenderCloseSweeper.runOnce();

      expect(new Date(receipt.receivedAt).getTime()).toBeLessThan(deadline.getTime());
      const [event] = await closedEvents(owner);
      expect(eventEnvelopeSchema.parse(event!.payload).payload).toMatchObject({ bidCount: 1 });
    });

    it('a bid queued behind the close finds the tender closed and is refused', async () => {
      const { owner, bidder, tenderId } = await setup();
      await makeOverdue(tenderId);
      const reached = deferred();
      const release = deferred();
      w.clock.onDecision = async () => {
        reached.resolve();
        await release.promise;
      };

      // The close holds the tender row, having decided it is due...
      const closing = w.tenderClose.close({ organizationId: owner, tenderId });
      await reached.promise;
      // ...and the bid, which arrived after, waits on it.
      const bidding = refusalOf(submit(bidder, tenderId));
      await untilASessionWaitsOnALock(w.prisma);
      release.resolve();

      expect(await closing).toBe('CLOSED');
      expect(await bidding).toContain('BID_WINDOW_CLOSED');
      expect(await rowOf(tenderId)).toMatchObject({ status: 'CLOSED' });
      expect(await closedEvents(owner)).toHaveLength(1);
      const bids = await runUnscoped('the suite counts the bids', () =>
        w.prisma.client.bid.count({ where: { tenderId } }),
      );
      expect(bids).toBe(0);
    });

    it('a close queued behind a bid that decided inside the window waits, and the late write is refused', async () => {
      const { owner, bidder, tenderId } = await setup();
      await sql(
        'the deadline is one second away',
        `UPDATE "tender" SET "bid_opening_at" = now() - interval '2 hours',
           "bid_closing_at" = now() + interval '1 second' WHERE "id" = '${tenderId}'`,
      );
      const decided = deferred();
      const release = deferred();
      w.clock.onDecision = async () => {
        decided.resolve();
        await release.promise;
      };

      // The bid holds the tender row (shared) and has read its instant...
      const bidding = refusalOf(submit(bidder, tenderId));
      await decided.promise;
      // ...the real deadline passes while it holds it...
      await untilDeadlinePassed(tenderId);
      // ...and the close, due now, queues behind it.
      const closing = w.tenderClose.close({ organizationId: owner, tenderId });
      await untilASessionWaitsOnALock(w.prisma);
      release.resolve();

      // Whatever the application decided, the database refuses a write after the deadline.
      expect(await bidding).toContain('BID_WINDOW_CLOSED');
      expect(await closing).toBe('CLOSED');
      const [event] = await closedEvents(owner);
      expect(eventEnvelopeSchema.parse(event!.payload).payload).toMatchObject({ bidCount: 0 });
      const bids = await runUnscoped('the suite counts the bids', () =>
        w.prisma.client.bid.count({ where: { tenderId } }),
      );
      expect(bids).toBe(0);
    });
  });

  describe('with no sweeper running', () => {
    it('still refuses a bid after the deadline, by the database clock, and closes when it runs', async () => {
      const { owner, bidder, tenderId } = await setup();
      await makeOverdue(tenderId);

      // Nobody has closed it: the status is still PUBLISHED, and the bid is refused anyway.
      expect(await rowOf(tenderId)).toMatchObject({ status: 'PUBLISHED' });
      expect(await refusalOf(submit(bidder, tenderId))).toContain('BID_WINDOW_CLOSED');
      expect((await w.tenderCloses.backlog()).overdue).toBeGreaterThanOrEqual(1);

      await w.tenderCloseSweeper.runOnce();

      expect(await rowOf(tenderId)).toMatchObject({ status: 'CLOSED' });
      expect(await closedEvents(owner)).toHaveLength(1);
      expect(await refusalOf(submit(bidder, tenderId))).toContain('BID_WINDOW_CLOSED');
    });

    it('reports the backlog and how long the oldest has waited, and the sweep empties it', async () => {
      const { tenderId } = await setup();
      await makeOverdue(tenderId);

      const before = await w.tenderCloses.backlog();
      expect(before.overdue).toBeGreaterThanOrEqual(1);
      expect(before.oldestOverdueAgeSeconds).toBeGreaterThanOrEqual(60);

      await w.tenderCloseSweeper.runOnce();
      const after = await w.tenderCloses.backlog();
      expect(after.overdue).toBeLessThan(before.overdue);
    });
  });

  describe('tenant isolation', () => {
    it('closes each tender in its own organization and never writes into another', async () => {
      const first = await setup();
      const second = await setup();
      await makeOverdue(first.tenderId);
      await makeOverdue(second.tenderId);

      await w.tenderCloseSweeper.runOnce();

      for (const mine of [first, second]) {
        const events = await closedEvents(mine.owner);
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
          organizationId: mine.owner,
          partitionKey: mine.tenderId,
        });
        expect(await rowOf(mine.tenderId)).toMatchObject({
          status: 'CLOSED',
          organizationId: mine.owner,
        });
      }
    });

    it("cannot be pointed at another organization's tender", async () => {
      const mine = await setup();
      const other = await setup();
      await makeOverdue(other.tenderId);

      // The right tender id under the wrong organization finds nothing and changes nothing.
      expect(
        await w.tenderClose.close({ organizationId: mine.owner, tenderId: other.tenderId }),
      ).toBe('NOT_FOUND');
      expect(await rowOf(other.tenderId)).toMatchObject({ status: 'PUBLISHED' });
      expect(await closedEvents(mine.owner)).toHaveLength(0);
      expect(await closedEvents(other.owner)).toHaveLength(0);

      // A closed tender is as invisible to a stranger as an open one.
      await w.tenderCloseSweeper.runOnce();
      expect(await rowOf(other.tenderId)).toMatchObject({ status: 'CLOSED' });
      await expect(asAdmin(mine.owner, () => w.tenders.get(other.tenderId))).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });
  });

  describe('what the database keeps', () => {
    it('refuses a closure that names nobody, and a lease without a fence', async () => {
      const { tenderId } = await setup();
      await expect(
        sql(
          'the suite attacks the table',
          `UPDATE "tender" SET "closed_at" = now() WHERE "id" = '${tenderId}'`,
        ),
      ).rejects.toThrow(/ck_tender_closure_complete/);
      await expect(
        sql(
          'the suite attacks the table',
          `UPDATE "tender" SET "close_fence" = 'F' WHERE "id" = '${tenderId}'`,
        ),
      ).rejects.toThrow(/ck_tender_close_lease/);
      // Closed before its deadline is not a closure.
      await expect(
        sql(
          'the suite attacks the table',
          `UPDATE "tender" SET "status" = 'CLOSED', "closed_at" = "bid_closing_at" - interval '1 second',
             "closed_by" = 'U', "status_changed_at" = now() WHERE "id" = '${tenderId}'`,
        ),
      ).rejects.toThrow(/ck_tender_closure_complete/);
    });
  });
});
