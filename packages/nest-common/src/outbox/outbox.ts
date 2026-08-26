import { ulid } from 'ulid';
import { EVENT_HEADERS, type EventEnvelope } from '@rasta/contracts';
import { tryGetContext } from '../context/request-context';

/**
 * Transactional Outbox (ADR-021).
 *
 * Domain code never publishes to Kafka directly. It writes an outbox row in
 * the *same database transaction* as the state change, and a relay publishes
 * it afterwards. Without this, "save the order" and "publish ORDER_CREATED"
 * are two non-atomic operations, and a crash between them produces either a
 * lost event (commission never charged) or a phantom event (commission charged
 * for an order that rolled back).
 *
 * The delivery guarantee is at-least-once. Exactly-once across a broker
 * boundary is expensive and brittle; at-least-once plus idempotent consumers
 * reaches the same end state for far less machinery.
 */

export interface OutboxMessageInput<TPayload = unknown> {
  aggregateType: string;
  aggregateId: string;
  eventName: string;
  eventVersion?: number;
  topic: string;
  payload: TPayload;
  /**
   * Kafka partition key. Defaults to `aggregateId`, which is what gives
   * ordering per aggregate — the property the wallet and tender flows depend on.
   */
  partitionKey?: string;
  aggregateVersion?: number;
  organizationId?: string;
  /** The event that caused this one, for causal tracing. */
  causationId?: string;
  occurredAt?: Date;
}

export interface OutboxRow {
  id: string;
  aggregateType: string;
  aggregateId: string;
  eventName: string;
  eventVersion: number;
  topic: string;
  partitionKey: string;
  payload: unknown;
  headers: Record<string, string>;
  organizationId: string | null;
  correlationId: string;
  createdAt: Date;
  publishedAt: Date | null;
  attempts: number;
  lastError: string | null;
}

export interface BuildOutboxOptions {
  producer: string;
  producerVersion?: string;
}

/**
 * Builds the row to insert. Pure — takes no I/O — so it can be called inside a
 * transaction callback and unit-tested without a database.
 */
export function buildOutboxRow<TPayload>(
  input: OutboxMessageInput<TPayload>,
  options: BuildOutboxOptions,
): Omit<OutboxRow, 'publishedAt' | 'attempts' | 'lastError'> {
  const context = tryGetContext();
  const eventId = ulid();
  const occurredAt = input.occurredAt ?? new Date();
  const correlationId = context?.correlationId ?? eventId;
  const organizationId = input.organizationId ?? context?.organizationId ?? null;

  const envelope: EventEnvelope<TPayload> = {
    eventId,
    eventName: input.eventName,
    eventVersion: input.eventVersion ?? 1,
    occurredAt: occurredAt.toISOString(),
    producer: options.producer,
    producerVersion: options.producerVersion ?? '0.0.0',
    aggregateType: input.aggregateType,
    aggregateId: input.aggregateId,
    ...(input.aggregateVersion !== undefined ? { aggregateVersion: input.aggregateVersion } : {}),
    ...(organizationId ? { tenantId: organizationId } : {}),
    correlationId,
    ...(input.causationId ? { causationId: input.causationId } : {}),
    ...(context?.traceId && context.spanId
      ? { traceparent: `00-${context.traceId}-${context.spanId}-01` }
      : {}),
    ...(context?.userId
      ? { actor: { type: 'USER' as const, id: context.userId } }
      : context?.callerService
        ? { actor: { type: 'SERVICE' as const, id: context.callerService } }
        : {}),
    payload: input.payload,
  };

  return {
    id: eventId,
    aggregateType: input.aggregateType,
    aggregateId: input.aggregateId,
    eventName: input.eventName,
    eventVersion: envelope.eventVersion,
    topic: input.topic,
    partitionKey: input.partitionKey ?? input.aggregateId,
    payload: envelope,
    headers: buildHeaders(envelope),
    organizationId,
    correlationId,
    createdAt: occurredAt,
  };
}

