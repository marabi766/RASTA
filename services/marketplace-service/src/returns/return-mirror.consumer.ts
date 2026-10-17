import { DLQ_REASONS, type EventEnvelope } from '@rasta/contracts';
import {
  UnprocessableEventError,
  type EventConsumer,
  type EventHandler,
  type HandlerOutcome,
  type OutboxStopOptions,
} from '@rasta/nest-common';
import type { Logger } from '@rasta/logging';
import { SERVICE_NAME, type MarketplaceEnv } from '../config/env';
import { MARKETPLACE_EVENTS } from '../events/events';
import { EventPublisher, ID_PREFIX, newId } from '../events/publisher';
import { returnMirrorEventsTotal, returnTransitionsTotal } from '../observability/metrics';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';
import { isUniqueViolation, violatedConstraint } from '../shared/prisma-errors';
import { decideMirror, mirrorStepOf, type MirrorRules, type MirrorStep } from './return-mirror';
import { ReturnRepository, type LockedReturnRow, type ReturnRequestRow } from './return.repository';
import { commandKeyHash, facts } from './return.service';
import { versionAfter } from './state-machine';

/** The consumer group, and this consumer's key in `processed_event`. */
export const RETURN_MIRROR_CONSUMER = 'marketplace-service.return-mirror';

/** The one topic it reads. Its producer is checked by `EventConsumer` (ADR-061 § 2). */
export const RETURN_MIRROR_CONSUMED_TOPICS = ['rasta.inventory.v1'] as const;

/** Where a refused event goes: this service's own dead-letter topic (`TOPIC_CONSUMERS`). */
export const MARKETPLACE_DEAD_LETTER_TOPIC = 'rasta.marketplace.v1.dlq';

/** Built by the module; `null` while the consumer is disabled. Same shape as supplier-service's. */
export type EventConsumerFactory = (handler: EventHandler) => EventConsumer;

/** Logged at startup while the consumer is off — which is the default. */
export const RETURN_MIRROR_DISABLED =
  'Return mirror not started: MARKETPLACE_RETURN_MIRROR_CONSUMER_ENABLED is false (the default). ' +
  'It moves a buyer’s return request on an inventory-service event in the supplier’s name; ' +
  'enabling it is a deployment decision, allowed only over this service’s own SASL credential and ' +
  'TLS to a broker that enforces per-topic ACLs (ADR-061 § 3, RUN-006).';

/** The broker-facing half, or `null` — no subscription at all — unless the flag is on. */
export function returnMirrorConsumerFactory(
  env: Pick<MarketplaceEnv, 'MARKETPLACE_RETURN_MIRROR_CONSUMER_ENABLED'>,
  build: EventConsumerFactory,
): EventConsumerFactory | null {
  return env.MARKETPLACE_RETURN_MIRROR_CONSUMER_ENABLED ? build : null;
}

/** Thrown for a step that arrived before the one it follows: retried, never applied early. */
export class ReturnStepAheadError extends Error {
  override readonly name = 'ReturnStepAheadError';
}

/** The index that keeps one shipment on one request of a buyer. */
const SHIPMENT_INDEX = 'ux_return_request_shipment';

