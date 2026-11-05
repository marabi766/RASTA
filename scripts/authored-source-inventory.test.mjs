// The shared authored-source inventory and the guard that keeps directory listing on it (FU-102).
//
// Git-ignored output (`generated` Prisma clients, `node_modules`, build output, `.next.build-lock*`)
// is rewritten by other tasks while a check runs. A walker that lists such a directory and reads it
// afterwards dies with ENOENT on a file nobody wrote (PR #741 F1/F2). `authored-source-inventory.cjs`
// never opens it, by ONE policy: the repository's .gitignore. The second half of this file refuses
// every other use of a directory-listing API.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { authoredFiles, ignoreMatcher } from './authored-source-inventory.cjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const INVENTORY = 'scripts/authored-source-inventory.cjs';
const GITIGNORE = fs.readFileSync(join(root, '.gitignore'), 'utf8');
const git = (...args) =>
  execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 1 << 28 });

/** A tree with authored files and one ignored path of every pattern shape of the real .gitignore. */
const AUTHORED = [
  'a.ts',
  'b/c.ts',
  'b/d/e.mjs',
  '.vscode/extensions.json',
  '.vscode/settings.example.json',
  '.env.example',
  'infrastructure/docker/kafka/bootstrap.env.example',
];
const IGNORED_DIRECTORIES = [
  'b/node_modules',
  'b/src/generated',
  'b/dist',
  'b/.next',
  'b/.next.build-lock',
  'b/.next.build-lock.receipt-1',
  'infrastructure/docker/kafka/.tls',
  '.vscode/cache',
  'b/.git', // not in .gitignore: git's own directory, at any depth
];
const IGNORED_FILES = ['.vscode/settings.json', 'x.log', '.env', 'a.tsbuildinfo', 'b/.env.local'];
function fixture() {
  const dir = fs.mkdtempSync(join(tmpdir(), 'authored-inventory-'));
  for (const file of [
    ...AUTHORED,
    ...IGNORED_FILES,
    ...IGNORED_DIRECTORIES.map((d) => `${d}/deep/f`),
  ]) {
    fs.mkdirSync(dirname(join(dir, file)), { recursive: true });
    fs.writeFileSync(join(dir, file), 'x\n');
  }
  return dir;
}
/** Runs `body` while recording every directory the inventory opens; `fail(path)` may throw instead. */
function opened(body, fail = () => undefined) {
  const real = fs.readdirSync;
  const seen = [];
  fs.readdirSync = (path, ...rest) => {
    seen.push(String(path));
    fail(String(path));
    return real(path, ...rest);
  };
  try {
    return { result: body(), seen };
  } finally {
    fs.readdirSync = real;
  }
}
const rel = (dir) => (path) => relative(dir, path);

