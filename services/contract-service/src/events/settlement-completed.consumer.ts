import { DLQ_REASONS, type EventEnvelope } from '@rasta/contracts';
import {
  EventConsumer,
  RastaError,
  UnprocessableEventError,
  createSystemContext,
  invalidPayloadError,
  kafkaConnection,
  runWithContext,
  type HandlerOutcome,
  type OutboxStopOptions,
} from '@rasta/nest-common';
import type { Logger } from '@rasta/logging';
import { z } from 'zod';
import { CONTRACT_DEAD_LETTER_TOPIC, SERVICE_NAME } from '../config/env';
import { ContractRepository } from '../contract/contract.repository';
import { statementSettlementsTotal, sourceVerificationsTotal } from '../observability/metrics';
import { PrismaService } from '../prisma/prisma.service';
import {
  confirmSettlement,
  confirmSettlementTenant,
  contractSettlementDue,
  isObligationOf,
  minorOf,
  type ConfirmedSettlement,
  type SettlementClaim,
  type SettlementMismatch,
} from '../settlement/obligation-confirm';
import type { ObligationSource } from '../settlement/obligation-source.client';
import {
  SettlementRepository,
  type SettlementCandidate,
} from '../settlement/settlement.repository';
import { transactionNow } from '../shared/clock';
import { isUniqueViolation } from '../shared/prisma-errors';
import type { Statement } from '../generated/prisma';
import { EventPublisher } from './publisher';
import type { EventConsumerFactory } from './tender-awarded.consumer';

/** The consumer group: `<service>.<purpose>` (ADR-061 § 3). */
export const SETTLEMENT_COMPLETED_CONSUMER = 'contract-service.settlement-completed';

/** The one topic it reads. `EventConsumer` also reads its `.retry` twin. */
export const SETTLEMENT_COMPLETED_TOPICS = ['rasta.economic.v1'] as const;

export const SETTLEMENT_COMPLETED = 'SETTLEMENT_COMPLETED';

/** The actor recorded on a contract the settlement settles: the system, never a person. */
export const SETTLING_ACTOR = `service:${SERVICE_NAME}`;

/**
 * Only the fields this service uses. economic-service owns the full schema and this service does not
 * import it (no cross-service imports); an extra field is not this consumer's business, which is why
 * this is not `.strict()`. None of them is taken as a fact: the tenant fields are compared, the rest
 * only say which statements to ask economic about.
 */
const identifier = z.string().min(1).max(128);
const settlementCompletedPayload = z.object({
  settlementId: identifier,
  transactionId: identifier,
  organizationId: identifier,
  payerOrganizationId: identifier,
  payeeOrganizationId: identifier,
  grossAmountMinor: z.string().regex(/^\d{1,19}$/),
});

/** The names the schema declares — what a dead-letter message may name of a failing payload (S-09). */
export const SETTLEMENT_COMPLETED_FIELDS: readonly string[] = Object.keys(
  settlementCompletedPayload.shape,
);

export interface SettlementCompletedConsumerOptions {
  readonly maxRetries: number;
  readonly retryBackoffMs: number;
}

/** The shared `EventConsumer` for this stream, subscribed with its `.retry` twin (D-039). */
export function settlementCompletedConsumerFactory(
  connection: ReturnType<typeof kafkaConnection>,
  logger: Pick<Logger, 'info' | 'warn' | 'error'>,
  options: SettlementCompletedConsumerOptions,
): EventConsumerFactory {
  return (handler) =>
    new EventConsumer(
      {
        ...connection,
        groupId: SETTLEMENT_COMPLETED_CONSUMER,
        topics: [...SETTLEMENT_COMPLETED_TOPICS],
        deadLetterTopic: CONTRACT_DEAD_LETTER_TOPIC,
        maxRetries: options.maxRetries,
        retryBackoffMs: options.retryBackoffMs,
      },
      handler,
      {
        log: (m) => logger.info(m),
        warn: (m) => logger.warn(m),
        error: (m, trace) => logger.error({ err: trace }, m),
      },
    );
}