/**
 * Mirrors the physical half of a return onto the request marketplace owns (ADR-048 § 2, § 3;
 * RUN-005 PR 3; docs/23 D-058): inventory-service's `RETURN_SHIPMENT_DISPATCHED`, `_RECEIVED`,
 * `_INSPECTED` and `_RESOLVED` move an `AUTHORIZED` request to `IN_TRANSIT`, `RECEIVED`,
 * `INSPECTED` and `RESOLVED`, and each move publishes the request's own `RETURN_*` event.
 *
 * ## Provenance and tenant, in the order they are checked
 *
 *   1. `EventConsumer` — the producer must be inventory-service, the owner of the topic the broker
 *      delivered on (ADR-061 § 2).
 *   2. `mirrorStepOf` — the version, the contract, and ADR-061 § 5: the envelope's tenant is the
 *      payload's organization (the supplier who owns the destination warehouse).
 *   3. `decideMirror`, under the request's row lock — the request exists, and its supplier is that
 *      tenant, its buyer the payload's buyer, its order the payload's order. Any mismatch is
 *      `SOURCE_UNCONFIRMED` and nothing is written: an event can never move a request of
 *      organizations it is not about. The write itself lands on the buyer's row, the request's own
 *      tenant — the same crossing the supplier's HTTP decisions make (`return.repository.ts`).
 *
 * ## No money (ADR-061 § 4)
 *
 * No step here has a financial effect: no Hold, Refund or Reversal is asked for, and `RESOLVED`
 * is not a refund (ADR-048 § 3). A refund for a settled order has no economic operation yet
 * (docs/10 § 10.4, Q-76). So § 4's verify-at-source is not required, and no source is read.
 *
 * ## Idempotency and order (ADR-032; the contract's ordering rule)
 *
 * The request is locked first, so every delivery about it — the same event twice included —
 * serialises on that row. The request's own version says how far its shipment got (version
 * `2 + returnShipmentVersion`):
 *
 *   - the next step applies: the move, its history row, its outbox event and the
 *     `processed_event` marker commit together;
 *   - a step at or below it is a duplicate or a stale redelivery and has no effect (`SKIPPED`,
 *     unmarked — there is no effect to record);
 *   - a step beyond the next is **not applied out of order**: it fails as retriable, the consumer
 *     retries it, and if its predecessor still has not been applied it is dead-lettered
 *     (`MAX_RETRIES_EXCEEDED`) to be replayed once that predecessor is. Nothing is parked here.
 *
 * A marker for an event whose step was not applied is a contradiction and is refused, rolled back
 * with this delivery, rather than silently "repaired". The history row's key is the event's id,
 * hashed, so even a lost marker cannot record a step twice.
 */
export class ReturnMirrorConsumer {
  private consumer?: EventConsumer;

  constructor(
    private readonly consumerFactory: EventConsumerFactory | null,
    private readonly prisma: PrismaService,
    private readonly repository: ReturnRepository,
    private readonly events: EventPublisher,
    private readonly rules: MirrorRules,
    private readonly logger: Pick<Logger, 'info' | 'warn' | 'debug'>,
  ) {}

  async start(): Promise<void> {
    if (!this.consumerFactory) {
      this.logger.warn(RETURN_MIRROR_DISABLED);
      return;
    }
    this.consumer = this.consumerFactory((envelope) => this.handle(envelope));
    await this.consumer.start();
  }

  /**
   * An `OutboxShutdown` worker: stopped in Nest's destroy phase, beside the relay, the purge and
   * the saga worker, by the shutdown's one deadline. An event still in flight is abandoned
   * uncommitted and delivered again; the request's version keeps a second step out.
   */
  stop(options?: OutboxStopOptions): Promise<void> {
    return this.consumer?.stop(options) ?? Promise.resolve();
  }

  /** One event. Public so a test can drive it without a broker. */
  async handle(envelope: EventEnvelope): Promise<HandlerOutcome> {
    let step: MirrorStep | null;
    try {
      step = mirrorStepOf(envelope);
    } catch (error) {
      this.count(envelope, 'refused');
      throw error;
    }
    if (step === null) return 'SKIPPED';

    let outcome: 'applied' | 'duplicate' | 'stale';
    try {
      outcome = await this.prisma.transaction((tx) => this.apply(tx, envelope, step));
    } catch (error) {
      if (error instanceof ReturnStepAheadError) {
        this.count(envelope, 'ahead');
        throw error;
      }
      const verdict = asVerdict(envelope, error);
      this.count(envelope, verdict instanceof UnprocessableEventError ? 'refused' : 'failed');
      throw verdict;
    }
    this.count(envelope, outcome);
    if (outcome === 'applied') return undefined;
    this.logger.debug(
      `${envelope.eventName} ${envelope.eventId} has no effect: return request already past it (${outcome})`,
    );
    return 'SKIPPED';
  }

