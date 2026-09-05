import { Counter, registry } from '@rasta/observability';

/**
 * Metrics owned by supplier-service.
 *
 * Only the ones answering a question an operator will actually ask. The
 * platform-wide series — outbox lag, HTTP latency, authorization denials — are
 * already defined in `@rasta/observability` and are not duplicated here.
 *
 * **No unbounded cardinality, and nothing that identifies a supplier.** No label
 * carries an `organizationId`, a `supplierId` or a display name. That matters
 * here more than in most services: a counter labelled by organization would
 * publish *which named organizations were suspended and when* to anybody who
 * can reach `/metrics`, which is a reputational disclosure needing no row of
 * data at all (AGENTS.md S-09). A per-tenant breakdown belongs in
 * analytics-service, under authorization.
 *
 * `capability` and `decision` are safe to label by: both are fixed, small
 * enumerations that say nothing about whose supplier it is.
 *
 * There is deliberately **no** score or rating metric. Q-12 is open; a gauge
 * exporting a number nobody has defined would be the quietest possible way for
 * an invented score to become something people build dashboards on.
 */

export const suppliersRegisteredTotal = new Counter({
  name: 'rasta_supplier_registered_total',
  help: 'Supplier profiles registered',
  labelNames: ['service'] as const,
  registers: [registry],
});

export const qualificationsSubmittedTotal = new Counter({
  name: 'rasta_supplier_qualifications_submitted_total',
  help: 'Qualification submissions accepted',
  labelNames: ['service', 'capability'] as const,
  registers: [registry],
});

/**
 * Decisions recorded, by outcome and capability.
 *
 * The operationally interesting series in this file. Submissions rising while
 * decisions stay flat is a review queue nobody is working, and that is invisible
 * from the submission counter alone — a supplier waiting indefinitely for an
 * answer looks exactly like a healthy platform from the outside.
 */
export const qualificationDecisionsTotal = new Counter({
  name: 'rasta_supplier_qualification_decisions_total',
  help: 'Qualification decisions recorded, by outcome',
  labelNames: ['service', 'decision', 'capability'] as const,
  registers: [registry],
});

/** Suspensions and reinstatements. Counted, never named. */
export const suspensionTransitionsTotal = new Counter({
  name: 'rasta_supplier_suspension_transitions_total',
  help: 'Supplier suspension and reinstatement transitions',
  labelNames: ['service', 'transition'] as const,
  registers: [registry],
});

/**
 * Directory queries, by which one.
 *
 * Separated from `search` because `qualified-for` is the query other services
 * will eventually make through a port, and watching it grow from zero is how an
 * operator will see that integration actually landing.
 */
export const directoryQueriesTotal = new Counter({
  name: 'rasta_supplier_directory_queries_total',
  help: 'Directory queries served, by kind',
  labelNames: ['service', 'query'] as const,
  registers: [registry],
});
