import { Controller, Get, HttpStatus, Res, VERSION_NEUTRAL } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Public } from '@rasta/nest-common';
import type { Response } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { DomainProjectorConsumer } from '../consumers/domain-projector.consumer';
import { AuditTrailConsumer } from '../consumers/audit-trail.consumer';
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
 *   ready  — can this service do its job? For a service with two input paths
 *            that means three things, and all three are checked.
 *
 * ## Why the database check asks about privileges specifically
 *
 * `SELECT 1` proves the socket is open. It does not prove this role can still
 * do the work. A botched grant or a role change would leave a connection that
 * reads perfectly while every ingestion fails — or, since AUD-002, one that
 * ingests perfectly while every subtree decision is refused — and the probe
 * would keep reporting ready throughout.
 *
 * So readiness asks the catalogue about the privileges **both** of this
 * service's paths need: INSERT and SELECT on `audit_event`, and SELECT, INSERT
 * and UPDATE on `organization_ref`. `PrismaService.isHealthy()` carries the
 * per-privilege reasoning; it asks the catalogue rather than attempting a
 * write, so a probe never leaves a row in an append-only store.
 *
 * ## Why either stopped consumer is not ready
 *
 * A consumer that is not running is a service that answers health checks while
 * the evidence stops accumulating — the exact failure ADR-053 exists to
 * prevent, and the one nobody notices because nothing errors. That is as true
 * of the audit trail (AUD-004 Phase B) as of the domain projector, so each is
 * reported separately and either one being down fails readiness: a combined
 * flag would let a healthy projector hide a stopped trail.
 *
 * Kafka connectivity itself is deliberately *not* a readiness failure: the
 * broker being briefly unreachable is what consumer retries are for, and
 * failing readiness would take a recovering service out of rotation.
 *
 * ## Why these routes are not in the published contract
 *
 * `@ApiExcludeController()`, for a reason stronger than tidiness. The OpenAPI
 * document describes the API this service offers callers, and these two probes
 * are not that — they are orchestrator plumbing on the internal network. More
 * concretely, `enrichOpenApiDocument()` stamps `security: [{ bearer: [] }]` on
 * every operation it finds, because every *documented* endpoint here is closed.
 * These two are `@Public`. Publishing them would therefore describe them as
 * requiring a bearer token that they neither demand nor check — a contract that
 * contradicts the router, in the direction that makes a reader trust a
 * protection that is not there.
 */
@ApiExcludeController()
@Controller({ path: 'health', version: VERSION_NEUTRAL })
export class HealthController {
  private readonly startedAt = Date.now();

  constructor(
    private readonly prisma: PrismaService,
    private readonly projector: DomainProjectorConsumer,
    private readonly trail: AuditTrailConsumer,
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
    checks: { database: boolean; projector: boolean; trail: boolean };
    ingests: true;
    queryApi: true;
  }> {
    const database = await this.prisma.isHealthy();
    const projector = this.projector.isRunning();
    const trail = this.trail.isRunning();

    const ready = database && projector && trail;
    response.status(ready ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);

    return {
      status: ready ? 'ok' : 'unavailable',
      service: SERVICE_NAME,
      checks: { database, projector, trail },
      // Said in the payload rather than only in a doc, and kept honest in both
      // directions: while `queryApi` was `false` it stated a real absence, and
      // AUD-002 built the read API, so it says so. A readiness payload that
      // under-reports is not "safely conservative" — it is a probe that
      // disagrees with the router, and the router is what serves callers.
      //
      // Still deliberately narrow: `trail: true` says the path-B consumer is
      // running. It does not claim that anything is publishing to that topic
      // right now, nor that producers are healthy — identity-service's outboxes
      // report their own state — and it claims no export, which is not built.
      ingests: true,
      queryApi: true,
    };
  }
}