  private async apply(
    tx: ExtendedPrismaClient,
    envelope: EventEnvelope,
    step: MirrorStep,
  ): Promise<'applied' | 'duplicate' | 'stale'> {
    const payload = step.payload;
    // The row lock serialises every delivery about this request, the same event twice included.
    const locked = await this.repository.lockRequest(tx, payload.returnRequestId);
    const row = locked ? await this.repository.findWithLines(locked.id, tx) : null;
    const decision = decideMirror(
      envelope,
      step,
      locked && row ? { ...locked, lines: row.lines } : null,
      this.rules,
    );
    const marked = await this.isMarked(tx, envelope.eventId);

    if (decision === 'STALE') return marked ? 'duplicate' : 'stale';
    if (decision === 'AHEAD') {
      throw new ReturnStepAheadError(
        `${envelope.eventName} ${envelope.eventId} is step ${step.seq} of return shipment ` +
          `${payload.returnShipmentId}, but return request ${locked!.id} is at version ` +
          `${locked!.version}: its earlier step has not been applied; replay it after that one`,
      );
    }
    if (marked) {
      throw new UnprocessableEventError(
        DLQ_REASONS.BUSINESS_RULE_VIOLATION,
        `${envelope.eventName} ${envelope.eventId} is marked processed but its step was never applied`,
      );
    }

    await this.move(tx, envelope, step, locked!);
    await tx.processedEvent.create({
      data: { eventId: envelope.eventId, consumerName: RETURN_MIRROR_CONSUMER },
    });
    return 'applied';
  }

  private async isMarked(tx: ExtendedPrismaClient, eventId: string): Promise<boolean> {
    const marker = await tx.processedEvent.findUnique({
      where: { eventId_consumerName: { eventId, consumerName: RETURN_MIRROR_CONSUMER } },
      select: { eventId: true },
    });
    return marker !== null;
  }

  private async move(
    tx: ExtendedPrismaClient,
    envelope: EventEnvelope,
    step: MirrorStep,
    locked: LockedReturnRow,
  ): Promise<void> {
    // The mirror's own clock orders the history (never before the step it follows); the step's
    // instant is inventory's fact and is stored as reported.
    const at = new Date(Math.max(Date.now(), locked.updatedAt.getTime()));
    const version = versionAfter(step.to, locked.status);
    const moved = await this.repository.advance(tx, locked, {
      status: step.to,
      version,
      updatedAt: at,
      ...stepColumns(step),
    });
    if (!moved) throw new Error(`Return request ${locked.id} changed under its own lock`);

    await this.repository.insertHistory(tx, {
      id: newId(ID_PREFIX.returnHistory),
      organizationId: locked.organizationId,
      returnRequestId: locked.id,
      fromStatus: locked.status,
      toStatus: step.to,
      version,
      actorId: actorOf(step),
      correlationId: envelope.correlationId,
      commandKeyHash: commandKeyHash(
        'EVENT rasta.inventory.v1',
        step.payload.returnShipmentId,
        envelope.eventId,
      ),
      occurredAt: at,
    });

    const row = await this.repository.findWithLines(locked.id, tx);
    if (!row) throw new Error(`Return request ${locked.id} vanished inside its own transaction`);
    await this.publish(tx, envelope, step, row);
    returnTransitionsTotal.inc({ service: SERVICE_NAME, to: step.to });
  }

