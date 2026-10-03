import { eventEnvelopeSchema } from '@rasta/contracts';
import { RastaError, runUnscoped, runWithContext } from '@rasta/nest-common';
import {
  EnvKekProvider,
  type KeyContext,
  type WrappedKey,
} from '../src/tender/sealing/key-provider';
import {
  asAdmin,
  asBidder,
  asUser,
  bidContent,
  cleanup,
  context,
  evaluatingTender,
  loadStanding,
  newOrganizationId,
  newUserId,
  outboxFor,
  publishedForBids,
  qualify as makeEligible,
  testEnv,
  wire,
  type Wiring,
} from './helpers';

/**
 * A contractor reading its **own** bid after the opening (ADR-066 § 4), against PostgreSQL: the
 * content it sealed, read back against the receipts audit-service holds; its status and what the
 * evaluation says of it (the decision once made, the total once completed — no rank, no other
 * bidder); every read audited with its outcome; and never another contractor's bid.
 */

const payloadOf = (row: { payload: unknown }) => eventEnvelopeSchema.parse(row.payload).payload;

const FULL = [
  { criterionCode: 'PRICE', scoreScaled: 8_500 },
  { criterionCode: 'LICENCE', scoreScaled: 100 },
];

describe('a contractor reads its own opened bid', () => {
  let w: Wiring;
  const organizations: string[] = [];
  let unwrap: jest.SpyInstance;

  const logOf = (tenderId: string) =>
    runUnscoped('the suite reads the access log', () =>
      w.prisma.client.bidAccessLog.findMany({ where: { tenderId }, orderBy: { id: 'asc' } }),
    );

  const mine = (bidder: string, tenderId: string, userId = newUserId()) =>
    asBidder(bidder, () => w.ownBids.getMineOpened(tenderId), userId);

  const codeOf = async (call: Promise<unknown>): Promise<{ code?: string; message?: string }> =>
    ((await call.then(
      () => undefined,
      (e: unknown) => e,
    )) ?? {}) as { code?: string; message?: string };

  beforeAll(async () => {
    w = wire(testEnv({ CONSTRUCTION_TENDER_OPEN_FOUR_EYES: 'false' }));
    await loadStanding(w);
  });

  beforeEach(() => {
    unwrap = jest.spyOn(w.keys, 'unwrap');
  });

  afterEach(() => {
    unwrap.mockRestore();
    w.evidence.failure = undefined;
    w.evidence.served.clear();
    w.memberships.reset();
  });

  afterAll(async () => {
    await cleanup(w.prisma, organizations);
    await w.close();
  });

  it('returns the content it sealed, its status and receipt data, and audits the read in the same transaction', async () => {
    const { owner, tenderId, bids } = await evaluatingTender(w, organizations, 2);
    const own = bids[0]!;
    const user = newUserId();
    const view = await mine(own.bidder, tenderId, user);

    expect(view).toMatchObject({
      bidId: own.bidId,
      tenderId,
      status: 'OPENED',
      revision: 1,
      content: bidContent('1000'),
      evaluation: {
        decision: null,
        reasonCode: null,
        completed: false,
        totalScaled: null,
        maxTotalScaled: null,
        evaluatorCount: null,
      },
    });
    const row = await runUnscoped('the suite reads the bid', () =>
      w.prisma.client.bid.findFirstOrThrow({ where: { id: own.bidId } }),
    );
    expect(view.contentCommitment).toBe(row.contentCommitment);
    expect(view.receivedAt).toBe(row.receivedAt.toISOString());

    // Audited under the tender owner's tenant, by the contractor, with the outcome.
    const rows = (await logOf(tenderId)).filter((r) => r.purpose === 'OWN_BID_CONTENT');
    expect(rows).toEqual([
      expect.objectContaining({
        organizationId: owner,
        bidId: own.bidId,
        accessorOrganizationId: own.bidder,
        accessorUserId: user,
        outcome: 'GRANTED',
        refusalCode: null,
      }),
    ]);
    const accessed = (await outboxFor(w.prisma, owner))
      .filter((e) => e.eventName === 'BID_ACCESSED')
      .map((e) => payloadOf(e) as Record<string, unknown>)
      .filter((p) => p.purpose === 'OWN_BID_CONTENT');
    expect(accessed).toEqual([
      expect.objectContaining({
        bidId: own.bidId,
        accessorOrganizationId: own.bidder,
        accessedBy: user,
        outcome: 'GRANTED',
        refusalCode: null,
      }),
    ]);
    // The content is in no event and no log row.
    expect(JSON.stringify(accessed)).not.toMatch(/Fixed price|Licence 1234/);
  });

  it('is never another contractor’s bid: each reads its own, and a stranger on the tender reads nothing', async () => {
    const { tenderId, bids } = await evaluatingTender(w, organizations, 2);
    const [first, second] = [bids[0]!, bids[1]!];
    const a = await mine(first.bidder, tenderId);
    const b = await mine(second.bidder, tenderId);
    expect([a.bidId, b.bidId]).toEqual([first.bidId, second.bidId]);
    expect(a.content.priceMinor).toBe('1000');
    expect(b.content.priceMinor).toBe('1001');
    // Nothing of the other bidder is in the answer.
    expect(JSON.stringify(a)).not.toContain(second.bidder);
    expect(JSON.stringify(a)).not.toContain(second.bidId);
    // The other bidder's price, compared value by value rather than as a
    // substring: the answer carries a random SHA-256 commitment and ULIDs, and
    // either can contain "1001" by chance (CI flake on 2026-10-03).
    const values: unknown[] = [];
    JSON.stringify(a, (_key, value: unknown) => {
      values.push(value);
      return value;
    });
    expect(values).not.toContain('1001');

    // A contractor with no bid on the tender is told what a missing bid is told, and the attempt is logged.
    const stranger = newOrganizationId();
    organizations.push(stranger);
    expect((await codeOf(mine(stranger, tenderId))).code).toBe('NOT_FOUND');
    const refused = (await logOf(tenderId)).filter((r) => r.accessorOrganizationId === stranger);
    expect(refused).toEqual([
      expect.objectContaining({
        purpose: 'OWN_BID_CONTENT',
        outcome: 'REFUSED',
        bidId: null,
        refusalCode: 'NOT_FOUND',
      }),
    ]);
    // A tender that does not exist has no owner whose log could hold the attempt.
    expect((await codeOf(mine(stranger, 'TND_NONE'))).code).toBe('NOT_FOUND');
  });

  it('is refused before the opening (422 NOT_OPENED), without touching the key, and the refusal is logged', async () => {
    const owner = newOrganizationId();
    const bidder = newOrganizationId();
    organizations.push(owner, bidder);
    await makeEligible(w, bidder);
    const { tenderId } = await publishedForBids(w, owner);
    await asBidder(bidder, () => w.bids.submit(tenderId, { content: bidContent() }));

    const error = await codeOf(mine(bidder, tenderId));
    expect(error.code).toBe('BUSINESS_RULE_VIOLATION');
    expect(error.message).toContain('NOT_OPENED');
    expect(unwrap).not.toHaveBeenCalled();
    expect(w.evidence.asked).not.toContainEqual({ organizationId: owner, tenderId });
    expect((await logOf(tenderId)).filter((r) => r.purpose === 'OWN_BID_CONTENT')).toEqual([
      expect.objectContaining({ outcome: 'REFUSED', refusalCode: 'NOT_OPENED' }),
    ]);
  });

  it('is refused for a bid that was withdrawn: it was never opened', async () => {
    const owner = newOrganizationId();
    const [kept, taken] = [newOrganizationId(), newOrganizationId()];
    organizations.push(owner, kept, taken);
    await makeEligible(w, kept);
    await makeEligible(w, taken);
    const { tenderId } = await publishedForBids(w, owner);
    await asBidder(kept, () => w.bids.submit(tenderId, { content: bidContent('1') }));
    const back = await asBidder(taken, () => w.bids.submit(tenderId, { content: bidContent('2') }));
    await asBidder(taken, () => w.bids.withdraw(tenderId, back.bidId, { expectedRevision: 1 }));
    await runUnscoped('the suite lets the deadline pass', () =>
      w.prisma.client.$executeRawUnsafe(
        `UPDATE "tender" SET "bid_opening_at" = now() - interval '2 hours',
           "bid_closing_at" = now() - interval '1 minute' WHERE "id" = '${tenderId}'`,
      ),
    );
    await w.tenderClose.close({ organizationId: owner, tenderId });
    await asAdmin(owner, () => w.tenderOpen.open(tenderId));
    expect((await codeOf(mine(taken, tenderId))).message).toContain('NOT_OPENED');
    expect((await mine(kept, tenderId)).status).toBe('OPENED');
  });

  it('reads the content against audit-service’s receipts on every call: unreachable is 503 and a forged head 422 INTEGRITY, each logged, and the key is unwrapped only for a read that goes through', async () => {
    const { owner, tenderId, bids } = await evaluatingTender(w, organizations, 1);
    const own = bids[0]!;
    // Opening unwrapped the key for the owner; what is counted from here is the contractor’s reads.
    unwrap.mockClear();

    w.evidence.failure = new Error('connect ECONNREFUSED');
    expect((await codeOf(mine(own.bidder, tenderId))).code).toBe('UPSTREAM_UNAVAILABLE');
    w.evidence.failure = undefined;
    expect(unwrap).not.toHaveBeenCalled();

    const honest = await w.evidence.fetchChain(owner, tenderId);
    w.evidence.served.set(tenderId, { ...honest, head: 'f'.repeat(64) });
    const forged = await codeOf(mine(own.bidder, tenderId));
    expect(forged.code).toBe('BUSINESS_RULE_VIOLATION');
    expect(forged.message).toContain('INTEGRITY');
    w.evidence.served.clear();
    expect(unwrap).not.toHaveBeenCalled();

    const refusals = (await logOf(tenderId))
      .filter((r) => r.purpose === 'OWN_BID_CONTENT' && r.outcome === 'REFUSED')
      .map((r) => r.refusalCode);
    expect(refusals).toEqual(['UPSTREAM_UNAVAILABLE', 'INTEGRITY']);

    // Honest again: read, and the key was unwrapped for this call alone and its bytes zeroised.
    const handedOut: Buffer[] = [];
    const original = EnvKekProvider.prototype.unwrap;
    unwrap.mockImplementation((wrapped: WrappedKey, keyContext: KeyContext) => {
      const der = original.call(w.keys, wrapped, keyContext);
      handedOut.push(der);
      return der;
    });
    expect((await mine(own.bidder, tenderId)).status).toBe('OPENED');
    expect(handedOut).toHaveLength(1);
    expect(handedOut[0]!.every((byte) => byte === 0)).toBe(true);
  });

  it('shows the decision once made, a disqualification’s closed code only, and the total only once the evaluation is completed — no rank, no other bidder', async () => {
    const { owner, tenderId, bids } = await evaluatingTender(w, organizations, 3);
    const [win, lose, out] = [bids[0]!, bids[1]!, bids[2]!];
    const evaluator = newUserId();
    for (const bid of [win, lose]) {
      await asAdmin(
        owner,
        () => w.evaluation.qualify(tenderId, bid.bidId, { decision: 'QUALIFIED' }),
        evaluator,
      );
    }
    await asAdmin(
      owner,
      () =>
        w.evaluation.qualify(tenderId, out.bidId, {
          decision: 'DISQUALIFIED',
          reasonCode: 'NON_RESPONSIVE',
          reasonText: 'Words the contractor never sees',
        }),
      evaluator,
    );
    await asAdmin(
      owner,
      () => w.evaluation.score(tenderId, win.bidId, { scores: FULL }),
      newUserId(),
    );
    await asAdmin(
      owner,
      () =>
        w.evaluation.score(tenderId, lose.bidId, {
          scores: [
            { criterionCode: 'PRICE', scoreScaled: 7_000 },
            { criterionCode: 'LICENCE', scoreScaled: 100 },
          ],
        }),
      newUserId(),
    );

    // The decision is visible; the scores are not, while the evaluation is under way.
    const early = await mine(win.bidder, tenderId);
    expect(early.status).toBe('QUALIFIED');
    expect(early.evaluation).toEqual({
      decision: 'QUALIFIED',
      reasonCode: null,
      completed: false,
      totalScaled: null,
      maxTotalScaled: null,
      evaluatorCount: null,
    });
    const rejected = await mine(out.bidder, tenderId);
    expect(rejected.status).toBe('DISQUALIFIED');
    expect(rejected.evaluation).toMatchObject({
      decision: 'DISQUALIFIED',
      reasonCode: 'NON_RESPONSIVE',
    });
    expect(JSON.stringify(rejected)).not.toContain('Words the contractor never sees');

    await asAdmin(owner, () => w.evaluation.evaluate(tenderId));
    const winner = await mine(win.bidder, tenderId);
    const loser = await mine(lose.bidder, tenderId);
    expect(winner.evaluation).toEqual({
      decision: 'QUALIFIED',
      reasonCode: null,
      completed: true,
      totalScaled: (6000n * 8_500n + 4000n * 100n).toString(),
      maxTotalScaled: (6000n * 100n * 100n + 4000n * 1n * 100n).toString(),
      evaluatorCount: 1,
    });
    expect(loser.evaluation.totalScaled).toBe((6000n * 7_000n + 4000n * 100n).toString());
    // A bidder is told its own status and total; not who else bid, how they did, or who wins.
    for (const view of [winner, loser, rejected]) {
      expect(Object.keys(view.evaluation).sort()).toEqual(
        [
          'completed',
          'decision',
          'evaluatorCount',
          'maxTotalScaled',
          'reasonCode',
          'totalScaled',
        ].sort(),
      );
    }
    expect(JSON.stringify(loser)).not.toContain(win.bidder);
    expect(JSON.stringify(loser)).not.toContain(win.bidId);
    expect(JSON.stringify(loser)).not.toMatch(/"rank"/);
    expect(rejected.evaluation.totalScaled).toBeNull();
  });

  it('is for the CONTRACTOR role alone: the owner’s staff, SYSTEM_ADMIN, AUDITOR and a service token are refused', async () => {
    const { owner, tenderId } = await evaluatingTender(w, organizations, 1);
    for (const roles of [['ORGANIZATION_ADMIN'], ['SYSTEM_ADMIN'], ['AUDITOR']]) {
      const call = asUser(owner, roles, () => w.ownBids.getMineOpened(tenderId));
      const error = await codeOf(call);
      expect(['INSUFFICIENT_ROLE', 'FORBIDDEN']).toContain(error.code);
    }
    const service = runWithContext(
      context({ authType: 'SERVICE', roles: ['CONTRACTOR'], organizationId: owner, userId: 'svc' }),
      () => w.ownBids.getMineOpened(tenderId),
    );
    expect((await codeOf(service)).code).toBe('FORBIDDEN');
    // None of those reached a bid: nothing was logged for the contractor purpose.
    expect((await logOf(tenderId)).filter((r) => r.purpose === 'OWN_BID_CONTENT')).toHaveLength(0);
  });

  it('fails the read when the log row cannot be written (the audit is part of the read)', async () => {
    const { tenderId, bids } = await evaluatingTender(w, organizations, 1);
    const own = bids[0]!;
    const insert = jest
      .spyOn(w.bidRepository, 'insertAccess')
      .mockRejectedValueOnce(RastaError.internal('the log is down'));
    await expect(mine(own.bidder, tenderId)).rejects.toBeDefined();
    insert.mockRestore();
    expect((await mine(own.bidder, tenderId)).status).toBe('OPENED');
  });
});
