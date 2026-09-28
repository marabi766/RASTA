import { DLQ_HEADERS, DLQ_REASONS } from '@rasta/contracts';
import { dlqMessagesTotal } from '@rasta/observability';
import { z } from 'zod';
import { EventConsumer, unparseableReason, type ConsumerLogger } from './event-consumer';

/**
 * S-09: a message whose body is not an event envelope used to be logged — and
 * dead-lettered — with the parser's own error text. Node's `JSON.parse`
 * quotes a snippet of the bytes it choked on, so whatever the body held
 * reached the log and the `x-dlq-error` header. Both now carry fixed text and
 * metadata (size, topic, partition, offset); the dead-lettered message keeps
 * the original bytes, which is what it is for.
 *
 * Driven through the real `EventConsumer` with a fake dead-letter producer and
 * a logger that records every line.
 */

const SENTINEL = 'SENTINEL-9c1e-national-id-0012345678';

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
    offset?: string,
  ): Promise<void>;
}

function build(): {
  handle: PrivateHandle;
  dlq: FakeDlqProducer;
  lines: string[];
  handled: jest.Mock;
} {
  const lines: string[] = [];
  const logger: ConsumerLogger = {
    log: (message) => lines.push(`log ${message}`),
    warn: (message) => lines.push(`warn ${message}`),
    error: (message) => lines.push(`error ${message}`),
  };
  const handled = jest.fn();
  const consumer = new EventConsumer(
    {
      brokers: ['localhost:9092'],
      clientId: 'nest-common-unparseable-spec',
      groupId: 'nest-common-unparseable-spec.group',
      topics: ['rasta.asset.v1'],
      deadLetterTopic: 'rasta.asset.v1.dlq',
      retryBackoffMs: 0,
    },
    handled,
    logger,
  );
  const dlq = new FakeDlqProducer();
  const handle = consumer as unknown as PrivateHandle;
  handle.dlqProducer = dlq;
  return { handle, dlq, lines, handled };
}

/** Every header value the dead-letter carries, as text. */
function headerText(dlq: FakeDlqProducer): string {
  return dlq.sent
    .flatMap((record) => record.messages)
    .flatMap((message) => Object.values(message.headers))
    .map((value) => (Buffer.isBuffer(value) ? value.toString('utf8') : String(value)))
    .join('\n');
}

const CASES: [string, Buffer][] = [
  // `JSON.parse` would say: Unexpected token 'S', "SENTINEL-9"... is not valid JSON
  ['not JSON at all', Buffer.from(`${SENTINEL} and more of the same`, 'utf8')],
  // …or: Unexpected token 'S', ..."nationalId":SENTINEL-9"... is not valid JSON
  ['JSON cut short around the value', Buffer.from(`{"nationalId":${SENTINEL}`, 'utf8')],
  [
    'JSON that is not an envelope',
    Buffer.from(JSON.stringify({ eventName: SENTINEL, producer: SENTINEL, payload: SENTINEL })),
  ],
];

beforeEach(() => {
  dlqMessagesTotal.reset();
});

afterAll(() => {
  dlqMessagesTotal.reset();
});

