import request from 'supertest';
import type { Server } from 'node:http';
import { runUnscoped } from '@rasta/nest-common';
import { admin, apiTenant, bearer, startApi, type ApiHarness } from './api-helpers';
import { cleanup, id } from './helpers';

/**
 * A stored idempotent answer goes only to the actor who made it, and only
 * while that actor may still reach its object (review of #287, finding 1;
 * docs/23 D-054).
 *
 * The scenario the review reproduced: a `SYSTEM_ADMIN` acting in organization
 * A authorises a transaction between B and C with key K. The record is A's —
 * keys are scoped to the acting organization — and it held B and C's
 * transaction. An `ORGANIZATION_ADMIN` of A who sent the same target and K was
 * handed it, where the same request with a fresh key is `NOT_FOUND`. Now:
 *
 *   - the same key from another actor is `409 IDEMPOTENCY_KEY_REUSED`, with
 *     nothing of the record — never a replay;
 *   - the same actor gets the stored answer back, unchanged;
 *   - the same actor who has since lost the access gets the `NOT_FOUND` a
 *     fresh request gets: the endpoint's object checks run again before any
 *     stored answer leaves (the transition is not run again);
 *   - a record from before actors were bound (`actor_hash` NULL) is answered
 *     through those checks alone.
 */
describe('who an idempotent economic answer is replayed to (HTTP)', () => {
  let harness: ApiHarness;
  let http: Server;

  /** The organization the platform administrator acts in, and an admin of it. */
  const acting = apiTenant('REPLAY-ACTING');
  const payer = apiTenant('REPLAY-B');
  const payee = apiTenant('REPLAY-C');

  /** One person, by subject and platform user id — the record binds both. */
  const platformPerson = (roles: string[]) =>
    `Bearer ${bearer({
      sub: `sub-replay-platform-${acting}`,
      rastaUserId: `USR-APITEST-REPLAY-PLATFORM`,
      organizationId: acting,
      organizationIds: [acting],
      roles,
    })}`;
  const asPlatformAdmin = () => platformPerson(['SYSTEM_ADMIN']);
  /** The same person, their platform role revoked: an admin of A only. */
  const asSamePersonDemoted = () => platformPerson(['ORGANIZATION_ADMIN']);
  const asOrganizationAdmin = () => `Bearer ${admin(acting)}`;
  const asPayer = () => `Bearer ${admin(payer)}`;

  beforeAll(async () => {
    harness = await startApi();
    http = harness.app.getHttpServer() as Server;
    const w = await wallet(asPayer());
    await request(http)
      .post(`/v1/wallets/${w.id}/top-up`)
      .set('authorization', asPayer())
      .set('idempotency-key', id('replay-topup'))
      .send({ amountMinor: '500000' })
      .expect(201);
    await wallet(`Bearer ${admin(payee)}`);
  });

  afterAll(async () => {
    await cleanup(harness.prisma, [acting, payer, payee]);
    await harness.close();
  });

  async function wallet(token: string) {
    return (await request(http).get('/v1/wallets/me').set('authorization', token).expect(200))
      .body as { id: string };
  }

  /** A B→C transaction in `state`, made by B itself. */
  async function transaction(state: 'created' | 'held' | 'authorised' | 'disputed') {
    const created = await request(http)
      .post('/v1/transactions')
      .set('authorization', asPayer())
      .set('idempotency-key', id('replay-txn'))
      .send({
        transactionType: 'MARKETPLACE_ORDER',
        counterpartyOrganizationId: payee,
        grossAmountMinor: '7000',
        currency: 'IRR',
        holdFunds: state !== 'created',
      })
      .expect(201);
    const transactionId = created.body.id as string;
    if (state === 'authorised' || state === 'disputed') {
      await post(
        `/v1/transactions/${transactionId}/authorise-settlement`,
        asPayer(),
        id('a'),
      ).expect(200);
    }
    if (state === 'disputed') {
      await post(`/v1/transactions/${transactionId}/dispute`, asPayer(), id('d'), {
        reason: 'The goods arrived damaged',
      }).expect(200);
    }
    return transactionId;
  }

  function post(path: string, token: string, key: string, body?: object): request.Test {
    const call = request(http).post(path).set('authorization', token).set('idempotency-key', key);
    return body ? call.send(body) : call;
  }

  const record = (endpoint: string, key: string) =>
    runUnscoped('the suite reads the idempotency record', () =>
      harness.prisma.client.idempotencyKey.findFirst({
        where: { organizationId: acting, endpoint, key },
      }),
    );

  /**
   * Nothing of B and C's transaction may be in a refusal: not the parties,
   * not the money. (A `NOT_FOUND` may name the id the caller itself sent.)
   */
  function disclosesNothing(response: request.Response): void {
    const text = JSON.stringify(response.body);
    expect(text).not.toContain(payer);
    expect(text).not.toContain(payee);
    expect(text).not.toContain('grossAmountMinor');
    expect(text).not.toContain('legs');
  }

  const commands = [
    {
      name: 'authorise-settlement',
      from: 'held' as const,
      path: (t: string) => `/v1/transactions/${t}/authorise-settlement`,
      endpoint: 'POST /v1/transactions/:id/authorise-settlement',
      body: undefined,
      status: 200,
    },
    {
      name: 'dispute',
      from: 'authorised' as const,
      path: (t: string) => `/v1/transactions/${t}/dispute`,
      endpoint: 'POST /v1/transactions/:id/dispute',
      body: { reason: 'Raised by the platform on the buyer’s behalf' },
      status: 200,
    },
    {
      name: 'cancel',
      from: 'created' as const,
      path: (t: string) => `/v1/transactions/${t}/cancel`,
      endpoint: 'POST /v1/transactions/:id/cancel',
      body: { reason: 'Cancelled by the platform' },
      status: 200,
    },
    {
      name: 'refund',
      from: 'held' as const,
      path: (t: string) => `/v1/transactions/${t}/refund`,
      endpoint: 'POST /v1/transactions/:id/refund',
      body: { reason: 'Refunded by the platform' },
      status: 200,
    },
  ];

  it.each(commands)(
    '$name: another actor with the same key is refused as a reused key, never answered',
    async (command) => {
      const transactionId = await transaction(command.from);
      const key = id(`replay-${command.name}`);
      const body = command.body;

      const first = await post(command.path(transactionId), asPlatformAdmin(), key, body);
      expect(first.status).toBe(command.status);
      expect(JSON.stringify(first.body)).toContain(transactionId);

      // A fresh key from the organization admin: the transaction is not theirs.
      const fresh = await post(command.path(transactionId), asOrganizationAdmin(), id('f'), body);
      expect(fresh.status).toBe(404);
      expect(fresh.body.code).toBe('NOT_FOUND');

      // The same target and K: before the fix, B and C's transaction (200).
      const replay = await post(command.path(transactionId), asOrganizationAdmin(), key, body);
      expect(replay.status).toBe(409);
      expect(replay.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
      disclosesNothing(replay);
    },
  );

  it.each(commands)(
    '$name: the same actor gets the stored answer back, unchanged',
    async (command) => {
      const transactionId = await transaction(command.from);
      const key = id(`same-${command.name}`);
      const body = command.body;

      const first = await post(command.path(transactionId), asPlatformAdmin(), key, body);
      expect(first.status).toBe(command.status);
      const replay = await post(command.path(transactionId), asPlatformAdmin(), key, body);
      expect(replay.status).toBe(command.status);
      expect(replay.body).toEqual(first.body);
      expect(await record(command.endpoint, key)).toMatchObject({
        state: 'COMPLETED',
        actorHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
    },
  );

  it.each(commands)(
    '$name: the same actor, their access revoked since, gets the NOT_FOUND a fresh request gets',
    async (command) => {
      const transactionId = await transaction(command.from);
      const key = id(`revoked-${command.name}`);
      const body = command.body;

      await post(command.path(transactionId), asPlatformAdmin(), key, body).expect(command.status);

      const fresh = await post(command.path(transactionId), asSamePersonDemoted(), id('f'), body);
      expect(fresh.status).toBe(404);
      const replay = await post(command.path(transactionId), asSamePersonDemoted(), key, body);
      expect(replay.status).toBe(404);
      expect(replay.body.code).toBe(fresh.body.code);
      disclosesNothing(replay);

      // The record is untouched, and still answers its actor once restored.
      const restored = await post(command.path(transactionId), asPlatformAdmin(), key, body);
      expect(restored.status).toBe(command.status);
      expect(JSON.stringify(restored.body)).toContain(transactionId);
    },
  );

  it('resolve-dispute (platform roles only): another platform person is refused, the same one is answered', async () => {
    // An organization admin never reaches this route's store — the role guard
    // refuses them first, fresh or replayed — so the actor who might be
    // answered here is another platform administrator of A.
    const transactionId = await transaction('disputed');
    const key = id('replay-resolve');
    const path = `/v1/transactions/${transactionId}/resolve-dispute`;
    const body = { resolution: 'The supplier showed the delivery note' };
    const anotherPlatformAdmin = `Bearer ${admin(acting, ['UNION_ADMIN'], 'another')}`;

    const first = await post(path, asPlatformAdmin(), key, body).expect(200);

    const other = await post(path, anotherPlatformAdmin, key, body);
    expect(other.status).toBe(409);
    expect(other.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    disclosesNothing(other);

    const replay = await post(path, asPlatformAdmin(), key, body).expect(200);
    expect(replay.body).toEqual(first.body);

    // Demoted, the same person is refused exactly as a fresh request.
    const fresh = await post(path, asSamePersonDemoted(), id('f'), body);
    const demoted = await post(path, asSamePersonDemoted(), key, body);
    expect(fresh.status).toBe(403);
    expect(demoted.status).toBe(fresh.status);
    expect(demoted.body.code).toBe(fresh.body.code);
    disclosesNothing(demoted);
  });

  it('settlement: another person in the paying organization is refused, the settler is answered', async () => {
    // Settled by a platform administrator acting for the payer: a settlement
    // posts the payer's journals, which a platform administrator acting for a
    // non-party organization cannot (a cross-tenant write, refused before any
    // answer is stored). Everyone acting for B is a party, so here the actor
    // binding is the whole of the protection; the replay guard re-runs the
    // settlement's own check (visible + may commit B) all the same.
    const transactionId = await transaction('authorised');
    const key = id('replay-settle');
    const settler = `Bearer ${admin(payer, ['SYSTEM_ADMIN'], 'settler')}`;
    const settle = (token: string) => post('/v1/settlements', token, key, { transactionId });

    const first = await settle(settler).expect(201);
    expect(first.body).toMatchObject({ transactionId });

    const other = await settle(asPayer());
    expect(other.status).toBe(409);
    expect(other.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(JSON.stringify(other.body)).not.toContain(first.body.settlementId as string);

    const replay = await settle(settler).expect(201);
    expect(replay.body).toEqual(first.body);
  });

  it('a record from before actors were bound is answered only through the object checks', async () => {
    const transactionId = await transaction('held');
    const key = id('legacy');
    const path = `/v1/transactions/${transactionId}/authorise-settlement`;
    const endpoint = 'POST /v1/transactions/:id/authorise-settlement';

    await post(path, asPlatformAdmin(), key).expect(200);
    await runUnscoped('the suite makes the record one written before actor binding', () =>
      harness.prisma.client.idempotencyKey.updateMany({
        where: { organizationId: acting, endpoint, key },
        data: { actorHash: null },
      }),
    );

    // No actor to compare: the organization admin passes the binding, and the
    // object check refuses them exactly as a fresh request.
    const replay = await post(path, asOrganizationAdmin(), key);
    expect(replay.status).toBe(404);
    expect(replay.body.code).toBe('NOT_FOUND');
    disclosesNothing(replay);

    // Someone who may see the transaction still gets the replay.
    const platform = await post(path, asPlatformAdmin(), key).expect(200);
    expect(platform.body).toMatchObject({ id: transactionId, status: 'PENDING_SETTLEMENT' });
  });

  it('creating a transaction: the same actor replays it, another actor is refused', async () => {
    const key = id('replay-create');
    const body = {
      transactionType: 'MARKETPLACE_ORDER',
      counterpartyOrganizationId: payee,
      grossAmountMinor: '3000',
      currency: 'IRR',
    };
    const create = (token: string) =>
      request(http)
        .post('/v1/transactions')
        .set('authorization', token)
        .set('idempotency-key', key)
        .send(body);

    const first = await create(asOrganizationAdmin()).expect(201);
    const replay = await create(asOrganizationAdmin()).expect(201);
    expect(replay.body).toEqual(first.body);

    const other = await create(asPlatformAdmin()).expect(409);
    expect(other.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    disclosesNothing(other);
  });
});
