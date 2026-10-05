import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ERROR_CODES, eventEnvelopeSchema } from '@rasta/contracts';
import { RastaError, runUnscoped, runWithContext, type RequestContext } from '@rasta/nest-common';
import { PrismaClient } from '../src/generated/prisma';
import { Logger } from '@nestjs/common';
import { awardStandingChecksTotal } from '../src/observability/metrics';
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
  ownerSql,
  TEST_ISSUER,
  testEnv,
  untilASessionWaitsOnALock,
  wire,
  type Wiring,
  awardApproved,
  approveAward,
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
      () => awardApproved(on, tenderId, justification ? { bidId, justification } : { bidId }),
      userId,
    );

  /** The awarder asks and other people approve; nothing is awarded yet. */
  const approve = (owner: string, tenderId: string, bidId: string, justification?: string) =>
    as(owner, () =>
      approveAward(w, tenderId, justification ? { bidId, justification } : { bidId }),
    );

  /** The command itself, on an approval already given: the answer is the award (or its refusal). */
  const awardNow = (
    owner: string,
    tenderId: string,
    bidId: string,
    justification?: string,
    userId?: string,
    on: Wiring = w,
  ) =>
    as(
      owner,
      async () => {
        const answer = await on.award.award(
          tenderId,
          justification ? { bidId, justification } : { bidId },
        );
        if (!answer.executed) throw new Error('the award was not approved yet');
        return answer.result;
      },
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
        // The identity the token carried (the suites give each user id a subject of its own, #188).
        awardedByIssuer: TEST_ISSUER,
        awardedBySubject: `sub-${user}`,
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
        projectId: after.projectId,
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
        hasJustification: false,
        matrixDigest: digest,
        approvalRequestId: expect.any(String),
        awardedBy: user,
        awardedAt: row!.awardedAt.toISOString(),
      });

      // The winner's price is a bid's content: it is on the award row and behind the read, never on the shared topic.
      expect(JSON.stringify(awarded!.payload)).not.toMatch(/amount|price/i);

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
      expect((await as(owner, () => w.award.getAward(tenderId))).amountMinor).toBe(price);
      // Nowhere in the owner's event stream or log, whole or as a number.
      const everything = JSON.stringify(
        [await outboxFor(w.prisma, owner), await logOf(tenderId)],
        (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value),
      );
      expect(everything).not.toContain(price);
      expect(everything).not.toContain('9007199254740992');
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
        awardApproved(w, tenderId, { bidId: bids[0]!.bidId }),
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
      // Someone whose identity is known asks and is approved by others (a request whose maker cannot be
      // told from its approver is refused, so an unknown identity cannot ask) ...
      await approve(owner, tenderId, bids[0]!.bidId);
      // ... and the person with half a pair executes: what is recorded is no half pair.
      await runWithContext(
        context({
          organizationId: owner,
          organizationIds: [owner],
          userId: user,
          roles: ['ORGANIZATION_ADMIN'],
          subject: 'idp-subject-8',
          // No issuer in the token: half a pair proves nothing.
          issuer: undefined,
        } as unknown as Partial<RequestContext>),
        async () => {
          const done = await w.award.award(tenderId, { bidId: bids[0]!.bidId });
          if (!done.executed) throw new Error('the award was not approved');
        },
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

    it('asks supplier-service about the winner only: for the request, and again at the execution, which an approval never replaces; not at all for a repeat of an award already made', async () => {
      const { owner, tenderId, bids } = await evaluated({ count: 3 });
      const before = SUPPLIER.asked.length;
      await approve(owner, tenderId, bids[0]!.bidId);
      // The winner alone, once, for the request the authority decides on.
      expect(SUPPLIER.asked.slice(before)).toEqual([bids[0]!.bidder]);
      await awardNow(owner, tenderId, bids[0]!.bidId);
      // And once more now, at the execution: the approval did not stand in for it. The check after the
      // commit is the sweeper's, not the request's.
      expect(SUPPLIER.asked.slice(before)).toEqual([bids[0]!.bidder, bids[0]!.bidder]);
      SUPPLIER.failure = RastaError.upstreamUnavailable('supplier-service');
      const again = await awardNow(owner, tenderId, bids[0]!.bidId);
      expect(again.alreadyAwarded).toBe(true);
      expect(SUPPLIER.asked.slice(before)).toEqual([bids[0]!.bidder, bids[0]!.bidder]);
    });

    it('does not award on an approval when the winner is no longer eligible at the execution: 422, the approval stays unused', async () => {
      const { owner, tenderId, bids } = await evaluated({ count: 2 });
      await approve(owner, tenderId, bids[0]!.bidId);
      SUPPLIER.suspend(bids[0]!.bidder, `SUS_${bids[0]!.bidder}`);
      expect(await refusalOf(awardNow(owner, tenderId, bids[0]!.bidId))).toContain(
        'WINNER_NOT_ELIGIBLE',
      );
      expect(await awardRows(tenderId)).toHaveLength(0);
      // Reinstated, the same approval still stands (nothing used it) and awards.
      SUPPLIER.reinstate(bids[0]!.bidder, `SUS_${bids[0]!.bidder}`);
      expect((await awardNow(owner, tenderId, bids[0]!.bidId)).status).toBe('AWARDED');
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

    describe('the standing check after the award: durable, and out of the request (ADR-067 § 3, residual)', () => {
      const checks = async (outcome: string) =>
        (await awardStandingChecksTotal.get()).values.find(
          (v) => v.labels.outcome === outcome && v.labels.service === 'construction-service',
        )?.value ?? 0;

      const rowOf = (tenderId: string) =>
        runUnscoped('the suite reads the standing check', () =>
          w.prisma.client.tenderAwardStandingCheck.findFirstOrThrow({ where: { tenderId } }),
        );
      const rowCount = (tenderId: string) =>
        runUnscoped('the suite counts the standing checks', () =>
          w.prisma.client.tenderAwardStandingCheck.count({ where: { tenderId } }),
        );
      const conflicts = (owner: string, tenderId: string) =>
        eventsOf(owner, 'TENDER_AWARD_STANDING_CONFLICT_DETECTED', tenderId);
      const backoff = { baseSeconds: 30, maxSeconds: 900 };

      afterEach(() => jest.restoreAllMocks());

      it('is written in the award’s own transaction, pending, and the response waits for nothing', async () => {
        const { owner, tenderId, bids } = await evaluated({ count: 1 });
        const asked = SUPPLIER.asked.length;
        const [clear, conflict, unavailable] = [
          await checks('clear'),
          await checks('conflict'),
          await checks('unavailable'),
        ];
        const user = newUserId();
        await approve(owner, tenderId, bids[0]!.bidId);
        const askedAtExecution = SUPPLIER.asked.length;
        const view = await awardNow(owner, tenderId, bids[0]!.bidId, undefined, user);

        // Only the pre-check was asked; the check after the commit is not the request's.
        expect(asked).toBeLessThanOrEqual(askedAtExecution);
        expect(SUPPLIER.asked.length - askedAtExecution).toBe(1);
        expect(await rowOf(tenderId)).toMatchObject({
          organizationId: owner,
          tenderId,
          bidId: bids[0]!.bidId,
          winnerOrganizationId: bids[0]!.bidder,
          awardedBy: user,
          status: 'PENDING',
          outcome: null,
          doneAt: null,
          attempts: 0,
          leaseUntil: null,
          fence: null,
        });
        const row = await rowOf(tenderId);
        // The window starts at the instant of the standing read the award was made on.
        expect(row.windowStart.toISOString()).toBe(view.standingAsOf);
        expect(row.awardedAt.toISOString()).toBe(view.awardedAt);
        expect([
          await checks('clear'),
          await checks('conflict'),
          await checks('unavailable'),
        ]).toEqual([clear, conflict, unavailable]);
        expect(await conflicts(owner, tenderId)).toHaveLength(0);
      });

      it('survives the process that made the award: a sweeper that starts afterwards makes it, once', async () => {
        const { owner, tenderId, bids } = await evaluated({ count: 1 });
        await award(owner, tenderId, bids[0]!.bidId);
        const before = await checks('clear');

        const restarted = w.awardCheckSweeperWith();
        expect(await restarted.runOnce(tenderId)).toEqual({
          claimed: 1,
          clear: 1,
          conflict: 0,
          retry: 0,
          lost: 0,
        });
        expect(await rowOf(tenderId)).toMatchObject({
          status: 'DONE',
          outcome: 'CLEAR',
          attempts: 0,
          leaseUntil: null,
          fence: null,
        });
        expect((await rowOf(tenderId)).doneAt).not.toBeNull();
        expect(await checks('clear')).toBe(before + 1);
        expect(await conflicts(owner, tenderId)).toHaveLength(0);
        // Settled: not claimed again.
        expect((await restarted.runOnce(tenderId)).claimed).toBe(0);
      });

      it('detects a suspension that lands between the answer and the commit: the award stands, the event comes once, a person is told', async () => {
        const { owner, tenderId, bids } = await evaluated({ count: 1 });
        const bidder = bids[0]!.bidder;
        const before = await checks('conflict');
        await approve(owner, tenderId, bids[0]!.bidId);
        SUPPLIER.afterAnswer = () => SUPPLIER.suspend(bidder, `SUS_RACE_${bidder}`);
        const user = newUserId();
        const view = await awardNow(owner, tenderId, bids[0]!.bidId, undefined, user);

        // Not stopped, not undone, and nothing is said in the request.
        expect(view.status).toBe('AWARDED');
        expect(await conflicts(owner, tenderId)).toHaveLength(0);

        expect((await w.awardCheckSweeper.runOnce(tenderId)).conflict).toBe(1);
        expect((await tenderRow(tenderId)).status).toBe('AWARDED');
        expect(await checks('conflict')).toBe(before + 1);
        expect(await rowOf(tenderId)).toMatchObject({ status: 'DONE', outcome: 'CONFLICT' });

        const [detected, ...more] = await conflicts(owner, tenderId);
        expect(more).toHaveLength(0);
        expect(detected).toMatchObject({ aggregateType: 'Tender', partitionKey: tenderId });
        const payload = payloadOf(detected!) as Record<string, unknown>;
        expect(payload).toEqual({
          tenderId,
          projectId: (await tenderRow(tenderId)).projectId,
          organizationId: owner,
          winningBidId: bids[0]!.bidId,
          winnerOrganizationId: bidder,
          awardedBy: user,
          awardedAt: view.awardedAt,
          windowStart: view.standingAsOf,
          checkedAt: expect.any(String),
          suspensionIds: [`SUS_RACE_${bidder}`],
          suspensionCount: 1,
          qualificationRemoved: false,
        });
        expect(new Date(payload.checkedAt as string).getTime()).toBeGreaterThanOrEqual(
          new Date(view.awardedAt).getTime() - 1_000,
        );
        // The event is on the same instant the check was settled at; sweeping again changes nothing.
        expect(occurredOf(detected!)).toEqual((await rowOf(tenderId)).doneAt);
        expect((await w.awardCheckSweeper.runOnce(tenderId)).claimed).toBe(0);
        expect(await conflicts(owner, tenderId)).toHaveLength(1);
      });

      it('retries with a backoff while supplier-service cannot say, naming the award in the log and no amount', async () => {
        const { owner, tenderId, bids } = await evaluated({ count: 1 });
        await award(owner, tenderId, bids[0]!.bidId);
        const lines: string[] = [];
        jest.spyOn(Logger.prototype, 'warn').mockImplementation((m: unknown) => {
          lines.push(String(m));
        });
        const before = await checks('unavailable');

        SUPPLIER.failure = RastaError.upstreamUnavailable('supplier-service');
        expect(await w.awardCheckSweeper.runOnce(tenderId)).toMatchObject({ claimed: 1, retry: 1 });
        const row = await rowOf(tenderId);
        expect(row).toMatchObject({
          status: 'PENDING',
          attempts: 1,
          leaseUntil: null,
          fence: null,
        });
        expect(row.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());
        expect(await checks('unavailable')).toBe(before + 1);
        // Every failure is tied to its award by ids and a closed code.
        const line = lines.find((l) => l.includes(tenderId));
        expect(line).toContain(bids[0]!.bidId);
        expect(line).toContain('UPSTREAM_UNAVAILABLE');
        expect(line).not.toMatch(/1000|amount|price/i);

        // Not claimed again until the backoff has passed.
        expect((await w.awardCheckSweeper.runOnce(tenderId)).claimed).toBe(0);
        SUPPLIER.failure = undefined;
        await ownerSql([
          `UPDATE "tender_award_standing_check" SET "next_attempt_at" = now() - interval '1 second' WHERE "tender_id" = '${tenderId}'`,
        ]);
        expect(await w.awardCheckSweeper.runOnce(tenderId)).toMatchObject({ claimed: 1, clear: 1 });
        expect(await rowOf(tenderId)).toMatchObject({
          status: 'DONE',
          outcome: 'CLEAR',
          attempts: 1,
        });
      });

      it('keeps the check pending when the outcome cannot be written, and names the award in the log', async () => {
        const { owner, tenderId, bids } = await evaluated({ count: 1 });
        await approve(owner, tenderId, bids[0]!.bidId);
        SUPPLIER.afterAnswer = () => SUPPLIER.suspend(bids[0]!.bidder, `SUS_${bids[0]!.bidder}`);
        await awardNow(owner, tenderId, bids[0]!.bidId);
        const lines: string[] = [];
        jest.spyOn(Logger.prototype, 'error').mockImplementation((m: unknown) => {
          lines.push(String(m));
        });
        jest
          .spyOn(w.awardChecks, 'settle')
          .mockRejectedValueOnce(new Error('the database went away'));

        expect(await w.awardCheckSweeper.runOnce(tenderId)).toMatchObject({ claimed: 1, retry: 1 });
        expect(await rowOf(tenderId)).toMatchObject({
          status: 'PENDING',
          outcome: null,
          attempts: 1,
        });
        expect(await conflicts(owner, tenderId)).toHaveLength(0);
        const line = lines.find((l) => l.includes(tenderId));
        expect(line).toContain(bids[0]!.bidId);
        expect(line).toContain('INTERNAL');
        expect(line).not.toContain('the database went away');

        // And once the database is back, the conflict is found and written — once.
        await ownerSql([
          `UPDATE "tender_award_standing_check" SET "next_attempt_at" = now() - interval '1 second' WHERE "tender_id" = '${tenderId}'`,
        ]);
        expect((await w.awardCheckSweeper.runOnce(tenderId)).conflict).toBe(1);
        expect(await conflicts(owner, tenderId)).toHaveLength(1);
      });

      it('lets one sweeper own a check at a time, and a lapsed claim writes nothing: no second event', async () => {
        const { owner, tenderId, bids } = await evaluated({ count: 1 });
        await award(owner, tenderId, bids[0]!.bidId);
        SUPPLIER.suspend(bids[0]!.bidder, `SUS_${bids[0]!.bidder}`);

        const [held] = await w.awardChecks.claimDue(10, 60, 'FENCE_A', tenderId);
        expect(held).toMatchObject({ tenderId, bidId: bids[0]!.bidId, fence: 'FENCE_A' });
        // Held under a live lease: another sweeper finds nothing.
        expect(await w.awardChecks.claimDue(10, 60, 'FENCE_B', tenderId)).toHaveLength(0);

        // The lease lapses; another sweeper takes the check back and settles it.
        await ownerSql([
          `UPDATE "tender_award_standing_check" SET "lease_until" = now() - interval '1 second' WHERE "tender_id" = '${tenderId}'`,
        ]);
        expect((await w.awardCheckSweeper.runOnce(tenderId)).conflict).toBe(1);

        // The first one, late, does nothing: the fence is not its any more.
        expect(await w.awardCheckService.process(held!, backoff)).toBe('LOST');
        expect(await conflicts(owner, tenderId)).toHaveLength(1);
        expect(await rowOf(tenderId)).toMatchObject({ status: 'DONE', outcome: 'CONFLICT' });
      });

      it('settles a check once when two sweepers run at the same time', async () => {
        const { owner, tenderId, bids } = await evaluated({ count: 1 });
        await award(owner, tenderId, bids[0]!.bidId);
        SUPPLIER.suspend(bids[0]!.bidder, `SUS_${bids[0]!.bidder}`);
        const [x, y] = await Promise.all([
          w.awardCheckSweeperWith().runOnce(tenderId),
          w.awardCheckSweeperWith().runOnce(tenderId),
        ]);
        expect(x.claimed + y.claimed).toBe(1);
        expect(x.conflict + y.conflict).toBe(1);
        expect(await conflicts(owner, tenderId)).toHaveLength(1);
      });

      it('counts what is pending, how old, and how many are past the alert age', async () => {
        const { owner, tenderId, bids } = await evaluated({ count: 1 });
        await award(owner, tenderId, bids[0]!.bidId);
        const open = await w.awardChecks.backlog(86_400);
        const late = await w.awardChecks.backlog(0);
        expect(open.pending).toBeGreaterThanOrEqual(1);
        expect(late.overdue).toBeGreaterThanOrEqual(1);
        expect(late.overdue).toBeGreaterThanOrEqual(open.overdue);
        expect(late.oldestPendingAgeSeconds).toBeGreaterThanOrEqual(0);
        await w.awardCheckSweeper.runOnce(tenderId);
        expect((await w.awardChecks.backlog(0)).pending).toBe(open.pending - 1);
      });

      it('writes one check per award: a repeat, and a refused award, write none', async () => {
        const { owner, tenderId, bids } = await evaluated({ count: 2 });
        SUPPLIER.suspend(bids[0]!.bidder, `SUS_${bids[0]!.bidder}`);
        await refusalOf(award(owner, tenderId, bids[0]!.bidId));
        expect(await rowCount(tenderId)).toBe(0);
        await award(owner, tenderId, bids[1]!.bidId, 'The first rank is suspended');
        await award(owner, tenderId, bids[1]!.bidId, 'The first rank is suspended');
        expect(await rowCount(tenderId)).toBe(1);
        expect((await rowOf(tenderId)).bidId).toBe(bids[1]!.bidId);
      });
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

  describe('reading the award (the price is behind the door, not on the topic)', () => {
    const projectOf = async (tenderId: string) =>
      (
        await runUnscoped('the suite reads the tender', () =>
          w.prisma.client.tender.findFirstOrThrow({ where: { id: tenderId } }),
        )
      ).projectId;
    const asService = <T>(owner: string, fn: () => T, service = 'contract-service') =>
      runWithContext(
        context({
          authType: 'SERVICE',
          callerService: service,
          organizationId: owner,
          roles: [],
        } as Partial<RequestContext>),
        fn,
      );

    it('gives the owner’s person the award with the winner’s price, and audits the read like a read of a bid', async () => {
      const { owner, tenderId, bids } = await evaluated({ count: 2 });
      const made = await award(owner, tenderId, bids[0]!.bidId);
      const reader = newUserId();
      const view = await as(owner, () => w.award.getAward(tenderId), reader);
      expect(view).toEqual({ ...made, alreadyAwarded: true });
      expect(view.amountMinor).toBe('1000');
      expect(view.projectId).toBe(await projectOf(tenderId));
      expect((await logOf(tenderId)).filter((r) => r.purpose === 'READ_AWARD')).toEqual([
        expect.objectContaining({
          bidId: bids[0]!.bidId,
          accessorOrganizationId: owner,
          accessorUserId: reader,
          outcome: 'GRANTED',
        }),
      ]);
      const accessed = (await eventsOf(owner, 'BID_ACCESSED', tenderId)).filter(
        (e) => (payloadOf(e) as { purpose: string }).purpose === 'READ_AWARD',
      );
      expect(accessed).toHaveLength(1);
    });

    it('gives contract-service the same award, recorded as the service, for the organization its token is signed for', async () => {
      const { owner, tenderId, bids } = await evaluated({ count: 1 });
      const made = await award(owner, tenderId, bids[0]!.bidId);
      const view = await asService(owner, () => w.award.getAward(tenderId));
      expect(view).toEqual({ ...made, alreadyAwarded: true });
      expect(view.projectId).toBe(await projectOf(tenderId));
      expect((await logOf(tenderId)).filter((r) => r.purpose === 'READ_AWARD')).toEqual([
        expect.objectContaining({
          accessorOrganizationId: owner,
          accessorUserId: 'service:contract-service',
          outcome: 'GRANTED',
        }),
      ]);
    });

    it('answers 404 for a tender not yet awarded, and audits that on the owner’s own tender', async () => {
      const { owner, tenderId } = await evaluated({ count: 1 });
      const user = newUserId();
      expect((await codeOf(as(owner, () => w.award.getAward(tenderId), user))).code).toBe(
        'NOT_FOUND',
      );
      expect((await logOf(tenderId)).filter((r) => r.purpose === 'READ_AWARD')).toEqual([
        expect.objectContaining({
          accessorUserId: user,
          outcome: 'REFUSED',
          refusalCode: 'NOT_FOUND',
        }),
      ]);
    });

    it('answers 404, unlogged, to another organization’s person and to a service token signed for another organization', async () => {
      const { owner, tenderId, bids } = await evaluated({ count: 1 });
      await award(owner, tenderId, bids[0]!.bidId);
      const stranger = (await evaluated({ count: 1 })).owner;
      const logBefore = (await logOf(tenderId)).length;
      expect((await codeOf(as(stranger, () => w.award.getAward(tenderId)))).code).toBe('NOT_FOUND');
      expect((await codeOf(asService(stranger, () => w.award.getAward(tenderId)))).code).toBe(
        'NOT_FOUND',
      );
      // A token signed for no tenant, and a bidder acting for its own organization.
      expect(
        (
          await codeOf(
            runWithContext(
              context({
                authType: 'SERVICE',
                callerService: 'contract-service',
                roles: [],
              } as Partial<RequestContext>),
              () => w.award.getAward(tenderId),
            ),
          )
        ).code,
      ).toBe('NOT_FOUND');
      expect((await codeOf(asBidder(bids[0]!.bidder, () => w.award.getAward(tenderId)))).code).toBe(
        'NOT_FOUND',
      );
      expect((await logOf(tenderId)).length).toBe(logBefore);
    });

    it('refuses the roles that never see a bid and a member of a bidding organization, each audited', async () => {
      const { owner, tenderId, bids } = await evaluated({ count: 2 });
      await award(owner, tenderId, bids[0]!.bidId);
      const refused: string[] = [];
      for (const roles of [['SYSTEM_ADMIN'], ['AUDITOR'], ['CONTRACTOR'], ['FLEET_MANAGER']]) {
        const user = newUserId();
        refused.push(user);
        expect(
          (await codeOf(asUser(owner, roles, () => w.award.getAward(tenderId), user))).code,
        ).toMatch(/FORBIDDEN|INSUFFICIENT_ROLE/);
      }
      const member = newUserId();
      refused.push(member);
      w.memberships.of.set(member, [bids[1]!.bidder]);
      expect(
        await refusalOf(
          as(owner, () => w.award.getAward(tenderId), member),
          'FORBIDDEN',
        ),
      ).toContain('CONFLICT_OF_INTEREST');
      const rows = (await logOf(tenderId)).filter((r) => r.purpose === 'READ_AWARD');
      expect(rows.map((r) => r.accessorUserId).sort()).toEqual([...refused].sort());
      expect(new Set(rows.map((r) => r.outcome))).toEqual(new Set(['REFUSED']));
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
        () => awardApproved(w, tenderId, { bidId: bids[0]!.bidId }),
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
        () => awardApproved(w, tenderId, { bidId: 'BID_ANY' }),
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
          () => awardApproved(w, tenderId, { bidId: bids[0]!.bidId }),
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
              () => awardApproved(w, tenderId, { bidId: 'x' }),
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
          () => awardApproved(strict, tenderId, { bidId: bids[0]!.bidId }),
        );
        expect(await refusalOf(alias, 'FORBIDDEN')).toContain('AWARDER_IS_EVALUATOR');
        expect(await awardRows(tenderId)).toHaveLength(0);
      });

      it('compares people on the identity each row recorded (#188 part B): another subject passes, the same subject under another user id is refused, another issuer is unknown', async () => {
        const identity = (owner: string, userId: string, subject: string, issuer: string) =>
          context({
            organizationId: owner,
            organizationIds: [owner],
            userId,
            roles: ['ORGANIZATION_ADMIN'],
            subject,
            issuer,
          } as unknown as Partial<RequestContext>);
        // An evaluated tender whose every row names its person: the evaluator's issuer and subject.
        const evaluatedByIdentity = async () => {
          const t = await evaluatingTender(w, organizations, 1);
          const evaluator = <T>(fn: () => T) =>
            runWithContext(identity(t.owner, 'USR_EVAL', 'sub-evaluator', ISSUER), fn);
          const bidId = t.bids[0]!.bidId;
          await evaluator(() => w.evaluation.qualify(t.tenderId, bidId, { decision: 'QUALIFIED' }));
          await evaluator(() =>
            w.evaluation.score(t.tenderId, bidId, {
              scores: [
                { criterionCode: 'PRICE', scoreScaled: 8_000 },
                { criterionCode: 'LICENCE', scoreScaled: 100 },
              ],
            }),
          );
          await evaluator(() => w.evaluation.evaluate(t.tenderId));
          return t;
        };
        const awardAs = (
          t: Awaited<ReturnType<typeof evaluatedByIdentity>>,
          userId: string,
          subject: string,
          issuer: string,
        ) =>
          runWithContext(identity(t.owner, userId, subject, issuer), () =>
            awardApproved(strict, t.tenderId, { bidId: t.bids[0]!.bidId }),
          );

        const other = await evaluatedByIdentity();
        expect((await awardAs(other, 'USR_OTHER', 'sub-other', ISSUER)).status).toBe('AWARDED');
        expect((await awardRows(other.tenderId))[0]).toMatchObject({
          awardedBy: 'USR_OTHER',
          awardedByIssuer: ISSUER,
          awardedBySubject: 'sub-other',
        });

        // One person behind a second user id: the subject gives them away.
        const same = await evaluatedByIdentity();
        expect(
          await refusalOf(awardAs(same, 'USR_SECOND_ID', 'sub-evaluator', ISSUER), 'FORBIDDEN'),
        ).toContain('AWARDER_IS_EVALUATOR');

        // Another issuer: a subject is unique only within its issuer, so nobody is taken for another person.
        const elsewhere = await evaluatedByIdentity();
        expect(
          await refusalOf(
            awardAs(elsewhere, 'USR_ELSEWHERE', 'sub-other', 'https://idp.other/realms/rasta'),
          ),
        ).toContain('ACTOR_IDENTITY_UNKNOWN');
        expect(await awardRows(elsewhere.tenderId)).toHaveLength(0);
      });

      it('fails closed for a user id the records cannot show to be another person: 422, not an award', async () => {
        // Rows written before the identity was recorded (or by a token that carried none) name a user id only.
        const { owner, tenderId, bids } = await evaluatingTender(w, organizations, 1);
        const evaluator = newUserId();
        const old = <T>(fn: () => T) =>
          runWithContext(
            context({
              organizationId: owner,
              organizationIds: [owner],
              userId: evaluator,
              roles: ['ORGANIZATION_ADMIN'],
              issuer: undefined,
              subject: undefined,
            } as unknown as Partial<RequestContext>),
            fn,
          );
        await old(() => w.evaluation.qualify(tenderId, bids[0]!.bidId, { decision: 'QUALIFIED' }));
        await old(() =>
          w.evaluation.score(tenderId, bids[0]!.bidId, {
            scores: [
              { criterionCode: 'PRICE', scoreScaled: 8_000 },
              { criterionCode: 'LICENCE', scoreScaled: 100 },
            ],
          }),
        );
        await old(() => w.evaluation.evaluate(tenderId));

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

    it('with a policy in force opens the request and awards nothing; the same command awards once it is approved', async () => {
      const { owner, tenderId, bids } = await evaluated({ count: 1 });
      await activateAwardPolicy(w, owner);
      const asked = await as(owner, () => w.award.award(tenderId, { bidId: bids[0]!.bidId }));
      expect(asked.executed).toBe(false);
      expect(await awardRows(tenderId)).toHaveLength(0);
      expect(await stateOf(tenderId, bids)).toEqual({
        tender: 'EVALUATED',
        bids: ['QUALIFIED'],
        awards: 0,
      });
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
      await approve(owner, tenderId, bids[0]!.bidId);
      const { release, atDecision } = holdAtDecision();
      const first = awardNow(owner, tenderId, bids[0]!.bidId);
      await atDecision;
      const second = awardNow(owner, tenderId, bids[1]!.bidId, 'The other one, for a reason');
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
      await approve(owner, tenderId, bids[0]!.bidId);
      const { release, atDecision } = holdAtDecision();
      const first = awardNow(owner, tenderId, bids[0]!.bidId);
      await atDecision;
      const second = awardNow(owner, tenderId, bids[0]!.bidId);
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
      await approve(owner, tenderId, bids[0]!.bidId);
      const { release, atDecision } = holdAtDecision();
      const awarding = awardNow(owner, tenderId, bids[0]!.bidId);
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

    const rowOf = (tenderId: string) =>
      runUnscoped('the suite reads the standing check', () =>
        w.prisma.client.tenderAwardStandingCheck.findFirstOrThrow({ where: { tenderId } }),
      );

    const conflictEvents = (owner: string, tenderId: string) =>
      eventsOf(owner, 'TENDER_AWARD_STANDING_CONFLICT_DETECTED', tenderId);

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

    it('does not commit an award without its standing check', async () => {
      const { owner, tenderId, bids } = await evaluated({ count: 2 });
      const row = insertAward({ owner, tenderId, bidId: bids[0]!.bidId, bidder: bids[0]!.bidder });
      await expect(
        runUnscoped('the suite awards without the check', () =>
          w.prisma.client.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(row);
            await tx.$executeRawUnsafe(
              `UPDATE "tender" SET "status" = 'AWARDED' WHERE "id" = '${tenderId}'`,
            );
            await tx.$executeRawUnsafe(
              `UPDATE "bid" SET "status" = 'AWARDED' WHERE "id" = '${bids[0]!.bidId}'`,
            );
          }),
        ),
      ).rejects.toThrow(/pending standing check/);
      expect(await stateOf(tenderId, bids)).toEqual({
        tender: 'EVALUATED',
        bids: ['QUALIFIED', 'QUALIFIED'],
        awards: 0,
      });
    });

    describe('the standing check row', () => {
      const insertCheck = (v: {
        owner: string;
        tenderId: string;
        bidId: string;
        bidder: string;
        id?: string;
      }) =>
        `INSERT INTO "tender_award_standing_check" ("id", "organization_id", "tender_id", "project_id", "bid_id",
           "winner_organization_id", "awarded_by", "awarded_at", "window_start", "created_at")
         VALUES ('${v.id ?? `TSC_${newUserId()}`}', '${v.owner}', '${v.tenderId}', 'PRJ_X', '${v.bidId}',
           '${v.bidder}', 'USR_X', now(), now(), now())`;

      it('is accepted only as the check of the award the tender holds, and only one', async () => {
        const unawarded = await evaluated({ count: 1 });
        await expect(
          attack(
            insertCheck({
              owner: unawarded.owner,
              tenderId: unawarded.tenderId,
              bidId: unawarded.bids[0]!.bidId,
              bidder: unawarded.bids[0]!.bidder,
            }),
          ),
        ).rejects.toThrow(/ck_award_standing_check_award/);

        const { owner, tenderId, bids } = await evaluated({ count: 2 });
        await award(owner, tenderId, bids[0]!.bidId);
        // A second one for the same tender; and one for a bid the award does not name.
        await expect(
          attack(insertCheck({ owner, tenderId, bidId: bids[0]!.bidId, bidder: bids[0]!.bidder })),
        ).rejects.toThrow(/ck_award_standing_check_award|unique|duplicate/i);
        await expect(
          attack(insertCheck({ owner, tenderId, bidId: bids[1]!.bidId, bidder: bids[1]!.bidder })),
        ).rejects.toThrow(/ck_award_standing_check_award/);
      });

      it('keeps what it is about, shape and finality: nothing but the claim and the outcome move, and a DONE check is final', async () => {
        const { owner, tenderId, bids } = await evaluated({ count: 2 });
        await award(owner, tenderId, bids[0]!.bidId);
        await expect(
          attack(
            `UPDATE "tender_award_standing_check" SET "winner_organization_id" = '${bids[1]!.bidder}' WHERE "tender_id" = '${tenderId}'`,
          ),
        ).rejects.toThrow(/ck_award_standing_check_immutable/);
        await expect(
          attack(
            `UPDATE "tender_award_standing_check" SET "window_start" = now() - interval '1 day' WHERE "tender_id" = '${tenderId}'`,
          ),
        ).rejects.toThrow(/ck_award_standing_check_immutable/);
        // DONE needs a live claim (and so a read and, for a conflict, its event); a fence is not set alone.
        await expect(
          attack(
            `UPDATE "tender_award_standing_check" SET "status" = 'DONE' WHERE "tender_id" = '${tenderId}'`,
          ),
        ).rejects.toThrow(/ck_award_standing_check_transition/);
        await expect(
          attack(
            `UPDATE "tender_award_standing_check" SET "fence" = 'F' WHERE "tender_id" = '${tenderId}'`,
          ),
        ).rejects.toThrow(/ck_award_standing_check_transition/);

        await w.awardCheckSweeper.runOnce(tenderId);
        for (const change of [
          `"status" = 'PENDING', "outcome" = NULL, "done_at" = NULL`,
          `"outcome" = 'CONFLICT'`,
          `"attempts" = 5`,
        ]) {
          await expect(
            attack(
              `UPDATE "tender_award_standing_check" SET ${change} WHERE "tender_id" = '${tenderId}'`,
            ),
          ).rejects.toThrow(/ck_award_standing_check_immutable/);
        }
        // Evidence that the check was made: never deleted.
        await expect(
          attack(`DELETE FROM "tender_award_standing_check" WHERE "tender_id" = '${tenderId}'`),
        ).rejects.toThrow(/ck_bid_append_only/);
      });

      it('is bound to its award: the window starts at the standing read the award was made on, and the project is the tender’s', async () => {
        const { owner, tenderId, bids } = await evaluated({ count: 1 });
        const project = (await tenderRow(tenderId)).projectId;
        const award = insertAward({
          owner,
          tenderId,
          bidId: bids[0]!.bidId,
          bidder: bids[0]!.bidder,
        });
        const check = (over: { window?: string; project?: string; created?: string }) =>
          `INSERT INTO "tender_award_standing_check" ("id", "organization_id", "tender_id", "project_id", "bid_id",
             "winner_organization_id", "awarded_by", "awarded_at", "window_start", "created_at")
           VALUES ('TSC_${newUserId()}', '${owner}', '${tenderId}', '${over.project ?? project}', '${bids[0]!.bidId}',
             '${bids[0]!.bidder}', 'USR_X', now(), ${over.window ?? 'now()'}, ${over.created ?? 'now()'})`;
        const inOneTransaction = (...statements: string[]) =>
          runUnscoped('the suite writes an award and a check as the runtime role', () =>
            w.prisma.client.$transaction(async (tx) => {
              for (const statement of statements) await tx.$executeRawUnsafe(statement);
            }),
          );
        // The award row above stands at now(); a window that starts later would let the sweeper miss a suspension.
        await expect(
          inOneTransaction(award, check({ window: `now() + interval '1 second'` })),
        ).rejects.toThrow(/ck_award_standing_check_window/);
        await expect(
          inOneTransaction(award, check({ window: `now() - interval '1 second'` })),
        ).rejects.toThrow(/ck_award_standing_check_window/);
        await expect(inOneTransaction(award, check({ project: 'PRJ_ELSEWHERE' }))).rejects.toThrow(
          /ck_award_standing_check_project/,
        );
        await expect(
          inOneTransaction(award, check({ created: `now() + interval '1 second'` })),
        ).rejects.toThrow(/ck_award_standing_check_new/);
        expect(await awardRows(tenderId)).toHaveLength(0);
      });

      it('lets the runtime role make only the sweeper’s moves: no shortcut to DONE, none around the backoff or the lease', async () => {
        const { owner, tenderId, bids } = await evaluated({ count: 1 });
        await award(owner, tenderId, bids[0]!.bidId);
        const row = (set: string) =>
          `UPDATE "tender_award_standing_check" SET ${set} WHERE "tender_id" = '${tenderId}'`;
        const transition = /ck_award_standing_check_transition/;

        // Straight to DONE, or to a conflict, with no claim and so no read and no event.
        for (const outcome of ['CLEAR', 'CONFLICT']) {
          await expect(
            attack(row(`"status" = 'DONE', "outcome" = '${outcome}', "done_at" = now()`)),
          ).rejects.toThrow(transition);
        }
        // Around the backoff and the attempts, on a check nobody holds.
        await expect(attack(row(`"next_attempt_at" = now() + interval '1 day'`))).rejects.toThrow(
          transition,
        );
        await expect(attack(row(`"attempts" = 3`))).rejects.toThrow(transition);
        // A lease that parks the check for good, and one claim over another's live lease.
        await expect(
          attack(row(`"lease_until" = now() + interval '2 hours', "fence" = 'F_LONG'`)),
        ).rejects.toThrow(transition);
        await attack(row(`"lease_until" = now() + interval '1 minute', "fence" = 'F_ONE'`));
        await expect(
          attack(row(`"lease_until" = now() + interval '1 minute', "fence" = 'F_TWO'`)),
        ).rejects.toThrow(transition);
        // A takeover of a lapsed lease is a new holder: it keeps no fence of the one it replaces.
        await ownerSql([
          `UPDATE "tender_award_standing_check" SET "lease_until" = now() - interval '1 second' WHERE "tender_id" = '${tenderId}'`,
        ]);
        await expect(
          attack(row(`"lease_until" = now() + interval '1 minute', "fence" = 'F_ONE'`)),
        ).rejects.toThrow(/a claim sets a new fence/);
        await attack(row(`"lease_until" = now() + interval '1 minute', "fence" = 'F_THREE'`));
        // From a live claim: a settlement dated in the future, or one that moves anything else.
        await expect(
          attack(
            row(
              `"status" = 'DONE', "outcome" = 'CLEAR', "done_at" = now() + interval '1 hour', "lease_until" = NULL, "fence" = NULL`,
            ),
          ),
        ).rejects.toThrow(transition);
        await expect(
          attack(
            row(
              `"status" = 'DONE', "outcome" = 'CLEAR', "done_at" = now(), "attempts" = 9, "lease_until" = NULL, "fence" = NULL`,
            ),
          ),
        ).rejects.toThrow(transition);
        // A failed attempt counts once and backs off by a bounded time.
        await expect(
          attack(
            row(
              `"attempts" = 0, "next_attempt_at" = now() + interval '1 minute', "lease_until" = NULL, "fence" = NULL`,
            ),
          ),
        ).rejects.toThrow(transition);
        await expect(
          attack(
            row(
              `"attempts" = 1, "next_attempt_at" = now() + interval '9 days', "lease_until" = NULL, "fence" = NULL`,
            ),
          ),
        ).rejects.toThrow(transition);
        expect(await rowOf(tenderId)).toMatchObject({
          status: 'PENDING',
          outcome: null,
          attempts: 0,
        });
      });

      it('does not commit a conflict without its event: the outbox must hold it by the end of the transaction', async () => {
        const { owner, tenderId, bids } = await evaluated({ count: 1 });
        await award(owner, tenderId, bids[0]!.bidId);
        const claim = `UPDATE "tender_award_standing_check" SET "lease_until" = now() + interval '1 minute', "fence" = 'F_DML' WHERE "tender_id" = '${tenderId}'`;
        const settle = (outcome: string) =>
          `UPDATE "tender_award_standing_check" SET "status" = 'DONE', "outcome" = '${outcome}', "done_at" = now(), "lease_until" = NULL, "fence" = NULL WHERE "tender_id" = '${tenderId}'`;
        await expect(
          runUnscoped('the suite settles a conflict as the runtime role', () =>
            w.prisma.client.$transaction(async (tx) => {
              await tx.$executeRawUnsafe(claim);
              await tx.$executeRawUnsafe(settle('CONFLICT'));
            }),
          ),
        ).rejects.toThrow(/ck_award_standing_check_announced/);
        expect(await rowOf(tenderId)).toMatchObject({ status: 'PENDING', outcome: null });
        expect(await conflictEvents(owner, tenderId)).toHaveLength(0);
      });

      it('lets a holder whose lease lapsed settle nothing and postpone nothing, even before anyone reclaims it', async () => {
        const { owner, tenderId, bids } = await evaluated({ count: 1 });
        await award(owner, tenderId, bids[0]!.bidId);
        SUPPLIER.suspend(bids[0]!.bidder, `SUS_${bids[0]!.bidder}`);
        const [held] = await w.awardChecks.claimDue(10, 60, 'FENCE_LAPSED', tenderId);
        await ownerSql([
          `UPDATE "tender_award_standing_check" SET "lease_until" = now() - interval '1 second' WHERE "tender_id" = '${tenderId}'`,
        ]);

        // It cannot settle (and the conflict it found is not written by it).
        expect(await w.awardCheckService.process(held!, { baseSeconds: 30, maxSeconds: 900 })).toBe(
          'LOST',
        );
        expect(await rowOf(tenderId)).toMatchObject({
          status: 'PENDING',
          outcome: null,
          attempts: 0,
        });
        expect(await conflictEvents(owner, tenderId)).toHaveLength(0);

        // Nor postpone: its failure moves neither the attempts nor the backoff.
        SUPPLIER.failure = RastaError.upstreamUnavailable('supplier-service');
        await w.awardCheckService.process(held!, { baseSeconds: 30, maxSeconds: 900 });
        expect(await rowOf(tenderId)).toMatchObject({ attempts: 0, nextAttemptAt: null });
        SUPPLIER.failure = undefined;

        // The lapse is itself the retry: the next sweep settles it, once.
        expect((await w.awardCheckSweeper.runOnce(tenderId)).conflict).toBe(1);
        expect(await conflictEvents(owner, tenderId)).toHaveLength(1);
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
      // The standing check still pending is named in the refusal.
      await expect(runAfterLock()).rejects.toThrow(
        /standing check\(s\) of which \d+ still pending/,
      );
      expect(await awardRows(tenderId)).toHaveLength(1);
      expect((await tenderRow(tenderId)).status).toBe('AWARDED');
    });
  });
});
