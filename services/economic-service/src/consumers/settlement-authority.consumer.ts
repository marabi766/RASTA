import { Logger, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { DLQ_REASONS, type EventEnvelope } from '@rasta/contracts';
import {
  createSystemContext,
  runWithContext,
  runUnscoped,
  UnprocessableEventError,
  type EventConsumer,
  type HandlerOutcome,
} from '@rasta/nest-common';
import { PrismaService } from '../prisma/prisma.service';
import { TransactionService } from '../transaction/transaction.service';
import { CONSUMED_EVENTS, maintenanceApprovedSchema } from '../events/consumed';
import { SERVICE_NAME } from '../config/env';
import { sourceVerificationsTotal } from '../observability/metrics';
import {
  confirmApproval,
  confirmTenant,
  noObligationReason,
  type Mismatch,
} from '../provenance/confirm';
import type { SourceFacts } from '../provenance/source-facts.client';

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
 * ## The approval is read from maintenance-service, not from the event (ADR-061 § 4)
 *
 * The event is its publisher's claim, and the broker does not yet
 * authenticate publishers. So before anything is recorded, the approval is
 * read from maintenance-service over authenticated REST, with the event's
 * organization signed into the token, and compared field by field: the
 * organization, the asset, `APPROVED`, the amount, the currency, the workshop
 * that gets paid, and who approved it and when.
 *
 *   - **The owner disagrees** (no such request in that organization, or any
 *     field differs): dead-lettered at once as `SOURCE_UNCONFIRMED`, with the
 *     field that differed. Nothing is recorded. A retry cannot change the
 *     owner's answer.
 *   - **The owner cannot be asked** (down, slow, misconfigured): the handler
 *     throws, the consumer retries, and the event is dead-lettered as
 *     `UPSTREAM_UNAVAILABLE` once the retries run out. Nothing is recorded. It
 *     fails closed, and a DLQ replay recovers it once maintenance-service is back.
 *
 * The HTTP call happens outside the database transaction, so a slow owner
 * never holds a connection or a lock.
 *
 * ## Idempotency, twice over
 *
 * `processed_event` in the same transaction as the effect (ADR-021), and
 * separately a lookup on `(sourceType, sourceReference)`. The second is not
 * redundant: a producer that re-emits the same approval under a **new event
 * id** would pass the first check, and one repair must produce one obligation.
 *
 * ## The tenant is checked before anything else (ADR-061 § 5)
 *
 * The envelope's `tenantId` must equal the payload's organization. A mismatch,
 * or no tenant at all, is dead-lettered as `SOURCE_UNCONFIRMED` before the
 * owner is asked, and the owner is only ever asked inside that one tenant.
 *
 * ## What it skips rather than fails, decided from the owner's record
 *
 * An approval with no workshop (an in-house repair with no external party), an
 * approval whose total is zero, and a repair in the payer's own workshop.
 * There is nobody else to pay, or nothing to pay. All are normal, so they are
 * skipped and marked processed rather than dead-lettered. But they are decided
 * **after** the owner confirms the approval, from the owner's values (PR #110
 * review #2): an event that merely *claims* "no workshop" or "zero" for an
 * approval the owner recorded differently is a mismatch, and is dead-lettered.
 */
export class SettlementAuthorityConsumer implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(SettlementAuthorityConsumer.name);
  private readonly consumer: EventConsumer;

  static readonly CONSUMER_NAME = 'economic-service.settlement-authority';

  constructor(
    build: (handler: (envelope: EventEnvelope) => Promise<HandlerOutcome>) => EventConsumer,
    private readonly prisma: PrismaService,
    private readonly transactions: TransactionService,
    private readonly sources: SourceFacts,
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

    // Before any skip, any lookup and any token: the envelope's tenant and the
    // payload's organization are one, or the event is refused (ADR-061 § 5).
    const tenancy = confirmTenant(envelope.tenantId, payload.organizationId);
    if (!tenancy.confirmed) this.refuse(payload.requestId, tenancy.mismatch);
    const tenant = payload.organizationId;

    // A system context, because a consumer has no request. The correlation id
    // is carried from the envelope so the whole chain — the approval in
    // maintenance-service, this obligation, and the settlement that follows —
    // shares one identifier (docs/13). The tenant is the envelope's, now
    // proved equal to the payload's; nothing re-contexts to another.
    const context = createSystemContext({
      correlationId: envelope.correlationId,
      organizationId: tenant,
      callerService: SERVICE_NAME,
    });

    return runWithContext(context, async () => {
      // Checked first so a replayed event costs no round trip to the owner.
      // Checked again inside the transaction below, which is the check that
      // counts.
      if (await this.alreadyProcessed(this.prisma.client, envelope.eventId)) {
        this.logger.debug(`Event ${envelope.eventId} already processed; no second effect`);
        return 'SKIPPED';
      }

      // Throws on an owner that cannot be asked: retried, never acted on.
      const fact = await this.sources.maintenanceRequest(tenant, payload.requestId);
      const verdict = confirmApproval(payload, fact);
      if (!verdict.confirmed || !fact) {
        this.refuse(payload.requestId, verdict.confirmed ? 'not_found' : verdict.mismatch);
      }
      sourceVerificationsTotal.inc({
        service: SERVICE_NAME,
        consumer: 'settlement_authority',
        outcome: 'confirmed',
      });

      // Decided from the owner's record, after it confirmed the approval.
      const noObligation = noObligationReason(fact);
      if (noObligation) {
        // `ck_transaction_amounts` requires a positive gross and
        // `ck_transaction_distinct_parties` two parties, so none of these could
        // be an obligation, and none should: nobody else is owed anything.
        this.logger.log(
          `Approval ${payload.requestId} creates no obligation (${noObligation}), as maintenance-service records it`,
        );
        await this.prisma.transaction(async (tx) => {
          if (await this.alreadyProcessed(tx, envelope.eventId)) return;
          await this.markProcessed(tx, envelope.eventId);
        });
        return 'SKIPPED';
      }
      // Narrowed by `noObligationReason`: a workshop other than the payer.
      const payeeOrganizationId = fact.workshopOrganizationId!;

      const alreadyProcessed = await this.prisma.transaction(async (tx) => {
        if (await this.alreadyProcessed(tx, envelope.eventId)) return true;

        // Every figure from the owner's answer. `confirmApproval` has just
        // proved it equal to the event's, so this changes no outcome. It
        // does mean nothing recorded here was taken on the event's word.
        const result = await this.transactions.recordAuthorisedObligation(tx, {
          organizationId: fact.organizationId,
          counterpartyOrganizationId: payeeOrganizationId,
          transactionType: 'MAINTENANCE_SERVICE',
          grossAmountMinor: BigInt(fact.totalCostMinor),
          currency: fact.currency,
          // Equal to the event's instant; `confirmApproval` refuses a fact without one.
          occurredAt: new Date(fact.approvedAt ?? payload.approvedAt),
          sourceType: 'MAINTENANCE_REQUEST',
          sourceReference: payload.requestId,
          causationId: envelope.eventId,
        });

        // Written in the same transaction as the effect. That is the whole
        // idempotency guarantee: the row and the obligation commit together or
        // neither does (ADR-021).
        await this.markProcessed(tx, envelope.eventId);

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

  /** Counts the refusal and dead-letters the event as `SOURCE_UNCONFIRMED`. */
  private refuse(requestId: string, mismatch: Mismatch): never {
    sourceVerificationsTotal.inc({
      service: SERVICE_NAME,
      consumer: 'settlement_authority',
      outcome: mismatch,
    });
    throw new UnprocessableEventError(
      DLQ_REASONS.SOURCE_UNCONFIRMED,
      `maintenance-service does not confirm MAINTENANCE_APPROVED for ${requestId}: ${mismatch}`,
    );
  }

  private async markProcessed(
    tx: Pick<PrismaService['client'], 'processedEvent'>,
    eventId: string,
  ): Promise<void> {
    await runUnscoped('the processed-event ledger is platform plumbing with no tenant column', () =>
      tx.processedEvent.create({
        data: { eventId, consumerName: SettlementAuthorityConsumer.CONSUMER_NAME },
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
              consumerName: SettlementAuthorityConsumer.CONSUMER_NAME,
            },
          },
        }),
    );
    return seen !== null;
  }
}
