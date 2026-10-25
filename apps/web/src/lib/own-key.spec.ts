/**
 * @jest-environment node
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { discoverModules } from '@/test/module-discovery';

import { blockerWording } from './availability-wording';
import { disputeTextLabel } from './labels';
import { ownText, ownValue } from './own-key';
import { GENERIC_REFUSAL_MESSAGE, mapProblemToFields, type FieldMapping } from '../server/write';

/**
 * Names every object inherits. As a key into a plain-object table they answer
 * with `Object.prototype` or a function, and React cannot render either.
 */
const INHERITED = [
  '__proto__',
  'constructor',
  'toString',
  'valueOf',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
  'toLocaleString',
  '__defineGetter__',
  '__lookupGetter__',
] as const;

describe('ownValue / ownText', () => {
  const table = { KNOWN: 'معلوم' };

  it('answers only for a key the table holds itself', () => {
    expect(ownText(table, 'KNOWN')).toBe('معلوم');
    expect(ownText(table, 'OTHER')).toBeUndefined();
    expect(ownText(undefined, 'KNOWN')).toBeUndefined();
    expect(ownText(table, null)).toBeUndefined();
    for (const key of INHERITED) {
      expect(ownValue(table, key)).toBeUndefined();
      expect(ownText(table, key)).toBeUndefined();
    }
  });

  it('answers for a table that really holds such a key', () => {
    const own = JSON.parse('{"__proto__":"x","constructor":"y"}') as Record<string, string>;
    expect(ownText(own, '__proto__')).toBe('x');
    expect(ownText(own, 'constructor')).toBe('y');
  });

  it('never returns a non-string from ownText', () => {
    const odd = { A: 1 } as unknown as Record<string, string>;
    expect(ownText(odd, 'A')).toBeUndefined();
  });
});

describe('every label function of the portal', () => {
  const FUNCTIONS = discoverModules({
    dirs: ['lib'],
    marker: /export (const|function) \w+(Label|Title)\b/,
  }).flatMap(({ name, exports }) =>
    Object.entries(exports)
      .filter(([key, value]) => /(Label|Title)$/.test(key) && typeof value === 'function')
      .map(([key, value]) => [`${name}.${key}`, value as (input: string) => unknown] as const),
  );

  it('is found: the sweep below is not vacuous', () => {
    expect(FUNCTIONS.length).toBeGreaterThanOrEqual(40);
  });

  it.each(FUNCTIONS)('%s answers a string (or null) for an inherited name', (_name, label) => {
    for (const key of INHERITED) {
      const shown = label(key);
      expect(shown === null || typeof shown === 'string').toBe(true);
    }
  });
});

describe('the other presentation tables', () => {
  it('blockerWording names the owner as a string', () => {
    for (const owner of INHERITED) {
      const wording = blockerWording({ code: 'DISPATCH_BLOCKED', owner });
      expect(typeof wording.owner).toBe('string');
      expect(wording.owner).toBe(owner);
    }
  });

  it('disputeTextLabel translates the saga’s two sentences and nothing else', () => {
    expect(disputeTextLabel('Dispute resolved: SETTLE')).toBe(
      'اعتراض با ادامهٔ تسویه به پایان رسید',
    );
    expect(disputeTextLabel('Dispute resolved: REFUND')).toBe('اعتراض با بازگشت وجه به پایان رسید');
    expect(disputeTextLabel('Dispute resolved: SETTLE ')).toBe('Dispute resolved: SETTLE ');
    expect(disputeTextLabel('کالا برگشت')).toBe('کالا برگشت');
    for (const key of INHERITED) expect(disputeTextLabel(key)).toBe(key);
  });
});

