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