  private publish(
    tx: ExtendedPrismaClient,
    envelope: EventEnvelope,
    step: MirrorStep,
    row: ReturnRequestRow,
  ): Promise<void> {
    const common = {
      aggregateId: row.id,
      organizationId: row.organizationId,
      causationId: envelope.eventId,
    };
    const stated = {
      ...facts(row),
      returnVersion: row.version,
      returnShipmentId: step.payload.returnShipmentId,
    };
    switch (step.eventName) {
      case 'RETURN_SHIPMENT_DISPATCHED':
        return this.events.enqueue(tx, {
          ...common,
          eventName: MARKETPLACE_EVENTS.RETURN_IN_TRANSIT,
          payload: { ...stated, inTransitAt: step.payload.dispatchedAt },
        });
      case 'RETURN_SHIPMENT_RECEIVED':
        return this.events.enqueue(tx, {
          ...common,
          eventName: MARKETPLACE_EVENTS.RETURN_RECEIVED,
          payload: {
            ...stated,
            receivedLines: step.payload.lines.map((line) => ({
              orderLineId: line.orderLineId,
              receivedQuantity: line.receivedQuantity,
            })),
            receivedAt: step.payload.receivedAt,
          },
        });
      case 'RETURN_SHIPMENT_INSPECTED':
        return this.events.enqueue(tx, {
          ...common,
          eventName: MARKETPLACE_EVENTS.RETURN_INSPECTED,
          payload: {
            ...stated,
            reportDocumentId: step.payload.reportDocumentId,
            inspectedAt: step.payload.inspectedAt,
          },
        });
      case 'RETURN_SHIPMENT_RESOLVED':
        return this.events.enqueue(tx, {
          ...common,
          eventName: MARKETPLACE_EVENTS.RETURN_RESOLVED,
          payload: {
            ...stated,
            outcomes: step.payload.dispositions.map((row) => ({
              orderLineId: row.orderLineId,
              disposition: row.disposition,
              quantity: row.quantity,
            })),
            resolvedAt: step.payload.resolvedAt,
          },
        });
    }
  }

  private count(envelope: EventEnvelope, result: string): void {
    returnMirrorEventsTotal.inc({ service: SERVICE_NAME, event: envelope.eventName, result });
  }
}

/** The request columns a step writes: the shipment once, and the step's own instant. */
function stepColumns(step: MirrorStep) {
  switch (step.eventName) {
    case 'RETURN_SHIPMENT_DISPATCHED':
      return {
        returnShipmentId: step.payload.returnShipmentId,
        inTransitAt: new Date(step.payload.dispatchedAt),
      };
    case 'RETURN_SHIPMENT_RECEIVED':
      return { receivedAt: new Date(step.payload.receivedAt) };
    case 'RETURN_SHIPMENT_INSPECTED':
      return {
        inspectedAt: new Date(step.payload.inspectedAt),
        inspectionReportDocumentId: step.payload.reportDocumentId,
      };
    case 'RETURN_SHIPMENT_RESOLVED':
      return { resolvedAt: new Date(step.payload.resolvedAt) };
  }
}

/** Who did the step, as inventory names them by user id. */
function actorOf(step: MirrorStep): string {
  switch (step.eventName) {
    case 'RETURN_SHIPMENT_DISPATCHED':
      return step.payload.dispatchedBy;
    case 'RETURN_SHIPMENT_RECEIVED':
      return step.payload.receivedBy;
    case 'RETURN_SHIPMENT_INSPECTED':
      return step.payload.inspectedBy;
    case 'RETURN_SHIPMENT_RESOLVED':
      return step.payload.resolvedBy;
  }
}

/**
 * A second request for a shipment already on another request of the same buyer is a verdict
 * about the event, not a failure to retry. Anything else — the database, a timeout — is rethrown
 * and retried by `EventConsumer`.
 */
function asVerdict(envelope: EventEnvelope, error: unknown): unknown {
  if (error instanceof UnprocessableEventError) return error;
  const constraint = violatedConstraint(error);
  if (
    isUniqueViolation(error) &&
    constraint !== undefined &&
    (constraint === SHIPMENT_INDEX ||
      constraint.includes('return_shipment_id') ||
      constraint.includes('returnShipmentId'))
  ) {
    return new UnprocessableEventError(
      DLQ_REASONS.BUSINESS_RULE_VIOLATION,
      `${envelope.eventName} ${envelope.eventId}: its return shipment is already on another return request`,
    );
  }
  return error;
}
