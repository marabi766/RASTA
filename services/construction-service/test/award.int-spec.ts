import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ERROR_CODES, eventEnvelopeSchema } from '@rasta/contracts';
import { RastaError, runUnscoped, runWithContext, type RequestContext } from '@rasta/nest-common';
import { PrismaClient } from '../src/generated/prisma';
import { matrixDigest } from '../src/tender/evaluation-matrix';
import {
  SUPPLIER,
  activateAwardPolicy,
  asAdmin,
  asBidder,
  asUser,
  cleanup,
  context,
  evaluatedTender,
  evaluatingTender,
  loadStanding,
  newUserId,
  outboxFor,
  ownerDatabaseUrl,
  testEnv,
  untilASessionWaitsOnALock,
  wire,
  type Wiring,
} from './helpers';

/**
 * Awarding an evaluated tender, against PostgreSQL (ADR-067 § 3): the person's choice of a ranked
 * bid, the justification a choice other than the single first rank needs, the winner's standing
 * asked again at the award (fail closed, no fallback), the conflict rules in both states, the
 * approval gate that stays closed, and the races — two awards at once, an award against the
 * completion of the evaluation, an evaluation write that arrives late — with every change audited
 * with its events in the same transaction and every table append-only for every writer.
 */

const payloadOf = (row: { payload: unknown }) => eventEnvelopeSchema.parse(row.payload).payload;
const occurredOf = (row: { payload: unknown }) =>
  new Date(eventEnvelopeSchema.parse(row.payload).occurredAt);

const ISSUER = 'https://idp.example/realms/rasta';
const DIGEST = 'a'.repeat(64);

