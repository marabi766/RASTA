import { Controller, Get, HttpCode, HttpStatus, Res, VERSION_NEUTRAL } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Public } from '@rasta/nest-common';
import { metricsContentType, metricsText } from '@rasta/observability';
import type { Response } from 'express';
// Imported for its registrations, so the exposition always carries the audit
// series whatever order the rest of the graph happens to load in.
import './metrics';

/**
 * The Prometheus scrape target.
 *
 * `GET /metrics`, version-neutral like the health probes, returning the shared
 * registry's text exposition: the platform defaults plus the ingestion, query,
 * capacity and chain-verification series `metrics.ts` registers.
 *
 * ## Why it is open, and why that exposes nothing
 *
 * A scraper carries no user token, so the route is `@Public` with a stated
 * reason — the only other exceptions to the global guards are the two probes.
 * What it serves is safe to serve that way because of the rule every audit
 * label obeys (ADR-053 § 13): no user, organization, actor, resource, event or
 * correlation id is ever a label, so the exposition is counts and durations
 * over sets fixed at deploy time. It is operational plumbing for the internal
 * network, not a business endpoint.
 *
 * ## Why it is not in the published contract
 *
 * The same reason as `HealthController`: `enrichOpenApiDocument()` stamps
 * bearer security on every operation it finds, so publishing an open route
 * would describe a protection it does not have. The audit contract stays its
 * four read paths.
 */
@ApiExcludeController()
@Controller({ path: 'metrics', version: VERSION_NEUTRAL })
export class MetricsController {
  @Get()
  @HttpCode(HttpStatus.OK)
  @Public('Prometheus scrape target; exposed only on the internal network, carries no identifiers')
  async metrics(@Res({ passthrough: true }) response: Response): Promise<string> {
    response.setHeader('content-type', metricsContentType);
    return metricsText();
  }
}
