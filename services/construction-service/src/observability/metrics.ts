import { Counter, registry } from '@rasta/observability';

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
