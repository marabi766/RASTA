import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { authoredFiles } = require('../../../../scripts/authored-source-inventory.cjs') as {
  authoredFiles: (dir: string) => string[];
};

/**
 * The class closed in code as in the database (FU-268): no source of this service takes an
 * advisory lock itself. Each goes through `lockReadCommitted`, so through the schema's READ
 * COMMITTED gate, and a lock added later anywhere under `src/` fails here, unlisted.
 *
 * Read as written and as decoded (#1016 r1 F2): every authored file, whatever its type, as text;
 * a TypeScript or JavaScript file also by the value of every name, string and template part
 * (`pg_advisory_xact_lock` is the lock). SQL whose names it cannot read (`U&"…"`, UESCAPE)
 * is refused.
 */
const SRC = join(__dirname, '..');
const ADVISORY = /pg_(try_)?advisory_/i;
const UNREADABLE = /u&"|\buescape\b/i;
const CODE = /\.[cm]?[jt]sx?$/;

/** Every decoded text of a source: identifiers, strings and template parts. */
function decodedTexts(path: string, source: string): string[] {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, false);
  const texts: string[] = [];
  const visit = (node: ts.Node): void => {
    const { text } = node as { text?: unknown };
    if (typeof text === 'string' && node.kind !== ts.SyntaxKind.SourceFile) texts.push(text);
    node.forEachChild(visit);
  };
  visit(file);
  return texts;
}

function lockProblems(path: string, source: string): string[] {
  const texts = [source, ...(CODE.test(path) ? decodedTexts(path, source) : [])];
  return [
    ...(texts.some((text) => ADVISORY.test(text)) ? ['names an advisory lock'] : []),
    ...(texts.some((text) => UNREADABLE.test(text)) ? ['SQL this cannot read'] : []),
  ];
}

describe('every advisory lock of economic-service is taken through the READ COMMITTED gate', () => {
  const production = authoredFiles(SRC).filter(
    (path) => !/\.spec\.[cm]?[jt]sx?$/.test(path) && !path.includes('__snapshots__'),
  );

  it('no authored source names an advisory lock function, or SQL it cannot read', () => {
    const offenders = production
      .map((path) => [relative(SRC, path), lockProblems(path, readFileSync(path, 'utf8'))])
      .filter(([, problems]) => problems.length > 0);
    expect(offenders).toEqual([]);
  });

  it.each([
    ['plain', 'tx.$queryRaw`SELECT pg_advisory_xact_lock(1)`', 'names an advisory lock'],
    [
      'a template escape',
      'tx.$queryRaw`SELECT pg_\\u0061dvisory_xact_lock(1)`',
      'names an advisory lock',
    ],
    ['a string escape', "const q = 'pg_\\x61dvisory_lock';", 'names an advisory lock'],
    [
      'a unicode name',
      'tx.$queryRaw`SELECT U&"pg_\\\\0061dvisory_xact_lock"(1)`',
      'SQL this cannot read',
    ],
    ['UESCAPE', 'tx.$queryRaw`SELECT U&"!0061" UESCAPE \'!\'`', 'SQL this cannot read'],
  ])('refuses a lock spelled %s', (_how, source, problem) => {
    expect(lockProblems('probe.ts', source)).toContain(problem);
  });

  it('reads every type of file as text, and the gate call is no lock', () => {
    expect(lockProblems('notes.json', '{"sql": "SELECT pg_try_advisory_lock(1)"}')).toEqual([
      'names an advisory lock',
    ]);
    expect(lockProblems('probe.ts', 'tx.$queryRaw`SELECT read_committed_xact_lock(1)`')).toEqual(
      [],
    );
  });

  it('reads the sources the locks live in (the scan is not empty)', () => {
    const files = production.map((path) => relative(SRC, path));
    expect(files).toEqual(
      expect.arrayContaining([
        join('reward', 'configuration-lock.ts'),
        join('reward', 'participation.service.ts'),
        join('prisma', 'read-committed-lock.ts'),
      ]),
    );
  });
});
