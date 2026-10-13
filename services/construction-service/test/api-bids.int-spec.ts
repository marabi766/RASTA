import request from 'supertest';
import { hashRequestBody } from '../src/shared/idempotency';
import {
  reasonsOf,
  actor,
  apiTenant,
  auditorActor,
  orgAdmin,
  startApi,
  type ApiHarness,
} from './api-helpers';
import {
  bidContent,
  bidKey,
  cleanup,
  publishedForBids,
  qualify,
  wire,
  type Wiring,
} from './helpers';

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
  // A fresh Idempotency-Key on every request, as the gateway's clients send one on every unsafe
  // call (a submission requires it, F4); a read ignores it.
  const contractor = (organizationId: string) => ({
    ...as(actor(organizationId, ['CONTRACTOR'])),
    'idempotency-key': bidKey(),
  });

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

  describe('the mandatory Idempotency-Key on a submission (docs/06 § 6.8, construction audit F4)', () => {
    const rowsOf = async (tenderId: string) => ({
      bids: await w.prisma.client.$queryRawUnsafe<{ id: string }[]>(
        'SELECT id FROM bid WHERE tender_id = $1',
        tenderId,
      ),
      receipts: await w.prisma.client.$queryRawUnsafe<{ seq: number }[]>(
        'SELECT seq FROM bid_receipt WHERE tender_id = $1',
        tenderId,
      ),
      submitted: await w.prisma.client.$queryRawUnsafe<{ id: string }[]>(
        `SELECT id FROM outbox_message WHERE aggregate_id = $1 AND event_name = 'BID_SUBMITTED'`,
        tenderId,
      ),
    });
    const submitWith = (
      bidder: string,
      tenderId: string,
      key: string | undefined,
      body: object,
    ) => {
      const headers: Record<string, string> = as(actor(bidder, ['CONTRACTOR']));
      if (key !== undefined) headers['idempotency-key'] = key;
      return http().post(`/v1/tenders/${tenderId}/bids`).set(headers).send(body);
    };

    it('refuses a submission without a key (400) and writes nothing', async () => {
      const { bidder, tenderId } = await setup('key-missing');
      // Missing: required. Blank: refused by the header's own bounds before that.
      for (const [key, code] of [
        [undefined, 'required'],
        ['   ', 'INVALID_HEADER'],
      ] as const) {
        const res = await submitWith(bidder, tenderId, key, { content: bidContent() });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('VALIDATION_FAILED');
        expect(res.body.details).toEqual([
          expect.objectContaining({ path: 'Idempotency-Key', code }),
        ]);
      }
      expect(await rowsOf(tenderId)).toEqual({ bids: [], receipts: [], submitted: [] });
    });

    it('answers a retry with the stored receipt, one bid, one receipt, one BID_SUBMITTED', async () => {
      const { bidder, tenderId } = await setup('key-replay');
      const key = bidKey();
      const body = { content: bidContent('1250000000') };
      const first = await submitWith(bidder, tenderId, key, body);
      expect(first.status).toBe(201);
      const again = await submitWith(bidder, tenderId, key, body);
      expect(again.status).toBe(201);
      expect(again.body).toEqual(first.body);
      const rows = await rowsOf(tenderId);
      expect(rows.bids).toHaveLength(1);
      expect(rows.receipts).toHaveLength(1);
      expect(rows.submitted).toHaveLength(1);

      // The same key with another body, or on another tender, is not a replay.
      const other = await submitWith(bidder, tenderId, key, { content: bidContent('900000000') });
      expect(other.status).toBe(409);
      expect(other.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
      const elsewhere = await setup('key-replay-elsewhere');
      const moved = await submitWith(bidder, elsewhere.tenderId, key, body);
      expect(moved.status).toBe(409);
      expect(moved.body.code).toBe('IDEMPOTENCY_KEY_REUSED');

      // The stored request hash is keyed: not the plain SHA-256 of the request, so a backup does
      // not let a price be guessed (ADR-066 § 1). And nothing of the price is stored with the key.
      const [stored] = await w.prisma.client.$queryRawUnsafe<
        { request_hash: string; response_body: unknown }[]
      >(
        `SELECT request_hash, response_body FROM idempotency_key WHERE organization_id = $1 AND endpoint = $2`,
        bidder,
        'POST /v1/tenders/:id/bids',
      );
      expect(stored?.request_hash).toMatch(/^hmac-v1:[a-z0-9-]+:[0-9a-f]{64}$/);
      expect(stored?.request_hash).not.toContain(hashRequestBody({ id: tenderId, body }));
      expect(JSON.stringify(stored?.response_body)).not.toContain('1250000000');
    });

    it('frees the key when the submission is refused, so the same request can be made again', async () => {
      const { bidder, tenderId } = await setup('key-released');
      const stranger = org('key-released-unknown');
      const key = bidKey();
      // Not eligible (unknown to supplier-service): refused, and the key is not kept.
      const refused = await submitWith(stranger, tenderId, key, { content: bidContent() });
      expect(refused.status).toBe(422);
      await qualify(w, stranger);
      const retried = await submitWith(stranger, tenderId, key, { content: bidContent() });
      expect(retried.status).toBe(201);
      // The tender's own bidder is untouched by another organization's key.
      expect((await submitWith(bidder, tenderId, key, { content: bidContent() })).status).toBe(201);
    });
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