describe('an unparseable message (S-09)', () => {
  it('negative control: Node’s parser does quote the bytes, so the old text leaked them', () => {
    let message = '';
    try {
      JSON.parse(`${SENTINEL} and more`);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('SENTINEL');
  });

  it.each(CASES)('%s: no log line and no DLQ header carries the body', async (_case, body) => {
    const { handle, dlq, lines, handled } = build();

    await handle.handleMessage('rasta.asset.v1', 3, body, undefined, '4711');

    expect(handled).not.toHaveBeenCalled();
    expect(dlq.sent).toHaveLength(1);
    expect(lines.length).toBeGreaterThan(0);
    // Not the whole sentinel, not its distinctive prefix.
    for (const text of [lines.join('\n'), headerText(dlq)]) {
      expect(text).not.toContain(SENTINEL);
      expect(text).not.toContain('SENTINEL');
    }
  });

  it('logs a fixed reason with the size and where the message sat — nothing of its content', async () => {
    const { handle, lines } = build();
    const body = Buffer.from(`${SENTINEL} and more of the same`, 'utf8');

    await handle.handleMessage('rasta.asset.v1', 3, body, undefined, '4711');

    expect(lines).toContain(
      `error Unparseable message on rasta.asset.v1[3]@4711: the body is not valid JSON (${body.length} bytes)`,
    );
  });

  it('dead-letters the original bytes, with the fixed reason in x-dlq-error', async () => {
    const { handle, dlq } = build();
    const body = Buffer.from(`{"nationalId":${SENTINEL}`, 'utf8');

    await handle.handleMessage('rasta.asset.v1', 0, body, undefined, '12');

    const [message] = dlq.sent[0]?.messages ?? [];
    expect(dlq.sent[0]?.topic).toBe('rasta.asset.v1.dlq');
    expect(message?.value).toEqual(body);
    expect(message?.value?.toString('utf8')).toContain(SENTINEL);
    expect(message?.headers[DLQ_HEADERS.reason]).toBe(DLQ_REASONS.VALIDATION_FAILED);
    expect(message?.headers[DLQ_HEADERS.error]).toBe(
      `Unparseable message (VALIDATION_FAILED): the body is not valid JSON (${body.length} bytes)`,
    );
  });

  it('names the schema fields an envelope fails on, never their values', async () => {
    const { handle, lines } = build();
    const body = Buffer.from(JSON.stringify({ eventName: SENTINEL, producer: SENTINEL }), 'utf8');

    await handle.handleMessage('rasta.asset.v1', 0, body, undefined, '5');

    const line = lines.find((text) => text.startsWith('error Unparseable'));
    expect(line).toMatch(/the body is not a valid event envelope \(\d+ bytes\): /);
    expect(line).toContain('"eventName" invalid_string');
    expect(line).toContain('"producer" invalid_string');
  });

  it('says so when a message has no body', async () => {
    const { handle, dlq, lines } = build();

    await handle.handleMessage('rasta.asset.v1', 1, null, undefined, '9');

    expect(lines).toContain(
      'error Unparseable message on rasta.asset.v1[1]@9: the message has no body',
    );
    expect(dlq.sent[0]?.messages[0]?.headers[DLQ_HEADERS.error]).toBe(
      'Unparseable message (VALIDATION_FAILED): the message has no body',
    );
  });
});

describe('unparseableReason', () => {
  it('drops zod messages, which can repeat the value received', () => {
    // The envelope schema has no enum or literal today; a schema that does
    // makes zod quote the received value in the issue message.
    const result = z.object({ kind: z.enum(['A', 'B']) }).safeParse({ kind: SENTINEL });
    expect(result.success).toBe(false);
    const error = (result as { error: Error }).error;
    expect(error.message).toContain(SENTINEL); // the control: zod does echo it

    const reason = unparseableReason(error, Buffer.from('{}'));
    expect(reason).toBe(
      'the body is not a valid event envelope (2 bytes): "kind" invalid_enum_value',
    );
    expect(reason).not.toContain(SENTINEL);
  });

  it('bounds how many issues it lists', () => {
    const schema = z.object(
      Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`f${i}`, z.string()])),
    );
    const result = schema.safeParse({});
    const reason = unparseableReason((result as { error: Error }).error, Buffer.from('{}'));
    expect(reason).toContain('"f4" invalid_type');
    expect(reason).not.toContain('"f5"');
    expect(reason).toMatch(/; and 3 more$/);
  });

  it('names only the error class of anything else', () => {
    expect(unparseableReason(new RangeError(SENTINEL), Buffer.from('x'))).toBe(
      'the body could not be read (1 bytes, RangeError)',
    );
  });
});
