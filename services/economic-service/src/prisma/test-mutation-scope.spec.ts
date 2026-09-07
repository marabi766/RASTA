import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Proves no integration test in **this service** mutates rows it cannot name.
 *
 * The three defects this exists to stop had already happened, and each was
 * one missing predicate:
 *
 *   - `outboxMessage.updateMany({ where: { publishedAt: null } })` stamped
 *     every unpublished row in the database as published without sending it,
 *     so a concurrent suite's events could never be claimed and its wait for
 *     them timed out naming Kafka;
 *   - two `DELETE FROM journal` statements with no `WHERE` at all removed
 *     every entry-less journal, including a concurrent run's ledger history;
 *   - `ALTER TABLE ... DISABLE TRIGGER` outside a transaction left the
 *     platform's immutability controls off for every session, and leaked them
 *     permanently if the process was killed.
 *
 * None of the three is visible in a review of the line that fails. They are
 * visible here, at unit-test speed, with no database — which is also why this
 * lives in the unit project: it runs in `pnpm verify` on a machine with no
 * Docker, and a new unbounded statement is refused before it can ever be run
 * against shared infrastructure.
 *
 * Scope is deliberately this service's `test/` directory and nothing else. The
 * same rule belongs in every service, but as a repository-wide lint rule it
 * would land on seven suites this change has not read.
 *
 * ## The escape hatch
 *
 * Some statements are unbounded on purpose: DDL cannot carry a `WHERE`, and
 * `ledger-immutability.int-spec.ts` asserts that an unbounded `UPDATE` is
 * *refused*, which is a property that only an unbounded `UPDATE` can test.
 * Those carry `ISOLATION-ALLOW-UNBOUNDED:` and a reason on a line above them.
 * The marker is not a way to silence this test; it is a requirement to say why
 * the statement is safe, next to the statement, where the next reader is.
 */

const TEST_DIR = join(__dirname, '..', '..', 'test');
const ALLOW_MARKER = 'ISOLATION-ALLOW-UNBOUNDED';

/** How far above a statement the marker may sit. */
const MARKER_LOOKBACK_LINES = 6;

interface Finding {
  file: string;
  line: number;
  kind: string;
  statement: string;
}

/**
 * The source with comment lines blanked, and line numbers preserved.
 *
 * Blanked rather than removed so a finding's line number still points at the
 * real line, and so the marker — which lives in a comment — can still be found
 * in the original text. Prose in this repository quotes SQL inside backticks
 * constantly; without this every one of those quotations would be reported.
 */
function codeLines(source: string): string[] {
  return source.split('\n').map((line) => (/^\s*(\/\/|\*\/?|\/\*)/.test(line) ? '' : line));
}

/**
 * Every string and template literal in the code.
 *
 * Good enough for SQL, which is what this looks at: the statements in these
 * suites are template literals with no nested backticks, and a literal that
 * this misses is a statement this test does not police rather than one it
 * reports wrongly.
 */
