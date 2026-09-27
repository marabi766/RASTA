import { DLQ_HEADERS, DLQ_REASONS, TOPIC_PRODUCERS, producersOf } from '@rasta/contracts';
import { dlqMessagesTotal } from '@rasta/observability';
import {
  EventConsumer,
  logField,
  type ConsumerLogger,
  type EventConsumerOptions,
  type EventHandler,
} from './event-consumer';

/**
 * ADR-061 § 2 — the producer allow-list, enforced once, in the consumer every
 * service uses.
 *
 * Driven through the real `EventConsumer` with a fake dead-letter producer, so
 * the assertions are about the class's own decision: which messages reach a
 * handler, which are dead-lettered, under which reason, after how many
 * attempts. The allow-list itself is `TOPIC_PRODUCERS` in `@rasta/contracts`.
 */

interface SentRecord {
  topic: string;
  messages: { value: Buffer | null; headers: Record<string, unknown> }[];
}

class FakeDlqProducer {
  readonly sent: SentRecord[] = [];

  async send(record: SentRecord): Promise<void> {
    this.sent.push(record);
  }
}

interface PrivateHandle {
  dlqProducer?: FakeDlqProducer;
  handleMessage(
    topic: string,
    partition: number,
    value: Buffer | null,
    headers: undefined,
  ): Promise<void>;
}

