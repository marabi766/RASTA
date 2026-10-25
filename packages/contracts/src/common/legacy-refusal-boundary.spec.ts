import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * PR #444 r1 F1, closed as a class: a zod refusal reaches a person, a log or
 * a dead letter only as the `LegacyRefusal` of `legacyParse(schema, input)`,
 * which always has the schema and every issue's value. The formatters refuse
 * anything else at run time (`requireLegacyRefusal`) and the types refuse it
 * at compile time; this guard keeps the sources from going around both — a
 * parse of their own with the values reported, or a zod error read directly.
 *
 * Production sources of every workspace and the root scripts; tests may build
 * zod errors to prove the formatters refuse them.
 */

const ROOT = join(__dirname, '../../../..');
const BOUNDARY = 'packages/contracts/src/common/zod-issues.ts';

function sourcesUnder(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      return ['node_modules', 'dist', '.next', 'test', '__fixtures__'].includes(entry)
        ? []
        : sourcesUnder(path);
    }
    return /\.(ts|tsx|mjs|cjs|js)$/.test(entry) && !/\.(spec|test|int-spec)\.|fixture/.test(entry)
      ? [path]
      : [];
  });
}

const workspaces = (parent: string): string[] =>
  readdirSync(join(ROOT, parent)).map((name) => join(ROOT, parent, name, 'src'));

const SOURCES = [...workspaces('packages'), ...workspaces('services'), join(ROOT, 'apps/web/src')]
  .flatMap(sourcesUnder)
  .concat(
    readdirSync(join(ROOT, 'scripts'))
      .filter((name) => /\.(mjs|cjs|js)$/.test(name) && !/\.test\./.test(name))
      .map((name) => join(ROOT, 'scripts', name)),
  )
  .map((path) => ({ file: relative(ROOT, path), text: readFileSync(path, 'utf8') }))
  .filter(({ file }) => file !== BOUNDARY);

/** Names bound to a `safeParse` result in `text`. */
function parseResults(text: string): string[] {
  return [...text.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*[^;]*?\.safeParse(?:Async)?\(/g)].map(
    (match) => match[1] as string,
  );
}

describe('the legacy-refusal boundary (PR #444 r1 F1)', () => {
  it('scans the whole repository', () => {
    expect(SOURCES.length).toBeGreaterThan(1_000);
    for (const tree of ['apps/web/src/', 'services/audit-service/src/', 'packages/config/src/']) {
      expect(SOURCES.some(({ file }) => file.startsWith(tree))).toBe(true);
    }
  });

  it('parses with the issue values reported only inside legacyParse', () => {
    const offenders = SOURCES.filter(({ text }) => /\breportInput\b|\bLEGACY_PARSE\b/.test(text));
    expect(offenders.map(({ file }) => file)).toEqual([]);
  });

  it('reads no zod error: a safeParse result is used for success and data only', () => {
    const offenders = SOURCES.flatMap(({ file, text }) => {
      const read = parseResults(text).filter((name) =>
        new RegExp(`\\b${name}\\??\\.error\\b`).test(text),
      );
      const inline = /\.safeParse(?:Async)?\([^;]*?\)\??\.error\b/.test(text) ? ['(inline)'] : [];
      const destructured = /\{[^}]*\berror\b[^}]*\}\s*=\s*[^;]*\.safeParse/.test(text)
        ? ['(destructured)']
        : [];
      const zodError =
        /instanceof\s+(?:z\.)?ZodError\b|name\s*===\s*'ZodError'|\b(?:treeify|prettify|flatten|format)Error\(/.test(
          text,
        )
          ? ['(ZodError)']
          : [];
      return [...read, ...inline, ...destructured, ...zodError].map((what) => `${file} ${what}`);
    });
    expect(offenders).toEqual([]);
  });

  it('every formatter of a refusal checks that it was given one', () => {
    // [file, function]: each takes a LegacyRefusal and calls requireLegacyRefusal
    // first, so a bare zod error fails loudly instead of being guessed at.
    const FORMATTERS: [string, string][] = [
      ['packages/contracts/src/common/zod-issues.ts', 'describeLegacyRefusal'],
      ['packages/nest-common/src/pipes/zod-validation.pipe.ts', 'toErrorDetails'],
      ['packages/nest-common/src/consumer/invalid-payload.ts', 'invalidPayloadError'],
      ['packages/config/src/env-issues.ts', 'envIssues'],
      ['services/audit-service/src/audit/refusal-diagnostics.ts', 'describeIssues'],
      ['services/audit-service/src/audit/payment-reconciliation-projection.ts', 'describeIssues'],
      ['services/audit-service/src/audit/ops-replay.mapper.ts', 'describeIssues'],
      ['services/audit-service/src/audit/commission-rule-change-projection.ts', 'issuesOf'],
      ['services/audit-service/src/audit/settlement-refusal-projection.ts', 'issuesOf'],
      ['services/audit-service/src/audit/contract-refusal-projection.ts', 'unprocessable'],
      ['services/identity-service/src/security-events/audit-trail-envelope.ts', 'describeIssues'],
      ['apps/web/src/lib/form-issues.ts', 'firstIssuePerField'],
    ];
    const missing = FORMATTERS.filter(([file, name]) => {
      const text = readFileSync(join(ROOT, file), 'utf8');
      const start = text.search(new RegExp(`function ${name}\\b`));
      if (start < 0) return true;
      const body = text.slice(start, text.indexOf('\n}\n', start));
      return !/requireLegacyRefusal\(/.test(body);
    });
    expect(missing).toEqual([]);
    // unparseableReason takes anything the envelope read failed with, and
    // names codes only for a refusal (isLegacyRefusal), the class otherwise.
    const consumer = readFileSync(
      join(ROOT, 'packages/nest-common/src/consumer/event-consumer.ts'),
      'utf8',
    );
    expect(consumer).toMatch(/if \(isLegacyRefusal\(failure\)\)/);
  });
});
