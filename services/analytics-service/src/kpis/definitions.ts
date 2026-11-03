/**
 * PR 2 registers measurements with already defined meanings, without choosing the savings
 * formulas ADR-071 leaves open. The baseline KPI is the recorded reference itself (identity),
 * not avoided downtime. Derived savings and marketplace prices belong to later PRs.
 */
export const KPI_DEFINITIONS = [
  {
    key: 'MAINTENANCE_COMPLETED_COUNT',
    unit: 'COUNT',
    dependsOnBaseline: false,
    formula: 'Count fact_maintenance completions in [from, to).',
  },
  {
    key: 'MAINTENANCE_DOWNTIME_BASELINE_MINUTES',
    unit: 'MINUTES',
    dependsOnBaseline: true,
    formula:
      'Identity: baseline with highest database identity (version) for this key, organization scope, exact period and unit; no currency. latest = highest database identity (version), not commit order; a future writer (Q-142) must serialize writes per (org, key, scope, unit, currency, period).',
  },
] as const;

export type KpiDefinition = (typeof KPI_DEFINITIONS)[number];
