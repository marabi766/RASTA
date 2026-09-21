import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { createSystemContext, runWithContext } from '@rasta/nest-common';
import type { NotificationIntent } from '../generated/prisma';
// Type-only: built by an explicit `useFactory` in `app.module.ts`.
import type { NotificationRepository } from '../notification/notification.repository';
import { LeaseLostError, type ResolvedRecipient } from '../notification/notification.repository';
import type { RecipientPort } from '../recipients/recipient.port';
import { RecipientResolutionError } from '../recipients/recipient.port';
import { ruleForKey, TEMPLATE_CATALOGUE_VERSION, type NotificationRule } from '../rules/rules';
import { renderInApp, RenderError, type RenderedInApp } from '../rules/render';
import { emailTemplateForRule } from '../channels/email-templates';
import type { ContextData } from '../rules/context-sanitiser';
import type { ScrubbedLogger } from '../logging/scrub';
import { nextResolutionAt } from './backoff';
import { CHANNEL_DEFAULTS } from '../preferences/defaults';
import { SERVICE_NAME } from '../config/env';
import {
  notificationDeliveriesTotal,
  notificationIntentsPending,
  notificationOldestPendingAgeSeconds,
  notificationRecipientTruncatedTotal,
  notificationResolutionFailuresTotal,
  notificationSuppressedTotal,
  RESOLUTION_FAILURE_REASONS,
  SUPPRESSION_REASONS,
} from '../observability/metrics';

export interface ResolutionWorkerOptions {
  readonly pollIntervalMs: number;
  readonly batchSize: number;
  readonly leaseSeconds: number;
  readonly backoffMaxSeconds: number;
  readonly maxRecipients: number;
  readonly inAppTtlDays: number;
  /** Names this replica on the claim row, so a stuck lease can be attributed. */
  readonly owner: string;
}

/** The bounded error class written to a delivery whose template could not render. */
const RENDER_FAILED = 'RENDER_FAILED';

/** How often the pending gauges are sampled from the table. */
const GAUGE_INTERVAL_MS = 15_000;

/**
 * Turns pending intents into deliveries — the send path, separated from the
 * consume path on purpose (ADR-054 § 1, § 9 invariant 1).
 *
 * Timer-driven and safe on every replica: `claimPending` leases disjoint rows
 * with `FOR UPDATE SKIP LOCKED`, and every write that spends a lease is
 * fenced on the token it was given. The shape is ADR-050's, deliberately, so
 * the platform has one concurrency pattern rather than two.
 *
 * ## Per-intent outcomes
 *
 *   identity unavailable  → deferred with backoff; `PENDING` stays `PENDING`,
 *                           `resolutionAttempts` climbs, the partition that
 *                           produced the event has long since moved on.
 *   nobody entitled       → `SUPPRESSED` / `NO_ELIGIBLE_RECIPIENT`, recorded.
 *   template cannot render→ every delivery `FAILED` with a `PERMANENT_FAILURE`
 *                           attempt. Not a dead-lettered event: the event was
 *                           fine (ADR § 9).
 *   otherwise             → one `SENT` in-app delivery per recipient.
 */
@Injectable()
export class ResolutionWorker implements OnApplicationShutdown {
  private timer?: NodeJS.Timeout;
  private gaugeTimer?: NodeJS.Timeout;
  private inFlight?: Promise<void>;
  private stopped = false;

