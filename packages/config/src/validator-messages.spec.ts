import { z } from 'zod';
import {
  booleanEnv,
  httpUrlSchema,
  postgresUrlSchema,
  queryBoolean,
  redisUrlSchema,
  urlWithProtocol,
} from './env';

/**
 * What the custom validators of this package say when they refuse (S-09,
 * #385 r1 F2).
 *
 * `queryBoolean` refuses a client's query text, and the pipe's echo backstop in
 * `@rasta/nest-common` does not look for values under three characters — so a
 * message here that repeated the input would reach the client for `?flag=42`.
 * The environment validators feed the boot error and its log. Either way the
 * message is fixed per schema and never carries the value received, or any
 * part of it, whatever its length.
 *
 * "The input does not occur in the message" cannot be asserted on its own: a
 * one-letter input such as `x` occurs inside `Expected`. So each length from
 * 1 to 4 is tried with two different sentinels, built only from characters
 * that appear in none of the fixed messages (checked below, not assumed), and
 * the refusal must be the fixed message for both — the same output whatever
 * the input was.
 */

/** Characters in none of the fixed messages, paths or codes below. */
const SENTINEL_CHARACTERS = 'jzJZ79';

/** Two different sentinels for every length from 1 to 4. */
const SENTINELS: readonly (readonly [string, string])[] = [
  ['j', 'Z'],
  ['jz', 'Z7'],
  ['jzj', 'Z79'],
  ['jzjz', 'ZJ97'],
];

const BOOLEAN_EXPECTED = 'Expected a boolean such as "true" or "false"';

/** What a refusal shows: `{ path, code, message }` per issue. */
function refusal(schema: z.ZodTypeAny, input: unknown) {
  const result = schema.safeParse(input);
  if (result.success) throw new Error(`expected a refusal, parsed ${String(result.data)}`);
  return result.error.issues.map(({ path, code, message }) => ({ path, code, message }));
}

describe('the sentinels', () => {
  it.each([
    BOOLEAN_EXPECTED,
    'URL must start with http:// or https://',
    'Database connection string must start with postgresql:// or postgres://',
    'Redis URL must start with redis:// or rediss://',
    'Broker URL must start with amqp://',
    'URL must be a valid URL',
    'custom',
    'FLAG',
  ])('appear nowhere in %p', (text) => {
    for (const character of SENTINEL_CHARACTERS) expect(text).not.toContain(character);
  });
});

describe.each([
  ['booleanEnv', (fallback: boolean) => booleanEnv(fallback)],
  ['queryBoolean', (fallback: boolean) => queryBoolean(fallback)],
])('%s refuses with the fixed message', (_name, make) => {
  const schema = z.object({ FLAG: make(true) });

  it.each(SENTINELS)('the same for %p and %p', (a, b) => {
    const expected = [{ path: ['FLAG'], code: 'custom', message: BOOLEAN_EXPECTED }];
    expect(refusal(schema, { FLAG: a })).toEqual(expected);
    expect(refusal(schema, { FLAG: b })).toEqual(expected);
  });

  it('whatever surrounds the value', () => {
    for (const value of ['  j  ', 'ZJ97ZJ97ZJ97', 'yes please', 'truee']) {
      expect(refusal(schema, { FLAG: value })[0]?.message).toBe(BOOLEAN_EXPECTED);
    }
  });
});

describe('queryBoolean reads exactly what booleanEnv reads', () => {
  // One parser, two labels (env.ts `booleanish`): the defaults, blank-as-false,
  // trimming, case and the refusal are the environment parser's, unchanged.
  const spellings = [
    'true',
    'false',
    '1',
    '0',
    'yes',
    'no',
    'on',
    'off',
    '',
    '   ',
    ' YES ',
    'Off',
    'TRUE',
    true,
    false,
    'maybe',
    'y',
    '2',
  ];

  it.each([true, false])('default %p', (fallback) => {
    for (const value of [...spellings, undefined]) {
      const env = booleanEnv(fallback).safeParse(value);
      const query = queryBoolean(fallback).safeParse(value);
      expect(query).toEqual(env);
    }
    expect(queryBoolean(fallback).parse(undefined)).toBe(fallback);
  });

  it('the eight spellings, blank and case', () => {
    const read = (value: unknown) => queryBoolean(true).parse(value);
    expect(['true', '1', 'yes', 'on'].map(read)).toEqual([true, true, true, true]);
    expect(['false', '0', 'no', 'off'].map(read)).toEqual([false, false, false, false]);
    expect(['', '   ', ' YES ', 'Off'].map(read)).toEqual([false, false, true, false]);
  });
});

describe.each([
  ['httpUrlSchema', httpUrlSchema, 'URL must start with http:// or https://'],
  [
    'postgresUrlSchema',
    postgresUrlSchema,
    'Database connection string must start with postgresql:// or postgres://',
  ],
  ['redisUrlSchema', redisUrlSchema, 'Redis URL must start with redis:// or rediss://'],
])('%s refuses another protocol with the fixed message', (_name, schema, expected) => {
  it.each(SENTINELS)('the same for %p:// and %p://', (a, b) => {
    const issues = [{ path: [], code: 'custom', message: expected }];
    expect(refusal(schema, `${a}://host.internal/path`)).toEqual(issues);
    expect(refusal(schema, `${b}://host.internal/path`)).toEqual(issues);
  });
});

describe('urlWithProtocol', () => {
  it('names the label and the protocols it accepts, never the one written', () => {
    const schema = urlWithProtocol(['amqp:'], 'Broker URL');
    expect(refusal(schema, 'jzjz://user:secret@host')).toEqual([
      { path: [], code: 'custom', message: 'Broker URL must start with amqp://' },
    ]);
  });

  it('keeps the other refusals, which were already fixed', () => {
    expect(refusal(httpUrlSchema, 'jzjz')).toEqual([
      { path: [], code: 'custom', message: 'URL must be a valid URL' },
    ]);
    expect(refusal(postgresUrlSchema, 'postgresql://')).toEqual([
      { path: [], code: 'custom', message: 'Database connection string must include a host' },
    ]);
  });
});
