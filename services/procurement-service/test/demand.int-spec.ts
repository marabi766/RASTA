import { eventEnvelopeSchema } from '@rasta/contracts';
import { validateProcurementPayload, type ProcurementEventName } from '../src/events/events';
import { actor, buyer, client, key, startApi, type ApiHarness } from './api-helpers';
import { cleanup, newOrganizationId, newProductId } from './helpers';

/**
 * A demand's life through the real API and database (ADR-070 § 2, COM-007 PR 1): it opens or joins
 * the window of its (organization, product), it is withdrawn with a reason while that window is
 * open, and every change is one transaction with its event — so with its audit record, which
 * audit-service makes of every event on the topic. The window's end is `window.int-spec.ts`.
 */
describe('demand requests', () => {
  let api: ApiHarness;
  const organizations: string[] = [];
  const org = (): string => {
    const id = newOrganizationId();
    organizations.push(id);
    return id;
  };

  /** The events this organization's commands wrote, in commit order, as published. */
  const eventsOf = async (organizationId: string) => {
    const rows = await api.prisma.client.outboxMessage.findMany({
      where: { organizationId },
      orderBy: [{ createdAt: 'asc' }, { streamSeq: 'asc' }],
    });
    return rows.map((row) => {
      const envelope = eventEnvelopeSchema.parse(row.payload);
      return {
        name: envelope.eventName as ProcurementEventName,
        payload: validateProcurementPayload(
          envelope.eventName as ProcurementEventName,
          envelope.payload,
        ) as Record<string, unknown>,
        partitionKey: row.partitionKey,
        tenantId: envelope.tenantId,
      };
    });
  };

  beforeAll(async () => {
    api = await startApi({
      PROCUREMENT_AGGREGATION_WINDOW_HOURS: '168',
      PROCUREMENT_AGGREGATION_MIN_QUANTITY: '0',
      PROCUREMENT_AGGREGATION_SHORTFALL_POLICY: 'EXTEND',
    });
  });

  afterAll(async () => {
    await cleanup(organizations);
    await api.close();
  });

  it('opens a window with the first demand, with the settings snapshot, and announces both', async () => {
    const a = org();
    const productId = newProductId();
    const response = await client(api, buyer(a)).submit({
      productId,
      quantity: 7,
      note: 'for the depot',
    });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      organizationId: a,
      productId,
      quantity: 7,
      status: 'SUBMITTED',
      note: 'for the depot',
      withdrawnAt: null,
      version: 1,
    });
    const aggregation = await client(api, buyer(a)).aggregation(response.body.aggregationId);
    expect(aggregation.status).toBe(200);
    expect(aggregation.body).toMatchObject({
      status: 'OPEN',
      productId,
      totalQuantity: 7,
      demandCount: 1,
      extensionCount: 0,
      setting: {
        windowHours: 168,
        minQuantity: 0,
        shortfallPolicy: 'EXTEND',
        settingVersion: null,
      },
      closedAt: null,
      rfqId: null,
    });
    expect(
      new Date(aggregation.body.closesAt).getTime() - new Date(aggregation.body.openedAt).getTime(),
    ).toBe(168 * 3_600_000);
    // The demand was registered at the window's opening instant or after it, by the same clock.
    expect(new Date(response.body.submittedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(aggregation.body.openedAt).getTime(),
    );

    const events = await eventsOf(a);
    expect(events).toEqual([
      {
        name: 'DEMAND_SUBMITTED',
        partitionKey: response.body.aggregationId,
        tenantId: a,
        payload: {
          demandId: response.body.id,
          aggregationId: response.body.aggregationId,
          organizationId: a,
          productId,
          quantity: 7,
          aggregationOpened: true,
          closesAt: aggregation.body.closesAt,
          submittedBy: expect.any(String),
          submittedAt: response.body.submittedAt,
        },
      },
    ]);
    // The buyer's free text stays in the database: on no event.
    const raw = await api.prisma.client.outboxMessage.findMany({ where: { organizationId: a } });
    expect(JSON.stringify(raw.map((row) => [row.payload, row.headers]))).not.toContain(
      'for the depot',
    );
  });

  it('joins the open window of the same product, and only of the same product', async () => {
    const a = org();
    const productId = newProductId();
    const first = await client(api, buyer(a)).submit({ productId, quantity: 2 });
    const second = await client(api, actor(a, ['ORGANIZATION_ADMIN'])).submit({
      productId,
      quantity: 3,
    });
    const other = await client(api, buyer(a)).submit({ productId: newProductId(), quantity: 1 });

    expect([first.status, second.status, other.status]).toEqual([201, 201, 201]);
    expect(second.body.aggregationId).toBe(first.body.aggregationId);
    expect(other.body.aggregationId).not.toBe(first.body.aggregationId);
    const aggregation = await client(api, buyer(a)).aggregation(first.body.aggregationId);
    expect(aggregation.body).toMatchObject({ totalQuantity: 5, demandCount: 2, version: 3 });
    const joined = (await eventsOf(a)).filter(
      (e) => e.payload.aggregationId === first.body.aggregationId,
    );
    expect(joined.map((e) => [e.name, e.payload.aggregationOpened])).toEqual([
      ['DEMAND_SUBMITTED', true],
      ['DEMAND_SUBMITTED', false],
    ]);
  });

  it('withdraws a demand with its reason: the window keeps the rest, and the event carries no reason', async () => {
    const a = org();
    const productId = newProductId();
    const kept = await client(api, buyer(a)).submit({ productId, quantity: 4 });
    const leaving = await client(api, buyer(a)).submit({ productId, quantity: 6 });

    const withdrawn = await client(api, buyer(a)).withdraw(
      leaving.body.id,
      1,
      'ordered elsewhere already',
    );
    expect(withdrawn.status).toBe(200);
    expect(withdrawn.body).toMatchObject({
      id: leaving.body.id,
      status: 'WITHDRAWN',
      withdrawReason: 'ordered elsewhere already',
      version: 2,
    });
    expect(withdrawn.body.withdrawnAt).toEqual(expect.any(String));
    const aggregation = await client(api, buyer(a)).aggregation(kept.body.aggregationId);
    expect(aggregation.body).toMatchObject({ status: 'OPEN', totalQuantity: 4, demandCount: 1 });

    const last = (await eventsOf(a)).at(-1);
    expect(last).toEqual({
      name: 'DEMAND_WITHDRAWN',
      partitionKey: kept.body.aggregationId,
      tenantId: a,
      payload: {
        demandId: leaving.body.id,
        aggregationId: kept.body.aggregationId,
        organizationId: a,
        productId,
        quantity: 6,
        withdrawnBy: expect.any(String),
        withdrawnAt: withdrawn.body.withdrawnAt,
      },
    });
    expect(JSON.stringify(last)).not.toContain('ordered elsewhere');
  });

  it('refuses a second withdrawal (422 DEMAND_NOT_SUBMITTED) and a stale version (409), changing nothing', async () => {
    const a = org();
    const demand = await client(api, buyer(a)).submit({ quantity: 3 });

    const stale = await client(api, buyer(a)).withdraw(demand.body.id, 2);
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('OPTIMISTIC_LOCK_FAILED');

    expect((await client(api, buyer(a)).withdraw(demand.body.id, 1)).status).toBe(200);
    const again = await client(api, buyer(a)).withdraw(demand.body.id, 2);
    expect(again.status).toBe(422);
    expect(again.body).toMatchObject({
      code: 'BUSINESS_RULE_VIOLATION',
      details: [{ path: 'withdrawal', code: 'DEMAND_NOT_SUBMITTED', message: expect.any(String) }],
    });
    expect((await eventsOf(a)).map((e) => e.name)).toEqual([
      'DEMAND_SUBMITTED',
      'DEMAND_WITHDRAWN',
    ]);
  });

  it('validates the body strictly: unknown fields, a product of another shape, a quantity that is not whole and positive', async () => {
    const a = org();
    const as = client(api, buyer(a));
    for (const body of [
      { productId: newProductId(), quantity: 1, unitPriceMinor: '100' },
      { productId: 'SKU-1', quantity: 1 },
      { productId: newProductId(), quantity: 0 },
      { productId: newProductId(), quantity: 1.5 },
      { productId: newProductId(), quantity: 2_147_483_648 },
      { productId: newProductId(), quantity: 1, note: '' },
      { productId: newProductId(), quantity: 1, note: 'x'.repeat(501) },
    ]) {
      const response = await as.post('/v1/demand-requests', body);
      expect({ body, status: response.status }).toEqual({ body, status: 400 });
    }
    const demand = await as.submit();
    for (const body of [
      { expectedVersion: 1, reason: 'short' },
      { expectedVersion: 1 },
      { reason: 'a reason long enough' },
      { expectedVersion: 1, reason: 'a reason long enough', note: 'x' },
    ]) {
      const response = await as.post(`/v1/demand-requests/${demand.body.id}/withdraw`, body);
      expect({ body, status: response.status }).toEqual({ body, status: 400 });
    }
    expect((await eventsOf(a)).map((e) => e.name)).toEqual(['DEMAND_SUBMITTED']);
  });

  it('requires an Idempotency-Key on both commands', async () => {
    const a = org();
    const response = await client(api, buyer(a))
      .post('/v1/demand-requests', { productId: newProductId(), quantity: 1 })
      .set('idempotency-key', '');
    expect(response.status).toBe(400);
    expect(response.body.details).toEqual([expect.objectContaining({ code: 'required' })]);
  });

  it('replays a command under its key and does nothing twice; another body under the key is 409', async () => {
    const a = org();
    const token = buyer(a);
    const k = key();
    const productId = newProductId();
    const first = await client(api, token).submit({ productId, quantity: 2 }, k);
    const replay = await client(api, token).submit({ productId, quantity: 2 }, k);
    expect([first.status, replay.status]).toEqual([201, 201]);
    expect(replay.body).toEqual(first.body);

    const reused = await client(api, token).submit({ productId, quantity: 3 }, k);
    expect(reused.status).toBe(409);
    expect(reused.body.code).toBe('IDEMPOTENCY_KEY_REUSED');

    const wk = key();
    const withdrawn = await client(api, token).withdraw(
      first.body.id,
      1,
      'not needed any more',
      wk,
    );
    const withdrawnAgain = await client(api, token).withdraw(
      first.body.id,
      1,
      'not needed any more',
      wk,
    );
    expect([withdrawn.status, withdrawnAgain.status]).toEqual([200, 200]);
    expect(withdrawnAgain.body).toEqual(withdrawn.body);

    expect((await eventsOf(a)).map((e) => e.name)).toEqual([
      'DEMAND_SUBMITTED',
      'DEMAND_WITHDRAWN',
    ]);
    const aggregation = await client(api, token).aggregation(first.body.aggregationId);
    expect(aggregation.body).toMatchObject({ totalQuantity: 0, demandCount: 0 });
  });

  it('lists the organization’s own demands and aggregations, newest first, by status and in pages', async () => {
    const a = org();
    const as = client(api, buyer(a));
    const one = await as.submit({ quantity: 1 });
    const two = await as.submit({ quantity: 2 });
    const three = await as.submit({ quantity: 3 });
    await as.withdraw(two.body.id, 1);

    const all = await as.demands();
    expect(all.status).toBe(200);
    expect(all.body.items.map((d: { id: string }) => d.id)).toEqual([
      three.body.id,
      two.body.id,
      one.body.id,
    ]);
    expect(all.body.nextCursor).toBeNull();

    const submitted = await as.demands('?status=SUBMITTED');
    expect(submitted.body.items.map((d: { id: string }) => d.id)).toEqual([
      three.body.id,
      one.body.id,
    ]);

    const page = await as.demands('?limit=2');
    expect(page.body.items).toHaveLength(2);
    expect(page.body.nextCursor).toBe(two.body.id);
    const rest = await as.demands(`?limit=2&cursor=${page.body.nextCursor}`);
    expect(rest.body.items.map((d: { id: string }) => d.id)).toEqual([one.body.id]);

    const open = await as.aggregations('?status=OPEN');
    expect(open.body.items).toHaveLength(3);
    expect((await as.aggregations('?status=READY')).body.items).toEqual([]);
    expect((await as.demands('?status=PENDING')).status).toBe(400);
  });
});