test('lists authored files, sorted, and never opens an ignored directory (every .gitignore pattern shape)', () => {
  const dir = fixture();
  try {
    const { result, seen } = opened(() => authoredFiles(dir));
    assert.deepEqual(
      result.map(rel(dir)),
      [...AUTHORED].sort(),
      'authored files, ignored ones left out',
    );
    const hit = seen
      .map(rel(dir))
      .filter((path) => IGNORED_DIRECTORIES.some((d) => path === d || path.startsWith(`${d}/`)));
    assert.deepEqual(hit, [], 'an ignored directory was opened');
    assert.ok(seen.length >= 6, 'the authored directories were opened');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an ignored directory that vanishes between listing and reading cannot fail the inventory', () => {
  const dir = fixture();
  try {
    // The review's race: the parent was listed, the lock directory is gone when it would be opened.
    const gone = (path) => {
      if (IGNORED_DIRECTORIES.some((d) => relative(dir, path) === d))
        throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
    };
    assert.equal(opened(() => authoredFiles(dir), gone).result.length, AUTHORED.length);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('skip prunes by name before the directory is opened; an authored fault still throws', () => {
  const dir = fixture();
  try {
    const { result, seen } = opened(() => authoredFiles(dir, { skip: (name) => name === 'd' }));
    assert.ok(!result.some((path) => path.endsWith('e.mjs')));
    assert.ok(!seen.includes(join(dir, 'b', 'd')));
    assert.throws(() => authoredFiles(join(dir, 'absent')), { code: 'ENOENT' });
    assert.deepEqual(authoredFiles(join(dir, 'absent'), { optional: true }), []);
    assert.throws(() => authoredFiles(join(dir, 'a.ts'), { optional: true }), { code: 'ENOTDIR' });
    // A listed AUTHORED directory that is gone (or unreadable) when it is opened is a real fault.
    for (const [code, options] of [['ENOENT'], ['EACCES'], ['ENOENT', { optional: true }]])
      assert.throws(
        () =>
          opened(
            () => authoredFiles(dir, options),
            (path) => {
              if (path === join(dir, 'b', 'd')) throw Object.assign(new Error(code), { code });
            },
          ),
        { code },
      );
    // The policy is read on every call: an unreadable .gitignore refuses, it does not ignore nothing.
    const real = fs.readFileSync;
    fs.readFileSync = (path, ...rest) => {
      if (String(path).endsWith('.gitignore'))
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      return real(path, ...rest);
    };
    try {
      assert.throws(() => authoredFiles(dir), { code: 'EACCES' });
    } finally {
      fs.readFileSync = real;
    }
    // A linked directory is judged like a directory (a linked node_modules is not opened) and not entered.
    fs.symlinkSync(join(dir, 'b'), join(dir, 'node_modules'));
    fs.symlinkSync(join(dir, 'b'), join(dir, 'linked'));
    const listed = authoredFiles(dir).map(rel(dir));
    assert.ok(!listed.includes('node_modules') && listed.includes('linked'));
    assert.ok(!listed.some((path) => path.startsWith('linked/')));
    // A walk that starts below the base still judges paths from it: `src/generated` is ignored
    // although the walk starts in `src` (a root outside the repository names its base).
    fs.mkdirSync(join(dir, 'tree/src/generated/deep'), { recursive: true });
    fs.writeFileSync(join(dir, 'tree/src/app.ts'), 'x');
    fs.writeFileSync(join(dir, 'tree/src/generated/deep/f'), 'x');
    const below = opened(() => authoredFiles(join(dir, 'tree/src'), { base: join(dir, 'tree') }));
    assert.deepEqual(below.result.map(rel(dir)), ['tree/src/app.ts']);
    assert.ok(!below.seen.some((path) => path.includes('generated')));
    assert.throws(
      () => authoredFiles(join(dir, 'b'), { base: join(dir, 'tree') }),
      /not inside its base/,
    );
    // ...and so is a root that is itself ignored output: nobody asks for the authored files of it.
    assert.throws(() => authoredFiles(join(root, 'services/audit-service/src/generated')), {
      code: 'EIGNORED',
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------
// ONE exclusion policy, and it is .gitignore: checked against git itself.
// ---------------------------------------------------------------------------------------------

/** What `git check-ignore --no-index` says about `[path, isDirectory]` pairs under this .gitignore. */
function gitIgnores(gitignore, probes) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'authored-gitignore-'));
  try {
    execFileSync('git', ['init', '-q', dir]);
    fs.writeFileSync(join(dir, '.gitignore'), gitignore);
    // The paths exist, so git knows which are directories (a trailing slash would be read as a name).
    const made = probes.filter(([path, isDirectory]) => {
      try {
        if (isDirectory) fs.mkdirSync(join(dir, path), { recursive: true });
        else {
          fs.mkdirSync(dirname(join(dir, path)), { recursive: true });
          fs.writeFileSync(join(dir, path), 'x');
        }
        return true;
      } catch {
        return false; // a file probe under a probe that is a file: the directory probes cover it
      }
    });
    const input = made.map(([path]) => `${path}\0`).join('');
    const out = spawnSync('git', ['-C', dir, 'check-ignore', '--no-index', '--stdin', '-z'], {
      input,
      encoding: 'utf8',
    });
    assert.ok(out.status === 0 || out.status === 1, out.stderr);
    const ignored = new Set(out.stdout.split('\0').filter(Boolean));
    return { made, ignored };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
function agreeWithGit(gitignore, probes) {
  const own = ignoreMatcher(gitignore);
  // git also asks about every parent directory: nothing below an ignored directory can be re-included.
  const ignored = (path, isDirectory) =>
    path
      .split('/')
      .slice(0, -1)
      .some((_, i, parts) => own(parts.slice(0, i + 1).join('/'), true)) || own(path, isDirectory);
  const differ = [];
  for (const mode of [true, false]) {
    const { made, ignored: expected } = gitIgnores(
      gitignore,
      probes.filter(([, isDirectory]) => isDirectory === mode),
    );
    assert.ok(made.length >= probes.length / 2 - 10, 'too many probes could not be created');
    for (const [path, isDirectory] of made)
      if (ignored(path, isDirectory) !== expected.has(path))
        differ.push({
          path,
          isDirectory,
          ours: ignored(path, isDirectory),
          git: expected.has(path),
        });
  }
  assert.deepEqual(differ, []);
}

test('the matcher agrees with git on every gitignore pattern shape', () => {
  const lines = [
    'dirname/',
    'bare',
    '*.log',
    'prefix*',
    '/anchored',
    'with/slash',
    'under/*',
    '!under/keep',
    '**/any/',
    'mid/**/tail',
    'inside/**',
    '[lm]class',
    'one?',
    '\\#hash',
    '\\!bang',
    'ends/*.key',
    '!ends/ok.key',
    '*.pem',
    '!ok.pem',
    'anch/o?e',
  ];
  const names = [
    'dirname',
    'bare',
    'x.log',
    'prefix',
    'prefixed',
    'anchored',
    'with/slash',
    'under/a',
    'under/keep',
    'any',
    'p/any',
    'mid/tail',
    'mid/a/tail',
    'mid/a/b/tail',
    'inside/a',
    'lclass',
    'nclass',
    'oneX',
    'one',
    '#hash',
    '!bang',
    'ends/a.key',
    'ends/ok.key',
    'ends/sub/a.key',
    'anch/oxe',
    'anch/o/e',
    'q.pem',
    'ok.pem',
    'sub/anchored',
    'sub/with/slash',
    'sub/dirname',
    'sub/x.log',
    'sub/under/a',
  ];
  const probes = names.flatMap((name) => [
    [name, true],
    [name, false],
    [`deep/${name}`, true],
    [`deep/${name}`, false],
  ]);
  agreeWithGit(lines.join('\n'), probes);
  assert.throws(() => ignoreMatcher('[[:alpha:]]x'), /unsupported/); // a shape it does not know is refused
});

test('the real .gitignore: every line, the review cases, and git itself agree', () => {
  // A probe for every line: its pattern with `*` as nothing and as text, `**` as zero and as two directories.
  const probes = GITIGNORE.split('\n')
    .filter((line) => line && !line.startsWith('#'))
    .flatMap((line) => {
      const base = line.replace(/^!/, '').replace(/^\//, '').replace(/\/$/, '');
      const forms = [
        base.replace(/\*\*\//g, '').replace(/\*/g, ''),
        base.replace(/\*\*\//g, 'p/q/').replace(/\*/g, 'x'),
        base.replace(/\/\*\*?$/, '/x'),
      ];
      return forms.flatMap((form) => [
        [form, true],
        [form, false],
        [`deep/${form}`, true],
        [`deep/${form}`, false],
      ]);
    });
  const named = [
    // the review's cases: build lock + staging, the broker CA, .vscode descendants and its exceptions
    '.next.build-lock',
    '.next.build-lock.receipt-1',
    'apps/web/.next.build-lock',
    'infrastructure/docker/kafka/.tls',
    'x/infrastructure/docker/kafka/.tls',
    'infrastructure/docker/.tls',
    '.vscode',
    '.vscode/settings.json',
    '.vscode/extensions.json',
    '.vscode/settings.example.json',
    'services/a/src/generated',
    'generated',
    'src/generatedx',
    'node_modules/.prisma',
    '.env',
    '.env.example',
    '.env.migrator.example',
    'infrastructure/x/y.example.key',
    'infrastructure/x/y.key',
    'a.log',
    'logs',
  ].flatMap((path) => [
    [path, true],
    [path, false],
  ]);
  agreeWithGit(GITIGNORE, [...probes, ...named]);
  assert.ok(probes.length >= 100, 'no .gitignore patterns found');
  const ignored = ignoreMatcher(GITIGNORE);
  for (const path of [
    '.next.build-lock',
    '.next.build-lock.receipt-1',
    'infrastructure/docker/kafka/.tls',
    'services/a/src/generated',
  ])
    assert.ok(ignored(path, true), `${path} must be ignored`);
  assert.ok(ignored('.vscode/settings.json', false));
  assert.ok(
    !ignored('.vscode/extensions.json', false) &&
      !ignored('.vscode/settings.example.json', false) &&
      !ignored('.vscode', true),
  );
});

test('the inventory of this repository is exactly what git tracks (plus untracked files that are not ignored)', () => {
  const expected = git('ls-files', '-z', '--cached', '--others', '--exclude-standard')
    .split('\0')
    .filter(Boolean)
    .sort();
  assert.deepEqual(authoredFiles(root).map(rel(root)).sort(), expected);
});

// ---------------------------------------------------------------------------------------------
// Directory listing is a CAPABILITY: outside the inventory, any use of it is refused.
// ---------------------------------------------------------------------------------------------
//
// Not "a recursive walker": that is a shape the next spelling escapes (`recursive: deep`, spread or
// quoted options, an alias, a computed key, a variable pattern, `glob`, a method, a helper, a loop).
// The boundary is the capability: the NAME of a listing API however it is imported, aliased or
// reached; an fs module held in a variable whose member is chosen at run time or that is passed on;
// a module the guard cannot resolve (treated as possibly fs); a glob library; code built from text.
// What it cannot follow it refuses (checklist 11). Options and recursion shape do not matter.

const LISTERS = new Set([
  'readdir',
  'readdirSync',
  'opendir',
  'opendirSync',
  'glob',
  'globSync',
  'globIterate',
  'readdirp',
  'scandir',
]);
const FS_MODULE = /^(?:node:)?(?:fs|fs\/promises|fs-extra|graceful-fs)$/;
const LISTING_PACKAGE =
  /^(?:node:)?(?:glob|fast-glob|globby|tinyglobby|readdirp|fdir|klaw|node-dir|recursive-readdir)$/;
const REFLECTIVE_MODULE = /^(?:node:)?vm$/;

// A text with none of these cannot reach a listing API, an fs module or code built from text.
const RELEVANT =
  /readdir|opendir|glob|scandir|\bfs\b|fs\/|\brequire\b|\bimport\s*\(|createRequire|getBuiltinModule|_load|\beval\b|\bFunction\b|\bprocess\b|\bvm\b|klaw|fdir|readdirp/;

function listingCapabilities(file, text) {
  if (!RELEVANT.test(text)) return [];
  const kind = /\.[cm]?jsx?$/.test(file)
    ? ts.ScriptKind.JS
    : file.endsWith('.tsx')
      ? ts.ScriptKind.TSX
      : ts.ScriptKind.TS;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  if (source.parseDiagnostics?.length) return [`${file}: does not parse`];
  const found = [];
  const note = (node, what) =>
    found.push(`${file}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1} ${what}`);
  const strip = (n) => {
    while (
      n &&
      (ts.isParenthesizedExpression(n) ||
        ts.isAsExpression(n) ||
        ts.isNonNullExpression(n) ||
        ts.isAwaitExpression(n) ||
        ts.isSatisfiesExpression?.(n) ||
        ts.isTypeAssertionExpression(n))
    )
      n = n.expression;
    return n;
  };
  const literal = (n) => (n && ts.isStringLiteralLike(n) ? n.text : undefined);
  // names that call require(): `require` and anything built by createRequire(...)
  const requirers = new Set(['require']);
  const all = [];
  const collect = (n) => {
    all.push(n);
    ts.forEachChild(n, collect);
  };
  collect(source);
  for (const n of all)
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.initializer &&
      ts.isCallExpression(strip(n.initializer)) &&
      /^createRequire$/.test(strip(n.initializer).expression.getText())
    )
      requirers.add(n.name.text);
  const memo = new Map();
  const moduleOf = (n) => {
    n = strip(n);
    if (!n || !ts.isCallExpression(n)) return undefined;
    if (memo.has(n)) return memo.get(n);
    const r = moduleOfCall(n);
    memo.set(n, r);
    return r;
  };
  const moduleOfCall = (n) => {
    if (!n || !ts.isCallExpression(n)) return undefined;
    const c = n.expression;
    const isRequire =
      (ts.isIdentifier(c) && requirers.has(c.text)) ||
      c.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isPropertyAccessExpression(c) &&
        /^(?:require|getBuiltinModule|_load)$/.test(c.name.text));
    if (!isRequire) return undefined;
    return literal(n.arguments[0]) ?? null; // null: the module cannot be resolved
  };

  // fs handles: bindings that hold a whole fs module
  const handles = new Set();
  const holds = (n) => {
    n = strip(n);
    if (!n) return false;
    if (ts.isIdentifier(n)) return handles.has(n.text);
    const m = moduleOf(n);
    if (m !== undefined) return m === null || FS_MODULE.test(m); // unresolved: may be fs
    if (ts.isPropertyAccessExpression(n))
      return ['promises', 'default'].includes(n.name.text) && holds(n.expression);
    if (ts.isElementAccessExpression(n))
      return holds(n.expression) && !literal(n.argumentExpression);
    if (ts.isConditionalExpression(n)) return holds(n.whenTrue) || holds(n.whenFalse);
    if (ts.isBinaryExpression(n))
      return [
        ts.SyntaxKind.BarBarToken,
        ts.SyntaxKind.QuestionQuestionToken,
        ts.SyntaxKind.AmpersandAmpersandToken,
        ts.SyntaxKind.CommaToken,
      ].includes(n.operatorToken.kind)
        ? holds(n.left) || holds(n.right)
        : false;
    return false;
  };
  let grew = true;
  const take = (name) => {
    if (ts.isIdentifier(name) && !handles.has(name.text)) {
      handles.add(name.text);
      grew = true;
    }
  };
  const destructure = (pattern) => {
    for (const el of pattern.elements) {
      if (ts.isOmittedExpression(el)) continue;
      if (el.dotDotDotToken) take(el.name);
      else if (ts.isObjectBindingPattern(pattern)) {
        const key = el.propertyName ?? el.name;
        if (ts.isComputedPropertyName(key) && !literal(key.expression))
          note(el, 'computed key read from an fs module');
        else if (['promises', 'default'].includes(key.text ?? literal(key.expression)))
          take(el.name);
      }
    }
  };
  const binders = all.filter(
    (n) =>
      ts.isImportDeclaration(n) ||
      ts.isImportEqualsDeclaration(n) ||
      (ts.isVariableDeclaration(n) && n.initializer) ||
      (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken),
  );
  while (grew) {
    grew = false;
    for (const n of binders) {
      if (ts.isImportDeclaration(n) && n.importClause && FS_MODULE.test(n.moduleSpecifier.text)) {
        const { name, namedBindings } = n.importClause;
        if (name) take(name);
        if (namedBindings && ts.isNamespaceImport(namedBindings)) take(namedBindings.name);
        if (namedBindings && ts.isNamedImports(namedBindings))
          for (const s of namedBindings.elements)
            if (['promises', 'default'].includes((s.propertyName ?? s.name).text)) take(s.name);
      } else if (
        ts.isImportEqualsDeclaration(n) &&
        ts.isExternalModuleReference(n.moduleReference) &&
        FS_MODULE.test(literal(n.moduleReference.expression) ?? '')
      )
        take(n.name);
      else if (ts.isVariableDeclaration(n) && n.initializer && holds(n.initializer)) {
        if (ts.isObjectBindingPattern(n.name)) destructure(n.name);
        else take(n.name);
      } else if (
        ts.isBinaryExpression(n) &&
        n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        holds(n.right)
      )
        take(n.left);
    }
  }

  for (const n of all) {
    if (n.kind === ts.SyntaxKind.EndOfFileToken) continue;
    // 1. the NAME of a listing API, however it is imported, aliased or reached
    if ((ts.isIdentifier(n) || ts.isPrivateIdentifier(n)) && LISTERS.has(n.text.replace(/^#/, '')))
      note(n, `names the directory-listing API ${n.text}`);
    else if (ts.isStringLiteralLike(n) && LISTERS.has(n.text) && !ts.isImportDeclaration(n.parent))
      note(n, `names the directory-listing API '${n.text}'`);
    // 2. modules
    const m = ts.isCallExpression(n) ? moduleOf(n) : undefined;
    if (m !== undefined && m !== null && (LISTING_PACKAGE.test(m) || REFLECTIVE_MODULE.test(m)))
      note(n, `loads ${m}`);
    if (m !== undefined && (m === null || FS_MODULE.test(m))) {
      let use = n;
      while (
        ts.isParenthesizedExpression(use.parent) ||
        ts.isAsExpression(use.parent) ||
        ts.isNonNullExpression(use.parent) ||
        ts.isAwaitExpression(use.parent)
      )
        use = use.parent;
      const p = use.parent;
      const safe =
        ts.isExpressionStatement(p) ||
        (ts.isPropertyAccessExpression(p) && p.expression === use && p.name.text !== 'then') ||
        (ts.isElementAccessExpression(p) &&
          p.expression === use &&
          literal(p.argumentExpression)) ||
        (ts.isVariableDeclaration(p) &&
          p.initializer === use &&
          !ts.isObjectBindingPattern(p.name)) ||
        (ts.isVariableDeclaration(p) &&
          p.initializer === use &&
          ts.isObjectBindingPattern(p.name)) ||
        (ts.isBinaryExpression(p) &&
          p.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          p.right === use);
      if (!safe) note(n, 'a loaded module is passed on where the guard cannot follow it');
    }
    if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) {
      const spec = n.moduleSpecifier?.text;
      if (spec && (LISTING_PACKAGE.test(spec) || REFLECTIVE_MODULE.test(spec)))
        note(n, `imports ${spec}`);
      if (
        spec &&
        /^(?:node:)?module$/.test(spec) &&
        !(
          ts.isImportDeclaration(n) &&
          n.importClause?.namedBindings &&
          ts.isNamedImports(n.importClause.namedBindings) &&
          !n.importClause.name &&
          n.importClause.namedBindings.elements.every((e) =>
            ['createRequire', 'builtinModules', 'isBuiltin', 'syncBuiltinESMExports'].includes(
              (e.propertyName ?? e.name).text,
            ),
          )
        )
      )
        note(n, 'imports node:module as a whole');
    }
    // 3. code from text, process internals
    if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
      const c = n.expression;
      if (ts.isIdentifier(c) && (c.text === 'eval' || c.text === 'Function'))
        note(n, `builds code from text (${c.text})`);
    }
    if (
      ts.isPropertyAccessExpression(n) &&
      /^(?:binding|dlopen|mainModule)$/.test(n.name.text) &&
      /^(?:process|globalThis\.process|global\.process)$/.test(n.expression.getText())
    )
      note(n, 'reaches Node internals through process');
    // 4. an fs handle the guard cannot follow
    if (ts.isIdentifier(n) && handles.has(n.text)) {
      const p = n.parent;
      const declared =
        (ts.isImportClause(p) ||
          ts.isNamespaceImport(p) ||
          ts.isImportSpecifier(p) ||
          ts.isVariableDeclaration(p) ||
          ts.isBindingElement(p) ||
          ts.isParameter(p) ||
          ts.isImportEqualsDeclaration(p)) &&
        p.name === n;
      const member =
        (ts.isPropertyAccessExpression(p) && p.expression === n) ||
        (ts.isElementAccessExpression(p) && p.expression === n && literal(p.argumentExpression)) ||
        ts.isTypeQueryNode(p);
      const aliased =
        (ts.isVariableDeclaration(p) && p.initializer === n && ts.isIdentifier(p.name)) ||
        (ts.isBinaryExpression(p) &&
          p.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          p.right === n &&
          ts.isIdentifier(p.left));
      const named =
        (ts.isPropertyAccessExpression(p) && p.name === n) ||
        (ts.isPropertyAssignment(p) && p.name === n) ||
        (ts.isBinaryExpression(p) && p.left === n) ||
        ts.isQualifiedName(p) ||
        ts.isTypeReferenceNode(p);
      if (!declared && !member && !aliased && !named)
        note(n, `fs handle ${n.text} used in a way the guard cannot follow`);
    }
  }
  return [...new Set(found)];
}

const REFUSED = {
  'recursive: deep':
    "import { readdirSync } from 'node:fs'; const deep = true; readdirSync(d, { recursive: deep });",
  'spread options':
    "import fs from 'node:fs'; const o = { recursive: true }; fs.readdirSync(d, { ...o });",
  'quoted recursive key': "import fs from 'node:fs'; fs.readdirSync(d, { 'recursive': true });",
  'computed reader name': "import fs from 'node:fs'; fs['read' + 'dirSync'](d);",
  'computed reader variable': "import fs from 'node:fs'; const k = 'readdirSync'; fs[k](d);",
  'string reader key': "import fs from 'node:fs'; fs['readdirSync'](d);",
  'imported alias': "import { readdirSync as list } from 'node:fs'; list(d, { recursive: true });",
  'required alias': "const { readdirSync: list } = require('node:fs'); list(d);",
  'computed destructuring': "const fs = require('node:fs'); const { [k]: list } = fs; list(d);",
  'variable glob pattern': "import { globSync } from 'node:fs'; globSync(pattern);",
  'async native glob':
    "import { glob } from 'node:fs/promises'; for await (const f of glob('**/*.ts')) f;",
  'fs.promises.readdir':
    "import fs from 'node:fs'; await fs.promises.readdir(d, { recursive: true });",
  opendir: "import { opendirSync } from 'node:fs'; opendirSync(d);",
  'class-method recursion':
    'class W { walk(d) { return fs.readdirSync(d).flatMap((n) => this.walk(n)); } }',
  'recursion through a helper':
    'const ls = (d) => readdirSync(d); const w = (d) => ls(d).flatMap(w);',
  'iterative traversal':
    'const todo = [root]; while (todo.length) for (const e of readdirSync(todo.pop())) todo.push(e);',
  'fs held in a variable and passed on': "import fs from 'node:fs'; use(fs);",
  'fs spread into an object': "import fs from 'node:fs'; const copy = { ...fs }; copy[k](d);",
  'fs read by Reflect': "import * as fs from 'node:fs'; Reflect.get(fs, k)(d);",
  'fs behind an alias, computed member': "const fs = require('node:fs'); const f = fs; f[k](d);",
  'fs required by a created require':
    "import { createRequire } from 'node:module'; const r = createRequire(url); const f = r('node:fs'); f[k](d);",
  'module chosen at run time': 'const m = await import(name); m[k](d);',
  'module passed on': "list(require('node:fs'));",
  'fs aliased by assignment': "import fs from 'node:fs'; let f; f = fs; f[k](d);",
  'computed key from a required module': "const { [k]: list } = require('node:fs'); list(d);",
  'fs chosen by a condition': "import fs from 'node:fs'; (pick ? fs : other)[k](d);",
  getBuiltinModule: "const f = process.getBuiltinModule('fs'); f[k](d);",
  'module.constructor._load': "const f = module.constructor._load('fs'); f[k](d);",
  'required glob library': "const g = require('tinyglobby'); g.x(p);",
  'imported glob library': "const g = await import('fast-glob'); g.x(p);",
  'then on a loaded module': "import('node:fs').then((m) => m[k](d));",
  'glob library': "import { globSync } from 'glob'; globSync(p);",
  'fast-glob': "import fg from 'fast-glob'; fg(p);",
  'code built from text': 'eval("require(\'node:fs\')");',
  'Function constructor': "new Function('return process')();",
  'process internals': "process.binding('fs');",
  'delegated through an injected reader': 'run({ readdir: (d) => list(d) });',
  'does not parse': 'process.argv.slice(;',
};
const ACCEPTED = {
  'reads files': "import { readFileSync } from 'node:fs'; readFileSync(p, 'utf8');",
  'members by name':
    "import fs from 'node:fs'; fs.readFileSync(p); await fs.promises.readFile(p); fs['statSync'](p);",
  'the inventory':
    "const { authoredFiles } = require('./authored-source-inventory.cjs'); authoredFiles(d);",
  'array and record indexing': 'const a = []; a[i]; rec[k];',
  'a comment names it': '// readdirSync(d, { recursive: true })\nconst s = 1;',
  'a literal path': "const page = require('./page');",
};
/** Files with a capability that are not allow-listed, and allow-listed files that no longer have one. */
function unlisted(found, allowed) {
  return Object.keys(found).filter((file) => !allowed.has(file));
}
function stale(found, allowed) {
  return [...allowed].filter((file) => !found[file]);
}

test('the detector refuses every way to reach a directory listing and accepts plain file reads', () => {
  for (const [name, code] of Object.entries(REFUSED))
    assert.notEqual(listingCapabilities('x.mjs', code).length, 0, `not refused: ${name}`);
  for (const [name, code] of Object.entries(ACCEPTED))
    assert.deepEqual(listingCapabilities('x.mjs', code), [], `refused: ${name}`);
  assert.notEqual(
    listingCapabilities('x.ts', 'const x: number = readdirSync(d).length;').length,
    0,
  );
});

/**
 * Files that use a directory-listing API (or hold an fs module the guard cannot follow) and predate
 * the inventory. Each only shrinks: moving a file onto `authoredFiles` removes its line, and a file
 * anywhere else fails the scan below. Generated output exists only under `services/<name>/src/generated`,
 * so a lister is out of reach of the race when it prunes `generated` BY NAME before it opens
 * anything (PRUNE_BY_NAME), or lists a tree that cannot contain it (NO_GENERATED_TREE). Follow-up
 * (FU-102): migrate them and drop the lists.
 */
const PRUNE_BY_NAME = [
  'apps/web/src/test/turbo-inputs-guard.ts',
  'packages/contracts/src/events/topic-consumers.repo.spec.ts',
  'packages/nest-common/src/kafka/log-creator.spec.ts',
  'packages/nest-common/src/tenancy/raw-sql-inventory.spec.ts',
  'scripts/check-service-boundaries-lib.mjs',
  'scripts/eligibility-clock-derive.mjs',
  'scripts/url-parsing-guard-lib.mjs',
  'services/audit-service/test/authorization.int-spec.ts',
  'services/construction-service/src/shared/idempotency-forget.spec.ts',
  'services/identity-service/src/prisma/transaction-boundary.spec.ts',
];
const NO_GENERATED_TREE = [
  'apps/web/src/app/select-reset.spec.tsx',
  'apps/web/src/app/suppliers/supplier-persian.spec.tsx',
  'apps/web/src/app/theme-switch-coverage.spec.tsx',
  'apps/web/src/design-tokens.spec.ts',
  'apps/web/src/e2e-server-reuse.spec.ts',
  'apps/web/src/lib/form-issues.spec.ts',
  'apps/web/src/lib/form-message-trust.spec.ts',
  'apps/web/src/lib/id-hints.spec.ts',
  'apps/web/src/server/page-context.spec.ts',
  'apps/web/src/server/session-organization.spec.ts',
  'apps/web/src/test/fenced-form-guard.ts',
  'apps/web/src/test/module-discovery.ts',
  'apps/web/src/test/orthography-scan.ts',
  'apps/web/src/test/server-action-discovery.ts',
  'apps/web/src/ui/layout/layout-guards.spec.ts',
  'packages/contracts/src/common/__tests__/zod-stock-oracle.ts',
  'packages/contracts/src/common/zod-authorship.spec.ts',
  'packages/observability/src/diagnostics.spec.ts',
  'scripts/aggregation-campaign-accounting.test.mjs',
  'scripts/aggregation-campaign-command-card.test.mjs',
  'scripts/aggregation-campaign-image-cohort.test.mjs',
  'scripts/aggregation-campaign-log-recovery.test.mjs',
  'scripts/aggregation-campaign-post-run-rehearsal.test.mjs',
  'scripts/aggregation-campaign-retrieval-comparison.test.mjs',
  'scripts/check-dockerfile-pins.mjs',
  'scripts/check-unit-step-concurrency.mjs',
  'scripts/outbox-b2-lib.test.mjs',
];
// Covers generated output ON PURPOSE (the image tree and tool directories) with a race-safe retry;
// its test passes the options through a fault-injecting readdir that makes the race happen.
const COVERS_GENERATED_ON_PURPOSE = [
  'scripts/testing-dev-only.mjs',
  'scripts/testing-dev-only.test.mjs',
  'scripts/testing-dev-only-source.mjs',
];
// Found by the capability scan (FU-102 r2): they list directories one level at a time, inject or
// replace a reader to test a fault, or load a module chosen at run time. The old recursion-only
// scan did not see them; none is known to open generated output, and none is reviewed one by one.
const OTHER_CAPABILITY = [
  'apps/web/scripts/build-lock.mjs',
  'apps/web/scripts/build-run.mjs',
  'apps/web/src/server-action-build-binding.spec.ts',
  'apps/web/src/server-action-build-ownership.spec.ts',
  'apps/web/src/test/server-action-boundary.ts',
  'apps/web/src/write-session-refusal.spec.ts',
  'packages/config/src/owner-credentials.spec.ts',
  'packages/contracts/src/common/legacy-refusal-boundary.spec.ts',
  'packages/contracts/src/common/zod-compat-patch.spec.ts',
  'packages/nest-common/src/logging/nest-logger.spec.ts',
  'packages/testing/src/tenant-scope-registration.spec.ts',
  'scripts/aggregation-campaign-log-recovery.mjs',
  'scripts/aggregation-campaign-preflight.test.mjs',
  'scripts/aggregation-evidence-cli.test.mjs',
  'scripts/backup-restore-drill-cli.test.mjs',
  'scripts/backup-restore-drill-fault.mjs',
  'scripts/backup-restore-drill-lib.mjs',
  'scripts/backup-restore-drill-recovery.mjs',
  'scripts/backup-restore-drill-recovery.test.mjs',
  'scripts/backup-restore-drill.test.mjs',
  'scripts/backup-restore-drill-test-support.mjs',
  'scripts/backup-restore-drill-workflow.test.mjs',
  'scripts/check-db-runtime-privileges-lib.test.mjs',
  'scripts/check-db-runtime-privileges.pg.test.mjs',
  'scripts/check-grafana-dashboard-lib.mjs',
  'scripts/check-tenant-index-order-lib.mjs',
  'scripts/check-test-phases.mjs',
  'scripts/ci-integration-split-lib.mjs',
  'scripts/ci-trivy-db-lib.mjs',
  'scripts/ci-trivy-db.test.mjs',
  'scripts/container-scope.mjs',
  'scripts/container-scope.test.mjs',
  'scripts/database-services.mjs',
  'scripts/database-turbo-env.test.mjs',
  'scripts/db-pool-config.pg.test.mjs',
  'scripts/db-session-utc.pg.test.mjs',
  'scripts/disclosure-guard-wiring.test.mjs',
  'scripts/exchange-deadline-rule.test.mjs',
  'scripts/internal-token-source-workspace.test.mjs',
  'scripts/kafka-outbox-tables.mjs',
  'scripts/lint-scripts-registration.test.mjs',
  'scripts/outbox-purge-turbo-env.test.mjs',
  'scripts/outbox-test-clock.test.mjs',
  'scripts/replay-dlq.broker.test.mjs',
  'scripts/service-boot-guard.test.mjs',
  'scripts/service-dev-loader.test.mjs',
  'scripts/service-env-turbo.test.mjs',
  'scripts/service-telemetry-order.test.mjs',
  'scripts/supplier-privilege-split.pg.test.mjs',
  'scripts/turbo-env-lib.mjs',
  'scripts/verify-audit-correction-command-lib.test.mjs',
  'scripts/verify-audit-correction-command-migration.mjs',
  'scripts/verify-migration-reversible-lib.test.mjs',
  'scripts/verify-migration-reversible.mjs',
  'scripts/verify-outbox-claim-migration.mjs',
  'scripts/verify-seed-guard.mjs',
  'services/contract-service/test/migration-rollback.int-spec.ts',
  'services/document-service/test/instants-timestamptz.int-spec.ts',
  'services/economic-service/src/prisma/test-mutation-scope.spec.ts',
  'services/fleet-service/test/ownership-generation-rollback.int-spec.ts',
  'tests/e2e/src/expect.test.ts',
];
const LISTING_ALLOWED = new Set([
  ...PRUNE_BY_NAME,
  ...NO_GENERATED_TREE,
  ...COVERS_GENERATED_ON_PURPOSE,
  ...OTHER_CAPABILITY,
]);

const trackedSources = () =>
  git('ls-files', '-z')
    .split('\0')
    .filter(
      (file) =>
        /\.(?:[cm]?[jt]sx?)$/.test(file) &&
        file !== INVENTORY &&
        file !== 'scripts/authored-source-inventory.test.mjs',
    );

test('a directory-listing capability outside the inventory is refused unless the file is allow-listed', () => {
  const found = {};
  for (const file of trackedSources()) {
    const capabilities = listingCapabilities(file, fs.readFileSync(join(root, file), 'utf8'));
    if (capabilities.length > 0) found[file] = capabilities;
  }
  assert.deepEqual(
    unlisted(found, LISTING_ALLOWED).flatMap((file) => found[file]),
    [],
    'enumerate files with authoredFiles() from scripts/authored-source-inventory.cjs (it never opens ' +
      'generated output, which another task may be regenerating); a lister of your own races with it',
  );
  assert.deepEqual(
    stale(found, LISTING_ALLOWED),
    [],
    'no longer lists directories: remove it from the allow-list',
  );
  assert.equal(
    LISTING_ALLOWED.size,
    10 + NO_GENERATED_TREE.length + 3 + OTHER_CAPABILITY.length,
    'a file is listed twice',
  );
  // The walker #741 delegates to (scripts/testing-dev-only-source.mjs) is seen like any other.
  assert.notEqual(
    listingCapabilities(
      'scripts/testing-dev-only-source.mjs',
      fs.readFileSync(join(root, 'scripts/testing-dev-only-source.mjs'), 'utf8'),
    ).length,
    0,
  );
});

// The walkers this change converted, and how many listing-API names each still has (a one-level
// listing beside the inventory call). A reverted conversion brings its raw walker back: more names.
const CONVERTED = {
  'scripts/disclosure-guard-wiring.test.mjs': 0,
  'scripts/db-pool-config.pg.test.mjs': 2,
  'scripts/service-boot-guard.test.mjs': 2,
  'scripts/check-test-phases.mjs': 2,
  'scripts/outbox-test-clock.test.mjs': 2,
  'scripts/verify-migration-reversible-lib.test.mjs': 8,
  'packages/contracts/src/common/legacy-refusal-boundary.spec.ts': 3,
  'packages/contracts/src/common/zod-compat-patch.spec.ts': 2,
  'services/audit-service/test/append-only.int-spec.ts': 0,
  'services/procurement-service/src/shared/body-parser.spec.ts': 0,
  'packages/testing/src/key-readers.ts': 0,
  'scripts/marketplace-saga-drain-check.test.mjs': 0,
};
test('the allow-list refuses an unlisted file and a listed file that no longer lists', () => {
  const allowed = new Set(['old.mjs', 'gone.mjs']);
  assert.deepEqual(unlisted({ 'old.mjs': ['w'] }, allowed), []);
  assert.deepEqual(unlisted({ 'new.mjs': ['w'], 'old.mjs': ['w'] }, allowed), ['new.mjs']);
  assert.deepEqual(stale({ 'old.mjs': ['w'] }, allowed), ['gone.mjs']);
});

test('the rule is still enforced on the walkers this change converted', () => {
  for (const [file, names] of Object.entries(CONVERTED)) {
    const text = fs.readFileSync(join(root, file), 'utf8');
    assert.match(text, /authored-source-inventory\.cjs/, `${file} does not use the inventory`);
    assert.equal(
      listingCapabilities(file, text).filter((what) => /directory-listing API/.test(what)).length,
      names,
      `${file} lists directories itself`,
    );
  }
});

/** Does the CODE compare against, or list, the name `generated`? A comment that still says so does not count. */
function codeNamesGenerated(file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  let found = false;
  const visit = (node) => {
    if (ts.isStringLiteralLike(node) && node.text === 'generated') {
      const p = node.parent;
      found ||=
        ts.isArrayLiteralExpression(p) ||
        ts.isCaseClause(p) ||
        (ts.isBinaryExpression(p) && /^[!=]==?$/.test(p.operatorToken.getText()));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}
test('the walkers that prune by name name generated in code (the behavioural check is the follow-up)', () => {
  for (const file of PRUNE_BY_NAME)
    assert.ok(
      codeNamesGenerated(file, fs.readFileSync(join(root, file), 'utf8')),
      `${file} does not prune generated`,
    );
  assert.ok(
    !codeNamesGenerated(
      'x.ts',
      "for (const n of ls) { // 'generated'\n if (n === 'dist') continue; }",
    ),
  );
  assert.ok(!codeNamesGenerated('x.ts', "log('generated'); if (n === 'dist') continue;"));
  assert.ok(
    codeNamesGenerated(
      'x.ts',
      "if (['a', 'generated'].includes(n)) continue; if (n !== 'generated') walk(n);",
    ),
  );
});
