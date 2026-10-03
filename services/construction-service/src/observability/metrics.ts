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

export const tenderCloseMaxAttempts = new Gauge({
  name: 'rasta_construction_tender_close_max_attempts',
  help: 'The most failed close attempts of any overdue PUBLISHED tender; 0 when none failed',
  labelNames: ['service'] as const,
  registers: [registry],
});

export const tenderCloseOldestOverdueAgeSeconds = new Gauge({
  name: 'rasta_construction_tender_close_oldest_overdue_age_seconds',
  help: 'Seconds the oldest overdue PUBLISHED tender has waited past its deadline; 0 when none',
  labelNames: ['service'] as const,
  registers: [registry],
});

/**
 * Opening or reading a tender's bids that was refused, by a closed reason
 * (not_closed, not_opened, proposal_required, second_person_required, no_proposal,
 * evidence_unavailable, evidence_behind, integrity, conflict_of_interest,
 * identity_unavailable, key_unavailable). `integrity` is the one to look at: a stored bid,
 * or the whole chain, did not match what audit-service holds (ADR-066 § 3);
 * `identity_unavailable` says identity-service could not tell whom a reader belongs to, so
 * nothing was shown. Never labelled by tender or tenant.
 */
export const bidOpeningRefusalsTotal = new Counter({
  name: 'rasta_construction_bid_opening_refusals_total',
  help: 'Openings and owner reads of bids refused, by reason',
  labelNames: ['service', 'reason'] as const,
  registers: [registry],
});

/**
 * Evaluation commands and reads refused (ADR-067 § 4), by closed reason: a conflict of interest
 * (`conflict_of_interest`, `tender_author`, `recused`), a state the command does not apply in, an
 * incomplete evaluation. Never labelled by tender, tenant or person.
 */
export const evaluationRefusalsTotal = new Counter({
  name: 'rasta_construction_evaluation_refusals_total',
  help: 'Evaluation commands and reads of opened bids refused, by reason',
  labelNames: ['service', 'reason'] as const,
  registers: [registry],
});

/**
 * Award commands refused (ADR-067 § 3), by closed reason: a conflict of interest, a winner
 * supplier-service no longer finds eligible (`winner_not_eligible`), a missing justification, the
 * approval gate, a tender that is not EVALUATED. Never labelled by tender, tenant or person.
 */
export const awardRefusalsTotal = new Counter({
  name: 'rasta_construction_award_refusals_total',
  help: 'Award commands refused, by reason',
  labelNames: ['service', 'reason'] as const,
  registers: [registry],
});

/**
 * The detective control after an opening committed (ADR-066 § 4): identity-service was asked
 * whether the proposer or the approver was a member of a bidding organization at the commit
 * instant. `clear` is the usual answer; `conflict` is the race the approval cannot close and
 * pages; `unavailable` says the check could not be made (it is not retried). Never labelled
 * by tender, tenant or person.
 */
export const bidOpeningConflictChecksTotal = new Counter({
  name: 'rasta_construction_bid_opening_conflict_checks_total',
  help: 'Checks after an opening of whether its proposer or approver belonged to a bidder, by outcome',
  labelNames: ['service', 'outcome'] as const,
  registers: [registry],
});
