import { Counter, registry } from '@rasta/observability';

/**
 * Metrics owned by procurement-service.
 *
 * Only the ones answering a question an operator will actually ask. The platform-wide
 * series — outbox lag, HTTP latency, authorization denials — are defined in
 * `@rasta/observability` and not duplicated here.
 *
 * **No unbounded cardinality, and nothing that identifies a tenant.** No label carries an
 * `organizationId`, a `productId` or a quantity (AGENTS.md S-09). The labels used — a
 * command, an outcome — are fixed, small enumerations.
 */

/**
 * What each demand command did (COM-007 PR 1): `command` is `submit` or `withdraw`; `outcome` is
 * `joined` (a demand joined a window that was open), `opened` (it opened a window), `after_end`
 * (it arrived after its window's end, ended it and joined the next) or `withdrawn`.
 */
export const demandCommandsTotal = new Counter({
  name: 'rasta_procurement_demand_commands_total',
  help: 'Demand commands handled, by command and outcome',
  labelNames: ['service', 'command', 'outcome'] as const,
  registers: [registry],
});

/**
 * Windows ended, by the transition (`ready`, `extended`, `referred`, `lapsed`) and by who ended it
 * (`demand`: a demand that arrived after `closesAt`; the sweeper of ADR-070 plan PR 2 adds its own).
 * A steady `extended` is the extension count Q-10 leaves uncapped, made visible.
 */
export const aggregationWindowsEndedTotal = new Counter({
  name: 'rasta_procurement_aggregation_windows_ended_total',
  help: 'Aggregation windows ended, by transition and trigger',
  labelNames: ['service', 'transition', 'trigger'] as const,
  registers: [registry],
});

/**
 * Commands answered from a stored response under their Idempotency-Key: a retry that did
 * nothing a second time. `endpoint` is the route template, a closed set.
 */
export const idempotentReplaysTotal = new Counter({
  name: 'rasta_procurement_idempotent_replays_total',
  help: 'Requests answered from a stored response under their Idempotency-Key',
  labelNames: ['service', 'endpoint'] as const,
  registers: [registry],
});