function buildHeaders(envelope: EventEnvelope): Record<string, string> {
  const headers: Record<string, string> = {
    [EVENT_HEADERS.eventId]: envelope.eventId,
    [EVENT_HEADERS.eventName]: envelope.eventName,
    [EVENT_HEADERS.eventVersion]: String(envelope.eventVersion),
    [EVENT_HEADERS.correlationId]: envelope.correlationId,
    [EVENT_HEADERS.producer]: envelope.producer,
  };
  if (envelope.tenantId) headers[EVENT_HEADERS.tenantId] = envelope.tenantId;
  if (envelope.causationId) headers[EVENT_HEADERS.causationId] = envelope.causationId;
  if (envelope.traceparent) headers[EVENT_HEADERS.traceparent] = envelope.traceparent;
  return headers;
}

// ---------------------------------------------------------------------------
// Relay
// ---------------------------------------------------------------------------

/** Persistence port. Implemented per service against its own Prisma client. */
export interface OutboxStore {
  /**
   * Claims up to `limit` unpublished rows.
   *
   * Implementations must use `FOR UPDATE SKIP LOCKED` so several service
   * replicas can relay concurrently without publishing the same row twice.
   */
  claimPending(limit: number): Promise<OutboxRow[]>;
  markPublished(ids: readonly string[]): Promise<void>;
  markFailed(id: string, error: string): Promise<void>;
  /** Age of the oldest unpublished row, in seconds. Feeds the stuck-relay alert. */
  oldestPendingAgeSeconds(): Promise<number>;
}

/** Broker port. */
export interface EventPublisher {
  publish(rows: readonly OutboxRow[]): Promise<void>;
}

export interface OutboxRelayOptions {
  store: OutboxStore;
  publisher: EventPublisher;
  pollIntervalMs?: number;
  batchSize?: number;
  logger?: {
    debug(obj: object, msg?: string): void;
    warn(obj: object, msg?: string): void;
    error(obj: object, msg?: string): void;
  };
  onBatchPublished?: (count: number) => void;
  onPublishFailed?: (row: OutboxRow, error: unknown) => void;
}

export class OutboxRelay {
  private timer?: NodeJS.Timeout;
  private running = false;
  private stopped = true;

  constructor(private readonly options: OutboxRelayOptions) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    const interval = this.options.pollIntervalMs ?? 500;
    this.timer = setInterval(() => {
      if (this.stopped) return;
      void this.tick();
    }, interval);
    // Do not hold the event loop open on shutdown.
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    // Let an in-flight batch finish so it is not published twice on restart.
    while (this.running) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  /**
   * Publishes one batch.
   *
   * Guards only against *concurrent* ticks — overlapping runs would claim and
   * publish the same rows twice. It deliberately does not require the relay to
   * be started, so an operator can force a drain during incident response and
   * a test can drive it deterministically.
   */
  async tick(): Promise<number> {
    if (this.running) return 0;
    this.running = true;

    try {
      const batch = await this.options.store.claimPending(this.options.batchSize ?? 100);
      if (batch.length === 0) return 0;

      try {
        await this.options.publisher.publish(batch);
        await this.options.store.markPublished(batch.map((row) => row.id));
        this.options.onBatchPublished?.(batch.length);
        this.options.logger?.debug({ count: batch.length }, 'Outbox batch published');
        return batch.length;
      } catch (error) {
        // Fall back to per-row publishing so one poisoned message cannot block
        // the queue behind it. A row that keeps failing surfaces via its
        // attempt count and the stuck-relay alert.
        return await this.publishIndividually(batch, error);
      }
    } catch (error) {
      this.options.logger?.error({ err: error }, 'Outbox relay tick failed');
      return 0;
    } finally {
      this.running = false;
    }
  }

  private async publishIndividually(
    batch: readonly OutboxRow[],
    batchError: unknown,
  ): Promise<number> {
    this.options.logger?.warn(
      { err: batchError, count: batch.length },
      'Batch publish failed; retrying rows individually',
    );

    const published: string[] = [];

    for (const row of batch) {
      try {
        await this.options.publisher.publish([row]);
        published.push(row.id);
      } catch (error) {
        await this.options.store.markFailed(row.id, describeError(error));
        this.options.onPublishFailed?.(row, error);
        this.options.logger?.error(
          { err: error, outboxId: row.id, eventName: row.eventName, topic: row.topic },
          'Outbox row failed to publish',
        );
      }
    }

    if (published.length > 0) {
      await this.options.store.markPublished(published);
      this.options.onBatchPublished?.(published.length);
    }

    return published.length;
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`.slice(0, 1000);
  return String(error).slice(0, 1000);
}
