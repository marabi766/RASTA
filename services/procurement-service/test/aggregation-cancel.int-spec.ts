import { eventEnvelopeSchema } from '@rasta/contracts';
import { demandIdsDigest } from '../src/events/events';
import { actor, buyer, client, key, startApi, TestClock, type ApiHarness } from './api-helpers';
import { cleanup, newOrganizationId, newProductId } from './helpers';

/**
 * Cancelling a READY aggregation (ADR-070 § 2, plan PR 2; Q-119 (4): the one way out for the
 * requesters of a window that ended): READY → CANCELLED with a reason, by a role of
 * PROCUREMENT_RFQ_ISSUER_ROLES of the buyer's own organization, once, with AGGREGATION_CANCELLED in
 * the same transaction. The demands stay as they were: final with the aggregation.
 */
const HOUR = 3_600_000;
const T0 = new Date('2031-07-01T08:00:00.000Z');

describe('cancelling an aggregation', () => {
  let api: ApiHarness;
  const clock = new TestClock();
  const organizations: string[] = [];
  const org = (): string => {
    const id = newOrganizationId();
    organizations.push(id);
    return id;
  };

  beforeAll(async () => {
    api = await startApi(
      {
        PROCUREMENT_AGGREGATION_WINDOW_HOURS: '10',
        PROCUREMENT_AGGREGATION_MIN_QUANTITY: '0',
        PROCUREMENT_AGGREGATION_SHORTFALL_POLICY: 'EXTEND',
      },
      { clock },
    );
  });

  afterAll(async () => {
    await cleanup(organizations);
    await api.close();
  });

  /** A READY aggregation of two demands, ended by a third that opened the next window. */
  async function readyAggregation(organizationId = org()) {
    const as = client(api, buyer(organizationId));
    const productId = newProductId();
    clock.set(T0);
    const first = (await as.submit({ productId, quantity: 2 })).body;
    clock.set(new Date(T0.getTime() + HOUR));
    const second = (await as.submit({ productId, quantity: 3 })).body;
    clock.set(new Date(T0.getTime() + 10 * HOUR));
    const late = (await as.submit({ productId, quantity: 1 })).body;
    clock.set(new Date(T0.getTime() + 12 * HOUR));
    const aggregation = (await as.aggregation(first.aggregationId)).body;
    expect(aggregation.status).toBe('READY');
    return { organizationId, as, aggregation, demands: [first, second], late };
  }

  const events = async (organizationId: string, eventName: string) =>
    (await api.prisma.client.outboxMessage.findMany({ where: { organizationId, eventName } })).map(
      (row) => eventEnvelopeSchema.parse(row.payload).payload as Record<string, unknown>,
    );

  it('READY → CANCELLED by the organization’s administrator, with its reason, one event naming the demands and who — never why', async () => {
    const { organizationId, as, aggregation, demands } = await readyAggregation();
    const admin = actor(organizationId, ['ORGANIZATION_ADMIN'], { rastaUserId: 'USR-CANCELLER' });

    const cancelled = await client(api, admin).cancel(
      aggregation.id,
      aggregation.version,
      'the depot was closed for good',
    );

    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toMatchObject({
      id: aggregation.id,
      status: 'CANCELLED',
      version: aggregation.version + 1,
      cancelledAt: new Date(T0.getTime() + 12 * HOUR).toISOString(),
      cancelReason: 'the depot was closed for good',
      closedAt: aggregation.closedAt,
      totalQuantity: 5,
      demandCount: 2,
    });
    expect((await as.aggregation(aggregation.id)).body).toEqual(cancelled.body);
    const [event, ...more] = await events(organizationId, 'AGGREGATION_CANCELLED');
    expect(more).toEqual([]);
    expect(event).toEqual({
      aggregationId: aggregation.id,
      organizationId,
      productId: aggregation.productId,
      totalQuantity: 5,
      demandCount: 2,
      demandIdsSha256: demandIdsDigest(demands.map((d) => d.id as string)),
      cancelledBy: 'USR-CANCELLER',
      cancelledAt: new Date(T0.getTime() + 12 * HOUR).toISOString(),
    });
    expect(JSON.stringify(event)).not.toContain('depot');

    // Its demands stay as they were, final with it: not withdrawable.
    for (const demand of demands) {
      const read = (await as.demand(demand.id)).body;
      expect(read).toMatchObject({ status: 'SUBMITTED', version: 1 });
      const refused = await as.withdraw(demand.id, 1);
      expect(refused.status).toBe(422);
      expect(refused.body.details).toEqual([
        expect.objectContaining({ code: 'AGGREGATION_WINDOW_ENDED' }),
      ]);
    }
  });

  it('is idempotent under its key, and a second cancellation is refused: one event', async () => {
    const { organizationId, aggregation } = await readyAggregation();
    const admin = client(api, actor(organizationId, ['ORGANIZATION_ADMIN']));
    const k = key();

    const first = await admin.cancel(aggregation.id, aggregation.version, 'not needed any more', k);
    const replay = await admin.cancel(
      aggregation.id,
      aggregation.version,
      'not needed any more',
      k,
    );
    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(first.body);

    const again = await admin.cancel(aggregation.id, first.body.version);
    expect(again.status).toBe(422);
    expect(again.body.details).toEqual([
      { path: 'cancellation', code: 'AGGREGATION_NOT_READY', message: expect.any(String) },
    ]);
    expect(await events(organizationId, 'AGGREGATION_CANCELLED')).toHaveLength(1);
  });

  it('only a READY one: an OPEN window is 422 AGGREGATION_NOT_READY, even past its end; a stale version is 409', async () => {
    const { organizationId, aggregation, late } = await readyAggregation();
    const admin = client(api, actor(organizationId, ['ORGANIZATION_ADMIN']));

    const open = (await admin.aggregation(late.aggregationId)).body;
    expect(open.status).toBe('OPEN');
    clock.set(new Date(T0.getTime() + 30 * HOUR));
    const notReady = await admin.cancel(open.id, open.version);
    expect(notReady.status).toBe(422);
    expect(notReady.body.details).toEqual([
      expect.objectContaining({ code: 'AGGREGATION_NOT_READY' }),
    ]);

    const stale = await admin.cancel(aggregation.id, aggregation.version - 1);
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('OPTIMISTIC_LOCK_FAILED');
    expect((await admin.aggregation(aggregation.id)).body.status).toBe('READY');
    expect(await events(organizationId, 'AGGREGATION_CANCELLED')).toEqual([]);
  });

  // PR-338 r1 F3: Zod counted UTF-16 code units, the CHECK counts characters (`char_length`).
  // Four emoji are eight code units and four characters: they passed `min(8)`, failed the CHECK
  // and answered a 500. Now a 400, the same one a short reason gets. PR-338 r2 F2: the upper bound
  // too — 500 emoji are 1000 code units and a reason the CHECK takes; 501 are a 400 like 501 letters.
  it('counts a reason in characters, as the database does: four emoji are a 400 like any short reason, nothing changed; 501 like any long one; 500 are a cancellation', async () => {
    const { organizationId, as, aggregation, demands, late } = await readyAggregation();
    const admin = client(api, actor(organizationId, ['ORGANIZATION_ADMIN']));
    const short = '\u{1F600}'.repeat(4);
    expect(short).toHaveLength(8);

    const refused = await admin.cancel(aggregation.id, aggregation.version, short);
    const shortAscii = await admin.cancel(aggregation.id, aggregation.version, 'abcdefg');
    expect(refused.status).toBe(400);
    expect(shortAscii.status).toBe(400);
    expect(refused.body.code).toBe(shortAscii.body.code);
    expect(refused.body.details).toEqual(shortAscii.body.details);
    expect((await admin.aggregation(aggregation.id)).body).toMatchObject({
      status: 'READY',
      version: aggregation.version,
    });
    expect(await events(organizationId, 'AGGREGATION_CANCELLED')).toEqual([]);

    // A withdrawal's reason is held by the same rule (its CHECK counts the same way).
    const withdrawn = await as.withdraw(demands[0]!.id as string, 1, short);
    expect(withdrawn.status).toBe(400);

    const over = await admin.cancel(aggregation.id, aggregation.version, '\u{1F600}'.repeat(501));
    const overAscii = await admin.cancel(aggregation.id, aggregation.version, 'a'.repeat(501));
    expect([over.status, overAscii.status]).toEqual([400, 400]);
    expect(over.body.details).toEqual(overAscii.body.details);

    // 300 emoji: a withdrawal of the open window's demand, stored as sent.
    const withdrawal = await as.withdraw(late.id as string, 1, '\u{1F600}'.repeat(300));
    expect(withdrawal.status).toBe(200);
    expect(withdrawal.body.withdrawReason).toBe('\u{1F600}'.repeat(300));

    const long = '\u{1F600}'.repeat(500);
    expect(long).toHaveLength(1000);
    const cancelled = await admin.cancel(aggregation.id, aggregation.version, long);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.cancelReason).toBe(long);
  });

  it.each([
    ['PROCUREMENT_USER (docs/09: rfq:read only)', ['PROCUREMENT_USER'], 403],
    ['AUDITOR', ['AUDITOR'], 403],
    ['AUDITOR beside the issuer role', ['AUDITOR', 'ORGANIZATION_ADMIN'], 403],
    ['SYSTEM_ADMIN beside the issuer role', ['SYSTEM_ADMIN', 'ORGANIZATION_ADMIN'], 403],
    ['FLEET_MANAGER', ['FLEET_MANAGER'], 403],
  ])(
    'refuses %s of the buyer’s own organization, nothing changed',
    async (_label, roles, status) => {
      const { organizationId, aggregation } = await readyAggregation();

      const refused = await client(api, actor(organizationId, roles)).cancel(
        aggregation.id,
        aggregation.version,
      );

      expect(refused.status).toBe(status);
      expect(
        (await client(api, buyer(organizationId)).aggregation(aggregation.id)).body,
      ).toMatchObject({
        status: 'READY',
        version: aggregation.version,
      });
      expect(await events(organizationId, 'AGGREGATION_CANCELLED')).toEqual([]);
    },
  );

  it('another organization’s administrator: 404, the same as a missing id', async () => {
    const { organizationId, aggregation } = await readyAggregation();
    const stranger = client(api, actor(org(), ['ORGANIZATION_ADMIN']));

    const refused = await stranger.cancel(aggregation.id, aggregation.version);
    const missing = await stranger.cancel('AGG_01JAAAAAAAAAAAAAAAAAAAAAAA', 1);

    expect([refused.status, missing.status]).toEqual([404, 404]);
    expect(refused.body.code).toBe('NOT_FOUND');
    expect(await events(organizationId, 'AGGREGATION_CANCELLED')).toEqual([]);
  });

  it('follows PROCUREMENT_RFQ_ISSUER_ROLES: configured to PROCUREMENT_USER, the administrator is refused', async () => {
    const configured = await startApi(
      {
        PROCUREMENT_AGGREGATION_WINDOW_HOURS: '10',
        PROCUREMENT_RFQ_ISSUER_ROLES: 'PROCUREMENT_USER',
      },
      { clock },
    );
    try {
      const organizationId = org();
      const as = client(configured, buyer(organizationId));
      const productId = newProductId();
      clock.set(T0);
      const first = (await as.submit({ productId, quantity: 1 })).body;
      clock.set(new Date(T0.getTime() + 10 * HOUR));
      await as.submit({ productId, quantity: 1 });
      const ready = (await as.aggregation(first.aggregationId)).body;

      const admin = client(configured, actor(organizationId, ['ORGANIZATION_ADMIN']));
      expect((await admin.cancel(ready.id, ready.version)).status).toBe(403);
      expect((await as.cancel(ready.id, ready.version)).status).toBe(200);
    } finally {
      await configured.close();
    }
  });
});
