import request from 'supertest';
import { ulid } from 'ulid';
import { fleetDashboardViewSchema } from '../src/maintenance/dto';
import {
  actor,
  internalToken,
  startApi,
  systemAdminWithoutTenant,
  type ApiHarness,
} from './api-helpers';
import {
  cleanup,
  maintenanceCompleted,
  newCompletion,
  newOrganizationId,
  wire,
  type Wiring,
} from './helpers';

/**
 * `GET /v1/dashboards/fleet` against the real application (ADR-071 § 4, RUN-001 PR 1): what it
 * sums, whom it answers, and — the tenant isolation test AGENTS.md § 4 requires — that one
 * organization never sees another's facts, by any route.
 */

let api: ApiHarness;
let w: Wiring;
const organizations: string[] = [];
const events: string[] = [];

const WINDOW = { from: '2026-10-01T00:00:00.000Z', to: '2026-11-01T00:00:00.000Z' };

async function project(
  organizationId: string,
  overrides: Parameters<typeof newCompletion>[1] = {},
) {
  const event = maintenanceCompleted(newCompletion(organizationId, overrides));
  events.push(event.eventId);
  await w.consumer.handle(event);
}

function fleet(token: string, query: Record<string, string> = WINDOW, organization?: string) {
  const call = request(api.app.getHttpServer())
    .get('/v1/dashboards/fleet')
    .query(query)
    .set('authorization', `Bearer ${token}`);
  return organization ? call.set('x-organization-id', organization) : call;
}

let a: string;
let b: string;

beforeAll(async () => {
  api = await startApi();
  w = wire();
  a = newOrganizationId();
  b = newOrganizationId();
  organizations.push(a, b);

  // A: two preventive (one with unknown downtime), one corrective in two currencies, one
  // completion outside the window. B: one corrective with a cost A's sums would show.
  await project(a, {
    type: 'PREVENTIVE',
    downtimeMinutes: 60,
    totalCostMinor: '1000',
    completedAt: '2026-10-02T10:00:00.000Z',
  });
  await project(a, {
    type: 'PREVENTIVE',
    downtimeMinutes: null,
    totalCostMinor: '2000',
    completedAt: '2026-10-20T10:00:00.000Z',
  });
  await project(a, {
    type: 'CORRECTIVE',
    downtimeMinutes: 300,
    totalCostMinor: '50000',
    completedAt: '2026-10-21T10:00:00.000Z',
  });
  await project(a, {
    type: 'CORRECTIVE',
    downtimeMinutes: 30,
    totalCostMinor: '5',
    currency: 'EUR',
    completedAt: '2026-10-22T10:00:00.000Z',
  });
  await project(a, {
    type: 'PREVENTIVE',
    downtimeMinutes: 10,
    totalCostMinor: '999',
    completedAt: '2026-09-15T10:00:00.000Z',
  });
  await project(b, {
    type: 'CORRECTIVE',
    downtimeMinutes: 1,
    totalCostMinor: '777777',
    completedAt: '2026-10-05T10:00:00.000Z',
  });
});

afterAll(async () => {
  await cleanup(organizations, events);
  await Promise.all([api.close(), w.close()]);
});

describe('the fleet dashboard', () => {
  it('sums the organization’s completions in [from, to) by type, cost per currency, unknown downtime not counted', async () => {
    const response = await fleet(actor(a, ['FLEET_MANAGER'])).expect(200);

    expect(fleetDashboardViewSchema.parse(response.body)).toEqual({
      organizationId: a,
      from: WINDOW.from,
      to: WINDOW.to,
      earliestCompletionAt: '2026-09-15T10:00:00.000Z',
      maintenance: {
        completed: [
          {
            type: 'CORRECTIVE',
            count: 2,
            downtime: { knownCount: 2, totalMinutes: 330 },
            cost: [
              { currency: 'EUR', amountMinor: '5' },
              { currency: 'IRR', amountMinor: '50000' },
            ],
          },
          {
            type: 'PREVENTIVE',
            count: 2,
            downtime: { knownCount: 1, totalMinutes: 60 },
            cost: [{ currency: 'IRR', amountMinor: '3000' }],
          },
        ],
      },
    });
  });

  it('includes `from` and excludes `to`', async () => {
    const response = await fleet(actor(a, ['FLEET_MANAGER']), {
      from: '2026-10-02T10:00:00.000Z',
      to: '2026-10-20T10:00:00.000Z',
    }).expect(200);
    expect(response.body.maintenance.completed).toEqual([
      expect.objectContaining({ type: 'PREVENTIVE', count: 1 }),
    ]);
  });

  it('answers an organization with no facts with an empty list and no earliest completion — never zeros', async () => {
    const empty = newOrganizationId();
    const response = await fleet(actor(empty, ['ORGANIZATION_ADMIN'])).expect(200);
    expect(response.body).toEqual({
      organizationId: empty,
      from: WINDOW.from,
      to: WINDOW.to,
      earliestCompletionAt: null,
      maintenance: { completed: [] },
    });
  });
});

