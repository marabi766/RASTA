import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve, relative, join } from 'node:path';
import ts from 'typescript';

// eslint-disable-next-line @typescript-eslint/no-require-imports -- CommonJS, shared with the other specs
const { authoredFiles } = require('../../../../scripts/authored-source-inventory.cjs') as {
  authoredFiles: (dir: string) => string[];
};

interface RawSite {
  file: string;
  hash: string;
  occurrence: number;
}
interface ReviewedSite extends RawSite {
  line: number;
  decision: string;
}
const root = resolve(__dirname, '../../../..');
const inventory = JSON.parse(
  readFileSync(join(__dirname, 'raw-sql-inventory.json'), 'utf8'),
) as ReviewedSite[];
function sites(source: string, file: string): RawSite[] {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const result: RawSite[] = [];
  const occurrences = new Map<string, number>();
  function visit(node: ts.Node): void {
    const direct = ts.isCallExpression(node) || ts.isTaggedTemplateExpression(node);
    const extracted =
      (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
      !(
        (ts.isCallExpression(node.parent) && node.parent.expression === node) ||
        (ts.isTaggedTemplateExpression(node.parent) && node.parent.tag === node)
      );
    const binding = ts.isBindingElement(node);
    if (direct || extracted || binding) {
      const expr = ts.isCallExpression(node)
        ? node.expression
        : ts.isTaggedTemplateExpression(node)
          ? node.tag
          : node;
      const memberName = ts.isBindingElement(expr) ? (expr.propertyName ?? expr.name) : undefined;
      const member =
        memberName && ts.isComputedPropertyName(memberName) ? memberName.expression : memberName;
      const name = ts.isPropertyAccessExpression(expr)
        ? expr.name.text
        : ts.isElementAccessExpression(expr) &&
            expr.argumentExpression &&
            ts.isStringLiteralLike(expr.argumentExpression)
          ? expr.argumentExpression.text
          : member && (ts.isIdentifier(member) || ts.isStringLiteralLike(member))
            ? member.text
            : '';
      if (/^\$(queryRaw|executeRaw)/.test(name)) {
        const hash = createHash('sha256').update(node.getText(parsed)).digest('hex');
        const occurrence = occurrences.get(hash) ?? 0;
        occurrences.set(hash, occurrence + 1);
        result.push({ file, hash, occurrence });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  return result;
}
/** Authored `services/<name>/src/**` source files (git-ignored output is never listed). */
function sourceFiles(): string[] {
  const services = join(root, 'services');
  return authoredFiles(services).filter(
    (path) =>
      /^[^/\\]+[/\\]src[/\\]/.test(relative(services, path)) &&
      /\.(?:[cm]?[jt]s|tsx|jsx)$/.test(path),
  );
}
function key(site: RawSite): string {
  return `${site.file}:${site.hash}:${site.occurrence}`;
}
function unclassified(actual: RawSite[], reviewed: ReviewedSite[]): RawSite[] {
  const accepted = new Set(
    reviewed
      .filter(
        (row) =>
          row.decision === 'has bound organization predicate' ||
          /^platform-wide: .{20,}$/.test(row.decision),
      )
      .map(key),
  );
  return actual.filter((site) => !accepted.has(key(site)));
}
it('every raw SQL call in ALL service src files has an explicit reviewed classification', () => {
  const files = sourceFiles();
  const actual = files.flatMap((file) => sites(readFileSync(file, 'utf8'), relative(root, file)));
  expect(actual.length).toBeGreaterThan(0);
  expect(unclassified(actual, inventory)).toEqual([]);
  const live = new Set(actual.map(key));
  expect(inventory.filter((entry) => !live.has(key(entry)))).toEqual([]);
  expect(new Set(inventory.map(key)).size).toBe(inventory.length);
}, 30_000);
it.each(['$queryRaw', '$executeRaw', '$queryRawUnsafe', '$executeRawUnsafe', '$queryRawTyped'])(
  'a new %s site refuses',
  (method) => {
    const source = `client.${method}(query)`;
    expect(
      unclassified(sites(source, 'services/new-service/src/repository.ts'), inventory),
    ).toHaveLength(1);
  },
);
it('changing approved SQL or adding a duplicate site requires another review', () => {
  const file = 'services/new-service/src/repository.ts';
  const source = 'client.$queryRaw`SELECT 1`';
  const first = sites(source, file)[0]!;
  const reviewed = [
    { ...first, line: 1, decision: 'platform-wide: fixed health probe without tenant data' },
  ];
  expect(unclassified(sites(source, file), reviewed)).toEqual([]);
  expect(
    unclassified(sites('client.$queryRaw`SELECT * FROM membership`', file), reviewed),
  ).toHaveLength(1);
  expect(unclassified(sites(`${source}; ${source}`, file), reviewed)).toHaveLength(1);
});
it('unclassified and reasonless entries cannot grant approval', () => {
  const actual = sites('tx["$executeRawUnsafe"](sql)', 'fixture.ts');
  expect(actual).toHaveLength(1);
  expect(
    unclassified(actual, [{ ...actual[0]!, line: 1, decision: 'platform-wide:' }]),
  ).toHaveLength(1);
});
it('extracted and destructured raw methods still require a classified site', () => {
  expect(
    unclassified(sites('const query = tx.$queryRaw; query(sql)', 'alias.ts'), inventory),
  ).toHaveLength(1);
  expect(
    unclassified(
      sites('const { $executeRawUnsafe: execute } = tx; execute(sql)', 'binding.ts'),
      inventory,
    ),
  ).toHaveLength(1);
});
it.each(['tx[`$queryRaw`](sql)', 'const {[`$executeRawUnsafe`]: execute} = tx; execute(sql)'])(
  'template-quoted raw methods require classification: %s',
  (source) => {
    expect(unclassified(sites(source, 'template-quoted.ts'), inventory)).toHaveLength(1);
  },
);
