import { Controller, Get, HttpStatus, Res, VERSION_NEUTRAL } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Public } from '@rasta/nest-common';
import type { Response } from 'express';
import { Inject } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MAIL_CHANNEL } from '../tokens';
import type { MailChannel, MailChannelHealth } from '../channels/mail.channel.port';
import { DispatcherConsumer } from '../intake/dispatcher.consumer';
import { ResolutionWorker } from '../resolution/resolution.worker';
import { SERVICE_NAME } from '../config/env';

/**
 * Liveness and readiness.
 *
 *   live   — is the process up? Never depends on anything external, or one
 *            flaky dependency becomes a restart loop across every replica.
 *
 *   ready  — can this service do its job? NTF-001 gives it three things to
 *            check, and each one is a real check that can fail:
 *
 *            database   reachable, migrated, and this role can write an intent
 *                       and read an in-app row (`PrismaService.isHealthy`).
 *            consumer   the dispatcher group is running. A service that
 *                       answers health checks while consuming nothing is
 *                       exactly the failure nobody notices.
 *            worker     the resolution loop is running. Without it every
 *                       intent stays `PENDING` forever and nothing errors.
 *
 * Kafka connectivity itself is deliberately *not* a readiness failure: the
 * broker being briefly unreachable is what consumer retries are for, and
 * failing readiness would take a recovering service out of rotation.
 *
 * `deliversMessages` is kept from the scaffold and is now `true` for the
 * in-app channel only. No email has ever been sent from this platform, no
 * provider or sender identity has been chosen (ADR-054 § 6, Q-37), and the
 * probe says which channel it means rather than letting "delivers" be read
 * as more than it is.
 *
 * `mailChannel` reports the SMTP adapter that now exists behind the
 * `MailChannel` port, and it is deliberately a **separate** field from the two
 * above. "A mail server is reachable" and "this platform sends email" are
 * different facts, and collapsing them is the exact misreading Q-37 warns
 * about: the adapter can greet Mailpit all day while `EMAIL: false` stays
 * true, because no rule produces an email delivery and
 * `deliversToRealRecipients` is `false`.
 */
// Not in the published contract: the probes are orchestrator plumbing on the
// internal network, and `enrichOpenApiDocument()` stamps bearer security on
// every operation it finds — publishing two `@Public` routes as protected
// would be a contract that contradicts the router.
@ApiExcludeController()
@Controller({ path: 'health', version: VERSION_NEUTRAL })
export class HealthController {
  private readonly startedAt = Date.now();

  constructor(
    private readonly prisma: PrismaService,
    private readonly dispatcher: DispatcherConsumer,
    private readonly worker: ResolutionWorker,
    @Inject(MAIL_CHANNEL) private readonly mail: MailChannel,
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
    status: 'ok' | 'unavailable';
    service: string;
    dependencies: { database: boolean; consumer: boolean; worker: boolean };
    channels: { IN_APP: true; EMAIL: false };
    deliversMessages: { IN_APP: true; EMAIL: false };
    mailChannel: MailChannelHealth;
  }> {
    const dependencies = {
      database: await this.prisma.isHealthy(),
      consumer: this.dispatcher.isRunning(),
      worker: this.worker.isRunning(),
    };
    const ok = dependencies.database && dependencies.consumer && dependencies.worker;

    // Reported, never a readiness failure. Mailpit lives behind a compose
    // profile `pnpm infra:up` does not start, so depending on it would leave
    // every default stack permanently unready — the same reasoning that keeps
    // Kafka out of `dependencies`. It is also not yet load-bearing: nothing
    // sends email, so an unreachable server costs nothing today.
    const mailChannel = await this.mail.health();

    if (!ok) response.status(HttpStatus.SERVICE_UNAVAILABLE);

    return {
      status: ok ? 'ok' : 'unavailable',
      service: SERVICE_NAME,
      dependencies,
      channels: { IN_APP: true, EMAIL: false },
      deliversMessages: { IN_APP: true, EMAIL: false },
      mailChannel,
    };
  }
}
