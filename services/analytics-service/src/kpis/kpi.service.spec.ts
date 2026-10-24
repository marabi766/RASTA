import { runWithContext, type RequestContext } from '@rasta/nest-common';
import { DashboardAccess } from '../access/access';
import { loadAnalyticsEnv } from '../config/env';
import { KpiService } from './kpi.service';
import { KpiRepository } from './kpi.repository';
import { kpisViewSchema } from './dto';

const query = { from: '2026-10-01T03:30:00+03:30', to: '2026-11-01T00:00:00Z' };
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

describe('KpiService', () => {
  const read = jest.fn().mockResolvedValue({
    completed_count: '9223372036854775808',
    earliest_completion: null,
    baseline_minutes: null,
  });
  const repository = { read } as unknown as KpiRepository;
  const service = new KpiService(new DashboardAccess(environment), repository, {
    error: jest.fn(),
  });

  it('keeps large values exact and absent baselines null, canonicalizing the requested instants', async () => {
    const result = await runWithContext(context(['FLEET_MANAGER']), async () =>
      service.list(query),
    );
    expect(kpisViewSchema.parse(result)).toEqual({
      organizationId: 'ORG-A',
      from: '2026-10-01T00:00:00.000Z',
      to: '2026-11-01T00:00:00.000Z',
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
    expect(read).toHaveBeenCalledWith(new Date('2026-10-01T00:00:00Z'), new Date(query.to));
  });

  it.each([['AUDITOR'], ['AUDITOR', 'SYSTEM_ADMIN'], ['DRIVER']])(
    'refuses %j at the service before reading, without an HTTP guard',
    async (...roles) => {
      await expect(
        runWithContext(context(roles), async () => service.list(query)),
      ).rejects.toThrow();
      expect(read).not.toHaveBeenCalled();
    },
  );
});