const CLIENT_ID = 'nest-common-producer-allowlist-spec';
const silent: ConsumerLogger = {
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const DECLARED_TOPICS = Object.keys(TOPIC_PRODUCERS);
const EVERY_PRODUCER = [...new Set(Object.values(TOPIC_PRODUCERS).flat())].sort();

function envelopeBytes(producer: string, eventId = '01JALLOWLISTSPEC000000001'): Buffer {
  return Buffer.from(
    JSON.stringify({
      eventId,
      eventName: 'SOMETHING_HAPPENED',
      eventVersion: 1,
      occurredAt: '2026-09-26T10:00:00.000Z',
      producer,
      producerVersion: '1.0.0',
      aggregateType: 'Thing',
      aggregateId: 'THG_1',
      correlationId: 'corr-allowlist',
      tenantId: 'ORG_ALLOWLIST',
      payload: {},
    }),
    'utf8',
  );
}

function build(
  topics: string[],
  handler: EventHandler,
  overrides: Partial<EventConsumerOptions> = {},
  logger: ConsumerLogger = silent,
): { handle: PrivateHandle; dlq: FakeDlqProducer } {
  const dlq = new FakeDlqProducer();
  const consumer = new EventConsumer(
    {
      brokers: ['localhost:9092'],
      clientId: CLIENT_ID,
      groupId: `${CLIENT_ID}.group`,
      topics,
      deadLetterTopic: 'rasta.test.v1.dlq',
      maxRetries: 3,
      retryBackoffMs: 0,
      ...overrides,
    },
    handler,
    logger,
  );
  const handle = consumer as unknown as PrivateHandle;
  handle.dlqProducer = dlq;
  return { handle, dlq };
}

beforeEach(() => {
  dlqMessagesTotal.reset();
});

afterAll(() => {
  dlqMessagesTotal.reset();
});

describe('a foreign producer on every declared topic', () => {
  // The whole matrix, not a sample: every topic, every other known producer.
  const cases = DECLARED_TOPICS.flatMap((topic) =>
    EVERY_PRODUCER.filter((producer) => !producersOf(topic).includes(producer)).map(
      (producer) => [topic, producer] as const,
    ),
  );

  it('covers every declared topic with at least one foreign producer', () => {
    expect(new Set(cases.map(([topic]) => topic))).toEqual(new Set(DECLARED_TOPICS));
  });

  it.each(cases)(
    '%s refuses %s: dead-lettered PRODUCER_NOT_ALLOWED, never handled',
    async (topic, producer) => {
      const handled: string[] = [];
      const { handle, dlq } = build([topic], async (envelope) => {
        handled.push(envelope.eventId);
      });

      await handle.handleMessage(topic, 0, envelopeBytes(producer), undefined);

      expect(handled).toEqual([]);
      expect(dlq.sent).toHaveLength(1);
      const headers = dlq.sent[0]?.messages[0]?.headers ?? {};
      expect(headers[DLQ_HEADERS.reason]).toBe(DLQ_REASONS.PRODUCER_NOT_ALLOWED);
      expect(headers[DLQ_HEADERS.originalTopic]).toBe(topic);
      // A verdict, not a failure: zero handler attempts, no retry.
      expect(headers[DLQ_HEADERS.attempts]).toBe('0');
    },
  );
});

describe('an allowed producer', () => {
  const cases = DECLARED_TOPICS.flatMap((topic) =>
    producersOf(topic).map((producer) => [topic, producer] as const),
  );

  it.each(cases)(
    '%s accepts %s and reaches the handler, dead-lettering nothing',
    async (topic, producer) => {
      const handled: string[] = [];
      const { handle, dlq } = build([topic], async (envelope) => {
        handled.push(envelope.producer);
      });

      await handle.handleMessage(topic, 0, envelopeBytes(producer), undefined);

      expect(handled).toEqual([producer]);
      expect(dlq.sent).toEqual([]);
    },
  );

  it('keeps retrying a failing handler as before — the check does not change that path', async () => {
    let attempts = 0;
    const { handle, dlq } = build(['rasta.asset.v1'], async () => {
      attempts += 1;
      throw new Error('database unavailable');
    });

    await handle.handleMessage('rasta.asset.v1', 0, envelopeBytes('asset-service'), undefined);

    expect(attempts).toBe(3);
    expect(dlq.sent[0]?.messages[0]?.headers[DLQ_HEADERS.reason]).toBe(
      DLQ_REASONS.MAX_RETRIES_EXCEEDED,
    );
  });
});

describe('what the check is judged against', () => {
  it('judges a retry delivery by the topic it was retried from', async () => {
    const handled: string[] = [];
    const { handle, dlq } = build(['rasta.asset.v1.retry'], async (envelope) => {
      handled.push(envelope.eventId);
    });

    await handle.handleMessage(
      'rasta.asset.v1.retry',
      0,
      envelopeBytes('asset-service', 'E1'),
      undefined,
    );
    await handle.handleMessage(
      'rasta.asset.v1.retry',
      0,
      envelopeBytes('fleet-service', 'E2'),
      undefined,
    );

    expect(handled).toEqual(['E1']);
    expect(dlq.sent[0]?.messages[0]?.headers[DLQ_HEADERS.reason]).toBe(
      DLQ_REASONS.PRODUCER_NOT_ALLOWED,
    );
  });

  it('uses the delivery topic, never anything the envelope claims', async () => {
    // A trail producer is legitimate on the trail topic and nowhere else.
    const handled: string[] = [];
    const { handle } = build(['rasta.marketplace.v1'], async (envelope) => {
      handled.push(envelope.eventId);
    });

    await handle.handleMessage(
      'rasta.marketplace.v1',
      0,
      envelopeBytes('identity-service'),
      undefined,
    );

    expect(handled).toEqual([]);
  });

  it('counts the refusal under its own reason, labelled only with closed values', async () => {
    const { handle } = build(['rasta.supplier.v1'], async () => undefined);

    await handle.handleMessage(
      'rasta.supplier.v1',
      0,
      envelopeBytes('marketplace-service'),
      undefined,
    );

    const counted = (await dlqMessagesTotal.get()).values.filter((sample) => sample.value > 0);
    expect(counted).toEqual([
      expect.objectContaining({
        value: 1,
        labels: {
          service: CLIENT_ID,
          topic: 'rasta.supplier.v1',
          reason: DLQ_REASONS.PRODUCER_NOT_ALLOWED,
        },
      }),
    ]);
  });

  it('seeds the PRODUCER_NOT_ALLOWED series at zero, so its first dead letter alerts', async () => {
    build(['rasta.fleet.v1'], async () => undefined);

    const series = (await dlqMessagesTotal.get()).values.filter(
      (sample) =>
        sample.labels.service === CLIENT_ID &&
        sample.labels.topic === 'rasta.fleet.v1' &&
        sample.labels.reason === DLQ_REASONS.PRODUCER_NOT_ALLOWED,
    );
    expect(series).toEqual([expect.objectContaining({ value: 0 })]);
  });
});

describe('subscribing to an undeclared topic', () => {
  it('fails at construction, naming the topic', () => {
    expect(() => build(['rasta.procurement.v1'], async () => undefined)).toThrow(
      /rasta\.procurement\.v1.*no producer declared in TOPIC_PRODUCERS/,
    );
  });

  it('fails even when only one of several topics is undeclared', () => {
    expect(() => build(['rasta.asset.v1', 'rasta.inventory.v1'], async () => undefined)).toThrow(
      /rasta\.inventory\.v1/,
    );
  });
});

describe('the producer claim is never repeated as raw text (Codex review of #124, finding 1)', () => {
  function recording(): { logger: ConsumerLogger; lines: string[] } {
    const lines: string[] = [];
    const push = (message: string): void => {
      lines.push(message);
    };
    return { logger: { log: push, warn: push, error: push }, lines };
  }

  function headerText(dlq: FakeDlqProducer): string {
    return JSON.stringify(dlq.sent.map((record) => record.messages.map((m) => m.headers)));
  }

  it('dead-letters a refusal with fixed text, never the claimed producer', async () => {
    const { logger, lines } = recording();
    const { handle, dlq } = build(['rasta.marketplace.v1'], async () => undefined, {}, logger);

    await handle.handleMessage(
      'rasta.marketplace.v1',
      0,
      envelopeBytes('economic-service'),
      undefined,
    );

    const error = String(dlq.sent[0]?.messages[0]?.headers[DLQ_HEADERS.error]);
    expect(error).toBe(
      "UnprocessableEventError: The envelope's producer is not declared for rasta.marketplace.v1 (ADR-061 § 2)",
    );
    expect(error).not.toContain('economic-service');
    // The log keeps the claim for the security review — quoted, as a field.
    expect(lines).toEqual([
      'Refused before any handler (PRODUCER_NOT_ALLOWED) on rasta.marketplace.v1: ' +
        'eventId="01JALLOWLISTSPEC000000001" eventName="SOMETHING_HAPPENED" producer="economic-service"',
    ]);
  });

  it.each([
    ['4 KiB of padding', `marketplace-service${'P'.repeat(4096)}`],
    ['a forged log line', 'marketplace-service\nINFO Refused nothing, all is well'],
    ['an ANSI escape', 'marketplace-service\u001b[2Jcleared'],
    ['a right-to-left override', 'marketplace-service\u202eecivres'],
  ])(
    'refuses a producer with %s as an invalid envelope, repeating none of it',
    async (_label, producer) => {
      const { logger, lines } = recording();
      const handled: string[] = [];
      const { handle, dlq } = build(
        ['rasta.marketplace.v1'],
        async (envelope) => {
          handled.push(envelope.eventId);
        },
        {},
        logger,
      );

      await handle.handleMessage('rasta.marketplace.v1', 0, envelopeBytes(producer), undefined);

      expect(handled).toEqual([]);
      expect(dlq.sent[0]?.messages[0]?.headers[DLQ_HEADERS.reason]).toBe(
        DLQ_REASONS.VALIDATION_FAILED,
      );
      const suffix = producer.slice('marketplace-service'.length);
      for (const text of [...lines, headerText(dlq)]) {
        expect(text).not.toContain(suffix);
        expect(text).not.toContain('marketplace-service');
      }
    },
  );
});

describe('logField', () => {
  it('quotes a plain value unchanged', () => {
    expect(logField('asset-service')).toBe('"asset-service"');
  });

  it('escapes control characters, quotes, backslashes and non-ASCII', () => {
    expect(logField('a\nb\u001b"c\\\u202e')).toBe('"a\\u000ab\\u001b\\u0022c\\u005c\\u202e"');
  });

  it('bounds a long value and says how long it was', () => {
    expect(logField('x'.repeat(5000))).toBe(`"${'x'.repeat(64)}"...(5000 chars)`);
  });
});
