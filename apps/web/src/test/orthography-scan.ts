import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import { parseTree, type Node as JsonNode, type ParseError } from 'jsonc-parser';
import postcss, { CssSyntaxError } from 'postcss';
import ts from 'typescript';

import { nonStandardSpelling } from './orthography';
import { COMPILED_EXTENSIONS, workspacePackageDirs } from './server-action-discovery';

/**
 * Which files the orthography guard reads, and what it reads in each.
 *
 * DISCOVERY. Checked file types under the web app and its workspace packages
 * (`workspacePackageDirs`). Dependency/build directory names and unimported
 * TEST_ONLY names are excluded. These names do not prove production
 * unreachability: routes under `app/dist`, package entry points and public
 * scripts can still be missed (FU-018 R3, pending a separate discovery change).
 * Imported test files are followed transitively; `app/test` is a route.
 *
 * CONTENT, decoded per rendering context, in addition to the file as written
 * (comments, identifiers, regex literals):
 *  - JS/TS: every string literal and template part with its JS escapes decoded;
 *    statically assembled strings are folded first (FOLDED below);
 *  - JSX text and JSX attribute strings: HTML character references decoded (only
 *    there — an "&#1610;" inside an ordinary JS string is not rendered as HTML);
 *  - CSS: CSS escapes decoded (only in CSS);
 *  - JSON: every string, JSON escapes decoded. Strict JSON except root TS/Turbo
 *    configuration files, whose grammars permit comments/trailing commas.
 *    JSON and CSS parser diagnostics are refusals, including recovered parses.
 * FOLDED: `'a' + 'b'` (any nesting, parentheses, `as`/`satisfies`), a template
 * whose every substitution folds, and adjacent JSX text and `{'…'}` children.
 * RENDERING LIMITS (FU-018 R2, pending): constituents are also checked, JSX
 * non-rendering children break runs, and CSS continuations/adjacent content
 * strings are not assembled. Extraction is not a complete rendered-text check.
 * OUT OF REACH: anything computed at run time — a string built from a variable
 * or a constant declared elsewhere (`const a = 'تا'; a + 'مین'`), `.join`,
 * `String.fromCharCode`, copy that arrives from a service.
 *
 * FAIL CLOSED: a parse error, a relative or `@/` import that resolves to no file,
 * a workspace sub-path import, or a computed `import()`/`require()` is reported
 * as a failure with its file:line, never skipped.
 */

const OUTPUT_DIRECTORIES = new Set([
  'node_modules',
  '.next',
  'dist',
  'build',
  '.turbo',
  'coverage',
]);
const CHECKED = new RegExp(`\\.(${[...COMPILED_EXTENSIONS, 'json', 'css'].join('|')})$`);
const DECLARATION = /\.d\.(ts|cts|mts)$/;
/**
 * Test-only by name, relative to its scan root: a spec file (`*.spec.*`,
 * `*.test.*`), a `__tests__`/`__mocks__` directory, the web app's spec support
 * `src/test/` and Playwright suite `e2e/`, and the root config of a tool the
 * build never runs (ESLint, Jest, Playwright). `next.config` and
 * `postcss.config` are build inputs and are checked.
 */
const TEST_ONLY =
  /(\.(spec|test)\.[a-z]+$|(^|\/)(__tests__|__mocks__)\/|^(src\/test|e2e)\/|^(eslint|jest|playwright)\.config\.[a-z]+$)/;

export interface OrthographyScan {
  /** Files read, relative to the repository. */
  readonly checked: string[];
  /** `file:line: spelling` of every non-standard spelling. */
  readonly offenders: string[];
  /** `file:line: reason` of every place the analysis could not complete. */
  readonly failures: string[];
}

function walk(dir: string, into: string[]): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!OUTPUT_DIRECTORIES.has(entry.name)) walk(full, into);
    } else if (CHECKED.test(entry.name) && !DECLARATION.test(entry.name)) {
      into.push(full);
    }
  }
  return into;
}

const scriptKind = (file: string): ts.ScriptKind =>
  /\.tsx$/.test(file)
    ? ts.ScriptKind.TSX
    : /\.ts$/.test(file)
      ? ts.ScriptKind.TS
      : /\.jsx$/.test(file)
        ? ts.ScriptKind.JSX
        : ts.ScriptKind.JS;

/** The string a static expression always evaluates to, or undefined. */
function fold(node: ts.Expression): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node)
  ) {
    return fold(node.expression);
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = fold(node.left);
    const right = left === undefined ? undefined : fold(node.right);
    return right === undefined ? undefined : `${left}${right}`;
  }
  if (ts.isTemplateExpression(node)) {
    let text = node.head.text;
    for (const span of node.templateSpans) {
      const value = fold(span.expression);
      if (value === undefined) return undefined;
      text += value + span.literal.text;
    }
    return text;
  }
  return undefined;
}

