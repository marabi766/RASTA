/**
 * @rasta/testing holds a test-only internal-token signer
 * (packages/testing/src/internal-token.ts, `mintTestInternalToken`). It must
 * never reach production. Three layers hold that, each checking an outcome
 * rather than how a file is spelled (PR #514 r1 F1):
 *
 * 1. **Source** — ESLint rule `testing/dev-only`: no production file imports
 *    the package, by name or by path, in any module form (static import,
 *    `export … from`, `import()`, `require`, `require.resolve`,
 *    `import x = require()`, `import('…')` types), and no production file
 *    imports a test-only file that could. Which files are production is
 *    decided here, by repository path (`isTestOnlyPath`), so a file kind
 *    nobody listed is production: fail closed. A dynamic `import()` or
 *    `require()` whose specifier is not a literal cannot be checked and is
 *    refused in production files. Root and web lint configs load the rule;
 *    scripts/testing-dev-only.test.mjs also runs it over every source file
 *    in apps/, services/ and packages/, including files no lint script names.
 * 2. **Dependencies** — `prodGraphProblems`: pnpm's own resolved production
 *    graph (`pnpm list --prod --recursive --depth Infinity`), so a package is
 *    identified by where it resolves and the name in its manifest, never by
 *    the key it is declared under (`signing: workspace:@rasta/testing@*`,
 *    `link:`/`file:` paths, any depth).
 * 3. **Artifacts** — `node scripts/testing-dev-only.mjs image <ref>`, run in CI
 *    on every image that is built (job `containers`: every image on a push
 *    to main, the affected ones on a merge-train run). It exports the final
 *    image filesystem and refuses a manifest named `@rasta/testing`, a
 *    `@rasta+testing` store entry, the minter's refusal text
 *    (`SIGNER_MARKER`, in any copy, compiled or bundled) and the minter's
 *    name in anything but TypeScript source. So a stage inherited from the
 *    build, a deploy without `--prod`, a copy after deploy or a
 *    `RUN --mount` copy is caught by what the image holds, however the
 *    Dockerfile says it. `tree <dir> <entry>` checks a build-output
 *    directory the same way: CI runs it on the portal's `.next` (job
 *    `web-browser`, every pull request), which has no image in this
 *    repository.
 *
 * Only Node built-ins here: CI runs the image check on a runner without an
 * install.
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
export const TESTING = '@rasta/testing';
export const TESTING_DIR = join(REPO_ROOT, 'packages', 'testing');
/** Part of the minter's refusal text, so every copy of the minter carries it. */
export const SIGNER_MARKER = 'rasta test-only internal-token signer';
export const MINTER_NAME = 'mintTestInternalToken';

// ---------------------------------------------------------------------------
// 1. Source
// ---------------------------------------------------------------------------

const toPosix = (path) => path.split(sep).join('/');

/**
 * Whether a repository-relative path is test-only code that no image runs.
 * Everything else — `src/**`, `dev/**`, `prisma/**`, a new directory — is
 * production. Root `scripts/` is CI and operator tooling, never copied into
 * an image (layer 3 would see it if it were).
 */
