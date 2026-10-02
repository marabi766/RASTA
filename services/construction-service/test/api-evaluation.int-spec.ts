import request from 'supertest';
import { runUnscoped } from '@rasta/nest-common';
import {
  actor,
  apiTenant,
  auditorActor,
  multiMemberActor,
  orgAdmin,
  startApi,
  type ApiHarness,
} from './api-helpers';
import {
  asAdmin,
  asBidder,
  bidContent,
  cleanup,
  loadStanding,
  publishedForBids,
  qualify,
  testEnv,
  wire,
  type Wiring,
} from './helpers';

/**
 * Evaluating bids through the real `AppModule` (ADR-067): closed without a token and to every
 * role the configuration did not grant, `404` for another organization, the real status codes for
 * what the lifecycle refuses, strict bodies, integers only, and the contractor's own read.
 */

describe('evaluation API', () => {
  let api: ApiHarness;
  /** The domain, with one-person opening, to bring a tender to EVALUATING before the API is used. */
  let w: Wiring;
  const organizations: string[] = [];

  const http = () => request(api.app.getHttpServer());
  const as = (token: string) => ({ authorization: `Bearer ${token}` });
  const org = (label: string): string => {
    const id = apiTenant(label);
    organizations.push(id);
    return id;
  };

  /** An EVALUATING tender with two bids by qualified contractors. */
  const evaluating = async (label: string) => {
    const owner = org(`${label}-owner`);
    const bids: { bidder: string; bidId: string }[] = [];
    const { tenderId } = await publishedForBids(w, owner);
    for (const [i, price] of ['1250000000', '1300000000'].entries()) {
      const bidder = org(`${label}-bidder${i}`);
      await qualify(w, bidder);
      const view = await asBidder(bidder, () =>
        w.bids.submit(tenderId, { content: bidContent(price) }),
      );
      bids.push({ bidder, bidId: view.bidId });
    }
    await runUnscoped('the suite lets the deadline pass', () =>
      w.prisma.client.$executeRawUnsafe(
        `UPDATE "tender" SET "bid_opening_at" = now() - interval '2 hours',
           "bid_closing_at" = now() - interval '1 minute' WHERE "id" = '${tenderId}'`,
      ),
    );
    await w.tenderClose.close({ organizationId: owner, tenderId });
    await asAdmin(owner, () => w.tenderOpen.open(tenderId));
    return { owner, tenderId, bids };
  };

  beforeAll(async () => {
    api = await startApi();
    w = wire(testEnv({ CONSTRUCTION_TENDER_OPEN_FOUR_EYES: 'false' }));
    await loadStanding(w);
  });

  afterEach(() => {
    api.memberships.reset();
    api.evidence.failure = undefined;
  });

  afterAll(async () => {
    await cleanup(api.prisma, organizations);
    await w.close();
    await api.close();
  });

  it('is closed without a token and to every role the configuration did not grant', async () => {
    const a = org('closed');
    const routes: [string, string, object | undefined][] = [
      ['post', '/v1/tenders/TND_x/bids/BID_x/qualification', { decision: 'QUALIFIED' }],
      ['post', '/v1/tenders/TND_x/bids/BID_x/recusal', { reasonCode: 'OTHER' }],
      [
        'post',
        '/v1/tenders/TND_x/bids/BID_x/scores',
        { scores: [{ criterionCode: 'PRICE', scoreScaled: 1 }] },
      ],
      ['post', '/v1/tenders/TND_x/evaluate', {}],
      ['get', '/v1/tenders/TND_x/evaluation', undefined],
    ];
    for (const [method, path, body] of routes) {
      const call = (token?: string) => {
        const req = (http() as unknown as Record<string, (p: string) => request.Test>)[method]!(
          path,
        );
        const authed = token ? req.set(as(token)) : req;
        return body ? authed.send(body) : authed;
      };
      expect((await call()).status).toBe(401);
      expect((await call(auditorActor(a))).status).toBe(403);
      expect((await call(actor(a, ['CONTRACTOR']))).status).toBe(403);
      expect((await call(actor(a, ['SYSTEM_ADMIN']))).status).toBe(403);
      expect((await call(actor(a, ['SYSTEM_ADMIN', 'ORGANIZATION_ADMIN']))).status).toBe(403);
      expect((await call(actor(a, ['CONTRACTOR', 'ORGANIZATION_ADMIN']))).status).toBe(403);
      expect((await call(actor(a, ['FLEET_MANAGER']))).status).toBe(403);
    }
  });

  it('decides, scores, completes and reads the matrix with the real status codes', async () => {
    const { owner, tenderId, bids } = await evaluating('flow');
    const [first, second] = [bids[0]!, bids[1]!];
    const evaluator = orgAdmin(owner);

    const qualified = await http()
      .post(`/v1/tenders/${tenderId}/bids/${first.bidId}/qualification`)
      .set(as(evaluator))
      .send({ decision: 'QUALIFIED' });
    expect(qualified.status).toBe(200);
    expect(qualified.body).toMatchObject({ decision: 'QUALIFIED', alreadyDecided: false });
    expect(
      (
        await http()
          .post(`/v1/tenders/${tenderId}/bids/${first.bidId}/qualification`)
          .set(as(evaluator))
          .send({ decision: 'QUALIFIED' })
      ).body,
    ).toMatchObject({ alreadyDecided: true });
    const different = await http()
      .post(`/v1/tenders/${tenderId}/bids/${first.bidId}/qualification`)
      .set(as(evaluator))
      .send({ decision: 'DISQUALIFIED', reasonCode: 'OTHER', reasonText: 'Changed my mind' });
    expect(different.status).toBe(422);
    expect(different.body.message).toContain('BID_ALREADY_DECIDED');

    const disqualified = await http()
      .post(`/v1/tenders/${tenderId}/bids/${second.bidId}/qualification`)
      .set(as(orgAdmin(owner)))
      .send({ decision: 'DISQUALIFIED', reasonCode: 'NON_RESPONSIVE', reasonText: 'No licence' });
    expect(disqualified.status).toBe(200);
    expect(JSON.stringify(disqualified.body)).not.toContain('No licence');

    const early = await http().post(`/v1/tenders/${tenderId}/evaluate`).set(as(evaluator)).send({});
    expect(early.status).toBe(422);
    expect(early.body.message).toContain('EVALUATION_INCOMPLETE');

    const scored = await http()
      .post(`/v1/tenders/${tenderId}/bids/${first.bidId}/scores`)
      .set(as(evaluator))
      .send({
        scores: [
          { criterionCode: 'PRICE', scoreScaled: 8_550 },
          { criterionCode: 'LICENCE', scoreScaled: 100 },
        ],
      });
    expect(scored.status).toBe(200);
    expect(scored.body).toMatchObject({ complete: true, unchanged: [] });
    expect(scored.body.recorded).toHaveLength(2);

    const completed = await http()
      .post(`/v1/tenders/${tenderId}/evaluate`)
      .set(as(orgAdmin(owner)))
      .send({});
    expect(completed.status).toBe(200);
    expect(completed.body).toMatchObject({
      status: 'EVALUATED',
      qualifiedBidCount: 1,
      alreadyEvaluated: false,
    });
    expect(completed.body.matrixDigest).toMatch(/^[0-9a-f]{64}$/);

    const matrix = await http()
      .get(`/v1/tenders/${tenderId}/evaluation`)
      .set(as(orgAdmin(owner)));
    expect(matrix.status).toBe(200);
    expect(matrix.body).toMatchObject({ status: 'EVALUATED', frozen: true, ready: true });
    const entry = matrix.body.bids.find((b: { bidId: string }) => b.bidId === first.bidId);
    expect(entry).toMatchObject({ rank: 1, tied: false, evaluatorCount: 1 });
    expect(entry.totalScaled).toBe((6000n * 8_550n + 4000n * 100n).toString());
    // Money-like totals are strings: nothing a float could round.
    expect(typeof matrix.body.maxTotalScaled).toBe('string');

    const late = await http()
      .post(`/v1/tenders/${tenderId}/bids/${first.bidId}/scores`)
      .set(as(evaluator))
      .send({ scores: [{ criterionCode: 'PRICE', scoreScaled: 1 }] });
    expect(late.status).toBe(422);
    expect(late.body.message).toContain('NOT_EVALUATING');
  });

  it('refuses unknown fields, floats and out-of-range scores with 400 and an unknown criterion or range with 422', async () => {
    const { owner, tenderId, bids } = await evaluating('bodies');
    const bidId = bids[0]!.bidId;
    const token = orgAdmin(owner);
    await http()
      .post(`/v1/tenders/${tenderId}/bids/${bidId}/qualification`)
      .set(as(token))
      .send({ decision: 'QUALIFIED' });
    const score = (body: object) =>
      http().post(`/v1/tenders/${tenderId}/bids/${bidId}/scores`).set(as(token)).send(body);

    for (const bad of [
      { scores: [{ criterionCode: 'PRICE', scoreScaled: 85.5 }] },
      { scores: [{ criterionCode: 'PRICE', scoreScaled: -1 }] },
      { scores: [{ criterionCode: 'PRICE', scoreScaled: '8500' }] },
      { scores: [] },
      { scores: [{ criterionCode: 'PRICE', scoreScaled: 1, evaluatorId: 'USR_X' }] },
      { scores: [{ criterionCode: 'PRICE', scoreScaled: 1 }], organizationId: 'ORG_X' },
    ]) {
      expect((await score(bad)).status).toBe(400);
    }
    const range = await score({ scores: [{ criterionCode: 'PRICE', scoreScaled: 10_001 }] });
    expect(range.status).toBe(422);
    expect(range.body.message).toContain('SCORE_OUT_OF_RANGE');
    const unknown = await score({ scores: [{ criterionCode: 'EXPERIENCE', scoreScaled: 1 }] });
    expect(unknown.status).toBe(422);
    expect(unknown.body.message).toContain('UNKNOWN_CRITERION');

    const qualify = (body: object) =>
      http()
        .post(`/v1/tenders/${tenderId}/bids/${bids[1]!.bidId}/qualification`)
        .set(as(token))
        .send(body);
    expect((await qualify({ decision: 'DISQUALIFIED' })).status).toBe(400);
    expect((await qualify({ decision: 'QUALIFIED', reasonCode: 'OTHER' })).status).toBe(400);
    expect((await qualify({ decision: 'MAYBE' })).status).toBe(400);
    expect((await qualify({ decision: 'QUALIFIED', decidedBy: 'USR_X' })).status).toBe(400);
  });

  it('answers another organization 404 on every route, and 403 to a member of a bidding organization, each audited', async () => {
    const { owner, tenderId, bids } = await evaluating('isolation');
    const stranger = org('isolation-stranger');
    const bidId = bids[0]!.bidId;
    const routes: [string, string, object | undefined][] = [
      ['post', `/v1/tenders/${tenderId}/bids/${bidId}/qualification`, { decision: 'QUALIFIED' }],
      ['post', `/v1/tenders/${tenderId}/bids/${bidId}/recusal`, { reasonCode: 'OTHER' }],
      [
        'post',
        `/v1/tenders/${tenderId}/bids/${bidId}/scores`,
        { scores: [{ criterionCode: 'PRICE', scoreScaled: 1 }] },
      ],
      ['post', `/v1/tenders/${tenderId}/evaluate`, {}],
      ['get', `/v1/tenders/${tenderId}/evaluation`, undefined],
    ];
    for (const [method, path, body] of routes) {
      const call = (token: string) => {
        const req = (http() as unknown as Record<string, (p: string) => request.Test>)[method]!(
          path,
        ).set(as(token));
        return body ? req.send(body) : req;
      };
      const foreign = await call(orgAdmin(stranger));
      expect(foreign.status).toBe(404);
      expect(foreign.body.code).toBe('NOT_FOUND');
      const conflicted = await call(
        multiMemberActor(owner, [bids[1]!.bidder], ['ORGANIZATION_ADMIN']),
      );
      expect(conflicted.status).toBe(403);
      expect(conflicted.body.message).toContain('CONFLICT_OF_INTEREST');
    }
    const row = await runUnscoped('the suite reads the tender', () =>
      w.prisma.client.tender.findFirstOrThrow({ where: { id: tenderId } }),
    );
    expect(row.status).toBe('EVALUATING');
    const refusals = await runUnscoped('the suite reads the log', () =>
      w.prisma.client.bidAccessLog.findMany({ where: { tenderId, outcome: 'REFUSED' } }),
    );
    expect(refusals.filter((r) => r.refusalCode === 'NOT_FOUND')).toHaveLength(5);
    expect(refusals.filter((r) => r.refusalCode === 'CONFLICT_OF_INTEREST')).toHaveLength(5);
  });

  it('answers 503 when identity-service cannot say who the caller is, and nothing is done', async () => {
    const { owner, tenderId, bids } = await evaluating('identity');
    api.memberships.failure = new Error('connect ECONNREFUSED');
    const res = await http()
      .post(`/v1/tenders/${tenderId}/bids/${bids[0]!.bidId}/qualification`)
      .set(as(orgAdmin(owner)))
      .send({ decision: 'QUALIFIED' });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('UPSTREAM_UNAVAILABLE');
  });

  it('serves a contractor its own opened bid — and only its own — with the evaluation of it', async () => {
    const { owner, tenderId, bids } = await evaluating('own');
    const [first, second] = [bids[0]!, bids[1]!];
    const path = `/v1/tenders/${tenderId}/bids/mine/opened`;

    expect((await http().get(path)).status).toBe(401);
    expect(
      (
        await http()
          .get(path)
          .set(as(orgAdmin(owner)))
      ).status,
    ).toBe(403);
    expect(
      (
        await http()
          .get(path)
          .set(as(auditorActor(owner)))
      ).status,
    ).toBe(403);
    expect(
      (
        await http()
          .get(path)
          .set(as(actor(owner, ['SYSTEM_ADMIN'])))
      ).status,
    ).toBe(403);

    const res = await http()
      .get(path)
      .set(as(actor(first.bidder, ['CONTRACTOR'])));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      bidId: first.bidId,
      status: 'OPENED',
      content: { priceMinor: '1250000000' },
      evaluation: { decision: null, completed: false, totalScaled: null },
    });
    expect(JSON.stringify(res.body)).not.toContain(second.bidId);
    expect(JSON.stringify(res.body)).not.toContain('1300000000');

    const other = await http()
      .get(path)
      .set(as(actor(second.bidder, ['CONTRACTOR'])));
    expect(other.body.bidId).toBe(second.bidId);

    const nobody = await http()
      .get(path)
      .set(as(actor(org('own-stranger'), ['CONTRACTOR'])));
    expect(nobody.status).toBe(404);

    // Unreachable audit-service: 503, and the refusal is in the owner's access log.
    api.evidence.failure = new Error('connect ECONNREFUSED');
    const down = await http()
      .get(path)
      .set(as(actor(first.bidder, ['CONTRACTOR'])));
    expect(down.status).toBe(503);
    api.evidence.failure = undefined;
    const log = await runUnscoped('the suite reads the log', () =>
      w.prisma.client.bidAccessLog.findMany({
        where: { tenderId, purpose: 'OWN_BID_CONTENT' },
        orderBy: { id: 'asc' },
      }),
    );
    expect(log.map((r) => `${r.outcome}:${r.refusalCode}`).sort()).toEqual([
      'GRANTED:null',
      'GRANTED:null',
      'REFUSED:NOT_FOUND',
      'REFUSED:UPSTREAM_UNAVAILABLE',
    ]);
  });
});
