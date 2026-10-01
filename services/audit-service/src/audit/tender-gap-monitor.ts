import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ENV } from '../tokens';
import type { AuditEnv } from '../config/env';
import {
  auditIngestionFailuresTotal,
  auditTenderPendingLinks,
  auditTenderPendingOldestAgeSeconds,
  INGESTION_FAILURE_REASONS,
} from '../observability/metrics';
import { TenderEvidenceRepository } from './tender-evidence.repository';

/**
 * Makes an open gap in a tender's receipt chain loud (ADR-066 § 2).
 *
 * A receipt that arrives before its predecessor is held, not dead-lettered; that is
 * only safe if a hole which never closes cannot stay unnoticed. Sampled from the table
 * (the gauges are never maintained by inc/dec): every held receipt older than
 * `AUDIT_TENDER_GAP_ALERT_SECONDS` is counted **once** under
 * `tender_chain_gap_overdue`, which fires the ingestion-failure alert, and the held count
 * and the age of the oldest are exported. Identifiers of held events are never labels.
 */
@Injectable()
export class TenderGapMonitor implements OnModuleInit, OnModuleDestroy {
  /** Held receipts already counted, so a sample every minute does not count one forever. */
  private readonly alerted = new Set<string>();

  constructor(
    private readonly repository: TenderEvidenceRepository,
    @Inject(ENV) private readonly env: AuditEnv,
  ) {}

  private timer?: NodeJS.Timeout;

  onModuleInit(): void {
    const tick = (): void => {
      // Upkeep never takes the service down; the ingestion counter covers real faults.
      void this.sample().catch(() => undefined);
    };
    tick();
    this.timer = setInterval(tick, 60_000);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async sample(): Promise<void> {
    const summary = await this.repository.pendingSummary(this.env.AUDIT_TENDER_GAP_ALERT_SECONDS);
    auditTenderPendingLinks.set(summary.held);
    auditTenderPendingOldestAgeSeconds.set(summary.oldestAgeSeconds);

    const overdue = new Set(summary.overdue);
    for (const id of this.alerted) if (!overdue.has(id)) this.alerted.delete(id);
    for (const id of overdue) {
      if (this.alerted.has(id)) continue;
      this.alerted.add(id);
      auditIngestionFailuresTotal.inc({
        reason: INGESTION_FAILURE_REASONS.TENDER_CHAIN_GAP_OVERDUE,
      });
    }
  }
}
