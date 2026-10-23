import request from 'supertest';
import type { Server } from 'node:http';
import { ulid } from 'ulid';
import { runUnscoped } from '@rasta/nest-common';
import { IdempotencyStore } from '../src/shared/idempotency';
import type { OfferView } from '../src/offer/dto';
import type { MarketplaceEnv } from '../src/config/env';
import { ENV } from '../src/tokens';
import {
  actor,
  apiKey,
  apiTenant,
  buyer,
  startApi,
  supplier,
  type ApiHarness,
} from './api-helpers';
import { asActor, cleanup, wire, type Wiring } from './helpers';

/**
 * A replay is bound to its caller and re-authorized; a stuck claim lapses
 * (#253 round 2, Codex r1 F1 and F2), against the real database and routes.
 *
 * F1: the stored response was keyed by (organization, endpoint, key) and
 * matched on the target and body alone. A platform operator in organization A
 * edits organization B's **draft** offer with key K — platform scope allows it
 * — and a supplier in A who sends the same offer id, body and K received B's
 * private draft from the cache without any owner check. Now the caller is part
 * of the request (another user's identical request is `409
 * IDEMPOTENCY_KEY_REUSED`), and before a stored response is returned the
 * route's current read/owner check runs again: an original caller who has
 * since lost the role gets the live endpoint's answer, not the stored body.
 *
 * F2: when the work failed and the release failed too (the database down),
 * the release's error replaced the work's, and the committed `IN_PROGRESS`
 * claim then blocked identical retries for the whole retention (24 h) although
 * nothing existed. Now the work's error is the answer, and the claim lapses
 * after `MARKETPLACE_IDEMPOTENCY_CLAIM_LEASE_SECONDS`, after which a retry
 * takes it over under a new token — and the stale holder can never complete.
 */
