import { inspect } from 'node:util';

import { z } from 'zod';
import { describeLegacyRefusal, legacyParse, type LegacyRefusal } from '@rasta/contracts';

import { invalidPayloadError } from './consumer/invalid-payload';
import { unparseableReason } from './consumer/event-consumer';
import { toErrorDetails, validateRequestInput } from './pipes/zod-validation.pipe';

/**
 * PR #444 r4 F5, addendum B: a union refused as a whole now keeps its
 * options' issues beside the refusal (for the form resolver only). This
 * formatter's output for such a refusal is unchanged, byte for byte: the
 * goldens below are what it printed at 670df615, before the branch tree
 * existed, at the root, under a record key and in an array. No option's issue,
 * enum value, literal or input value appears in any of them.
 */

const VALUE = 'SENTINEL-042-value';
const RECORD_NAME = 'SENTINEL-042-record';

function refused(schema: z.ZodType, input: unknown): LegacyRefusal {
  const result = legacyParse(schema, input);
  if (result.success) throw new Error('expected a refusal');
  return result.refusal;
}

/** Every option fails on its type, so zod 3 reported `invalid_union` (with `unionErrors`). */
const option = z.union([
  z.object({ a: z.enum(['OPTION-ALPHA', 'OPTION-BETA']) }),
  z.object({
    b: z.literal('LITERAL-GAMMA'),
    c: z.number({ error: (issue) => `not a number: ${String(issue.input)}` }),
  }),
]);

const unions = (): Record<'record' | 'root' | 'array', LegacyRefusal> => ({
  record: refused(z.object({ tags: z.record(z.string(), option) }), {
    tags: { [RECORD_NAME]: { a: VALUE, b: VALUE, c: VALUE } },
  }),
  root: refused(option, { a: VALUE, b: VALUE, c: VALUE }),
  array: refused(z.object({ items: z.array(option) }), {
    items: [{ a: VALUE, b: VALUE, c: VALUE }],
  }),
});

const OPTION_TEXT = /OPTION-ALPHA|OPTION-BETA|LITERAL-GAMMA|not a number|SENTINEL-042-value/;

const GOLDEN = {
  record: {
    issues:
      '[{"code":"invalid_union","path":["tags","SENTINEL-042-record"],"message":"Invalid input","zodDefault":true}]',
    json: '{"issues":[{"path":["tags","SENTINEL-042-record"],"code":"invalid_union"}]}',
    inspect:
      'LegacyRefusal {"issues":[{"path":["tags","SENTINEL-042-record"],"code":"invalid_union"}]}',
    describe: 'tags.SENTINEL-042-record invalid_union',
    details: '[{"path":"tags.*","message":"Invalid input","code":"invalid_union"}]',
    thrown:
      '{"code":"VALIDATION_FAILED","status":400,"details":[{"path":"tags.*","message":"Invalid input","code":"invalid_union"}],"clientSafe":false,"name":"RastaError"}Request validation failed',
    invalidPayload: 'test.event EVT-042 payload fails its schema: tags.* invalid_union',
    unparseable:
      'the body is not a valid event envelope (2 bytes): "tags.SENTINEL-042-record" invalid_union',
  },
  root: {
    issues: '[{"code":"invalid_union","path":[],"message":"Invalid input","zodDefault":true}]',
    json: '{"issues":[{"path":[],"code":"invalid_union"}]}',
    inspect: 'LegacyRefusal {"issues":[{"path":[],"code":"invalid_union"}]}',
    describe: '(root) invalid_union',
    details: '[{"path":"(root)","message":"Invalid input","code":"invalid_union"}]',
    thrown:
      '{"code":"VALIDATION_FAILED","status":400,"details":[{"path":"(root)","message":"Invalid input","code":"invalid_union"}],"clientSafe":false,"name":"RastaError"}Request validation failed',
    invalidPayload: 'test.event EVT-042 payload fails its schema: (root) invalid_union',
    unparseable: 'the body is not a valid event envelope (2 bytes): "(root)" invalid_union',
  },
  array: {
    issues:
      '[{"code":"invalid_union","path":["items",0],"message":"Invalid input","zodDefault":true}]',
    json: '{"issues":[{"path":["items",0],"code":"invalid_union"}]}',
    inspect: 'LegacyRefusal {"issues":[{"path":["items",0],"code":"invalid_union"}]}',
    describe: 'items.0 invalid_union',
    details: '[{"path":"items[0]","message":"Invalid input","code":"invalid_union"}]',
    thrown:
      '{"code":"VALIDATION_FAILED","status":400,"details":[{"path":"items[0]","message":"Invalid input","code":"invalid_union"}],"clientSafe":false,"name":"RastaError"}Request validation failed',
    invalidPayload: 'test.event EVT-042 payload fails its schema: items.0 invalid_union',
    unparseable: 'the body is not a valid event envelope (2 bytes): "items.0" invalid_union',
  },
} as const;

describe('formatters of a refused union, as at 670df615 (r4 F5, addendum B)', () => {
  it.each(Object.entries(unions()))('%s', (name, refusal) => {
    const golden = GOLDEN[name as keyof typeof GOLDEN];
    let thrown: unknown;
    try {
      validateRequestInput(refusal.schema, refusal.input);
    } catch (error) {
      thrown = error;
    }
    const actual = {
      issues: JSON.stringify(refusal.issues),
      json: JSON.stringify(refusal),
      inspect: inspect(refusal),
      describe: describeLegacyRefusal(refusal),
      details: JSON.stringify(toErrorDetails(refusal)),
      thrown: JSON.stringify(thrown) + String((thrown as Error).message),
      invalidPayload: invalidPayloadError(
        { eventName: 'test.event', eventId: 'EVT-042' },
        refusal,
        ['tags', 'items', 'a', 'b', 'c'],
      ).message,
      unparseable: unparseableReason(refusal, Buffer.from('{}')),
    };
    expect(actual).toEqual(golden);
    expect(Object.values(actual).join('\n')).not.toMatch(OPTION_TEXT);
  });
});
