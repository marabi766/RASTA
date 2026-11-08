import { publishablePattern } from './pattern-refinement';
import type { z } from 'zod';
import { publishedRefinementPattern } from './pattern-refinement';
import { ID_PREFIXES, type IdPrefix, prefixedIdSchema, seedIdSchema } from './identifiers';

/**
 * FU-073: an identifier schema publishes the same accepted set it enforces.
 *
 * The OpenAPI converter (`@rasta/nest-common` `toJsonSchema`, which this
 * package cannot import) publishes a string's pattern from a `.regex()` check
 * or from a registered pattern refinement, and a union as
 * `anyOf`; `publishedPatterns` reads a schema by that rule. A schema with no
 * pattern on some branch is published as any string, and fails here.
 */

type Def = {
  type: string;
  checks?: { _zod: { def: Record<string, unknown> } }[];
  options?: z.ZodType[];
};
const defOf = (schema: z.ZodType): Def => (schema as unknown as { _zod: { def: Def } })._zod.def;

/** Per published `anyOf` branch, its `pattern` (`undefined`: the branch is any string). */
function publishedPatterns(schema: z.ZodType): (string | undefined)[] {
  const def = defOf(schema);
  if (def.type === 'union') return (def.options ?? []).flatMap(publishedPatterns);
  expect(def.type).toBe('string');
  let pattern: string | undefined;
  for (const check of def.checks ?? []) {
    const marked = publishedRefinementPattern(check);
    if (marked && publishablePattern(marked)) pattern = marked.source;
    const own = check._zod.def;
    if (own.check === 'string_format' && own.format === 'regex') {
      if (publishablePattern(own.pattern as RegExp)) pattern = (own.pattern as RegExp).source;
    }
  }
  return [pattern];
}

/** The predicate `prefixedIdSchema` ran on main before FU-073 (split at the first `_`). */
function legacyPrefixed(prefix: IdPrefix, value: string): boolean {
  const index = value.indexOf('_');
  if (index === -1) return false;
  return (
    value.slice(0, index) === prefix && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(value.slice(index + 1))
  );
}

const ULID = '01JBQ4ZK6M8N9P0R1S2T3V4W5X';
const PREFIXES = Object.values(ID_PREFIXES);

function samples(prefix: IdPrefix): string[] {
  const other = PREFIXES.find((candidate) => candidate !== prefix) ?? 'XXX';
  return [
    `${prefix}_${ULID}`,
    `${prefix}_${'Z'.repeat(26)}`,
    `${other}_${ULID}`,
    `${prefix.toLowerCase()}_${ULID}`,
    `${prefix}_${ULID.toLowerCase()}`,
    ...['I', 'L', 'O', 'U'].map((letter) => `${prefix}_${ULID.slice(0, 25)}${letter}`),
    `${prefix}_${ULID.slice(0, 25)}`,
    `${prefix}_${ULID}0`,
    `${prefix}__${ULID.slice(1)}`,
    `${prefix}_${ULID.slice(0, 12)}_${ULID.slice(13)}`,
    `${prefix}${ULID}`,
    `_${ULID}`,
    ULID,
    '',
    `${prefix}-DEMO-1`,
    `${prefix}-UNION-YAZD`,
    `${prefix}-${ULID}`,
    `${prefix}-`,
    `${prefix}-${'A'.repeat(48)}`,
    `${prefix}-${'A'.repeat(49)}`,
    `${prefix}-demo`,
    `${prefix}-DEMO_1`,
    `${other}-DEMO-1`,
    ` ${prefix}_${ULID}`,
    `${prefix}_${ULID} `,
    `${prefix}_${ULID}\n`,
    `\n${prefix}_${ULID}`,
    `${prefix}-DEMO-1\n`,
    `${prefix}_${ULID.slice(0, 25)}١`,
    `${prefix}_${ULID.slice(0, 25)}۱`,
    `${prefix}_${ULID.slice(0, 25)}１`,
    `${prefix}-DEMO-۱`,
    `${prefix}＿${ULID}`,
    `${prefix}_${ULID.slice(0, 25)}\u{1D7CF}`,
  ];
}

const accepts = (patterns: (string | undefined)[], flags: string, value: string) =>
  patterns.some((pattern) => new RegExp(pattern as string, flags).test(value));

describe.each(PREFIXES)('identifier %s: runtime and published schema agree', (prefix) => {
  const cases: [string, z.ZodType][] = [
    ['prefixedIdSchema', prefixedIdSchema(prefix)],
    ['seedIdSchema', seedIdSchema(prefix)],
  ];

  it.each(cases)('%s publishes a pattern on every branch', (_name, schema) => {
    for (const pattern of publishedPatterns(schema)) {
      expect(pattern).toEqual(expect.stringMatching(/^\^.*\$$/));
    }
  });

  it.each(cases)(
    '%s gives every sample the same verdict at runtime and as published',
    (name, schema) => {
      const patterns = publishedPatterns(schema);
      expect(patterns).not.toContain(undefined);
      const verdicts = samples(prefix).map((value) => {
        const runtime = schema.safeParse(value).success;
        // Identifiers agree in both modes; consumers must use Unicode mode (FU-152).
        return {
          value,
          runtime,
          plain: accepts(patterns, '', value),
          unicode: accepts(patterns, 'u', value),
        };
      });
      expect(verdicts.filter((v) => v.runtime !== v.plain || v.runtime !== v.unicode)).toEqual([]);
      // The accepted set is the one main enforced: the refinement for prefixed
      // ids, plus the readable seed form for `seedIdSchema`.
      const seed = new RegExp(`^${prefix}-[A-Z0-9-]{1,48}$`);
      const legacy = (value: string) =>
        legacyPrefixed(prefix, value) || (name === 'seedIdSchema' && seed.test(value));
      expect(verdicts.filter((v) => v.runtime !== legacy(v.value))).toEqual([]);
      expect(verdicts.some((v) => v.runtime)).toBe(true);
      expect(verdicts.some((v) => !v.runtime)).toBe(true);
    },
  );
});