/**
 * Settles the statement economic-service settled, and the contract once every approved statement is
 * (CON-003 PR 6c, ADR-068 § 6 (3) and (5), docs/24 Q-97 (6)).
 *
 * ## economic confirms; the event only triggers (I5, ADR-061 § 4, A-13)
 *
 * `SETTLEMENT_COMPLETED` is its publisher's claim, and it does not name a statement — it names
 * economic's transaction (for a statement, the obligation economic built from `STATEMENT_APPROVED`),
 * the settlement, the payer and the payee. So, before anything is written:
 *
 *   1. **The tenant** (ADR-061 § 5): the envelope's tenant, the payload's organization and the payer
 *      are one — the employer, the statements' tenant — or the event is dead-lettered as
 *      `SOURCE_UNCONFIRMED` before anything is read or asked.
 *   2. **Already recorded**: a statement this obligation already settled is the same settlement again
 *      (`SKIPPED`, no round trip) or a contradiction (`VALIDATION_FAILED`, nothing overwritten).
 *   3. **Which statement**: the employer's APPROVED statements owed to the payee. None: economic's
 *      settlement is of no statement here (an order, a repair) — `SKIPPED`.
 *   4. **economic is asked**, statement by statement, outside any transaction, for the obligation it
 *      holds (`GET /v1/internal/obligations/by-source/STATEMENT/{id}`, a service token signed for the
 *      employer). The statement whose obligation is the event's transaction is the one; its answer is
 *      held against the statement's own row (`confirmSettlement`): the same statement, payer,
 *      beneficiary and currency, the obligation exactly the net, SETTLED and `fullySettled` by the
 *      settlement the event names. Any difference: dead-lettered at once as `SOURCE_UNCONFIRMED`,
 *      with the field — a retry cannot change economic's answer. No statement's obligation is the
 *      event's: `SKIPPED`.
 *   5. **economic cannot be asked** (down, slow, a 404 that is not its own, a body it would not
 *      send): the handler throws, the consumer retries, and the event is dead-lettered as
 *      `UPSTREAM_UNAVAILABLE` once the retries run out. Nothing is written — **never a statement
 *      settled on the event's word**. A DLQ replay recovers it once economic is back.
 *
 * ## One transaction: the statement, then perhaps the contract
 *
 * Under the contract's row lock — the one every command of a contract takes — then the statement's:
 * APPROVED → SETTLED with the settlement economic confirmed, and `STATEMENT_SETTLED` in the outbox.
 * Then the contract's rule (ADR-068 § 6 (3)): COMPLETED, no statement open, Σ settled = Σ approved
 * net ⇒ COMPLETED → SETTLED and `CONTRACT_SETTLED`, in the same transaction. The database holds both
 * (`statement_guard`, `ck_statement_settlement`, `contract_guard`). Two deliveries at once are
 * ordered by the lock: the second finds the statement SETTLED and is judged as in (2).
 */
export class SettlementCompletedConsumer {
  private consumer?: EventConsumer;

  constructor(
    private readonly consumerFactory: EventConsumerFactory,
    private readonly prisma: PrismaService,
    private readonly contracts: ContractRepository,
    private readonly settlements: SettlementRepository,
    private readonly publisher: EventPublisher,
    private readonly obligations: ObligationSource,
    private readonly logger: Pick<Logger, 'info' | 'warn' | 'debug'>,
  ) {}

  async start(): Promise<void> {
    this.consumer = this.consumerFactory((envelope) => this.handle(envelope));
    await this.consumer.start();
  }

  /**
   * An `OutboxShutdown` worker, like the other two consumers: stopped by the shutdown's one deadline;
   * a settlement still in flight (economic's answer, or the transaction) is abandoned uncommitted and
   * delivered again, and the statement's one settlement keeps a second out.
   */
  stop(options?: OutboxStopOptions): Promise<void> {
    return this.consumer?.stop(options) ?? Promise.resolve();
  }