  constructor(
    private readonly repository: NotificationRepository,
    private readonly recipients: RecipientPort,
    private readonly options: ResolutionWorkerOptions,
    private readonly logger: ScrubbedLogger,
  ) {}

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => void this.tickGuarded(), this.options.pollIntervalMs);
    this.timer.unref?.();

    const sample = (): Promise<void> => this.sampleGauges();
    void sample();
    this.gaugeTimer = setInterval(() => void sample(), GAUGE_INTERVAL_MS);
    this.gaugeTimer.unref?.();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.stop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.gaugeTimer) clearInterval(this.gaugeTimer);
    this.timer = undefined;
    this.gaugeTimer = undefined;
    // A batch that is mid-flight finishes; a lease abandoned half-written
    // would only be picked up again after it expired.
    await this.inFlight;
  }

  isRunning(): boolean {
    return this.timer !== undefined && !this.stopped;
  }

  /** Overlapping ticks are skipped rather than queued: one batch at a time per replica. */
  private tickGuarded(): Promise<void> {
    if (this.inFlight || this.stopped) return Promise.resolve();
    const run = this.tick()
      .then(() => undefined)
      .catch((error: unknown) => {
        // Upkeep must never take the service down. A persistent fault shows
        // up as the pending gauge climbing and the failure counter moving.
        this.logger.error(`Resolution tick failed: ${describe(error)}`);
      })
      .finally(() => {
        this.inFlight = undefined;
      });
    this.inFlight = run;
    return run;
  }

  /**
   * One batch: claim, then process each intent in its own tenant context.
   * Exposed so the integration suites can drive the worker deterministically
   * instead of waiting on the timer.
   */
  async tick(): Promise<number> {
    const claimed = await this.repository.claimPending(
      this.options.owner,
      this.options.batchSize,
      this.options.leaseSeconds,
    );

    for (const intent of claimed) {
      await runWithContext(
        createSystemContext({
          correlationId: intent.correlationId,
          organizationId: intent.organizationId,
          callerService: SERVICE_NAME,
        }),
        // `async` on purpose: the guard's context must still be open when the
        // lazy Prisma promises inside actually run (PROJECT_MEMORY § 30).
        async () => this.processIntent(intent),
      );
    }

    return claimed.length;
  }

  async processIntent(intent: NotificationIntent): Promise<void> {
    const rule = ruleForKey(intent.ruleKey);
    if (!rule) {
      // A rule removed from the catalogue after its intent was written. Nothing
      // can be rendered for it; recorded as suppressed rather than retried
      // forever against a catalogue that will not change under the retry.
      await this.suppress(intent, SUPPRESSION_REASONS.RULE_UNKNOWN);
      return;
    }

    let resolved;
    try {
      resolved = await this.recipients.resolve({
        organizationId: intent.organizationId,
        roles: rule.recipientRoles,
        limit: this.options.maxRecipients,
        correlationId: intent.correlationId,
      });
    } catch (error) {
      await this.defer(intent, error);
      return;
    }

    if (resolved.truncated) {
      notificationRecipientTruncatedTotal.inc({ rule_key: rule.ruleKey });
      this.logger.warn(
        `Intent ${intent.id} (${rule.ruleKey}) resolved more recipients than the ceiling of ${this.options.maxRecipients}; list truncated`,
      );
    }

    if (resolved.recipients.length === 0) {
      await this.suppress(intent, SUPPRESSION_REASONS.NO_ELIGIBLE_RECIPIENT);
      return;
    }

    const rendered = this.render(rule, intent);
    const recipients: ResolvedRecipient[] = resolved.recipients.map((candidate) => ({
      userId: candidate.userId,
      role: candidate.role,
      email: candidate.email,
    }));
    const emailTemplate = emailTemplateForRule(rule.ruleKey);

    try {
      const written = await this.repository.dispatch({
        intent,
        recipients,
        rendered,
        templateVersion: TEMPLATE_CATALOGUE_VERSION,
        inAppTtlDays: this.options.inAppTtlDays,
        rule: {
          ruleKey: rule.ruleKey,
          category: rule.category,
          classification: rule.classification,
          severity: rule.severity,
          mandatoryChannels: rule.mandatoryChannels,
        },
        channelDefaults: CHANNEL_DEFAULTS,
        emailTemplate: emailTemplate
          ? { key: emailTemplate.key, version: emailTemplate.version }
          : null,
      });
      const status = 'errorClass' in rendered ? 'FAILED' : 'SENT';
      // Counted apart, because they are different facts. A suppressed delivery
      // was neither sent nor failed; folding it into either would make the
      // delivery success rate a number about preferences rather than delivery.
      //
      // Email is counted apart from in-app for a second reason: an email row
      // leaves this transaction **queued**, not delivered. Counting it as sent
      // here would make the success rate a measurement of this service's
      // willingness to try.
      const delivered = recipients.length - written.inAppSuppressed;
      if (delivered > 0) {
        notificationDeliveriesTotal.inc({ channel: 'IN_APP', status }, delivered);
      }
      if (written.inAppSuppressed > 0) {
        notificationDeliveriesTotal.inc(
          { channel: 'IN_APP', status: 'SUPPRESSED' },
          written.inAppSuppressed,
        );
      }
      if (written.emailQueued > 0) {
        notificationDeliveriesTotal.inc(
          { channel: 'EMAIL', status: 'QUEUED' },
          written.emailQueued,
        );
      }
      if (written.emailSuppressed > 0) {
        notificationDeliveriesTotal.inc(
          { channel: 'EMAIL', status: 'SUPPRESSED' },
          written.emailSuppressed,
        );
      }
      this.logger.info(
        `Intent ${intent.id} (${rule.ruleKey}) dispatched: ${delivered} in-app deliveries ${status}, ` +
          `${written.inAppSuppressed} suppressed by preference, ${written.inApp} rows, ` +
          `${written.emailQueued} email queued (${written.emailDeferred} until quiet hours end), ` +
          `${written.emailSuppressed} email suppressed`,
      );
    } catch (error) {
      if (error instanceof LeaseLostError) {
        notificationResolutionFailuresTotal.inc({ reason: RESOLUTION_FAILURE_REASONS.LEASE_LOST });
        this.logger.warn(
          `Intent ${intent.id} lease was taken over before dispatch committed; nothing written`,
        );
        return;
      }
      throw error;
    }
  }

  private render(
    rule: NotificationRule,
    intent: NotificationIntent,
  ): RenderedInApp | { errorClass: string } {
    try {
      return renderInApp(rule.template, intent.contextData as ContextData);
    } catch (error) {
      const detail =
        error instanceof RenderError ? `missing ${error.missing.join(', ')}` : describe(error);
      this.logger.error(
        `Intent ${intent.id} (${rule.ruleKey}) cannot render ${rule.template.key}: ${detail}`,
      );
      return { errorClass: RENDER_FAILED };
    }
  }

  private async defer(intent: NotificationIntent, error: unknown): Promise<void> {
    const reason =
      error instanceof RecipientResolutionError
        ? error.reason
        : RESOLUTION_FAILURE_REASONS.UNREACHABLE;
    notificationResolutionFailuresTotal.inc({ reason });

    const retryAt = nextResolutionAt(intent.resolutionAttempts, this.options.backoffMaxSeconds);
    const kept = await this.repository.deferResolution(intent, reason, retryAt);
    this.logger.warn(
      `Intent ${intent.id} recipient resolution failed (${reason}); ` +
        (kept
          ? `attempt ${intent.resolutionAttempts + 1} recorded, retry at ${retryAt.toISOString()}`
          : 'lease no longer held, another worker owns the retry'),
    );
  }

  private async suppress(intent: NotificationIntent, reason: string): Promise<void> {
    const done = await this.repository.suppress(intent, reason);
    if (done) {
      notificationSuppressedTotal.inc({ reason });
      this.logger.info(`Intent ${intent.id} suppressed: ${reason}`);
    }
  }

  private async sampleGauges(): Promise<void> {
    try {
      const summary = await this.repository.pendingSummary();
      notificationIntentsPending.set(summary.pending);
      notificationOldestPendingAgeSeconds.set(summary.oldestAgeSeconds);
    } catch {
      // Sampling is best-effort; a failure here is not an outage.
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
