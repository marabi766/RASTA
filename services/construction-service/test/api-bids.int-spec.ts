import request from 'supertest';
import {
  reasonsOf,
  actor,
  apiTenant,
  auditorActor,
  orgAdmin,
  startApi,
  type ApiHarness,
} from './api-helpers';
import { bidContent, cleanup, publishedForBids, qualify, wire, type Wiring } from './helpers';

/**
 * The bidder's HTTP surface through the real `AppModule`: closed without a token and
 * to every role but `CONTRACTOR`, the real status codes, strict bodies, `404` for a
 * tender the caller may not see, and no content in any answer.
 */

describe('bids API', () => {
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
  const contractor = (organizationId: string) => as(actor(organizationId, ['CONTRACTOR']));

  const setup = async (label: string, visibility: 'PUBLIC' | 'RESTRICTED' = 'PUBLIC') => {
    const owner = org(`${label}-owner`);
    const bidder = org(`${label}-bidder`);
    await qualify(w, bidder);
    const { tenderId } = await publishedForBids(w, owner, {
      visibility,
      invited: visibility === 'RESTRICTED' ? [bidder] : [],
    });
    return { owner, bidder, tenderId };
  };

  beforeAll(async () => {
    api = await startApi();
    w = wire();
  });

  afterAll(async () => {
    await cleanup(api.prisma, organizations);
    await w.close();
    await api.close();
  });

  it('is closed without a token and to every role but CONTRACTOR, the platform administrator and the oversight role included', async () => {
    const a = org('closed');
    const routes: [string, string, object][] = [
      ['get', '/v1/open-tenders', {}],
      ['get', '/v1/open-tenders/TND_x', {}],
      ['post', '/v1/tenders/TND_x/bids', { content: bidContent() }],
      ['get', '/v1/tenders/TND_x/bids/mine', {}],
      ['put', '/v1/tenders/TND_x/bids/BID_x', { expectedRevision: 1, content: bidContent() }],
      ['post', '/v1/tenders/TND_x/bids/BID_x/withdraw', { expectedRevision: 1 }],
    ];
    for (const [method, path, body] of routes) {
      const call = (token?: string) => {
        const req = (http() as unknown as Record<string, (p: string) => request.Test>)[method]!(
          path,
        );
        return (token ? req.set(as(token)) : req).send(body);
      };
      expect((await call()).status).toBe(401);
      expect((await call(auditorActor(a))).status).toBe(403);
      expect((await call(orgAdmin(a))).status).toBe(403);
      expect((await call(actor(a, ['SYSTEM_ADMIN']))).status).toBe(403);
    }
  });

  it('submits (201), reads its own receipt (200), replaces (200) and withdraws (200), never returning content', async () => {
    const { bidder, tenderId } = await setup('flow');

    const submitted = await http()
      .post(`/v1/tenders/${tenderId}/bids`)
      .set(contractor(bidder))
      .send({ content: bidContent() });
    expect(submitted.status).toBe(201);
    expect(submitted.body).toMatchObject({ status: 'SUBMITTED', revision: 1, tenderId });
    const bidId = submitted.body.bidId as string;

    const mine = await http().get(`/v1/tenders/${tenderId}/bids/mine`).set(contractor(bidder));
    expect(mine.status).toBe(200);
    expect(mine.body).toEqual(submitted.body);

    const replaced = await http()
      .put(`/v1/tenders/${tenderId}/bids/${bidId}`)
      .set(contractor(bidder))
      .send({ expectedRevision: 1, content: bidContent('900000000') });
    expect(replaced.status).toBe(200);
    expect(replaced.body.revision).toBe(2);

    const stale = await http()
      .put(`/v1/tenders/${tenderId}/bids/${bidId}`)
      .set(contractor(bidder))
      .send({ expectedRevision: 1, content: bidContent() });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('OPTIMISTIC_LOCK_FAILED');

    const withdrawn = await http()
      .post(`/v1/tenders/${tenderId}/bids/${bidId}/withdraw`)
      .set(contractor(bidder))
      .send({ expectedRevision: 2 });
    expect(withdrawn.status).toBe(200);
    expect(withdrawn.body.status).toBe('WITHDRAWN');

    for (const body of [submitted.body, mine.body, replaced.body, withdrawn.body]) {
      expect(JSON.stringify(body)).not.toMatch(/1250000000|900000000|Mobilisation|Licence 1234/);
    }
  });

  it('answers 409 to a second bid and 422 to an ineligible organization, naming every reason', async () => {
    const { bidder, tenderId } = await setup('refusals');
    const first = await http()
      .post(`/v1/tenders/${tenderId}/bids`)
      .set(contractor(bidder))
      .send({ content: bidContent() });
    expect(first.status).toBe(201);
    const again = await http()
      .post(`/v1/tenders/${tenderId}/bids`)
      .set(contractor(bidder))
      .send({ content: bidContent() });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('ALREADY_EXISTS');

    const unknown = org('refusals-unknown');
    const refused = await http()
      .post(`/v1/tenders/${tenderId}/bids`)
      .set(contractor(unknown))
      .send({ content: bidContent() });
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe('BUSINESS_RULE_VIOLATION');
    expect(refused.body.message).toContain('BIDDER_NOT_ELIGIBLE');
    expect(reasonsOf(refused.body)).toEqual(['bid:BIDDER_NOT_ELIGIBLE']);
    expect(refused.body.details).toEqual([
      { path: 'bid', code: 'BIDDER_NOT_ELIGIBLE', message: 'Bid refused: BIDDER_NOT_ELIGIBLE' },
    ]);
  });

  it('refuses bodies that decide what they may not, and a price that is not whole minor units', async () => {
    const { bidder, tenderId } = await setup('strict');
    const post = (body: object) =>
      http().post(`/v1/tenders/${tenderId}/bids`).set(contractor(bidder)).send(body);

    for (const body of [
      {},
      { content: bidContent(), status: 'OPENED' },
      { content: bidContent(), bidderOrganizationId: 'ORG_x' },
      { content: bidContent(), revision: 9 },
      { content: { ...bidContent(), priceMinor: 12.5 } },
      { content: { ...bidContent(), priceMinor: '12.5' } },
      { content: { ...bidContent(), priceMinor: '-1' } },
      { content: { ...bidContent(), priceMinor: '99999999999999999999' } },
      { content: { ...bidContent(), receipt: 'x' } },
      {
        content: {
          ...bidContent(),
          answers: [
            { criterionCode: 'PRICE', response: 'a' },
            { criterionCode: 'PRICE', response: 'b' },
          ],
        },
      },
    ]) {
      expect((await post(body)).status).toBe(400);
    }
    expect(
      (
        await http()
          .put(`/v1/tenders/${tenderId}/bids/BID_x`)
          .set(contractor(bidder))
          .send({ content: bidContent() })
      ).status,
    ).toBe(400);
  });

  it('answers 404, never 403, for a tender the caller may not bid on, and for a stranger’s bid', async () => {
    const { bidder, tenderId } = await setup('hidden', 'RESTRICTED');
    const outsider = org('hidden-outsider');
    await qualify(w, outsider);
    const own = await http()
      .post(`/v1/tenders/${tenderId}/bids`)
      .set(contractor(bidder))
      .send({ content: bidContent() });
    expect(own.status).toBe(201);

    for (const [method, path, body] of [
      ['get', `/v1/open-tenders/${tenderId}`, {}],
      ['post', `/v1/tenders/${tenderId}/bids`, { content: bidContent() }],
      [
        'put',
        `/v1/tenders/${tenderId}/bids/${own.body.bidId}`,
        { expectedRevision: 1, content: bidContent() },
      ],
      ['post', `/v1/tenders/${tenderId}/bids/${own.body.bidId}/withdraw`, { expectedRevision: 1 }],
      ['get', `/v1/tenders/${tenderId}/bids/mine`, {}],
    ] as [string, string, object][]) {
      const req = (http() as unknown as Record<string, (p: string) => request.Test>)[method]!(path);
      const res = await req.set(contractor(outsider)).send(body);
      expect([method, path, res.status]).toEqual([method, path, 404]);
    }
  });

  it('lists the tenders it may bid on and shows one with its frozen criteria', async () => {
    const { bidder, tenderId } = await setup('open');

    const list = await http().get('/v1/open-tenders?limit=100').set(contractor(bidder));
    expect(list.status).toBe(200);
    expect(list.body.items.map((item: { id: string }) => item.id)).toContain(tenderId);

    const one = await http().get(`/v1/open-tenders/${tenderId}`).set(contractor(bidder));
    expect(one.status).toBe(200);
    expect(one.body.criteria.map((c: { code: string }) => c.code)).toEqual(['PRICE', 'LICENCE']);
    expect(one.body).not.toHaveProperty('organizationId');
    expect(one.body).not.toHaveProperty('createdBy');
  });
});
