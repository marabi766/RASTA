import type { EventEnvelope } from '@rasta/contracts';
import {
  createSystemContext,
  RastaError,
  runWithContext,
  UnprocessableEventError,
  type EventConsumer,
  type EventHandler,
  type HandlerOutcome,
} from '@rasta/nest-common';
import { DLQ_REASONS } from '@rasta/contracts';
import type { Logger } from '@rasta/logging';
import { SERVICE_NAME } from '../config/env';
import { performanceFactsTotal } from '../observability/metrics';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';
import { ConcludedOutcomeRepository } from './concluded-outcome.repository';
import { marketplaceContribution, type MarketplaceContribution } from './marketplace-facts';
import { PerformanceEventRepository, type RecordOutcome } from './performance-event.repository';

/** The consumer group, and this consumer's key in `processed_event`. */
export const PERFORMANCE_CONSUMER = 'supplier-service.performance';

/** The one topic it reads. Its producer is checked by `EventConsumer` (ADR-061 § 2). */
export const PERFORMANCE_CONSUMED_TOPICS = ['rasta.marketplace.v1'] as const;

/** Where a refused event goes: this service's own dead-letter topic. */
export const SUPPLIER_DEAD_LETTER_TOPIC = 'rasta.supplier.v1.dlq';

/** Built by the module; `null` in a run without a broker. Same shape as asset-service's. */
export type EventConsumerFactory = (handler: EventHandler) => EventConsumer;

/**
 * Records what marketplace events say about a supplier's performance
 * (ADR-052 step 5). Storage only: no score is computed here — that is step 6,
 * which waits on docs/24 Q-77, Q-78 and Q-79.
 *
 * ## Provenance, in the order it is checked
 *
 *   1. `EventConsumer` — the producer must be `marketplace-service`, the owner
 *      of the topic the broker delivered on (ADR-061 § 2). Consistency, not
 *      authentication: § 3 (SASL/ACL, RUN-006) is the gate before real data.
 *   2. `marketplaceContribution` — the envelope's tenant must be the payload's
 *      buyer (§ 5), or the event is dead-lettered `SOURCE_UNCONFIRMED`.
 *   Verify-at-source (§ 4) is **not** done: the score is reputational, not
 *   financial (A-13), and marketplace has no internal read endpoint to ask.
 *   The project manager recorded that as a known residual (2026-09-26).
 *
 * ## The one tenant switch
 *
 * The shared consumer runs a handler in the envelope's tenant — here, the
 * buyer's. A performance fact belongs to the supplier, so the write runs in
 * the supplier's tenant instead: `inSupplierTenant`, below, and nowhere else.
 * It happens only after § 5 has tied the envelope's tenant to the payload,
 * and only for the supplier organization that same payload names. ADR-061
 * § 5 forbids this switch in the financial consumers, whose effect lands in
 * the envelope's own tenant; ADR-052 records why this one differs.
 *
 * ## Unregistered suppliers
 *
 * A fact is recorded whether or not the supplier has a profile here — the
 * history is the order's, not the profile's. Step 6 never scores a supplier
 * that is not registered (project manager, 2026-09-26).
 *
 * ## Idempotency (ADR-032, ADR-052 rule 8)
 *
 * The `processed_event` marker and the row commit in one transaction. A
 * refusal throws before the commit, so a refused event is never marked. An
 * event that contributes nothing — another name, or a consumed one with no
 * measurement — is not marked either: there is no effect to record.
 */
export class PerformanceConsumer {
  private consumer?: EventConsumer;

  constructor(
    private readonly consumerFactory: EventConsumerFactory | null,
    private readonly prisma: PrismaService,
    private readonly events: PerformanceEventRepository,
    private readonly outcomes: ConcludedOutcomeRepository,
    private readonly logger: Pick<Logger, 'info' | 'warn' | 'debug'>,
  ) {}

