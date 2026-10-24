import request from 'supertest';
import { PLATFORM_ROLES, createSystemContext, runWithContext } from '@rasta/nest-common';
import { kpisViewSchema } from '../src/kpis/dto';
import {
  actor,
  bearer,
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
  ownerClient,
  wire,
  type Wiring,
} from './helpers';
import { baselineFixture, cleanupBaselines, KPI_WINDOW } from './baseline-helpers';

let api: ApiHarness;
let wiring: Wiring;
const owner = ownerClient();
const organizations: string[] = [];
const events: string[] = [];
function organization(): string {
  const id = newOrganizationId();
  organizations.push(id);
  return id;
}
function kpis(token: string, query: Record<string, string> = KPI_WINDOW, active?: string) {
  const call = request(api.app.getHttpServer())
    .get('/v1/kpis')
    .query(query)
    .set('authorization', `Bearer ${token}`);
  return active ? call.set('x-organization-id', active) : call;
}
async function view(id: string) {
  const response = await kpis(actor(id, ['FLEET_MANAGER'])).expect(200);
  return kpisViewSchema.parse(response.body);
}

beforeAll(async () => {
  api = await startApi();
  wiring = wire();
});
afterAll(async () => {
  await cleanupBaselines(organizations);
  await cleanup(organizations, events);
  await Promise.all([api.close(), wiring.close(), owner.$disconnect()]);
});

describe('GET /v1/kpis — exact baseline matching', () => {
  it('without any baseline returns INSUFFICIENT_BASELINE and literal null, never zero', async () => {
    const response = await view(organization());
    expect(response.earliestCompletionAt).toBeNull();
    expect(response.kpis).toEqual([
      {
        key: 'MAINTENANCE_COMPLETED_COUNT',
        unit: 'COUNT',
        dependsOnBaseline: false,
        status: 'AVAILABLE',
        value: '0',
      },
      {
        key: 'MAINTENANCE_DOWNTIME_BASELINE_MINUTES',
        unit: 'MINUTES',
        dependsOnBaseline: true,
        status: 'INSUFFICIENT_BASELINE',
        value: null,
      },
    ]);
  });

  it.each([
    ['scope', { scopeKind: 'GOVERNANCE_ROOT' }],
    ['period start', { periodStart: new Date('2026-09-01T00:00:00Z') }],
    ['period end', { periodEnd: new Date('2026-12-01T00:00:00Z') }],
    ['unit', { unit: 'COUNT' }],
    ['currency', { currency: 'IRR' }],
    ['key', { metricKey: 'OTHER_METRIC' }],
  ])('a baseline for another %s never supplies the KPI', async (_name, overrides) => {
    const id = organization();
    await owner.baselineMetric.create({ data: baselineFixture(id, overrides) });
    expect((await view(id)).kpis[1]).toMatchObject({
      status: 'INSUFFICIENT_BASELINE',
      value: null,
    });
  });

  it('reads an exact baseline as a decimal string; versions append and latest recorded wins', async () => {
    const id = organization();
    await owner.baselineMetric.create({ data: baselineFixture(id, { value: 1n }) });
    await owner.baselineMetric.create({
      data: baselineFixture(id, { value: 9223372036854775807n }),
    });
    const response = await kpis(actor(id, ['FLEET_MANAGER']), {
      from: '2026-10-01T03:30:00+03:30',
      to: KPI_WINDOW.to,
    }).expect(200);
    expect(kpisViewSchema.parse(response.body).kpis[1]).toMatchObject({
      status: 'AVAILABLE',
      value: '9223372036854775807',
    });
    await owner.baselineMetric.create({ data: baselineFixture(id, { value: 0n }) });
    expect((await view(id)).kpis[1]).toMatchObject({ status: 'AVAILABLE', value: '0' });
  });

  it('counts only completions in [from, to), preserving earliest held fact coverage', async () => {
    const id = organization();
    for (const completedAt of [KPI_WINDOW.from, KPI_WINDOW.to, '2026-09-15T00:00:00Z']) {
      const event = maintenanceCompleted(newCompletion(id, { completedAt }));
      events.push(event.eventId);
      await wiring.consumer.handle(event);
    }
    const result = await view(id);
    expect(result.kpis[0]).toMatchObject({ status: 'AVAILABLE', value: '1' });
    expect(result.earliestCompletionAt).toBe('2026-09-15T00:00:00.000Z');
  });
});

