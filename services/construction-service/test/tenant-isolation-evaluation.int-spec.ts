import { runUnscoped } from '@rasta/nest-common';
import {
  asAdmin,
  asBidder,
  cleanup,
  evaluatingTender,
  loadStanding,
  newUserId,
  outboxFor,
  testEnv,
  wire,
  type Wiring,
} from './helpers';

/**
 * Tenant isolation for evaluation (AGENTS.md § 4, ADR-011, ADR-067): organization B's evaluators
 * can neither decide on, score, stand down from, complete nor read the matrix of organization A's
 * tender — every refusal is a `404` (never `403`), a refused attempt writes no row of the
 * evaluation and leaves its refusal in **A's** access log — a contractor reaches nothing of the
 * owner's evaluation, and B's own evaluation is untouched by any of it.
 */

const FULL = [
  { criterionCode: 'PRICE', scoreScaled: 8_500 },
  { criterionCode: 'LICENCE', scoreScaled: 100 },
];

describe('tenant isolation — evaluation', () => {
  let w: Wiring;
  const organizations: string[] = [];
  let a: Awaited<ReturnType<typeof evaluatingTender>>;
  let b: Awaited<ReturnType<typeof evaluatingTender>>;

  const rowsOf = (tenderId: string) =>
    runUnscoped('the suite reads what evaluation wrote', async () => ({
      qualifications: await w.prisma.client.bidQualification.count({ where: { tenderId } }),
      evaluations: await w.prisma.client.bidEvaluation.count({ where: { tenderId } }),
      recusals: await w.prisma.client.bidEvaluationRecusal.count({ where: { tenderId } }),
      scores: await w.prisma.client.bidEvaluationScore.count({ where: { tenderId } }),
    }));

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
    a = await evaluatingTender(w, organizations, 2);
    b = await evaluatingTender(w, organizations, 1);
    // A has a decision and a score of its own, so "B changes nothing of A's" is not "A has nothing".
    await asAdmin(a.owner, () =>
      w.evaluation.qualify(a.tenderId, a.bids[0]!.bidId, { decision: 'QUALIFIED' }),
    );
    await asAdmin(a.owner, () =>
      w.evaluation.score(a.tenderId, a.bids[0]!.bidId, { scores: FULL }),
    );
  });

  afterEach(() => w.memberships.reset());

  afterAll(async () => {
    await cleanup(w.prisma, organizations);
    await w.close();
  });

  it('answers 404 to B on every evaluation route for A’s tender, writes nothing, and logs each attempt under A', async () => {
    const before = await rowsOf(a.tenderId);
    const outboxBefore = (await outboxFor(w.prisma, a.owner)).length;
    const bid = a.bids[1]!.bidId;
    const evaluator = newUserId();
    const asB = <T>(fn: () => T) => asAdmin(b.owner, fn, evaluator);

    const calls: [string, () => Promise<unknown>][] = [
      [
        'QUALIFY_BID',
        () => asB(() => w.evaluation.qualify(a.tenderId, bid, { decision: 'QUALIFIED' })),
      ],
      [
        'SCORE_BID',
        () => asB(() => w.evaluation.score(a.tenderId, a.bids[0]!.bidId, { scores: FULL })),
      ],
      ['RECUSE', () => asB(() => w.evaluation.recuse(a.tenderId, bid, { reasonCode: 'OTHER' }))],
      ['EVALUATE_BIDS', () => asB(() => w.evaluation.evaluate(a.tenderId))],
      ['READ_EVALUATION', () => asB(() => w.evaluation.getMatrix(a.tenderId))],
    ];
    for (const [, call] of calls) expect(await codeOf(call())).toBe('NOT_FOUND');

    expect(await rowsOf(a.tenderId)).toEqual(before);
    expect(
      (
        await runUnscoped('the suite reads A', () =>
          w.prisma.client.tender.findFirstOrThrow({ where: { id: a.tenderId } }),
        )
      ).status,
    ).toBe('EVALUATING');

    const refused = (
      await runUnscoped('the suite reads A’s access log', () =>
        w.prisma.client.bidAccessLog.findMany({
          where: { tenderId: a.tenderId, accessorUserId: evaluator },
        }),
      )
    ).sort((x, y) => (x.purpose < y.purpose ? -1 : 1));
    expect(refused.map((r) => [r.purpose, r.outcome, r.refusalCode])).toEqual(
      ['EVALUATE_BIDS', 'QUALIFY_BID', 'READ_EVALUATION', 'RECUSE', 'SCORE_BID'].map((p) => [
        p,
        'REFUSED',
        'NOT_FOUND',
      ]),
    );
    for (const row of refused) {
      expect(row).toMatchObject({ organizationId: a.owner, accessorOrganizationId: b.owner });
    }
    // The attempt leaves BID_ACCESSED for A; B's own stream has none of it, and A's evaluation events did not grow.
    expect((await outboxFor(w.prisma, a.owner)).length).toBe(outboxBefore + 5);
    const bOutbox = JSON.stringify(await outboxFor(w.prisma, b.owner), (_k, v: unknown) =>
      typeof v === 'bigint' ? v.toString() : v,
    );
    expect(bOutbox).not.toContain(a.tenderId);
  });

  it('answers a tender that does not exist exactly as another organization’s, and logs nothing for it', async () => {
    const missing = await codeOf(asAdmin(b.owner, () => w.evaluation.getMatrix('TND_NONE')));
    const foreign = await codeOf(asAdmin(b.owner, () => w.evaluation.getMatrix(a.tenderId)));
    expect(missing).toBe('NOT_FOUND');
    expect(foreign).toBe(missing);
  });

  it('shows B only B’s matrix: no bid, decision, cell or total of A’s', async () => {
    const m = await asAdmin(b.owner, () => w.evaluation.getMatrix(b.tenderId));
    expect(m.tenderId).toBe(b.tenderId);
    expect(m.bids.map((x) => x.bidId)).toEqual(b.bids.map((x) => x.bidId));
    const json = JSON.stringify(m);
    for (const bid of a.bids) {
      expect(json).not.toContain(bid.bidId);
      expect(json).not.toContain(bid.bidder);
    }
    expect(json).not.toContain(a.tenderId);
  });

  it('is scoped by the tenant guard itself: B’s client sees none of A’s evaluation rows', async () => {
    const seen = await asAdmin(b.owner, async () => ({
      qualifications: await w.prisma.client.bidQualification.findMany({}),
      evaluations: await w.prisma.client.bidEvaluation.findMany({}),
      recusals: await w.prisma.client.bidEvaluationRecusal.findMany({}),
      scores: await w.prisma.client.bidEvaluationScore.findMany({}),
    }));
    for (const rows of Object.values(seen)) {
      for (const row of rows) expect(row.organizationId).toBe(b.owner);
    }
    // And what A holds is there, to B's client or not: the suite's own view.
    expect((await rowsOf(a.tenderId)).scores).toBe(2);
  });

  it('keeps A’s decision and total exactly as they were after all of that', async () => {
    const m = await asAdmin(a.owner, () => w.evaluation.getMatrix(a.tenderId));
    const entry = m.bids.find((x) => x.bidId === a.bids[0]!.bidId)!;
    expect(entry.qualification?.decision).toBe('QUALIFIED');
    expect(entry.totalScaled).toBe((6000n * 8_500n + 4000n * 100n).toString());
    expect(m.bids.find((x) => x.bidId === a.bids[1]!.bidId)?.qualification).toBeNull();
  });

  it('keeps a contractor out of the owner’s evaluation routes, and its own read is its own bid only', async () => {
    const contractor = a.bids[0]!.bidder;
    const asContractor = <T>(fn: () => T) => asBidder(contractor, fn);
    for (const call of [
      () => asContractor(() => w.evaluation.getMatrix(a.tenderId)),
      () =>
        asContractor(() =>
          w.evaluation.qualify(a.tenderId, a.bids[1]!.bidId, { decision: 'QUALIFIED' }),
        ),
      () => asContractor(() => w.evaluation.score(a.tenderId, a.bids[0]!.bidId, { scores: FULL })),
      () => asContractor(() => w.evaluation.evaluate(a.tenderId)),
    ]) {
      expect(await codeOf(call())).toBe('FORBIDDEN');
    }
    // It reads its own bid; the other contractor's is not reachable by any argument.
    const view = await asContractor(() => w.ownBids.getMineOpened(a.tenderId));
    expect(view.bidId).toBe(a.bids[0]!.bidId);
    expect(JSON.stringify(view)).not.toContain(a.bids[1]!.bidId);
    // A contractor of another tender has no bid here at all.
    const other = b.bids[0]!.bidder;
    expect(await codeOf(asBidder(other, () => w.ownBids.getMineOpened(a.tenderId)))).toBe(
      'NOT_FOUND',
    );
    expect(await rowsOf(a.tenderId)).toMatchObject({ scores: 2 });
  });
});
