import { Logger, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import type { EventEnvelope } from '@rasta/contracts';
import {
  createSystemContext,
  runWithContext,
  runUnscoped,
  type EventConsumer,
  type HandlerOutcome,
} from '@rasta/nest-common';
import { PrismaService } from '../prisma/prisma.service';
import { TransactionService } from '../transaction/transaction.service';
import { CONSUMED_EVENTS, maintenanceApprovedSchema } from '../events/consumed';
import { SERVICE_NAME } from '../config/env';

/**
 * Consumes `MAINTENANCE_APPROVED` and records a settleable obligation
 * (ADR-032).
 *
 * ## What it does, and the one thing it deliberately does not
 *
 * It writes a `Transaction` in `PENDING_SETTLEMENT`: the payer, the workshop,
 * the amount the owner approved, and the date they approved it. That is the
 * "مجوز تسویه" the product document requires before any money moves.
 *
 * **It moves no money.** No hold, no journal, no balance change. Two reasons,
 * and the second is the one that decided it:
 *
 *   - No document says an approval debits a wallet. Making it do so would
 *     invent both a payment mechanism and the rule that the machine's owner
 *     pays their workshop out of a platform wallet.
 *   - An approval arriving for an organization with an empty wallet would then
 *     have to fail. The repair already happened and the cost is already owed;
 *     dead-lettering the event would lose a person's approval to protect a
 *     balance. Recording the obligation and letting it wait is the honest
 *     outcome, and the queue is visible in
 *     `rasta_economic_transactions_pending_settlement`.
 *
 * ## Idempotency, twice over
 *
 * `processed_event` in the same transaction as the effect (ADR-021), and
 * separately a lookup on `(sourceType, sourceReference)`. The second is not
 * redundant: a producer that re-emits the same approval under a **new event
 * id** would pass the first check, and one repair must produce one obligation.
 *
 * ## What it skips rather than fails
 *
 * An approval with no `workshopOrganizationId` — an in-house repair with no
 * external party — and an approval whose total is zero. There is nobody to pay
 * in the first case and nothing to pay in the second. Both are normal events,
 * so both are skipped rather than dead-lettered: a dead-letter would make an
 * ordinary occurrence look like a defect and would need a human to clear it.
 */
export class SettlementAuthorityConsumer implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(SettlementAuthorityConsumer.name);
  private readonly consumer: EventConsumer;

  static readonly CONSUMER_NAME = 'economic-service.settlement-authority';

  constructor(
    build: (handler: (envelope: EventEnvelope) => Promise<HandlerOutcome>) => EventConsumer,
    private readonly prisma: PrismaService,
    private readonly transactions: TransactionService,
  ) {
    this.consumer = build((envelope) => this.handle(envelope));
  }

  async onModuleInit(): Promise<void> {
    await this.consumer.start();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.consumer.stop();
  }

  async handle(envelope: EventEnvelope): Promise<HandlerOutcome> {
    if (envelope.eventName !== CONSUMED_EVENTS.MAINTENANCE_APPROVED) return 'SKIPPED';

    const payload = maintenanceApprovedSchema.parse(envelope.payload);

    const payeeOrganizationId = payload.workshopOrganizationId;
    if (!payeeOrganizationId) {
      this.logger.log(
        `Approval ${payload.requestId} names no workshop; nothing is owed to anyone outside the organization`,
      );
      return 'SKIPPED';
    }

    if (BigInt(payload.totalCostMinor) <= 0n) {
      // `ck_transaction_amounts` requires a positive gross, so a repair that
      // cost nothing cannot become an obligation — and should not: there is
      // nothing to settle.
      this.logger.log(`Approval ${payload.requestId} has no cost; nothing to settle`);
      return 'SKIPPED';
    }

    if (payeeOrganizationId === payload.organizationId) {
      // An organization repairing its own machine in its own workshop. Real,
      // and not an obligation between parties — `ck_transaction_distinct_parties`
      // would refuse the row anyway, so it is recognised here rather than
      // surfacing as a constraint violation.
      this.logger.log(
        `Approval ${payload.requestId} is an in-house repair; no cross-party obligation arises`,
      );
      return 'SKIPPED';
    }

    // A system context, because a consumer has no request. The correlation id
    // is carried from the envelope so the whole chain — the approval in
    // maintenance-service, this obligation, and the settlement that follows —
    // shares one identifier (docs/13).
    const context = createSystemContext({
      correlationId: envelope.correlationId,
      organizationId: payload.organizationId,
      callerService: SERVICE_NAME,
    });

    return runWithContext(context, async () => {
      const alreadyProcessed = await this.prisma.transaction(async (tx) => {
        const seen = await runUnscoped(
          'the processed-event ledger is platform plumbing with no tenant column',
          () =>
            tx.processedEvent.findUnique({
              where: {
                eventId_consumerName: {
                  eventId: envelope.eventId,
                  consumerName: SettlementAuthorityConsumer.CONSUMER_NAME,
                },
              },
            }),
        );
        if (seen) return true;

        const result = await this.transactions.recordAuthorisedObligation(tx, {
          organizationId: payload.organizationId,
          counterpartyOrganizationId: payeeOrganizationId,
          transactionType: 'MAINTENANCE_SERVICE',
          grossAmountMinor: BigInt(payload.totalCostMinor),
          currency: payload.currency,
          occurredAt: new Date(payload.approvedAt),
          sourceType: 'MAINTENANCE_REQUEST',
          sourceReference: payload.requestId,
          causationId: envelope.eventId,
        });

        // Written in the same transaction as the effect. That is the whole
        // idempotency guarantee: the row and the obligation commit together or
        // neither does (ADR-021).
        await runUnscoped(
          'the processed-event ledger is platform plumbing with no tenant column',
          () =>
            tx.processedEvent.create({
              data: {
                eventId: envelope.eventId,
                consumerName: SettlementAuthorityConsumer.CONSUMER_NAME,
              },
            }),
        );

        if (result.created) {
          this.logger.log(
            `Recorded a settleable obligation for maintenance request ${payload.requestId}`,
          );
        }
        return false;
      });

      if (alreadyProcessed) {
        this.logger.debug(`Event ${envelope.eventId} already processed; no second effect`);
        return 'SKIPPED';
      }

      return undefined;
    });
  }
}
