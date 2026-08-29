import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { Kafka, type Producer, CompressionTypes } from 'kafkajs';
import type { EventPublisher, OutboxRow } from '@rasta/nest-common';

export interface KafkaPublisherOptions {
  brokers: string[];
  clientId: string;
}

/**
 * Kafka side of the outbox relay.
 *
 * Producer settings are chosen for correctness over throughput:
 *
 *   acks=-1 (all)          a write is acknowledged only once every in-sync
 *                          replica has it, so a leader failure cannot lose it
 *   idempotent=true        the broker deduplicates producer retries, so a
 *                          network hiccup does not duplicate an event
 *   maxInFlightRequests=1  preserves per-partition ordering under retry, which
 *                          is what keeps ORDER_CREATED and ORDER_COMPLETED
 *                          for the same order in the order they happened
 */
@Injectable()
export class KafkaEventPublisher implements EventPublisher, OnModuleDestroy {
  private readonly logger = new Logger(KafkaEventPublisher.name);
  private readonly kafka: Kafka;
  private producer?: Producer;
  private connecting?: Promise<Producer>;

  constructor(private readonly options: KafkaPublisherOptions) {
    this.kafka = new Kafka({
      clientId: options.clientId,
      brokers: options.brokers,
      retry: { initialRetryTime: 300, retries: 8 },
      logLevel: 1, // ERROR — kafkajs is extremely chatty at INFO
    });
  }

  private async getProducer(): Promise<Producer> {
    if (this.producer) return this.producer;
    // Guard against a thundering herd of concurrent first-calls each opening
    // their own producer.
    this.connecting ??= (async () => {
      const producer = this.kafka.producer({
        idempotent: true,
        maxInFlightRequests: 1,
        allowAutoTopicCreation: false,
      });
      await producer.connect();
      this.producer = producer;
      this.logger.log(`Kafka producer connected to ${this.options.brokers.join(', ')}`);
      return producer;
    })();

    try {
      return await this.connecting;
    } catch (error) {
      this.connecting = undefined;
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

  async onModuleDestroy(): Promise<void> {
    if (this.producer) {
      await this.producer.disconnect();
      this.producer = undefined;
    }
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