  /** One event. Public so a test can drive it without a broker. */
  async handle(envelope: EventEnvelope): Promise<HandlerOutcome> {
    if (envelope.eventName !== SETTLEMENT_COMPLETED) return 'SKIPPED';

    // A known event whose payload fails its schema is a producer defect no retry fixes:
    // dead-lettered at once as VALIDATION_FAILED, naming field paths and zod codes only (S-09).
    const parsed = settlementCompletedPayload.safeParse(envelope.payload);
    if (!parsed.success) {
      throw invalidPayloadError(envelope, parsed.error, SETTLEMENT_COMPLETED_FIELDS);
    }
    const payload = parsed.data;

    if (
      !confirmSettlementTenant(
        envelope.tenantId,
        payload.organizationId,
        payload.payerOrganizationId,
      )
    ) {
      this.refuse(payload.transactionId, 'tenant_mismatch');
    }
    const tenant = payload.organizationId;

    const context = createSystemContext({
      correlationId: envelope.correlationId,
      organizationId: tenant,
      callerService: SERVICE_NAME,
    });

    return runWithContext(context, async () => {
      const claim: SettlementClaim = {
        transactionId: payload.transactionId,
        settlementId: payload.settlementId,
      };

      // Checked first so a redelivery costs no round trip to economic. Checked again under the
      // locks, which is the check that counts.
      const recorded = await this.settlements.findSettledBy(tenant, claim.transactionId);
      if (recorded) return this.judgeRecorded(envelope, claim, recorded);

      const candidates = await this.settlements.findCandidates(
        tenant,
        payload.payeeOrganizationId,
        minorOf(payload.grossAmountMinor),
      );
      for (const candidate of candidates) {
        // Throws on an owner that cannot be asked: retried, never acted on.
        let fact;
        try {
          fact = await this.obligations.obligation(tenant, candidate.id);
        } catch (error) {
          if (error instanceof RastaError) {
            statementSettlementsTotal.inc({ service: SERVICE_NAME, outcome: 'unavailable' });
          }
          throw error;
        }
        if (!fact || !isObligationOf(claim, fact)) continue;

        const verdict = confirmSettlement(
          {
            id: candidate.id,
            organizationId: candidate.organizationId,
            contractorOrganizationId: candidate.contract.contractorOrganizationId,
            netMinor: candidate.netMinor,
          },
          claim,
          fact,
        );
        if (!verdict.confirmed) return this.refuse(claim.transactionId, verdict.mismatch);
        sourceVerificationsTotal.inc({
          service: SERVICE_NAME,
          consumer: 'settlement_completed',
          outcome: 'confirmed',
        });
        return this.record(envelope, claim, candidate, verdict.settlement);
      }

      statementSettlementsTotal.inc({ service: SERVICE_NAME, outcome: 'not_statement' });
      this.logger.debug(
        `${envelope.eventName} ${envelope.eventId}: settles no statement of this service`,
      );
      return 'SKIPPED';
    });
  }

