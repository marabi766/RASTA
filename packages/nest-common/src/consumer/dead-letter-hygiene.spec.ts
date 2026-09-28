import type { IHeaders } from 'kafkajs';
import { DLQ_HEADERS, DLQ_REASONS, EVENT_HEADERS } from '@rasta/contracts';
import { dlqMessagesTotal } from '@rasta/observability';
import {
  EventConsumer,
  HANDLER_MESSAGE_MAX,
  UnprocessableEventError,
  forwardedHeaders,
  handlerMessage,
  type ConsumerLogger,
  type EventHandler,
} from './event-consumer';

/**
 * S-09 on the dead-letter path (review of #135):
 *
 *  - F3: only the platform's own headers (`EVENT_HEADERS`) are copied from the
 *    original message; an `authorization` or custom header is not.
 *  - F2: a handler's message reaches the log and `x-dlq-error` as a fixed
 *    classification, the reason code, and the message with control characters
 *    stripped and cut to `HANDLER_MESSAGE_MAX`.
 *  - F5: the original partition and offset ride along as headers.
 *
 * Driven through the real `EventConsumer` with a fake dead-letter producer and
 * a logger that records every line.
 */

const SENTINEL = 'SENTINEL-3b7d-bearer-token';

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
    headers: IHeaders | undefined,
    offset?: string,
  ): Promise<void>;
}

function build(handler: EventHandler): {
  handle: PrivateHandle;
  dlq: FakeDlqProducer;
  lines: string[];
} {
  const lines: string[] = [];
  const logger: ConsumerLogger = {
    log: (message) => lines.push(`log ${message}`),
    warn: (message) => lines.push(`warn ${message}`),
    error: (message) => lines.push(`error ${message}`),
  };
  const consumer = new EventConsumer(
    {
      brokers: ['localhost:9092'],
      clientId: 'nest-common-dlq-hygiene-spec',
      groupId: 'nest-common-dlq-hygiene-spec.group',
      topics: ['rasta.asset.v1'],
      deadLetterTopic: 'rasta.asset.v1.dlq',
      maxRetries: 2,
      retryBackoffMs: 0,
    },
    handler,
    logger,
  );
  const dlq = new FakeDlqProducer();
  const handle = consumer as unknown as PrivateHandle;
  handle.dlqProducer = dlq;
  return { handle, dlq, lines };
}

const ENVELOPE = {
  eventId: '01JDLQHYGIENESPEC00000001',
  eventName: 'ASSET_DECOMMISSIONED',
  eventVersion: 1,
  occurredAt: '2026-09-28T10:00:00.000Z',
  producer: 'asset-service',
  producerVersion: '1.0.0',
  aggregateType: 'Asset',
  aggregateId: 'AST_HYGIENE_1',
  correlationId: 'corr-hygiene-1',
  causationId: 'cause-hygiene-1',
  tenantId: 'ORG_HYGIENE',
  traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
  payload: { reason: 'sold' },
};
const BODY = Buffer.from(JSON.stringify(ENVELOPE), 'utf8');

/** What the outbox relay sets (`buildHeaders`), as kafkajs delivers them: Buffers. */
const PLATFORM_HEADERS: IHeaders = {
  [EVENT_HEADERS.eventId]: Buffer.from(ENVELOPE.eventId),
  [EVENT_HEADERS.eventName]: Buffer.from(ENVELOPE.eventName),
  [EVENT_HEADERS.eventVersion]: Buffer.from('1'),
  [EVENT_HEADERS.correlationId]: Buffer.from(ENVELOPE.correlationId),
  [EVENT_HEADERS.causationId]: Buffer.from(ENVELOPE.causationId),
  [EVENT_HEADERS.tenantId]: Buffer.from(ENVELOPE.tenantId),
  [EVENT_HEADERS.producer]: Buffer.from(ENVELOPE.producer),
  [EVENT_HEADERS.traceparent]: Buffer.from(ENVELOPE.traceparent),
  [EVENT_HEADERS.streamSeq]: Buffer.from('00000000000000000042'),
};
const FOREIGN_HEADERS: IHeaders = {
  authorization: Buffer.from(`Bearer ${SENTINEL}`),
  Authorization: `Bearer ${SENTINEL}`,
  cookie: Buffer.from(`session=${SENTINEL}`),
  'x-customer-note': Buffer.from(SENTINEL),
  'X-Event-Id': Buffer.from(SENTINEL), // not the relay's spelling
};