const NAMED_REFERENCES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
  shy: '\u00ad',
  zwnj: '\u200c',
  zwj: '\u200d',
  lrm: '\u200e',
  rlm: '\u200f',
};

/** HTML character references as JSX renders them; an unlisted named one stands as a separator. */
export function decodeHtml(text: string): string {
  return text.replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);/g, (_, ref: string) => {
    if (ref[0] !== '#') return NAMED_REFERENCES[ref] ?? '\ufffd';
    const code = /^#[xX]/.test(ref) ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
    return code <= 0x10ffff ? String.fromCodePoint(code) : '\ufffd';
  });
}

/** CSS escapes (`\62a `, `\-`) as a CSS parser reads them. */
export function decodeCss(text: string): string {
  return text.replace(/\\([0-9a-fA-F]{1,6})[ \t\n\f]?|\\([^\n0-9a-fA-F])/g, (_, hex, char) =>
    hex === undefined ? char : String.fromCodePoint(Math.min(parseInt(hex, 16), 0x10ffff)),
  );
}

/** JSX text as React renders it: lines trimmed, blank lines dropped, the rest joined by a space. */
function jsxText(raw: string): string {
  const lines = raw.split(/\r\n|\n|\r/);
  if (lines.length === 1) return decodeHtml(raw);
  return decodeHtml(
    lines
      .map((line, index) =>
        index === 0 ? line.trimEnd() : index === lines.length - 1 ? line.trimStart() : line.trim(),
      )
      .filter((line) => line !== '')
      .join(' '),
  );
}

interface Texts {
  /** Decoded texts with the 1-based line each starts on. */
  readonly texts: Array<[number, string]>;
  readonly imports: Array<[number, string]>;
  readonly failures: string[];
}

function scriptTexts(file: string, source: string): Texts {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKind(file));
  const lineOf = (node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const texts: Array<[number, string]> = [];
  const imports: Array<[number, string]> = [];
  const failures: string[] = [];
  const diagnostics = (sf as unknown as { parseDiagnostics: ts.Diagnostic[] }).parseDiagnostics;
  for (const d of diagnostics) {
    const line = sf.getLineAndCharacterOfPosition(d.start ?? 0).line + 1;
    failures.push(`${line}: parse error: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`);
  }
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      imports.push([lineOf(node), node.moduleSpecifier.text]);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      imports.push([lineOf(node), node.moduleReference.expression.text]);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    ) {
      const target = node.arguments[0] && fold(node.arguments[0]);
      if (target === undefined) failures.push(`${lineOf(node)}: computed import`);
      else imports.push([lineOf(node), target]);
    }
    if (ts.isJsxAttribute(node) && node.initializer && ts.isStringLiteral(node.initializer)) {
      // Not a JS string: no JS escapes, HTML references decoded.
      texts.push([lineOf(node), decodeHtml(node.initializer.getText(sf).slice(1, -1))]);
    } else if (ts.isStringLiteral(node) && ts.isJsxAttribute(node.parent)) {
      // handled above
    } else if (fold(node as ts.Expression) !== undefined) {
      texts.push([lineOf(node), fold(node as ts.Expression) as string]);
    } else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      texts.push([lineOf(node), node.text]);
    }
    if (ts.isJsxElement(node) || ts.isJsxFragment(node)) {
      // Adjacent text and folded `{…}` children render as one string.
      let run = '';
      let from = 0;
      const flush = () => {
        if (run !== '') texts.push([from, run]);
        run = '';
      };
      for (const child of node.children) {
        const piece = ts.isJsxText(child)
          ? jsxText(child.text)
          : ts.isJsxExpression(child) && child.expression
            ? fold(child.expression)
            : undefined;
        if (piece === undefined) flush();
        else {
          if (run === '') from = lineOf(child);
          run += piece;
        }
      }
      flush();
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { texts, imports, failures };
}

function jsonTexts(source: string, config = false): Texts {
  const errors: ParseError[] = [];
  const tree = parseTree(source, errors, {
    disallowComments: !config,
    allowTrailingComma: config,
    allowEmptyContent: false,
  });
  const lineOf = (offset: number): number => source.slice(0, offset).split(/\r\n|\r|\n/).length;
  const failures = errors.map((error) => `${lineOf(error.offset)}: parse error: JSON`);
  const texts: Array<[number, string]> = [];
  const visit = (node: JsonNode): void => {
    if (node.type === 'string') texts.push([lineOf(node.offset), node.value as string]);
    node.children?.forEach(visit);
  };
  if (tree) visit(tree);
  return { texts, imports: [], failures };
}

