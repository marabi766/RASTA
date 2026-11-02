import type { ArgumentMetadata } from '@nestjs/common';
import * as contracts from '@rasta/contracts';
import {
  DLQ_HEADERS,
  ID_PREFIXES,
  currencySchema,
  moneySchema,
  numberInput,
  seedIdSchema,
} from '@rasta/contracts';
import { dlqMessagesTotal } from '@rasta/observability';
import { z } from 'zod';
import { ZodValidationPipe } from '../pipes/zod-validation.pipe';
import { EventConsumer, type ConsumerLogger } from './event-consumer';
import { invalidPayloadError } from './invalid-payload';

/**
 * Differential goldens for nest-common's two adapters of a zod refusal (PR
 * #444 r1 F1): the shared HTTP pipe, on the contracts' own schemas, and the
 * consumer's refusal of a message that is not an event envelope. Each `ZOD3`
 * value was recorded by running this file unchanged on main `745d0434`
 * (zod 3.25.76), where both entry points have the same signatures
 * (`~/worker2/session/t109/scripts/record.sh`).
 */

/** Recorded under zod 3 on main 745d0434; never written by a test run. */
const ZOD3: Record<string, unknown> = {
  'pipe a one-value enum given another value': [
    { path: 'currency', message: "Invalid enum value. Expected 'IRR'", code: 'invalid_enum_value' },
  ],
  'pipe a one-value enum inside money': [
    {
      path: 'price.currency',
      message: "Invalid enum value. Expected 'IRR'",
      code: 'invalid_enum_value',
    },
  ],
  'pipe a one-value enum given a number': [
    { path: 'currency', message: "Expected 'IRR', received number", code: 'invalid_type' },
  ],
  'pipe a missing enum, literal and money': [
    { path: 'currency', message: 'Required', code: 'invalid_type' },
    { path: 'price', message: 'Required', code: 'invalid_type' },
    { path: 'kind', message: 'Required', code: 'invalid_type' },
    { path: 'flag', message: 'Invalid literal value, expected "yes"', code: 'invalid_literal' },
  ],
  'pipe an enum given a number': [
    { path: 'kind', message: "Expected 'A' | 'B', received number", code: 'invalid_type' },
  ],
  'pipe limit 1e999': [
    { path: 'limit', message: 'Expected integer, received float', code: 'invalid_type' },
    { path: 'limit', message: 'Number must be less than or equal to 200', code: 'too_big' },
  ],
  'pipe limit nope': [
    { path: 'limit', message: 'Expected number, received nan', code: 'invalid_type' },
  ],
  'pipe limit 0.5': [
    { path: 'limit', message: 'Expected integer, received float', code: 'invalid_type' },
    { path: 'limit', message: 'Number must be greater than or equal to 1', code: 'too_small' },
  ],
  'pipe an id neither seed nor ULID': [
    { path: 'ownerId', message: 'Expected an identifier of the form ORG_<ULID>', code: 'custom' },
  ],
  'pipe an unknown key': [
    { path: '(root)', message: 'Unrecognized key(s) in object (1)', code: 'unrecognized_keys' },
  ],
  'pipe not an object': [
    { path: '(root)', message: 'Expected object, received string', code: 'invalid_type' },
  ],
  'envelope actor.type 7':
    'Unparseable message (VALIDATION_FAILED): the body is not a valid event envelope (300 bytes): "actor.type" invalid_type',
  'envelope actor.type outside its enum':
    'Unparseable message (VALIDATION_FAILED): the body is not a valid event envelope (306 bytes): "actor.type" invalid_enum_value',
  'envelope an empty object':
    'Unparseable message (VALIDATION_FAILED): the body is not a valid event envelope (2 bytes): "eventId" invalid_type; "eventName" invalid_type; "occurredAt" invalid_type; "producer" invalid_type; "aggregateType" invalid_type; and 2 more',
  'envelope wrong types':
    'Unparseable message (VALIDATION_FAILED): the body is not a valid event envelope (280 bytes): "eventVersion" invalid_type; "occurredAt" invalid_string; "producer" invalid_type',
  'envelope an array':
    'Unparseable message (VALIDATION_FAILED): the body is not a valid event envelope (5 bytes): "(root)" invalid_type',
  'envelope no payload key (an event this consumer does not handle)': 'handled 1',
  'invalidPayloadError an empty payload':
    'ASSET_STATUS_CHANGED 01JB9V5Q6K8M2N4P7R3S5T7V9X payload fails its schema: assetId invalid_type; status invalid_type; kind invalid_literal; currency invalid_type; hours invalid_type',
  'invalidPayloadError enum and literal given numbers':
    'ASSET_STATUS_CHANGED 01JB9V5Q6K8M2N4P7R3S5T7V9X payload fails its schema: status invalid_type; kind invalid_literal; currency invalid_type',
  'invalidPayloadError values outside the enums':
    'ASSET_STATUS_CHANGED 01JB9V5Q6K8M2N4P7R3S5T7V9X payload fails its schema: status invalid_enum_value; kind invalid_literal; currency invalid_enum_value',
  'invalidPayloadError hours 0.5 and -1':
    'ASSET_STATUS_CHANGED 01JB9V5Q6K8M2N4P7R3S5T7V9X payload fails its schema: hours invalid_type; hours too_small',
};