describe('every gateway-message mapping dimension', () => {
  const MAPPINGS = discoverModules({
    dirs: ['server'],
    marker: /export const \w+MAPPING\b/,
  }).flatMap(({ name, exports }) =>
    Object.entries(exports)
      .filter(
        ([key, value]) =>
          /MAPPING$/.test(key) && typeof value === 'object' && value !== null && 'paths' in value,
      )
      .map(([key, value]) => [`${name}.${key}`, value as FieldMapping<string>] as const),
  );

  it('is found', () => {
    expect(MAPPINGS.length).toBeGreaterThanOrEqual(20);
  });

  const shownOf = (
    mapping: FieldMapping<string>,
    problem: Parameters<typeof mapProblemToFields>[0],
  ) => {
    const mapped = mapProblemToFields(problem, mapping);
    return [mapped.message, ...Object.values(mapped.fieldErrors)].filter(
      (text) => text !== null && text !== undefined,
    );
  };

  describe.each(MAPPINGS)('%s', (_name, mapping) => {
    it.each(INHERITED)('shows only strings for the inherited name %s', (key) => {
      const problems = [
        { code: 'VALIDATION_FAILED', message: key }, // messages, COMMON_MESSAGES, patterns
        { code: key, message: 'unmapped' }, // byCode
        { code: 'VALIDATION_FAILED', message: 'bad', details: [{ path: key, message: key }] }, // paths
        {
          code: 'VALIDATION_FAILED',
          message: 'bad',
          details: [{ path: Object.keys(mapping.paths)[0] ?? 'x', message: key, code: key }],
        }, // byDetailCode
      ];
      for (const problem of problems) {
        const shown = shownOf(mapping, problem);
        expect(shown.length).toBeGreaterThan(0);
        for (const text of shown) {
          expect(typeof text).toBe('string');
          expect(text).not.toBe(key);
          expect(String(text)).toMatch(/\p{Script=Arabic}/u);
        }
      }
    });
  });

  it('says the generic sentence for the exact case in review (message «__proto__»)', () => {
    const mapped = mapProblemToFields(
      { code: 'VALIDATION_FAILED', message: '__proto__' },
      { paths: {} },
    );
    expect(mapped.message).toBe(GENERIC_REFUSAL_MESSAGE);
  });
});

describe('no bracket lookup that tolerates an unknown key bypasses own-key.ts', () => {
  const SRC = join(__dirname, '..');
  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) return entry === 'test' ? [] : sources(path);
      return /\.(ts|tsx)$/.test(entry) && !/\.(spec|test)\.|fixture|\.d\.ts$/.test(entry)
        ? [path]
        : [];
    });
  }

  // A lookup that SAYS what to do for a missing key (`?? fallback`, `=== undefined`,
  // `!== undefined`) is a lookup by an external key: only an own-key read is safe.
  // `TABLE[key]` with no fallback is a closed, typed key and is not flagged.
  const TABLE_FALLBACK =
    /\b[A-Z][A-Z0-9_]{2,}(?:\)|\?\.)?\[[^\]'"`\d][^\]]*\]\)?\s*(?:\?\?|[!=]==\s*undefined)/;
  // The four dictionaries of a FieldMapping, read by whatever name the code gives them.
  const MAPPING_DICTIONARY = /\.(?:messages|byCode|byDetailCode|paths)\??\.?\[[^\]'"`\d]/;
  // A cast that widens a typed table to look it up by a string.
  const WIDENED = /\bas\s+(?:Readonly<)?Record<string,[^>]*>>?\)\[[^\]'"`\d]/;

  // Lua in the Redis script and its `ARGV[n]` are not presentation tables.
  const SKIPPED = new Set(['server/unresolved-request-store.ts']);

  it('finds no raw lookup into a presentation table with an external key', () => {
    const offenders = sources(SRC).flatMap((file) => {
      const name = relative(SRC, file);
      if (SKIPPED.has(name) || name === 'lib/own-key.ts') return [];
      return readFileSync(file, 'utf8')
        .split('\n')
        .map((line, index) => ({ line, at: `${name}:${index + 1}` }))
        .filter(
          ({ line }) =>
            !/^\s*(?:\/\/|\*|\/\*)/.test(line) &&
            (TABLE_FALLBACK.test(line) || MAPPING_DICTIONARY.test(line) || WIDENED.test(line)),
        )
        .map(({ at }) => at);
    });
    expect(offenders).toEqual([]);
  });

  it('sees the shapes it exists to catch (a mutant that reverts one lookup fails above)', () => {
    for (const line of [
      'return ROLE_LABELS[role] ?? role;',
      'if (OPEN_WORK_NOTES[status] !== undefined)',
      'const known = mapping.messages?.[message] ??',
      'const field = mapping.paths[detail.path];',
      '(BID_STATUS_LABELS as Readonly<Record<string, string>>)[status]',
    ]) {
      expect(TABLE_FALLBACK.test(line) || MAPPING_DICTIONARY.test(line) || WIDENED.test(line)).toBe(
        true,
      );
    }
    for (const line of ['return COLUMNS[columns];', "const a = TABLE['x'] ?? 1;", 'rows[0]']) {
      expect(TABLE_FALLBACK.test(line) || MAPPING_DICTIONARY.test(line) || WIDENED.test(line)).toBe(
        false,
      );
    }
  });
});
