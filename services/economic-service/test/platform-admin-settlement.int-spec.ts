import request from 'supertest';
import type { Server } from 'node:http';
import { runUnscoped } from '@rasta/nest-common';
import { admin, apiTenant, internalToken, startApi, type ApiHarness } from './api-helpers';
import { cleanup, id } from './helpers';
import { ECONOMIC_EVENTS } from '../src/events/events';

/**
 * A platform administrator acting for organization A settles B's transaction
 * to C (docs/23 D-054; review of #287 r4, F3).
 *
 * Object authorization admits them — `canCommitOrganization` gives platform
 * scope the operator's crossing (docs/09 § 9.3) — but the settlement journal
 * is B's, and the journal header is tenant-scoped: the guard refused the write
 * as an implicit cross-tenant create, the settlement rolled back, and the
 * filter answered a bare 500. Now that one write crosses, on an explicit leave
 * (`access.ts` `settlementBooks`), and nothing else moves:
 *
 *   - the money is on B's and C's books — the settlement row, the journal and
 *     its legs, `SETTLEMENT_COMPLETED`'s tenant;
 *   - the request is A's — its idempotency key, and a replay to the same
 *     person returns the same settlement without posting a second one;
 *   - the record says who acted (`settledBy`, the journal's `postedBy`, the
 *     event's actor) and for whom (`actingOrganizationId` = A).
 *
 * Everyone else is still refused before anything is written. On `main`'s
 * `src` the two trigger cases fail with 500.
 */
