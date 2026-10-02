import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { eventEnvelopeSchema } from '@rasta/contracts';
import { RastaError, runUnscoped, runWithContext } from '@rasta/nest-common';
import { PrismaClient } from '../src/generated/prisma';
import { matrixDigest } from '../src/tender/evaluation-matrix';
import {
  SUPPLIER,
  asAdmin,
  cleanup,
  context,
  evaluatingTender,
  loadStanding,
  newUserId,
  asBidder,
  bidContent,
  newOrganizationId,
  outboxFor,
  ownerDatabaseUrl,
  publishedForBids,
  qualify as makeEligible,
  testEnv,
  untilASessionWaitsOnALock,
  wire,
  type Wiring,
} from './helpers';

/**
 * Evaluating the opened bids of a tender, against PostgreSQL (ADR-067 § 2, § 4): decisions on
 * bids, the matrix of scores against the frozen criteria, recusal, the conflict-of-interest rules
 * in both states, the completion of the evaluation and the freezing of the matrix — each change
 * audited with its event in the same transaction, timestamps from the clock read after the lock,
 * and every table append-only for every writer.
 */

const payloadOf = (row: { payload: unknown }) => eventEnvelopeSchema.parse(row.payload).payload;
const occurredOf = (row: { payload: unknown }) =>
  new Date(eventEnvelopeSchema.parse(row.payload).occurredAt);

const FULL = [
  { criterionCode: 'PRICE', scoreScaled: 8_500 },
  { criterionCode: 'LICENCE', scoreScaled: 100 },
];

