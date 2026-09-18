import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * AGENTS.md A-02 as an executable check: a file inside one
 * `services/<service>/` package never imports, requires or mocks a path inside
 * another service's package.
 *
 * ## Why this exists beside the ESLint rule
 *
 * The root ESLint config forbids `**\/services/*\/src/**`, and that rule did not
 * stop `identity-service/test/refusal-audit-flow.int-spec.ts` from importing
 * six audit-service modules (ADR-053 plan, Phase C1 correction). Two gaps let
 * it through, and neither is fixable inside ESLint alone:
 *
 *   1. A relative specifier — `../../audit-service/src/...` — contains no
 *      `services/` segment, so the glob never matches it.
 *   2. Every service lints `src` only (`eslint src`), so `test/` is never
 *      linted at all.
 *
 * This checker resolves each specifier to the file it names and asks which
 * service package that file lives in. That is the question A-02 actually asks,
 * and it has the same answer whether the specifier was relative, absolute, a
 * `file:` URL, a bare `services/...` path or a workspace package name.
 *
 * ## Stricter than `src/**`, on purpose
 *
 * A-02 names `services/*\/src/**`. This checker refuses a path into **any** part
 * of another service's package — `src`, `test`, a generated Prisma client,
 * `dist`. Another service's test helpers are its implementation too: the
 * violating file above imported `audit-service/test/helpers` as well, and a rule
 * that allowed that would allow the same coupling one directory over. Shared
 * code goes in `packages/*`; runtime communication goes over REST or Kafka.
 *
 * Pure functions only, so `check-service-boundaries.test.mjs` can drive every
 * branch against a throwaway tree. The CLI is `check-service-boundaries.mjs`.
 */

/** Files that can carry an import. Declarations included: a type import couples too. */
export const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

/**
 * Directories never scanned. Each is either third-party, a build output of the
 * service's own source (checked at the source), or a generated client whose
 * internal requires are relative to itself.
 */
export const SKIPPED_DIRECTORIES = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.turbo',
  'generated',
  'test-results',
  'playwright-report',
]);

/**
 * Replaces every comment with spaces, keeping newlines and string contents, so
 * offsets and line numbers in the result are those of the original.
 *
 * A comment that *describes* a forbidden import is not one — the header of the
 * file this checker was written for did exactly that — and flagging it would
 * make the rule something people learn to word around rather than obey.
 *
 * Template literals are tracked with their `${ … }` nesting. Regular-expression
 * literals are not: a `/` that opens one is read as division, which is harmless
 * unless the pattern itself contains a quote or `//`, and no import site does.
 */
export function stripComments(source) {
  const out = source.split('');
  const blank = (from, to) => {
    for (let i = from; i < to; i += 1) if (out[i] !== '\n' && out[i] !== '\r') out[i] = ' ';
  };

  // Stack of contexts: 'code' (optionally inside a template `${`), 'template'.
  const stack = ['code'];
  const braceDepth = [0];
  let i = 0;
  const n = source.length;

  while (i < n) {
    const context = stack[stack.length - 1];
    const ch = source[i];
    const next = source[i + 1];

    if (context === 'template') {
      if (ch === '\\') {
        i += 2;
      } else if (ch === '`') {
        stack.pop();
        braceDepth.pop();
        i += 1;
      } else if (ch === '$' && next === '{') {
        stack.push('code');
        braceDepth.push(0);
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }

    // code
    if (ch === '/' && next === '/') {
      const end = source.indexOf('\n', i);
      const stop = end === -1 ? n : end;
      blank(i, stop);
      i = stop;
    } else if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      blank(i, stop);
      i = stop;
    } else if (ch === "'" || ch === '"') {
      i += 1;
      while (i < n && source[i] !== ch && source[i] !== '\n') {
        i += source[i] === '\\' ? 2 : 1;
      }
      i += 1;
    } else if (ch === '`') {
      stack.push('template');
      braceDepth.push(0);
      i += 1;
    } else if (ch === '{') {
      braceDepth[braceDepth.length - 1] += 1;
      i += 1;
    } else if (ch === '}') {
      if (stack.length > 1 && braceDepth[braceDepth.length - 1] === 0) {
        // Closes a template substitution.
        stack.pop();
        braceDepth.pop();
      } else {
        braceDepth[braceDepth.length - 1] -= 1;
      }
      i += 1;
    } else {
      i += 1;
    }
  }

  return out.join('');
}

