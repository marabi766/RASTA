import { HttpStatus } from '@nestjs/common';
import { HealthController, MetricsController } from './health.controller';
import type { PrismaService } from '../prisma/prisma.service';
import type { MaintenanceFactsConsumer } from '../maintenance/maintenance-facts.consumer';
import type { AnalyticsEnv } from '../config/env';

/**
 * The probes, and the one distinction that matters operationally: readiness fails on the
 * database, without which every dashboard fails, and **not** on the projection — a stopped
 * consumer costs freshness, not answers.
 */

function controller(
  database: boolean,
  projection: { enabled: boolean; running: boolean } = { enabled: true, running: true },
): HealthController {
  return new HealthController(
    { isHealthy: async () => database } as unknown as PrismaService,
    { isRunning: () => projection.running } as unknown as MaintenanceFactsConsumer,
    { ANALYTICS_MAINTENANCE_FACTS_CONSUMER_ENABLED: projection.enabled } as AnalyticsEnv,
  );
}

function response() {
  const captured = { status: 0 };
  return {
    captured,
    res: { status: (code: number) => ((captured.status = code), undefined) } as unknown as never,
  };
}

describe('liveness', () => {
  it('depends on nothing external', () => {
    const body = controller(false).live();
    expect(body.status).toBe('ok');
    expect(body.service).toBe('analytics-service');
  });
});

describe('readiness', () => {
  it('is ready with a healthy database and a running projection', async () => {
    const { captured, res } = response();
    const body = await controller(true).ready(res);

    expect(captured.status).toBe(HttpStatus.OK);
    expect(body.checks).toEqual({ database: true, maintenanceFacts: 'running' });
    expect(body.degraded).toEqual([]);
  });

  it('is unavailable without a database, and reports nothing else as degraded', async () => {
    const { captured, res } = response();
    const body = await controller(false, { enabled: true, running: false }).ready(res);

    expect(captured.status).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect(body.status).toBe('unavailable');
    expect(body.degraded).toEqual([]);
  });

  it('stays ready with a stopped projection, and says it is degraded', async () => {
    const { captured, res } = response();
    const body = await controller(true, { enabled: true, running: false }).ready(res);

    expect(captured.status).toBe(HttpStatus.OK);
    expect(body.checks.maintenanceFacts).toBe('stopped');
    expect(body.degraded).toEqual(['maintenanceFacts']);
  });

  it('reports a projection that is not enabled as disabled, a decision rather than a fault', async () => {
    const { res } = response();
    const body = await controller(true, { enabled: false, running: false }).ready(res);

    expect(body.checks.maintenanceFacts).toBe('disabled');
    expect(body.degraded).toEqual([]);
  });
});

describe('startup', () => {
  it('waits on the database and nothing else', async () => {
    const first = response();
    expect(
      (await controller(true, { enabled: true, running: false }).startup(first.res)).status,
    ).toBe('ok');
    expect(first.captured.status).toBe(HttpStatus.OK);

    const second = response();
    expect((await controller(false).startup(second.res)).status).toBe('starting');
    expect(second.captured.status).toBe(HttpStatus.SERVICE_UNAVAILABLE);
  });
});

describe('version and metrics', () => {
  it('carries build identification and no business data', () => {
    const body = controller(true).version();
    expect(body.service).toBe('analytics-service');
    expect(Object.keys(body).sort()).toEqual(['builtAt', 'commit', 'node', 'service', 'version']);
  });

  it('serves the Prometheus text format, with the projection counter and no tenant label', async () => {
    let contentType = '';
    const text = await new MetricsController().metrics({
      setHeader: (_name: string, value: string) => (contentType = value),
    } as never);
    expect(contentType).toContain('text/plain');
    expect(text).toContain('rasta_analytics_facts_projected_total');
    expect(text).not.toMatch(/organization/i);
  });
});
