import { Counter, Gauge, registry } from '@rasta/observability';

/**
 * Metrics owned by construction-service.
 *
 * Only the ones answering a question an operator will actually ask. The
 * platform-wide series — outbox lag, HTTP latency, authorization denials — are
 * defined in `@rasta/observability` and not duplicated here.
 *
 * **No unbounded cardinality, and nothing that identifies a tenant.** No label
 * carries an `organizationId`, a `projectId` or a title (AGENTS.md S-09). The
 * labels used — a lifecycle transition, an endpoint template — are fixed, small
 * enumerations.
 */

export const projectTransitionsTotal = new Counter({
  name: 'rasta_construction_project_transitions_total',
  help: 'Project lifecycle commands that committed, by command',
  labelNames: ['service', 'command'] as const,
  registers: [registry],
});

export const needTransitionsTotal = new Counter({
  name: 'rasta_construction_need_transitions_total',
  help: 'Project-need lifecycle commands that committed, by command',
  labelNames: ['service', 'command'] as const,
  registers: [registry],
});

export const tenderTransitionsTotal = new Counter({
  name: 'rasta_construction_tender_transitions_total',
  help: 'Tender lifecycle commands that committed, by command',
  labelNames: ['service', 'command'] as const,
  registers: [registry],
});

/**
 * Compare-and-set losses: a command refused because the row changed under it.
 *
 * A steady rate is normal concurrency; a spike on one command is two clients
 * fighting over the same projects, which is worth knowing before users report
 * "my change keeps being rejected".
 */
export const versionConflictsTotal = new Counter({
  name: 'rasta_construction_version_conflicts_total',
  help: 'Commands refused with OPTIMISTIC_LOCK_FAILED, by aggregate',
  labelNames: ['service', 'aggregate'] as const,
  registers: [registry],
});

export const idempotentReplaysTotal = new Counter({
  name: 'rasta_construction_idempotent_replays_total',
  help: 'Requests answered from a stored idempotent response, by endpoint template',
  labelNames: ['service', 'endpoint'] as const,
  registers: [registry],
});

/**
 * The queue behind ORGANIZATION_MOVED (Q-83, docs/23 D-041): what each sweep
 * did with a task. `retried` that keeps rising means organization-service
 * cannot be asked and policies stay unchecked meanwhile.
 */
export const policyReconciliationTotal = new Counter({
  name: 'rasta_construction_policy_reconciliation_total',
  help: 'Policy reconciliation tasks handled, by result (suspended, confirmed, noop, retried)',
  labelNames: ['service', 'result'] as const,
  registers: [registry],
});

/** Sampled from the database, never maintained by inc/dec (ADR-050). */
export const policyReconciliationBacklog = new Gauge({
  name: 'rasta_construction_policy_reconciliation_backlog',
  help: 'Open (not DONE) policy reconciliation tasks',
  labelNames: ['service'] as const,
  registers: [registry],
});

export const policyReconciliationOldestDueAgeSeconds = new Gauge({
  name: 'rasta_construction_policy_reconciliation_oldest_due_age_seconds',
  help: 'Seconds the oldest due policy reconciliation task has waited; 0 when none is due',
  labelNames: ['service'] as const,
  registers: [registry],
});

/**
 * What each close sweep did with a tender (ADR-065 § 3), by result: `closed`, `noop`
 * (already closed or cancelled by someone else), `not_due` (the deadline was moved
 * after the claim), `lost` (the lease was taken back) and `failed`. `failed` that
 * keeps rising means a tender cannot be closed and is retried every lease.
 */
export const tenderCloseTotal = new Counter({
  name: 'rasta_construction_tender_close_total',
  help: 'Tenders handled by the close sweeper, by result (closed, noop, not_due, lost, failed)',
  labelNames: ['service', 'result'] as const,
  registers: [registry],
});

/** Sampled from the database, never maintained by inc/dec (ADR-050). */
export const tenderCloseBacklog = new Gauge({
  name: 'rasta_construction_tender_close_backlog',
  help: 'PUBLISHED tenders whose bid_closing_at has passed and that are not yet CLOSED',
  labelNames: ['service'] as const,
  registers: [registry],
});

export const tenderCloseOldestOverdueAgeSeconds = new Gauge({
  name: 'rasta_construction_tender_close_oldest_overdue_age_seconds',
  help: 'Seconds the oldest overdue PUBLISHED tender has waited past its deadline; 0 when none',
  labelNames: ['service'] as const,
  registers: [registry],
});
