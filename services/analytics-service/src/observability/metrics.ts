import { Counter, registry } from '@rasta/observability';

/**
 * Metrics owned by analytics-service.
 *
 * **Nothing that identifies a tenant, ever** (`docs/13`, ADR-017, ADR-071 § 9). No label
 * carries an `organizationId`, a `requestId`, an asset or an amount: breaking a number down
 * by organization is this service's *database* job, under authorization, never a metric's.
 * The labels used — the consumer, the event name and an outcome — are fixed, small sets.
 */

/**
 * What a projection did with each delivery: `applied` (a fact was written), `duplicate` (an
 * event already applied, or another event stating the same fact — no second effect),
 * `conflict` (an event contradicting the fact already held; dead-lettered) and `skipped` (an
 * event this projection does not read). A steady `conflict` is a producer defect or somebody
 * publishing events they do not own.
 */
export const factsProjectedTotal = new Counter({
  name: 'rasta_analytics_facts_projected_total',
  help: 'Deliveries a projection handled, by consumer, event and outcome',
  labelNames: ['consumer', 'event', 'outcome'] as const,
  registers: [registry],
});

export const PROJECTION_OUTCOMES = {
  APPLIED: 'applied',
  DUPLICATE: 'duplicate',
  CONFLICT: 'conflict',
  SKIPPED: 'skipped',
} as const;

export type ProjectionOutcome = (typeof PROJECTION_OUTCOMES)[keyof typeof PROJECTION_OUTCOMES];
