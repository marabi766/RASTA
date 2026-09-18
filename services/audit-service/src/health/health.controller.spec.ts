import { HttpStatus } from '@nestjs/common';
import type { Response } from 'express';
import { HealthController } from './health.controller';
import type { PrismaService } from '../prisma/prisma.service';
import type { DomainProjectorConsumer } from '../consumers/domain-projector.consumer';
import type { AuditTrailConsumer } from '../consumers/audit-trail.consumer';
import { SERVICE_NAME } from '../config/env';

function build(database: boolean, projectorRunning: boolean, trailRunning = true) {
  const prisma = { isHealthy: async () => database } as unknown as PrismaService;
  const projector = { isRunning: () => projectorRunning } as unknown as DomainProjectorConsumer;
  const trail = { isRunning: () => trailRunning } as unknown as AuditTrailConsumer;

  let status: number | undefined;
  const response = { status: (code: number) => (status = code) } as unknown as Response;

  return {
    controller: new HealthController(prisma, projector, trail),
    response,
    statusOf: () => status,
  };
}

describe('audit-service health probes', () => {
  it('reports the process as live without touching a dependency', () => {
    // Liveness must never depend on anything external: a failing liveness
    // probe restarts the container, so one flaky dependency would become a
    // restart loop across every replica.
    const live = build(false, false, false).controller.live();

    expect(live.status).toBe('ok');
    expect(live.service).toBe(SERVICE_NAME);
    expect(live.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it('is ready when the database accepts writes and both consumers are running', async () => {
    const { controller, response, statusOf } = build(true, true, true);

    const ready = await controller.ready(response);

    expect(ready.status).toBe('ok');
    expect(ready.checks).toEqual({ database: true, projector: true, trail: true });
    expect(statusOf()).toBe(HttpStatus.OK);
  });

  it('is not ready when the database check fails', async () => {
    // The check is a `has_table_privilege` conjunction over both paths — INSERT
    // and SELECT on `audit_event`, SELECT/INSERT/UPDATE on `organization_ref` —
    // not `SELECT 1`. A connection that reads but has lost INSERT fails every
    // ingestion while looking perfectly healthy, and one that has lost SELECT
    // on `organization_ref` refuses every union administrator their subtree.
    const { controller, response, statusOf } = build(false, true);

    const ready = await controller.ready(response);

    expect(ready.status).toBe('unavailable');
    expect(ready.checks.database).toBe(false);
    expect(statusOf()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
  });

  it('is not ready when the projector is not running', async () => {
    // A projector with no consumer answers health checks while the evidence
    // stops accumulating — the failure nobody notices, because nothing errors.
    const { controller, response, statusOf } = build(true, false);

    const ready = await controller.ready(response);

    expect(ready.status).toBe('unavailable');
    expect(ready.checks.projector).toBe(false);
    expect(statusOf()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
  });

  it('is not ready when the audit-trail consumer is not running, however healthy the projector is', async () => {
    // AUD-004 Phase B. The negative control for a combined flag: with a healthy
    // database and a running projector, a stopped trail must still fail
    // readiness, and the payload must say which of the two it was.
    const { controller, response, statusOf } = build(true, true, false);

    const ready = await controller.ready(response);

    expect(ready.status).toBe('unavailable');
    expect(ready.checks).toEqual({ database: true, projector: true, trail: false });
    expect(statusOf()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
  });

  it('is not ready when neither consumer is running', async () => {
    const { controller, response, statusOf } = build(true, false, false);

    const ready = await controller.ready(response);

    expect(ready.checks).toEqual({ database: true, projector: false, trail: false });
    expect(statusOf()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
  });

  it('states that it both ingests and serves a query api', async () => {
    // Said in the payload, not only in a doc, and it has to match the router.
    // While AUD-002 was unbuilt this read `queryApi: false` and that was the
    // truth; the read API exists now, so a probe that still said `false` would
    // be a readiness payload disagreeing with the routes the service serves.
    const { controller, response } = build(true, true);

    const ready = await controller.ready(response);

    expect(ready.ingests).toBe(true);
    expect(ready.queryApi).toBe(true);
  });
});
