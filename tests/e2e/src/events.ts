import { Kafka, logLevel, type Consumer } from 'kafkajs';
import { randomUUID } from 'node:crypto';
import { EVENT_HEADERS } from '@rasta/contracts';
import { e2eConfig, type E2eConfig } from './env';

/**
 * Reads what economic-service actually published.
 *
 * The HTTP response proves the service answered. It does not prove the write
 * reached the outbox, that the relay picked it up, or that the correlation
 * identifier survived the hop into Kafka — and that hop is where a correlation
 * chain usually breaks, because nothing downstream fails loudly when it does.
 *
 * So the correlation scenario subscribes to the real topic and asserts on the
 * real message headers. No stub broker: a `KafkaJS` consumer against the same
 * cluster the service produces to.
 */

/**
 * One message off the topic, split the way the platform structures it.
 *
 * The message value is the **envelope** (`eventId`, `eventName`,
 * `correlationId`, `tenantId`, …) with the domain payload nested inside it.
 * Both levels are kept: the header and the envelope carry the correlation id
 * independently, and a test that checked only one would miss the case where
 * they disagree.
 */
export interface ObservedEvent {
  eventName: string;
  /** From the Kafka header — what a consumer filters on without deserialising. */
  correlationId: string | undefined;
  /** From the envelope body — what a consumer records once it has. */
  envelopeCorrelationId: string | undefined;
  tenantId: string | undefined;
  /** The partition key. */
  key: string | undefined;
  /** The domain payload, unwrapped from the envelope. */
  payload: Record<string, unknown>;
}

export class EconomicEventTap {
  private readonly consumer: Consumer;
  private readonly received: ObservedEvent[] = [];
  private joined = false;

  private constructor(consumer: Consumer) {
    this.consumer = consumer;
  }

  /**
   * Starts listening at the **end** of the topic and returns once the consumer
   * group has actually joined.
   *
   * Both halves matter. Reading from the end keeps a developer's local topic
   * backlog out of the assertions. Waiting for `GROUP_JOIN` removes the race
   * that otherwise makes this flaky: a consumer that has subscribed but not
   * yet joined is not receiving anything, so an action performed in that
   * window produces an event nobody sees and a timeout that blames the wrong
   * component.
   */
  /**
   * @param topic which domain stream to observe. Defaults to the economic one,
   *   because that is what most scenarios watch; the marketplace scenarios pass
   *   their own rather than having a second near-identical tap.
   */
  static async start(
    config: E2eConfig = e2eConfig(),
    topic: string = config.economicTopic,
  ): Promise<EconomicEventTap> {
    const kafka = new Kafka({
      clientId: `e2e-tap-${randomUUID()}`,
      brokers: config.kafkaBrokers,
      logLevel: logLevel.ERROR,
      retry: { initialRetryTime: 200, retries: 8 },
    });

    // A fresh group per run, so one run never consumes another's offsets and a
    // re-run is not affected by where the previous one stopped.
    const consumer = kafka.consumer({ groupId: `e2e-tap-${randomUUID()}` });
    const tap = new EconomicEventTap(consumer);

    consumer.on(consumer.events.GROUP_JOIN, () => {
      tap.joined = true;
    });

    await consumer.connect();
    await consumer.subscribe({ topic, fromBeginning: false });
    await consumer.run({
      eachMessage: async ({ message }) => {
        const headers = message.headers ?? {};
        // A Kafka header value is `Buffer | string | (Buffer | string)[]`. The
        // array form only appears when a producer sets the same header twice,
        // which none of ours does — but narrowing it explicitly is cheaper than
        // a cast that would quietly stringify `[object Object]` if one ever did.
        const read = (name: string): string | undefined => {
          const raw = headers[name];
          if (raw === undefined || raw === null) return undefined;
          const single = Array.isArray(raw) ? raw[0] : raw;
          if (single === undefined) return undefined;
          return typeof single === 'string' ? single : Buffer.from(single).toString('utf8');
        };

        const envelope = message.value
          ? (JSON.parse(message.value.toString('utf8')) as {
              correlationId?: string;
              payload?: Record<string, unknown>;
            })
          : {};

        tap.received.push({
          eventName: read(EVENT_HEADERS.eventName) ?? '(unnamed)',
          correlationId: read(EVENT_HEADERS.correlationId),
          envelopeCorrelationId: envelope.correlationId,
          tenantId: read(EVENT_HEADERS.tenantId),
          key: message.key ? message.key.toString('utf8') : undefined,
          payload: envelope.payload ?? {},
        });
      },
    });

    await waitFor('the event tap to join its consumer group', () => tap.joined, 60_000);
    return tap;
  }

  /** Every event seen so far that carries this correlation id. */
  correlated(correlationId: string): ObservedEvent[] {
    return this.received.filter((event) => event.correlationId === correlationId);
  }

  /**
   * Waits until at least `expected` events carrying `correlationId` have
   * arrived, then returns them.
   */
  async awaitCorrelated(
    correlationId: string,
    expected: readonly string[],
    timeoutMs = 60_000,
  ): Promise<ObservedEvent[]> {
    await waitFor(
      `events ${expected.join(', ')} with correlation ${correlationId}`,
      () => {
        const seen = new Set(this.correlated(correlationId).map((event) => event.eventName));
        return expected.every((name) => seen.has(name));
      },
      timeoutMs,
      () =>
        `saw: ${
          this.correlated(correlationId)
            .map((event) => event.eventName)
            .join(', ') || '(nothing)'
        }`,
    );
    return this.correlated(correlationId);
  }

  async stop(): Promise<void> {
    await this.consumer.disconnect();
  }
}

/**
 * Polls `check` until it is true. No fixed sleeps anywhere in this suite —
 * docs/14 § 14.7 forbids them, and a sleep long enough to be reliable is
 * always long enough to be slow.
 */
export async function waitFor(
  description: string,
  check: () => boolean | Promise<boolean>,
  timeoutMs = 30_000,
  detail?: () => string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for ${description}` +
      (detail ? `; ${detail()}` : '') +
      (lastError ? `; last error: ${String(lastError)}` : ''),
  );
}