describe('tenant isolation — B baseline never affects A', () => {
  it('B has an exact baseline and fact; A remains insufficient with an unchanged response', async () => {
    const a = organization();
    const b = organization();
    const before = await view(a);
    await owner.baselineMetric.create({ data: baselineFixture(b, { value: 777777n }) });
    const event = maintenanceCompleted(newCompletion(b));
    events.push(event.eventId);
    await wiring.consumer.handle(event);
    expect(await view(a)).toEqual(before);
    const forB = await view(b);
    expect(forB.kpis[0].value).toBe('1');
    expect(forB.kpis[1]).toMatchObject({ status: 'AVAILABLE', value: '777777' });
    const refused = await kpis(actor(a, ['FLEET_MANAGER']), KPI_WINDOW, b).expect(403);
    expect(JSON.stringify(refused.body)).not.toContain('777777');
  });

  it('the guarded Prisma model scopes baseline reads as well as the raw API query', async () => {
    const a = organization();
    const b = organization();
    const row = await owner.baselineMetric.create({ data: baselineFixture(b) });
    await runWithContext(
      createSystemContext({ organizationId: a, correlationId: 'kpi-isolation' }),
      async () => {
        expect(await api.prisma.client.baselineMetric.findMany({ where: { id: row.id } })).toEqual(
          [],
        );
      },
    );
  });

  it('resolves active memberships and permits SYSTEM_ADMIN to select exactly one organization', async () => {
    const a = organization();
    const b = organization();
    await owner.baselineMetric.create({ data: baselineFixture(b) });
    const token = bearer({
      sub: 'multi-member',
      organizationId: a,
      organizationIds: [a, b],
      roles: ['FLEET_MANAGER'],
    });
    const result = await kpis(token, KPI_WINDOW, b).expect(200);
    expect(result.body.organizationId).toBe(b);
    expect(result.body.kpis[1].value).toBe('600');
    const admin = await kpis(actor(b, ['SYSTEM_ADMIN']), KPI_WINDOW, b).expect(200);
    expect(admin.body.organizationId).toBe(b);
  });
});

describe('KPI roles, strict queries, and read-only surface', () => {
  it.each(PLATFORM_ROLES)('checks platform role %s', async (role) => {
    const allowed = ['ORGANIZATION_ADMIN', 'FLEET_MANAGER', 'SYSTEM_ADMIN'].includes(role);
    await kpis(actor(organization(), [role])).expect(allowed ? 200 : 403);
  });
  it('refuses AUDITOR even beside SYSTEM_ADMIN or a configured reader', async () => {
    for (const role of ['FLEET_MANAGER', 'SYSTEM_ADMIN']) {
      await kpis(actor(organization(), [role, 'AUDITOR'])).expect(403);
    }
  });
  it('requires credentials and an active organization; service tokens grant no read', async () => {
    await request(api.app.getHttpServer()).get('/v1/kpis').query(KPI_WINDOW).expect(401);
    await kpis(systemAdminWithoutTenant()).expect(403);
    await request(api.app.getHttpServer())
      .get('/v1/kpis')
      .query(KPI_WINDOW)
      .set(
        'x-internal-token',
        await internalToken('economic-service', { organizationId: organization() }),
      )
      .expect(403);
  });
  it.each([
    {},
    { from: KPI_WINDOW.from },
    { from: KPI_WINDOW.to, to: KPI_WINDOW.from },
    { from: KPI_WINDOW.from, to: KPI_WINDOW.from },
    { ...KPI_WINDOW, from: 'not-an-instant' },
    ...[
      'organizationId',
      'organizationIds',
      'tenantId',
      'scope',
      'subtree',
      'rootOrganizationId',
      'childOrganizationId',
      'limit',
      'period',
    ].map((key) => ({ ...KPI_WINDOW, [key]: 'other' })),
  ])('invalid query is 400 VALIDATION_FAILED: %j', async (query) => {
    const response = await kpis(
      actor(organization(), ['FLEET_MANAGER']),
      query as Record<string, string>,
    ).expect(400);
    expect(response.body.code).toBe('VALIDATION_FAILED');
  });
  it.each(['post', 'put', 'patch', 'delete'] as const)(
    'has no %s path for KPI or baseline writes',
    async (method) => {
      for (const path of ['/v1/kpis', '/v1/baseline-metrics']) {
        await request(api.app.getHttpServer())
          [method](path)
          .set('authorization', `Bearer ${actor(organization(), ['SYSTEM_ADMIN'])}`)
          .send({ value: '123' })
          .expect(404);
      }
    },
  );
});
