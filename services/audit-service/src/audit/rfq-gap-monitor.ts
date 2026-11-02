import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ENV } from '../tokens';
import type { AuditEnv } from '../config/env';
import {
  auditIngestionFailuresTotal,
  auditRfqOverdueLinks,
  auditRfqPendingLinks,
  auditRfqPendingOldestAgeSeconds,
  INGESTION_FAILURE_REASONS,
} from '../observability/metrics';
import { RfqEvidenceRepository } from './rfq-evidence.repository';

/**
 * Makes an open gap in an RFQ's receipt chain loud (ADR-070 § 4, ADR-066 § 2).
 *
 * A receipt that arrives before its predecessor is held, not dead-lettered; that is
 * only safe if a hole which never closes cannot stay unnoticed. Sampled from the table
 * (the gauges are never maintained by inc/dec, and are computed over every held row):
 * the held count, the count older than `AUDIT_RFQ_GAP_ALERT_SECONDS` and the age of the
 * oldest are exported, and `RastaAuditRfqChainGapOpen` fires for as long as any overdue
 * gap exists. Each such receipt is also counted **once** under `rfq_chain_gap_overdue`
 * (a new gap, for the ingestion-failure alert). Identifiers of held events are never labels.
 */
@Injectable()
export class RfqGapMonitor implements OnModuleInit, OnModuleDestroy {
  /** Held receipts already counted, so a sample every minute does not count one forever. */
  private readonly alerted = new Set<string>();

  constructor(
    private readonly repository: RfqEvidenceRepository,
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
    const summary = await this.repository.pendingSummary(this.env.AUDIT_RFQ_GAP_ALERT_SECONDS);
    auditRfqPendingLinks.set(summary.held);
    auditRfqPendingOldestAgeSeconds.set(summary.oldestAgeSeconds);
    auditRfqOverdueLinks.set(summary.overdueCount);

    const overdue = new Set(summary.newlyOverdue);
    for (const id of this.alerted) if (!overdue.has(id)) this.alerted.delete(id);
    for (const id of overdue) {
      if (this.alerted.has(id)) continue;
      this.alerted.add(id);
      auditIngestionFailuresTotal.inc({
        reason: INGESTION_FAILURE_REASONS.RFQ_CHAIN_GAP_OVERDUE,
      });
    }
  }
}