describe('evaluating the opened bids of a tender', () => {
  let w: Wiring;
  /** A committee: up to two evaluators per bid, two required. */
  let committee: Wiring;
  /** The optional conflict rule that the tender's author does not evaluate, switched on. */
  let strict: Wiring;
  const organizations: string[] = [];

  const sql = (reason: string, statement: string) =>
    runUnscoped(reason, () => w.prisma.client.$executeRawUnsafe(statement));

  const rowOf = (tenderId: string) =>
    runUnscoped('the suite reads the tender', () =>
      w.prisma.client.tender.findFirstOrThrow({ where: { id: tenderId } }),
    );

  const bidRow = (bidId: string) =>
    runUnscoped('the suite reads a bid', () =>
      w.prisma.client.bid.findFirstOrThrow({ where: { id: bidId } }),
    );

  const logOf = (tenderId: string) =>
    runUnscoped('the suite reads the access log', () =>
      w.prisma.client.bidAccessLog.findMany({ where: { tenderId }, orderBy: { id: 'asc' } }),
    );

  const counts = async (tenderId: string) =>
    runUnscoped('the suite counts what evaluation wrote', async () => ({
      qualifications: await w.prisma.client.bidQualification.count({ where: { tenderId } }),
      evaluations: await w.prisma.client.bidEvaluation.count({ where: { tenderId } }),
      recusals: await w.prisma.client.bidEvaluationRecusal.count({ where: { tenderId } }),
      scores: await w.prisma.client.bidEvaluationScore.count({ where: { tenderId } }),
    }));

  const eventsOf = async (owner: string, name: string, tenderId?: string) =>
    (await outboxFor(w.prisma, owner)).filter(
      (row) => row.eventName === name && (tenderId === undefined || row.aggregateId === tenderId),
    );

  const evaluating = (count = 2) => evaluatingTender(w, organizations, count);

  const as = <T>(owner: string, fn: () => T, userId?: string) => asAdmin(owner, fn, userId);

  const qualify = (
    owner: string,
    tenderId: string,
    bidId: string,
    userId?: string,
    on: Wiring = w,
  ) => as(owner, () => on.evaluation.qualify(tenderId, bidId, { decision: 'QUALIFIED' }), userId);

  const disqualify = (owner: string, tenderId: string, bidId: string, userId?: string) =>
    as(
      owner,
      () =>
        w.evaluation.qualify(tenderId, bidId, {
          decision: 'DISQUALIFIED',
          reasonCode: 'NON_RESPONSIVE',
          reasonText: 'Left out the licence the tender asked for',
        }),
      userId,
    );

  const score = (
    owner: string,
    tenderId: string,
    bidId: string,
    scores: { criterionCode: string; scoreScaled: number }[] = FULL,
    userId?: string,
    on: Wiring = w,
  ) => as(owner, () => on.evaluation.score(tenderId, bidId, { scores }), userId);

  const evaluate = (owner: string, tenderId: string, userId?: string) =>
    as(owner, () => w.evaluation.evaluate(tenderId), userId);

  const matrix = (owner: string, tenderId: string, userId?: string) =>
    as(owner, () => w.evaluation.getMatrix(tenderId), userId);

  const codeOf = async (call: Promise<unknown>): Promise<{ code?: string; message?: string }> =>
    ((await call.then(
      () => undefined,
      (e: unknown) => e,
    )) ?? {}) as { code?: string; message?: string };

  /** The refusal's closed reason, from the 422's or 403's message. */
  const refusalOf = async (call: Promise<unknown>, code = 'BUSINESS_RULE_VIOLATION') => {
    const error = await codeOf(call);
    expect(error.code).toBe(code);
    return error.message ?? '';
  };

  beforeAll(async () => {
    // One person opens: the four-eyes rule (Q-91) has its own suite.
    const open = { CONSTRUCTION_TENDER_OPEN_FOUR_EYES: 'false' };
    w = wire(testEnv(open));
    committee = wire(
      testEnv({
        ...open,
        CONSTRUCTION_EVALUATION_MIN_EVALUATORS: '2',
        CONSTRUCTION_EVALUATION_MAX_EVALUATORS: '2',
      }),
    );
    strict = wire(testEnv({ ...open, CONSTRUCTION_COI_RULES: 'EVALUATOR_NOT_TENDER_AUTHOR' }));
    await loadStanding(w);
  });

  afterEach(() => {
    for (const wiring of [w, committee, strict]) {
      wiring.clock.fixed = undefined;
      wiring.clock.onDecision = undefined;
      wiring.memberships.reset();
    }
    SUPPLIER.failure = undefined;
  });

  afterAll(async () => {
    await cleanup(w.prisma, organizations);
    await w.close();
    await committee.close();
    await strict.close();
  });

  // ---------------------------------------------------------------------------------------------

  describe('deciding on a bid', () => {
    it('qualifies an OPENED bid: QUALIFIED, one decision, BID_QUALIFIED with ids and a time, an audit row, all in one transaction', async () => {
      const { owner, tenderId, bids } = await evaluating();
      const bid = bids[0]!;
      const user = newUserId();
      const view = await qualify(owner, tenderId, bid.bidId, user);

      const [decision, ...rest] = await runUnscoped('the suite reads the decision', () =>
        w.prisma.client.bidQualification.findMany({ where: { tenderId, bidId: bid.bidId } }),
      );
      expect(rest).toHaveLength(0);
      expect(decision).toMatchObject({
        organizationId: owner,
        decision: 'QUALIFIED',
        reasonCode: null,
        reasonText: null,
        decidedBy: user,
      });
      // The contractor's standing was read at the decision (Q-85) and is on the record.
      expect(decision!.standingAsOf).not.toBeNull();
      expect(view).toEqual({
        bidId: bid.bidId,
        tenderId,
        decision: 'QUALIFIED',
        reasonCode: null,
        decidedAt: decision!.decidedAt.toISOString(),
        decidedBy: user,
        alreadyDecided: false,
      });
      expect((await bidRow(bid.bidId)).status).toBe('QUALIFIED');
      expect((await rowOf(tenderId)).status).toBe('EVALUATING');

      const [event, ...more] = await eventsOf(owner, 'BID_QUALIFIED', tenderId);
      expect(more).toHaveLength(0);
      expect(event).toMatchObject({
        aggregateType: 'Tender',
        aggregateId: tenderId,
        partitionKey: tenderId,
      });
      expect(occurredOf(event!)).toEqual(decision!.decidedAt);
      expect(payloadOf(event!)).toEqual({
        bidId: bid.bidId,
        tenderId,
        organizationId: owner,
        decidedBy: user,
        decidedAt: decision!.decidedAt.toISOString(),
      });
      expect((await logOf(tenderId)).filter((row) => row.purpose === 'QUALIFY_BID')).toEqual([
        expect.objectContaining({
          bidId: bid.bidId,
          accessorOrganizationId: owner,
          accessorUserId: user,
          outcome: 'GRANTED',
          refusalCode: null,
          accessedAt: decision!.decidedAt,
        }),
      ]);
    });

    it('disqualifies with a closed reason: the code is on the event, the words stay in the database', async () => {
      const { owner, tenderId, bids } = await evaluating();
      const bid = bids[0]!;
      const view = await disqualify(owner, tenderId, bid.bidId);
      expect(view).toMatchObject({
        decision: 'DISQUALIFIED',
        reasonCode: 'NON_RESPONSIVE',
        alreadyDecided: false,
      });
      expect((await bidRow(bid.bidId)).status).toBe('DISQUALIFIED');
      const decision = await runUnscoped('the suite reads the decision', () =>
        w.prisma.client.bidQualification.findFirstOrThrow({
          where: { tenderId, bidId: bid.bidId },
        }),
      );
      expect(decision).toMatchObject({
        reasonCode: 'NON_RESPONSIVE',
        reasonText: 'Left out the licence the tender asked for',
        standingAsOf: null,
      });

      const events = await eventsOf(owner, 'BID_DISQUALIFIED', tenderId);
      expect(events).toHaveLength(1);
      expect(payloadOf(events[0]!)).toMatchObject({
        bidId: bid.bidId,
        reasonCode: 'NON_RESPONSIVE',
      });
      const everything = JSON.stringify(
        [await outboxFor(w.prisma, owner), await logOf(tenderId)],
        (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value),
      );
      expect(everything).not.toContain('Left out the licence');
      // Nothing of what the bid said, or priced, reaches an event or the log.
      expect(everything).not.toMatch(/Fixed price|Licence 1234|priceMinor/);
    });

    it('answers the same decision again with the first, writes nothing, and refuses a different one', async () => {
      const { owner, tenderId, bids } = await evaluating();
      const bid = bids[0]!;
      const first = await qualify(owner, tenderId, bid.bidId);
      const before = await counts(tenderId);
      const eventsBefore = (await outboxFor(w.prisma, owner)).length;

      const again = await qualify(owner, tenderId, bid.bidId);
      expect(again).toEqual({ ...first, alreadyDecided: true });
      expect(await counts(tenderId)).toEqual(before);
      expect((await outboxFor(w.prisma, owner)).length).toBe(eventsBefore);

      expect(await refusalOf(disqualify(owner, tenderId, bid.bidId))).toContain(
        'BID_ALREADY_DECIDED',
      );
      expect((await bidRow(bid.bidId)).status).toBe('QUALIFIED');
    });

    it('asks supplier-service for the contractor’s standing at a qualification (Q-85): not eligible is refused and may be disqualified instead; unreachable refuses and writes nothing', async () => {
      const { owner, tenderId, bids } = await evaluating();
      const [suspended, down] = [bids[0]!, bids[1]!];
      SUPPLIER.suspend(suspended.bidder, `SUS_${suspended.bidder}`);
      expect(await refusalOf(qualify(owner, tenderId, suspended.bidId))).toContain(
        'BIDDER_NOT_ELIGIBLE',
      );
      expect((await bidRow(suspended.bidId)).status).toBe('OPENED');
      expect((await disqualify(owner, tenderId, suspended.bidId)).decision).toBe('DISQUALIFIED');

      SUPPLIER.failure = RastaError.upstreamUnavailable('supplier-service');
      expect((await codeOf(qualify(owner, tenderId, down.bidId))).code).toBe(
        'UPSTREAM_UNAVAILABLE',
      );
      expect((await bidRow(down.bidId)).status).toBe('OPENED');
      SUPPLIER.failure = undefined;
      expect((await qualify(owner, tenderId, down.bidId)).decision).toBe('QUALIFIED');
    });

    it('answers an identical repeat from the record: no question to supplier-service, so a standing that is down or has changed does not fail it', async () => {
      const { owner, tenderId, bids } = await evaluating(1);
      const bid = bids[0]!;
      const first = await qualify(owner, tenderId, bid.bidId);
      const asked = SUPPLIER.asked.length;

      SUPPLIER.failure = RastaError.upstreamUnavailable('supplier-service');
      expect(await qualify(owner, tenderId, bid.bidId)).toEqual({ ...first, alreadyDecided: true });
      SUPPLIER.failure = undefined;
      SUPPLIER.suspend(bid.bidder, `SUS_${bid.bidder}`);
      expect(await qualify(owner, tenderId, bid.bidId)).toEqual({ ...first, alreadyDecided: true });
      expect(SUPPLIER.asked.length).toBe(asked);
      // A NEW decision still asks, and a different one is still refused.
      expect(await refusalOf(disqualify(owner, tenderId, bid.bidId))).toContain(
        'BID_ALREADY_DECIDED',
      );
    });

    it('is refused for a bid that does not exist, for a withdrawn bid (never opened), and for a tender that is not EVALUATING', async () => {
      const owner = newOrganizationId();
      organizations.push(owner);
      const { tenderId } = await publishedForBids(w, owner);
      const [standing, taken] = [newOrganizationId(), newOrganizationId()];
      organizations.push(standing, taken);
      await makeEligible(w, standing);
      await makeEligible(w, taken);
      const kept = await asBidder(standing, () =>
        w.bids.submit(tenderId, { content: bidContent('1') }),
      );
      const back = await asBidder(taken, () =>
        w.bids.submit(tenderId, { content: bidContent('2') }),
      );
      await asBidder(taken, () => w.bids.withdraw(tenderId, back.bidId, { expectedRevision: 1 }));

      // Not yet closed, not yet opened: there is nothing to decide on.
      expect(await refusalOf(qualify(owner, tenderId, kept.bidId))).toContain('NOT_EVALUATING');

      await sql(
        'the suite lets the deadline pass',
        `UPDATE "tender" SET "bid_opening_at" = now() - interval '2 hours',
           "bid_closing_at" = now() - interval '1 minute' WHERE "id" = '${tenderId}'`,
      );
      await w.tenderClose.close({ organizationId: owner, tenderId });
      await as(owner, () => w.tenderOpen.open(tenderId));
      expect((await codeOf(qualify(owner, tenderId, 'BID_NONE'))).code).toBe('NOT_FOUND');
      expect(await refusalOf(qualify(owner, tenderId, back.bidId))).toContain('BID_NOT_OPENED');
      expect((await bidRow(back.bidId)).status).toBe('WITHDRAWN');
      expect((await qualify(owner, tenderId, kept.bidId)).decision).toBe('QUALIFIED');
    });

    it('reads the decision instant from the clock after the tender lock, and writes it on the row and the event', async () => {
      const { owner, tenderId, bids } = await evaluating();
      const instant = new Date(Date.now() + 5_000);
      w.clock.fixed = instant;
      let lockHeld = false;
      w.clock.onDecision = async () => {
        // Another session cannot take the tender row: the instant is being read under the lock.
        lockHeld = await runUnscoped('the suite probes the lock', async () => {
          try {
            await w.prisma.client.$transaction(async (tx) => {
              await tx.$queryRawUnsafe(
                `SELECT 1 FROM "tender" WHERE "id" = '${tenderId}' FOR UPDATE NOWAIT`,
              );
            });
            return false;
          } catch {
            return true;
          }
        });
      };
      await qualify(owner, tenderId, bids[0]!.bidId);
      expect(lockHeld).toBe(true);
      const decision = await runUnscoped('the suite reads the decision', () =>
        w.prisma.client.bidQualification.findFirstOrThrow({ where: { tenderId } }),
      );
      expect(decision.decidedAt).toEqual(instant);
      const [event] = await eventsOf(owner, 'BID_QUALIFIED', tenderId);
      expect(occurredOf(event!)).toEqual(instant);
      expect((payloadOf(event!) as { decidedAt: string }).decidedAt).toBe(instant.toISOString());
    });
  });

  // ---------------------------------------------------------------------------------------------

  describe('scoring against the frozen criteria', () => {
    it('records a score per criterion as an integer × 100, with weights from the frozen template and nothing in code', async () => {
      const { owner, tenderId, bids } = await evaluating();
      const bid = bids[0]!;
      await qualify(owner, tenderId, bid.bidId);
      const user = newUserId();
      const view = await score(owner, tenderId, bid.bidId, FULL, user);
      expect(view).toMatchObject({
        bidId: bid.bidId,
        evaluatorId: user,
        recorded: [
          { criterionCode: 'PRICE', revision: 1, scoreScaled: 8_500 },
          { criterionCode: 'LICENCE', revision: 1, scoreScaled: 100 },
        ],
        unchanged: [],
        complete: true,
      });

      // The total is Σ weightBp × scoreScaled over the weights the tender froze (6000 and 4000).
      const m = await matrix(owner, tenderId);
      const entry = m.bids.find((b) => b.bidId === bid.bidId)!;
      expect(entry.totalScaled).toBe((6000n * 8_500n + 4000n * 100n).toString());
      expect(entry).toMatchObject({ rank: 1, tied: false, evaluatorCount: 1 });
      expect(m.criteria.map((c) => [c.code, c.weightBp])).toEqual([
        ['PRICE', 6000],
        ['LICENCE', 4000],
      ]);
    });

    it('a score changes only by appending: a revision is a new row, the earlier ones stay, the matrix shows the latest', async () => {
      const { owner, tenderId, bids } = await evaluating();
      const bid = bids[0]!;
      await qualify(owner, tenderId, bid.bidId);
      const user = newUserId();
      await score(owner, tenderId, bid.bidId, FULL, user);
      const again = await score(
        owner,
        tenderId,
        bid.bidId,
        [{ criterionCode: 'PRICE', scoreScaled: 9_000 }],
        user,
      );
      expect(again).toMatchObject({
        recorded: [{ criterionCode: 'PRICE', revision: 2, scoreScaled: 9_000 }],
        unchanged: [],
        complete: true,
      });

      const rows = await runUnscoped('the suite reads every revision', () =>
        w.prisma.client.bidEvaluationScore.findMany({
          where: { tenderId, bidId: bid.bidId, criterionCode: 'PRICE' },
          orderBy: { revision: 'asc' },
        }),
      );
      expect(rows.map((r) => [r.revision, r.scoreScaled])).toEqual([
        [1, 8_500],
        [2, 9_000],
      ]);
      const entry = (await matrix(owner, tenderId)).bids.find((b) => b.bidId === bid.bidId)!;
      expect(entry.totalScaled).toBe((6000n * 9_000n + 4000n * 100n).toString());
      expect(entry.evaluations[0]?.cells.find((c) => c.criterionCode === 'PRICE')).toMatchObject({
        revision: 2,
        scoreScaled: 9_000,
      });
    });

    it('writes nothing, and says so, for a score equal to the one standing', async () => {
      const { owner, tenderId, bids } = await evaluating();
      const bid = bids[0]!;
      await qualify(owner, tenderId, bid.bidId);
      const user = newUserId();
      await score(owner, tenderId, bid.bidId, FULL, user);
      const before = await counts(tenderId);
      const eventsBefore = (await eventsOf(owner, 'BID_SCORED', tenderId)).length;
      const view = await score(owner, tenderId, bid.bidId, FULL, user);
      expect(view).toMatchObject({ recorded: [], unchanged: ['PRICE', 'LICENCE'], complete: true });
      expect(await counts(tenderId)).toEqual(before);
      expect((await eventsOf(owner, 'BID_SCORED', tenderId)).length).toBe(eventsBefore);
    });

    it('publishes BID_SCORED with how many cells and a digest of them — never the scores', async () => {
      const { owner, tenderId, bids } = await evaluating();
      const bid = bids[0]!;
      await qualify(owner, tenderId, bid.bidId);
      const user = newUserId();
      const view = await score(owner, tenderId, bid.bidId, FULL, user);
      const [event, ...more] = await eventsOf(owner, 'BID_SCORED', tenderId);
      expect(more).toHaveLength(0);
      const at = (await logOf(tenderId)).find((row) => row.purpose === 'SCORE_BID')!.accessedAt;
      expect(payloadOf(event!)).toEqual({
        bidId: bid.bidId,
        tenderId,
        organizationId: owner,
        evaluationId: view.evaluationId,
        evaluatorId: user,
        recordedCount: 2,
        scoresDigest: createHash('sha256')
          .update(['LICENCE|1|100', 'PRICE|1|8500'].join('\n'))
          .digest('hex'),
        scoredAt: at.toISOString(),
      });
      expect(JSON.stringify(payloadOf(event!))).not.toContain('8500');
    });

    it.each([
      ['PRICE', 10_001, 'SCORE_OUT_OF_RANGE'],
      ['PRICE', -1, 'SCORE_OUT_OF_RANGE'],
      ['LICENCE', 50, 'SCORE_OUT_OF_RANGE'],
      ['LICENCE', 101, 'SCORE_OUT_OF_RANGE'],
      ['EXPERIENCE', 100, 'UNKNOWN_CRITERION'],
    ])(
      'refuses %s scored %i: %s, and writes nothing',
      async (criterionCode, scoreScaled, refusal) => {
        const { owner, tenderId, bids } = await evaluating(1);
        const bid = bids[0]!;
        await qualify(owner, tenderId, bid.bidId);
        const before = await counts(tenderId);
        // A request is all or nothing: the good score beside the bad one is not recorded.
        const scores =
          criterionCode === 'PRICE'
            ? [{ criterionCode, scoreScaled }]
            : [
                { criterionCode: 'PRICE', scoreScaled: 5_000 },
                { criterionCode, scoreScaled },
              ];
        expect(await refusalOf(score(owner, tenderId, bid.bidId, scores))).toContain(refusal);
        expect(await counts(tenderId)).toEqual(before);
      },
    );

    it('scores only a QUALIFIED bid, only while EVALUATING', async () => {
      const { owner, tenderId, bids } = await evaluating();
      const [open, disqualified] = [bids[0]!, bids[1]!];
      expect(await refusalOf(score(owner, tenderId, open.bidId))).toContain('BID_NOT_QUALIFIED');
      await disqualify(owner, tenderId, disqualified.bidId);
      expect(await refusalOf(score(owner, tenderId, disqualified.bidId))).toContain(
        'BID_NOT_QUALIFIED',
      );
      expect((await codeOf(score(owner, tenderId, 'BID_NONE'))).code).toBe('NOT_FOUND');
      expect((await counts(tenderId)).scores).toBe(0);
    });

    it('lets one evaluator score a bid by default, and a second is refused (ADR-067: one evaluator per bid)', async () => {
      const { owner, tenderId, bids } = await evaluating(1);
      const bid = bids[0]!;
      await qualify(owner, tenderId, bid.bidId);
      await score(owner, tenderId, bid.bidId);
      expect(await refusalOf(score(owner, tenderId, bid.bidId))).toContain('EVALUATOR_LIMIT');
      expect((await counts(tenderId)).evaluations).toBe(1);
    });

    it('with a committee, takes the mean of the evaluators’ totals and compares bids exactly', async () => {
      const { owner, tenderId, bids } = await evaluatingTender(committee, organizations, 2);
      const [a, b] = [bids[0]!, bids[1]!];
      for (const bid of [a, b]) await qualify(owner, tenderId, bid.bidId, undefined, committee);
      const [one, two] = [newUserId(), newUserId()];
      const price = (v: number) => [
        { criterionCode: 'PRICE', scoreScaled: v },
        { criterionCode: 'LICENCE', scoreScaled: 100 },
      ];
      // a: 9000 and 7000; b: 8000 and 8000 — the same sum, so the same mean, so a tie.
      await score(owner, tenderId, a.bidId, price(9_000), one, committee);
      await score(owner, tenderId, a.bidId, price(7_000), two, committee);
      await score(owner, tenderId, b.bidId, price(8_000), one, committee);

      // b has one complete evaluator of two: it cannot be completed yet.
      const m1 = await as(owner, () => committee.evaluation.getMatrix(tenderId));
      expect(m1.ready).toBe(false);
      expect(m1.blockers).toEqual([{ bidId: b.bidId, completeEvaluators: 1, required: 2 }]);
      expect(await refusalOf(as(owner, () => committee.evaluation.evaluate(tenderId)))).toContain(
        'EVALUATION_INCOMPLETE',
      );

      await score(owner, tenderId, b.bidId, price(8_000), two, committee);
      // A third evaluator is over the maximum.
      expect(
        await refusalOf(score(owner, tenderId, a.bidId, price(1), newUserId(), committee)),
      ).toContain('EVALUATOR_LIMIT');
      const m2 = await as(owner, () => committee.evaluation.getMatrix(tenderId));
      const sums = m2.bids.map((x) => [x.bidId, x.totalScaled, x.rank, x.tied, x.evaluatorCount]);
      const sum = (6000n * 9_000n + 4000n * 100n + (6000n * 7_000n + 4000n * 100n)).toString();
      expect(sums).toEqual(
        expect.arrayContaining([
          [a.bidId, sum, 1, true, 2],
          [b.bidId, sum, 1, true, 2],
        ]),
      );
      expect(m2.ready).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------------------------

  describe('standing down', () => {
    it('removes the evaluator’s scores from the matrix, bars them from the bid, frees their place, and leaves the record', async () => {
      const { owner, tenderId, bids } = await evaluating(1);
      const bid = bids[0]!;
      await qualify(owner, tenderId, bid.bidId);
      const first = newUserId();
      await score(owner, tenderId, bid.bidId, FULL, first);

      const view = await as(
        owner,
        () => w.evaluation.recuse(tenderId, bid.bidId, { reasonCode: 'CONFLICT_OF_INTEREST' }),
        first,
      );
      expect(view).toMatchObject({
        bidId: bid.bidId,
        evaluatorId: first,
        reasonCode: 'CONFLICT_OF_INTEREST',
        alreadyRecused: false,
      });

      const m = await matrix(owner, tenderId);
      const entry = m.bids[0]!;
      expect(entry).toMatchObject({ evaluatorCount: 0, totalScaled: null, rank: null });
      expect(entry.recusals).toEqual([
        expect.objectContaining({ evaluatorId: first, reasonCode: 'CONFLICT_OF_INTEREST' }),
      ]);
      // Their scores remain in the database — append-only — and out of the matrix.
      expect((await counts(tenderId)).scores).toBe(2);
      expect(m.ready).toBe(false);

      // They may not score or decide on it again, whoever asks.
      expect(
        await refusalOf(score(owner, tenderId, bid.bidId, FULL, first), 'FORBIDDEN'),
      ).toContain('RECUSED');
      // Another evaluator takes the place (one per bid by default) and completes the evaluation.
      await score(owner, tenderId, bid.bidId, FULL, newUserId());
      expect((await matrix(owner, tenderId)).ready).toBe(true);
      expect((await evaluate(owner, tenderId)).status).toBe('EVALUATED');
    });

    it('is publishes BID_EVALUATOR_RECUSED, is audited, is idempotent, and may be done before a decision', async () => {
      const { owner, tenderId, bids } = await evaluating(1);
      const bid = bids[0]!;
      const user = newUserId();
      const recuse = () =>
        as(owner, () => w.evaluation.recuse(tenderId, bid.bidId, { reasonCode: 'OTHER' }), user);
      const first = await recuse();
      expect(first.alreadyRecused).toBe(false);
      const before = await counts(tenderId);
      expect(await recuse()).toEqual({ ...first, alreadyRecused: true });
      expect(await counts(tenderId)).toEqual(before);

      const events = await eventsOf(owner, 'BID_EVALUATOR_RECUSED', tenderId);
      expect(events).toHaveLength(1);
      expect(payloadOf(events[0]!)).toEqual({
        bidId: bid.bidId,
        tenderId,
        organizationId: owner,
        evaluatorId: user,
        reasonCode: 'OTHER',
        recusedAt: first.recusedAt,
      });
      expect((await logOf(tenderId)).filter((row) => row.purpose === 'RECUSE')).toHaveLength(1);
      // The evaluator who stood down does not decide on it either.
      expect(await refusalOf(qualify(owner, tenderId, bid.bidId, user), 'FORBIDDEN')).toContain(
        'RECUSED',
      );
      expect((await bidRow(bid.bidId)).status).toBe('OPENED');
    });
  });

  // ---------------------------------------------------------------------------------------------

  describe('conflict of interest (ADR-067 § 4)', () => {
    it('refuses a member of a bidding organization, by the token, on every route, before anything is said of the tender; each refusal audited with its closed code', async () => {
      const { owner, tenderId, bids } = await evaluating();
      const bid = bids[0]!;
      await qualify(owner, tenderId, bid.bidId);
      const conflicted = newUserId();
      const asMember = <T>(fn: () => T) =>
        runWithContext(
          context({
            organizationId: owner,
            organizationIds: [owner, bids[1]!.bidder],
            userId: conflicted,
            roles: ['ORGANIZATION_ADMIN'],
          }),
          fn,
        );
      const before = await counts(tenderId);

      const calls: [string, () => Promise<unknown>][] = [
        [
          'QUALIFY_BID',
          () =>
            asMember(() => w.evaluation.qualify(tenderId, bid.bidId, { decision: 'QUALIFIED' })),
        ],
        [
          'SCORE_BID',
          () => asMember(() => w.evaluation.score(tenderId, bid.bidId, { scores: FULL })),
        ],
        [
          'RECUSE',
          () => asMember(() => w.evaluation.recuse(tenderId, bid.bidId, { reasonCode: 'OTHER' })),
        ],
        ['EVALUATE_BIDS', () => asMember(() => w.evaluation.evaluate(tenderId))],
        ['READ_EVALUATION', () => asMember(() => w.evaluation.getMatrix(tenderId))],
      ];
      for (const [, call] of calls) {
        const message = await refusalOf(call(), 'FORBIDDEN');
        expect(message).toContain('CONFLICT_OF_INTEREST');
      }
      expect(await counts(tenderId)).toEqual(before);
      const refused = (await logOf(tenderId)).filter((row) => row.outcome === 'REFUSED');
      expect(refused.map((row) => row.purpose).sort()).toEqual(
        ['EVALUATE_BIDS', 'QUALIFY_BID', 'READ_EVALUATION', 'RECUSE', 'SCORE_BID'].sort(),
      );
      for (const row of refused) {
        expect(row).toMatchObject({
          organizationId: owner,
          accessorUserId: conflicted,
          refusalCode: 'CONFLICT_OF_INTEREST',
        });
      }
      const accessed = (await eventsOf(owner, 'BID_ACCESSED', tenderId))
        .map((row) => payloadOf(row) as { outcome: string; refusalCode: string | null })
        .filter((p) => p.outcome === 'REFUSED');
      expect(accessed).toHaveLength(5);
      expect(accessed.every((p) => p.refusalCode === 'CONFLICT_OF_INTEREST')).toBe(true);
    });

    it('judges membership on identity-service as of now: joined a bidder after the token was issued, refused', async () => {
      const { owner, tenderId, bids } = await evaluating();
      const bid = bids[0]!;
      await qualify(owner, tenderId, bid.bidId);
      const user = newUserId();
      w.memberships.of.set(user, [bids[1]!.bidder]);
      const message = await refusalOf(score(owner, tenderId, bid.bidId, FULL, user), 'FORBIDDEN');
      expect(message).toContain('CONFLICT_OF_INTEREST');
      expect((await counts(tenderId)).scores).toBe(0);
      expect(
        (await logOf(tenderId)).filter((r) => r.outcome === 'REFUSED' && r.accessorUserId === user),
      ).toHaveLength(1);
    });

    it('fails closed when identity-service cannot say: nothing is done, the refusal is audited', async () => {
      const { owner, tenderId, bids } = await evaluating();
      const bid = bids[0]!;
      w.memberships.failure = new Error('connect ECONNREFUSED');
      const before = await counts(tenderId);
      for (const call of [
        () => qualify(owner, tenderId, bid.bidId),
        () => matrix(owner, tenderId),
        () => evaluate(owner, tenderId),
      ]) {
        expect((await codeOf(call())).code).toBe('UPSTREAM_UNAVAILABLE');
      }
      expect(await counts(tenderId)).toEqual(before);
      expect((await bidRow(bid.bidId)).status).toBe('OPENED');
    });

    it('refuses a caller identity-service no longer shows in the organization, or without a role that evaluates, although the token is valid', async () => {
      const { owner, tenderId, bids } = await evaluating();
      const revoked = newUserId();
      w.memberships.revoked.add(revoked);
      expect((await codeOf(qualify(owner, tenderId, bids[0]!.bidId, revoked))).code).toBe(
        'FORBIDDEN',
      );
      const demoted = newUserId();
      w.memberships.rolesOf.set(demoted, ['OPERATOR']);
      expect((await codeOf(qualify(owner, tenderId, bids[0]!.bidId, demoted))).code).toBe(
        'FORBIDDEN',
      );
      expect((await bidRow(bids[0]!.bidId)).status).toBe('OPENED');
    });

    it('refuses SYSTEM_ADMIN, AUDITOR and CONTRACTOR whenever present, and another organization’s tender is a 404 that its owner is told of', async () => {
      const { owner, tenderId, bids } = await evaluating(1);
      for (const roles of [
        ['SYSTEM_ADMIN'],
        ['AUDITOR'],
        ['CONTRACTOR'],
        ['SYSTEM_ADMIN', 'ORGANIZATION_ADMIN'],
      ]) {
        const call = runWithContext(
          context({ organizationId: owner, organizationIds: [owner], userId: newUserId(), roles }),
          () => w.evaluation.qualify(tenderId, bids[0]!.bidId, { decision: 'QUALIFIED' }),
        );
        expect((await codeOf(call)).code).toBe('FORBIDDEN');
      }
      // Each of those acted for the tender's own organization: the refusal is audited, with its code.
      const own = (await logOf(tenderId)).filter(
        (row) => row.outcome === 'REFUSED' && row.accessorOrganizationId === owner,
      );
      expect(own).toHaveLength(4);
      for (const row of own) {
        expect(row).toMatchObject({
          organizationId: owner,
          purpose: 'QUALIFY_BID',
          refusalCode: 'FORBIDDEN',
        });
      }
      // The role refusals of every route are logged the same way.
      const roleless = newUserId();
      const routes: [string, () => Promise<unknown>][] = [
        ['SCORE_BID', () => w.evaluation.score(tenderId, bids[0]!.bidId, { scores: FULL })],
        ['RECUSE', () => w.evaluation.recuse(tenderId, bids[0]!.bidId, { reasonCode: 'OTHER' })],
        ['EVALUATE_BIDS', () => w.evaluation.evaluate(tenderId)],
        ['READ_EVALUATION', () => w.evaluation.getMatrix(tenderId)],
      ];
      for (const [, route] of routes) {
        const call = runWithContext(
          context({
            organizationId: owner,
            organizationIds: [owner],
            userId: roleless,
            roles: ['FLEET_MANAGER'],
          }),
          route,
        );
        expect((await codeOf(call)).code).toBe('INSUFFICIENT_ROLE');
      }
      const byRoleless = (await logOf(tenderId)).filter((row) => row.accessorUserId === roleless);
      expect(byRoleless.map((row) => [row.purpose, row.refusalCode]).sort()).toEqual(
        [
          ['EVALUATE_BIDS', 'INSUFFICIENT_ROLE'],
          ['READ_EVALUATION', 'INSUFFICIENT_ROLE'],
          ['RECUSE', 'INSUFFICIENT_ROLE'],
          ['SCORE_BID', 'INSUFFICIENT_ROLE'],
        ].sort(),
      );

      // A tender that is not the caller's own stays an unaudited 404 for a caller without the role too.
      const before = (await logOf(tenderId)).length;
      const strangerWithoutRole = runWithContext(
        context({
          organizationId: 'ORG_STRANGER_EVAL',
          organizationIds: ['ORG_STRANGER_EVAL'],
          userId: newUserId(),
          roles: ['FLEET_MANAGER'],
        }),
        () => w.evaluation.getMatrix(tenderId),
      );
      // Ownership first: the 404 does not depend on the caller's roles, and says nothing of the tender.
      expect((await codeOf(strangerWithoutRole)).code).toBe('NOT_FOUND');
      expect((await logOf(tenderId)).length).toBe(before);

      const stranger = asAdmin('ORG_STRANGER_EVAL', () =>
        w.evaluation.qualify(tenderId, bids[0]!.bidId, { decision: 'QUALIFIED' }),
      );
      expect((await codeOf(stranger)).code).toBe('NOT_FOUND');
      const refusals = (await logOf(tenderId)).filter(
        (row) => row.accessorOrganizationId === 'ORG_STRANGER_EVAL',
      );
      // Another organization's tender is an unaudited 404: nobody's log learns of the probe.
      expect(refusals).toEqual([]);
      expect((await bidRow(bids[0]!.bidId)).status).toBe('OPENED');
    });

    describe('EVALUATOR_NOT_TENDER_AUTHOR', () => {
      it('is off by default: the user who created and published the tender may evaluate it', async () => {
        const { owner, tenderId, bids } = await evaluating(1);
        const tender = await rowOf(tenderId);
        expect(tender.createdBy).toBeTruthy();
        expect((await qualify(owner, tenderId, bids[0]!.bidId, tender.createdBy)).decision).toBe(
          'QUALIFIED',
        );
      });

      it('on, refuses the user who created, and the one who published, the tender — everywhere, audited — and nobody else', async () => {
        const { owner, tenderId, bids } = await evaluatingTender(strict, organizations, 1);
        const bid = bids[0]!;
        const tender = await rowOf(tenderId);
        for (const author of [tender.createdBy, tender.publishedBy!]) {
          const message = await refusalOf(
            as(
              owner,
              () => strict.evaluation.qualify(tenderId, bid.bidId, { decision: 'QUALIFIED' }),
              author,
            ),
            'FORBIDDEN',
          );
          expect(message).toContain('EVALUATOR_IS_TENDER_AUTHOR');
          expect(
            await refusalOf(
              as(owner, () => strict.evaluation.getMatrix(tenderId), author),
              'FORBIDDEN',
            ),
          ).toContain('EVALUATOR_IS_TENDER_AUTHOR');
        }
        expect((await bidRow(bid.bidId)).status).toBe('OPENED');
        const refused = (await logOf(tenderId)).filter(
          (row) => row.refusalCode === 'EVALUATOR_IS_TENDER_AUTHOR',
        );
        expect(refused.length).toBeGreaterThanOrEqual(4);
        // Someone else evaluates it.
        expect((await qualify(owner, tenderId, bid.bidId, newUserId(), strict)).decision).toBe(
          'QUALIFIED',
        );
      });
    });
  });

  // ---------------------------------------------------------------------------------------------

  describe('completing the evaluation', () => {
    const readyTender = async () => {
      const t = await evaluating(2);
      for (const bid of t.bids) {
        await qualify(t.owner, t.tenderId, bid.bidId);
      }
      await score(t.owner, t.tenderId, t.bids[0]!.bidId, FULL);
      await score(t.owner, t.tenderId, t.bids[1]!.bidId, [
        { criterionCode: 'PRICE', scoreScaled: 7_000 },
        { criterionCode: 'LICENCE', scoreScaled: 100 },
      ]);
      return t;
    };

    it('freezes the matrix: EVALUATED, who and when, BIDS_EVALUATED with a count and the matrix digest, one audit row', async () => {
      const { owner, tenderId, bids } = await readyTender();
      const before = await rowOf(tenderId);
      const user = newUserId();
      const view = await evaluate(owner, tenderId, user);

      const row = await rowOf(tenderId);
      expect(row).toMatchObject({
        status: 'EVALUATED',
        evaluatedBy: user,
        version: before.version + 1,
      });
      expect(row.evaluatedAt!.getTime()).toBeGreaterThanOrEqual(row.openedAt!.getTime());
      expect(row.statusChangedAt).toEqual(row.evaluatedAt);
      expect(view).toMatchObject({
        tenderId,
        status: 'EVALUATED',
        evaluatedBy: user,
        evaluatedAt: row.evaluatedAt!.toISOString(),
        qualifiedBidCount: 2,
        alreadyEvaluated: false,
      });

      const [event, ...more] = await eventsOf(owner, 'BIDS_EVALUATED', tenderId);
      expect(more).toHaveLength(0);
      expect(occurredOf(event!)).toEqual(row.evaluatedAt);
      expect(payloadOf(event!)).toEqual({
        tenderId,
        projectId: before.projectId,
        organizationId: owner,
        evaluatedBidCount: 2,
        matrixDigest: view.matrixDigest,
        evaluatedBy: user,
        evaluatedAt: row.evaluatedAt!.toISOString(),
      });
      // The digest is of what is in the database, and is the same afterwards: the matrix did not move.
      const rows = async () =>
        runUnscoped('the suite reads the matrix rows', async () => ({
          qualifications: await w.prisma.client.bidQualification.findMany({ where: { tenderId } }),
          evaluations: await w.prisma.client.bidEvaluation.findMany({ where: { tenderId } }),
          recusals: await w.prisma.client.bidEvaluationRecusal.findMany({ where: { tenderId } }),
          scores: await w.prisma.client.bidEvaluationScore.findMany({ where: { tenderId } }),
        }));
      expect(matrixDigest(await rows())).toBe(view.matrixDigest);
      expect((await logOf(tenderId)).filter((r) => r.purpose === 'EVALUATE_BIDS')).toHaveLength(1);
      expect((await bidRow(bids[0]!.bidId)).status).toBe('QUALIFIED');

      // The ranking is shown and chooses nobody: rank 1 is not an award.
      const m = await matrix(owner, tenderId);
      expect(m).toMatchObject({ status: 'EVALUATED', frozen: true });
      expect(m.bids.map((b) => [b.bidId, b.rank])).toEqual(
        expect.arrayContaining([
          [bids[0]!.bidId, 1],
          [bids[1]!.bidId, 2],
        ]),
      );
      expect((await bidRow(bids[0]!.bidId)).status).not.toBe('AWARDED');
    });

    it('is idempotent: completing again answers the same view and writes nothing', async () => {
      const { owner, tenderId } = await readyTender();
      const first = await evaluate(owner, tenderId);
      const eventsBefore = (await outboxFor(w.prisma, owner)).length;
      const again = await evaluate(owner, tenderId);
      expect(again).toEqual({ ...first, alreadyEvaluated: true });
      expect((await outboxFor(w.prisma, owner)).length).toBe(eventsBefore);
      expect(await eventsOf(owner, 'BIDS_EVALUATED', tenderId)).toHaveLength(1);
    });

    it('is refused while a qualified bid is not scored in full, or an opened bid is undecided (EVALUATION_INCOMPLETE), and changes nothing', async () => {
      const { owner, tenderId, bids } = await evaluating(2);
      await qualify(owner, tenderId, bids[0]!.bidId);
      const user = newUserId();
      await score(
        owner,
        tenderId,
        bids[0]!.bidId,
        [{ criterionCode: 'PRICE', scoreScaled: 5_000 }],
        user,
      );
      // Not scored in full, and another bid undecided.
      expect(await refusalOf(evaluate(owner, tenderId))).toContain('EVALUATION_INCOMPLETE');
      await score(
        owner,
        tenderId,
        bids[0]!.bidId,
        [{ criterionCode: 'LICENCE', scoreScaled: 100 }],
        user,
      );
      expect(await refusalOf(evaluate(owner, tenderId))).toContain('EVALUATION_INCOMPLETE');
      await disqualify(owner, tenderId, bids[1]!.bidId);
      expect((await evaluate(owner, tenderId)).status).toBe('EVALUATED');
      expect(await eventsOf(owner, 'BIDS_EVALUATED', tenderId)).toHaveLength(1);
    });

    it('with no qualified bid is refused: the tender can only be cancelled (NO_QUALIFIED_BID)', async () => {
      const { owner, tenderId, bids } = await evaluating(2);
      for (const bid of bids) await disqualify(owner, tenderId, bid.bidId);
      expect(await refusalOf(evaluate(owner, tenderId))).toContain('NO_QUALIFIED_BID');
      expect(await rowOf(tenderId)).toMatchObject({
        status: 'EVALUATING',
        evaluatedAt: null,
        evaluatedBy: null,
      });
      expect(await eventsOf(owner, 'BIDS_EVALUATED', tenderId)).toHaveLength(0);
    });

    it('after it, every command is refused (NOT_EVALUATING) and the database refuses a row from any writer', async () => {
      const { owner, tenderId, bids } = await readyTender();
      await evaluate(owner, tenderId);
      const before = await counts(tenderId);
      for (const call of [
        () => qualify(owner, tenderId, bids[0]!.bidId),
        () => score(owner, tenderId, bids[0]!.bidId, [{ criterionCode: 'PRICE', scoreScaled: 1 }]),
        () =>
          as(owner, () => w.evaluation.recuse(tenderId, bids[0]!.bidId, { reasonCode: 'OTHER' })),
      ]) {
        expect(await refusalOf(call())).toContain('NOT_EVALUATING');
      }
      expect(await counts(tenderId)).toEqual(before);

      // The same refusal from the database, whatever path forgot (as the runtime role).
      const claim = await runUnscoped('the suite reads a claim', () =>
        w.prisma.client.bidEvaluation.findFirstOrThrow({ where: { tenderId } }),
      );
      await expect(
        sql(
          'the suite writes a cell after the evaluation',
          `INSERT INTO "bid_evaluation_score" ("id", "organization_id", "tender_id", "bid_id", "evaluation_id",
             "evaluator_id", "criterion_code", "revision", "score_scaled", "scored_at")
           VALUES ('BSC_LATE', '${owner}', '${tenderId}', '${claim.bidId}', '${claim.id}',
             '${claim.evaluatorId}', 'PRICE', 2, 1, now())`,
        ),
      ).rejects.toThrow(/ck_evaluation_open/);
      await expect(
        sql(
          'the suite recuses after the evaluation',
          `INSERT INTO "bid_evaluation_recusal" ("id", "organization_id", "tender_id", "bid_id", "evaluator_id", "reason_code", "recused_at")
           VALUES ('BRC_LATE', '${owner}', '${tenderId}', '${claim.bidId}', 'USR_LATE', 'OTHER', now())`,
        ),
      ).rejects.toThrow(/ck_evaluation_open/);
    });

    it('serialises with a score: one that waits behind the completion finds the matrix frozen', async () => {
      const { owner, tenderId, bids } = await readyTender();
      const user = (
        await runUnscoped('the suite reads a claim', () =>
          w.prisma.client.bidEvaluation.findFirstOrThrow({
            where: { tenderId, bidId: bids[0]!.bidId },
          }),
        )
      ).evaluatorId;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let reached!: () => void;
      const atDecision = new Promise<void>((resolve) => (reached = resolve));
      w.clock.onDecision = async () => {
        reached();
        await gate;
      };
      const completing = evaluate(owner, tenderId);
      await atDecision;
      // The completion holds the tender lock and has not committed: a score queues behind it.
      const late = score(
        owner,
        tenderId,
        bids[0]!.bidId,
        [{ criterionCode: 'PRICE', scoreScaled: 1 }],
        user,
      );
      await untilASessionWaitsOnALock(w.prisma);
      release();
      expect((await completing).status).toBe('EVALUATED');
      expect(await refusalOf(late)).toContain('NOT_EVALUATING');
      const cells = await runUnscoped('the suite reads the cells', () =>
        w.prisma.client.bidEvaluationScore.findMany({
          where: { tenderId, bidId: bids[0]!.bidId, criterionCode: 'PRICE' },
        }),
      );
      expect(cells).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------------------------

  describe('the matrix read', () => {
    it('is audited per bid (READ_EVALUATION, BID_ACCESSED), and refused before the opening', async () => {
      const { owner, tenderId, bids } = await evaluating(2);
      const user = newUserId();
      await matrix(owner, tenderId, user);
      const rows = (await logOf(tenderId)).filter((row) => row.purpose === 'READ_EVALUATION');
      expect(rows.map((row) => row.bidId).sort()).toEqual(bids.map((b) => b.bidId).sort());
      for (const row of rows)
        expect(row).toMatchObject({ accessorUserId: user, outcome: 'GRANTED' });
      const accessed = (await eventsOf(owner, 'BID_ACCESSED', tenderId)).filter(
        (e) => (payloadOf(e) as { purpose: string }).purpose === 'READ_EVALUATION',
      );
      expect(accessed).toHaveLength(2);

      // A tender that has not been opened has no matrix.
      const fresh = newUserId();
      const { tenderId: unopened } = await publishedForBids(w, owner);
      expect(await refusalOf(matrix(owner, unopened, fresh))).toContain('NOT_OPENED');
      expect((await logOf(unopened)).filter((r) => r.outcome === 'REFUSED')).toEqual([
        expect.objectContaining({ purpose: 'READ_EVALUATION', refusalCode: 'NOT_OPENED' }),
      ]);
    });
  });

  // ---------------------------------------------------------------------------------------------

  describe('what the database keeps, whoever writes', () => {
    const attack = (statement: string) =>
      sql('the suite attacks the table as the runtime role', statement);

    it('refuses a bid made QUALIFIED without the decision, and a decision on a bid that is not OPENED', async () => {
      const { owner, tenderId, bids } = await evaluating(2);
      await expect(
        attack(`UPDATE "bid" SET "status" = 'QUALIFIED' WHERE "id" = '${bids[0]!.bidId}'`),
      ).rejects.toThrow(/ck_bid_decision_recorded/);
      await expect(
        attack(`UPDATE "bid" SET "status" = 'DISQUALIFIED' WHERE "id" = '${bids[0]!.bidId}'`),
      ).rejects.toThrow(/ck_bid_decision_recorded/);

      await qualify(owner, tenderId, bids[1]!.bidId);
      await expect(
        attack(
          `INSERT INTO "bid_qualification" ("id", "organization_id", "tender_id", "bid_id", "decision", "decided_at", "decided_by")
           VALUES ('BQL_TWICE', '${owner}', '${tenderId}', '${bids[1]!.bidId}', 'QUALIFIED', now(), 'USR_X')`,
        ),
      ).rejects.toThrow(/ck_qualification_bid/);
      // A disqualification without its reason cannot be written either.
      await expect(
        attack(
          `INSERT INTO "bid_qualification" ("id", "organization_id", "tender_id", "bid_id", "decision", "decided_at", "decided_by")
           VALUES ('BQL_NOREASON', '${owner}', '${tenderId}', '${bids[0]!.bidId}', 'DISQUALIFIED', now(), 'USR_X')`,
        ),
      ).rejects.toThrow(/ck_bid_qualification_reason/);
      expect((await bidRow(bids[0]!.bidId)).status).toBe('OPENED');
    });

    it('refuses a cell outside its criterion, out of sequence, for the wrong evaluator, for another criterion, or for a bid not QUALIFIED', async () => {
      const { owner, tenderId, bids } = await evaluating(2);
      await qualify(owner, tenderId, bids[0]!.bidId);
      const user = newUserId();
      await score(owner, tenderId, bids[0]!.bidId, FULL, user);
      const claim = await runUnscoped('the suite reads the claim', () =>
        w.prisma.client.bidEvaluation.findFirstOrThrow({ where: { tenderId } }),
      );
      const insert = (over: Partial<Record<string, string | number>>) => {
        const v = {
          id: `BSC_${newUserId()}`,
          bid: claim.bidId,
          evaluation: claim.id,
          evaluator: claim.evaluatorId,
          criterion: 'PRICE',
          revision: 2,
          score: 1,
          ...over,
        };
        return attack(
          `INSERT INTO "bid_evaluation_score" ("id", "organization_id", "tender_id", "bid_id", "evaluation_id",
             "evaluator_id", "criterion_code", "revision", "score_scaled", "scored_at")
           VALUES ('${v.id}', '${owner}', '${tenderId}', '${v.bid}', '${v.evaluation}', '${v.evaluator}',
             '${v.criterion}', ${v.revision}, ${v.score}, now())`,
        );
      };
      await expect(insert({ score: 10_001 })).rejects.toThrow(/ck_score_range/);
      await expect(insert({ score: -1 })).rejects.toThrow(/ck_bid_score_shape/);
      await expect(insert({ criterion: 'LICENCE', score: 50 })).rejects.toThrow(/ck_score_range/);
      await expect(insert({ criterion: 'NOPE' })).rejects.toThrow(/ck_score_criterion/);
      await expect(insert({ revision: 5 })).rejects.toThrow(/ck_score_revision/);
      await expect(insert({ revision: 1 })).rejects.toThrow(); // the cell's first revision exists
      await expect(insert({ evaluator: 'USR_OTHER' })).rejects.toThrow(/ck_score_evaluation/);
      await expect(insert({ bid: bids[1]!.bidId })).rejects.toThrow(/ck_score_evaluation/);
      // A claim on a bid that is not QUALIFIED.
      await expect(
        attack(
          `INSERT INTO "bid_evaluation" ("id", "organization_id", "tender_id", "bid_id", "evaluator_id", "created_at")
           VALUES ('BEV_NOPE', '${owner}', '${tenderId}', '${bids[1]!.bidId}', 'USR_X', now())`,
        ),
      ).rejects.toThrow(/ck_evaluation_bid/);
      expect((await counts(tenderId)).scores).toBe(2);
    });

    it('is append-only for the runtime role: no update, no delete, and no truncate even for the owner', async () => {
      const { owner, tenderId, bids } = await evaluating(1);
      await qualify(owner, tenderId, bids[0]!.bidId);
      await score(owner, tenderId, bids[0]!.bidId);
      await as(
        owner,
        () => w.evaluation.recuse(tenderId, bids[0]!.bidId, { reasonCode: 'OTHER' }),
        newUserId(),
      );
      for (const table of [
        'bid_qualification',
        'bid_evaluation',
        'bid_evaluation_recusal',
        'bid_evaluation_score',
      ]) {
        await expect(
          attack(`DELETE FROM "${table}" WHERE "tender_id" = '${tenderId}'`),
        ).rejects.toThrow(/ck_bid_append_only/);
      }
      await expect(
        attack(
          `UPDATE "bid_evaluation_score" SET "score_scaled" = 0 WHERE "tender_id" = '${tenderId}'`,
        ),
      ).rejects.toThrow(/ck_bid_append_only/);
      await expect(
        attack(
          `UPDATE "bid_qualification" SET "decided_by" = 'USR_X' WHERE "tender_id" = '${tenderId}'`,
        ),
      ).rejects.toThrow(/ck_bid_append_only/);
      const ownerClient = new PrismaClient({ datasources: { db: { url: ownerDatabaseUrl() } } });
      const rollback = new Error('the suite rolls the attempt back');
      try {
        for (const table of [
          'bid_qualification',
          'bid_evaluation',
          'bid_evaluation_recusal',
          'bid_evaluation_score',
        ]) {
          await expect(
            ownerClient.$transaction(async (tx) => {
              await tx.$executeRawUnsafe(`TRUNCATE "${table}"`);
              throw rollback;
            }),
          ).rejects.toThrow(/ck_bid_append_only|cannot truncate a table referenced/);
        }
      } finally {
        await ownerClient.$disconnect();
      }
      expect((await counts(tenderId)).scores).toBe(2);
    });
  });

  // ---------------------------------------------------------------------------------------------

  describe('the guards lock the tender before they judge its status (as the runtime role)', () => {
    /**
     * Holds the tender row `FOR UPDATE` in a transaction of its own, starts `insert` as the runtime
     * role, waits until a session is blocked on a lock, then runs `change` in the held transaction
     * and commits: the insert must have waited for it and then be refused. Without the guard's own
     * lock it would have read EVALUATING, passed, and landed after the change.
     */
    const heldWhileInserting = async (tenderId: string, insert: string, change: string) => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let locked!: () => void;
      const isLocked = new Promise<void>((resolve) => (locked = resolve));
      const holder = runUnscoped('the suite holds the tender lock', () =>
        w.prisma.client.$transaction(async (tx) => {
          await tx.$queryRawUnsafe(`SELECT 1 FROM "tender" WHERE "id" = '${tenderId}' FOR UPDATE`);
          locked();
          await gate;
          await tx.$executeRawUnsafe(change);
        }),
      );
      await isLocked;
      const attempt = sql('the suite inserts as the runtime role', insert).then(
        () => 'INSERTED',
        (error: unknown) => String(error),
      );
      await untilASessionWaitsOnALock(w.prisma);
      release();
      await holder;
      return attempt;
    };

    const cancel = (tenderId: string) =>
      `UPDATE "tender" SET "status" = 'CANCELLED', "status_reason" = 'the suite', "status_reason_code" = 'OWNER_REQUEST'
        WHERE "id" = '${tenderId}'`;

    it('a score waits for the completion of the evaluation and is then refused: the matrix and its digest do not move', async () => {
      const { owner, tenderId, bids } = await evaluating(1);
      const bid = bids[0]!;
      await qualify(owner, tenderId, bid.bidId);
      const user = newUserId();
      await score(owner, tenderId, bid.bidId, FULL, user);
      const claim = await runUnscoped('the suite reads the claim', () =>
        w.prisma.client.bidEvaluation.findFirstOrThrow({ where: { tenderId } }),
      );

      // evaluate takes the lock and stops at its decision instant; the insert queues behind it.
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let reached!: () => void;
      const atDecision = new Promise<void>((resolve) => (reached = resolve));
      w.clock.onDecision = async () => {
        reached();
        await gate;
      };
      const completing = evaluate(owner, tenderId);
      await atDecision;
      const attempt = sql(
        'the suite inserts a cell as the runtime role',
        `INSERT INTO "bid_evaluation_score" ("id", "organization_id", "tender_id", "bid_id", "evaluation_id",
           "evaluator_id", "criterion_code", "revision", "score_scaled", "scored_at")
         VALUES ('BSC_RACE', '${owner}', '${tenderId}', '${bid.bidId}', '${claim.id}', '${user}', 'PRICE', 2, 1, now())`,
      ).then(
        () => 'INSERTED',
        (error: unknown) => String(error),
      );
      await untilASessionWaitsOnALock(w.prisma);
      release();
      const view = await completing;
      expect(await attempt).toMatch(/ck_evaluation_open/);
      const cells = await runUnscoped('the suite reads the cells', () =>
        w.prisma.client.bidEvaluationScore.findMany({ where: { tenderId } }),
      );
      expect(cells).toHaveLength(2);
      expect(
        matrixDigest({
          qualifications: await runUnscoped('the suite reads the decisions', () =>
            w.prisma.client.bidQualification.findMany({ where: { tenderId } }),
          ),
          evaluations: await runUnscoped('the suite reads the claims', () =>
            w.prisma.client.bidEvaluation.findMany({ where: { tenderId } }),
          ),
          recusals: [],
          scores: cells,
        }),
      ).toBe(view.matrixDigest);
    });

    it('a recusal, an evaluator’s claim and a decision wait for a change of the tender’s state and are then refused', async () => {
      type Tender = { owner: string; tenderId: string; bids: { bidId: string }[] };
      const cases: [string, (t: Tender) => string][] = [
        [
          'recusal',
          (
            t,
          ) => `INSERT INTO "bid_evaluation_recusal" ("id", "organization_id", "tender_id", "bid_id", "evaluator_id", "reason_code", "recused_at")
           VALUES ('BRC_RACE', '${t.owner}', '${t.tenderId}', '${t.bids[0]!.bidId}', 'USR_RACE', 'OTHER', now())`,
        ],
        [
          'claim',
          (
            t,
          ) => `INSERT INTO "bid_evaluation" ("id", "organization_id", "tender_id", "bid_id", "evaluator_id", "created_at")
           VALUES ('BEV_RACE', '${t.owner}', '${t.tenderId}', '${t.bids[0]!.bidId}', 'USR_RACE', now())`,
        ],
        [
          'decision',
          (
            t,
          ) => `INSERT INTO "bid_qualification" ("id", "organization_id", "tender_id", "bid_id", "decision", "reason_code", "reason_text", "decided_at", "decided_by")
           VALUES ('BQL_RACE', '${t.owner}', '${t.tenderId}', '${t.bids[1]!.bidId}', 'DISQUALIFIED', 'OTHER', 'the suite', now(), 'USR_RACE')`,
        ],
      ];
      // Each on a tender of its own, with its first bid QUALIFIED and its second still OPENED.
      for (const [, insert] of cases) {
        const t = await evaluating(2);
        await qualify(t.owner, t.tenderId, t.bids[0]!.bidId);
        const outcome = await heldWhileInserting(t.tenderId, insert(t), cancel(t.tenderId));
        expect(outcome).toMatch(/ck_evaluation_open/);
        expect(await counts(t.tenderId)).toMatchObject({ recusals: 0, evaluations: 0, scores: 0 });
      }
    });
  });

  describe('the migration’s rollback', () => {
    it('refuses once any evaluation data exists, and touches nothing', async () => {
      const text = readFileSync(
        join(
          __dirname,
          '..',
          'prisma',
          'migrations',
          '20261002150000_tender_evaluation',
          'down.sql',
        ),
        'utf8',
      );
      const lock = /^LOCK TABLE [^;]+;/m.exec(text)?.[0];
      const check = new RegExp(
        'DO \\$preflight_evaluation\\$[\\s\\S]*?\\$preflight_evaluation\\$;',
      ).exec(text)?.[0];
      expect(lock).toContain('ACCESS EXCLUSIVE');
      expect(check).toBeDefined();
      expect(text.indexOf(lock!)).toBeLessThan(text.indexOf(check!));
      expect(text.indexOf(check!)).toBeLessThan(text.indexOf('DROP TABLE'));
      const runAfterLock = () =>
        w.prisma.client.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(lock!.replace(/;$/, ''));
          await tx.$executeRawUnsafe(check!.replace(/;$/, ''));
        });

      // Every kind of evaluation data refuses it on its own; this suite has all of them by now.
      const { owner, tenderId, bids } = await evaluating(1);
      await qualify(owner, tenderId, bids[0]!.bidId);
      await expect(runAfterLock()).rejects.toThrow(/down refused: evaluation data exists/);
      expect((await bidRow(bids[0]!.bidId)).status).toBe('QUALIFIED');
      await score(owner, tenderId, bids[0]!.bidId);
      await evaluate(owner, tenderId);
      await expect(runAfterLock()).rejects.toThrow(/down refused/);
      expect(await rowOf(tenderId)).toMatchObject({ status: 'EVALUATED' });
    });
  });
});