describe('awarding an evaluated tender', () => {
  let w: Wiring;
  /** The optional rule that the awarder is none of the evaluators, switched on. */
  let strict: Wiring;
  const organizations: string[] = [];

  const sql = (reason: string, statement: string) =>
    runUnscoped(reason, () => w.prisma.client.$executeRawUnsafe(statement));

  const tenderRow = (tenderId: string) =>
    runUnscoped('the suite reads the tender', () =>
      w.prisma.client.tender.findFirstOrThrow({ where: { id: tenderId } }),
    );

  const bidRow = (bidId: string) =>
    runUnscoped('the suite reads a bid', () =>
      w.prisma.client.bid.findFirstOrThrow({ where: { id: bidId } }),
    );

  const awardRows = (tenderId: string) =>
    runUnscoped('the suite reads the award', () =>
      w.prisma.client.tenderAward.findMany({ where: { tenderId } }),
    );

  const logOf = (tenderId: string) =>
    runUnscoped('the suite reads the access log', () =>
      w.prisma.client.bidAccessLog.findMany({ where: { tenderId }, orderBy: { id: 'asc' } }),
    );

  const eventsOf = async (owner: string, name: string, tenderId?: string) =>
    (await outboxFor(w.prisma, owner)).filter(
      (row) => row.eventName === name && (tenderId === undefined || row.aggregateId === tenderId),
    );

  const evaluated = (options: { count?: number; tie?: boolean; prices?: string[] } = {}) =>
    evaluatedTender(w, organizations, options);

  const as = <T>(owner: string, fn: () => T, userId?: string) => asAdmin(owner, fn, userId);

  /** The core, with the approval gate satisfied: the route's gate has its own tests below. */
  const award = (
    owner: string,
    tenderId: string,
    bidId: string,
    justification?: string,
    userId?: string,
    on: Wiring = w,
  ) =>
    as(
      owner,
      () => on.award.awardApproved(tenderId, justification ? { bidId, justification } : { bidId }),
      userId,
    );

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

  /** Three bids: the first two qualified and scored (ranks 1 and 2), the third disqualified. */
  const mixedTender = async () => {
    const { owner, tenderId, bids } = await evaluatingTender(w, organizations, 3);
    const evaluator = newUserId();
    for (const [index, bid] of bids.slice(0, 2).entries()) {
      await as(
        owner,
        () => w.evaluation.qualify(tenderId, bid.bidId, { decision: 'QUALIFIED' }),
        evaluator,
      );
      await as(
        owner,
        () =>
          w.evaluation.score(tenderId, bid.bidId, {
            scores: [
              { criterionCode: 'PRICE', scoreScaled: 9_000 - index * 1_000 },
              { criterionCode: 'LICENCE', scoreScaled: 100 },
            ],
          }),
        evaluator,
      );
    }
    await as(
      owner,
      () =>
        w.evaluation.qualify(tenderId, bids[2]!.bidId, {
          decision: 'DISQUALIFIED',
          reasonCode: 'NON_RESPONSIVE',
          reasonText: 'Left out the licence the tender asked for',
        }),
      evaluator,
    );
    await as(owner, () => w.evaluation.evaluate(tenderId), evaluator);
    return { owner, tenderId, bids, evaluator };
  };

  const stateOf = async (tenderId: string, bids: { bidId: string }[]) => ({
    tender: (await tenderRow(tenderId)).status,
    bids: await Promise.all(bids.map(async (bid) => (await bidRow(bid.bidId)).status)),
    awards: (await awardRows(tenderId)).length,
  });

  /** Holds the next command at its decision instant (it has the tender lock) until `release()`. */
  const holdAtDecision = (on: Wiring = w) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let reached!: () => void;
    const atDecision = new Promise<void>((resolve) => (reached = resolve));
    on.clock.onDecision = async () => {
      reached();
      await gate;
    };
    return { release, atDecision };
  };

  beforeAll(async () => {
    // One person opens: the four-eyes rule (Q-91) has its own suite.
    const open = { CONSTRUCTION_TENDER_OPEN_FOUR_EYES: 'false' };
    w = wire(testEnv(open));
    strict = wire(testEnv({ ...open, CONSTRUCTION_COI_RULES: 'AWARDER_NOT_EVALUATOR' }));
    await loadStanding(w);
  });

  afterEach(() => {
    for (const wiring of [w, strict]) {
      wiring.clock.fixed = undefined;
      wiring.clock.onDecision = undefined;
      wiring.memberships.reset();
      wiring.evidence.failure = undefined;
    }
    SUPPLIER.failure = undefined;
    SUPPLIER.afterAnswer = undefined;
  });

  afterAll(async () => {
    await cleanup(w.prisma, organizations);
    await w.close();
    await strict.close();
  });

  // ---------------------------------------------------------------------------------------------

  describe('the award', () => {
    it('writes the award, the tender, the winning bid, the losing bids, the events and the audit row in one transaction', async () => {
      const { owner, tenderId, bids } = await evaluated({ count: 3 });
      const before = await tenderRow(tenderId);
      const user = newUserId();
      const view = await award(owner, tenderId, bids[0]!.bidId, undefined, user);

      const [row, ...rest] = await awardRows(tenderId);
      expect(rest).toHaveLength(0);
      expect(row).toMatchObject({
        organizationId: owner,
        tenderId,
        bidId: bids[0]!.bidId,
        bidderOrganizationId: bids[0]!.bidder,
        amountMinor: 1000n,
        rank: 1,
        tied: false,
        justification: null,
        awardedBy: user,
        // The test context carries no issuer: nothing is invented.
        awardedByIssuer: null,
        awardedBySubject: null,
      });
      // supplier-service was asked at the award, and its instant is on the record.
      expect(row!.standingAsOf.getTime()).toBeGreaterThan(Date.now() - 120_000);
      expect(row!.standingAsOf.getTime()).toBeLessThanOrEqual(row!.awardedAt.getTime() + 1_000);

      const after = await tenderRow(tenderId);
      expect(after).toMatchObject({
        status: 'AWARDED',
        version: before.version + 1,
        statusChangedBy: user,
        updatedBy: user,
      });
      expect(after.statusChangedAt).toEqual(row!.awardedAt);
      expect(before.status).toBe('EVALUATED');
      expect((await bidRow(bids[0]!.bidId)).status).toBe('AWARDED');
      expect((await bidRow(bids[1]!.bidId)).status).toBe('NOT_AWARDED');
      expect((await bidRow(bids[2]!.bidId)).status).toBe('NOT_AWARDED');
      for (const bid of bids) expect((await bidRow(bid.bidId)).updatedBy).toBe(user);

      // The matrix the choice was made against is the one `evaluate` froze and announced.
      const [evaluatedEvent] = await eventsOf(owner, 'BIDS_EVALUATED', tenderId);
      const digest = (payloadOf(evaluatedEvent!) as { matrixDigest: string }).matrixDigest;
      expect(row!.matrixDigest).toBe(digest);

      expect(view).toEqual({
        tenderId,
        status: 'AWARDED',
        bidId: bids[0]!.bidId,
        bidderOrganizationId: bids[0]!.bidder,
        amountMinor: '1000',
        rank: 1,
        tied: false,
        justification: null,
        matrixDigest: digest,
        standingAsOf: row!.standingAsOf.toISOString(),
        awardedAt: row!.awardedAt.toISOString(),
        awardedBy: user,
        alreadyAwarded: false,
      });

      const [awarded, ...more] = await eventsOf(owner, 'TENDER_AWARDED', tenderId);
      expect(more).toHaveLength(0);
      expect(awarded).toMatchObject({
        aggregateType: 'Tender',
        aggregateId: tenderId,
        partitionKey: tenderId,
      });
      expect(occurredOf(awarded!)).toEqual(row!.awardedAt);
      expect(payloadOf(awarded!)).toEqual({
        tenderId,
        projectId: before.projectId,
        organizationId: owner,
        winningBidId: bids[0]!.bidId,
        winnerOrganizationId: bids[0]!.bidder,
        amountMinor: '1000',
        hasJustification: false,
        matrixDigest: digest,
        awardedBy: user,
        awardedAt: row!.awardedAt.toISOString(),
      });

      // One BID_NOT_AWARDED per bid that lost: its own bid and bidder, and nothing of the winner.
      const losers = await eventsOf(owner, 'BID_NOT_AWARDED', tenderId);
      const byBid = (x: { bidId: string }, y: { bidId: string }) => (x.bidId < y.bidId ? -1 : 1);
      expect(losers.map((e) => payloadOf(e) as { bidId: string }).sort(byBid)).toEqual(
        [bids[1]!, bids[2]!].sort(byBid).map((bid) => ({
          bidId: bid.bidId,
          tenderId,
          organizationId: owner,
          bidderOrganizationId: bid.bidder,
          decidedAt: row!.awardedAt.toISOString(),
        })),
      );
      for (const event of losers) {
        const text = JSON.stringify(event.payload);
        expect(text).not.toContain(bids[0]!.bidder);
        expect(text).not.toContain(bids[0]!.bidId);
        expect(text).not.toContain('"1000"');
      }

      // The read of the winner's price is audited like any read of a bid (ADR-066 § 5).
      expect((await logOf(tenderId)).filter((r) => r.purpose === 'AWARD_TENDER')).toEqual([
        expect.objectContaining({
          bidId: bids[0]!.bidId,
          accessorOrganizationId: owner,
          accessorUserId: user,
          outcome: 'GRANTED',
          refusalCode: null,
          accessedAt: row!.awardedAt,
        }),
      ]);
      const accessed = (await eventsOf(owner, 'BID_ACCESSED', tenderId)).filter(
        (e) => (payloadOf(e) as { purpose: string }).purpose === 'AWARD_TENDER',
      );
      expect(accessed).toHaveLength(1);
    });

    it('reads the winner’s price whole, beyond what a double holds, and never as a number', async () => {
      const price = '9007199254740993';
      const { owner, tenderId, bids } = await evaluated({
        count: 2,
        prices: [price, '9007199254740995'],
      });
      const view = await award(owner, tenderId, bids[0]!.bidId);
      expect(view.amountMinor).toBe(price);
      expect((await awardRows(tenderId))[0]!.amountMinor).toBe(9007199254740993n);
      const [event] = await eventsOf(owner, 'TENDER_AWARDED', tenderId);
      expect((payloadOf(event!) as { amountMinor: string }).amountMinor).toBe(price);
    });

    it('records the awarder’s issuer and subject beside the user id when the token carries both', async () => {
      const { owner, tenderId, bids } = await evaluated({ count: 1 });
      const user = newUserId();
      const withIdentity = {
        organizationId: owner,
        organizationIds: [owner],
        userId: user,
        roles: ['ORGANIZATION_ADMIN'],
        subject: 'idp-subject-7',
        issuer: ISSUER,
      } as unknown as Partial<RequestContext>;
      await runWithContext(context(withIdentity), () =>
        w.award.awardApproved(tenderId, { bidId: bids[0]!.bidId }),
      );
      expect((await awardRows(tenderId))[0]).toMatchObject({
        awardedBy: user,
        awardedByIssuer: ISSUER,
        awardedBySubject: 'idp-subject-7',
      });
    });

    it('records no half pair: a subject without its issuer is not kept', async () => {
      const { owner, tenderId, bids } = await evaluated({ count: 1 });
      const user = newUserId();
      await runWithContext(
        context({
          organizationId: owner,
          organizationIds: [owner],
          userId: user,
          roles: ['ORGANIZATION_ADMIN'],
          subject: 'idp-subject-8',
        }),
        () => w.award.awardApproved(tenderId, { bidId: bids[0]!.bidId }),
      );
      expect((await awardRows(tenderId))[0]).toMatchObject({
        awardedBy: user,
        awardedByIssuer: null,
        awardedBySubject: null,
      });
    });

    it('leaves a bid that was disqualified as it was, and tells only the qualified ones that lost', async () => {
      const { owner, tenderId, bids } = await mixedTender();
      await award(owner, tenderId, bids[0]!.bidId);
      expect((await bidRow(bids[0]!.bidId)).status).toBe('AWARDED');
      expect((await bidRow(bids[1]!.bidId)).status).toBe('NOT_AWARDED');
      expect((await bidRow(bids[2]!.bidId)).status).toBe('DISQUALIFIED');
      const told = await eventsOf(owner, 'BID_NOT_AWARDED', tenderId);
      expect(told.map((e) => (payloadOf(e) as { bidId: string }).bidId)).toEqual([bids[1]!.bidId]);
    });
  });

  // ---------------------------------------------------------------------------------------------

  describe('a person chooses; anything but the single first rank is justified (ADR-067 § 3, Q-89)', () => {
    it('refuses another rank without a justification, writes nothing, and audits the refusal against the bid named', async () => {
      const { owner, tenderId, bids } = await evaluated({ count: 3 });
      const user = newUserId();
      const message = await refusalOf(award(owner, tenderId, bids[1]!.bidId, undefined, user));
      expect(message).toContain('JUSTIFICATION_REQUIRED');
      expect(await stateOf(tenderId, bids)).toEqual({
        tender: 'EVALUATED',
        bids: ['QUALIFIED', 'QUALIFIED', 'QUALIFIED'],
        awards: 0,
      });
      expect(await eventsOf(owner, 'TENDER_AWARDED', tenderId)).toHaveLength(0);
      expect(await eventsOf(owner, 'BID_NOT_AWARDED', tenderId)).toHaveLength(0);
      expect((await logOf(tenderId)).filter((r) => r.purpose === 'AWARD_TENDER')).toEqual([
        expect.objectContaining({
          bidId: bids[1]!.bidId,
          accessorUserId: user,
          outcome: 'REFUSED',
          refusalCode: 'JUSTIFICATION_REQUIRED',
        }),
      ]);
    });

    it('awards another rank with its justification: rank, the words in the database, only a flag on the event', async () => {
      const { owner, tenderId, bids } = await evaluated({ count: 3 });
      const words = 'The first rank has no licence for this class of road';
      const view = await award(owner, tenderId, bids[2]!.bidId, words);
      expect(view).toMatchObject({
        bidId: bids[2]!.bidId,
        rank: 3,
        tied: false,
        justification: words,
      });
      expect((await awardRows(tenderId))[0]).toMatchObject({ rank: 3, justification: words });
      expect((await bidRow(bids[0]!.bidId)).status).toBe('NOT_AWARDED');
      expect((await bidRow(bids[2]!.bidId)).status).toBe('AWARDED');
      const [event] = await eventsOf(owner, 'TENDER_AWARDED', tenderId);
      expect(payloadOf(event!)).toMatchObject({
        winningBidId: bids[2]!.bidId,
        hasJustification: true,
      });
      const everything = JSON.stringify(
        [await outboxFor(w.prisma, owner), await logOf(tenderId)],
        (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value),
      );
      expect(everything).not.toContain('no licence for this class');
    });

    it('treats the first rank as a choice that needs its words when it is shared', async () => {
      const { owner, tenderId, bids } = await evaluated({ count: 2, tie: true });
      expect(await refusalOf(award(owner, tenderId, bids[0]!.bidId))).toContain(
        'JUSTIFICATION_REQUIRED',
      );
      expect(await refusalOf(award(owner, tenderId, bids[1]!.bidId))).toContain(
        'JUSTIFICATION_REQUIRED',
      );
      const view = await award(owner, tenderId, bids[1]!.bidId, 'Both are equal; the nearer yard');
      expect(view).toMatchObject({ rank: 1, tied: true, bidId: bids[1]!.bidId });
      expect((await awardRows(tenderId))[0]).toMatchObject({ rank: 1, tied: true });
    });

    it('keeps a justification the first rank did not need, and says so on the event', async () => {
      const { owner, tenderId, bids } = await evaluated({ count: 2 });
      const view = await award(owner, tenderId, bids[0]!.bidId, 'Recorded though not required');
      expect(view.justification).toBe('Recorded though not required');
      const [event] = await eventsOf(owner, 'TENDER_AWARDED', tenderId);
      expect(payloadOf(event!)).toMatchObject({ hasJustification: true });
    });

    it('never chooses by itself: a tender with several qualified bids is awarded only to the bid named', async () => {
      const { owner, tenderId, bids } = await evaluated({ count: 3 });
      await award(owner, tenderId, bids[1]!.bidId, 'The owner’s call');
      expect((await bidRow(bids[0]!.bidId)).status).toBe('NOT_AWARDED');
      expect((await awardRows(tenderId))[0]!.bidId).toBe(bids[1]!.bidId);
    });
  });

  // ---------------------------------------------------------------------------------------------

  describe('what may be awarded', () => {
    it('refuses a tender that is not EVALUATED, whatever the bid', async () => {
      const { owner, tenderId, bids } = await evaluatingTender(w, organizations, 1);
      expect(await refusalOf(award(owner, tenderId, bids[0]!.bidId))).toContain('NOT_EVALUATED');
      expect((await tenderRow(tenderId)).status).toBe('EVALUATING');
    });

    it('refuses a bid that is not the tender’s (404) and one that is not QUALIFIED (422)', async () => {
      const { owner, tenderId, bids } = await mixedTender();
      expect((await codeOf(award(owner, tenderId, 'BID_NOT_THERE'))).code).toBe('NOT_FOUND');
      const other = await evaluated({ count: 1 });
      expect((await codeOf(award(owner, tenderId, other.bids[0]!.bidId))).code).toBe('NOT_FOUND');
      expect(await refusalOf(award(owner, tenderId, bids[2]!.bidId))).toContain(
        'BID_NOT_QUALIFIED',
      );
      expect((await awardRows(tenderId)).length).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------------------------

  describe('the winner’s standing, asked again at the award (Q-85, fail closed)', () => {
    it('refuses a winner suspended since it bid: 422, nothing changes, the refusal is audited against its bid', async () => {
      const { owner, tenderId, bids } = await evaluated({ count: 2 });
      const bidder = bids[0]!.bidder;
      SUPPLIER.suspend(bidder, `SUS_${bidder}`);
      const user = newUserId();
      expect(await refusalOf(award(owner, tenderId, bids[0]!.bidId, undefined, user))).toContain(
        'WINNER_NOT_ELIGIBLE',
      );
      expect(await stateOf(tenderId, bids)).toEqual({
        tender: 'EVALUATED',
        bids: ['QUALIFIED', 'QUALIFIED'],
        awards: 0,
      });
      expect(await eventsOf(owner, 'TENDER_AWARDED', tenderId)).toHaveLength(0);
      expect((await logOf(tenderId)).filter((r) => r.purpose === 'AWARD_TENDER')).toEqual([
        expect.objectContaining({
          bidId: bids[0]!.bidId,
          accessorUserId: user,
          outcome: 'REFUSED',
          refusalCode: 'WINNER_NOT_ELIGIBLE',
        }),
      ]);
      const refused = (await eventsOf(owner, 'BID_ACCESSED', tenderId)).filter(
        (e) => (payloadOf(e) as { purpose: string }).purpose === 'AWARD_TENDER',
      );
      expect(refused.map((e) => payloadOf(e))).toEqual([
        expect.objectContaining({ outcome: 'REFUSED', refusalCode: 'WINNER_NOT_ELIGIBLE' }),
      ]);
    });

    it('does not fall back to the next rank by itself; the person may name another qualified bid (Q-93)', async () => {
      const { owner, tenderId, bids } = await evaluated({ count: 2 });
      SUPPLIER.suspend(bids[0]!.bidder, `SUS_${bids[0]!.bidder}`);
      await refusalOf(award(owner, tenderId, bids[0]!.bidId));
      // Still EVALUATED, the second bid still QUALIFIED: nothing was awarded in its stead.
      expect((await tenderRow(tenderId)).status).toBe('EVALUATED');
      expect((await bidRow(bids[1]!.bidId)).status).toBe('QUALIFIED');
      // The second rank is selectable — by a person, with the words a non-first rank needs.
      const view = await award(owner, tenderId, bids[1]!.bidId, 'The first rank was suspended');
      expect(view).toMatchObject({ bidId: bids[1]!.bidId, rank: 2, status: 'AWARDED' });
      expect((await bidRow(bids[0]!.bidId)).status).toBe('NOT_AWARDED');
    });

    it('accepts a winner that was suspended and reinstated before the award', async () => {
      const { owner, tenderId, bids } = await evaluated({ count: 1 });
      const bidder = bids[0]!.bidder;
      SUPPLIER.suspend(bidder, `SUS_${bidder}`);
      await refusalOf(award(owner, tenderId, bids[0]!.bidId));
      SUPPLIER.reinstate(bidder, `SUS_${bidder}`);
      expect((await award(owner, tenderId, bids[0]!.bidId)).status).toBe('AWARDED');
    });

    it('asks supplier-service about the winner only, and not at all for a repeat of an award already made', async () => {
      const { owner, tenderId, bids } = await evaluated({ count: 3 });
      const before = SUPPLIER.asked.length;
      await award(owner, tenderId, bids[0]!.bidId);
      expect(SUPPLIER.asked.slice(before)).toEqual([bids[0]!.bidder]);
      SUPPLIER.failure = RastaError.upstreamUnavailable('supplier-service');
      const again = await award(owner, tenderId, bids[0]!.bidId);
      expect(again.alreadyAwarded).toBe(true);
      expect(SUPPLIER.asked.slice(before)).toEqual([bids[0]!.bidder]);
    });

    it('fails closed when supplier-service cannot be reached: 503, nothing is awarded, the attempt is audited', async () => {
      const { owner, tenderId, bids } = await evaluated({ count: 2 });
      SUPPLIER.failure = RastaError.upstreamUnavailable('supplier-service');
      const error = await codeOf(award(owner, tenderId, bids[0]!.bidId));
      expect(error.code).toBe('UPSTREAM_UNAVAILABLE');
      expect(await stateOf(tenderId, bids)).toEqual({
        tender: 'EVALUATED',
        bids: ['QUALIFIED', 'QUALIFIED'],
        awards: 0,
      });
      expect((await logOf(tenderId)).filter((r) => r.purpose === 'AWARD_TENDER')).toEqual([
        expect.objectContaining({
          bidId: bids[0]!.bidId,
          outcome: 'REFUSED',
          refusalCode: 'UPSTREAM_UNAVAILABLE',
        }),
      ]);
    });

    it('asks outside the tender’s lock: while supplier-service is slow, nobody is held and the row is free to lock', async () => {
      const { owner, tenderId, bids } = await evaluated({ count: 1 });
      const original = SUPPLIER.fetchStanding.bind(SUPPLIER);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let reached!: () => void;
      const atStanding = new Promise<void>((resolve) => (reached = resolve));
      SUPPLIER.fetchStanding = async (organizationId: string) => {
        reached();
        await gate;
        return original(organizationId);
      };
      try {
        const awarding = award(owner, tenderId, bids[0]!.bidId);
        await atStanding;
        // The award is waiting on supplier-service. A lock request that must not wait succeeds.
        await runUnscoped('the suite locks the row the award would lock', () =>
          w.prisma.client.$transaction(async (tx) => {
            await tx.$queryRawUnsafe(
              `SELECT 1 FROM "tender" WHERE "id" = '${tenderId}' FOR UPDATE NOWAIT`,
            );
          }),
        );
        release();
        expect((await awarding).status).toBe('AWARDED');
      } finally {
        SUPPLIER.fetchStanding = original;
      }
    });

    it('does not stop a suspension that lands between the answer and the commit: the record says when it was last seen eligible', async () => {
      const { owner, tenderId, bids } = await evaluated({ count: 1 });
      const bidder = bids[0]!.bidder;
      SUPPLIER.afterAnswer = () => SUPPLIER.suspend(bidder, `SUS_RACE_${bidder}`);
      const view = await award(owner, tenderId, bids[0]!.bidId);
      expect(view.status).toBe('AWARDED');
      expect(new Date(view.standingAsOf).getTime()).toBeLessThanOrEqual(
        new Date(view.awardedAt).getTime(),
      );
    });

    it('fails closed when audit-service cannot say what the winner’s bid was: 503, nothing is awarded', async () => {
      const { owner, tenderId, bids } = await evaluated({ count: 1 });
      w.evidence.failure = new Error('connect ECONNREFUSED');
      const error = await codeOf(award(owner, tenderId, bids[0]!.bidId));
      expect(error.code).toBe('UPSTREAM_UNAVAILABLE');
      expect((await tenderRow(tenderId)).status).toBe('EVALUATED');
      expect(await awardRows(tenderId)).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------------------------

  describe('once awarded', () => {
    it('answers the same award again with the same view, writing and asking nothing', async () => {
      const { owner, tenderId, bids } = await evaluated({ count: 2 });
      const first = await award(owner, tenderId, bids[0]!.bidId);
      const events = (await outboxFor(w.prisma, owner)).length;
      const logs = (await logOf(tenderId)).length;
      const again = await award(owner, tenderId, bids[0]!.bidId);
      expect(again).toEqual({ ...first, alreadyAwarded: true });
      expect((await outboxFor(w.prisma, owner)).length).toBe(events);
      expect((await logOf(tenderId)).length).toBe(logs);
      expect(await awardRows(tenderId)).toHaveLength(1);
    });

    it('refuses another bid with 409, and audits the refusal', async () => {
      const { owner, tenderId, bids } = await evaluated({ count: 2 });
      await award(owner, tenderId, bids[0]!.bidId);
      const error = await codeOf(award(owner, tenderId, bids[1]!.bidId, 'A second thought'));
      expect(error.code).toBe(ERROR_CODES.ALREADY_EXISTS);
      expect((await awardRows(tenderId))[0]!.bidId).toBe(bids[0]!.bidId);
      expect((await bidRow(bids[1]!.bidId)).status).toBe('NOT_AWARDED');
      const refused = (await logOf(tenderId)).filter(
        (r) => r.purpose === 'AWARD_TENDER' && r.outcome === 'REFUSED',
      );
      expect(refused).toEqual([
        expect.objectContaining({ bidId: bids[1]!.bidId, refusalCode: 'ALREADY_AWARDED' }),
      ]);
    });

    it('lets the evaluation be read as it was, now with the bids’ outcome', async () => {
      const { owner, tenderId, bids } = await evaluated({ count: 2 });
      const frozen = await as(owner, () => w.evaluation.getMatrix(tenderId));
      await award(owner, tenderId, bids[0]!.bidId);
      const matrix = await as(owner, () => w.evaluation.getMatrix(tenderId));
      expect(matrix.bids.map((b) => [b.bidId, b.bidStatus, b.rank])).toEqual(
        frozen.bids.map((b) => [
          b.bidId,
          b.bidId === bids[0]!.bidId ? 'AWARDED' : 'NOT_AWARDED',
          b.rank,
        ]),
      );
      // Completing the evaluation again still answers itself, and says where the tender is now.
      const again = await as(owner, () => w.evaluation.evaluate(tenderId));
      expect(again).toMatchObject({ status: 'AWARDED', alreadyEvaluated: true });
    });

    it('tells each contractor its own outcome and nothing of the winner or the price (Q-89)', async () => {
      const { owner, tenderId, bids } = await evaluated({ count: 2 });
      await award(owner, tenderId, bids[0]!.bidId);
      const winner = await asBidder(bids[0]!.bidder, () => w.ownBids.getMineOpened(tenderId));
      const loser = await asBidder(bids[1]!.bidder, () => w.ownBids.getMineOpened(tenderId));
      expect(winner.status).toBe('AWARDED');
      expect(loser.status).toBe('NOT_AWARDED');
      const seen = JSON.stringify(loser);
      expect(seen).not.toContain(bids[0]!.bidder);
      expect(seen).not.toContain(bids[0]!.bidId);
      expect(seen).not.toContain('"priceMinor":"1000"');
    });
  });

  // ---------------------------------------------------------------------------------------------

  describe('who awards (ADR-067 § 3, § 4)', () => {
    it('refuses a member of any organization that bid, by the token and by identity-service now, and learns nothing of the tender', async () => {
      const { owner, tenderId, bids } = await evaluated({ count: 2 });
      const bidder = bids[0]!.bidder;
      // By the token.
      const token = newUserId();
      const byToken = runWithContext(
        context({
          organizationId: owner,
          organizationIds: [owner, bidder],
          userId: token,
          roles: ['ORGANIZATION_ADMIN'],
        }),
        () => w.award.awardApproved(tenderId, { bidId: bids[0]!.bidId }),
      );
      expect(await refusalOf(byToken, 'FORBIDDEN')).toContain('CONFLICT_OF_INTEREST');
      // By identity-service: a membership created after the token was issued.
      const live = newUserId();
      w.memberships.of.set(live, [bids[1]!.bidder]);
      expect(
        await refusalOf(award(owner, tenderId, bids[0]!.bidId, undefined, live), 'FORBIDDEN'),
      ).toContain('CONFLICT_OF_INTEREST');
      expect(await awardRows(tenderId)).toHaveLength(0);
      const refused = (await logOf(tenderId)).filter((r) => r.purpose === 'AWARD_TENDER');
      expect(refused.map((r) => [r.accessorUserId, r.refusalCode]).sort()).toEqual(
        [
          [token, 'CONFLICT_OF_INTEREST'],
          [live, 'CONFLICT_OF_INTEREST'],
        ].sort(),
      );
    });

    it('says the conflict before anything about the tender’s state: a conflicted caller on an unevaluated tender learns nothing', async () => {
      const { owner, tenderId, bids } = await evaluatingTender(w, organizations, 1);
      const caller = runWithContext(
        context({
          organizationId: owner,
          organizationIds: [owner, bids[0]!.bidder],
          userId: newUserId(),
          roles: ['ORGANIZATION_ADMIN'],
        }),
        () => w.award.awardApproved(tenderId, { bidId: 'BID_ANY' }),
      );
      expect(await refusalOf(caller, 'FORBIDDEN')).toContain('CONFLICT_OF_INTEREST');
    });

    it('refuses SYSTEM_ADMIN, AUDITOR and CONTRACTOR on the owner’s own tender, whatever else they hold, and audits each', async () => {
      const { owner, tenderId, bids } = await evaluated({ count: 1 });
      const refusedBy: string[] = [];
      for (const roles of [
        ['SYSTEM_ADMIN'],
        ['AUDITOR'],
        ['CONTRACTOR'],
        ['ORGANIZATION_ADMIN', 'AUDITOR'],
        ['ORGANIZATION_ADMIN', 'SYSTEM_ADMIN'],
      ]) {
        const user = newUserId();
        refusedBy.push(user);
        const call = asUser(
          owner,
          roles,
          () => w.award.awardApproved(tenderId, { bidId: bids[0]!.bidId }),
          user,
        );
        expect((await codeOf(call)).code).toBe('FORBIDDEN');
      }
      // An ordinary member without a role that awards is told so, and that too is audited.
      const plain = newUserId();
      expect(
        (
          await codeOf(
            asUser(
              owner,
              ['FLEET_MANAGER'],
              () => w.award.awardApproved(tenderId, { bidId: 'x' }),
              plain,
            ),
          )
        ).code,
      ).toBe('INSUFFICIENT_ROLE');
      expect(await awardRows(tenderId)).toHaveLength(0);
      const refused = (await logOf(tenderId)).filter((r) => r.purpose === 'AWARD_TENDER');
      expect(refused.map((r) => r.accessorUserId).sort()).toEqual([...refusedBy, plain].sort());
      expect(new Set(refused.map((r) => r.outcome))).toEqual(new Set(['REFUSED']));
    });

    it('refuses a caller identity-service no longer shows as a member with a role that awards', async () => {
      const { owner, tenderId, bids } = await evaluated({ count: 1 });
      const user = newUserId();
      w.memberships.revoked.add(user);
      expect(await codeOf(award(owner, tenderId, bids[0]!.bidId, undefined, user))).toMatchObject({
        code: 'FORBIDDEN',
      });
      w.memberships.revoked.delete(user);
      w.memberships.rolesOf.set(user, ['FLEET_MANAGER']);
      expect(await codeOf(award(owner, tenderId, bids[0]!.bidId, undefined, user))).toMatchObject({
        code: 'FORBIDDEN',
      });
      expect(await awardRows(tenderId)).toHaveLength(0);
    });

    it('fails closed when identity-service cannot be reached: nothing is awarded', async () => {
      const { owner, tenderId, bids } = await evaluated({ count: 1 });
      w.memberships.failure = RastaError.upstreamUnavailable('identity-service');
      expect((await codeOf(award(owner, tenderId, bids[0]!.bidId))).code).toBe(
        'UPSTREAM_UNAVAILABLE',
      );
      expect(await awardRows(tenderId)).toHaveLength(0);
    });

    it('lets an evaluator award when the rule is off (the default)', async () => {
      const { owner, tenderId, bids, evaluator } = await evaluated({ count: 1 });
      expect((await award(owner, tenderId, bids[0]!.bidId, undefined, evaluator)).status).toBe(
        'AWARDED',
      );
    });

    describe('AWARDER_NOT_EVALUATOR, switched on', () => {
      it('refuses the person who decided on the bids, scored them and completed the evaluation: 403, audited, nothing awarded', async () => {
        const { owner, tenderId, bids, evaluator } = await evaluated({ count: 2 });
        expect(
          await refusalOf(
            award(owner, tenderId, bids[0]!.bidId, undefined, evaluator, strict),
            'FORBIDDEN',
          ),
        ).toContain('AWARDER_IS_EVALUATOR');
        expect(await stateOf(tenderId, bids)).toMatchObject({ tender: 'EVALUATED', awards: 0 });
        expect((await logOf(tenderId)).filter((r) => r.purpose === 'AWARD_TENDER')).toEqual([
          expect.objectContaining({
            accessorUserId: evaluator,
            outcome: 'REFUSED',
            refusalCode: 'AWARDER_IS_EVALUATOR',
          }),
        ]);
      });

      it('counts the one who stood down, and the one who only completed the evaluation', async () => {
        const t = await evaluatingTender(w, organizations, 2);
        const decider = newUserId();
        const completer = newUserId();
        const recuser = newUserId();
        for (const [i, bid] of t.bids.entries()) {
          await as(
            t.owner,
            () => w.evaluation.qualify(t.tenderId, bid.bidId, { decision: 'QUALIFIED' }),
            decider,
          );
          await as(
            t.owner,
            () =>
              w.evaluation.score(t.tenderId, bid.bidId, {
                scores: [
                  { criterionCode: 'PRICE', scoreScaled: 9_000 - i * 1_000 },
                  { criterionCode: 'LICENCE', scoreScaled: 100 },
                ],
              }),
            decider,
          );
        }
        await as(
          t.owner,
          () => w.evaluation.recuse(t.tenderId, t.bids[1]!.bidId, { reasonCode: 'OTHER' }),
          recuser,
        );
        await as(t.owner, () => w.evaluation.evaluate(t.tenderId), completer);
        for (const person of [recuser, completer]) {
          expect(
            await refusalOf(
              award(t.owner, t.tenderId, t.bids[0]!.bidId, undefined, person, strict),
              'FORBIDDEN',
            ),
          ).toContain('AWARDER_IS_EVALUATOR');
        }
      });

      it('refuses one whose subject is the evaluator’s user id: one person behind two ids', async () => {
        const { owner, tenderId, bids, evaluator } = await evaluated({ count: 1 });
        const alias = runWithContext(
          context({
            organizationId: owner,
            organizationIds: [owner],
            userId: newUserId(),
            roles: ['ORGANIZATION_ADMIN'],
            subject: evaluator,
          }),
          () => strict.award.awardApproved(tenderId, { bidId: bids[0]!.bidId }),
        );
        expect(await refusalOf(alias, 'FORBIDDEN')).toContain('AWARDER_IS_EVALUATOR');
        expect(await awardRows(tenderId)).toHaveLength(0);
      });

      it('fails closed for a user id the records cannot show to be another person: 422, not an award', async () => {
        const { owner, tenderId, bids } = await evaluated({ count: 1 });
        const stranger = newUserId();
        expect(
          await refusalOf(award(owner, tenderId, bids[0]!.bidId, undefined, stranger, strict)),
        ).toContain('ACTOR_IDENTITY_UNKNOWN');
        expect(await awardRows(tenderId)).toHaveLength(0);
        expect((await logOf(tenderId)).filter((r) => r.outcome === 'REFUSED')).toEqual([
          expect.objectContaining({ refusalCode: 'ACTOR_IDENTITY_UNKNOWN' }),
        ]);
      });
    });
  });

  // ---------------------------------------------------------------------------------------------

  describe('the approval gate fails closed (Q-84)', () => {
    it('refuses the route with no active tender.award policy, naming APPROVAL_POLICY_REQUIRED', async () => {
      const { owner, tenderId, bids } = await evaluated({ count: 1 });
      const message = await refusalOf(
        as(owner, () => w.award.award(tenderId, { bidId: bids[0]!.bidId })),
      );
      expect(message).toContain('APPROVAL_POLICY_REQUIRED');
      expect(await stateOf(tenderId, bids)).toEqual({
        tender: 'EVALUATED',
        bids: ['QUALIFIED'],
        awards: 0,
      });
      expect((await logOf(tenderId)).filter((r) => r.purpose === 'AWARD_TENDER')).toEqual([
        expect.objectContaining({ outcome: 'REFUSED', refusalCode: 'APPROVAL_POLICY_REQUIRED' }),
      ]);
    });

    it('refuses the route with a policy in force too, until the approval round is wired (PR 11)', async () => {
      const { owner, tenderId, bids } = await evaluated({ count: 1 });
      await activateAwardPolicy(w, owner);
      expect(
        await refusalOf(as(owner, () => w.award.award(tenderId, { bidId: bids[0]!.bidId }))),
      ).toContain('APPROVAL_REQUIRED');
      expect(await awardRows(tenderId)).toHaveLength(0);
      // The core is the same code with the gate satisfied.
      expect((await award(owner, tenderId, bids[0]!.bidId)).status).toBe('AWARDED');
    });

    it('counts a policy of another organization as none', async () => {
      const { owner, tenderId, bids } = await evaluated({ count: 1 });
      const stranger = (await evaluated({ count: 1 })).owner;
      await activateAwardPolicy(w, stranger);
      expect(
        await refusalOf(as(owner, () => w.award.award(tenderId, { bidId: bids[0]!.bidId }))),
      ).toContain('APPROVAL_POLICY_REQUIRED');
    });
  });

  // ---------------------------------------------------------------------------------------------

  describe('races', () => {
    it('two different awards at once are one award and a 409', async () => {
      const { owner, tenderId, bids } = await evaluated({ count: 2 });
      const { release, atDecision } = holdAtDecision();
      const first = award(owner, tenderId, bids[0]!.bidId);
      await atDecision;
      const second = award(owner, tenderId, bids[1]!.bidId, 'The other one, for a reason');
      await untilASessionWaitsOnALock(w.prisma);
      release();
      expect((await first).bidId).toBe(bids[0]!.bidId);
      expect((await codeOf(second)).code).toBe(ERROR_CODES.ALREADY_EXISTS);
      expect(await awardRows(tenderId)).toHaveLength(1);
      expect(await eventsOf(owner, 'TENDER_AWARDED', tenderId)).toHaveLength(1);
      expect((await bidRow(bids[0]!.bidId)).status).toBe('AWARDED');
      expect((await bidRow(bids[1]!.bidId)).status).toBe('NOT_AWARDED');
    });

    it('the same award twice at once is one award, and the second answers it', async () => {
      const { owner, tenderId, bids } = await evaluated({ count: 2 });
      const { release, atDecision } = holdAtDecision();
      const first = award(owner, tenderId, bids[0]!.bidId);
      await atDecision;
      const second = award(owner, tenderId, bids[0]!.bidId);
      await untilASessionWaitsOnALock(w.prisma);
      release();
      const [a, b] = [await first, await second];
      expect([a.alreadyAwarded, b.alreadyAwarded]).toEqual([false, true]);
      expect(b).toEqual({ ...a, alreadyAwarded: true });
      expect(await awardRows(tenderId)).toHaveLength(1);
      expect(await eventsOf(owner, 'BID_NOT_AWARDED', tenderId)).toHaveLength(1);
    });

    it('an evaluation write that arrives while the award holds the lock waits, finds the matrix frozen and the tender AWARDED, and changes nothing', async () => {
      const { owner, tenderId, bids, evaluator } = await evaluated({ count: 2 });
      const claim = await runUnscoped('the suite reads a claim', () =>
        w.prisma.client.bidEvaluation.findFirstOrThrow({ where: { tenderId } }),
      );
      const { release, atDecision } = holdAtDecision();
      const awarding = award(owner, tenderId, bids[0]!.bidId);
      await atDecision;

      // As the runtime role, around the application: a cell, a decision and a recusal.
      const cell = sql(
        'the suite inserts a cell as the runtime role',
        `INSERT INTO "bid_evaluation_score" ("id", "organization_id", "tender_id", "bid_id", "evaluation_id",
           "evaluator_id", "criterion_code", "revision", "score_scaled", "scored_at")
         VALUES ('BSC_LATE', '${owner}', '${tenderId}', '${claim.bidId}', '${claim.id}', '${claim.evaluatorId}',
           'PRICE', 2, 1, now())`,
      ).then(
        () => 'INSERTED',
        (error: unknown) => String(error),
      );
      // And through the application.
      const late = as(
        owner,
        () =>
          w.evaluation.score(tenderId, bids[1]!.bidId, {
            scores: [{ criterionCode: 'PRICE', scoreScaled: 1 }],
          }),
        evaluator,
      );
      await untilASessionWaitsOnALock(w.prisma);
      release();
      await awarding;
      expect(await cell).toMatch(/ck_evaluation_open/);
      expect(await refusalOf(late)).toContain('NOT_EVALUATING');

      const [row] = await awardRows(tenderId);
      const [evaluatedEvent] = await eventsOf(owner, 'BIDS_EVALUATED', tenderId);
      const digestNow = matrixDigest({
        qualifications: await runUnscoped('the suite reads the decisions', () =>
          w.prisma.client.bidQualification.findMany({ where: { tenderId } }),
        ),
        evaluations: await runUnscoped('the suite reads the claims', () =>
          w.prisma.client.bidEvaluation.findMany({ where: { tenderId } }),
        ),
        recusals: await runUnscoped('the suite reads the recusals', () =>
          w.prisma.client.bidEvaluationRecusal.findMany({ where: { tenderId } }),
        ),
        scores: await runUnscoped('the suite reads the cells', () =>
          w.prisma.client.bidEvaluationScore.findMany({ where: { tenderId } }),
        ),
      });
      expect(digestNow).toBe(row!.matrixDigest);
      expect((payloadOf(evaluatedEvent!) as { matrixDigest: string }).matrixDigest).toBe(digestNow);
    });

    it('an award that arrives while the evaluation is being completed waits for it, then awards on the frozen matrix', async () => {
      const t = await evaluatingTender(w, organizations, 1);
      const evaluator = newUserId();
      await as(
        t.owner,
        () => w.evaluation.qualify(t.tenderId, t.bids[0]!.bidId, { decision: 'QUALIFIED' }),
        evaluator,
      );
      await as(
        t.owner,
        () =>
          w.evaluation.score(t.tenderId, t.bids[0]!.bidId, {
            scores: [
              { criterionCode: 'PRICE', scoreScaled: 7_000 },
              { criterionCode: 'LICENCE', scoreScaled: 100 },
            ],
          }),
        evaluator,
      );
      const { release, atDecision } = holdAtDecision();
      const completing = as(t.owner, () => w.evaluation.evaluate(t.tenderId), evaluator);
      await atDecision;
      // Not yet EVALUATED: the award queues behind the completion's lock, and is judged after it.
      const awarding = award(t.owner, t.tenderId, t.bids[0]!.bidId);
      await untilASessionWaitsOnALock(w.prisma);
      release();
      const done = await completing;
      const view = await awarding;
      expect(view.status).toBe('AWARDED');
      expect(view.matrixDigest).toBe(done.matrixDigest);
      expect(view.awardedAt >= done.evaluatedAt).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------------------------

  describe('what the database keeps, whoever writes', () => {
    const attack = (statement: string) =>
      sql('the suite attacks the table as the runtime role', statement);

    const insertAward = (v: {
      owner: string;
      tenderId: string;
      bidId: string;
      bidder: string;
      rank?: number;
      tied?: boolean;
      justification?: string | null;
      issuer?: string | null;
      subject?: string | null;
      id?: string;
    }) => `INSERT INTO "tender_award" ("id", "organization_id", "tender_id", "bid_id",
        "bidder_organization_id", "amount_minor", "rank", "tied", "matrix_digest", "justification",
        "standing_as_of", "awarded_at", "awarded_by", "awarded_by_issuer", "awarded_by_subject")
      VALUES ('${v.id ?? `TAW_${newUserId()}`}', '${v.owner}', '${v.tenderId}', '${v.bidId}',
        '${v.bidder}', 1, ${v.rank ?? 1}, ${v.tied ?? false}, '${DIGEST}',
        ${v.justification === undefined || v.justification === null ? 'NULL' : `'${v.justification}'`},
        now(), now(), 'USR_X',
        ${v.issuer ? `'${v.issuer}'` : 'NULL'}, ${v.subject ? `'${v.subject}'` : 'NULL'})`;

    it('refuses an award for a tender that is not EVALUATED, for a bid that is not a qualified one of it, and for the wrong bidder', async () => {
      const evaluating = await evaluatingTender(w, organizations, 1);
      await expect(
        attack(
          insertAward({
            owner: evaluating.owner,
            tenderId: evaluating.tenderId,
            bidId: evaluating.bids[0]!.bidId,
            bidder: evaluating.bids[0]!.bidder,
          }),
        ),
      ).rejects.toThrow(/ck_award_evaluated/);

      const { owner, tenderId, bids } = await evaluated({ count: 2 });
      await expect(
        attack(insertAward({ owner, tenderId, bidId: bids[0]!.bidId, bidder: bids[1]!.bidder })),
      ).rejects.toThrow(/ck_award_bid/);
      await expect(
        attack(insertAward({ owner, tenderId, bidId: 'BID_NOPE', bidder: bids[0]!.bidder })),
      ).rejects.toThrow();
      // A bid of another tender.
      const other = await evaluated({ count: 1 });
      await expect(
        attack(
          insertAward({
            owner,
            tenderId,
            bidId: other.bids[0]!.bidId,
            bidder: other.bids[0]!.bidder,
          }),
        ),
      ).rejects.toThrow(/ck_award_bid/);
      expect(await awardRows(tenderId)).toHaveLength(0);
    });

    it('refuses an award that is not justified when it is not the single first rank, and a half pair of identity', async () => {
      const { owner, tenderId, bids } = await evaluated({ count: 2 });
      const base = { owner, tenderId, bidId: bids[1]!.bidId, bidder: bids[1]!.bidder };
      await expect(attack(insertAward({ ...base, rank: 2 }))).rejects.toThrow(
        /ck_tender_award_justified/,
      );
      await expect(attack(insertAward({ ...base, rank: 1, tied: true }))).rejects.toThrow(
        /ck_tender_award_justified/,
      );
      await expect(
        attack(insertAward({ ...base, rank: 2, justification: 'x', issuer: ISSUER })),
      ).rejects.toThrow(/ck_tender_award_actor_pair/);
      await expect(
        attack(insertAward({ ...base, rank: 2, justification: 'x', subject: 'sub' })),
      ).rejects.toThrow(/ck_tender_award_actor_pair/);
      await expect(attack(insertAward({ ...base, rank: 0, justification: 'x' }))).rejects.toThrow(
        /ck_tender_award_shape/,
      );
      expect(await awardRows(tenderId)).toHaveLength(0);
    });

    it('does not commit an award row without the tender and the winning bid moving with it', async () => {
      const { owner, tenderId, bids } = await evaluated({ count: 2 });
      const row = insertAward({ owner, tenderId, bidId: bids[0]!.bidId, bidder: bids[0]!.bidder });
      await expect(
        runUnscoped('the suite inserts an award alone', () =>
          w.prisma.client.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(row);
          }),
        ),
      ).rejects.toThrow(/ck_award_consistent/);
      expect(await awardRows(tenderId)).toHaveLength(0);
      expect((await tenderRow(tenderId)).status).toBe('EVALUATED');
    });

    it('moves a tender to AWARDED, and a bid to AWARDED or NOT_AWARDED, only with an award that names them', async () => {
      const { owner, tenderId, bids } = await evaluated({ count: 2 });
      await expect(
        attack(`UPDATE "tender" SET "status" = 'AWARDED' WHERE "id" = '${tenderId}'`),
      ).rejects.toThrow(/ck_tender_award_recorded/);
      for (const status of ['AWARDED', 'NOT_AWARDED']) {
        await expect(
          attack(`UPDATE "bid" SET "status" = '${status}' WHERE "id" = '${bids[0]!.bidId}'`),
        ).rejects.toThrow(/ck_bid_award_recorded/);
      }
      expect(await stateOf(tenderId, bids)).toEqual({
        tender: 'EVALUATED',
        bids: ['QUALIFIED', 'QUALIFIED'],
        awards: 0,
      });

      // Once awarded, the award names the winner alone: the other bid is not AWARDED by any write,
      // and AWARDED is terminal for the tender, its winning bid and the others.
      await award(owner, tenderId, bids[0]!.bidId);
      await expect(
        attack(`UPDATE "bid" SET "status" = 'AWARDED' WHERE "id" = '${bids[1]!.bidId}'`),
      ).rejects.toThrow(/ck_bid_status_transition/);
      await expect(
        attack(`UPDATE "bid" SET "status" = 'NOT_AWARDED' WHERE "id" = '${bids[0]!.bidId}'`),
      ).rejects.toThrow(/ck_bid_status_transition/);
      for (const status of ['CANCELLED', 'EVALUATED', 'DRAFT']) {
        await expect(
          attack(
            `UPDATE "tender" SET "status" = '${status}'::"TenderStatus" WHERE "id" = '${tenderId}'`,
          ),
        ).rejects.toThrow(/ck_tender_status_transition/);
      }
      expect(await stateOf(tenderId, bids)).toEqual({
        tender: 'AWARDED',
        bids: ['AWARDED', 'NOT_AWARDED'],
        awards: 1,
      });
    });

    it('is append-only for the runtime role, and refuses a second award for the tender', async () => {
      const { owner, tenderId, bids } = await evaluated({ count: 2 });
      await award(owner, tenderId, bids[0]!.bidId);
      await expect(
        attack(`DELETE FROM "tender_award" WHERE "tender_id" = '${tenderId}'`),
      ).rejects.toThrow(/ck_bid_append_only/);
      await expect(
        attack(
          `UPDATE "tender_award" SET "awarded_by" = 'USR_X' WHERE "tender_id" = '${tenderId}'`,
        ),
      ).rejects.toThrow(/ck_bid_append_only/);
      await expect(
        attack(
          `UPDATE "tender_award" SET "bid_id" = '${bids[1]!.bidId}' WHERE "tender_id" = '${tenderId}'`,
        ),
      ).rejects.toThrow(/ck_bid_append_only/);
      // A second row for the same tender: the tender is no longer EVALUATED.
      await expect(
        attack(
          insertAward({
            owner,
            tenderId,
            bidId: bids[1]!.bidId,
            bidder: bids[1]!.bidder,
            rank: 2,
            justification: 'again',
          }),
        ),
      ).rejects.toThrow(/ck_award_evaluated/);
      const ownerClient = new PrismaClient({ datasources: { db: { url: ownerDatabaseUrl() } } });
      const rollback = new Error('the suite rolls the attempt back');
      try {
        await expect(
          ownerClient.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(`TRUNCATE "tender_award"`);
            throw rollback;
          }),
        ).rejects.toThrow(/ck_bid_append_only|cannot truncate a table referenced/);
      } finally {
        await ownerClient.$disconnect();
      }
      expect(await awardRows(tenderId)).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------------------------

  describe('the migration’s rollback', () => {
    it('refuses once any award exists, and touches nothing', async () => {
      const text = readFileSync(
        join(__dirname, '..', 'prisma', 'migrations', '20261003100000_tender_award', 'down.sql'),
        'utf8',
      );
      const lock = /^LOCK TABLE [^;]+;/m.exec(text)?.[0];
      const check = new RegExp('DO \\$preflight_award\\$[\\s\\S]*?\\$preflight_award\\$;').exec(
        text,
      )?.[0];
      expect(lock).toContain('ACCESS EXCLUSIVE');
      expect(check).toBeDefined();
      expect(text.indexOf(lock!)).toBeLessThan(text.indexOf(check!));
      expect(text.indexOf(check!)).toBeLessThan(text.indexOf('DROP TABLE'));
      const runAfterLock = () =>
        w.prisma.client.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(lock!.replace(/;$/, ''));
          await tx.$executeRawUnsafe(check!.replace(/;$/, ''));
        });

      const { owner, tenderId, bids } = await evaluated({ count: 2 });
      await award(owner, tenderId, bids[0]!.bidId);
      await expect(runAfterLock()).rejects.toThrow(/down refused: award data exists/);
      expect(await awardRows(tenderId)).toHaveLength(1);
      expect((await tenderRow(tenderId)).status).toBe('AWARDED');
    });
  });
});
