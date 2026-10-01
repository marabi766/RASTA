import { DLQ_REASONS, type EventEnvelope } from '@rasta/contracts';
import {
  EventConsumer,
  UnprocessableEventError,
  kafkaConnection,
  type HandlerOutcome,
} from '@rasta/nest-common';
import type { Logger } from '@rasta/logging';
import { z } from 'zod';
import { ContractorStandingRepository } from '../tender/contractor-standing.repository';
import {
  CONSTRUCTION_DEAD_LETTER_TOPIC,
  type EventConsumerFactory,
} from './organization-moved.consumer';

/** The consumer group: `<service>.<purpose>` (ADR-061 § 3). */
export const SUPPLIER_STANDING_CONSUMER = 'construction-service.supplier-standing';

/** The one topic it reads. `EventConsumer` also reads its `.retry` twin. */
export const SUPPLIER_STANDING_TOPICS = ['rasta.supplier.v1'] as const;

export const SUPPLIER_QUALIFIED = 'SUPPLIER_QUALIFIED';
export const SUPPLIER_SUSPENDED = 'SUPPLIER_SUSPENDED';
export const SUPPLIER_REINSTATED = 'SUPPLIER_REINSTATED';

/** The capability a contractor must be qualified for to bid (ADR-067 § 4). */
export const CONTRACTING = 'CONTRACTING';

/**
 * Only the fields this service uses. supplier-service owns the full schemas and
 * this service does not import them (no cross-service imports); an extra field
 * is not this consumer's business, which is why none of these is `.strict()`.
 */
const identifier = z.string().min(1).max(64);
const instant = z
  .string()
  .min(1)
  .transform((text, ctx) => {
    const at = new Date(text);
    if (Number.isNaN(at.getTime())) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'not a timestamp' });
      return z.NEVER;
    }
    return at;
  });

const qualifiedPayload = z.object({
  organizationId: identifier,
  qualifiedFor: z.array(z.string()).min(1),
  decidedAt: instant,
});
const suspendedPayload = z.object({
  organizationId: identifier,
  suspensionId: identifier,
  suspendedAt: instant,
});
const reinstatedPayload = z.object({
  organizationId: identifier,
  suspensionId: identifier,
  reinstatedAt: instant,
});

export function supplierStandingConsumerFactory(
  connection: ReturnType<typeof kafkaConnection>,
  logger: Pick<Logger, 'info' | 'warn' | 'error'>,
): EventConsumerFactory {
  return (handler) =>
    new EventConsumer(
      {
        ...connection,
        groupId: SUPPLIER_STANDING_CONSUMER,
        topics: [...SUPPLIER_STANDING_TOPICS],
        deadLetterTopic: CONSTRUCTION_DEAD_LETTER_TOPIC,
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
 * Folds supplier-service's qualification and suspension events into the
 * contractor-standing read model a bid is checked against (CON-002 PR 5,
 * ADR-067 § 4).
 *
 * ## Only this read model gets the answer
 *
 * `SUPPLIER_QUALIFIED` counts when its `qualifiedFor` names `CONTRACTING`; the
 * other capabilities are not this service's business. Every write is
 * commutative and idempotent (see `ContractorStandingRepository`), so a
 * redelivery, a `.retry` replay and a reordering all converge on one state.
 * No `processed_event` marker, on purpose: it would make a replay after an
 * outage a no-op, which is the thing a replay is for.
 *
 * ## Provenance
 *
 * `EventConsumer` refuses, before any handler, an event on `rasta.supplier.v1`
 * whose producer is not supplier-service (ADR-061 § 2). Eligibility still fails
 * closed for an organization this service has heard nothing about.
 *
 * A payload that cannot be parsed, or an episode id that belongs to another
 * organization, is a verdict on the event: it goes to the dead-letter topic
 * rather than being retried.
 */
export class SupplierStandingConsumer {
  private consumer?: EventConsumer;

  constructor(
    private readonly consumerFactory: EventConsumerFactory,
    private readonly standing: ContractorStandingRepository,
    private readonly logger: Pick<Logger, 'info' | 'warn' | 'debug'>,
  ) {}

  async start(): Promise<void> {
    this.consumer = this.consumerFactory((envelope) => this.handle(envelope));
    await this.consumer.start();
  }

  async stop(): Promise<void> {
    await this.consumer?.stop();
  }

  /** One event. Public so a test can drive it without a broker. */
  async handle(envelope: EventEnvelope): Promise<HandlerOutcome> {
    switch (envelope.eventName) {
      case SUPPLIER_QUALIFIED: {
        const payload = this.parse(envelope, qualifiedPayload);
        if (!payload.qualifiedFor.includes(CONTRACTING)) return 'SKIPPED';
        await this.standing.recordQualified(payload.organizationId, payload.decidedAt);
        return;
      }
      case SUPPLIER_SUSPENDED: {
        const payload = this.parse(envelope, suspendedPayload);
        this.refuseIf(
          envelope,
          await this.standing.suspend(
            payload.organizationId,
            payload.suspensionId,
            payload.suspendedAt,
          ),
        );
        return;
      }
      case SUPPLIER_REINSTATED: {
        const payload = this.parse(envelope, reinstatedPayload);
        this.refuseIf(
          envelope,
          await this.standing.reinstate(
            payload.organizationId,
            payload.suspensionId,
            payload.reinstatedAt,
          ),
        );
        return;
      }
      default:
        return 'SKIPPED';
    }
  }

  private parse<T>(envelope: EventEnvelope, schema: z.ZodType<T, z.ZodTypeDef, unknown>): T {
    const parsed = schema.safeParse(envelope.payload);
    if (!parsed.success) {
      // A verdict on the event, not a failure to retry: it can never parse.
      throw new UnprocessableEventError(
        DLQ_REASONS.VALIDATION_FAILED,
        `${envelope.eventName} ${envelope.eventId} has an unusable payload`,
      );
    }
    return parsed.data;
  }

  private refuseIf(envelope: EventEnvelope, refusal: string | undefined): void {
    if (refusal === undefined) return;
    this.logger.warn(`${envelope.eventName} ${envelope.eventId} refused: ${refusal}`);
    throw new UnprocessableEventError(
      DLQ_REASONS.VALIDATION_FAILED,
      `${envelope.eventName} ${envelope.eventId} contradicts what is recorded (${refusal})`,
    );
  }
}
