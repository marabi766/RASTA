import { legacyParse } from '@rasta/contracts';
import { Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { z } from 'zod';
import type { EventEnvelope } from '@rasta/contracts';
import {
  invalidPayloadError,
  type EventConsumer,
  type EventHandler,
  type HandlerOutcome,
  type OutboxStopOptions,
} from '@rasta/nest-common';
import { IDENTITY_EVENTS } from '../identity/events';
import { settleWithin, untilDeadline, withCancellation } from '../prisma/cancellation';
import { KeycloakProjector } from './keycloak.projector';

/**
 * The durable half of the Keycloak projection (ADR-060 § 5).
 *
 * Every membership change projects the user straight after it commits, but
 * that write can fail after the change is already durable. The change also
 * enqueued one of these events in the same transaction, so consuming them and
 * projecting the named user again closes the gap: the projection lands once
 * Keycloak is reachable, however long the outage was.
 *
 * **Idempotent by construction.** The projector rebuilds all four attributes
 * from the database every time, so a redelivery, a replay, or an event
 * arriving after a later change all write the current truth — never the state
 * the event describes. That is also why there is no `processed_event` ledger
 * here: there is nothing to deduplicate.
 */
export const REPROJECTED_EVENTS = [
  IDENTITY_EVENTS.USER_ACTIVATED,
  IDENTITY_EVENTS.MEMBERSHIP_CREATED,
  IDENTITY_EVENTS.ROLE_ASSIGNED,
  IDENTITY_EVENTS.ROLE_REVOKED,
  IDENTITY_EVENTS.MEMBERSHIP_REVOKED,
  IDENTITY_EVENTS.MEMBERSHIP_EXPIRED,
] as readonly string[];

/** Every one of the events above names the user it changed. */
const namesUser = z.object({ userId: z.string().min(1) });

export type EventConsumerFactory = (handler: EventHandler) => EventConsumer;

@Injectable()
export class KeycloakProjectionConsumer implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(KeycloakProjectionConsumer.name);
  private consumer?: EventConsumer;
  /**
   * Aborted when the bounded stop returns — the handler in flight drained, or
   * abandoned at the deadline (#402 r2 F2): the projection it runs cancels its
   * Keycloak call, and every database operation it would start next is
   * refused (`prisma/cancellation.ts`).
   */
  private cancel = new AbortController();
  /** The handlers' transactions not settled yet: a stop waits for them (#458 r2 F2). */
  private readonly transactions = new Set<Promise<unknown>>();
  /** The one stop of this run; later calls join it (#458 r1 F2). */
  private stopping?: Promise<void>;

  constructor(
    /** Null when Keycloak sync is off: there is nothing to project into. */
    private readonly consumerFactory: EventConsumerFactory | null,
    private readonly projector: KeycloakProjector,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.consumerFactory) {
      this.logger.warn('Keycloak re-projection consumer disabled — Keycloak sync is off');
      return;
    }
    this.cancel = new AbortController();
    this.stopping = undefined;
    this.consumer = this.consumerFactory((envelope) => this.handle(envelope));
    await this.consumer.start();
  }

  /**
   * An `OutboxShutdown` worker: stopped in Nest's destroy phase, beside both
   * relays, the purge and the expiry scanner, by the shutdown's one deadline
   * (D-052); an event still in flight is abandoned uncommitted and delivered
   * again, which the projection absorbs by construction (above). Before, its
   * own `onModuleDestroy` stopped the consumer with no bound, so a Keycloak
   * write or a dead letter that hung held the close into the forced exit.
   * Keycloak sync off, there is nothing to stop. When it returns, the
   * projection of a handler it abandoned is cancelled (`cancel`). One stop:
   * a later call — `onApplicationShutdown` after `OutboxShutdown`'s — joins
   * it, and never starts a second flush.
   */
  stop(options?: OutboxStopOptions): Promise<void> {
    this.stopping ??= this.halt(options?.deadlineAt);
    return this.stopping;
  }

  private async halt(deadlineAt: number | undefined): Promise<void> {
    try {
      await (this.consumer?.stop({ deadlineAt }) ?? Promise.resolve());
    } finally {
      // Once the stop returns — or fails: a Kafka disconnect that rejects
      // (#458 r3 F7) — the handler it may have abandoned starts nothing more,
      // before the caller resumes; and the owed fences and the handlers'
      // pending transactions are still flushed and waited for, by the
      // deadline. The failure is rethrown after that, never instead of it.
      this.cancel.abort();
      await this.recoverOwed(deadlineAt);
    }
  }

  /**
   * Before the stop returns, outside the scope it cancelled: the fresh fences
   * of late writes still owed — one the cancelled handler heard back for
   * after its deadline, or one still unanswered past it (D-070 D). In a scope
   * that carries the deadline (#458 r1 F2): bounded by what is left of it,
   * refused past it, and cancelled before this returns. Never throws: in the
   * stop's `finally`, it must not replace the stop's own failure.
   */
  private async recoverOwed(deadlineAt: number | undefined): Promise<void> {
    if (!this.consumerFactory) return;
    const flushed = await untilDeadline(() => this.projector.recoverOwed(), deadlineAt).catch(
      (error: unknown) => {
        this.logger.error(`Flushing owed Keycloak write fences failed: ${String(error)}`);
        return { outcome: 'abandoned' as const, unsettled: 0 };
      },
    );
    const owed = flushed.outcome === 'finished' ? flushed.value : -1;
    if (owed !== 0) {
      this.logger.error(
        `Stopping with ${owed < 0 ? 'unknown' : owed} late Keycloak write fences unwritten ` +
          '(D-070 D); the old fences, if not yet taken over, still stand',
      );
    }
    // Never "stopped" with a COMMIT still pending (#458 r2 F2): an abandoned
    // handler's transaction already handed to the engine is waited for, by
    // the deadline, and one that has not settled by then is reported.
    const unsettled = flushed.unsettled + (await settleWithin(this.transactions, deadlineAt));
    if (unsettled > 0) {
      this.logger.error(
        `Keycloak projection consumer stopped at the shutdown deadline with ${unsettled} ` +
          'transactions unsettled: they may still commit',
      );
    }
  }

  /** Joins the stop `OutboxShutdown` began; returns at once. */
  onApplicationShutdown(): Promise<void> {
    return this.stop();
  }

  /**
   * Projects the user an event names.
   *
   * A projection that fails throws, so the consumer retries it and, past its
   * limit, dead-letters it where an operator sees it — the reconcile command is
   * the sweep for anything that ends up there.
   */
  async handle(envelope: EventEnvelope): Promise<HandlerOutcome> {
    if (!REPROJECTED_EVENTS.includes(envelope.eventName)) return 'SKIPPED';

    const parsed = legacyParse(namesUser, envelope.payload);
    if (!parsed.success) {
      // The producer is this service, and publish-time validation requires the
      // field; a payload without it is a defect a retry cannot fix. Dead-lettered
      // at once rather than acknowledged, so the missed projection has a record
      // an operator sees (audit L7-26, docs/07 § 7.6).
      throw invalidPayloadError(envelope, parsed.refusal, Object.keys(namesUser.shape));
    }

    const { signal } = this.cancel;
    await withCancellation(
      signal,
      () => this.projector.project(parsed.data.userId, 'event', { signal }),
      { transactions: this.transactions },
    );
  }
}
