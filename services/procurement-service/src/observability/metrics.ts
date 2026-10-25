import { Counter, Gauge, registry } from '@rasta/observability';
import type { WindowOutcome } from '../demand/demand.state-machine';

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
 * (`demand`: a demand that arrived after `closesAt`; `sweeper`: the window sweeper, on time).
 * A steady `extended` is the extension count Q-10 leaves uncapped, made visible.
 */
export const aggregationWindowsEndedTotal = new Counter({
  name: 'rasta_procurement_aggregation_windows_ended_total',
  help: 'Aggregation windows ended, by transition and trigger',
  labelNames: ['service', 'transition', 'trigger'] as const,
  registers: [registry],
});

/** The metric label of each end of a window (a fixed, small set). */
export const ENDED_LABEL: Record<WindowOutcome['command'], string> = {
  reachThreshold: 'ready',
  extend: 'extended',
  refer: 'referred',
  lapse: 'lapsed',
};

/**
 * Extensions of a window under EXTEND, counted per window length — an end that was several lengths
 * late counts each (Q-119 note (c)). No cap on them is invented (Q-10); this is how they are seen.
 */
export const aggregationExtensionsTotal = new Counter({
  name: 'rasta_procurement_aggregation_extensions_total',
  help: 'Window lengths an aggregation was extended by under EXTEND',
  labelNames: ['service'] as const,
  registers: [registry],
});

/** READY aggregations cancelled (ADR-070 § 2). */
export const aggregationCancelledTotal = new Counter({
  name: 'rasta_procurement_aggregation_cancelled_total',
  help: 'READY aggregations cancelled',
  labelNames: ['service'] as const,
  registers: [registry],
});

/**
 * What the window sweeper did with each window it claimed (ADR-070 plan PR 2): `ended` (it ended
 * the window), `followed` (a batch of an ended window's demands followed it), `noop` (ended by
 * someone else, nothing to do), `not_due` (moved on after the claim), `lost` (the claim was taken
 * back) or `failed` (retried after a backoff).
 */
export const windowSweepTotal = new Counter({
  name: 'rasta_procurement_window_sweep_total',
  help: 'Window sweeper steps, by result',
  labelNames: ['service', 'result'] as const,
  registers: [registry],
});

/** OPEN windows past `closes_at` not yet ended (sampled from the database). */
export const windowSweepDue = new Gauge({
  name: 'rasta_procurement_window_sweep_due',
  help: 'OPEN aggregation windows past their end, not yet ended',
  labelNames: ['service'] as const,
  registers: [registry],
});

/** How long the oldest of them has been past its end, in seconds; 0 when none. */
export const windowSweepOldestDueAgeSeconds = new Gauge({
  name: 'rasta_procurement_window_sweep_oldest_due_age_seconds',
  help: 'Age past its end of the oldest OPEN aggregation window not yet ended',
  labelNames: ['service'] as const,
  registers: [registry],
});

/** Live demands of ended REFERRED/LAPSED windows still to follow them. */
export const windowDemandsToFollow = new Gauge({
  name: 'rasta_procurement_window_demands_to_follow',
  help: 'Live demands of ended windows not yet moved to the window status',
  labelNames: ['service'] as const,
  registers: [registry],
});

/** The most failed sweep attempts any due or following window has; 0 when none failed. */
export const windowSweepMaxAttempts = new Gauge({
  name: 'rasta_procurement_window_sweep_max_attempts',
  help: 'Most failed sweep attempts of any aggregation window still to sweep',
  labelNames: ['service'] as const,
  registers: [registry],
});

/** The largest `extension_count` of an OPEN window: one extended over and over is visible here. */
export const windowMaxExtensionCount = new Gauge({
  name: 'rasta_procurement_window_max_extension_count',
  help: 'Largest extension count of an OPEN aggregation window',
  labelNames: ['service'] as const,
  registers: [registry],
});

/**
 * Commands answered from a stored response under their Idempotency-Key: a retry that did
 * nothing a second time. `endpoint` is the route template, a closed set.
 */
/** RFQ commands committed (plan PR 6): issue, close (by a person) and cancel. */
export const rfqCommandsTotal = new Counter({
  name: 'rasta_procurement_rfq_commands_total',
  help: 'RFQ commands committed, by command',
  labelNames: ['service', 'command'] as const,
  registers: [registry],
});

/** RFQ close sweeper steps (plan PR 6), the shape of the window sweeper's. */
export const rfqCloseSweepTotal = new Counter({
  name: 'rasta_procurement_rfq_close_sweep_total',
  help: 'RFQ close sweeper steps, by result',
  labelNames: ['service', 'result'] as const,
  registers: [registry],
});

export const rfqCloseDue = new Gauge({
  name: 'rasta_procurement_rfq_close_due',
  help: 'PUBLISHED RFQs past their quotation deadline, not yet closed',
  labelNames: ['service'] as const,
  registers: [registry],
});

export const rfqCloseOldestDueAgeSeconds = new Gauge({
  name: 'rasta_procurement_rfq_close_oldest_due_age_seconds',
  help: 'Age past its deadline of the oldest PUBLISHED RFQ not yet closed',
  labelNames: ['service'] as const,
  registers: [registry],
});

export const idempotentReplaysTotal = new Counter({
  name: 'rasta_procurement_idempotent_replays_total',
  help: 'Requests answered from a stored response under their Idempotency-Key',
  labelNames: ['service', 'endpoint'] as const,
  registers: [registry],
});
