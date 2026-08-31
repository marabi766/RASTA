import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Res,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '@rasta/nest-common';
import { metricsText, metricsContentType } from '@rasta/observability';
import type { Response } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { KafkaEventPublisher } from '../outbox/kafka.publisher';
import { MALWARE_SCANNER, OBJECT_STORAGE } from '../tokens';
import type { ObjectStorage } from '../storage/storage.port';
import type { MalwareScanner } from '../scanning/scanner.port';
import { SERVICE_NAME } from '../config/env';

/**
 * Health and metrics.
 *
 * The distinction between the probes matters operationally:
 *
 *   live    — is the process running? If this fails, Kubernetes restarts us.
 *             It must never depend on anything external, or one flaky
 *             dependency turns into a restart loop across the document.
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
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    @Inject(MALWARE_SCANNER) private readonly scanner: MalwareScanner,
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
    // Two hard dependencies here rather than one. The database is obvious.
    // Object storage is the other, and it is what makes this service different
    // from every other in the platform: without a reachable bucket there is no
    // upload URL to issue, no object to confirm and no download to sign, so
    // every meaningful request fails. Reporting ready without it would send
    // traffic to a service that can only return errors.
    //
    // Kafka stays a degradation rather than a failure: the outbox retains what
    // has not gone out and the service still answers (ADR-021).
    const [database, objectStorage, scanner] = await Promise.all([
      this.prisma.isHealthy(),
      this.storage.isHealthy(),
      this.scanner.health(),
    ]);

    const kafka = await this.publisher.isHealthy();

    // ## Why the scanner is a degradation and not a readiness failure
    //
    // It is reported separately from storage and the database because it is a
    // genuinely different dependency with a genuinely different consequence,
    // and collapsing the three into one boolean would hide which is which
    // (ADR-049).
    //
    // A scanner outage does not stop this service from doing its job
    // correctly. Uploads still work, metadata still reads, deletions still
    // record, and documents queue as `PENDING` — undownloadable, which is the
    // fail-closed direction and exactly what should happen. Failing readiness
    // instead would take the whole service out of rotation and break the three
    // things that still work perfectly, to no security benefit: a download is
    // refused by `canDownload` whether or not this probe returns 503.
    //
    // What it must not do is go unnoticed, which is why it is in `checks`, in
    // `degraded`, and behind two metrics (`rasta_document_scanner_up`,
    // `rasta_document_scan_signature_age_seconds`). A stale signature database
    // is called out on its own: scanning still works and still answers, so the
    // only symptom is documents quietly failing to clear.
    const scannerHealthy = scanner.available && scanner.signaturesFresh;

    const checks = {
      database,
      objectStorage,
      kafka,
      scanner: {
        available: scanner.available,
        engine: scanner.engine,
        engineVersion: scanner.engineVersion,
        signatureVersion: scanner.signatureVersion,
        signatureAgeSeconds: scanner.signatureAgeSeconds,
        signaturesFresh: scanner.signaturesFresh,
        // A reason code or a short sentence, never an exception message: this
        // endpoint is unauthenticated and a socket error carries the address
        // (AGENTS.md S-09).
        detail: scanner.detail,
      },
    };

    const ready = database && objectStorage;

    response.status(ready ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);

    const degraded: string[] = [];
    if (ready && !kafka) degraded.push('kafka');
    if (ready && !scanner.available) degraded.push('scanner');
    else if (ready && !scanner.signaturesFresh) degraded.push('scanner-signatures');

    return {
      status: ready ? 'ok' : 'unavailable',
      service: SERVICE_NAME,
      checks,
      degraded,
      // Stated rather than left to be inferred from `scanner.available`. An
      // operator reading this probe during an incident should not have to know
      // that `canDownload` allows only CLEAN to work out whether an outage has
      // opened anything up. It has not, and this says so.
      downloadsRequireCleanScan: true,
      scannerHealthy,
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
