import { Counter, registry } from '@rasta/observability';

/**
 * Metrics owned by contract-service.
 *
 * Only the ones answering a question an operator will actually ask. The platform-wide
 * series — outbox lag, HTTP latency, authorization denials — are defined in
 * `@rasta/observability` and not duplicated here.
 *
 * **No unbounded cardinality, and nothing that identifies a tenant.** No label carries an
 * `organizationId`, a `tenderId` or an amount (AGENTS.md S-09). The labels used — an
 * outcome, a mismatch code — are fixed, small enumerations.
 */

/**
 * What the consumer of `TENDER_AWARDED` did with each delivery: `drafted` (a contract was
 * made), `replayed` (the same award again, no second contract), `refused` (the owner
 * did not confirm, or the delivery contradicts the contract it names) or `unavailable`
 * (the owner could not be asked; retried). A steady `refused` is a producer defect or
 * somebody publishing events they do not own.
 */
export const contractDraftsTotal = new Counter({
  name: 'rasta_contract_drafts_total',
  help: 'TENDER_AWARDED deliveries handled, by outcome',
  labelNames: ['service', 'outcome'] as const,
  registers: [registry],
});

/**
 * What each command did (CON-003 PR 2): `command` is `sign` or `cancel`, `outcome` one of
 * `recorded` (a signature was recorded, the contract still a draft), `signed`, `cancelled`,
 * `unchanged` (the same person signing the same side again) or `refused`. Fixed, small sets.
 */
export const contractCommandsTotal = new Counter({
  name: 'rasta_contract_commands_total',
  help: 'Contract commands handled, by command and outcome',
  labelNames: ['service', 'command', 'outcome'] as const,
  registers: [registry],
});

/**
 * Commands answered from a stored response under their Idempotency-Key: a retry that did
 * nothing a second time. `endpoint` is the route template, a closed set.
 */
export const idempotentReplaysTotal = new Counter({
  name: 'rasta_contract_idempotent_replays_total',
  help: 'Requests answered from a stored response under their Idempotency-Key',
  labelNames: ['service', 'endpoint'] as const,
  registers: [registry],
});

/**
 * Checks of an event against the owning service (ADR-061 § 4), by outcome — `confirmed`, or
 * the mismatch that refused it. Any mismatch is worth an alert: either a producer has a
 * defect or somebody is publishing events they do not own.
 */
export const sourceVerificationsTotal = new Counter({
  name: 'rasta_contract_source_verifications_total',
  help: 'Checks of an event against the owning service, by consumer and outcome',
  labelNames: ['service', 'consumer', 'outcome'] as const,
  registers: [registry],
});