describe('tenant isolation: organization A never sees organization B', () => {
  it('shows each organization only its own facts', async () => {
    const forA = await fleet(actor(a, ['FLEET_MANAGER'])).expect(200);
    const forB = await fleet(actor(b, ['FLEET_MANAGER'])).expect(200);

    expect(JSON.stringify(forA.body)).not.toContain('777777');
    expect(forB.body.maintenance.completed).toEqual([
      {
        type: 'CORRECTIVE',
        count: 1,
        downtime: { knownCount: 1, totalMinutes: 1 },
        cost: [{ currency: 'IRR', amountMinor: '777777' }],
      },
    ]);
    expect(forB.body.earliestCompletionAt).toBe('2026-10-05T10:00:00.000Z');
  });

  it('refuses a member of A who names B in X-Organization-Id, and leaks nothing of B', async () => {
    const response = await fleet(actor(a, ['FLEET_MANAGER']), WINDOW, b);
    expect(response.status).toBe(403);
    expect(JSON.stringify(response.body)).not.toContain('777777');
  });

  it('cannot be steered to another organization by a query parameter', async () => {
    await fleet(actor(a, ['FLEET_MANAGER']), { ...WINDOW, organizationId: b }).expect(400);
  });

  it('lets a SYSTEM_ADMIN read only the organization it acts for', async () => {
    const response = await fleet(actor(b, ['SYSTEM_ADMIN'])).expect(200);
    expect(response.body.organizationId).toBe(b);
    expect(JSON.stringify(response.body)).not.toContain('50000');
  });
});

describe('authorization', () => {
  it.each(['ORGANIZATION_ADMIN', 'FLEET_MANAGER'])(
    'lets %s read (the default readers)',
    async (role) => {
      await fleet(actor(a, [role])).expect(200);
    },
  );

  it.each(['DRIVER', 'OPERATOR', 'PROCUREMENT_USER', 'UNION_ADMIN'])(
    'refuses %s with 403',
    async (role) => {
      const response = await fleet(actor(a, [role])).expect(403);
      expect(response.body.code).toBe('INSUFFICIENT_ROLE');
    },
  );

  it('refuses the oversight role: one organization’s dashboard is not an aggregate (docs/09 § 9.3)', async () => {
    const response = await fleet(actor(a, ['AUDITOR'])).expect(403);
    expect(JSON.stringify(response.body)).not.toContain('50000');
    await fleet(actor(a, ['FLEET_MANAGER', 'AUDITOR'])).expect(403);
  });

  it('refuses a SYSTEM_ADMIN that selected no organization, rather than summing every one', async () => {
    await fleet(systemAdminWithoutTenant()).expect(403);
  });

  it('refuses a service-to-service token, verified and still not enough', async () => {
    const response = await request(api.app.getHttpServer())
      .get('/v1/dashboards/fleet')
      .query(WINDOW)
      .set('x-internal-token', await internalToken('economic-service', { organizationId: a }))
      .expect(403);
    expect(JSON.stringify(response.body)).not.toContain('50000');
  });

  it('refuses a caller with no token', async () => {
    await request(api.app.getHttpServer()).get('/v1/dashboards/fleet').query(WINDOW).expect(401);
  });
});

describe('the window', () => {
  it.each([
    ['a missing end', { from: WINDOW.from }],
    ['a window that ends before it starts', { from: WINDOW.to, to: WINDOW.from }],
    ['an empty window', { from: WINDOW.from, to: WINDOW.from }],
    ['an instant that is not ISO 8601', { from: '2026-10-01', to: WINDOW.to }],
    ['an unknown parameter', { ...WINDOW, limit: '10' }],
  ])('refuses %s with 400', async (_label, query) => {
    const response = await fleet(
      actor(a, ['FLEET_MANAGER']),
      query as Record<string, string>,
    ).expect(400);
    expect(response.body.code).toBe('VALIDATION_FAILED');
  });
});

describe('no route writes', () => {
  it.each(['post', 'put', 'patch', 'delete'] as const)(
    'has no %s on the dashboard',
    async (method) => {
      const response = await request(api.app.getHttpServer())
        [method]('/v1/dashboards/fleet')
        .set('authorization', `Bearer ${actor(a, ['ORGANIZATION_ADMIN'])}`)
        .send({ requestId: `MRQ_${ulid()}` });
      expect(response.status).toBe(404);
    },
  );
});
