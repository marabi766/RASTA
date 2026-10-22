import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Res,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import { ApiExcludeController, ApiOperation } from '@nestjs/swagger';
import { Public } from '@rasta/nest-common';
import { metricsText, metricsContentType } from '@rasta/observability';
import type { Response } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { MaintenanceFactsConsumer } from '../maintenance/maintenance-facts.consumer';
import { SERVICE_NAME, type AnalyticsEnv } from '../config/env';
import { ENV } from '../tokens';

/**
 * Health and metrics.
 *
 *   live    — is the process running? Never depends on anything external, or one flaky
 *             dependency becomes a restart loop across every replica.
 *   ready   — can we serve traffic? The database only: every dashboard reads it.
 *   startup — has initialisation finished?
 *
 * ## The projection is a degradation, not a readiness failure
 *
 * A stopped consumer stops nothing a reader asks: the dashboards still answer from the facts
 * held. It is reported, in `checks` and in `degraded`, because a projection that has been
 * stopped for an hour means every dashboard is an hour behind. When the projection is not
 * enabled (`ANALYTICS_MAINTENANCE_FACTS_CONSUMER_ENABLED=false`) it is reported as `disabled`,
 * which is a deployment decision, not a fault.
 */
@ApiExcludeController()
@Controller({ path: 'health', version: VERSION_NEUTRAL })
export class HealthController {
  private readonly startedAt = Date.now();

  constructor(
    private readonly prisma: PrismaService,
    private readonly projection: MaintenanceFactsConsumer,
    @Inject(ENV) private readonly env: AnalyticsEnv,
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
    const projection = !this.env.ANALYTICS_MAINTENANCE_FACTS_CONSUMER_ENABLED
      ? 'disabled'
      : this.projection.isRunning()
        ? 'running'
        : 'stopped';

    response.status(database ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);

    return {
      status: database ? 'ok' : 'unavailable',
      service: SERVICE_NAME,
      checks: { database, maintenanceFacts: projection },
      degraded: database && projection === 'stopped' ? ['maintenanceFacts'] : [],
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

@ApiExcludeController()
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