function literals(code: string): { text: string; index: number }[] {
  const found: { text: string; index: number }[] = [];
  const pattern = /`(?:[^`\\]|\\.)*`|'(?:[^'\\\n]|\\.)*'/g;

  for (const match of code.matchAll(pattern)) {
    found.push({ text: match[0], index: match.index });
  }
  return found;
}

/**
 * Statement shapes that are unbounded unless they say otherwise.
 *
 * `ENABLE TRIGGER` and `ADD CONSTRAINT` are absent on purpose: restoring a
 * control is never the destructive direction, and requiring a justification
 * for putting an invariant back would push authors towards not putting it
 * back.
 */
const SHAPES: { kind: string; matches: RegExp; boundedByWhere: boolean }[] = [
  { kind: 'DELETE', matches: /\bDELETE\s+FROM\b/i, boundedByWhere: true },
  { kind: 'UPDATE', matches: /\bUPDATE\s+[\w"$.{}]+\s+SET\b/i, boundedByWhere: true },
  { kind: 'TRUNCATE', matches: /\bTRUNCATE\b/i, boundedByWhere: false },
  {
    kind: 'DISABLE TRIGGER',
    matches: /\bALTER\s+TABLE\b[\s\S]*?\bDISABLE\b/i,
    boundedByWhere: false,
  },
  {
    kind: 'DROP',
    matches: /\bDROP\s+(TABLE|CONSTRAINT|TRIGGER|SCHEMA|INDEX)\b/i,
    boundedByWhere: false,
  },
];

function lineOf(code: string, index: number): number {
  return code.slice(0, index).split('\n').length;
}

function allowed(sourceLines: string[], line: number): boolean {
  const from = Math.max(0, line - 1 - MARKER_LOOKBACK_LINES);
  return sourceLines.slice(from, line).some((text) => text.includes(ALLOW_MARKER));
}

function scan(file: string, source: string): Finding[] {
  const sourceLines = source.split('\n');
  const code = codeLines(source).join('\n');
  const findings: Finding[] = [];

  for (const literal of literals(code)) {
    for (const shape of SHAPES) {
      if (!shape.matches.test(literal.text)) continue;
      if (shape.boundedByWhere && /\bWHERE\b/i.test(literal.text)) continue;

      const line = lineOf(code, literal.index);
      if (allowed(sourceLines, line)) continue;

      findings.push({
        file,
        line,
        kind: shape.kind,
        statement: literal.text.replace(/\s+/g, ' ').slice(0, 120),
      });
    }
  }

  // `updateMany` and `deleteMany` reach the same tables without any SQL to
  // read. An absent `where` is Prisma's "every row", which is exactly the
  // shape that published the whole outbox.
  for (const match of code.matchAll(/\.(updateMany|deleteMany)\s*\(/g)) {
    const tail = code.slice(match.index, match.index + 300);
    if (/\bwhere\s*:/.test(tail)) continue;

    const line = lineOf(code, match.index);
    if (allowed(sourceLines, line)) continue;

    findings.push({
      file,
      line,
      kind: `${match[1]} without where`,
      statement: tail.replace(/\s+/g, ' ').slice(0, 120),
    });
  }

  return findings;
}

const FILES = readdirSync(TEST_DIR)
  .filter((name) => name.endsWith('.ts'))
  .sort();

describe('the economic integration tests bound every mutation they make', () => {
  it('is reading the suites it claims to be reading', () => {
    // Guards the guard. A wrong path or a regex that stopped matching would
    // make every assertion below trivially true against an empty set — which
    // is the failure mode of every static check ever written.
    expect(FILES.length).toBeGreaterThan(20);
    expect(FILES).toContain('helpers.ts');
    expect(FILES).toContain('system-actor.int-spec.ts');

    const helpers = readFileSync(join(TEST_DIR, 'helpers.ts'), 'utf8');
    const sql = literals(codeLines(helpers).join('\n')).filter((literal) =>
      /\bDELETE\s+FROM\b/i.test(literal.text),
    );
    expect(sql.length).toBeGreaterThan(5);
    // And every one of them is bound, which is the property under test stated
    // once directly rather than only as the absence of a finding.
    for (const statement of sql) expect(statement.text).toMatch(/\bWHERE\b/i);
  });

  it('recognises an unbounded statement when it sees one', () => {
    // The check has to be able to fail, so this is what failing looks like.
    const findings = scan(
      'synthetic.int-spec.ts',
      [
        'const bad = () => client.$executeRawUnsafe(`DELETE FROM journal`);',
        'const worse = () => client.outboxMessage.updateMany({ data: { publishedAt: new Date() } });',
        'const ddl = () => client.$executeRawUnsafe(`ALTER TABLE wallet DISABLE TRIGGER t`);',
      ].join('\n'),
    );

    expect(findings.map((finding) => finding.kind).sort()).toEqual([
      'DELETE',
      'DISABLE TRIGGER',
      'updateMany without where',
    ]);
  });

  it('does not report a statement quoted in prose, or one that is justified', () => {
    const findings = scan(
      'synthetic.int-spec.ts',
      [
        '// The two `DELETE FROM journal` statements that used to stand here.',
        '/* TRUNCATE is never acceptable in a shared database. */',
        `// ${ALLOW_MARKER}: DDL cannot carry a WHERE; the transaction bounds it.`,
        'const fine = () => tx.$executeRawUnsafe(`ALTER TABLE journal DISABLE TRIGGER t`);',
      ].join('\n'),
    );

    expect(findings).toEqual([]);
  });

  it.each(FILES)('%s mutates nothing it cannot name', (name) => {
    const findings = scan(name, readFileSync(join(TEST_DIR, name), 'utf8'));

    // The message is the whole value of this test: a bare `toHaveLength(0)`
    // would say a number, and what the author needs is the statement, the line
    // and what to do about it.
    expect(
      findings.map(
        (finding) =>
          `${finding.file}:${finding.line} — unbounded ${finding.kind}: ${finding.statement}`,
      ),
    ).toEqual([]);
  });
});