/** A control character (C0, DEL) or the right-to-left override, anywhere in `value`. */
const hasControl = (value: string): boolean =>
  Array.from(value).some((char) => {
    const code = char.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f || code === 0x202e;
  });

const text = (value: unknown): string =>
  Buffer.isBuffer(value) ? value.toString('utf8') : String(value);

function onlyMessage(dlq: FakeDlqProducer): {
  value: Buffer | null;
  headers: Record<string, unknown>;
} {
  expect(dlq.sent).toHaveLength(1);
  const message = dlq.sent[0]?.messages[0];
  if (!message) throw new Error('no dead letter was sent');
  return message;
}

beforeEach(() => {
  dlqMessagesTotal.reset();
});

afterAll(() => {
  dlqMessagesTotal.reset();
});

describe('dead-letter headers: the platform’s own only (F3)', () => {
  const refuse: EventHandler = async () => {
    throw new UnprocessableEventError(DLQ_REASONS.BUSINESS_RULE_VIOLATION, 'asset is retired');
  };

  it('drops authorization, cookies and custom headers — the sentinel reaches no header', async () => {
    const { handle, dlq } = build(refuse);

    await handle.handleMessage(
      'rasta.asset.v1',
      1,
      BODY,
      { ...PLATFORM_HEADERS, ...FOREIGN_HEADERS },
      '77',
    );

    const { headers } = onlyMessage(dlq);
    for (const name of Object.keys(FOREIGN_HEADERS)) expect(headers).not.toHaveProperty(name);
    expect(Object.values(headers).map(text).join('\n')).not.toContain('SENTINEL');
  });

  it('keeps everything a replay to the original topic needs', async () => {
    const { handle, dlq } = build(refuse);

    await handle.handleMessage(
      'rasta.asset.v1',
      1,
      BODY,
      { ...PLATFORM_HEADERS, ...FOREIGN_HEADERS },
      '77',
    );

    const { value, headers } = onlyMessage(dlq);
    // The body, byte for byte, and where it came from.
    expect(value).toEqual(BODY);
    expect(headers[DLQ_HEADERS.originalTopic]).toBe('rasta.asset.v1');
    // Every relay header but `x-producer`, which a dead letter has always
    // re-stamped with the consumer that wrote it.
    for (const [name, original] of Object.entries(PLATFORM_HEADERS)) {
      if (name === EVENT_HEADERS.producer) continue;
      expect(text(headers[name])).toBe(text(original));
    }
    expect(headers[EVENT_HEADERS.producer]).toBe('nest-common-dlq-hygiene-spec');
  });

  it('forwardedHeaders is exactly EVENT_HEADERS, matched by exact name', () => {
    const kept = forwardedHeaders({ ...PLATFORM_HEADERS, ...FOREIGN_HEADERS });
    expect(Object.keys(kept).sort()).toEqual(Object.values(EVENT_HEADERS).sort());
    expect(forwardedHeaders(undefined)).toEqual({});
  });
});

describe('dead-letter headers: where the original sat (F5)', () => {
  it('carries the original partition and offset', async () => {
    const { handle, dlq } = build(async () => {
      throw new UnprocessableEventError(DLQ_REASONS.VALIDATION_FAILED, 'bad payload');
    });

    await handle.handleMessage('rasta.asset.v1', 4, BODY, PLATFORM_HEADERS, '123456');

    const { headers } = onlyMessage(dlq);
    expect(headers[DLQ_HEADERS.originalPartition]).toBe('4');
    expect(headers[DLQ_HEADERS.originalOffset]).toBe('123456');
  });

  it('on the unparseable path too', async () => {
    const { handle, dlq } = build(async () => undefined);

    await handle.handleMessage('rasta.asset.v1', 2, Buffer.from('not json'), undefined, '9');

    const { headers } = onlyMessage(dlq);
    expect(headers[DLQ_HEADERS.originalPartition]).toBe('2');
    expect(headers[DLQ_HEADERS.originalOffset]).toBe('9');
  });
});

