import { DLQ_REASONS, type EventEnvelope } from '@rasta/contracts';
import {
  EventConsumer,
  RastaError,
  UnprocessableEventError,
  createSystemContext,
  invalidPayloadError,
  kafkaConnection,
  runWithContext,
  type EventDelivery,
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
import { StatementSettler } from '../settlement/statement-settler';
import type { Statement } from '../generated/prisma';
import { EventPublisher } from './publisher';
import type { EventConsumerFactory } from './tender-awarded.consumer';

/** The consumer group: `<service>.<purpose>` (ADR-061 § 3). */
export const SETTLEMENT_COMPLETED_CONSUMER = 'contract-service.settlement-completed';

/** The one topic it reads. `EventConsumer` also reads its `.retry` twin. */
export const SETTLEMENT_COMPLETED_TOPICS = ['rasta.economic.v1'] as const;

export const SETTLEMENT_COMPLETED = 'SETTLEMENT_COMPLETED';

export { SETTLING_ACTOR } from '../settlement/statement-settler';

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
        // A new group starts at the oldest retained message, not at the end (review of #343
        // round 1, F1): a settlement published before this consumer's first start — the
        // obligation settled through economic's existing endpoint — is still delivered. Older than
        // the topic's retention, `SettlementReconciliationSweeper` finds it by asking economic.
        // Replays are harmless: a statement already settled by the same settlement is SKIPPED.
        fromBeginning: true,
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
  private readonly settler: StatementSettler;

  constructor(
    private readonly consumerFactory: EventConsumerFactory,
    prisma: PrismaService,
    contracts: ContractRepository,
    private readonly settlements: SettlementRepository,
    publisher: EventPublisher,
    private readonly obligations: ObligationSource,
    private readonly logger: Pick<Logger, 'info' | 'warn' | 'debug'>,
  ) {
    this.settler = new StatementSettler(prisma, contracts, settlements, publisher);
  }

  async start(): Promise<void> {
    this.consumer = this.consumerFactory((envelope, delivery) => this.handle(envelope, delivery));
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

  /**
   * One event. Public so a test can drive it without a broker.
   *
   * `delivery.heartbeat` is called before and after each question to economic-service (review of
   * #343 round 1, F2): kafkajs heartbeats between messages, not during one, so a scan of many
   * candidates — each answered within `CONTRACT_SETTLEMENT_REQUEST_TIMEOUT_MS`, at most half the
   * session timeout — keeps this member in its group however long the scan as a whole takes.
   */
  async handle(envelope: EventEnvelope, delivery?: EventDelivery): Promise<HandlerOutcome> {
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
        delivery?.heartbeat?.();
        try {
          fact = await this.obligations.obligation(tenant, candidate.id);
        } catch (error) {
          if (error instanceof RastaError) {
            statementSettlementsTotal.inc({ service: SERVICE_NAME, outcome: 'unavailable' });
          }
          throw error;
        } finally {
          delivery?.heartbeat?.();
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
    const result = await this.settler.settle(candidate, claim, settlement, {
      reference: envelope.eventId,
      causationId: envelope.eventId,
    });
    // A concurrent delivery (or the reconciliation) settled it first: judged as a redelivery.
    if (result.outcome === 'already') return this.judgeRecorded(envelope, claim, result.statement);

    statementSettlementsTotal.inc({ service: SERVICE_NAME, outcome: result.outcome });
    this.logger.info(
      result.outcome === 'contract_settled'
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
