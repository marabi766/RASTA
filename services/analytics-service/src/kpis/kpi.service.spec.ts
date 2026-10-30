import { runWithContext, type RequestContext } from '@rasta/nest-common';
import { DashboardAccess } from '../access/access';
import { loadAnalyticsEnv } from '../config/env';
import { KpiService, type KpiValueReaders } from './kpi.service';
import { KpiRepository, type KpiRead } from './kpi.repository';
import { kpiStatusSchema, kpisViewSchema } from './dto';

const query = { from: '2026-07-01T03:30:00+03:30', to: '2026-08-01T00:00:00Z' };
const environment = loadAnalyticsEnv({
  NODE_ENV: 'test',
  KAFKA_BROKERS: 'localhost:9092',
  KAFKA_ALLOW_PLAINTEXT: 'true',
  OIDC_ISSUER_URL: 'http://localhost:8080/realms/rasta',
  OIDC_JWKS_URI: 'http://localhost:8080/certs',
  OIDC_AUDIENCE: 'rasta-api',
  INTERNAL_TOKEN_SECRET: 'a-throwaway-value-used-only-by-this-spec-32',
  DATABASE_URL: 'postgresql://u:p@localhost:5433/rasta_analytics',
});
const context = (roles: string[]): RequestContext =>
  ({
    requestId: 'req-1',
    correlationId: 'corr-1',
    organizationId: 'ORG-A',
    organizationIds: ['ORG-A'],
    userId: 'USR-1',
    roles,
    authType: 'USER',
    startedAt: 0,
  }) as RequestContext;

const covered: KpiRead = {
  completed_count: '9223372036854775808',
  earliest_completion: null,
  baseline_minutes: null,
  coverage_start: new Date('2026-01-01T00:00:00Z'),
  read_at: new Date('2026-10-29T00:00:00Z'),
};
const enabled = { ANALYTICS_MAINTENANCE_FACTS_CONSUMER_ENABLED: true };
const disabled = { ANALYTICS_MAINTENANCE_FACTS_CONSUMER_ENABLED: false };

function build(
  read: KpiRead,
  env = enabled,
  readers?: KpiValueReaders,
): { service: KpiService; error: jest.Mock; read: jest.Mock } {
  const readMock = jest.fn().mockResolvedValue(read);
  const error = jest.fn();
  const service = new KpiService(
    new DashboardAccess(environment),
    { read: readMock } as unknown as KpiRepository,
    { error },
    env,
    ...(readers ? [readers] : []),
  );
  return { service, error, read: readMock };
}
const list = (service: KpiService, q = query) =>
  runWithContext(context(['FLEET_MANAGER']), async () => service.list(q));

describe('KpiService', () => {
  it('keeps large values exact and absent baselines null, canonicalizing the requested instants', async () => {
    const { service, read } = build(covered);
    const result = await list(service);
    expect(kpisViewSchema.parse(result)).toEqual({
      organizationId: 'ORG-A',
      from: '2026-07-01T00:00:00.000Z',
      to: '2026-08-01T00:00:00.000Z',
      earliestCompletionAt: null,
      kpis: [
        {
          key: 'MAINTENANCE_COMPLETED_COUNT',
          unit: 'COUNT',
          dependsOnBaseline: false,
          status: 'AVAILABLE',
          value: '9223372036854775808',
        },
        {
          key: 'MAINTENANCE_DOWNTIME_BASELINE_MINUTES',
          unit: 'MINUTES',
          dependsOnBaseline: true,
          status: 'INSUFFICIENT_BASELINE',
          value: null,
        },
      ],
    });
    expect(read).toHaveBeenCalledWith(new Date('2026-07-01T00:00:00Z'), new Date(query.to));
  });

  it('a covered quiet window is AVAILABLE "0": zero is reported when it is known', async () => {
    const { service } = build({ ...covered, completed_count: '0' });
    expect((await list(service)).kpis[0]).toMatchObject({ status: 'AVAILABLE', value: '0' });
  });

  it.each([
    ['the consumer never ran', { coverage_start: null }, enabled],
    [
      'the window starts before coverage',
      { coverage_start: new Date('2026-07-02T00:00:00Z') },
      enabled,
    ],
    ['the window ends in the future', { read_at: new Date('2026-07-31T23:59:59.999Z') }, enabled],
    ['the consumer is disabled', {}, disabled],
  ])('%s: the count is NO_DATA with no value, whatever was counted', async (_name, patch, env) => {
    const { service } = build({ ...covered, completed_count: '7', ...patch }, env);
    const result = await list(service);
    expect(result.kpis[0]).toEqual({
      key: 'MAINTENANCE_COMPLETED_COUNT',
      unit: 'COUNT',
      dependsOnBaseline: false,
      status: 'NO_DATA',
    });
    expect(result.kpis[0]).not.toHaveProperty('value');
  });

  it('keeps the baseline KPI on its own statuses beside a NO_DATA count', async () => {
    const { service } = build({ ...covered, coverage_start: null, baseline_minutes: '600' });
    const [count, baseline] = (await list(service)).kpis;
    expect(count?.status).toBe('NO_DATA');
    expect(baseline).toMatchObject({ status: 'AVAILABLE', value: '600' });
  });

  it('the status enum is closed: exactly these three values', () => {
    expect(kpiStatusSchema.options).toEqual(['AVAILABLE', 'INSUFFICIENT_BASELINE', 'NO_DATA']);
  });

  it.each([
    ['NO_DATA carrying null', { status: 'NO_DATA', value: null }],
    ['NO_DATA carrying a count', { status: 'NO_DATA', value: '0' }],
    ['AVAILABLE without a value', { status: 'AVAILABLE' }],
    ['AVAILABLE carrying null', { status: 'AVAILABLE', value: null }],
    ['INSUFFICIENT_BASELINE carrying a count', { status: 'INSUFFICIENT_BASELINE', value: '1' }],
  ])('refuses %s through the invalid-response path, disclosing nothing', async (_name, bad) => {
    const readers = {
      MAINTENANCE_COMPLETED_COUNT: () => bad,
      MAINTENANCE_DOWNTIME_BASELINE_MINUTES: () => ({
        status: 'INSUFFICIENT_BASELINE',
        value: null,
      }),
    } as unknown as KpiValueReaders;
    const { service, error } = build(covered, enabled, readers);
    await expect(list(service)).rejects.toThrow('KPI response unavailable');
    expect(error).toHaveBeenCalledWith({ event: 'KPI_RESPONSE_INVALID' }, expect.any(String));
  });

  it.each([['AUDITOR'], ['AUDITOR', 'SYSTEM_ADMIN'], ['DRIVER']])(
    'refuses %j at the service before reading, without an HTTP guard',
    async (...roles) => {
      const { service, read } = build(covered);
      await expect(
        runWithContext(context(roles), async () => service.list(query)),
      ).rejects.toThrow();
      expect(read).not.toHaveBeenCalled();
    },
  );
});