export function isTestOnlyPath(relPath) {
  const rel = toPosix(relPath);
  if (/^(tests|scripts|packages\/testing)\//.test(rel)) return true;
  if (/(^|\/)(test|__tests__|e2e)\//.test(rel)) return true;
  return /\.(spec|test|int-spec|e2e-spec)\.[cm]?[jt]sx?$/.test(rel);
}

/** True when `target` (absolute) is the testing package or inside it. */
const insideTesting = (target) => {
  const rel = relative(TESTING_DIR, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

/**
 * Why `specifier`, imported from `filename`, reaches test-only code, or
 * `undefined`. By name: `@rasta/testing` and its subpaths, or a path through
 * a `@rasta/testing` / `@rasta+testing` directory. By path: a relative or
 * absolute specifier resolving into packages/testing or into a test-only file
 * (root `scripts/` excepted: lint configs load their rules from there).
 */
export function testOnlyTarget(specifier, filename) {
  if (specifier === TESTING || specifier.startsWith(`${TESTING}/`)) return TESTING;
  if (/(^|\/)@rasta[/+]testing([/@]|$)/.test(specifier)) return TESTING;
  if (!specifier.startsWith('.') && !isAbsolute(specifier)) return undefined;
  const target = resolve(dirname(filename), specifier);
  if (insideTesting(target)) return 'packages/testing';
  const rel = relative(REPO_ROOT, target);
  if (
    !rel.startsWith('..') &&
    !isAbsolute(rel) &&
    !/^scripts\//.test(toPosix(rel)) &&
    isTestOnlyPath(rel)
  ) {
    return `test-only ${toPosix(rel)}`;
  }
  return undefined;
}

const literal = (node) => {
  if (node?.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis[0].value.cooked;
  }
  return undefined;
};

/** ESLint rule `testing/dev-only` (see layer 1 above). */
export const devOnlyRule = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      reaches:
        '{{target}} is test-only code (it holds a test signer) and must not be reachable from production source.',
      dynamic:
        'A non-literal module specifier cannot be checked against test-only code; use a literal in production source.',
    },
  },
  create(context) {
    const filename = context.filename;
    const rel = relative(REPO_ROOT, filename);
    if (rel.startsWith('..') || isAbsolute(rel) || isTestOnlyPath(rel)) return {};

    const check = (node, source, { dynamic = false } = {}) => {
      const specifier = literal(source);
      if (specifier === undefined) {
        if (dynamic) context.report({ node, messageId: 'dynamic' });
        return;
      }
      const target = testOnlyTarget(specifier, filename);
      if (target) context.report({ node, messageId: 'reaches', data: { target } });
    };
    const isRequire = (callee) =>
      (callee.type === 'Identifier' && callee.name === 'require') ||
      (callee.type === 'MemberExpression' &&
        !callee.computed &&
        ((callee.object.type === 'Identifier' &&
          callee.object.name === 'require' &&
          callee.property.name === 'resolve') ||
          (callee.object.type === 'Identifier' &&
            callee.object.name === 'module' &&
            callee.property.name === 'require')));

    return {
      ImportDeclaration: (node) => check(node, node.source),
      ExportNamedDeclaration: (node) => node.source && check(node, node.source),
      ExportAllDeclaration: (node) => check(node, node.source),
      ImportExpression: (node) => check(node, node.source, { dynamic: true }),
      TSImportType: (node) => check(node, node.argument?.literal ?? node.argument),
      TSExternalModuleReference: (node) => check(node, node.expression),
      CallExpression(node) {
        if (isRequire(node.callee)) check(node, node.arguments[0], { dynamic: true });
      },
    };
  },
};

// ---------------------------------------------------------------------------
// 2. Dependencies
// ---------------------------------------------------------------------------

/** `pnpm list --prod` for every workspace project under `cwd`, as JSON. */
export function pnpmProdGraph(cwd) {
  const result = spawnSync(
    'pnpm',
    ['list', '--prod', '--json', '--recursive', '--depth', 'Infinity'],
    { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    throw new Error(`pnpm list failed (${result.status}): ${result.stderr || result.error}`);
  }
  return JSON.parse(result.stdout);
}

/**
 * Every production dependency chain, from any workspace project, that ends
 * in the testing package — identified by its resolved directory or the name
 * in its own manifest, whatever key declares it. `testingDir` is the
 * workspace's packages/testing.
 */
export function prodGraphProblems(projects, testingDir) {
  const testingReal = realpathSync(testingDir);
  const identity = new Map();
  const isTesting = (path) => {
    if (!path) return false;
    if (!identity.has(path)) {
      let real = path;
      let name;
      try {
        real = realpathSync(path);
        name = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8')).name;
      } catch {
        // An entry pnpm lists but whose manifest is unreadable: decided by path alone.
      }
      identity.set(
        path,
        real === testingReal || name === TESTING || /[/\\]@rasta\+testing@/.test(path),
      );
    }
    return identity.get(path);
  };

  const problems = [];
  const walk = (deps, chain) => {
    for (const [key, dep] of Object.entries(deps ?? {})) {
      const here = [...chain, `${key} (${dep.version})`];
      if (isTesting(dep.path)) problems.push(here.join(' → '));
      else walk(dep.dependencies, here);
    }
  };
  for (const project of projects) {
    if (isTesting(project.path)) continue;
    walk(project.dependencies, [project.name ?? project.path]);
    walk(project.optionalDependencies, [project.name ?? project.path]);
  }
  return problems;
}

// ---------------------------------------------------------------------------
// 3. Images
// ---------------------------------------------------------------------------

const TS_SOURCE = /\.(?:[cm]?ts|tsx)$/;
const DECLARATION = /\.d\.[cm]?ts$/;
const SKIPPED_ROOTS = new Set(['proc', 'sys', 'dev']);

/**
 * What in an extracted image filesystem (`root`) is the test signer or its
 * package. TypeScript sources may name the minter (a service's own test
 * files ship in its directory and cannot resolve the package without it);
 * they still may not contain the minter itself (`SIGNER_MARKER`).
 */
export function imageTreeProblems(root) {
  const problems = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const rel = toPosix(relative(root, path));
      if (dir === root && SKIPPED_ROOTS.has(entry.name)) continue;
      if (/(^|\/)(@rasta\+testing[^/]*|@rasta\/testing)(\/|$)/.test(rel)) {
        problems.push(`${rel}: a ${TESTING} package directory`);
        if (entry.isDirectory()) continue;
      }
      if (entry.isDirectory()) {
        visit(path);
        continue;
      }
      if (!entry.isFile()) continue;
      const bytes = readFileSync(path);
      if (bytes.includes(SIGNER_MARKER)) problems.push(`${rel}: contains the test signer`);
      if (bytes.includes(MINTER_NAME) && (!TS_SOURCE.test(rel) || DECLARATION.test(rel))) {
        problems.push(`${rel}: names ${MINTER_NAME} outside TypeScript source`);
      }
      if (entry.name === 'package.json' && bytes.includes(TESTING)) {
        let name;
        try {
          name = JSON.parse(bytes.toString('utf8')).name;
        } catch {
          problems.push(`${rel}: unreadable manifest that mentions ${TESTING}`);
          continue;
        }
        if (name === TESTING) problems.push(`${rel}: the ${TESTING} manifest`);
      }
    }
  };
  visit(root);
  return problems;
}

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed (${result.status}): ${result.stderr || result.error}`,
    );
  }
  return result.stdout;
};

/**
 * Exports the final filesystem of image `ref` and checks it. Fails closed:
 * any docker or tar failure, or an export without the image's own entry
 * point (WORKDIR + CMD), is an error rather than a pass.
 */
export function checkImage(ref) {
  const [config] = JSON.parse(run('docker', ['image', 'inspect', ref]));
  const workdir = config?.Config?.WorkingDir;
  const entry = config?.Config?.Cmd?.at(-1);
  if (!workdir || !entry) throw new Error(`${ref}: no WORKDIR or CMD to locate the entry point`);

  const scratch = mkdtempSync(join(tmpdir(), 'testing-dev-only-'));
  const id = run('docker', ['create', ref]).trim();
  try {
    const tarball = join(scratch, 'image.tar');
    run('docker', ['export', '--output', tarball, id]);
    const root = join(scratch, 'fs');
    run('mkdir', [root]);
    run('tar', [
      '-xf',
      tarball,
      '-C',
      root,
      '--no-same-owner',
      '--no-same-permissions',
      '--exclude=dev/*',
    ]);
    rmSync(tarball);
    const main = join(root, workdir, entry);
    if (!existsSync(main) || !lstatSync(main).isFile()) {
      throw new Error(
        `${ref}: entry point ${join(workdir, entry)} is not in the exported filesystem`,
      );
    }
    return imageTreeProblems(root);
  } finally {
    spawnSync('docker', ['rm', id]);
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Checks a build-output directory (the portal's `.next`) the same way.
 * `entry` must be a file in it, so an empty or misplaced directory is an
 * error rather than a pass.
 */
export function checkTree(dir, entry) {
  const main = join(dir, entry);
  if (!existsSync(main) || !lstatSync(main).isFile()) {
    throw new Error(`${entry} is not in ${dir}: not a build output`);
  }
  return imageTreeProblems(dir);
}

/** An image reference as CI tags one (`rasta/<service>:<sha>`), or a local tag. */
const IMAGE_REF = /^[a-z0-9][a-z0-9._/-]*(?::[A-Za-z0-9._-]+)?$/;
/** A repository-relative directory or file name: no `..`, no leading `/`. */
const REPO_PATH = /^(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._-][A-Za-z0-9._/-]*$/;

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, target, entry, ...rest] = process.argv.slice(2);
  const valid =
    rest.length === 0 &&
    ((command === 'image' && entry === undefined && IMAGE_REF.test(target ?? '')) ||
      (command === 'tree' && REPO_PATH.test(target ?? '') && REPO_PATH.test(entry ?? '')));
  if (!valid) {
    console.error(
      'usage: node scripts/testing-dev-only.mjs image <name[:tag]> | tree <dir> <entry-file>',
    );
    process.exit(2);
  }
  try {
    const problems = command === 'image' ? checkImage(target) : checkTree(target, entry);
    if (problems.length > 0) {
      console.error(`${target}: test-only signer code:\n  ${problems.join('\n  ')}`);
      process.exit(1);
    }
    console.log(`${target}: no ${TESTING} package and no test signer`);
  } catch (error) {
    console.error(`${target}: cannot verify: ${error.message}`);
    process.exit(1);
  }
}