describe('a platform administrator settles another organization’s transaction (HTTP)', () => {
  let harness: ApiHarness;
  let http: Server;

  const acting = apiTenant('XSETTLE-A');
  const payer = apiTenant('XSETTLE-B');
  const payee = apiTenant('XSETTLE-C');

  const asPayer = () => `Bearer ${admin(payer)}`;
  const asPayee = () => `Bearer ${admin(payee)}`;
  const asActingAdmin = () => `Bearer ${admin(acting)}`;
  const asPlatform = (role: 'SYSTEM_ADMIN' | 'UNION_ADMIN') =>
    `Bearer ${admin(acting, [role], 'platform')}`;
  /** `admin()`'s platform user id for a token — what `settledBy` records. */
  const userIdOf = (token: string) =>
    (
      JSON.parse(
        Buffer.from(token.replace(/^Bearer test\./, ''), 'base64url').toString('utf8'),
      ) as { rastaUserId: string }
    ).rastaUserId;

  beforeAll(async () => {
    harness = await startApi();
    http = harness.app.getHttpServer() as Server;
    const w = await wallet(asPayer());
    await post(`/v1/wallets/${w.id}/top-up`, asPayer(), id('xsettle-topup'), {
      amountMinor: '1000000',
    }).expect(201);
    await wallet(asPayee());
  });

  afterAll(async () => {
    await cleanup(harness.prisma, [acting, payer, payee]);
    await harness.close();
  });

  async function wallet(token: string) {
    return (await request(http).get('/v1/wallets/me').set('authorization', token).expect(200))
      .body as { id: string; availableBalanceMinor: string };
  }

  function post(path: string, token: string, key: string, body?: object): request.Test {
    const call = request(http).post(path).set('authorization', token).set('idempotency-key', key);
    return body ? call.send(body) : call;
  }

  /** A B→C transaction with funds held, in `state`, made by B itself. */
  async function transaction(state: 'created' | 'held' | 'authorised' | 'disputed') {
    const created = await post('/v1/transactions', asPayer(), id('xsettle-txn'), {
      transactionType: 'MARKETPLACE_ORDER',
      counterpartyOrganizationId: payee,
      grossAmountMinor: '9000',
      currency: 'IRR',
      holdFunds: state !== 'created',
    }).expect(201);
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

  const read = <T>(what: string, fn: () => Promise<T>) =>
    runUnscoped(`the suite reads ${what} across every organization`, fn);

  const settlementsOf = (transactionId: string) =>
    read('the settlement rows', () =>
      harness.prisma.client.settlement.findMany({ where: { transactionId } }),
    );
  const settlementJournalsOf = (transactionId: string) =>
    read('the settlement journals', () =>
      harness.prisma.client.journal.findMany({
        where: { transactionId, journalType: 'SETTLEMENT' },
        include: { entries: true },
      }),
    );
  const statusOf = async (transactionId: string) =>
    (
      await read('the transaction row', () =>
        harness.prisma.client.transaction.findUniqueOrThrow({ where: { id: transactionId } }),
      )
    ).status;
  const idempotencyRecords = (key: string) =>
    read('the idempotency records', () =>
      harness.prisma.client.idempotencyKey.findMany({
        where: { endpoint: 'POST /v1/settlements', key },
      }),
    );
  const settlementEvents = (settlementId: string) =>
    read('the outbox', () =>
      harness.prisma.client.outboxMessage.findMany({
        where: { aggregateId: settlementId, eventName: ECONOMIC_EVENTS.SETTLEMENT_COMPLETED },
      }),
    );

  it.each(['SYSTEM_ADMIN', 'UNION_ADMIN'] as const)(
    '%s acting for A settles B→C: on B’s and C’s books, keyed and attributed to A',
    async (role) => {
      const transactionId = await transaction('authorised');
      const token = asPlatform(role);
      const settler = userIdOf(token);
      const key = id(`xsettle-${role}`);
      const payeeBefore = BigInt((await wallet(asPayee())).availableBalanceMinor);

      const first = await post('/v1/settlements', token, key, { transactionId });
      expect(first.status).toBe(201);
      expect(first.body).toMatchObject({
        transactionId,
        grossAmountMinor: '9000',
        currency: 'IRR',
      });
      const settlementId = first.body.settlementId as string;

      // Whose books: the settlement row and the journal are the payer's.
      const [settlement, ...more] = await settlementsOf(transactionId);
      expect(more).toEqual([]);
      expect(settlement).toMatchObject({
        id: settlementId,
        organizationId: payer,
        payerOrganizationId: payer,
        payeeOrganizationId: payee,
        settledBy: settler,
        actingOrganizationId: acting,
      });

      const [journal, ...otherJournals] = await settlementJournalsOf(transactionId);
      expect(otherJournals).toEqual([]);
      expect(journal).toMatchObject({
        id: first.body.journalId,
        organizationId: payer,
        postedBy: settler,
      });
      // Legs on B (escrow), C (wallet) and — if any commission — the platform;
      // never on the acting organization.
      const legOrganizations = new Set(journal!.entries.map((entry) => entry.organizationId));
      expect(legOrganizations.has(payer)).toBe(true);
      expect(legOrganizations.has(payee)).toBe(true);
      expect(legOrganizations.has(acting)).toBe(false);

      expect(await statusOf(transactionId)).toBe('SETTLED');
      expect(BigInt((await wallet(asPayee())).availableBalanceMinor)).toBe(
        payeeBefore + BigInt(first.body.netAmountMinor as string),
      );

      // The record: who acted (the event's actor), on whose books (its tenant).
      const [event] = await settlementEvents(settlementId);
      expect(event).toMatchObject({ organizationId: payer });
      expect(event!.payload).toMatchObject({
        tenantId: payer,
        actor: { type: 'USER', id: settler },
        payload: { payerOrganizationId: payer, payeeOrganizationId: payee },
      });

      // The request is A's: the key is A's alone, and completed.
      expect(await idempotencyRecords(key)).toEqual([
        expect.objectContaining({ organizationId: acting, state: 'COMPLETED' }),
      ]);

      // A replay to the same person is the same settlement — nothing posted twice.
      const replay = await post('/v1/settlements', token, key, { transactionId });
      expect(replay.status).toBe(201);
      expect(replay.body).toEqual(first.body);
      expect(await settlementsOf(transactionId)).toHaveLength(1);
      expect(await settlementJournalsOf(transactionId)).toHaveLength(1);

      // A fresh key is judged against the settled transaction: 409, not a 500.
      const again = await post('/v1/settlements', token, id('xsettle-again'), { transactionId });
      expect(again.status).toBe(409);
      expect(again.body.code).toBe('INVALID_STATE_TRANSITION');
    },
  );

  it('the payer settling its own transaction records itself as the acting organization', async () => {
    const transactionId = await transaction('authorised');
    await post('/v1/settlements', asPayer(), id('xsettle-own'), { transactionId }).expect(201);
    const [settlement] = await settlementsOf(transactionId);
    expect(settlement).toMatchObject({ organizationId: payer, actingOrganizationId: payer });
  });

  /**
   * The same actor on the other four commands D-054 named. They write nothing
   * tenant-scoped on another organization's behalf (the refund's payer journal
   * already crosses on its own written reason), so they already succeeded;
   * held here so the whole lifecycle stays reachable for the operator.
   */
  it.each([
    {
      name: 'authorise-settlement',
      from: 'held' as const,
      body: undefined,
      to: 'PENDING_SETTLEMENT',
    },
    {
      name: 'dispute',
      from: 'authorised' as const,
      body: { reason: 'Raised by the platform' },
      to: 'DISPUTED',
    },
    {
      name: 'resolve-dispute',
      from: 'disputed' as const,
      body: { resolution: 'Delivery note shown' },
      to: 'PENDING_SETTLEMENT',
    },
    {
      name: 'cancel',
      from: 'created' as const,
      body: { reason: 'Cancelled by the platform' },
      to: 'CANCELLED',
    },
    {
      name: 'refund',
      from: 'held' as const,
      body: { reason: 'Refunded by the platform' },
      to: 'REFUNDED',
    },
  ])('$name by SYSTEM_ADMIN acting for A succeeds on B↔C', async (command) => {
    const transactionId = await transaction(command.from);
    const response = await post(
      `/v1/transactions/${transactionId}/${command.name}`,
      asPlatform('SYSTEM_ADMIN'),
      id(`xsettle-${command.name}`),
      command.body,
    );
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ id: transactionId, status: command.to });
  });

  describe('everyone else still fails closed — nothing settled, nothing posted', () => {
    const user = (token: string) => async () => ({ authorization: token });
    /** The order saga's token, signed for one organization (ADR-035). */
    const saga = (organizationId: string) => async () => ({
      'x-internal-token': await internalToken('marketplace-service', { organizationId }),
    });
    const refusals: {
      name: string;
      headers: () => Promise<Record<string, string>>;
      status: number;
      code: string;
    }[] = [
      {
        name: 'an organization administrator of A (not a party)',
        headers: user(asActingAdmin()),
        status: 404,
        code: 'NOT_FOUND',
      },
      {
        name: 'the payee’s organization administrator (a party, but not the payer)',
        headers: user(asPayee()),
        status: 403,
        code: 'TENANT_MISMATCH',
      },
      {
        name: 'a service whose token names A',
        headers: saga(acting),
        status: 404,
        code: 'NOT_FOUND',
      },
      {
        name: 'a service whose token names the payee',
        headers: saga(payee),
        status: 403,
        code: 'TENANT_MISMATCH',
      },
    ];

    it.each(refusals)('$name is refused', async (refusal) => {
      const transactionId = await transaction('authorised');

      const response = await request(http)
        .post('/v1/settlements')
        .set(await refusal.headers())
        .set('idempotency-key', id('xsettle-refused'))
        .send({ transactionId });
      expect(response.status).toBe(refusal.status);
      expect(response.body.code).toBe(refusal.code);

      expect(await statusOf(transactionId)).toBe('PENDING_SETTLEMENT');
      expect(await settlementsOf(transactionId)).toEqual([]);
      expect(await settlementJournalsOf(transactionId)).toEqual([]);
    });
  });
});
