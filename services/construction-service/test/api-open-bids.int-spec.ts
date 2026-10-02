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

  it('is closed without a token and to every role the configuration did not grant', async () => {
    const a = org('closed');
    const routes: [string, string, object | undefined][] = [
      ['post', '/v1/tenders/TND_x/open-bids', {}],
      ['post', '/v1/tenders/TND_x/open-bids/proposal', {}],
      ['get', '/v1/tenders/TND_x/bids', undefined],
      ['get', '/v1/tenders/TND_x/bids/BID_x', undefined],
      ['get', '/v1/tenders/TND_x/bid-access-log', undefined],
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
      // The platform administrator has no access to a bid through the API, super-role or not.
      expect((await call(actor(a, ['SYSTEM_ADMIN']))).status).toBe(403);
      // ... and not made harmless by also holding the owner's role.
      expect((await call(actor(a, ['SYSTEM_ADMIN', 'ORGANIZATION_ADMIN']))).status).toBe(403);
      expect((await call(actor(a, ['CONTRACTOR', 'ORGANIZATION_ADMIN']))).status).toBe(403);
    }
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
