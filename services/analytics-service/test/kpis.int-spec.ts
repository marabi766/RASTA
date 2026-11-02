import request from 'supertest';
import { errorEnvelope, expectNotDisclosed } from '@rasta/testing';
import { PLATFORM_ROLES, createSystemContext, runWithContext } from '@rasta/nest-common';
import { kpisViewSchema } from '../src/kpis/dto';
import { KpiRepository } from '../src/kpis/kpi.repository';
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
  clearCoverage,
  maintenanceCompleted,
  newCompletion,
  newOrganizationId,
  ownerClient,
  plantCoverage,
  wire,
  type Wiring,
} from './helpers';
import { baselineFixture, cleanupBaselines, COVERED_SINCE, KPI_WINDOW } from './baseline-helpers';

const IN_WINDOW = '2026-07-10T07:30:00.000Z';
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
  await plantCoverage(COVERED_SINCE);
});
afterAll(async () => {
  await cleanupBaselines(organizations);
  await cleanup(organizations, events);
  await clearCoverage();
  await Promise.all([api.close(), wiring.close(), owner.$disconnect()]);
});

describe('GET /v1/kpis — exact baseline matching', () => {
  it('a quiet, fully covered tenant is AVAILABLE "0"; a missing baseline is INSUFFICIENT_BASELINE with literal null', async () => {
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
    ['period start', { periodStart: new Date('2026-06-01T00:00:00Z') }],
    ['period end', { periodEnd: new Date('2026-09-01T00:00:00Z') }],
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

  it('reads exact decimal strings; database versions increase and the latest insert (including zero) wins', async () => {
    const id = organization();
    const first = await owner.baselineMetric.create({ data: baselineFixture(id, { value: 1n }) });
    const second = await owner.baselineMetric.create({
      data: baselineFixture(id, { value: 9223372036854775807n }),
    });
    expect(second.version).toBeGreaterThan(first.version);
    const response = await kpis(actor(id, ['FLEET_MANAGER']), {
      from: '2026-07-01T03:30:00+03:30',
      to: KPI_WINDOW.to,
    }).expect(200);
    expect(kpisViewSchema.parse(response.body).kpis[1]).toMatchObject({
      status: 'AVAILABLE',
      value: '9223372036854775807',
    });
    const zero = await owner.baselineMetric.create({ data: baselineFixture(id, { value: 0n }) });
    expect(zero.version).toBeGreaterThan(second.version);
    expect((await view(id)).kpis[1]).toMatchObject({ status: 'AVAILABLE', value: '0' });
  });

  it('counts only completions in [from, to), preserving earliest held fact coverage', async () => {
    const id = organization();
    for (const completedAt of [KPI_WINDOW.from, KPI_WINDOW.to, '2026-06-15T00:00:00Z']) {
      const event = maintenanceCompleted(newCompletion(id, { completedAt }));
      events.push(event.eventId);
      await wiring.consumer.handle(event);
    }
    const result = await view(id);
    expect(result.kpis[0]).toMatchObject({ status: 'AVAILABLE', value: '1' });
    expect(result.earliestCompletionAt).toBe('2026-06-15T00:00:00.000Z');
  });
});

describe('tenant isolation — B baseline never affects A', () => {
  it('B has an exact baseline and fact; A remains insufficient with an unchanged response', async () => {
    const a = organization();
    const b = organization();
    const before = await view(a);
    await owner.baselineMetric.create({ data: baselineFixture(b, { value: 777777n }) });
    const event = maintenanceCompleted(newCompletion(b, { completedAt: IN_WINDOW }));
    events.push(event.eventId);
    await wiring.consumer.handle(event);
    expect(await view(a)).toEqual(before);
    const forB = await view(b);
    expect(forB.kpis[0]).toMatchObject({ status: 'AVAILABLE', value: '1' });
    expect(forB.kpis[1]).toMatchObject({ status: 'AVAILABLE', value: '777777' });
    const refused = await kpis(actor(a, ['FLEET_MANAGER']), KPI_WINDOW, b).expect(403);
    // B's baseline value is not in the refusal; the envelope's generated values set aside first (#452).
    expectNotDisclosed(refused.body, ['777777'], {
      metadata: errorEnvelope({ headers: refused.headers }),
    });
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

const COUNT = 'MAINTENANCE_COMPLETED_COUNT';
const BASELINE = 'MAINTENANCE_DOWNTIME_BASELINE_MINUTES';
const byKey = (response: { kpis: { key: string }[] }, key: string) =>
  response.kpis.find((kpi) => kpi.key === key);

async function project(id: string, completedAt = IN_WINDOW): Promise<void> {
  const event = maintenanceCompleted(newCompletion(id, { completedAt }));
  events.push(event.eventId);
  await wiring.consumer.handle(event);
}

describe('MAINTENANCE_COMPLETED_COUNT coverage — NO_DATA is not zero (Q-154, D-082)', () => {
  afterEach(() => plantCoverage(COVERED_SINCE));

  it('a window starting before the coverage start is NO_DATA with no value field, though facts are held', async () => {
    const id = organization();
    await project(id);
    await plantCoverage(new Date('2026-07-15T00:00:00.000Z'));
    const response = await kpis(actor(id, ['FLEET_MANAGER'])).expect(200);
    // Raw body: `value` must be ABSENT, not null and not "0".
    expect(byKey(response.body, COUNT)).toEqual({
      key: COUNT,
      unit: 'COUNT',
      dependsOnBaseline: false,
      status: 'NO_DATA',
    });
    expect(JSON.stringify(response.body.kpis[0])).not.toContain('value');
  });

  it('the consumer never ran: NO_DATA, whether or not facts exist', async () => {
    const quiet = organization();
    const busy = organization();
    await project(busy);
    await clearCoverage();
    for (const id of [quiet, busy]) {
      const response = await kpis(actor(id, ['FLEET_MANAGER'])).expect(200);
      expect(byKey(response.body, COUNT)).toMatchObject({ status: 'NO_DATA' });
      expect(byKey(response.body, COUNT)).not.toHaveProperty('value');
    }
  });

  it('the boundary instant: from exactly at the coverage start is AVAILABLE, one millisecond earlier NO_DATA', async () => {
    const id = organization();
    await project(id);
    await plantCoverage(new Date(KPI_WINDOW.from));
    expect(byKey(await view(id), COUNT)).toMatchObject({ status: 'AVAILABLE', value: '1' });
    await plantCoverage(new Date(Date.parse(KPI_WINDOW.from) + 1));
    expect(byKey(await view(id), COUNT)).toEqual(expect.objectContaining({ status: 'NO_DATA' }));
  });

  it('a partial window (starting before coverage, ending after it) fails closed', async () => {
    const id = organization();
    await plantCoverage(new Date('2026-07-10T00:00:00.000Z'));
    expect(byKey(await view(id), COUNT)).toMatchObject({ status: 'NO_DATA' });
  });

  it('a window reaching into the future is NO_DATA even for a covered tenant', async () => {
    const id = organization();
    const response = await kpis(actor(id, ['FLEET_MANAGER']), {
      from: KPI_WINDOW.from,
      to: '2999-01-01T00:00:00.000Z',
    }).expect(200);
    expect(byKey(response.body, COUNT)).toMatchObject({ status: 'NO_DATA' });
  });

  it('a window ending right now or earlier needs no future data: to at or before the read instant', async () => {
    const id = organization();
    const response = await kpis(actor(id, ['FLEET_MANAGER']), {
      from: KPI_WINDOW.from,
      to: new Date(Date.now() - 60_000).toISOString(),
    }).expect(200);
    expect(byKey(response.body, COUNT)).toMatchObject({ status: 'AVAILABLE', value: '0' });
  });

  it('a deployment whose consumer is disabled reports NO_DATA although a coverage row exists', async () => {
    const disabled = await startApi({ consumerEnabled: false });
    try {
      const id = organization();
      const response = await request(disabled.app.getHttpServer())
        .get('/v1/kpis')
        .query(KPI_WINDOW)
        .set('authorization', `Bearer ${actor(id, ['FLEET_MANAGER'])}`)
        .expect(200);
      expect(byKey(response.body, COUNT)).toMatchObject({ status: 'NO_DATA' });
    } finally {
      await disabled.close();
    }
  });

  it('the baseline KPI keeps its own statuses beside a NO_DATA count — the meanings are not merged', async () => {
    const withBaseline = organization();
    const without = organization();
    await owner.baselineMetric.create({ data: baselineFixture(withBaseline, { value: 42n }) });
    await clearCoverage();
    const present = await view(withBaseline);
    expect(byKey(present, COUNT)).toMatchObject({ status: 'NO_DATA' });
    expect(byKey(present, BASELINE)).toMatchObject({ status: 'AVAILABLE', value: '42' });
    const absent = await view(without);
    expect(byKey(absent, COUNT)).toMatchObject({ status: 'NO_DATA' });
    expect(byKey(absent, BASELINE)).toMatchObject({ status: 'INSUFFICIENT_BASELINE', value: null });
  });

  it("tenant B's activity never changes tenant A's status: A quiet and covered stays AVAILABLE 0", async () => {
    const a = organization();
    const b = organization();
    const before = await view(a);
    expect(byKey(before, COUNT)).toMatchObject({ status: 'AVAILABLE', value: '0' });
    await project(b);
    await project(b, '2026-07-11T07:30:00.000Z');
    expect(await view(a)).toEqual(before);
    expect(byKey(await view(b), COUNT)).toMatchObject({ status: 'AVAILABLE', value: '2' });
    // Coverage is shared, not per tenant: when it goes, it goes for both.
    await clearCoverage();
    expect(byKey(await view(a), COUNT)).toMatchObject({ status: 'NO_DATA' });
    expect(byKey(await view(b), COUNT)).toMatchObject({ status: 'NO_DATA' });
  });

  it('count and coverage come from one statement: the repository returns them together', async () => {
    const id = organization();
    await project(id);
    const read = await runWithContext(
      createSystemContext({ organizationId: id, correlationId: 'kpi-coverage-snapshot' }),
      () => new KpiRepository(api.prisma).read(new Date(KPI_WINDOW.from), new Date(KPI_WINDOW.to)),
    );
    expect(read).toMatchObject({ completed_count: '1', coverage_start: COVERED_SINCE });
    expect(read.read_at.getTime()).toBeGreaterThan(Date.parse(KPI_WINDOW.to));
  });
});
