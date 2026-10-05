import request from 'supertest';
import { runUnscoped } from '@rasta/nest-common';
import {
  actor,
  apiTenant,
  multiMemberActor,
  orgAdmin,
  reasonsOf,
  startApi,
  type ApiHarness,
} from './api-helpers';
import {
  activateAwardPolicy,
  approveAward,
  approvedProject,
  asAdmin,
  asBidder,
  bidContent,
  cleanup,
  evaluatedTender,
  loadStanding,
  publishedForBids,
  qualify,
  testEnv,
  wire,
  type Wiring,
} from './helpers';
import { REFUSAL_REASONS, buildConstructionOpenApiDocument } from '../src/openapi/document';
import { responseSchemaOf, validate, violationsOf } from './refusal-contract';

/**
 * The refusal contract, route by route (docs/06 § 6.7; round 1 of #227).
 *
 * `startApi` records every 403, 409 and 422 any API suite provokes and, when the harness closes, checks
 * each against the **generated OpenAPI document's** schema for that route and status (`refusal-contract.ts`).
 * That covers the refusals the other suites already cause. This suite causes, for real, the refusals of the
 * routes of `REFUSAL_REASONS` that none of them reaches, so that a real answer of **every** listed route is
 * checked against its documented schema, and it proves the checker itself refuses an answer the document does
 * not describe (a code or a path outside the route's closed list).
 *
 * Everything here is a real request through the real `AppModule`; no response is written by hand except the
 * deliberately wrong bodies that prove the validator fails.
 */