describe('idempotent replays: caller-bound, re-authorized; claims lapse (real database)', () => {
  let harness: ApiHarness;
  let http: Server;
  let store: IdempotencyStore;
  let wiring: Wiring;

  const operatorOrg = apiTenant('RPL-OPS');
  const ownerOrg = apiTenant('RPL-OWN');
  const buyerOrg = apiTenant('RPL-BUY');

  beforeAll(async () => {
    harness = await startApi();
    http = harness.app.getHttpServer() as Server;
    store = harness.app.get(IdempotencyStore);
    wiring = wire(harness.prisma);
  });

  afterAll(async () => {
    await cleanup(harness.prisma, [operatorOrg, ownerOrg, buyerOrg]);
    await harness.close();
  });

  afterEach(() => jest.restoreAllMocks());

  /** One person in the operator's organization, holding the roles given. */
  const operatorUser = `USR-RPL-OPERATOR-${ulid().slice(-8)}`;
  const asOperator = (roles: string[] = ['SYSTEM_ADMIN']) =>
    `Bearer ${actor(operatorOrg, roles, operatorUser)}`;

  async function newProduct(organizationId: string): Promise<string> {
    const response = await request(http)
      .post('/v1/products')
      .set('authorization', `Bearer ${supplier(organizationId)}`)
      .set('idempotency-key', apiKey('rpl-product'))
      .send({
        sku: `RPL-SKU-${Date.now()}-${Math.trunc(Math.random() * 1e6)}`,
        name: 'قطعه یدکی آزمایشی',
        category: 'PARTS',
        kind: 'GOOD',
        unit: 'عدد',
      })
      .expect(201);
    return response.body.id as string;
  }

  /** An offer of `ownerOrg` that nobody else may see: a draft. */
  async function privateDraft(): Promise<{ id: string; price: string }> {
    const price = String(100_000 + Math.trunc(Math.random() * 800_000));
    const response = await request(http)
      .post('/v1/offers')
      .set('authorization', `Bearer ${supplier(ownerOrg)}`)
      .set('idempotency-key', apiKey('rpl-draft'))
      .send({
        productId: await newProduct(ownerOrg),
        unitPriceMinor: price,
        currency: 'IRR',
        availableQuantity: 5,
        leadTimeDays: 3,
        minimumQuantity: 1,
        publish: false,
      })
      .expect(201);
    expect(response.body.status).toBe('DRAFT');
    return { id: response.body.id as string, price };
  }

  const patchOffer = (authorization: string, id: string, body: object, key: string) =>
    request(http)
      .patch(`/v1/offers/${id}`)
      .set('authorization', authorization)
      .set('idempotency-key', key)
      .send(body);

  /**
   * Nothing of the owner's offer in what a refused caller received. The error body echoes the
   * request `path` (the offer's own ULID) and the request's `correlationId`: random ids that can
   * contain `DRAFT` or the price's digits by chance, so the content is looked for without them —
   * and both are pinned exactly, so nothing else can travel in them: the offer's path as asked, and
   * the correlation id the response was sent under.
   */
  function expectNothingOf(
    response: { body: Record<string, unknown>; headers: Record<string, string> },
    draft: { id: string; price: string },
  ) {
    const { path, correlationId, ...answered } = response.body;
    expect(path).toBe(`/v1/offers/${draft.id}`);
    expect(correlationId).toBe(response.headers['x-correlation-id']);
    const text = JSON.stringify(answered);
    expect(text).not.toContain(ownerOrg);
    expect(text).not.toContain(draft.price);
    expect(text).not.toContain('DRAFT');
  }

  describe('F1 — a stored response is never handed to a caller who may not see it', () => {
    it('operator → supplier in the same organization: the supplier gets 409 IDEMPOTENCY_KEY_REUSED, no foreign data', async () => {
      const draft = await privateDraft();
      const key = apiKey('rpl-f1-supplier');
      const body = { availableQuantity: 4 };

      // Platform scope lets the operator edit another organization's offer.
      const operator = await patchOffer(asOperator(), draft.id, body, key).expect(200);
      expect(operator.body).toMatchObject({
        id: draft.id,
        supplierOrganizationId: ownerOrg,
        status: 'DRAFT',
      });

      // The attack: another user of the operator's organization, same key,
      // same offer id, same body.
      const replayAttempt = await patchOffer(
        `Bearer ${supplier(operatorOrg)}`,
        draft.id,
        body,
        key,
      ).expect(409);
      expect(replayAttempt.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
      expectNothingOf(replayAttempt, draft);

      // What that supplier is told live, with a key of its own: the offer is
      // not theirs, and its existence is not confirmed either.
      const live = await patchOffer(
        `Bearer ${supplier(operatorOrg)}`,
        draft.id,
        body,
        apiKey('rpl-f1-live'),
      ).expect(404);
      expectNothingOf(live, draft);
    });

    it('the same user replays as before: the stored response, nothing written again', async () => {
      const draft = await privateDraft();
      const key = apiKey('rpl-f1-same');
      const body = { availableQuantity: 3 };

      const first = await patchOffer(asOperator(), draft.id, body, key).expect(200);
      const versions = () =>
        runUnscoped('the suite counts the events of the offer', () =>
          harness.prisma.client.outboxMessage.count({ where: { aggregateId: draft.id } }),
        );
      const eventsAfterFirst = await versions();

      const replay = await patchOffer(asOperator(), draft.id, body, key).expect(200);
      expect(replay.body).toEqual(first.body);
      expect(await versions()).toBe(eventsAfterFirst);
    });

    it('the original caller who lost the role is refused on replay exactly as the live route refuses', async () => {
      const draft = await privateDraft();
      const key = apiKey('rpl-f1-demoted');
      const body = { availableQuantity: 2 };

      await patchOffer(asOperator(), draft.id, body, key).expect(200);

      // The same person, no longer a platform operator — still a supplier of
      // their own organization, so `@Roles` lets the request in.
      const demoted = asOperator(['SUPPLIER']);
      const replay = await patchOffer(demoted, draft.id, body, key);
      const live = await patchOffer(demoted, draft.id, body, apiKey('rpl-f1-demoted-live'));

      expect(live.status).toBe(404);
      expect(replay.status).toBe(live.status);
      expect(replay.body.code).toBe(live.body.code);
      expectNothingOf(replay, draft);
    });

    it('a created offer is replayed to its creator only while the creator may still manage it', async () => {
      const productId = await newProduct(ownerOrg);
      const key = apiKey('rpl-f1-create');
      const body = {
        productId,
        unitPriceMinor: '420000',
        currency: 'IRR',
        availableQuantity: 5,
        leadTimeDays: 3,
        minimumQuantity: 1,
        publish: false,
      };
      const person = `USR-RPL-CREATOR-${ulid().slice(-8)}`;
      const as = (roles: string[]) => `Bearer ${actor(ownerOrg, roles, person)}`;
      const post = (authorization: string) =>
        request(http)
          .post('/v1/offers')
          .set('authorization', authorization)
          .set('idempotency-key', key)
          .send(body);

      const first = await post(as(['SUPPLIER'])).expect(201);
      expect((await post(as(['SUPPLIER'])).expect(201)).body).toEqual(first.body);

      // Another supplier of the same organization: a different caller.
      const colleague = await post(`Bearer ${supplier(ownerOrg)}`).expect(409);
      expect(colleague.body.code).toBe('IDEMPOTENCY_KEY_REUSED');

      // The creator, now only a buyer: `@Roles` refuses before the store.
      await post(as(['PROCUREMENT_USER'])).expect(403);
    });

    it('an order replay re-runs the order’s read and party check: the stranger’s answer is the live 404', async () => {
      // The guard every order route uses, by the rules as they are now. A
      // caller who is no longer a party gets what the live command answers.
      const offer = await request(http)
        .post('/v1/offers')
        .set('authorization', `Bearer ${supplier(ownerOrg)}`)
        .set('idempotency-key', apiKey('rpl-order-offer'))
        .send({
          productId: await newProduct(ownerOrg),
          unitPriceMinor: '250000',
          currency: 'IRR',
          availableQuantity: 5,
          leadTimeDays: 3,
          minimumQuantity: 1,
          publish: true,
        })
        .expect(201);
      const placed = await request(http)
        .post('/v1/orders')
        .set('authorization', `Bearer ${buyer(buyerOrg)}`)
        .set('idempotency-key', apiKey('rpl-order'))
        .send({ lines: [{ offerId: offer.body.id as string, quantity: 1 }] })
        .expect(201);
      const orderId = placed.body.id as string;

      const asParty = (organizationId: string, roles: string[]) => (fn: () => Promise<void>) =>
        asActor({ organizationId, roles, userId: `USR-RPL-${organizationId}` }, fn);

      // The buyer may see it and is the buyer: every buyer command's guard passes.
      await asParty(buyerOrg, ['PROCUREMENT_USER'])(() =>
        wiring.orders.assertReplayVisible(orderId, 'cancel'),
      );
      // The supplier sees it but is not the buyer: 403, as the live cancel says.
      await expect(
        asParty(ownerOrg, ['SUPPLIER'])(() => wiring.orders.assertReplayVisible(orderId, 'cancel')),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      const liveCancel = await request(http)
        .post(`/v1/orders/${orderId}/cancel`)
        .set('authorization', `Bearer ${actor(ownerOrg, ['ORGANIZATION_ADMIN'])}`)
        .set('idempotency-key', apiKey('rpl-order-cancel'))
        .send({ reason: 'Ordered against the wrong asset by mistake.' })
        .expect(403);
      expect(liveCancel.body.code).toBe('FORBIDDEN');
      // A stranger: 404 for every command, as the live routes answer.
      for (const command of ['place', 'confirm', 'cancel', 'review'] as const) {
        await expect(
          asParty(operatorOrg, ['PROCUREMENT_USER', 'SUPPLIER'])(() =>
            wiring.orders.assertReplayVisible(orderId, command),
          ),
        ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      }
    });
  });

  describe('F2 — a failed release keeps the original error; the claim lapses with its lease', () => {
    const ENDPOINT = 'POST /v1/orders';

    const keyRow = (key: string) =>
      runUnscoped('the suite reads the key the request left', () =>
        harness.prisma.client.idempotencyKey.findUnique({
          where: {
            organizationId_endpoint_key: { organizationId: buyerOrg, endpoint: ENDPOINT, key },
          },
        }),
      );

    /** Moves a claim past its lease, as the clock would. */
    const lapse = (key: string) =>
      runUnscoped('the suite ages the claim past its lease', () =>
        harness.prisma.client.idempotencyKey.updateMany({
          where: { organizationId: buyerOrg, endpoint: ENDPOINT, key },
          data: {
            createdAt: new Date(Date.now() - 5 * 60_000),
            expiresAt: new Date(Date.now() - 1_000),
          },
        }),
      );

    it('answers the work’s own error, keeps the claim only for its lease, then one retry places exactly one order', async () => {
      const offer = await request(http)
        .post('/v1/offers')
        .set('authorization', `Bearer ${supplier(ownerOrg)}`)
        .set('idempotency-key', apiKey('rpl-f2-offer'))
        .send({
          productId: await newProduct(ownerOrg),
          unitPriceMinor: '250000',
          currency: 'IRR',
          availableQuantity: 1,
          leadTimeDays: 3,
          minimumQuantity: 1,
          publish: true,
        })
        .expect(201);
      const offerId = offer.body.id as string;
      const key = apiKey('rpl-f2');
      const place = () =>
        request(http)
          .post('/v1/orders')
          .set('authorization', `Bearer ${buyer(buyerOrg)}`)
          .set('idempotency-key', key)
          .send({ lines: [{ offerId, quantity: 3 }] });
      const ordersUnder = () =>
        runUnscoped('the suite counts the orders one key produced', () =>
          harness.prisma.client.order.count({
            where: { organizationId: buyerOrg, idempotencyKey: key },
          }),
        );

      // The work is refused (only one unit available) and the database then
      // refuses the release too.
      const release = jest
        .spyOn(store, 'release')
        .mockRejectedValueOnce(
          Object.assign(new Error("Can't reach database server"), { code: 'P1001' }),
        );
      const before = Date.now();
      const refused = await place();

      expect(release).toHaveBeenCalledTimes(1);
      // The work's error, not the release's 500.
      expect(refused.status).toBe(422);
      expect(refused.body.code).toBe('BUSINESS_RULE_VIOLATION');
      expect(await ordersUnder()).toBe(0);

      // The claim stayed — but only for its lease, not the 24-hour retention.
      const stuck = await keyRow(key);
      expect(stuck?.state).toBe('IN_PROGRESS');
      const lease =
        harness.app.get<MarketplaceEnv>(ENV).MARKETPLACE_IDEMPOTENCY_CLAIM_LEASE_SECONDS;
      expect(stuck!.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + lease * 1000);
      expect(stuck!.expiresAt.getTime()).toBeGreaterThanOrEqual(before + lease * 1000 - 5_000);

      // Within the lease an identical retry is told to wait.
      const early = await place().expect(409);
      expect(early.body.code).toBe('CONFLICT');
      expect(early.headers['retry-after']).toBe('1');

      // The supplier restocks; the lease lapses; the same retry now runs once.
      await request(http)
        .patch(`/v1/offers/${offerId}`)
        .set('authorization', `Bearer ${supplier(ownerOrg)}`)
        .set('idempotency-key', apiKey('rpl-f2-restock'))
        .send({ availableQuantity: 10 })
        .expect(200);
      await lapse(key);

      const retried = await place().expect(201);
      expect(await ordersUnder()).toBe(1);
      const completed = await keyRow(key);
      expect(completed).toMatchObject({ state: 'COMPLETED', responseBody: retried.body });
      // A completed response lives the retention from now.
      expect(completed!.expiresAt.getTime()).toBeGreaterThan(Date.now() + 23 * 60 * 60 * 1000);

      // And it replays, without a second order.
      expect((await place().expect(201)).body).toEqual(retried.body);
      expect(await ordersUnder()).toBe(1);
    });

    it('a stale holder that finishes after its claim was taken over cannot complete, and frees nothing', async () => {
      // An endpoint with no unique index of its own behind the key, so only
      // the claim token stands between the two executions.
      const productId = await newProduct(ownerOrg);
      const key = apiKey('rpl-f2-stale');
      const offerEndpoint = 'POST /v1/offers';
      const dto = {
        productId,
        unitPriceMinor: '310000',
        currency: 'IRR' as const,
        availableQuantity: 4,
        leadTimeDays: 2,
        minimumQuantity: 1,
        publish: true,
      };
      const asOwner = <T>(fn: () => Promise<T>) =>
        asActor(
          { organizationId: ownerOrg, roles: ['SUPPLIER'], userId: 'USR-RPL-STALE-OWNER' },
          fn,
        );
      const execute = (work: () => Promise<void>) =>
        asOwner(() =>
          wiring.idempotency.run<OfferView>(
            offerEndpoint,
            key,
            dto,
            201,
            async (record) => {
              await work();
              return wiring.catalogue.createOffer(dto, record);
            },
            (stored) => wiring.catalogue.assertOfferReplayVisible(stored.id),
          ),
        );

      // A: claims, then stalls before its transaction.
      let resume!: () => void;
      const stalled = new Promise<void>((resolve) => {
        resume = resolve;
      });
      let claimed!: () => void;
      const hasClaimed = new Promise<void>((resolve) => {
        claimed = resolve;
      });
      const stale = execute(async () => {
        claimed();
        await stalled;
      }).catch((error: unknown) => error);
      await hasClaimed;

      // Its lease lapses; B, the same request, takes the key over and commits.
      await runUnscoped('the suite ages the stalled claim past its lease', () =>
        harness.prisma.client.idempotencyKey.updateMany({
          where: { organizationId: ownerOrg, endpoint: offerEndpoint, key },
          data: {
            createdAt: new Date(Date.now() - 5 * 60_000),
            expiresAt: new Date(Date.now() - 1_000),
          },
        }),
      );
      const winner = await execute(() => Promise.resolve());

      // A wakes up and runs its work to the end: its completion matches no row.
      resume();
      const error = await stale;
      expect(error).toMatchObject({ code: 'CONFLICT', retryAfterSeconds: 1 });

      const [offers, row] = await runUnscoped('the suite reads what the key produced', () =>
        Promise.all([
          harness.prisma.client.offer.findMany({ where: { productId }, select: { id: true } }),
          harness.prisma.client.idempotencyKey.findUnique({
            where: {
              organizationId_endpoint_key: {
                organizationId: ownerOrg,
                endpoint: offerEndpoint,
                key,
              },
            },
          }),
        ]),
      );
      // Exactly one offer — B's — and B's completed response untouched by A's
      // failed completion or its release.
      expect(offers).toEqual([{ id: winner.id }]);
      expect(row).toMatchObject({ state: 'COMPLETED', responseBody: winner });
    });
  });
});