function cssTexts(source: string): Texts {
  try {
    postcss.parse(source);
  } catch (error) {
    if (!(error instanceof CssSyntaxError)) throw error;
    return { texts: [], imports: [], failures: [`${error.line ?? 1}: parse error: CSS`] };
  }
  const imports: Array<[number, string]> = [];
  source.split('\n').forEach((line, index) => {
    for (const m of line.matchAll(/@import\s+(?:url\(\s*)?(['"]?)([^'")\s;]+)\1/g)) {
      imports.push([index + 1, m[2] as string]);
    }
  });
  return {
    texts: decodeCss(source)
      .split('\n')
      .map((line, index): [number, string] => [index + 1, line]),
    imports,
    failures: [],
  };
}

const RESOLVED_EXTENSIONS = [...COMPILED_EXTENSIONS, 'json', 'css'];

function resolveFile(base: string): string | undefined {
  const candidates = [
    base,
    ...RESOLVED_EXTENSIONS.map((ext) => `${base}.${ext}`),
    ...RESOLVED_EXTENSIONS.map((ext) => join(base, `index.${ext}`)),
    // TS ESM style: `./x.js` names `./x.ts`.
    ...(/\.(m|c)?js$/.test(base)
      ? ['ts', 'tsx', 'mts', 'cts'].map((ext) => base.replace(/\.(m|c)?js$/, `.${ext}`))
      : []),
  ];
  return candidates.find((path) => existsSync(path) && statSync(path).isFile());
}

/**
 * The orthography of every checked file (see the header). `appDir` is the web
 * app; `repoRoot` holds `packages/`.
 */
export function scanOrthography(repoRoot: string, appDir: string): OrthographyScan {
  // Discovery treats an invalid manifest as "not a package". Validate first so
  // malformed dependency metadata cannot silently remove a production root.
  const manifests = [
    join(appDir, 'package.json'),
    ...readdirSync(join(repoRoot, 'packages'))
      .map((name) => join(repoRoot, 'packages', name, 'package.json'))
      .filter(existsSync),
  ];
  const metadataFailures = manifests.flatMap((file) =>
    jsonTexts(readFileSync(file, 'utf8')).failures.map(
      (failure) => `${relative(repoRoot, file)}:${failure}`,
    ),
  );
  if (metadataFailures.length > 0)
    return { checked: [], offenders: [], failures: metadataFailures };
  const roots = [appDir, ...workspacePackageDirs(repoRoot, appDir)];
  const workspaceNames = new Map<string, string>();
  for (const dir of roots.slice(1)) {
    workspaceNames.set(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name, dir);
  }
  const all = new Map<string, string>(); // file -> scan root
  for (const root of roots) for (const file of walk(root, [])) all.set(file, root);
  const testOnly = (file: string) =>
    TEST_ONLY.test(
      relative(all.get(file) as string, file)
        .split(sep)
        .join('/'),
    );

  const offenders: string[] = [];
  const failures: string[] = [];
  const checked = new Set<string>();
  const pending = [...all.keys()].filter((file) => !testOnly(file));
  while (pending.length > 0) {
    const file = pending.pop() as string;
    if (checked.has(file)) continue;
    checked.add(file);
    const at = relative(repoRoot, file);
    const source = readFileSync(file, 'utf8');
    const found = /\.json$/.test(file)
      ? jsonTexts(
          source,
          // JSONC belongs only to build-tool configs at scan roots, never copy JSON.
          roots.includes(dirname(file)) &&
            /^(tsconfig(?:\.[^.]+)?|turbo)\.json$/.test(basename(file)),
        )
      : /\.css$/.test(file)
        ? cssTexts(source)
        : scriptTexts(file, source);
    failures.push(...found.failures.map((failure) => `${at}:${failure}`));
    const lines = source.split('\n').map((line, index): [number, string] => [index + 1, line]);
    for (const [line, text] of [...lines, ...found.texts]) {
      const spelling = nonStandardSpelling(text);
      if (spelling !== null) offenders.push(`${at}:${line}: ${spelling}`);
    }
    for (const [line, specifier] of found.imports) {
      let base: string | undefined;
      if (specifier.startsWith('.') || specifier.startsWith('/')) {
        base = join(dirname(file), specifier);
      } else if (specifier.startsWith('@/') && file.startsWith(appDir + sep)) {
        base = join(appDir, 'src', specifier.slice(2));
      } else if (specifier.startsWith('@/')) {
        failures.push(`${at}:${line}: '@/' outside the web app: '${specifier}'`);
        continue;
      } else {
        const name = specifier
          .split('/')
          .slice(0, specifier.startsWith('@') ? 2 : 1)
          .join('/');
        if (!workspaceNames.has(name)) continue; // a third-party package: not authored here
        if (name !== specifier) {
          failures.push(`${at}:${line}: workspace sub-path import '${specifier}'`);
        }
        continue; // the package's whole directory is a root already
      }
      const target = resolveFile(base);
      if (target === undefined) failures.push(`${at}:${line}: cannot resolve '${specifier}'`);
      // Checked wherever it lives; an asset (an image) holds no authored copy.
      else if (CHECKED.test(target) && !DECLARATION.test(target)) pending.push(target);
    }
  }
  return {
    checked: [...checked].map((file) => relative(repoRoot, file)).sort(),
    offenders,
    failures,
  };
}
