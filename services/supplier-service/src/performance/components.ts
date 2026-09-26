/**
 * The vocabulary of supplier performance scoring (ADR-052).
 *
 * Closed sets, each mirrored by a PostgreSQL enum of the same values: a value
 * outside one is refused at the boundary and again by the column, never coerced
 * into the nearest member.
 */

/**
 * The five components ADR-052 § 1 accepted, with their weights held as data
 * in `performance_formula_weight` — never here (ADR-052 § 3, principle 9).
 *
 * QUALITY is a component with a configured weight and no producer (Q-56). It
 * stays in the set because its weight is part of the denominator `coverageBp`
 * is measured against; dropping it would inflate every supplier's coverage.
 */
export const PERFORMANCE_COMPONENTS = [
  'QUALITY',
  'ON_TIME',
  'CUSTOMER_SATISFACTION',
  'DISPUTE_ABSENCE',
  'CANCELLATION_ABSENCE',
] as const;

export type PerformanceComponent = (typeof PERFORMANCE_COMPONENTS)[number];

export const FORMULA_STATUSES = ['DRAFT', 'ACTIVE', 'RETIRED'] as const;
export type FormulaStatus = (typeof FORMULA_STATUSES)[number];

/** 100% in basis points. A version's weights sum to exactly this (ADR-052 § 3). */
export const WEIGHT_TOTAL_BP = 10_000;

/** The top of the 0..100 scale, in hundredths (ADR-052 § 7, `scoreCentis`). */
export const SCORE_CENTIS_MAX = 10_000;

/**
 * ADR-052 § 4, rule 13 — the closed set marketplace publishes on
 * `ORDER_DISPUTE_RESOLVED.responsibility` and `ORDER_CANCELLED.cancellationCause`.
 */
export const RESPONSIBILITY_ATTRIBUTIONS = [
  'SUPPLIER',
  'BUYER',
  'PLATFORM',
  'UNDETERMINED',
] as const;
export type ResponsibilityAttribution = (typeof RESPONSIBILITY_ATTRIBUTIONS)[number];

/** ADR-052 § 6 — marketplace samples by `orderId`, maintenance by `repairOrderId`. */
export const OUTCOME_KINDS = ['ORDER', 'REPAIR_ORDER'] as const;
export type OutcomeKind = (typeof OUTCOME_KINDS)[number];

/** The components whose facts carry a responsibility (rule 13). */
export const ATTRIBUTED_COMPONENTS = ['DISPUTE_ABSENCE', 'CANCELLATION_ABSENCE'] as const;