  async start(): Promise<void> {
    if (!this.consumerFactory) {
      this.logger.warn('Performance consumer disabled — no Kafka broker configured');
      return;
    }
    this.consumer = this.consumerFactory((envelope) => this.handle(envelope));
    await this.consumer.start();
  }

  async stop(): Promise<void> {
    await this.consumer?.stop();
  }

  /** One event. Public so a test can drive it without a broker. */
  async handle(envelope: EventEnvelope): Promise<HandlerOutcome> {
    const contribution = marketplaceContribution(envelope);
    if (contribution === null) return 'SKIPPED';

    if (contribution.kind === 'NOT_A_FACT') {
      performanceFactsTotal.inc({
        service: SERVICE_NAME,
        event: envelope.eventName,
        result: contribution.reason,
      });
      this.logger.debug(
        `${envelope.eventName} ${envelope.eventId} carries no measurement (${contribution.reason})`,
      );
      return 'SKIPPED';
    }

    const outcome = await inSupplierTenant(envelope, supplierOf(contribution), () =>
      this.prisma.transaction((tx) => this.apply(tx, envelope, contribution)),
    );
    performanceFactsTotal.inc({
      service: SERVICE_NAME,
      event: envelope.eventName,
      result: outcome === 'RECORDED' ? 'recorded' : 'duplicate',
    });
  }

  private async apply(
    tx: ExtendedPrismaClient,
    envelope: EventEnvelope,
    contribution: Exclude<MarketplaceContribution, { kind: 'NOT_A_FACT' }>,
  ): Promise<RecordOutcome> {
    const { count } = await tx.processedEvent.createMany({
      data: [{ eventId: envelope.eventId, consumerName: PERFORMANCE_CONSUMER }],
      skipDuplicates: true,
    });
    if (count === 0) return 'DUPLICATE';

    try {
      return contribution.kind === 'FACT'
        ? await this.events.record(tx, contribution.fact)
        : await this.outcomes.record(tx, contribution.outcome);
    } catch (error) {
      throw asVerdict(envelope, error);
    }
  }
}

function supplierOf(
  contribution: Exclude<MarketplaceContribution, { kind: 'NOT_A_FACT' }>,
): string {
  return contribution.kind === 'FACT'
    ? contribution.fact.organizationId
    : contribution.outcome.organizationId;
}

/**
 * Runs `fn` in the supplier's tenant — the single, explicit tenant switch of
 * this consumer (see the class comment). The correlation id and the calling
 * service carry over from the envelope; only the organization changes.
 */
export function inSupplierTenant<T>(
  envelope: EventEnvelope,
  supplierOrganizationId: string,
  fn: () => T,
): T {
  return runWithContext(
    createSystemContext({
      correlationId: envelope.correlationId,
      organizationId: supplierOrganizationId,
      callerService: envelope.producer,
    }),
    fn,
  );
}

/**
 * A domain refusal from a repository is a verdict about the event, so it is
 * dead-lettered at once instead of retried: a fact the domain rules refuse
 * (`VALIDATION_FAILED`), or an event id already counted as a different fact
 * (`BUSINESS_RULE_VIOLATION`). Anything else — the database, a timeout — is
 * rethrown and retried by `EventConsumer`.
 */
function asVerdict(envelope: EventEnvelope, error: unknown): unknown {
  if (!(error instanceof RastaError)) return error;
  if (error.code === 'VALIDATION_FAILED') {
    return new UnprocessableEventError(
      DLQ_REASONS.VALIDATION_FAILED,
      `${envelope.eventName} ${envelope.eventId}: ${error.message}`,
    );
  }
  if (error.code === 'BUSINESS_RULE_VIOLATION') {
    return new UnprocessableEventError(
      DLQ_REASONS.BUSINESS_RULE_VIOLATION,
      `${envelope.eventName} ${envelope.eventId}: ${error.message}`,
    );
  }
  return error;
}