const QUOTED = String.raw`(['"\x60])([^'"\x60\n]+)\1`;

/**
 * Every way a module in this repository can name another file.
 *
 *   import … from 'x'  ·  import 'x'  ·  import type … from 'x'
 *   export … from 'x'  ·  export * from 'x'
 *   import('x')        ·  require('x')  ·  require.resolve('x')
 *   import x = require('x')
 *   jest.mock / doMock / unmock / requireActual / requireMock / createMockFromModule('x')
 *
 * `jest.mock` is here because it loads the module it names: a test that mocks
 * another service's repository has imported it.
 */
const PATTERNS = [
  new RegExp(String.raw`\bimport\s+(?:type\s+)?[\w$*{}\s,]*?\bfrom\s*` + QUOTED, 'g'),
  new RegExp(String.raw`\bimport\s*` + QUOTED, 'g'),
  new RegExp(
    String.raw`\bexport\s+(?:type\s+)?(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s*from\s*` + QUOTED,
    'g',
  ),
  new RegExp(String.raw`\bimport\s*\(\s*` + QUOTED, 'g'),
  new RegExp(String.raw`\brequire(?:\.resolve)?\s*\(\s*` + QUOTED, 'g'),
  new RegExp(
    String.raw`\bjest\s*\.\s*(?:mock|doMock|unmock|requireActual|requireMock|createMockFromModule)\s*\(\s*` +
      QUOTED,
    'g',
  ),
];

/** `{ specifier, index }` for every module reference in `source`, in source order. */
export function extractSpecifiers(source) {
  const code = stripComments(source);
  const found = new Map();
  for (const pattern of PATTERNS) {
    pattern.lastIndex = 0;
    for (let match = pattern.exec(code); match; match = pattern.exec(code)) {
      const specifier = match[2];
      const index = match.index + match[0].lastIndexOf(specifier);
      // Keyed by position, so a site two patterns could both reach is reported
      // once rather than twice.
      if (!found.has(index)) found.set(index, specifier);
    }
  }
  return [...found.entries()]
    .sort(([a], [b]) => a - b)
    .map(([index, specifier]) => ({ specifier, index }));
}

/** 1-based line of `index` in `source`. */
export function lineOf(source, index) {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i += 1) if (source[i] === '\n') line += 1;
  return line;
}

const toPosix = (path) => path.split(sep).join('/').replace(/\\/g, '/');

/**
 * The service directory a repository-relative path lies in, or `null`.
 * `services/identity-service/test/x.ts` → `identity-service`.
 */
export function serviceOf(repoRelativePath) {
  const match = /^services\/([^/]+)(?:\/|$)/.exec(toPosix(repoRelativePath));
  return match ? match[1] : null;
}

/**
 * Resolves `specifier`, written in `fromFile`, to the service it reaches — or
 * `null` when it reaches no service package (a dependency, `packages/*`, a
 * file outside `services/`).
 *
 * @param {object} options
 * @param {string} options.repoRoot           absolute repository root
 * @param {string} options.fromFile           absolute path of the importing file
 * @param {string} options.specifier          the module specifier as written
 * @param {Map<string,string>} options.packageToService
 *        workspace package name → service directory, e.g.
 *        `@rasta/audit-service` → `audit-service`
 * @returns {{ service: string, target: string } | null}
 */
