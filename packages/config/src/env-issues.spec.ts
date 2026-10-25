import { z } from 'zod';
import { businessLineSchema, legacyParse, parsableUrl } from '@rasta/contracts';
import {
  CONFIG_ENV_MESSAGES,
  EnvValidationError,
  baseEnvSchema,
  databaseEnvSchema,
  kafkaEnvSchema,
  loadEnv,
  outboxPurgeEnvSchema,
  redisEnvSchema,
  authEnvSchema,
  type LoadEnvOptions,
} from './env';
import { ENV_PATH_PLACEHOLDER, envIssues, fixedEnvMessages } from './env-issues';
import { envEnumFields } from './env-schema';

/**
 * Environment refusals are built from the issue's path, its code and the schema
 * only — never from the value written (S-09, #385 r2 F2).
 *
 * Zod's built-in enum message repeats the input (`received '…'`), and `loadEnv`
 * used to copy every message into `EnvValidationError`, which reaches the boot
 * log. Each case here sets a variable to two different sentinels and requires
 * the same refusal for both — issues, message and stack — with neither
 * sentinel anywhere in it: the output does not depend on the input.
 */
const SENTINELS = ['private-sentinel-79', 'JZ97-another-secret'] as const;

interface Refusal {
  issues: { path: string; message: string }[];
  message: string;
  stack: string | undefined;
}

function refusalOf(load: () => unknown): Refusal {
  try {
    load();
  } catch (error) {
    if (!(error instanceof EnvValidationError)) throw error;
    return { issues: error.issues, message: error.message, stack: error.stack };
  }
  throw new Error('expected a refusal');
}

/**
 * The refusal of `schema` for `source(value)`, the same for two values, which
 * occur nowhere in it; and the codes Zod raised, so a case proves the code it
 * is about.
 */
function refusedAlike<S extends z.ZodTypeAny>(
  schema: S,
  source: (value: string) => NodeJS.ProcessEnv,
  values: readonly [string, string] = SENTINELS,
  options?: LoadEnvOptions<z.infer<S>>,
): Refusal & { codes: string[] } {
  const [a, b] = values.map((value) => refusalOf(() => loadEnv(schema, source(value), options)));
  expect(a).toEqual(b);
  for (const value of values) expect(JSON.stringify(a)).not.toContain(value);
  // Parsed as loadEnv parses, and read in zod 3's vocabulary, which the refusal is written in.
  const parsed = legacyParse(schema, source(values[0]));
  const codes = parsed.success ? [] : parsed.refusal.issues.map((i) => i.code);
  return { ...(a as Refusal), codes };
}

const only = (name: string) => (value: string) => ({ [name]: value }) as NodeJS.ProcessEnv;

