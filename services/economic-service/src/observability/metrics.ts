import { Counter, Gauge, Histogram, registry } from '@rasta/observability';

/**
 * Metrics owned by economic-service.
 *
 * Only the ones that answer a question an operator will actually ask. The
 * platform-wide ones — outbox lag, DLQ arrivals, event processing duration,
 * HTTP latency, authorization denials — are already defined in
 * `@rasta/observability` and are not duplicated here.
 *
 * Two rules govern every series below.
 *
 * **No unbounded cardinality.** Nothing is labelled by `organizationId`,
 * `walletId`, `transactionId` or `userId`. A per-tenant breakdown of financial
 * activity belongs in analytics-service, against the database, under
 * authorization — not in a Prometheus scrape that anyone on the monitoring
 * network can read (AGENTS.md S-09).
 *
 * **No metric is a total of money.** There is no gauge of platform revenue and
 * no counter of rial settled. Two reasons, and the second is the one that
 * matters: a cross-tenant money total is a figure nobody should be able to
 * read from an unauthenticated scrape, and a Prometheus counter is a float —
 * feeding rial amounts into it would reintroduce, in the observability layer,
 * exactly the precision loss ADR-022 removed from the domain. Counts of
 * *events* are safe; sums of *money* are not.
 */

export const journalsPostedTotal = new Counter({
  name: 'rasta_economic_journals_posted_total',
  help: 'Journals posted, by type',
  labelNames: ['service', 'type'] as const,
  registers: [registry],
});

/**
 * Ledger entries written.
 *
 * The trigger for ADR-030: partitioning becomes due when this counter's rate
 * passes one million per month, ten times earlier than the extraction
 * threshold in docs/04 § 4.1. A deferral whose condition is a number somebody
 * can query is a deferral; one whose condition is a note is a forgotten
 * decision.
 */
export const ledgerEntriesTotal = new Counter({
  name: 'rasta_economic_ledger_entries_total',
  help: 'Ledger entries appended — the growth signal that triggers partitioning (ADR-030)',
  labelNames: ['service'] as const,
  registers: [registry],
});

/**
 * Journals refused for not balancing.
 *
 * Should be flat at zero. Anything else is a defect in a posting path, and it
 * is worth its own series rather than being folded into HTTP 4xx: a caller
 * cannot cause this by sending a bad request, so every occurrence is ours.
 */
export const unbalancedJournalsTotal = new Counter({
  name: 'rasta_economic_unbalanced_journals_total',
  help: 'Journals refused because debits did not equal credits',
  labelNames: ['service'] as const,
  registers: [registry],
});

/**
 * Deviations found by the wallet/ledger reconciliation.
 *
 * docs/10 § 10.3 calls a deviation a critical alert. The number of wallets
 * that disagree with their ledger account is the alert condition; the wallets
 * themselves are in the log, not in the label.
 */
export const walletLedgerDeviationsTotal = new Gauge({
  name: 'rasta_economic_wallet_ledger_deviations',
  help: 'Wallets whose stored balance disagrees with the sum of their ledger entries',
  labelNames: ['service'] as const,
  registers: [registry],
});

export const walletsOpenTotal = new Gauge({
  name: 'rasta_economic_wallets_open',
  help: 'Wallets in ACTIVE status',
  labelNames: ['service'] as const,
  registers: [registry],
});

export const holdsActiveTotal = new Gauge({
  name: 'rasta_economic_holds_active',
  help: 'Escrow holds currently outstanding',
  labelNames: ['service'] as const,
  registers: [registry],
});

/**
 * Transactions recorded, by type and by how they arrived.
 *
 * `source` separates an HTTP command from an event-driven obligation, which is
 * the difference between a user doing something and another service telling us
 * something happened.
 */
export const transactionsCreatedTotal = new Counter({
  name: 'rasta_economic_transactions_created_total',
  help: 'Transactions recorded, by type and origin',
  labelNames: ['service', 'type', 'source'] as const,
  registers: [registry],
});

/**
 * Obligations authorised to settle but not yet settled.
 *
 * The queue that a `MAINTENANCE_APPROVED` lands in (ADR-032). It is the figure
 * most likely to grow quietly: the machine is back at work, so nobody chases
 * the payment, and the workshop is not paid.
 */
export const transactionsPendingSettlement = new Gauge({
  name: 'rasta_economic_transactions_pending_settlement',
  help: 'Transactions authorised to settle and still waiting',
  labelNames: ['service'] as const,
  registers: [registry],
});