function matchesZod3(name: string, observed: unknown): void {
  expect(observed).toEqual(ZOD3[name]);
}

const META: ArgumentMetadata = { type: 'body' };

function pipeDetails(schema: z.ZodTypeAny, input: unknown): unknown {
  try {
    new ZodValidationPipe(schema).transform(input, META);
  } catch (error) {
    return (error as { details?: unknown }).details;
  }
  throw new Error('the pipe accepted the input');
}

describe('the shared pipe, as zod 3 answered', () => {
  const body = z
    .object({
      currency: currencySchema,
      price: moneySchema,
      limit: numberInput(z.number().int().min(1).max(200)),
      kind: z.enum(['A', 'B']),
      flag: z.literal('yes'),
      ownerId: seedIdSchema(ID_PREFIXES.organization),
    })
    .strict();
  const valid = {
    currency: 'IRR',
    price: { amountMinor: '100', currency: 'IRR' },
    limit: '5',
    kind: 'A',
    flag: 'yes',
    ownerId: 'ORG-ZOD3-GOLDEN',
  };

  it.each([
    ['a one-value enum given another value', { ...valid, currency: 'USD' }],
    ['a one-value enum inside money', { ...valid, price: { amountMinor: '100', currency: 'USD' } }],
    ['a one-value enum given a number', { ...valid, currency: 7 }],
    ['a missing enum, literal and money', { limit: '5', ownerId: valid.ownerId }],
    ['an enum given a number', { ...valid, kind: 7 }],
    ['limit 1e999', { ...valid, limit: '1e999' }],
    ['limit nope', { ...valid, limit: 'nope' }],
    ['limit 0.5', { ...valid, limit: '0.5' }],
    ['an id neither seed nor ULID', { ...valid, ownerId: 'nope' }],
    ['an unknown key', { ...valid, extra: 1 }],
    ['not an object', 'text'],
  ])('%s', (name, input) => {
    matchesZod3(`pipe ${name}`, pipeDetails(body, input));
  });
});

class FakeDlqProducer {
  readonly sent: { messages: { headers: Record<string, unknown> }[] }[] = [];

  async send(record: { messages: { headers: Record<string, unknown> }[] }): Promise<void> {
    this.sent.push(record);
  }
}