describe('handler messages: classified, sanitised, bounded (F2)', () => {
  // A message that tries to forge a second log line, hide behind a
  // right-to-left override, and run long — with the sentinel past the bound.
  const HOSTILE =
    'amount_mismatch for AST_HYGIENE_1\nerror FAKE: all good\r\u001b[2K\u202e' +
    'x'.repeat(HANDLER_MESSAGE_MAX) +
    SENTINEL;

  it('a refusal: fixed classification, reason, sanitised message — in the log and x-dlq-error', async () => {
    const { handle, dlq, lines } = build(async () => {
      throw new UnprocessableEventError(DLQ_REASONS.SOURCE_UNCONFIRMED, HOSTILE);
    });

    await handle.handleMessage('rasta.asset.v1', 0, BODY, PLATFORM_HEADERS, '1');

    const error = text(onlyMessage(dlq).headers[DLQ_HEADERS.error]);
    expect(error).toMatch(
      /^Handler refused \(SOURCE_UNCONFIRMED\): amount_mismatch for AST_HYGIENE_1 error FAKE: all good \[2K x+…$/,
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(
      /^error Handler refused ASSET_DECOMMISSIONED "01JDLQHYGIENESPEC00000001" \(SOURCE_UNCONFIRMED\): amount_mismatch/,
    );
    for (const written of [error, ...lines]) {
      expect(written).not.toContain('SENTINEL');
      expect(hasControl(written)).toBe(false);
    }
  });

  it('an exhausted handler: every attempt line and the dead letter are sanitised too', async () => {
    const { handle, dlq, lines } = build(async () => {
      throw new Error(HOSTILE);
    });

    await handle.handleMessage('rasta.asset.v1', 0, BODY, PLATFORM_HEADERS, '1');

    const error = text(onlyMessage(dlq).headers[DLQ_HEADERS.error]);
    expect(error).toMatch(/^Handler failed 2x \(MAX_RETRIES_EXCEEDED\): Error: amount_mismatch/);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(
      /^warn Attempt 1\/2 failed for ASSET_DECOMMISSIONED "01J\w+": Error: /,
    );
    expect(lines[1]).toMatch(
      /^error Handler failed 2x for ASSET_DECOMMISSIONED "01J\w+" \(MAX_RETRIES_EXCEEDED\): Error: /,
    );
    for (const written of [error, ...lines]) {
      expect(written).not.toContain('SENTINEL');
      expect(hasControl(written)).toBe(false);
    }
  });

  it('negative control: the unsanitised message would have carried the sentinel and a newline', () => {
    expect(`Error: ${HOSTILE}`).toContain(SENTINEL);
    expect(`Error: ${HOSTILE}`).toContain('\n');
  });

  it('bounds by characters, not bytes, and keeps Persian text', () => {
    const persian = 'مبلغ با سند مالک نمی‌خواند';
    expect(
      handlerMessage(new UnprocessableEventError(DLQ_REASONS.SOURCE_UNCONFIRMED, persian)),
    ).toBe(persian);
    const long = handlerMessage(new Error('ب'.repeat(500)));
    expect(Array.from(long)).toHaveLength(HANDLER_MESSAGE_MAX);
    expect(long.endsWith('…')).toBe(true);
  });

  it('names the error class of anything thrown', () => {
    expect(handlerMessage(new RangeError('out of range'))).toBe('RangeError: out of range');
    expect(handlerMessage('a bare string\nwith a newline')).toBe('a bare string with a newline');
  });
});