describe('the refusal contract: real refusals against the generated OpenAPI document', () => {
  let api: ApiHarness;
  let w: Wiring;
  const organizations: string[] = [];
  const coiBefore = process.env.CONSTRUCTION_COI_RULES;

  const http = () => request(api.app.getHttpServer());
  const as = (token: string) => ({ authorization: `Bearer ${token}` });
  const org = (label: string): string => {
    const id = apiTenant(label);
    organizations.push(id);
    return id;
  };

  /** A CLOSED tender with one bid by a qualified contractor, bids not yet opened. */
  const closed = async (label: string) => {
    const owner = org(`${label}-owner`);
    const bidder = org(`${label}-bidder`);
    await qualify(w, bidder);
    const { tenderId } = await publishedForBids(w, owner);
    const bid = await asBidder(bidder, () => w.bids.submit(tenderId, { content: bidContent() }));
    await runUnscoped('the suite lets the deadline pass', () =>
      w.prisma.client.$executeRawUnsafe(
        `UPDATE "tender" SET "bid_opening_at" = now() - interval '2 hours',
           "bid_closing_at" = now() - interval '1 minute' WHERE "id" = '${tenderId}'`,
      ),
    );
    await w.tenderClose.close({ organizationId: owner, tenderId });
    return { owner, bidder, tenderId, bidId: bid.bidId };
  };

  beforeAll(async () => {
    // As api-award: the awarder and the evaluators of the suite's tenders hold identities of another issuer.
    process.env.CONSTRUCTION_COI_RULES = '';
    api = await startApi();
    w = wire(testEnv({ CONSTRUCTION_TENDER_OPEN_FOUR_EYES: 'false' }));
    await loadStanding(w);
  });

  afterEach(() => {
    api.evidence.failure = undefined;
    api.evidence.served.clear();
    api.hierarchy.missing.clear();
    api.memberships.reset();
  });

  afterAll(async () => {
    if (coiBefore === undefined) delete process.env.CONSTRUCTION_COI_RULES;
    else process.env.CONSTRUCTION_COI_RULES = coiBefore;
    await cleanup(api.prisma, organizations);
    await w.close();
    await api.close();
  });

  it('a member of a bidding organization is refused on every owner route of the bids, with opening:CONFLICT_OF_INTEREST', async () => {
    const { owner, bidder, tenderId, bidId } = await closed('conflict');
    const conflicted = as(multiMemberActor(owner, [bidder], ['ORGANIZATION_ADMIN']));
    for (const [method, path] of [
      ['post', `/v1/tenders/${tenderId}/open-bids/proposal`],
      ['post', `/v1/tenders/${tenderId}/open-bids/proposal/withdraw`],
      ['get', `/v1/tenders/${tenderId}/bids`],
      ['get', `/v1/tenders/${tenderId}/bids/${bidId}`],
      ['get', `/v1/tenders/${tenderId}/bid-access-log`],
    ] as const) {
      const res = await (http() as unknown as Record<string, (p: string) => request.Test>)
        [method](path)
        .set(conflicted);
      expect({ path, status: res.status, reasons: reasonsOf(res.body) }).toEqual({
        path,
        status: 403,
        reasons: ['opening:CONFLICT_OF_INTEREST'],
      });
    }
  });

  it('a bid cannot be replaced or withdrawn once the tender has closed (bid:BID_WINDOW_CLOSED)', async () => {
    const { bidder, tenderId, bidId } = await closed('window');
    const contractor = as(actor(bidder, ['CONTRACTOR']));

    const replaced = await http()
      .put(`/v1/tenders/${tenderId}/bids/${bidId}`)
      .set(contractor)
      .send({ expectedRevision: 1, content: bidContent('900000000') });
    expect(replaced.status).toBe(422);
    expect(reasonsOf(replaced.body)).toEqual(['bid:BID_WINDOW_CLOSED']);

    const withdrawn = await http()
      .post(`/v1/tenders/${tenderId}/bids/${bidId}/withdraw`)
      .set(contractor)
      .send({ expectedRevision: 1 });
    expect(withdrawn.status).toBe(422);
    expect(reasonsOf(withdrawn.body)).toEqual(['bid:BID_WINDOW_CLOSED']);
  });

  it('a contractor cannot read its bid back before the opening (opening:NOT_OPENED)', async () => {
    const { bidder, tenderId } = await closed('mine');
    const res = await http()
      .get(`/v1/tenders/${tenderId}/bids/mine/opened`)
      .set(as(actor(bidder, ['CONTRACTOR'])));
    expect(res.status).toBe(422);
    expect(reasonsOf(res.body)).toEqual(['opening:NOT_OPENED']);
  });

  it('an invitation of an organization that does not exist is refused (invitation:INVITED_ORGANIZATION_NOT_FOUND)', async () => {
    const owner = org('invite-owner');
    const project = await approvedProject(w, owner);
    const created = await http()
      .post(`/v1/projects/${project.id}/tenders`)
      .set(as(orgAdmin(owner)))
      .send({
        title: 'Road resurfacing',
        scopeOfWork: 'Two kilometres',
        procurementNature: 'FORMAL_TENDER',
        visibility: 'RESTRICTED',
        bidOpeningAt: new Date(Date.now() + 86_400_000).toISOString(),
        bidClosingAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      });
    expect(created.status).toBe(201);
    api.hierarchy.missing.add('ORG_NOBODY');
    const res = await http()
      .post(`/v1/tenders/${created.body.id as string}/invitations`)
      .set(as(orgAdmin(owner)))
      .send({ organizationId: 'ORG_NOBODY' });
    expect(res.status).toBe(422);
    expect(res.body.details).toEqual([
      {
        path: 'invitation',
        code: 'INVITED_ORGANIZATION_NOT_FOUND',
        message: 'Invitation refused: INVITED_ORGANIZATION_NOT_FOUND',
      },
    ]);
    // `details` is a fixed message, no input echoed (the top-level `message`, for people, is unchanged).
    expect(JSON.stringify(res.body.details)).not.toContain('ORG_NOBODY');
  });

  describe('an award request, and the award that opens the winning bid', () => {
    it('a member of a bidding organization may neither read nor decide the approval (approval:CONFLICT_OF_INTEREST)', async () => {
      const { owner, tenderId, bids } = await evaluatedTender(w, organizations, { count: 2 });
      await activateAwardPolicy(w, owner);
      const asked = await http()
        .post(`/v1/tenders/${tenderId}/award`)
        .set(as(orgAdmin(owner)))
        .send({ bidId: bids[0]!.bidId });
      expect(asked.status).toBe(202);
      const stepId = asked.body.steps[0].approvalId as string;

      const conflicted = as(multiMemberActor(owner, [bids[1]!.bidder], ['ORGANIZATION_ADMIN']));
      const read = await http().get(`/v1/approvals/${stepId}`).set(conflicted);
      expect(read.status).toBe(403);
      expect(read.body.details).toEqual([
        {
          path: 'approval',
          code: 'CONFLICT_OF_INTEREST',
          message: 'Approval refused: CONFLICT_OF_INTEREST',
        },
      ]);
      const decided = await http()
        .post(`/v1/approvals/${stepId}/decision`)
        .set(conflicted)
        .send({ decision: 'GRANT', expectedVersion: 1 });
      expect(decided.status).toBe(403);
      expect(reasonsOf(decided.body)).toEqual(['approval:CONFLICT_OF_INTEREST']);
    });

    it('a receipt chain that differs from audit-service’s, found when the winning bid is opened for its price, answers opening:INTEGRITY', async () => {
      const { owner, tenderId, bids } = await evaluatedTender(w, organizations, { count: 2 });
      // Asked and granted the real way, in the owner's context; the award itself is the HTTP call.
      await asAdmin(owner, () => approveAward(w, tenderId, { bidId: bids[0]!.bidId }));
      const honest = await api.evidence.fetchChain(owner, tenderId);
      api.evidence.served.set(tenderId, { ...honest, head: 'f'.repeat(64) });

      const res = await http()
        .post(`/v1/tenders/${tenderId}/award`)
        .set(as(orgAdmin(owner)))
        .send({ bidId: bids[0]!.bidId });
      expect(res.status).toBe(422);
      expect(reasonsOf(res.body)).toEqual(['opening:INTEGRITY']);
      const row = await runUnscoped('the suite reads the tender', () =>
        w.prisma.client.tender.findFirstOrThrow({ where: { id: tenderId } }),
      );
      expect(row.status).toBe('EVALUATED');
    });
  });

  describe('the checker', () => {
    const KEY = 'POST /v1/tenders/{id}/award';
    const document = () => buildConstructionOpenApiDocument(api.app);
    const verdict = (status: number, body: unknown) =>
      validate(document(), responseSchemaOf(document(), KEY, status)!, body);
    const refusal = (path: string, code: string) => ({
      code: 'BUSINESS_RULE_VIOLATION',
      message: 'Award refused',
      details: [{ path, code, message: 'x' }],
    });

    it('accepts the answers the document describes, including the opening area the award now lists', () => {
      expect(verdict(422, refusal('opening', 'INTEGRITY'))).toEqual([]);
      expect(verdict(422, refusal('award', 'NOT_EVALUATED'))).toEqual([]);
      expect(verdict(403, refusal('award', 'CONFLICT_OF_INTEREST'))).toEqual([]);
      expect(verdict(409, refusal('approval', 'APPROVAL_STALE'))).toEqual([]);
    });

    it('refuses an answer the document does not describe: another path, another code, another status’s code, a free field', () => {
      expect(verdict(422, refusal('opening', 'NOT_CLOSED'))).not.toEqual([]);
      expect(verdict(422, refusal('publication', 'NATURE_REQUIRED'))).not.toEqual([]);
      expect(verdict(422, refusal('award', 'CONFLICT_OF_INTEREST'))).not.toEqual([]);
      expect(verdict(422, refusal('award', 'made-up'))).not.toEqual([]);
      expect(
        verdict(422, {
          ...refusal('award', 'NOT_EVALUATED'),
          details: [{ path: 'award', code: 'NOT_EVALUATED', message: 'x', bidId: 'BID_1' }],
        }),
      ).not.toEqual([]);
    });

    it('reports a recorded refusal that its route does not document, by route and status', () => {
      expect(
        violationsOf(api.app, [
          { key: KEY, status: 422, body: refusal('opening', 'NOT_CLOSED') },
          { key: 'GET /v1/nowhere', status: 403, body: refusal('award', 'NOT_EVALUATED') },
        ]),
      ).toEqual([
        expect.stringContaining(`${KEY} 422`),
        'GET /v1/nowhere 403: the document declares no such response',
      ]);
    });
  });

  it('every route this suite reaches is a route of REFUSAL_REASONS', () => {
    const reached = new Set(
      api.refusals.recorded
        .filter((refusal) => (refusal.body as { details?: unknown[] }).details?.length)
        .map((refusal) => refusal.key),
    );
    for (const key of reached) expect(Object.keys(REFUSAL_REASONS)).toContain(key);
  });
});
