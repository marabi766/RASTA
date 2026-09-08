import { Controller, Get, HttpStatus, Res, VERSION_NEUTRAL } from '@nestjs/common';
import { Public } from '@rasta/nest-common';
import type { Response } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { DomainProjectorConsumer } from '../consumers/domain-projector.consumer';
import { SERVICE_NAME } from '../config/env';

/**
 * Liveness and readiness.
 *
 * The distinction matters operationally:
 *
 *   live   — is the process up? If this fails, the orchestrator restarts us, so
 *            it must never depend on anything external or one flaky dependency
 *            becomes a restart loop across every replica.
 *
 *   ready  — can this service do its job? For a projector that means two
 *            things, and both are checked.
 *
 * ## Why the database check asks about INSERT specifically
 *
 * `SELECT 1` proves the socket is open. It does not prove this role can still
 * write, and writing is the entire job. A botched grant or a role change would
 * leave a connection that reads perfectly while every ingestion fails, and the
 * probe would keep reporting ready throughout. So readiness asks the catalogue
 * whether `current_user` still holds INSERT on `audit_event`.
 *
 * ## Why a stopped consumer is not ready
 *
 * A projector with no consumer is a service that answers health checks while
 * the evidence stops accumulating — the exact failure ADR-053 exists to
 * prevent, and the one nobody notices because nothing errors.
 *
 * Kafka connectivity itself is deliberately *not* a readiness failure: the
 * broker being briefly unreachable is what consumer retries are for, and
 * failing readiness would take a recovering service out of rotation.
 */
@Controller({ path: 'health', version: VERSION_NEUTRAL })
export class HealthController {
  private readonly startedAt = Date.now();

  constructor(
    private readonly prisma: PrismaService,
    private readonly projector: DomainProjectorConsumer,
  ) {}

  @Get('live')
  @Public('Liveness probe; exposed only on the internal network')
  live(): { status: string; service: string; uptimeSeconds: number } {
    return {
      status: 'ok',
      service: SERVICE_NAME,
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
    };
  }

  @Get('ready')
  @Public('Readiness probe; exposed only on the internal network')
  async ready(@Res({ passthrough: true }) response: Response): Promise<{
    status: string;
    service: string;
    checks: { database: boolean; projector: boolean };
    ingests: true;
    queryApi: false;
  }> {
    const database = await this.prisma.isHealthy();
    const projector = this.projector.isRunning();

    const ready = database && projector;
    response.status(ready ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);

    return {
      status: ready ? 'ok' : 'unavailable',
      service: SERVICE_NAME,
      checks: { database, projector },
      // Said in the payload rather than only in a doc. AUD-001 records
      // evidence; it cannot yet be asked for any. Anything discovering this
      // service by probing it should not conclude an audit query exists.
      ingests: true,
      queryApi: false,
    };
  }
}