  /** The statement's settlement, and the contract's when it is due, in one transaction. */
  private async record(
    envelope: EventEnvelope,
    claim: SettlementClaim,
    candidate: SettlementCandidate,
    settlement: ConfirmedSettlement,
  ): Promise<HandlerOutcome> {
    const tenant = candidate.organizationId;
    let outcome: 'settled' | 'contract_settled';
    try {
      outcome = await this.prisma.transaction(async (tx) => {
        const contract = await this.contracts.lockContract(tx, tenant, candidate.contractId);
        if (!contract) throw new Error(`statement ${candidate.id} has no contract`);
        const statement = await this.settlements.lock(tx, tenant, contract.id, candidate.id);
        if (!statement) throw new Error(`statement ${candidate.id} vanished`);
        // A concurrent delivery settled it first: judged as a redelivery, outside the transaction.
        if (statement.status === 'SETTLED') throw new AlreadySettled(statement);
        // I3: an APPROVED statement changes only to SETTLED, so it is still APPROVED here.
        if (statement.status !== 'APPROVED') {
          throw new Error(`statement ${statement.id} is ${statement.status}, not APPROVED`);
        }

        const at = await transactionNow(tx);
        const moved = await this.settlements.settle(tx, {
          organizationId: tenant,
          id: statement.id,
          version: statement.version,
          settlement,
          eventId: envelope.eventId,
          at,
        });
        // Under both locks nothing else moves it; a miss is a defect, retried and never acted on.
        if (!moved) throw new Error(`statement ${statement.id} moved under its lock`);
        await this.publisher.enqueue(tx, {
          eventName: 'STATEMENT_SETTLED',
          aggregateId: contract.id,
          organizationId: tenant,
          causationId: envelope.eventId,
          occurredAt: at,
          payload: {
            contractId: contract.id,
            statementId: statement.id,
            statementNumber: statement.statementNumber,
            organizationId: tenant,
            contractorOrganizationId: contract.contractorOrganizationId,
            obligationId: settlement.obligationId,
            settlementId: settlement.settlementId,
            settledAt: settlement.settledAt.toISOString(),
          },
        });

        // ADR-068 § 6 (3): the contract, once COMPLETED, with no statement open and every approved
        // one settled in full.
        const totals = await this.settlements.totals(tx, tenant, contract.id);
        if (!contractSettlementDue(contract.status, totals)) return 'settled';
        const settled = await this.contracts.transition(tx, {
          organizationId: tenant,
          id: contract.id,
          from: 'COMPLETED',
          to: 'SETTLED',
          version: contract.version,
          actor: SETTLING_ACTOR,
          at,
        });
        if (!settled) throw new Error(`contract ${contract.id} moved under its lock`);
        await this.publisher.enqueue(tx, {
          eventName: 'CONTRACT_SETTLED',
          aggregateId: contract.id,
          organizationId: tenant,
          causationId: envelope.eventId,
          occurredAt: at,
          payload: {
            contractId: contract.id,
            projectId: contract.projectId,
            organizationId: tenant,
            contractorOrganizationId: contract.contractorOrganizationId,
            settledAt: at.toISOString(),
          },
        });
        return 'contract_settled';
      });
    } catch (error) {
      const winner =
        error instanceof AlreadySettled
          ? error.statement
          : isUniqueViolation(error)
            ? await this.settlements.findSettledBy(tenant, claim.transactionId)
            : null;
      if (!winner) throw error;
      return this.judgeRecorded(envelope, claim, winner);
    }

    statementSettlementsTotal.inc({ service: SERVICE_NAME, outcome });
    this.logger.info(
      outcome === 'contract_settled'
        ? `Settled statement ${candidate.id} and its contract ${candidate.contractId}`
        : `Settled statement ${candidate.id}`,
    );
    return undefined;
  }

  /**
   * A delivery whose obligation already settled a statement: the same settlement again is a skip; a
   * delivery that contradicts it is refused and overwrites nothing.
   */
  private judgeRecorded(
    envelope: EventEnvelope,
    claim: SettlementClaim,
    statement: Statement,
  ): HandlerOutcome {
    const differing: string[] = [];
    if (statement.settlementObligationId !== claim.transactionId) differing.push('transactionId');
    if (statement.settlementId !== claim.settlementId) differing.push('settlementId');
    if (differing.length === 0) {
      statementSettlementsTotal.inc({ service: SERVICE_NAME, outcome: 'replayed' });
      this.logger.debug(
        `${envelope.eventName} ${envelope.eventId}: statement ${statement.id} already settled; no second effect`,
      );
      return 'SKIPPED';
    }
    statementSettlementsTotal.inc({ service: SERVICE_NAME, outcome: 'refused' });
    this.logger.warn(
      `${envelope.eventName} ${envelope.eventId} contradicts statement ${statement.id}`,
    );
    // Not a retry: a verdict on the event. A retry cannot make two settlements one.
    throw new UnprocessableEventError(
      DLQ_REASONS.VALIDATION_FAILED,
      `${envelope.eventName} ${envelope.eventId} contradicts what is recorded (statement ${statement.id}; differs in ${differing.join(', ')})`,
    );
  }

  /** Counts the refusal and dead-letters the event as `SOURCE_UNCONFIRMED`. Nothing is written. */
  private refuse(transactionId: string, mismatch: SettlementMismatch): never {
    sourceVerificationsTotal.inc({
      service: SERVICE_NAME,
      consumer: 'settlement_completed',
      outcome: mismatch,
    });
    statementSettlementsTotal.inc({ service: SERVICE_NAME, outcome: 'refused' });
    throw new UnprocessableEventError(
      DLQ_REASONS.SOURCE_UNCONFIRMED,
      `economic-service does not confirm SETTLEMENT_COMPLETED for ${transactionId}: ${mismatch}`,
    );
  }
}

/** Thrown inside the transaction when a concurrent delivery settled the statement first. */
class AlreadySettled extends Error {
  constructor(readonly statement: Statement) {
    super('statement already settled');
  }
}