export function resolveTarget({ repoRoot, fromFile, specifier, packageToService }) {
  // A workspace package name. Services are applications, not libraries: none
  // exports anything for another to import, so any subpath counts.
  const packageName = specifier.startsWith('@')
    ? specifier.split('/').slice(0, 2).join('/')
    : specifier.split('/')[0];
  const viaPackage = packageToService.get(packageName);
  if (viaPackage) {
    return {
      service: viaPackage,
      target: `services/${viaPackage}${specifier.slice(packageName.length)}`,
    };
  }

  let absolute;
  if (specifier.startsWith('file:')) {
    try {
      absolute = fileURLToPath(specifier);
    } catch {
      return null;
    }
  } else if (
    specifier === '.' ||
    specifier === '..' ||
    specifier.startsWith('./') ||
    specifier.startsWith('../')
  ) {
    absolute = resolve(dirname(fromFile), specifier);
  } else if (isAbsolute(specifier) || /^[A-Za-z]:[\\/]/.test(specifier)) {
    absolute = resolve(specifier);
  } else if (/^\/?services\//.test(specifier)) {
    // A bare or root-anchored repository path, the form a `paths` alias or a
    // `baseUrl` of the repository root would produce.
    absolute = resolve(repoRoot, specifier.replace(/^\//, ''));
  } else {
    return null;
  }

  const rawRelative = relative(repoRoot, absolute);
  // Outside the repository whenever `relative` says so with a leading `..`,
  // or — the case a leading-`..` check alone misses — when `repoRoot` and
  // `absolute` sit on different Windows drives, where `path.relative` returns
  // `absolute` itself rather than a `..`-prefixed path. An absolute path can
  // still name a service checkout elsewhere on disk, which is no better.
  if (rawRelative.startsWith('..') || isAbsolute(rawRelative)) {
    const match = /\/services\/([^/]+)(?:\/|$)/.exec(toPosix(absolute));
    return match ? { service: match[1], target: toPosix(absolute) } : null;
  }
  const fromRoot = toPosix(rawRelative);
  const service = serviceOf(fromRoot);
  return service ? { service, target: fromRoot } : null;
}

/**
 * Violations in one file's `source`.
 *
 * @returns {{ file: string, line: number, specifier: string, owner: string, target: string, service: string }[]}
 */
export function checkSource({ repoRoot, file, source, packageToService }) {
  const fromRoot = toPosix(relative(repoRoot, file));
  const owner = serviceOf(fromRoot);
  if (!owner) return [];

  const violations = [];
  for (const { specifier, index } of extractSpecifiers(source)) {
    const reached = resolveTarget({ repoRoot, fromFile: file, specifier, packageToService });
    if (reached && reached.service !== owner) {
      violations.push({
        file: fromRoot,
        line: lineOf(source, index),
        specifier,
        owner,
        service: reached.service,
        target: reached.target,
      });
    }
  }
  return violations;
}

/** `@rasta/<name>` → service directory, read from each service's own package.json. */
export function servicePackages(repoRoot) {
  const map = new Map();
  const servicesDir = join(repoRoot, 'services');
  if (!existsSync(servicesDir)) return map;
  for (const entry of readdirSync(servicesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifest = join(servicesDir, entry.name, 'package.json');
    if (!existsSync(manifest)) continue;
    try {
      const { name } = JSON.parse(readFileSync(manifest, 'utf8'));
      if (typeof name === 'string' && name.length > 0) map.set(name, entry.name);
    } catch {
      // A malformed manifest is somebody else's failure to report; it cannot
      // widen what this check allows.
    }
  }
  return map;
}

function* walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
      yield* walk(path);
    } else if (entry.isFile() && SOURCE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
      yield path;
    }
  }
}

/**
 * Scans every service package under `repoRoot`.
 *
 * @returns {{ scanned: number, services: number, violations: ReturnType<typeof checkSource> }}
 */
export function scanRepository(repoRoot) {
  const root = resolve(repoRoot);
  const packageToService = servicePackages(root);
  const servicesDir = join(root, 'services');
  const violations = [];
  let scanned = 0;
  let services = 0;

  if (!existsSync(servicesDir) || !statSync(servicesDir).isDirectory()) {
    return { scanned, services, violations };
  }

  for (const entry of readdirSync(servicesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    services += 1;
    for (const file of walk(join(servicesDir, entry.name))) {
      scanned += 1;
      const source = readFileSync(file, 'utf8');
      violations.push(...checkSource({ repoRoot: root, file, source, packageToService }));
    }
  }

  return { scanned, services, violations };
}

/** One violation as a `file:line` line a terminal and an editor both understand. */
export function formatViolation(violation) {
  return (
    `${violation.file}:${violation.line}  ${violation.owner} imports '${violation.specifier}' ` +
    `→ ${violation.target} (inside ${violation.service})`
  );
}
