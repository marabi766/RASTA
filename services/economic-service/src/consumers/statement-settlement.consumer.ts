import { Logger, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { DLQ_REASONS, type EventEnvelope, legacyParse } from '@rasta/contracts';
import {
  WorkerBoundary,
  WorkerAbandonedError,
  workerOperation,
  WorkerDrain,
  createSystemContext,
  invalidPayloadError,
  runWithContext,
  runUnscoped,
  UnprocessableEventError,
  type EventConsumer,
  type HandlerOutcome,
  type OutboxStopOptions,
} from '@rasta/nest-common';
import { PrismaService } from '../prisma/prisma.service';
import { TransactionService } from '../transaction/transaction.service';
import {
  CONSUMED_EVENTS,
  STATEMENT_APPROVED_FIELDS,
  statementApprovedSchema,
} from '../events/consumed';
import { SERVICE_NAME } from '../config/env';
import { sourceVerificationsTotal, transactionsCreatedTotal } from '../observability/metrics';
import {
  confirmStatementApproval,
  confirmTenant,
  statementNoObligationReason,
  type Mismatch,
} from '../provenance/confirm';
import type { SourceFacts } from '../provenance/source-facts.client';
import { STATEMENT_SOURCE_TYPE } from '../transaction/dto';
import type { BusinessLine } from '../generated/prisma';

/**
 * Consumes `STATEMENT_APPROVED` and records the statement's settleable
 * obligation (ADR-068 § 6 (2), CON-003 PR 6b) — the mirror of
 * `settlement-authority` for a repair (ADR-032).
 *
 * ## The event is a trigger; the obligation is built from the owner's answer
 *
 * `STATEMENT_APPROVED` carries identifiers and the instant only (Q-97 (2)).
 * Before anything is written, the statement is read from contract-service over
 * authenticated REST (A-13, ADR-061 § 4) — `GET /v1/internal/statements/{id}`,
 * a service token signed for the event's organization, outside any database
 * transaction and under `ECONOMIC_SOURCE_REQUEST_TIMEOUT_MS` — and the
 * obligation takes its **amount (the net), payer, beneficiary and currency
 * from that answer**. The event's claims are only compared:
 *
 *   - **the owner disagrees or refuses** — no such statement for that employer,
 *     another contract, payer or contractor, another approval instant, a status
 *     other than APPROVED (approval is final, so no retry changes it), or a
 *     currency this service keeps no wallet in: dead-lettered at once as
 *     `SOURCE_UNCONFIRMED`, naming what differed. Nothing is recorded;
 *   - **the owner cannot be asked** (down, slow, 403, a body that does not
 *     parse): the handler throws, the consumer retries, and the event is
 *     dead-lettered as `UPSTREAM_UNAVAILABLE` once the retries run out. Nothing
 *     is recorded. A DLQ replay recovers it.
 *
 * ## What it records, and what it does not (Q-97 (3), (4))
 *
 * One `CONSTRUCTION_STATEMENT` transaction, straight to `PENDING_SETTLEMENT`,
 * for the whole net: no partial payment, no retention, no advance — a
 * configured deduction has already reduced the net and nothing returns it.
 * Its commission pricing is this service's own rule in force at `approvedAt`
 * (ADR-045 § 4): contract-service sends no rate. The business line is
 * `ECONOMIC_STATEMENT_BUSINESS_LINE`, unset by default (docs/24 Q-130). **No
 * money moves**: no hold, no journal, no balance change. The existing settle
 * path (`POST /v1/settlements`) settles it like any other obligation. Recorded
 * once, its terms never change (`trg_transaction_statement_obligation_fixed`).
 * The record is `TRANSACTION_STATUS_CHANGED` with action
 * `RECORD_AUTHORISED_OBLIGATION`, in the same transaction (ADR-021).
 *
 * A net of zero — the whole gross deducted — is owed to nobody, so it is
 * skipped and marked processed, decided from the owner's figure.
 *
 * ## One statement, at most one obligation (ADR-068 § 6 (5) I4)
 *
 * `processed_event` in the transaction of the effect, and the unique key
 * `ux_transaction_source_fact` on `(payer, STATEMENT, statementId)`: a
 * re-emitted approval under a new event id, or two deliveries racing, find the
 * winner's row and record nothing. The payer is the owner's answer, a function
 * of the statement, so per payer is per statement.
 *
 * ## The tenant is checked before anything else (ADR-061 § 5)
 *
 * The envelope's `tenantId` must be the payload's employer, or the event is
 * refused before any token is minted or the owner is asked.
 */
export class StatementSettlementConsumer implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(StatementSettlementConsumer.name);
  private readonly consumer: EventConsumer;
  private readonly worker = new WorkerBoundary(() =>
    this.logger.warn('Obligation worker ABANDONED; submitted write outcome UNCONFIRMED'),
  );
  private stopped = false;
  private readonly drain = new WorkerDrain(
    this.worker,
    {
      stop: (options) => this.consumer.stop(options),
    },
    () => this.logger.warn('Obligation worker ABANDONED; submitted write outcome UNCONFIRMED'),
  );

  static readonly CONSUMER_NAME = 'economic-service.statement-settlement';

  constructor(
    build: (handler: (envelope: EventEnvelope) => Promise<HandlerOutcome>) => EventConsumer,
    private readonly prisma: PrismaService,
    private readonly transactions: TransactionService,
    private readonly sources: SourceFacts,
    /** `ECONOMIC_STATEMENT_BUSINESS_LINE`; null while Q-130 is open. */
    private readonly businessLine: BusinessLine | null,
  ) {
    this.consumer = build((envelope) => this.handle(envelope));
  }

  async onModuleInit(): Promise<void> {
    await this.consumer.start();
  }

  /** Drains broker and direct deliveries under the coordinator's one deadline. */
  stop(options: OutboxStopOptions = {}): Promise<void> {
    this.stopped = true;
    return this.drain.stop(options);
  }

  /** Joins the stop `OutboxShutdown` began; returns at once. */
  onApplicationShutdown(): Promise<void> {
    return this.stop();
  }

  handle(envelope: EventEnvelope): Promise<HandlerOutcome> {
    return this.worker.run(() => {
      this.worker.assertActive();
      if (this.stopped) throw new WorkerAbandonedError();
      return workerOperation(() => this.process(envelope));
    });
  }

  private async process(envelope: EventEnvelope): Promise<HandlerOutcome> {
    // The contract topic carries every contract and statement event; only the
    // financial chain's final approval is a fact this service acts on.
    if (envelope.eventName !== CONSUMED_EVENTS.STATEMENT_APPROVED) return 'SKIPPED';

    // A producer defect no retry fixes: dead-lettered at once, before the
    // processed marker, naming fields only (S-09, L7-26).
    const parsed = legacyParse(statementApprovedSchema, envelope.payload);
    if (!parsed.success) {
      throw invalidPayloadError(envelope, parsed.refusal, STATEMENT_APPROVED_FIELDS);
    }
    const payload = parsed.data;

    const tenancy = confirmTenant(envelope.tenantId, payload.organizationId);
    if (!tenancy.confirmed) this.refuse(payload.statementId, tenancy.mismatch);
    const tenant = payload.organizationId;

    const context = createSystemContext({
      correlationId: envelope.correlationId,
      organizationId: tenant,
      callerService: SERVICE_NAME,
    });

    return runWithContext(context, async () => {
      // The fast path, so a redelivery costs no round trip to the owner; the
      // check inside the transaction below is the one that counts.
      if (await this.alreadyProcessed(this.prisma.client, envelope.eventId)) {
        this.logger.debug(`Event ${envelope.eventId} already processed; no second effect`);
        return 'SKIPPED';
      }

      // Outside any transaction; throws on an owner that cannot be asked.
      const fact = await workerOperation(() => this.sources.statement(tenant, payload.statementId));
      const verdict = confirmStatementApproval(payload, fact);
      if (!verdict.confirmed || !fact) {
        this.refuse(payload.statementId, verdict.confirmed ? 'not_found' : verdict.mismatch);
      }
      sourceVerificationsTotal.inc({
        service: SERVICE_NAME,
        consumer: 'statement_settlement',
        outcome: 'confirmed',
      });

      const noObligation = statementNoObligationReason(fact);
      if (noObligation) {
        this.logger.log(
          `Statement ${payload.statementId} creates no obligation (${noObligation}), as contract-service records it`,
        );
        await this.prisma.transaction(async (tx) => {
          if (await this.alreadyProcessed(tx, envelope.eventId)) return;
          await this.markProcessed(tx, envelope.eventId);
        });
        return 'SKIPPED';
      }
      // `confirmStatementApproval` refused a statement without its instant.
      if (!fact.approvedAt) this.refuse(payload.statementId, 'approval_mismatch');
      const approvedAt = new Date(fact.approvedAt);

      const outcome = await this.prisma.transaction(async (tx) => {
        if (await this.alreadyProcessed(tx, envelope.eventId)) return null;

        // Every term from the owner's answer, none from the event.
        const result = await this.transactions.recordAuthorisedObligation(tx, {
          organizationId: fact.payerOrganizationId,
          counterpartyOrganizationId: fact.beneficiaryOrganizationId,
          transactionType: 'CONSTRUCTION_STATEMENT',
          businessLine: this.businessLine,
          grossAmountMinor: BigInt(fact.netMinor),
          currency: fact.currency,
          occurredAt: approvedAt,
          sourceType: STATEMENT_SOURCE_TYPE,
          sourceReference: fact.statementId,
          causationId: envelope.eventId,
        });

        await this.markProcessed(tx, envelope.eventId);

        return result;
      });
      this.worker.assertActive();

      if (outcome === null) {
        this.logger.debug(`Event ${envelope.eventId} already processed; no second effect`);
        return 'SKIPPED';
      }
      if (outcome.created) {
        transactionsCreatedTotal.inc({
          service: SERVICE_NAME,
          type: 'CONSTRUCTION_STATEMENT',
          source: 'event',
        });
        this.logger.log(`Recorded a settleable obligation for statement ${fact.statementId}`);
      }
      return undefined;
    });
  }

  /** Counts the refusal and dead-letters the event as `SOURCE_UNCONFIRMED`. */
  private refuse(statementId: string, mismatch: Mismatch): never {
    sourceVerificationsTotal.inc({
      service: SERVICE_NAME,
      consumer: 'statement_settlement',
      outcome: mismatch,
    });
    throw new UnprocessableEventError(
      DLQ_REASONS.SOURCE_UNCONFIRMED,
      `contract-service does not confirm STATEMENT_APPROVED for ${statementId}: ${mismatch}`,
    );
  }

  private async markProcessed(
    tx: Pick<PrismaService['client'], 'processedEvent'>,
    eventId: string,
  ): Promise<void> {
    await runUnscoped('the processed-event ledger is platform plumbing with no tenant column', () =>
      tx.processedEvent.create({
        data: { eventId, consumerName: StatementSettlementConsumer.CONSUMER_NAME },
      }),
    );
  }

  private async alreadyProcessed(
    client: Pick<PrismaService['client'], 'processedEvent'>,
    eventId: string,
  ): Promise<boolean> {
    const seen = await runUnscoped(
      'the processed-event ledger is platform plumbing with no tenant column',
      () =>
        client.processedEvent.findUnique({
          where: {
            eventId_consumerName: {
              eventId,
              consumerName: StatementSettlementConsumer.CONSUMER_NAME,
            },
          },
        }),
    );
    return seen !== null;
  }
}
