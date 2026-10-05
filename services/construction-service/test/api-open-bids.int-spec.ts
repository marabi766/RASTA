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
  asBidder,
  bidContent,
  cleanup,
  publishedForBids,
  qualify,
  wire,
  type Wiring,
} from './helpers';

/**
 * Opening the bids, and the owner's reads, through the real `AppModule` (ADR-066 § 4-5):
 * closed without a token and to every role the configuration did not grant, `404` for
 * another organization, the real status codes for what the lifecycle and the evidence
 * refuse, and no content in any answer before the opening.
 */

describe('open-bids API', () => {
  let api: ApiHarness;
  let w: Wiring;
  const organizations: string[] = [];

  const http = () => request(api.app.getHttpServer());
  const as = (token: string) => ({ authorization: `Bearer ${token}` });
  const org = (label: string): string => {
    const id = apiTenant(label);
    organizations.push(id);
    return id;
  };

  /** A CLOSED tender with one bid by a qualified contractor. */
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
    api = await startApi();
    w = wire();
  });

  afterEach(() => {
    api.evidence.failure = undefined;
    api.evidence.served.clear();
  });

  afterAll(async () => {
    await cleanup(api.prisma, organizations);
    await w.close();
    await api.close();
  });

  /** Every owner-side route of a tender's bids: method, path. */
  const ownerRoutes = (tenderId: string, bidId: string): [string, string][] => [
    ['post', `/v1/tenders/${tenderId}/open-bids`],
    ['post', `/v1/tenders/${tenderId}/open-bids/proposal`],
    ['post', `/v1/tenders/${tenderId}/open-bids/proposal/withdraw`],
    ['get', `/v1/tenders/${tenderId}/bids`],
    ['get', `/v1/tenders/${tenderId}/bids/${bidId}`],
    ['get', `/v1/tenders/${tenderId}/bid-access-log`],
  ];
  const call = (method: string, path: string, token?: string) => {
    const req = (http() as unknown as Record<string, (p: string) => request.Test>)[method]!(path);
    return token ? req.set(as(token)) : req;
  };

  it('is closed without a token, and to every role the configuration did not grant in the owning organization', async () => {
    const { owner, tenderId, bidId } = await closed('closed');
    for (const [method, path] of ownerRoutes(tenderId, bidId)) {
      expect((await call(method, path)).status).toBe(401);
      for (const token of [
        auditorActor(owner),
        actor(owner, ['CONTRACTOR']),
        actor(owner, ['FLEET_MANAGER']),
        // The platform administrator has no access to a bid through the API, super-role or not.
        actor(owner, ['SYSTEM_ADMIN']),
        // ... and not made harmless by also holding the owner's role.
        actor(owner, ['SYSTEM_ADMIN', 'ORGANIZATION_ADMIN']),
        actor(owner, ['CONTRACTOR', 'ORGANIZATION_ADMIN']),
      ]) {
        const res = await call(method, path, token);
        expect({ path, status: res.status }).toEqual({ path, status: 403 });
      }
    }
  });

  it('answers a contractor of another organization what a missing tender gets — 404, ownership before roles — and tells the owner; 403 only inside the owning organization (#223 F3)', async () => {
    const { owner, bidder, tenderId, bidId } = await closed('f3');
    const missing = `TND_${tenderId.slice(-6)}MISSING`;
    // A contractor of the bidding organization, and one of an organization with no part in it.
    const contractors = [actor(bidder, ['CONTRACTOR']), actor(org('f3-other'), ['CONTRACTOR'])];

    const answer = (res: request.Response) => ({
      status: res.status,
      code: res.body.code,
      message: res.body.message,
    });
    for (const token of contractors) {
      for (const [method, path] of ownerRoutes(tenderId, bidId)) {
        const other = answer(await call(method, path, token));
        expect({ path, ...other }).toEqual({
          path,
          status: 404,
          code: 'NOT_FOUND',
          message: 'Tender not found',
        });
        expect(other).toEqual(answer(await call(method, path.replace(tenderId, missing), token)));
      }
    }

    // Inside the owning organization, a member without an opening role is told 403.
    for (const [method, path] of ownerRoutes(tenderId, bidId)) {
      const res = await call(method, path, actor(owner, ['CONTRACTOR']));
      expect({ path, status: res.status, code: res.body.code }).toEqual({
        path,
        status: 403,
        code: 'FORBIDDEN',
      });
    }

    // Each attempt on a bid route is on the owner's log (reading the log itself is not):
    // another organization's as before, and now the role refusal inside the owner as well.
    const rows = await runUnscoped('the suite reads the access log', () =>
      w.prisma.client.bidAccessLog.findMany({ where: { tenderId, outcome: 'REFUSED' } }),
    );
    const refused = (organizationId: string) =>
      rows
        .filter((row) => row.accessorOrganizationId === organizationId)
        .map((row) => `${row.purpose}:${row.refusalCode}`)
        .sort();
    const fiveRoutes = (code: string) =>
      ['OPEN_BIDS', 'PROPOSE_OPENING', 'WITHDRAW_PROPOSAL', 'LIST_BIDS', 'READ_BID']
        .map((purpose) => `${purpose}:${code}`)
        .sort();
    expect(refused(bidder)).toEqual(fiveRoutes('NOT_FOUND'));
    expect(refused(owner)).toEqual(fiveRoutes('FORBIDDEN'));
    const row = await runUnscoped('the suite reads the tender', () =>
      w.prisma.client.tender.findFirstOrThrow({ where: { id: tenderId } }),
    );
    expect(row).toMatchObject({ status: 'CLOSED', openingProposedBy: null, openedAt: null });
  });

  it('opens (200), answers the same view again, and reads the bids with their content (200), each read audited', async () => {
    const { owner, bidder, tenderId, bidId } = await closed('flow');

    const before = await http()
      .get(`/v1/tenders/${tenderId}/bids`)
      .set(as(orgAdmin(owner)));
    expect(before.status).toBe(200);
    expect(before.body).toMatchObject({ opened: false, bidCount: 1, bids: [] });
    expect(JSON.stringify(before.body)).not.toMatch(/1250000000|Licence 1234/);
    expect(JSON.stringify(before.body)).not.toContain(bidder);
    expect(
      (
        await http()
          .get(`/v1/tenders/${tenderId}/bids/${bidId}`)
          .set(as(orgAdmin(owner)))
      ).status,
    ).toBe(422);

    // Four eyes (Q-91, on by default): a proposal by one user, the approval of a second.
    const noProposal = await http()
      .post(`/v1/tenders/${tenderId}/open-bids`)
      .set(as(orgAdmin(owner)));
    expect(noProposal.status).toBe(422);
    expect(noProposal.body.message).toContain('PROPOSAL_REQUIRED');
    const proposer = orgAdmin(owner);
    const proposal = await http()
      .post(`/v1/tenders/${tenderId}/open-bids/proposal`)
      .set(as(proposer));
    expect(proposal.status).toBe(200);
    expect(proposal.body).toMatchObject({ tenderId, alreadyProposed: false });
    const self = await http().post(`/v1/tenders/${tenderId}/open-bids`).set(as(proposer));
    expect(self.status).toBe(422);
    expect(self.body.message).toContain('SECOND_PERSON_REQUIRED');
    // Only the proposer may take it back; then anyone eligible proposes afresh.
    const stranger = await http()
      .post(`/v1/tenders/${tenderId}/open-bids/proposal/withdraw`)
      .set(as(orgAdmin(owner)));
    expect(stranger.status).toBe(403);
    const withdrawn = await http()
      .post(`/v1/tenders/${tenderId}/open-bids/proposal/withdraw`)
      .set(as(proposer));
    expect(withdrawn.status).toBe(200);
    expect(withdrawn.body).toMatchObject({ tenderId });
    expect(
      (await http().post(`/v1/tenders/${tenderId}/open-bids/proposal`).set(as(proposer))).body,
    ).toMatchObject({ alreadyProposed: false });

    const opened = await http()
      .post(`/v1/tenders/${tenderId}/open-bids`)
      .set(as(orgAdmin(owner)));
    expect(opened.status).toBe(200);
    expect(opened.body).toMatchObject({
      tenderId,
      status: 'EVALUATING',
      bidCount: 1,
      alreadyOpened: false,
    });
    expect(JSON.stringify(opened.body)).not.toMatch(/1250000000|Licence 1234/);

    const again = await http()
      .post(`/v1/tenders/${tenderId}/open-bids`)
      .set(as(orgAdmin(owner)));
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ ...opened.body, alreadyOpened: true });

    const list = await http()
      .get(`/v1/tenders/${tenderId}/bids`)
      .set(as(orgAdmin(owner)));
    expect(list.status).toBe(200);
    expect(list.body).toMatchObject({ opened: true, bidCount: 1 });
    expect(list.body.bids[0]).toMatchObject({
      bidId,
      bidderOrganizationId: bidder,
      status: 'OPENED',
      content: { priceMinor: '1250000000' },
    });
    const one = await http()
      .get(`/v1/tenders/${tenderId}/bids/${bidId}`)
      .set(as(orgAdmin(owner)));
    expect(one.status).toBe(200);
    expect(one.body).toEqual(list.body.bids[0]);

    const log = await http()
      .get(`/v1/tenders/${tenderId}/bid-access-log`)
      .set(as(orgAdmin(owner)));
    expect(log.status).toBe(200);
    const purposes = (log.body.items as { purpose: string; outcome: string }[]).map(
      (item) => `${item.purpose}:${item.outcome}`,
    );
    expect(purposes).toEqual(
      expect.arrayContaining([
        'COUNT_BIDS:GRANTED',
        'READ_BID:REFUSED',
        'OPEN_BIDS:GRANTED',
        'LIST_BIDS:GRANTED',
        'READ_BID:GRANTED',
      ]),
    );
    expect(JSON.stringify(log.body)).not.toMatch(/1250000000|Licence 1234/);
  });

  it('answers another organization 404 on every route, and 403 to a member of a bidding organization', async () => {
    const { owner, bidder, tenderId, bidId } = await closed('isolation');
    const stranger = org('isolation-stranger');

    for (const [method, path] of [
      ['post', `/v1/tenders/${tenderId}/open-bids`],
      ['post', `/v1/tenders/${tenderId}/open-bids/proposal`],
      ['get', `/v1/tenders/${tenderId}/bids`],
      ['get', `/v1/tenders/${tenderId}/bids/${bidId}`],
      ['get', `/v1/tenders/${tenderId}/bid-access-log`],
    ] as const) {
      const res = await (http() as unknown as Record<string, (p: string) => request.Test>)[method]!(
        path,
      ).set(as(orgAdmin(stranger)));
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('NOT_FOUND');
    }

    const conflicted = await http()
      .post(`/v1/tenders/${tenderId}/open-bids`)
      .set(as(multiMemberActor(owner, [bidder], ['ORGANIZATION_ADMIN'])));
    expect(conflicted.status).toBe(403);
    const row = await runUnscoped('the suite reads the tender', () =>
      w.prisma.client.tender.findFirstOrThrow({ where: { id: tenderId } }),
    );
    expect(row.status).toBe('CLOSED');
  });

  it('answers 422 for a tender not yet closed, 503 when audit-service cannot be reached, and 422 INTEGRITY for a head it never announced', async () => {
    const owner = org('refusals-owner');
    const bidder = org('refusals-bidder');
    await qualify(w, bidder);
    const { tenderId: published } = await publishedForBids(w, owner);
    const early = await http()
      .post(`/v1/tenders/${published}/open-bids`)
      .set(as(orgAdmin(owner)));
    expect(early.status).toBe(422);
    expect(early.body.code).toBe('BUSINESS_RULE_VIOLATION');
    expect(early.body.message).toContain('NOT_CLOSED');

    const { owner: o2, tenderId } = await closed('refusals');
    api.evidence.failure = new Error('connect ECONNREFUSED');
    const down = await http()
      .post(`/v1/tenders/${tenderId}/open-bids`)
      .set(as(orgAdmin(o2)));
    expect(down.status).toBe(503);
    expect(down.body.code).toBe('UPSTREAM_UNAVAILABLE');
    api.evidence.failure = undefined;

    // Proposed, so that it is the evidence that refuses and not the missing second person.
    expect(
      (
        await http()
          .post(`/v1/tenders/${tenderId}/open-bids/proposal`)
          .set(as(orgAdmin(o2)))
      ).status,
    ).toBe(200);
    const honest = await api.evidence.fetchChain(o2, tenderId);
    api.evidence.served.set(tenderId, { ...honest, head: 'f'.repeat(64) });
    const forged = await http()
      .post(`/v1/tenders/${tenderId}/open-bids`)
      .set(as(orgAdmin(o2)));
    expect(forged.status).toBe(422);
    expect(forged.body.message).toContain('INTEGRITY');

    const row = await runUnscoped('the suite reads the tender', () =>
      w.prisma.client.tender.findFirstOrThrow({ where: { id: tenderId } }),
    );
    expect(row).toMatchObject({ status: 'CLOSED', openedAt: null });
  });
});
