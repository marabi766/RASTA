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
 * neither: the scaffold owns no schema, opens no Prisma client, runs no outbox
 * relay and registers no consumer (ADR-054 is `Proposed`; NTF-001 has not
 * started).
 *
 * The alternative would be a probe returning `checks: { database: true }` from
 * a constant, which is the failure mode this comment exists to prevent. A
 * readiness probe is read during an incident by somebody deciding whether a
 * dependency is at fault, and one reporting a healthy database this process
 * never opened is worse than no probe at all.
 *
 * So `ready` answers the only question the process can answer — the listener is
 * up — and `dependencies` is empty, which is the true set. When NTF-001 adds
 * the schema, the dispatcher group and the relay, each becomes a real check and
 * readiness starts being able to fail.
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
    deliversMessages: false;
  } {
    return {
      status: 'ok',
      service: SERVICE_NAME,
      // Empty because it is empty, not because nothing was checked.
      dependencies: {},
      implemented: false,
      // Said separately and said plainly. This platform has never sent an
      // email, no provider or sender identity has been chosen (ADR-054 § 6,
      // Q-37), and a service named `notification` answering a green probe is
      // exactly the thing somebody could mistake for one that delivers.
      deliversMessages: false,
    };
  }
}