describe('the shared schemas', () => {
  const shared = baseEnvSchema
    .merge(databaseEnvSchema)
    .merge(kafkaEnvSchema)
    .merge(outboxPurgeEnvSchema)
    .merge(redisEnvSchema)
    .merge(authEnvSchema);
  const valid = {
    SERVICE_NAME: 'asset-service',
    PORT: '3103',
    DATABASE_URL: 'postgresql://db.internal/rasta',
    KAFKA_BROKERS: 'kafka:9092',
    KAFKA_CLIENT_ID: 'asset-service',
    REDIS_URL: 'redis://cache',
    OIDC_ISSUER_URL: 'https://id.example/realms/rasta',
    OIDC_JWKS_URI: 'https://id.example/realms/rasta/certs',
    OIDC_AUDIENCE: 'rasta',
    INTERNAL_TOKEN_SECRET: 'x'.repeat(32),
  };
  const fields = envEnumFields(shared);

  it('have the three enum settings the r2 review named, found by walking the schema', () => {
    expect(fields.map((field) => field.name).sort()).toEqual([
      'KAFKA_SASL_MECHANISM',
      'LOG_LEVEL',
      'NODE_ENV',
    ]);
  });

  it.each(fields.map((field) => field.name))('%s refuses without the value written', (name) => {
    const refusal = refusedAlike(shared, (value) => ({ ...valid, [name]: value }));
    expect(refusal.codes).toEqual(['invalid_enum_value']);
    expect(refusal.issues).toHaveLength(1);
    expect(refusal.issues[0]?.path).toBe(name);
    expect(refusal.issues[0]?.message).toMatch(/^Invalid enum value\. Expected '/);
  });

  it('name the options the schema declares', () => {
    const refusal = refusedAlike(shared, (value) => ({ ...valid, LOG_LEVEL: value }));
    expect(refusal.issues).toEqual([
      {
        path: 'LOG_LEVEL',
        message:
          "Invalid enum value. Expected 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace'",
      },
    ]);
  });

  it('keep their own fixed messages, the audited list', () => {
    expect(Object.isFrozen(CONFIG_ENV_MESSAGES)).toBe(true);
    const refusal = refusedAlike(shared, (value) => ({
      ...valid,
      OTEL_TRACES_ENABLED: value,
      DATABASE_POOL_SIZE: value,
      REDIS_URL: `${value}://cache`,
    }));
    expect(refusal.issues).toEqual([
      { path: 'OTEL_TRACES_ENABLED', message: 'Expected a boolean such as "true" or "false"' },
      {
        path: 'DATABASE_POOL_SIZE',
        message: 'Expected a whole number written as digits, such as "10"',
      },
      { path: 'REDIS_URL', message: 'Redis URL must start with redis:// or rediss://' },
    ]);
  });

  it('keep the fixed DATABASE_URL refusals, without the count they used to carry', () => {
    const url = (value: string) =>
      `postgresql://db.internal/rasta?options=-c%20${value}&options=-c%20TimeZone%3DUTC`;
    const refusal = refusedAlike(shared, (value) => ({ ...valid, DATABASE_URL: url(value) }));
    expect(refusal.issues).toEqual([
      { path: 'DATABASE_URL', message: expect.stringContaining('more than one options parameter') },
    ]);
  });
});

/**
 * #385 r4, the rule for numbers: a post-parse check may print a setting's value
 * only once the schema has read it as a number — digits cannot carry text. Each
 * such setting, written as text, is refused by the schema with a fixed message
 * before any check that prints it runs; written as a number that fails the
 * cross-check, it is printed.
 */
describe('numeric settings a post-parse check prints', () => {
  const shared = baseEnvSchema
    .merge(databaseEnvSchema)
    .merge(kafkaEnvSchema)
    .merge(outboxPurgeEnvSchema);
  const valid = {
    SERVICE_NAME: 'asset-service',
    PORT: '3103',
    DATABASE_URL: 'postgresql://db.internal/rasta',
    KAFKA_BROKERS: 'kafka:9092',
    KAFKA_CLIENT_ID: 'asset-service',
  };
  const PRINTED = [
    'SHUTDOWN_TIMEOUT_MS',
    'DATABASE_STATEMENT_TIMEOUT_MS',
    'OUTBOX_SHUTDOWN_GRACE_SECONDS',
    'OUTBOX_PURGE_STATEMENT_TIMEOUT_MS',
    'OUTBOX_PURGE_MAX_WAIT_MS',
  ];

  it.each(PRINTED)('%s written as text is refused before it can be printed', (name) => {
    const refusal = refusedAlike(
      shared,
      (value) => ({ ...valid, [name]: value }) as NodeJS.ProcessEnv,
      SENTINELS,
      { operationBudgets: () => [] },
    );
    expect(refusal.issues).toHaveLength(1);
    expect(refusal.issues[0]?.path).toBe(name);
  });

  it('written as a number that fails the cross-check, the number is printed', () => {
    const issues = (timeout: string) =>
      refusalOf(() => loadEnv(shared, { ...valid, SHUTDOWN_TIMEOUT_MS: timeout })).issues;
    expect(issues('1234')[0]?.message).toContain('(1234 ms) leaves no outbox shutdown budget');
    expect(issues('1567')[0]?.message).toContain('(1567 ms) leaves no outbox shutdown budget');
  });
});

describe('every issue code, from the schema and the code alone', () => {
  it('invalid_type: Required, or the expected type without what was received', () => {
    expect(refusedAlike(z.object({ A: z.string(), B: z.number() }), only('B'))).toMatchObject({
      codes: ['invalid_type', 'invalid_type'],
      issues: [
        { path: 'A', message: 'Required' },
        { path: 'B', message: 'Expected number' },
      ],
    });
  });

  describe('invalid_enum_value', () => {
    it('at the top', () => {
      expect(refusedAlike(z.object({ A: z.enum(['on', 'off']) }), only('A'))).toMatchObject({
        codes: ['invalid_enum_value'],
        issues: [{ path: 'A', message: "Invalid enum value. Expected 'on' | 'off'" }],
      });
    });

    it('for a list entry, past a transform and a pipeline output', () => {
      const schema = z.object({
        A: z
          .string()
          .transform((raw) => raw.split(',').map((entry) => entry.trim()))
          .pipe(z.array(z.enum(['ONE', 'TWO']))),
      });
      expect(refusedAlike(schema, (value) => only('A')(`ONE,${value}`))).toMatchObject({
        codes: ['invalid_enum_value'],
        issues: [{ path: 'A.1', message: "Invalid enum value. Expected 'ONE' | 'TWO'" }],
      });
    });

    it('past a preprocess into an optional shared enum (economic business line)', () => {
      const schema = z.object({
        A: z.preprocess(
          (value) => (value === '' ? undefined : value),
          businessLineSchema.optional(),
        ),
      });
      const refusal = refusedAlike(schema, only('A'));
      expect(refusal.codes).toEqual(['invalid_enum_value']);
      expect(refusal.issues).toEqual([
        {
          path: 'A',
          message: expect.stringMatching(
            /^Invalid enum value\. Expected 'PARTS' \| 'INSURANCE' \| /,
          ),
        },
      ]);
    });

    it('options the issue carries but the schema does not declare are not printed', () => {
      // A refinement may raise the code with any options; only an enum's own are schema facts.
      const schema = z.object({
        A: z.string().superRefine((value, ctx) => {
          ctx.addIssue({ code: 'invalid_value', values: [value] });
        }),
      });
      expect(refusedAlike(schema, only('A'))).toMatchObject({
        codes: ['invalid_enum_value'],
        issues: [{ path: 'A', message: 'Invalid enum value' }],
      });
    });

    it('for a native enum', () => {
      enum Mode {
        Fast = 'FAST',
        Slow = 'SLOW',
      }
      expect(refusedAlike(z.object({ A: z.nativeEnum(Mode) }), only('A'))).toMatchObject({
        codes: ['invalid_enum_value'],
        issues: [{ path: 'A', message: "Invalid enum value. Expected 'FAST' | 'SLOW'" }],
      });
    });

    it('under an error map whose text is not in the list: the declared options instead', () => {
      // organization's GOVERNANCE_POLICY_SETTER_ROLES shape: the array's map, a child's issue.
      const schema = z.object({
        A: z
          .string()
          .transform((raw) => raw.split(','))
          .pipe(
            z.array(z.enum(['ADMIN', 'AUDITOR']), {
              error: (issue) => `bad: ${String(issue.input)}`,
            }),
          ),
      });
      expect(refusedAlike(schema, only('A'))).toMatchObject({
        codes: ['invalid_enum_value'],
        issues: [{ path: 'A.0', message: "Invalid enum value. Expected 'ADMIN' | 'AUDITOR'" }],
      });
    });
  });

  it('too_small and too_big: the bound the schema declares', () => {
    const schema = z.object({
      S: z.string().min(40),
      T: z.string().max(4),
      L: z
        .string()
        .transform((raw) => raw.split(','))
        .pipe(z.array(z.string()).min(3)),
    });
    expect(
      refusedAlike(schema, (value) => ({ S: value, T: value, L: value }) as NodeJS.ProcessEnv),
    ).toMatchObject({
      codes: ['too_small', 'too_big', 'too_small'],
      issues: [
        { path: 'S', message: 'String must contain at least 40 character(s)' },
        { path: 'T', message: 'String must contain at most 4 character(s)' },
        { path: 'L', message: 'Array must contain at least 3 element(s)' },
      ],
    });
    const numbers = z.object({ N: z.coerce.number().int().min(10).max(20) });
    expect(refusedAlike(numbers, only('N'), ['7979797', '9797979'])).toMatchObject({
      codes: ['too_big'],
      issues: [{ path: 'N', message: 'Number must be less than or equal to 20' }],
    });
    expect(refusedAlike(numbers, only('N'), ['-7979797', '-9797979'])).toMatchObject({
      codes: ['too_small'],
      issues: [{ path: 'N', message: 'Number must be greater than or equal to 10' }],
    });
  });

  it('invalid_string: the check, never the text', () => {
    const schema = z.object({
      R: z.string().regex(/^[0-9]+$/),
      U: z.string().check(parsableUrl()),
      E: z.string().email(),
      P: z.string().startsWith('rasta-'),
    });
    expect(
      refusedAlike(
        schema,
        (value) => ({ R: value, U: value, E: value, P: value }) as NodeJS.ProcessEnv,
      ),
    ).toMatchObject({
      codes: ['invalid_string', 'invalid_string', 'invalid_string', 'invalid_string'],
      issues: [
        { path: 'R', message: 'Invalid' },
        { path: 'U', message: 'Invalid url' },
        { path: 'E', message: 'Invalid email' },
        { path: 'P', message: 'Invalid input: not in the expected form' },
      ],
    });
  });

  it('not_multiple_of and not_finite', () => {
    const schema = z.object({ M: z.coerce.number().multipleOf(5), F: z.coerce.number().finite() });
    expect(
      refusedAlike(schema, (value) => ({ M: value, F: 'Infinity' }) as NodeJS.ProcessEnv, [
        '7979797',
        '9797979',
      ]),
    ).toMatchObject({
      codes: ['not_multiple_of', 'not_finite'],
      issues: [
        { path: 'M', message: 'Number must be a multiple of 5' },
        { path: 'F', message: 'Number must be finite' },
      ],
    });
  });

  it('invalid_literal, invalid_union, invalid_date', () => {
    const schema = z.object({
      L: z.literal('on'),
      U: z.union([z.literal('a'), z.literal('b')]),
      D: z.coerce.date(),
    });
    expect(
      // Without digits: `new Date('private-sentinel-79')` is a date in 1979.
      refusedAlike(schema, (value) => ({ L: value, U: value, D: value }) as NodeJS.ProcessEnv, [
        'private-sentinel-jz',
        'JZ-another-secret',
      ]),
    ).toMatchObject({
      codes: ['invalid_literal', 'invalid_union', 'invalid_date'],
      issues: [
        { path: 'L', message: 'Invalid literal value' },
        { path: 'U', message: 'Invalid input' },
        { path: 'D', message: 'Invalid date' },
      ],
    });
  });

  // zod 4 throws on an intersection whose sides cannot be merged instead of raising
  // invalid_intersection_types (no schema here uses an intersection), and has no
  // function schemas to raise invalid_arguments / invalid_return_type.
  it('invalid_union_discriminator', () => {
    const schema = z.object({
      K: z.preprocess(
        (raw) => JSON.parse(String(raw)),
        z.discriminatedUnion('kind', [
          z.object({ kind: z.literal('a') }),
          z.object({ kind: z.literal('b') }),
        ]),
      ),
    });
    expect(
      refusedAlike(
        schema,
        (value) => ({ K: JSON.stringify({ kind: value }) }) as NodeJS.ProcessEnv,
      ),
    ).toMatchObject({
      codes: ['invalid_union_discriminator'],
      issues: [{ path: 'K.kind', message: 'Invalid discriminator value' }],
    });
  });

  describe('custom', () => {
    const dynamic = z.object({
      A: z.string().superRefine((value, ctx) => {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Unknown role: ${value}` });
      }),
    });

    it('a dynamic message is replaced by the fixed one for its code', () => {
      expect(refusedAlike(dynamic, only('A'))).toMatchObject({
        codes: ['custom'],
        issues: [{ path: 'A', message: 'Invalid input' }],
      });
    });

    it('a listed text is kept, compared by equality: one that only starts with it is not', () => {
      const KNOWN = 'names a role that does not exist';
      const schema = z.object({
        A: z.string().superRefine((value, ctx) => {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: KNOWN });
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${KNOWN}: ${value}` });
        }),
      });
      expect(refusedAlike(schema, only('A'), SENTINELS, { fixedMessages: [KNOWN] })).toMatchObject({
        issues: [
          { path: 'A', message: KNOWN },
          { path: 'A', message: 'Invalid input' },
        ],
      });
    });
  });
});

