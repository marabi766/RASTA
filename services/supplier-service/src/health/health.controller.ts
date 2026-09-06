import { Controller, Get, HttpCode, HttpStatus, Res, VERSION_NEUTRAL } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '@rasta/nest-common';
import { metricsText, metricsContentType } from '@rasta/observability';
import type { Response } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { KafkaEventPublisher } from '../outbox/kafka.publisher';
import { SERVICE_NAME } from '../config/env';

/**
 * Health and metrics.
 *
 * The distinction between the probes matters operationally:
 *
 *   live    — is the process running? If this fails, Kubernetes restarts us. It
 *             must never depend on anything external, or one flaky dependency
 *             turns into a restart loop across every replica.
 *
 *   ready   — can we serve traffic? Checks only the dependencies without which
 *             every request would fail. Checking more than that turns a partial
 *             outage into a total one.
 *
 *   startup — has initialisation finished? Gives slow boots room without
 *             loosening the liveness threshold.
 *
 * ## Kafka is a degradation, not a readiness failure
 *
 * The outbox is why. A broker outage stops nothing this service does: a
 * qualification is still decided, the row is still written and the event is
 * still durably queued — the relay drains it when Kafka returns (ADR-021).
 * Failing readiness on the broker would take a working service out of rotation
 * and turn a broker incident into a supplier-directory outage.
 *
 * It is still reported, in `checks` and in `degraded`, because a broker that has
 * been unreachable for an hour means every consumer's view of who is suspended
 * is an hour stale — which is exactly the kind of quiet divergence nobody
 * notices until somebody trades with a suspended supplier.
 */
@ApiTags('health')
@Controller({ path: 'health', version: VERSION_NEUTRAL })
export class HealthController {
  private readonly startedAt = Date.now();

  constructor(
    private readonly prisma: PrismaService,
    private readonly publisher: KafkaEventPublisher,
  ) {}

  @Get('live')
  @Public('Liveness probe; exposed only on the internal network')
  @ApiOperation({ summary: 'Process liveness' })
  live() {
    return {
      status: 'ok',
      service: SERVICE_NAME,
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
    };
  }

  @Get('ready')
  @Public('Readiness probe; exposed only on the internal network')
  @ApiOperation({ summary: 'Dependency readiness' })
  async ready(@Res({ passthrough: true }) response: Response) {
    const database = await this.prisma.isHealthy();
    const kafka = await this.publisher.isHealthy();

    const ready = database;
    response.status(ready ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);

    const degraded: string[] = [];
    if (ready && !kafka) degraded.push('kafka');

    return {
      status: ready ? 'ok' : 'unavailable',
      service: SERVICE_NAME,
      checks: { database, kafka },
      degraded,
      // Stated rather than left to be inferred. An operator reading this probe
      // during an incident should not have to work out from elsewhere whether a
      // degraded broker has quietly loosened anything. It has not: nothing is
      // approved, suspended or reinstated without a human, whatever this says.
      decisionsRequireAHuman: true,
    };
  }

  @Get('startup')
  @Public('Startup probe; exposed only on the internal network')
  @ApiOperation({ summary: 'Initialisation complete' })
  async startup(@Res({ passthrough: true }) response: Response) {
    const database = await this.prisma.isHealthy();
    response.status(database ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);

    return { status: database ? 'ok' : 'starting', checks: { database } };
  }

  @Get('version')
  @Public('Build identification; carries no business data')
  @ApiOperation({ summary: 'Build version' })
  version() {
    return {
      service: SERVICE_NAME,
      version: process.env.SERVICE_VERSION ?? '0.1.0',
      commit: process.env.GIT_COMMIT ?? 'unknown',
      builtAt: process.env.BUILD_TIME ?? 'unknown',
      node: process.version,
    };
  }
}

@Controller({ path: 'metrics', version: VERSION_NEUTRAL })
export class MetricsController {
  @Get()
  @HttpCode(200)
  @Public('Prometheus scrape target; reachable only from the monitoring namespace')
  async metrics(@Res({ passthrough: true }) response: Response): Promise<string> {
    response.setHeader('content-type', metricsContentType);
    return metricsText();
  }
}