/** The `x-dlq-error` an unreadable message is dead-lettered with, or `handled` when it reached the handler. */
async function deadLetterError(body: unknown): Promise<string> {
  const handled = jest.fn(async () => 'SKIPPED' as const);
  const logger: ConsumerLogger = {
    log: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
  const consumer = new EventConsumer(
    {
      brokers: ['localhost:9092'],
      clientId: 'zod3-golden-spec',
      groupId: 'zod3-golden-spec.group',
      topics: ['rasta.asset.v1'],
      deadLetterTopic: 'rasta.asset.v1.dlq',
      retryBackoffMs: 0,
    },
    handled,
    logger,
  );
  const dlq = new FakeDlqProducer();
  const handle = consumer as unknown as {
    dlqProducer?: FakeDlqProducer;
    handleMessage(t: string, p: number, v: Buffer, h: undefined, o?: string): Promise<void>;
  };
  handle.dlqProducer = dlq;
  await handle.handleMessage(
    'rasta.asset.v1',
    0,
    Buffer.from(JSON.stringify(body)),
    undefined,
    '1',
  );
  if (dlq.sent.length === 0) return `handled ${handled.mock.calls.length}`;
  const header = dlq.sent[0]?.messages[0]?.headers[DLQ_HEADERS.error];
  return Buffer.isBuffer(header) ? header.toString('utf8') : String(header);
}

describe('an unreadable envelope is dead-lettered with zod 3’s codes', () => {
  const envelope = {
    eventId: '01JB9V5Q6K8M2N4P7R3S5T7V9X',
    eventName: 'ASSET_REGISTERED',
    eventVersion: 1,
    occurredAt: '2026-10-01T10:00:00.000Z',
    producer: 'asset-service',
    producerVersion: '1.0.0',
    aggregateType: 'Asset',
    aggregateId: 'AST_1',
    correlationId: 'corr-zod3',
    actor: { type: 'USER', id: 'USR_1' },
    payload: {},
  };

  afterAll(() => dlqMessagesTotal.reset());

  it.each([
    ['actor.type 7', { ...envelope, actor: { type: 7, id: 'USR_1' } }],
    ['actor.type outside its enum', { ...envelope, actor: { type: 'ROBOT', id: 'USR_1' } }],
    ['an empty object', {}],
    ['wrong types', { ...envelope, eventVersion: 'one', occurredAt: 'yesterday', producer: 7 }],
    ['an array', [1, 2]],
    [
      'no payload key (an event this consumer does not handle)',
      (({ payload: _p, ...rest }) => rest)(envelope),
    ],
  ])('%s', async (name, body) => {
    matchesZod3(`envelope ${name}`, await deadLetterError(body));
  });
});

/**
 * What a consumer hands `invalidPayloadError`, as each tree's consumers build
 * it: on this branch `legacyParse(schema, payload).refusal`; on main (zod 3)
 * and on the r1 head, `schema.safeParse(payload).error` — the same 13 call
 * sites, so the formatter is compared as it is called. (Read off the module,
 * not imported by name, so the file runs unchanged on all three trees.)
 */
function consumerRefusal(schema: z.ZodTypeAny, payload: unknown): never {
  const parse = (contracts as Record<string, unknown>).legacyParse as
    ((s: z.ZodTypeAny, v: unknown) => { refusal?: unknown }) | undefined;
  return (parse ? parse(schema, payload).refusal : schema.safeParse(payload).error) as never;
}

describe('invalidPayloadError, as the 13 consumers call it', () => {
  const payload = z.object({
    assetId: z.string().min(1),
    status: z.enum(['ACTIVE', 'RETIRED']),
    kind: z.literal('MAINTENANCE'),
    currency: currencySchema,
    hours: z.number().int().min(0),
  });
  const fields = Object.keys(payload.shape);
  const envelope = { eventName: 'ASSET_STATUS_CHANGED', eventId: '01JB9V5Q6K8M2N4P7R3S5T7V9X' };

  it.each([
    ['an empty payload', {}],
    [
      'enum and literal given numbers',
      { assetId: 'AST_1', status: 1, kind: 2, currency: 3, hours: 1 },
    ],
    [
      'values outside the enums',
      { assetId: 'AST_1', status: 'GONE', kind: 'X', currency: 'USD', hours: 1 },
    ],
    [
      'hours 0.5 and -1',
      { assetId: 'AST_1', status: 'ACTIVE', kind: 'MAINTENANCE', currency: 'IRR', hours: -0.5 },
    ],
  ])('%s', (name, input) => {
    matchesZod3(
      `invalidPayloadError ${name}`,
      invalidPayloadError(envelope, consumerRefusal(payload, input), fields).message,
    );
  });
});
