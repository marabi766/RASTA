import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { Kafka, type Producer, CompressionTypes } from 'kafkajs';
import {
  boundedDisconnect,
  kafkaClientConfig,
  kafkaShutdownDeadline,
  type KafkaConnectionOptions,
} from '@rasta/nest-common';
import type { EventPublisher, OutboxRow } from '@rasta/nest-common';

/** The service's connection to the broker, SASL and TLS included (RUN-006). */
export type KafkaPublisherOptions = KafkaConnectionOptions;

/**
 * Kafka side of the outbox relay.
 *
 * Producer settings are chosen for correctness over throughput:
 *
 *   acks=-1 (all)          a write is acknowledged only once every in-sync
 *                          replica has it, so a leader failure cannot lose it
 *   idempotent=true        the broker deduplicates producer retries, so a
 *                          network hiccup does not duplicate an event
 *   maxInFlightRequests=1  preserves per-partition ordering under retry — for
 *                          the retries of *one* producer request. It does not
 *                          make this service's events semantically ordered:
 *                          several relay replicas may publish separate rows of
 *                          one key concurrently, which is D-027 and open
 */
@Injectable()
export class KafkaEventPublisher implements EventPublisher, OnModuleDestroy {
  private readonly logger = new Logger(KafkaEventPublisher.name);
  private readonly kafka: Kafka;
  private producer?: Producer;
  private connecting?: Promise<Producer>;
  /**
   * The producer object of a connect that has not resolved yet.
   *
   * `producer` is set only once `connect()` succeeds, and `connect()` retries
   * on timers of its own. Without a handle on the object *before* that, a
   * shutdown that lands during a connect has nothing to close, and those
   * timers hold the process open until the retry budget runs out.
   */
  private pendingProducer?: Producer;
  /**
   * Set by `onModuleDestroy`. After it, this publisher opens nothing.
   *
   * The relay stops on shutdown, but a tick already in flight can still reach
   * `publish()` afterwards — `OutboxRelay.stop()` waits only for a bounded
   * grace. Without this flag that tick opens a *new* connection to a broker
   * the application has just finished leaving.
   */
  private destroyed = false;
  /** The bounded close, once begun (`onModuleDestroy`). */
  private closing?: Promise<void>;

  constructor(private readonly options: KafkaPublisherOptions) {
    this.kafka = new Kafka({
      ...kafkaClientConfig(options),
      retry: { initialRetryTime: 300, retries: 8 },
      logLevel: 1, // ERROR — kafkajs is extremely chatty at INFO
    });
  }

  private async getProducer(): Promise<Producer> {
    if (this.destroyed) {
      // A refusal rather than a connection. The caller is the relay, which
      // treats a publish failure as "retry this row later" — and later, for a
      // publisher that has been destroyed, means a different process.
      throw new Error('Kafka publisher has been shut down and will not open a new producer');
    }
    if (this.producer) return this.producer;
    // Guard against a thundering herd of concurrent first-calls each opening
    // their own producer.
    this.connecting ??= (async () => {
      const producer = this.kafka.producer({
        idempotent: true,
        maxInFlightRequests: 1,
        allowAutoTopicCreation: false,
      });
      // Recorded before the await, so a shutdown during the connect has
      // something to disconnect. `connect()` retries on its own timers and
      // nothing else can cancel them.
      this.pendingProducer = producer;
      await producer.connect();
      this.producer = producer;
      this.pendingProducer = undefined;
      this.logger.log(`Kafka producer connected to ${this.options.brokers.join(', ')}`);
      return producer;
    })();

    try {
      return await this.connecting;
    } catch (error) {
      this.connecting = undefined;
      this.pendingProducer = undefined;
      throw error;
    }
  }

  async publish(rows: readonly OutboxRow[]): Promise<void> {
    if (rows.length === 0) return;

    const producer = await this.getProducer();

    // One batch per topic, with the partition key preserved so ordering per
    // aggregate survives (ADR-006).
    const byTopic = new Map<string, OutboxRow[]>();
    for (const row of rows) {
      const bucket = byTopic.get(row.topic);
      if (bucket) bucket.push(row);
      else byTopic.set(row.topic, [row]);
    }

    await producer.sendBatch({
      acks: -1,
      compression: CompressionTypes.GZIP,
      topicMessages: [...byTopic.entries()].map(([topic, topicRows]) => ({
        topic,
        messages: topicRows.map((row) => ({
          key: row.partitionKey,
          value: JSON.stringify(row.payload),
          headers: row.headers,
        })),
      })),
    });
  }

  async isHealthy(): Promise<boolean> {
    try {
      const admin = this.kafka.admin();
      await admin.connect();
      await admin.listTopics();
      await admin.disconnect();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Closes whatever is open, including a connect that has not landed.
   *
   * Both halves matter and they fail differently. Leaving a *connected*
   * producer open leaks a socket. Leaving a *connecting* one open leaks the
   * retry timers behind `connect()`, which keep the event loop alive with no
   * socket to show for it — a process that will not exit and gives no reason
   * why.
   *
   * Both by the shutdown deadline, the one `OutboxShutdown` drains the relay by
   * (D-052 phase 4b). kafkajs's `disconnect()` waits for every request in
   * flight — a connect's included — and Nest waits for this hook: a broker that
   * stopped answering held `app.close()` past SHUTDOWN_TIMEOUT_MS. A close the
   * broker does not let finish is abandoned with a warning instead. One close:
   * a second call joins it.
   */
  onModuleDestroy(): Promise<void> {
    this.closing ??= this.close(kafkaShutdownDeadline(this.options));
    return this.closing;
  }

  private async close(deadlineAt: number): Promise<void> {
    this.destroyed = true;
    this.connecting = undefined;

    // `disconnect()` on a producer that is still connecting cancels the retry
    // rather than waiting it out — once its request in flight has returned.
    const clients = [this.pendingProducer, this.producer].filter(
      (client): client is Producer => client !== undefined,
    );
    this.pendingProducer = undefined;
    this.producer = undefined;
    await Promise.all(
      clients.map((client) =>
        boundedDisconnect(client, { deadlineAt, label: 'Kafka producer', logger: this.logger }),
      ),
    );
  }
}

/**
 * Publisher for environments without a broker — unit tests, and any local run
 * where Kafka is not up. Records what it was asked to publish so a test can
 * assert on it, and never silently pretends success it did not have.
 */
export class InMemoryEventPublisher implements EventPublisher {
  readonly published: OutboxRow[] = [];

  async publish(rows: readonly OutboxRow[]): Promise<void> {
    this.published.push(...rows);
  }

  async isHealthy(): Promise<boolean> {
    return true;
  }

  clear(): void {
    this.published.length = 0;
  }
}
