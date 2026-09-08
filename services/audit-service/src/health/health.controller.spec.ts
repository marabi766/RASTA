import { HttpStatus } from '@nestjs/common';
import type { Response } from 'express';
import { HealthController } from './health.controller';
import type { PrismaService } from '../prisma/prisma.service';
import type { DomainProjectorConsumer } from '../consumers/domain-projector.consumer';
import { SERVICE_NAME } from '../config/env';

function build(database: boolean, projectorRunning: boolean) {
  const prisma = { isHealthy: async () => database } as unknown as PrismaService;
  const projector = { isRunning: () => projectorRunning } as unknown as DomainProjectorConsumer;

  let status: number | undefined;
  const response = { status: (code: number) => (status = code) } as unknown as Response;

  return {
    controller: new HealthController(prisma, projector),
    response,
    statusOf: () => status,
  };
}

describe('audit-service health probes', () => {
  it('reports the process as live without touching a dependency', () => {
    // Liveness must never depend on anything external: a failing liveness
    // probe restarts the container, so one flaky dependency would become a
    // restart loop across every replica.
    const live = build(false, false).controller.live();

    expect(live.status).toBe('ok');
    expect(live.service).toBe(SERVICE_NAME);
    expect(live.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it('is ready when the database accepts writes and the projector is running', async () => {
    const { controller, response, statusOf } = build(true, true);

    const ready = await controller.ready(response);

    expect(ready.status).toBe('ok');
    expect(ready.checks).toEqual({ database: true, projector: true });
    expect(statusOf()).toBe(HttpStatus.OK);
  });

  it('is not ready when the database check fails', async () => {
    // The check is `has_table_privilege(current_user, 'audit_event', 'INSERT')`,
    // not `SELECT 1`. A connection that reads but has lost INSERT fails every
    // ingestion while looking perfectly healthy.
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

  it('states that it ingests but exposes no query api', async () => {
    // Said in the payload, not only in a doc. Anything discovering this
    // service by probing it must not conclude an audit query exists: that is
    // AUD-002, and claiming it early is how a gap gets missed.
    const { controller, response } = build(true, true);

    const ready = await controller.ready(response);

    expect(ready.ingests).toBe(true);
    expect(ready.queryApi).toBe(false);
  });
});
