import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ENV } from '../tokens';
import type { AuditEnv } from '../config/env';
import { auditReconciliationEvidenceMissing } from '../observability/metrics';
import { AuditRepository } from './audit.repository';

/**
 * Makes a missing payment-reconciliation evidence row loud (D-046; Codex on
 * #204, HIGH 1).
 *
 * The projector writes an evidence row in the same transaction as the audit row
 * of every `PAYMENT_RECONCILIATION_RESOLVED` and `_OPERATOR_ACTION`. Two things
 * can still leave an audit row without one, and neither raises anything at
 * write time: a replica running a version from before the projection (during a
 * rolling deploy), and an event already marked processed before the projection
 * existed — `ingest` returns `DUPLICATE` before it would write. So this samples
 * the tables, once a minute, for audit rows of those two events **written**
 * (`recorded_at`) inside `AUDIT_RECONCILIATION_EVIDENCE_LOOKBACK_HOURS` that
 * have no evidence row, and exports the count;
 * `RastaAuditReconciliationEvidenceMissing` fires while it is above zero.
 * Runbook: `docs/runbooks/audit-gap-detected.md`.
 *
 * The window is on when the row was written, not when the event happened
 * (Codex on #204, round 2): a late delivery of an old event — the case an old
 * replica during a rollout produces — opens its gap now, and is counted now.
 *
 * The count is one platform-level number across tenants, read under
 * `runUnscoped` and exported with no label; see
 * `AuditRepository.countMissingReconciliationEvidence` for why that is the
 * documented exception to A-04 and what it may never return.
 */
@Injectable()
export class ReconciliationEvidenceMonitor implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly repository: AuditRepository,
    @Inject(ENV) private readonly env: AuditEnv,
  ) {}

  onModuleInit(): void {
    const tick = (): void => {
      // Upkeep never takes the service down. A sample that fails leaves the
      // last value in place rather than reporting a reassuring zero.
      void this.sample().catch(() => undefined);
    };
    tick();
    this.timer = setInterval(tick, 60_000);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Counts the gaps written inside the look-back window and exports the number. */
  async sample(now: Date = new Date()): Promise<number> {
    const since = new Date(
      now.getTime() - this.env.AUDIT_RECONCILIATION_EVIDENCE_LOOKBACK_HOURS * 3_600_000,
    );
    const missing = await this.repository.countMissingReconciliationEvidence(since);
    auditReconciliationEvidenceMissing.set(missing);
    return missing;
  }
}
