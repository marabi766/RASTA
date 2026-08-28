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
 *   live    — is the process running? If this fails, Kubernetes restarts us.
 *             It must never depend on anything external, or one flaky
 *             dependency turns into a restart loop across the fleet.
 *
 *   ready   — can we serve traffic? Checks only the dependencies without which
 *             every request would fail. Checking more than that turns a
 *             partial outage into a total one.
 *
 *   startup — has initialisation finished? Gives slow boots room without
 *             loosening the liveness threshold.
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
    // The database is the only hard dependency: without it every request
    // fails. Kafka being down delays event publication and freezes the asset
    // replica, but the outbox retains what has not gone out and the service
    // still answers — so it is reported as degraded, not as unready (ADR-021).
    const database = await this.prisma.isHealthy();

    const checks = { database, kafka: await this.publisher.isHealthy() };
    const ready = database;

    response.status(ready ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);

    return {
      status: ready ? 'ok' : 'unavailable',
      service: SERVICE_NAME,
      checks,
      degraded: ready && !checks.kafka ? ['kafka'] : [],
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