/** Transactions frozen by an objection. No automatic movement (docs/10 § 10.5). */
export const transactionsDisputed = new Gauge({
  name: 'rasta_economic_transactions_disputed',
  help: 'Transactions with an unresolved dispute, on which settlement is stopped',
  labelNames: ['service'] as const,
  registers: [registry],
});

export const settlementsCompletedTotal = new Counter({
  name: 'rasta_economic_settlements_completed_total',
  help: 'Settlements posted',
  labelNames: ['service', 'type'] as const,
  registers: [registry],
});

/**
 * Settlements that failed.
 *
 * ADR-031 and docs/08 § 8.6 both forbid automatic financial compensation after
 * a settlement fails: the funds stay held and a human is alerted. This counter
 * is that alert's condition, and `reason` is a small closed set so the label
 * stays bounded.
 */
export const settlementFailuresTotal = new Counter({
  name: 'rasta_economic_settlement_failures_total',
  help: 'Settlement attempts that failed, leaving the funds held for human review',
  labelNames: ['service', 'reason'] as const,
  registers: [registry],
});

export const holdsRefusedTotal = new Counter({
  name: 'rasta_economic_holds_refused_total',
  help: 'Hold attempts refused, by reason',
  labelNames: ['service', 'reason'] as const,
  registers: [registry],
});

/**
 * Payment intents by outcome, and whether the provider was simulated.
 *
 * `simulated` is a label rather than an assumption so that a dashboard cannot
 * silently show demonstration traffic as real (ADR-024).
 */
export const paymentIntentsTotal = new Counter({
  name: 'rasta_economic_payment_intents_total',
  help: 'Payment intents by outcome and provider',
  labelNames: ['service', 'provider', 'simulated', 'outcome'] as const,
  registers: [registry],
});

/**
 * Commission applications, split by whether a rule matched.
 *
 * `matched=false` is the ADR-023 case — no active rule, therefore no
 * commission — and it is worth watching: a platform settling everything at
 * zero commission is either correctly configured or entirely unconfigured, and
 * only this series tells the two apart.
 */
export const commissionApplicationsTotal = new Counter({
  name: 'rasta_economic_commission_applications_total',
  help: 'Commission calculations, by whether an active rule matched',
  labelNames: ['service', 'type', 'matched'] as const,
  registers: [registry],
});

export const rewardsGrantedTotal = new Counter({
  name: 'rasta_economic_rewards_granted_total',
  help: 'Rewards granted, by trigger and whether they carried rial value',
  labelNames: ['service', 'trigger', 'monetised'] as const,
  registers: [registry],
});

/**
 * Reward evaluations that granted nothing, and why.
 *
 * `reason` is a closed set: `no_rule`, `cap_reached`, `duplicate`, `no_actor`,
 * `condition_unmet`. The last two are the ones worth alerting on — a trigger
 * arriving without a user actor grants nothing at all (ADR-033), and a rule
 * whose condition never matches is a rule somebody configured wrongly.
 */
export const rewardsSkippedTotal = new Counter({
  name: 'rasta_economic_rewards_skipped_total',
  help: 'Reward evaluations that granted nothing, by reason',
  labelNames: ['service', 'reason'] as const,
  registers: [registry],
});

/**
 * Idempotent replays served from the stored response.
 *
 * A healthy number here means clients are retrying and the platform is
 * absorbing it correctly. A sudden rise means something upstream is timing out
 * and retrying — worth knowing before it becomes a duplicate-charge report.
 */
export const idempotentReplaysTotal = new Counter({
  name: 'rasta_economic_idempotent_replays_total',
  help: 'Requests answered from a stored idempotent response instead of re-executing',
  labelNames: ['service', 'endpoint'] as const,
  registers: [registry],
});

/**
 * How long a financial transaction holds its row locks.
 *
 * The one latency figure that matters operationally in this service: a
 * settlement holds locks on two wallets, so a slow tail here is the shape of
 * contention rather than of load. Buckets span a fast local commit to the
 * point where something is genuinely wrong.
 */
export const financialTransactionDuration = new Histogram({
  name: 'rasta_economic_financial_transaction_duration_seconds',
  help: 'Wall-clock duration of a money-moving database transaction, by operation',
  labelNames: ['service', 'operation'] as const,
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});
