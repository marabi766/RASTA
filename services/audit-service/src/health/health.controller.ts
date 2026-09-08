import { Controller, Get, VERSION_NEUTRAL } from '@nestjs/common';
import { Public } from '@rasta/nest-common';
import { SERVICE_NAME } from '../config/env';

/**
 * Liveness and readiness.
 *
 * ## Why `ready` checks nothing, and why that is honest rather than lazy
 *
 * Every other service in this repository checks a database here, and several
 * report a broker as a degradation. This one checks neither, because it has
 * neither: the scaffold owns no schema, opens no Prisma client and registers no
 * consumer (ADR-053 is `Proposed`; AUD-001 has not started).
 *
 * The alternative would be a probe that returns `checks: { database: true }`
 * from a constant, and that is the failure mode this comment exists to prevent.
 * A readiness probe is read during an incident by someone deciding whether a
 * dependency is at fault, and one that reports a healthy database this process
 * never opened is worse than no probe at all.
 *
 * So `ready` answers the only question the process can actually answer — the
 * HTTP listener is up and serving — and `dependencies` is empty, which is the
 * true set. When AUD-001 adds the schema and the consumer group, each becomes a
 * real check here, and readiness starts being able to fail.
 */
@Controller({ path: 'health', version: VERSION_NEUTRAL })
export class HealthController {
  private readonly startedAt = Date.now();

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
  ready(): {
    status: string;
    service: string;
    dependencies: Record<string, never>;
    implemented: false;
  } {
    return {
      status: 'ok',
      service: SERVICE_NAME,
      // Empty because it is empty, not because nothing was checked.
      dependencies: {},
      // Stated in the payload, not only in a comment. Anything that discovers
      // this service by probing it should be told plainly that no audit
      // evidence is ingested, stored or queryable here yet.
      implemented: false,
    };
  }
}
