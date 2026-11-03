import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ENV } from '../tokens';
import { PrismaService } from '../prisma/prisma.service';
import { SamplingLoop } from './sampling-loop';
import type { AuditEnv } from '../config/env';
import {
  auditIngestionFailuresTotal,
  auditTenderOverdueLinks,
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
 * (the gauges are never maintained by inc/dec, and are computed over every held row):
 * the held count, the count older than `AUDIT_TENDER_GAP_ALERT_SECONDS` and the age of the
 * oldest are exported, and `RastaAuditTenderChainGapOpen` fires for as long as any overdue
 * gap exists. Each such receipt is also counted **once** under `tender_chain_gap_overdue`
 * (a new gap, for the ingestion-failure alert). Identifiers of held events are never labels.
 */
@Injectable()
export class TenderGapMonitor implements OnModuleInit, OnModuleDestroy {
  /** Held receipts already counted, so a sample every minute does not count one forever. */
  private readonly alerted = new Set<string>();

  private readonly loop = new SamplingLoop(() => this.sample());

  constructor(
    private readonly repository: TenderEvidenceRepository,
    @Inject(ENV) private readonly env: AuditEnv,
    prisma: PrismaService,
  ) {
    // Ordered before the client's disconnect (Nest destroys providers concurrently, so
    // this monitor's own hook is not enough): `PrismaService.onModuleDestroy` awaits it.
    prisma.beforeDisconnect(() => this.loop.stop());
  }

  onModuleInit(): void {
    this.loop.start();
  }

  async onModuleDestroy(): Promise<void> {
    await this.loop.stop();
  }

  async sample(): Promise<void> {
    const summary = await this.repository.pendingSummary(this.env.AUDIT_TENDER_GAP_ALERT_SECONDS);
    auditTenderPendingLinks.set(summary.held);
    auditTenderPendingOldestAgeSeconds.set(summary.oldestAgeSeconds);
    auditTenderOverdueLinks.set(summary.overdueCount);

    const overdue = new Set(summary.newlyOverdue);
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
