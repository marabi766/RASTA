import { EXCEPTION_FILTER_LOGGER } from '@rasta/nest-common';
import type { Logger } from '@rasta/logging';
import request from 'supertest';
import { actor, buyer, client, internalToken, key, startApi, type ApiHarness } from './api-helpers';
import { cleanup, newOrganizationId, newProductId } from './helpers';

/**
 * Tenant isolation and BOLA on every route (ADR-070 § 10, AGENTS.md S-03), against real rows.
 *
 * A demand and its aggregation are the buyer's organization's alone (Q-119 (1)): a third
 * organization gets 404 on every route by id — the same answer as for an id that does not exist —
 * and its lists never show them. AUDITOR, the platform administrator (even acting for the buyer's
 * organization with X-Organization-Id), a service token and a role the configuration does not
 * grant are refused 403 before anything is read; no token is 401. Nothing a refused caller sends
 * changes a row or writes an event.
 */
describe('tenant isolation and authorization', () => {
  let api: ApiHarness;
  const organizations: string[] = [];
  const org = (): string => {
    const id = newOrganizationId();
    organizations.push(id);
    return id;
  };

  let owner: string;
  let demand: { id: string; aggregationId: string; version: number };

  beforeAll(async () => {
    api = await startApi();
    owner = org();
    const created = await client(api, buyer(owner)).submit({ quantity: 5 });
    expect(created.status).toBe(201);
    demand = created.body;
  });

  afterAll(async () => {
    await cleanup(organizations);
    await api.close();
  });

  const unchanged = async () => {
    const row = await api.prisma.client.$queryRaw<{ status: string; version: number }[]>`
      SELECT status, version FROM demand_request WHERE id = ${demand.id}`;
    expect(row).toEqual([{ status: 'SUBMITTED', version: 1 }]);
    const events = await api.prisma.client.outboxMessage.count({
      where: { organizationId: owner },
    });
    expect(events).toBe(1);
  };

  /** Every route of PR 1, as one caller: [label, response]. */
  const everyRoute = async (as: ReturnType<typeof client>) =>
    [
      ['GET demand', await as.demand(demand.id)],
      ['GET demands', await as.demands()],
      ['GET aggregation', await as.aggregation(demand.aggregationId)],
      ['GET aggregations', await as.aggregations()],
      ['POST withdraw', await as.withdraw(demand.id, 1)],
      ['POST submit', await as.submit({ quantity: 1 })],
    ] as const;

  it('a third organization: 404 on every route by id, the same as a missing id; its lists show nothing of the buyer', async () => {
    const third = org();
    const as = client(api, buyer(third));
    for (const response of [
      await as.demand(demand.id),
      await as.aggregation(demand.aggregationId),
      await as.withdraw(demand.id, 1),
    ]) {
      expect(response.status).toBe(404);
      expect(response.body.code).toBe('NOT_FOUND');
    }
    const missing = await as.demand('DMD_01JAAAAAAAAAAAAAAAAAAAAAAA');
    expect(missing.status).toBe(404);
    expect(Object.keys(missing.body).sort()).toEqual(
      Object.keys((await as.demand(demand.id)).body).sort(),
    );
    expect((await as.demands()).body.items).toEqual([]);
    expect((await as.aggregations()).body.items).toEqual([]);
    await unchanged();
  });

  it('a third organization’s demand for the same product opens its own window, never the buyer’s', async () => {
    const third = org();
    const productId = (await client(api, buyer(owner)).demand(demand.id)).body.productId;
    const theirs = await client(api, buyer(third)).submit({ productId, quantity: 1 });
    expect(theirs.status).toBe(201);
    expect(theirs.body.aggregationId).not.toBe(demand.aggregationId);
    expect((await client(api, buyer(owner)).aggregation(demand.aggregationId)).body).toMatchObject({
      totalQuantity: 5,
      demandCount: 1,
    });
  });

  it.each([
    ['AUDITOR', () => actor(owner, ['AUDITOR'])],
    ['AUDITOR beside a demand role', () => actor(owner, ['AUDITOR', 'PROCUREMENT_USER'])],
    ['a role the configuration does not grant', () => actor(owner, ['FLEET_MANAGER'])],
    ['a UNION_ADMIN (no union exception, Q-119 note)', () => actor(owner, ['UNION_ADMIN'])],
    ['a SUPPLIER of the buyer’s organization', () => actor(owner, ['SUPPLIER'])],
  ])(
    '%s of the buyer’s own organization: 403 on every route, nothing changed',
    async (_label, token) => {
      for (const [route, response] of await everyRoute(client(api, token()))) {
        expect({ route, status: response.status }).toEqual({ route, status: 403 });
      }
      await unchanged();
    },
  );

  it('the platform administrator, acting for the buyer’s organization: 403 on every route, nothing changed', async () => {
    const admin = actor(org(), ['SYSTEM_ADMIN']);
    const as = client(api, admin, { 'x-organization-id': owner });
    for (const [route, response] of await everyRoute(as)) {
      expect({ route, status: response.status }).toEqual({ route, status: 403 });
    }
    // With its own organization too, and with a demand role beside it.
    const mixed = client(api, actor(owner, ['SYSTEM_ADMIN', 'ORGANIZATION_ADMIN']));
    for (const [route, response] of await everyRoute(mixed)) {
      expect({ route, status: response.status }).toEqual({ route, status: 403 });
    }
    await unchanged();
  });

  it('a service token, even one signed for the buyer’s organization: 403 on every route', async () => {
    const token = await internalToken('economic-service', owner);
    const http = () => request(api.app.getHttpServer());
    const responses = [
      await http().get(`/v1/demand-requests/${demand.id}`).set('x-internal-token', token),
      await http().get('/v1/demand-requests').set('x-internal-token', token),
      await http().get(`/v1/aggregations/${demand.aggregationId}`).set('x-internal-token', token),
      await http()
        .post(`/v1/demand-requests/${demand.id}/withdraw`)
        .set('x-internal-token', token)
        .set('idempotency-key', key())
        .send({ expectedVersion: 1, reason: 'a service has no say here' }),
      await http()
        .post('/v1/demand-requests')
        .set('x-internal-token', token)
        .set('idempotency-key', key())
        .send({ productId: newProductId(), quantity: 1 }),
    ];
    expect(responses.map((r) => r.status)).toEqual([403, 403, 403, 403, 403]);
    await unchanged();
  });

  it('no token: 401 on every route', async () => {
    const http = () => request(api.app.getHttpServer());
    const responses = [
      await http().get(`/v1/demand-requests/${demand.id}`),
      await http().get('/v1/aggregations'),
      await http()
        .post('/v1/demand-requests')
        .set('idempotency-key', key())
        .send({ productId: newProductId(), quantity: 1 }),
    ];
    expect(responses.map((r) => r.status)).toEqual([401, 401, 401]);
  });

  it('a person without a platform user id may read but not command (403)', async () => {
    const as = client(api, actor(owner, ['PROCUREMENT_USER'], { rastaUserId: null }));
    expect((await as.demand(demand.id)).status).toBe(200);
    expect((await as.submit({ quantity: 1 })).status).toBe(403);
    expect((await as.withdraw(demand.id, 1)).status).toBe(403);
    await unchanged();
  });

  it('logs every refusal once, structured — code, status, method, path — and nothing the caller sent', async () => {
    // Refusals are logged, not durably audited — as on every service today; a durable refusal
    // record is the platform's S-06 follow-up (PM ruling on PR-327 r1 F2).
    const logger = api.app.get<Logger>(EXCEPTION_FILTER_LOGGER);
    const warn = jest.spyOn(logger, 'warn');
    const NOTE = 'T175 note the log must never hold';
    const service = await internalToken('economic-service', owner);
    const http = () => request(api.app.getHttpServer());
    const submitAs = (headers: Record<string, string>) => {
      let built = http().post('/v1/demand-requests').set('idempotency-key', key());
      for (const [name, value] of Object.entries(headers)) built = built.set(name, value);
      return built.send({ productId: newProductId(), quantity: 1, note: NOTE });
    };
    const bearerOf = (token: string) => ({ authorization: `Bearer ${token}` });
    const paths: [string, Record<string, string>][] = [
      ['a role the configuration does not grant', bearerOf(actor(owner, ['FLEET_MANAGER']))],
      ['AUDITOR (RolesGuard)', bearerOf(actor(owner, ['AUDITOR', 'PROCUREMENT_USER']))],
      [
        'the platform administrator',
        { ...bearerOf(actor(org(), ['SYSTEM_ADMIN'])), 'x-organization-id': owner },
      ],
      ['a service token', { 'x-internal-token': service }],
      [
        'a command without a platform user id',
        bearerOf(actor(owner, ['PROCUREMENT_USER'], { rastaUserId: null })),
      ],
      [
        'another organization’s X-Organization-Id',
        { ...bearerOf(actor(org(), ['PROCUREMENT_USER'])), 'x-organization-id': owner },
      ],
    ];
    try {
      for (const [label, headers] of paths) {
        warn.mockClear();
        const response = await submitAs(headers);
        expect({ label, status: response.status }).toEqual({ label, status: 403 });
        expect({ label, calls: warn.mock.calls.length }).toEqual({ label, calls: 1 });
        const [payload, message] = warn.mock.calls[0] as unknown as [
          Record<string, unknown>,
          string,
        ];
        expect({ label, message }).toEqual({
          label,
          message: `Access denied: ${response.body.code}`,
        });
        expect(payload).toMatchObject({
          errorCode: response.body.code,
          status: 403,
          method: 'POST',
          path: '/v1/demand-requests',
        });
        const logged = JSON.stringify(warn.mock.calls);
        expect({ label, note: logged.includes(NOTE) }).toEqual({ label, note: false });
        for (const value of Object.values(headers)) {
          expect({ label, credential: logged.includes(value) }).toEqual({
            label,
            credential: false,
          });
        }
      }
    } finally {
      warn.mockRestore();
    }
    await unchanged();
  });

  it('a member of two organizations acting for the other one sees nothing of the buyer’s', async () => {
    const other = org();
    const token = actor(other, ['PROCUREMENT_USER'], { memberships: [owner] });
    const as = client(api, token);
    expect((await as.demand(demand.id)).status).toBe(404);
    // Acting for the buyer with X-Organization-Id, as a member, it reads it.
    const asOwner = client(api, token, { 'x-organization-id': owner });
    expect((await asOwner.demand(demand.id)).status).toBe(200);
  });

  it('a configuration that drops a role refuses it at once (PROCUREMENT_DEMAND_ROLES)', async () => {
    const narrowed = await startApi({ PROCUREMENT_DEMAND_ROLES: 'ORGANIZATION_ADMIN' });
    try {
      expect((await client(narrowed, buyer(owner)).demand(demand.id)).status).toBe(403);
      expect(
        (await client(narrowed, actor(owner, ['ORGANIZATION_ADMIN'])).demand(demand.id)).status,
      ).toBe(200);
    } finally {
      await narrowed.close();
    }
  });

  it('AUDITOR in the configuration stops the service before it serves anything', async () => {
    await expect(
      startApi({ PROCUREMENT_DEMAND_ROLES: 'PROCUREMENT_USER,AUDITOR' }),
    ).rejects.toThrow(/may not name AUDITOR/);
  });
});