describe('paths: only what the schema owns', () => {
  it('a record key, written by the operator, prints as the placeholder', () => {
    const schema = z.object({
      MAP: z.preprocess((raw) => JSON.parse(String(raw)), z.record(z.string(), z.number())),
    });
    expect(
      refusedAlike(
        schema,
        (value) => ({ MAP: JSON.stringify({ [value]: 'x' }) }) as NodeJS.ProcessEnv,
      ),
    ).toMatchObject({
      issues: [{ path: `MAP.${ENV_PATH_PLACEHOLDER}`, message: 'Expected number' }],
    });
  });

  it('an unrecognised key is counted, never named', () => {
    const schema = z.object({ A: z.string() }).strict();
    expect(
      refusedAlike(schema, (value) => ({ A: 'ok', [value]: 'x' }) as NodeJS.ProcessEnv),
    ).toMatchObject({
      codes: ['unrecognized_keys'],
      issues: [{ path: '(root)', message: 'Unrecognized key(s) in object: 1' }],
    });
  });

  it('a path segment the schema does not declare prints as the placeholder', () => {
    // A refinement may name any path; only a declared key is printed.
    const schema = z.object({ A: z.string() }).superRefine((_env, ctx) => {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['A'], message: 'x' });
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['NOT_DECLARED'], message: 'x' });
    });
    const parsed = legacyParse(schema, { A: 'ok' });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(envIssues(parsed.refusal, new Set())).toEqual([
      { path: 'A', message: 'Invalid input' },
      { path: ENV_PATH_PLACEHOLDER, message: 'Invalid input' },
    ]);
  });
});

describe('fixedEnvMessages', () => {
  it('records texts while the schema is built, and nothing once sealed', () => {
    const messages = fixedEnvMessages();
    expect(messages.fixed('one')).toBe('one');
    messages.fixed('two');
    messages.fixed('one');
    const sealed = messages.seal();
    expect(sealed).toEqual(['one', 'two']);
    expect(Object.isFrozen(sealed)).toBe(true);
    expect(messages.seal()).toBe(sealed);
    expect(() => messages.fixed('three')).toThrow(/while the schema is built/);
    expect(sealed).toEqual(['one', 'two']);
  });
});
