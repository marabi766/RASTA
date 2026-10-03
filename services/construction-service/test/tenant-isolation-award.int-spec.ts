import { runUnscoped, runWithContext, type RequestContext } from '@rasta/nest-common';
import {
  asAdmin,
  asBidder,
  cleanup,
  context,
  evaluatedTender,
  loadStanding,
  newUserId,
  outboxFor,
  testEnv,
  wire,
  type Wiring,
} from './helpers';

/**
 * Tenant isolation for the award (AGENTS.md § 4, ADR-011, ADR-067 § 3): organization B's people can
 * neither award, nor read the award of, organization A's tender — every refusal is a `404` (never
 * `403`), a refused attempt writes no row and no event and is not logged under A — and B cannot
 * award its own tender to A's bid. A contractor of A reaches nothing of the owner's award, and B's
 * own award is untouched by any of it.
 */

describe('tenant isolation — award', () => {
  let w: Wiring;
  const organizations: string[] = [];
  let a: Awaited<ReturnType<typeof evaluatedTender>>;
  let b: Awaited<ReturnType<typeof evaluatedTender>>;

  const awardsOf = (tenderId: string) =>
    runUnscoped('the suite reads the awards', () =>
      w.prisma.client.tenderAward.findMany({ where: { tenderId } }),
    );

  const statusOf = (bidId: string) =>
    runUnscoped(
      'the suite reads a bid',
      async () => (await w.prisma.client.bid.findFirstOrThrow({ where: { id: bidId } })).status,
    );

  const codeOf = async (call: Promise<unknown>): Promise<string | undefined> =>
    (
      (await call.then(
        () => undefined,
        (e: unknown) => e,
      )) as { code?: string } | undefined
    )?.code;

  beforeAll(async () => {
    w = wire(testEnv({ CONSTRUCTION_TENDER_OPEN_FOUR_EYES: 'false' }));
    await loadStanding(w);
    a = await evaluatedTender(w, organizations, { count: 2 });
    b = await evaluatedTender(w, organizations, { count: 1 });
  });

  afterEach(() => w.memberships.reset());

  afterAll(async () => {
    await cleanup(w.prisma, organizations);
    await w.close();
  });

  it('answers 404 to B on the award of A’s tender, through the route and through the core, and writes and logs nothing', async () => {
    const outboxBefore = (await outboxFor(w.prisma, a.owner)).length;
    const logBefore = await runUnscoped('the suite counts A’s log', () =>
      w.prisma.client.bidAccessLog.count({ where: { tenderId: a.tenderId } }),
    );
    const user = newUserId();
    const asB = <T>(fn: () => T) => asAdmin(b.owner, fn, user);
    for (const call of [
      () => asB(() => w.award.award(a.tenderId, { bidId: a.bids[0]!.bidId })),
      () => asB(() => w.award.awardApproved(a.tenderId, { bidId: a.bids[0]!.bidId })),
      () =>
        asB(() =>
          w.award.awardApproved(a.tenderId, { bidId: a.bids[1]!.bidId, justification: 'x' }),
        ),
    ]) {
      expect(await codeOf(call())).toBe('NOT_FOUND');
    }
    expect(await awardsOf(a.tenderId)).toHaveLength(0);
    expect(
      await runUnscoped('the suite reads A', () =>
        w.prisma.client.tender.findFirstOrThrow({ where: { id: a.tenderId } }),
      ),
    ).toMatchObject({ status: 'EVALUATED' });
    expect(await statusOf(a.bids[0]!.bidId)).toBe('QUALIFIED');
    // Another organization's tender is an unaudited 404 (non-disclosure): A's log and A's event
    // stream learn nothing of the attempts.
    expect(
      await runUnscoped('the suite counts A’s log', () =>
        w.prisma.client.bidAccessLog.count({ where: { tenderId: a.tenderId } }),
      ),
    ).toBe(logBefore);
    expect((await outboxFor(w.prisma, a.owner)).length).toBe(outboxBefore);
    const bOutbox = JSON.stringify(await outboxFor(w.prisma, b.owner), (_k, v: unknown) =>
      typeof v === 'bigint' ? v.toString() : v,
    );
    expect(bOutbox).not.toContain(a.tenderId);
  });

  it('answers a tender that does not exist exactly as another organization’s', async () => {
    const missing = await codeOf(
      asAdmin(b.owner, () => w.award.awardApproved('TND_NONE', { bidId: a.bids[0]!.bidId })),
    );
    const foreign = await codeOf(
      asAdmin(b.owner, () => w.award.awardApproved(a.tenderId, { bidId: a.bids[0]!.bidId })),
    );
    expect(missing).toBe('NOT_FOUND');
    expect(foreign).toBe(missing);
  });

  it('does not let B award its own tender to A’s bid: that bid is not B’s to name', async () => {
    expect(
      await codeOf(
        asAdmin(b.owner, () => w.award.awardApproved(b.tenderId, { bidId: a.bids[0]!.bidId })),
      ),
    ).toBe('NOT_FOUND');
    expect(await awardsOf(b.tenderId)).toHaveLength(0);
    expect(await statusOf(a.bids[0]!.bidId)).toBe('QUALIFIED');
  });

  it('keeps a contractor out of the owner’s award, whichever tender it bid on', async () => {
    for (const contractor of [a.bids[0]!.bidder, b.bids[0]!.bidder]) {
      const call = asBidder(contractor, () =>
        w.award.awardApproved(a.tenderId, { bidId: a.bids[0]!.bidId }),
      );
      // The contractor acts for its own organization, not the tender's owner: ownership first, so 404.
      expect(await codeOf(call)).toBe('NOT_FOUND');
    }
    expect(await awardsOf(a.tenderId)).toHaveLength(0);
  });

  it('awards each owner’s tender on its own, and leaves the other’s exactly as it was', async () => {
    const view = await asAdmin(a.owner, () =>
      w.award.awardApproved(a.tenderId, { bidId: a.bids[0]!.bidId }),
    );
    expect(view).toMatchObject({ tenderId: a.tenderId, bidId: a.bids[0]!.bidId });
    // B's tender and its bid are untouched by A's award.
    expect(await awardsOf(b.tenderId)).toHaveLength(0);
    expect(
      await runUnscoped('the suite reads B', () =>
        w.prisma.client.tender.findFirstOrThrow({ where: { id: b.tenderId } }),
      ),
    ).toMatchObject({ status: 'EVALUATED' });
    expect(await statusOf(b.bids[0]!.bidId)).toBe('QUALIFIED');

    const own = await asAdmin(b.owner, () =>
      w.award.awardApproved(b.tenderId, { bidId: b.bids[0]!.bidId }),
    );
    expect(own).toMatchObject({ tenderId: b.tenderId, bidId: b.bids[0]!.bidId, rank: 1 });
    expect(await awardsOf(a.tenderId)).toHaveLength(1);
  });

  it('answers 404 to B on the read of A’s award, as a person and as a service signed for B, and shows B only its own', async () => {
    const asService = <T>(owner: string, fn: () => T) =>
      runWithContext(
        context({
          authType: 'SERVICE',
          callerService: 'contract-service',
          organizationId: owner,
          roles: [],
        } as Partial<RequestContext>),
        fn,
      );
    expect(await codeOf(asAdmin(b.owner, () => w.award.getAward(a.tenderId)))).toBe('NOT_FOUND');
    expect(await codeOf(asService(b.owner, () => w.award.getAward(a.tenderId)))).toBe('NOT_FOUND');
    const own = await asService(b.owner, () => w.award.getAward(b.tenderId));
    expect(own).toMatchObject({ tenderId: b.tenderId, bidId: b.bids[0]!.bidId });
    expect(JSON.stringify(own)).not.toContain(a.tenderId);
    // A's own read still works, and B's attempts left nothing in A's log.
    expect(await asService(a.owner, () => w.award.getAward(a.tenderId))).toMatchObject({
      tenderId: a.tenderId,
    });
    const aReads = await runUnscoped('the suite reads A’s log', () =>
      w.prisma.client.bidAccessLog.findMany({
        where: { tenderId: a.tenderId, purpose: 'READ_AWARD' },
      }),
    );
    expect(aReads.map((r) => r.accessorUserId)).toEqual(['service:contract-service']);
  });

  it('is scoped by the tenant guard itself: B’s client sees none of A’s awards, A’s none of B’s', async () => {
    // The client is lazy: the query must run inside the scope, hence the awaits in the callbacks.
    const seenByB = await asAdmin(
      b.owner,
      async () => await w.prisma.client.tenderAward.findMany({}),
    );
    expect(seenByB.length).toBeGreaterThan(0);
    for (const row of seenByB) expect(row.organizationId).toBe(b.owner);
    expect(
      await asAdmin(
        b.owner,
        async () =>
          await w.prisma.client.tenderAward.findFirst({ where: { tenderId: a.tenderId } }),
      ),
    ).toBeNull();
    const seenByA = await asAdmin(
      a.owner,
      async () => await w.prisma.client.tenderAward.findMany({}),
    );
    for (const row of seenByA) expect(row.organizationId).toBe(a.owner);
    expect(
      await asAdmin(
        a.owner,
        async () =>
          await w.prisma.client.tenderAward.findFirst({ where: { tenderId: b.tenderId } }),
      ),
    ).toBeNull();
  });

  it('shows a contractor its own outcome and not another tender’s, nor another contractor’s', async () => {
    const mine = await asBidder(a.bids[1]!.bidder, () => w.ownBids.getMineOpened(a.tenderId));
    expect(mine).toMatchObject({ bidId: a.bids[1]!.bidId, status: 'NOT_AWARDED' });
    const seen = JSON.stringify(mine);
    expect(seen).not.toContain(a.bids[0]!.bidder);
    expect(seen).not.toContain(b.tenderId);
    // A contractor of the other tender has no bid here at all.
    expect(
      await codeOf(asBidder(b.bids[0]!.bidder, () => w.ownBids.getMineOpened(a.tenderId))),
    ).toBe('NOT_FOUND');
  });
});
