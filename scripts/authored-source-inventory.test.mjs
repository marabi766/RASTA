// The shared authored-source inventory and the guard that keeps directory listing on it (FU-102).
//
// Git-ignored output (`generated` Prisma clients, `node_modules`, build output, `.next.build-lock*`)
// is rewritten by other tasks while a check runs. A walker that lists such a directory and reads it
// afterwards dies with ENOENT on a file nobody wrote (PR #741 F1/F2). `authored-source-inventory.cjs`
// never opens it, by ONE policy: the repository's .gitignore. The second half of this file refuses
// every other use of a directory-listing API.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { authoredFiles } from './authored-source-inventory.cjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const INVENTORY = 'scripts/authored-source-inventory.cjs';
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
const rel = (dir) => (path) => relative(dir, path);

const unblocked = process.getuid?.() === 0; // root opens a mode-000 directory, so there nothing is proved
const lock = (dir, directories, mode) => {
  for (const d of directories) fs.chmodSync(join(dir, d), mode);
};

test('lists authored files, sorted, and never opens an ignored directory (every .gitignore pattern shape)', () => {
  const dir = fixture();
  try {
    // An ignored directory nobody may open: the listing succeeds only if it never tries.
    lock(dir, IGNORED_DIRECTORIES, 0o000);
    const result = authoredFiles(dir);
    assert.deepEqual(
      result.map(rel(dir)),
      [...AUTHORED].sort(),
      'authored files, ignored ones left out',
    );
    if (!unblocked) {
      // ...and the same walk over an AUTHORED directory nobody may open is a real fault.
      fs.chmodSync(join(dir, 'b', 'd'), 0o000);
      assert.throws(() => authoredFiles(dir), /git ls-files failed/);
      assert.throws(() => authoredFiles(dir, { optional: true }), /git ls-files failed/);
      fs.chmodSync(join(dir, 'b', 'd'), 0o755);
    }
  } finally {
    lock(dir, IGNORED_DIRECTORIES, 0o755);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the order, skip, optional, base, links and a nested repository', () => {
  const dir = fixture();
  try {
    // A depth-first walk that sorts each directory by name: the directory `a` comes before `a-b`.
    for (const file of ['o/a.b/x', 'o/a/x', 'o/a-b']) {
      fs.mkdirSync(dirname(join(dir, file)), { recursive: true });
      fs.writeFileSync(join(dir, file), 'x');
    }
    assert.deepEqual(authoredFiles(join(dir, 'o')).map(rel(join(dir, 'o'))), [
      'a/x',
      'a-b',
      'a.b/x',
    ]);
    const skipped = authoredFiles(dir, { skip: (name) => name === 'd' });
    assert.ok(!skipped.some((path) => path.endsWith('e.mjs')));
    assert.ok(
      authoredFiles(dir, { skip: (name) => name === 'c.ts' }).every((p) => !p.endsWith('c.ts')),
    );
    // A root whose name holds glob characters (or looks like pathspec magic) is that directory only.
    for (const odd of ['we[ir]d*', 'weird1', ':(top).env']) {
      fs.mkdirSync(join(dir, odd), { recursive: true });
      fs.writeFileSync(join(dir, odd, `${odd.length}.ts`), 'x');
    }
    for (const odd of ['we[ir]d*', ':(top).env'])
      assert.deepEqual(authoredFiles(join(dir, odd), { base: dir }).map(rel(join(dir, odd))), [
        `${odd.length}.ts`,
      ]);
    // only names BELOW the root are skipped: the root itself and what holds it are not
    assert.equal(
      authoredFiles(join(dir, 'b'), { base: dir, skip: (name) => name === 'b' }).length,
      2,
    );
    assert.throws(() => authoredFiles(join(dir, 'absent')), { code: 'ENOENT' });
    assert.deepEqual(authoredFiles(join(dir, 'absent'), { optional: true }), []);
    assert.throws(() => authoredFiles(join(dir, 'a.ts'), { optional: true }), { code: 'ENOTDIR' });
    // The policy is the repository's .gitignore: an unreadable one refuses, it does not ignore nothing.
    const real = fs.accessSync;
    fs.accessSync = (path, ...rest) => {
      if (String(path).endsWith('.gitignore'))
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      return real(path, ...rest);
    };
    try {
      assert.throws(() => authoredFiles(dir), { code: 'EACCES' });
    } finally {
      fs.accessSync = real;
    }
    // A linked directory is not a file and is not entered (a linked node_modules is never opened).
    fs.symlinkSync(join(dir, 'b'), join(dir, 'node_modules'));
    fs.symlinkSync(join(dir, 'b'), join(dir, 'linked'));
    const listed = authoredFiles(dir).map(rel(dir));
    assert.ok(!listed.includes('node_modules') && !listed.includes('linked'));
    assert.ok(!listed.some((path) => path.startsWith('linked/')));
    // A walk that starts below the base still judges paths from it: `src/generated` is ignored
    // although the walk starts in `src` (a root outside the repository names its base).
    fs.mkdirSync(join(dir, 'tree/src/generated/deep'), { recursive: true });
    fs.writeFileSync(join(dir, 'tree/src/app.ts'), 'x');
    fs.writeFileSync(join(dir, 'tree/src/generated/deep/f'), 'x');
    assert.deepEqual(
      authoredFiles(join(dir, 'tree/src'), { base: join(dir, 'tree') }).map(rel(dir)),
      ['tree/src/app.ts'],
    );
    assert.throws(
      () => authoredFiles(join(dir, 'b'), { base: join(dir, 'tree') }),
      /not inside its base/,
    );
    // ...and so is a root that is itself ignored output: nobody asks for the authored files of it.
    assert.throws(
      () => authoredFiles(join(dir, 'tree/src/generated'), { base: join(dir, 'tree') }),
      { code: 'EIGNORED' },
    );
    assert.throws(() => authoredFiles(join(root, 'services/audit-service/src/generated')), {
      code: 'EIGNORED',
    });
    // A repository inside the tree is not listed file by file: refused, never guessed.
    execFileSync('git', ['init', '-q', join(dir, 'tree/inner')]);
    fs.writeFileSync(join(dir, 'tree/inner/f.ts'), 'x');
    assert.throws(() => authoredFiles(join(dir, 'tree')), /nested repository/);
    // A caller's own git environment (a hook runs with GIT_DIR set) does not redirect the listing.
    const before = authoredFiles(join(root, 'scripts'));
    const saved = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE };
    process.env.GIT_DIR = join(dir, 'nowhere');
    process.env.GIT_WORK_TREE = join(dir, 'nowhere');
    try {
      assert.deepEqual(authoredFiles(join(root, 'scripts')), before);
    } finally {
      for (const [name, value] of Object.entries(saved))
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a tree with its own repository: tracked files count, a deleted tracked file does not', () => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'authored-repo-'));
  try {
    const run = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' });
    run('init', '-q');
    for (const file of ['keep.ts', 'gone.ts', 'src/generated/tracked.ts', 'src/app.ts']) {
      fs.mkdirSync(dirname(join(dir, file)), { recursive: true });
      fs.writeFileSync(join(dir, file), 'x');
    }
    run('add', '-f', '.');
    run('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'x');
    fs.rmSync(join(dir, 'gone.ts'));
    fs.writeFileSync(join(dir, 'new.ts'), 'x'); // untracked, not ignored
    fs.mkdirSync(join(dir, 'src/generated/more'), { recursive: true });
    fs.writeFileSync(join(dir, 'src/generated/more/untracked.ts'), 'x'); // untracked, ignored
    assert.deepEqual(authoredFiles(dir).map(rel(dir)), [
      'keep.ts',
      'new.ts',
      'src/app.ts',
      'src/generated/tracked.ts', // tracked: authored, whatever the policy says
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------
// ONE exclusion policy, and git itself applies it: no pattern matcher of our own to disagree.
// ---------------------------------------------------------------------------------------------
//
// A hand matcher disagreed with git on UTF-8 names (git reads bytes), newlines in paths, a BOM, a
// final CR and `!` re-inclusion below `**` (PR #772 r1 F3). The inventory takes git's own answer.
// Each row is [.gitignore text, a path, is it ignored?]: the answers were read from git itself.

/** Authored files of a temporary tree with this `.gitignore` and these paths, relative to it. */
function listing(policy, paths) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'authored-oracle-'));
  try {
    fs.writeFileSync(join(dir, '.gitignore'), policy);
    for (const path of paths) {
      fs.mkdirSync(dirname(join(dir, path)), { recursive: true });
      fs.writeFileSync(join(dir, path), 'x');
    }
    return authoredFiles(dir).map(rel(dir)).sort();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
/** What `git ls-files --cached --others --exclude-standard -z` says in a real repository. */
function oracle(policy, paths) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'authored-oracle-git-'));
  try {
    execFileSync('git', ['init', '-q', dir]);
    fs.writeFileSync(join(dir, '.gitignore'), policy);
    for (const path of paths) {
      fs.mkdirSync(dirname(join(dir, path)), { recursive: true });
      fs.writeFileSync(join(dir, path), 'x');
    }
    return execFileSync(
      'git',
      [
        '-C',
        dir,
        '-c',
        'core.excludesFile=/dev/null',
        'ls-files',
        '-z',
        '-co',
        '--exclude-standard',
      ],
      { encoding: 'utf8' },
    )
      .split('\0')
      .filter(Boolean)
      .sort();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('the inventory is git itself: the reviewer oracle table (UTF-8, newlines, re-inclusion below **)', () => {
  const rows = [
    ['q/??\n', 'q/é', true], // two bytes
    ['q/?x\n', 'q/éx', false],
    ['q/[!a]\n', 'q/é', false],
    ['q/**\n', 'q/a\nb', true], // a newline in a name
    ['q/**/x\n', 'q/a\nb/x', true],
    ['q/**\n!q/a/\n', 'q/a/b', true], // re-including the parent does not re-include what `q/**` names
    ['q/*\n!q/a/\n', 'q/a/b', false], // ...but with `*` the parent decides
    ['q/*\n', 'q/a/b', true],
    ['*.log\n!keep.log\n', 'keep.log', false],
    ['dir/\n', 'dir', false], // a FILE named like a directory pattern is not ignored
  ];
  for (const [policy, path, ignored] of rows)
    assert.equal(
      listing(policy, [path]).includes(path),
      !ignored,
      `${JSON.stringify(policy)} ${JSON.stringify(path)}`,
    );
});

test('the inventory equals git on BOM, CRLF, a final CR, NUL and spacing edges', () => {
  const policies = [
    '\uFEFFq/x\n',
    'q/x\r\n',
    'q/x\r',
    'q/x\n\r\n!q/y\r\n',
    'q/x\0y\nq/z\n',
    'q/a**/z\n',
    'q/**a\n',
    'q/x \n',
    'q/x\\ \n',
    '\\#q\n#q\n',
    'q/é\n',
    'q/[é]\n',
    'q/[[:alpha:]]x\n',
  ];
  const paths = [
    'q/x',
    'q/y',
    'q/z',
    'q/é',
    'q/e',
    'q/ax',
    'q/a/b/z',
    'q/ab/z',
    'q/aa',
    '#q',
    'q/x ',
  ];
  for (const policy of policies)
    assert.deepEqual(listing(policy, paths), oracle(policy, paths), JSON.stringify(policy));
});

test('a name that is not UTF-8 is refused, never mangled', () => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'authored-bytes-'));
  try {
    fs.writeFileSync(join(dir, 'ok.ts'), 'x');
    fs.writeFileSync(Buffer.concat([Buffer.from(`${dir}/q`), Buffer.from([0xff])]), 'x');
    assert.throws(() => authoredFiles(dir), { name: 'TypeError' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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
  /\\u|readdir|opendir|glob|scandir|\bfs\b|fs\/|\brequire\b|\bimport\s*\(|createRequire|getBuiltinModule|_load|\beval\b|\bFunction\b|\bprocess\b|\bvm\b|klaw|fdir|readdirp/;

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
  const memberName = (n) =>
    ts.isPropertyAccessExpression(n)
      ? n.name.text
      : ts.isElementAccessExpression(n)
        ? literal(n.argumentExpression)
        : undefined;
  // names that call require(): `require`, anything built by createRequire(...), and aliases of either
  const requirers = new Set(['require']);
  const factories = new Set(['createRequire']);
  const all = [];
  const collect = (n) => {
    all.push(n);
    ts.forEachChild(n, collect);
  };
  collect(source);
  const factoryCall = (n) =>
    n &&
    ts.isCallExpression(n) &&
    ((ts.isIdentifier(n.expression) && factories.has(n.expression.text)) ||
      memberName(strip(n.expression)) === 'createRequire');
  for (let size = -1; size !== requirers.size + factories.size;) {
    size = requirers.size + factories.size;
    for (const n of all) {
      if (ts.isImportSpecifier(n) && (n.propertyName ?? n.name).text === 'createRequire')
        factories.add(n.name.text);
      else if (
        ts.isBindingElement(n) &&
        ts.isIdentifier(n.name) &&
        (n.propertyName ?? n.name).text === 'createRequire'
      )
        factories.add(n.name.text);
      const bound = ts.isVariableDeclaration(n)
        ? [n.name, n.initializer]
        : ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken
          ? [n.left, n.right]
          : [];
      const init = strip(bound[1]);
      if (!init || !bound[0] || !ts.isIdentifier(bound[0])) continue;
      if (factoryCall(init) || (ts.isIdentifier(init) && requirers.has(init.text)))
        requirers.add(bound[0].text);
      else if (
        (ts.isIdentifier(init) && factories.has(init.text)) ||
        memberName(init) === 'createRequire'
      )
        factories.add(bound[0].text);
    }
  }
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
      factoryCall(strip(c)) ||
      c.kind === ts.SyntaxKind.ImportKeyword ||
      /^(?:require|getBuiltinModule|_load)$/.test(memberName(strip(c)) ?? '');
    if (!isRequire) return undefined;
    const specifier = literal(n.arguments[0]);
    if (specifier !== undefined) return specifier;
    // `createRequire(url)(resolve(...))` was invisible before: a path built here names a repository file
    return factoryCall(strip(c)) && builtFilePath(n.arguments[0]) ? '<file path>' : null; // null: cannot be resolved
  };

  // fs handles: bindings that hold a whole fs module
  const handles = new Set();
  const holds = (n, strict = false) => {
    n = strip(n);
    if (!n) return false;
    if (ts.isIdentifier(n)) return handles.has(n.text);
    const m = moduleOf(n);
    if (m !== undefined) return m === null ? !strict : FS_MODULE.test(m); // unresolved: may be fs
    if (ts.isPropertyAccessExpression(n))
      return ['promises', 'default'].includes(n.name.text) && holds(n.expression, strict);
    if (ts.isElementAccessExpression(n))
      return (
        holds(n.expression, strict) &&
        (!literal(n.argumentExpression) ||
          ['promises', 'default'].includes(literal(n.argumentExpression)))
      );
    if (ts.isConditionalExpression(n))
      return holds(n.whenTrue, strict) || holds(n.whenFalse, strict);
    if (ts.isBinaryExpression(n))
      return [
        ts.SyntaxKind.BarBarToken,
        ts.SyntaxKind.QuestionQuestionToken,
        ts.SyntaxKind.AmpersandAmpersandToken,
        ts.SyntaxKind.CommaToken,
      ].includes(n.operatorToken.kind)
        ? holds(n.left, strict) || holds(n.right, strict)
        : false;
    return false;
  };
  // values of a module the guard cannot resolve: nothing may be called on them (`require(name).sync(p)`)
  const unknowns = new Set();
  // A specifier BUILT as a file path (`resolve(...)`, or `join(dir, ...)` with a base) names a file
  // of this repository, never a built-in or a package.
  const builtFilePath = (arg) => {
    arg = strip(arg);
    if (!arg || !ts.isCallExpression(arg)) return false;
    const callee = ts.isIdentifier(arg.expression)
      ? arg.expression.text
      : memberName(arg.expression);
    return (
      callee === 'resolve' ||
      (callee === 'join' &&
        arg.arguments.length > 1 &&
        !(literal(arg.arguments[0]) !== undefined && !literal(arg.arguments[0]).includes('/')))
    );
  };
  const unresolved = (n) => {
    n = strip(n);
    if (!n) return false;
    if (ts.isCallExpression(n)) return moduleOf(n) === null && !builtFilePath(n.arguments[0]);
    if (ts.isIdentifier(n)) return unknowns.has(n.text);
    if (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n))
      return unresolved(n.expression);
    return false;
  };
  const names = (pattern) =>
    ts.isIdentifier(pattern)
      ? [pattern.text]
      : pattern.elements.flatMap((el) => (ts.isOmittedExpression(el) ? [] : names(el.name)));
  for (let size = -1; size !== unknowns.size;) {
    size = unknowns.size;
    for (const n of all) {
      const pair = ts.isVariableDeclaration(n)
        ? [n.name, n.initializer]
        : ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken
          ? [n.left, n.right]
          : [];
      if (
        pair[1] &&
        unresolved(pair[1]) &&
        (ts.isIdentifier(pair[0]) || ts.isBindingPattern(pair[0]))
      )
        for (const name of names(pair[0])) unknowns.add(name);
    }
  }
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
    if (ts.isCallExpression(n) && unresolved(n.expression))
      note(n, 'calls into a module the guard cannot resolve');
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
      const clause = ts.isExportDeclaration(n) ? n.exportClause : undefined;
      if (
        ts.isExportDeclaration(n) &&
        FS_MODULE.test(spec ?? '') &&
        (!clause ||
          ts.isNamespaceExport(clause) ||
          clause.elements.some((e) =>
            ['promises', 'default'].includes((e.propertyName ?? e.name).text),
          ))
      )
        note(n, `re-exports ${spec} whole`);
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
    if (ts.isIdentifier(n) && (n.text === 'eval' || n.text === 'Function')) {
      const p = n.parent;
      const harmless =
        ts.isTypeReferenceNode(p) ||
        ts.isTypeOfExpression(p) ||
        (ts.isBinaryExpression(p) &&
          p.right === n &&
          p.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword) ||
        p.name === n ||
        (ts.isCallExpression(p) && /^(?:any|toBeInstanceOf)$/.test(memberName(p.expression) ?? ''));
      if (!harmless) note(n, `builds code from text, or aliases it (${n.text})`);
    }
    const global = /^(?:globalThis|global|window|self)$/;
    if (
      memberName(n) !== undefined &&
      /^(?:eval|Function)$/.test(memberName(n)) &&
      global.test(n.expression.getText())
    )
      note(n, 'builds code from text through the global object');
    // process, module and the global object: a member chosen at run time may be a module loader
    const symbolKey = (k) =>
      ts.isCallExpression(k) && /^Symbol(?:\.for)?$/.test(k.expression.getText()); // never a name
    if (
      ts.isElementAccessExpression(n) &&
      !literal(n.argumentExpression) &&
      !symbolKey(n.argumentExpression)
    ) {
      const base = strip(n.expression).getText();
      if (
        /^(?:process|module|globalThis|global|globalThis\.process|global\.process|module\.constructor|Module|require)$/.test(
          base,
        )
      )
        note(n, `computed member of ${base}`);
    }
    if (/^(?:getBuiltinModule|_load)$/.test(memberName(n) ?? '')) {
      const p = n.parent;
      if (!(ts.isCallExpression(p) && p.expression === n))
        note(n, `${memberName(n)} reached without being called`);
    }
    if (
      ts.isBindingElement(n) &&
      /^(?:getBuiltinModule|_load)$/.test((n.propertyName ?? n.name).text ?? '')
    )
      note(n, `${(n.propertyName ?? n.name).text} taken out of its owner`);
    // 3b. a module loader (require, createRequire and their aliases) that is not simply called
    if (ts.isIdentifier(n) && (requirers.has(n.text) || factories.has(n.text))) {
      const p = n.parent;
      const plain = (name) => !/^(?:call|apply|bind)$/.test(name);
      const ok =
        (ts.isCallExpression(p) && p.expression === n) ||
        ((ts.isVariableDeclaration(p) || ts.isParameter(p) || ts.isBindingElement(p)) &&
          p.name === n) ||
        p.name === n ||
        ts.isImportSpecifier(p) ||
        ts.isTypeOfExpression(p) ||
        ts.isTypeQueryNode(p) ||
        (ts.isVariableDeclaration(p) && p.initializer === n && ts.isIdentifier(p.name)) ||
        (ts.isBinaryExpression(p) &&
          p.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          ts.isIdentifier(p.left) &&
          (p.left === n || p.right === n)) ||
        (ts.isPropertyAccessExpression(p) && (p.name === n || plain(p.name.text))) ||
        (ts.isElementAccessExpression(p) &&
          p.expression === n &&
          plain(literal(p.argumentExpression) ?? 'call')) ||
        (ts.isPropertyAssignment(p) && p.name === n);
      if (!ok) note(n, `module loader ${n.text} used in a way the guard cannot follow`);
    }
    if (
      ts.isPropertyAccessExpression(n) &&
      /^(?:binding|dlopen|mainModule)$/.test(n.name.text) &&
      /^(?:process|globalThis\.process|global\.process)$/.test(n.expression.getText())
    )
      note(n, 'reaches Node internals through process');
    // 4. an fs handle the guard cannot follow
    if (
      (ts.isIdentifier(n) && handles.has(n.text)) ||
      ((ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) && holds(n, true))
    ) {
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
        note(n, `fs handle ${n.getText()} used in a way the guard cannot follow`);
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
  // PR #751 r2 F1: computed or aliased access through an fs expression, an acquisition the guard cannot name
  'review example: fs.promises[api]':
    "import fs from 'node:fs'; export const list = (api, dir) => fs.promises[api](dir, { recursive: true });",
  'optional chain on fs.promises': "import fs from 'node:fs'; fs.promises?.[api]?.(d);",
  "fs['promises'] aliased": "import fs from 'node:fs'; const p = fs['promises']; p[k](d);",
  "fs['promises'] computed": "import fs from 'node:fs'; fs['promises'][k](d);",
  '.default chain': "import fs from 'node:fs'; fs.default.promises[k](d);",
  'required .default chain': "require('node:fs').default.promises[k](d);",
  'required promises, computed': "require('node:fs').promises[api](d);",
  'promises of a required fs, destructured computed':
    "const { promises: p } = require('fs'); p[k](d);",
  'require aliased': "const r = require; r('node:fs')[k](d);",
  'require aliased twice': "const r = require; const s = r; s('node:fs')[k](d);",
  'require through a comma': "(0, require)('node:fs')[k](d);",
  'require passed on': "use(require); require('node:fs');",
  'require.call': "require.call(null, 'node:fs')[k](d);",
  'createRequire aliased':
    "import { createRequire } from 'node:module'; const c = createRequire; c(url)('node:fs')[k](d);",
  'createRequire renamed':
    "import { createRequire as cr } from 'node:module'; cr(url)('node:fs')[k](d);",
  'createRequire read from process':
    "const { createRequire: cr } = process.getBuiltinModule('module'); cr(u)('fs')[k](d);",
  'computed getBuiltinModule': "process['getBuiltinModule']('fs')[k](d);",
  'computed member of process': "process[name]('fs')[k](d);",
  'getBuiltinModule aliased': "const g = process.getBuiltinModule; g('fs')[k](d);",
  'getBuiltinModule destructured': "const { getBuiltinModule: g } = process; g('fs')[k](d);",
  'fs star re-export': "export * from 'node:fs';",
  'fs namespace re-export': "export * as fs from 'node:fs';",
  'fs default re-export': "export { default } from 'fs';",
  'fs promises re-export': "export { promises as p } from 'node:fs/promises';",
  'fs namespace exported': "import * as fs from 'node:fs'; export { fs };",
  'fs default exported': "import fs from 'node:fs'; export default fs;",
  'unresolved loader, static member': 'require(name).sync(p);',
  'unresolved loader built by another call': 'require(pick(name)).sync(p);',
  'unresolved loader, join without a base': 'require(join(name)).sync(p);',
  'unresolved loader, member of a held module': 'const g = require(name); g.sync(p);',
  'unresolved loader, destructured member': 'const { sync } = require(name); sync(p);',
  'unresolved import, default called': 'const g = (await import(name)).default; g(p);',
  'eval aliased': "const e = eval; e('x');",
  'eval through a comma': "(0, eval)('x');",
  'eval through the global object': "globalThis['eval']('x');",
  'Function aliased': "const F = Function; new F('return process')();",
  'Function passed on': "Reflect.construct(Function, ['return process']);",
  'unicode-escaped loader': "\\u0072equire('\\u0066s')[k](d);",
  'unicode-escaped lister': 'const f = (d) => \\u0072eaddirSync(d);',
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
  "fs['promises'] members by name":
    "import fs from 'node:fs'; await fs['promises'].readFile(p); fs.default.statSync(p);",
  'require read, not passed': "const r = require; r('./x'); require.resolve('y'); typeof require;",
  'createRequire for a literal':
    "import { createRequire } from 'node:module'; createRequire(u)('./x');",
  'named re-export of file reads': "export { readFileSync } from 'node:fs';",
  'a repository file loaded by path':
    "const c = require(resolve(root, 'dist/index.js')); c.build(1);",
  'matchers and process members':
    "expect(f).toBeInstanceOf(Function); x instanceof Function; process.env[k]; g[Symbol.for('k')];",
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
 * so a lister is out of reach of the race only when it lists a tree that cannot contain it
 * (NO_GENERATED_TREE). The ten walkers that pruned `generated` by name were migrated onto
 * `authoredFiles` (FU-112 r2): a walker of its own, however it prunes, is not trusted, so there is
 * no pruning-order check to fool. Follow-up (FU-102): migrate the rest and drop the lists.
 */
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
  'apps/web/src/test/turbo-inputs-guard.ts', // wraps fs read APIs to record reads; lists nothing itself
  'apps/web/scripts/build-lock.mjs',
  'apps/web/scripts/capture-next-config.cjs',
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
    NO_GENERATED_TREE.length + 3 + OTHER_CAPABILITY.length,
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
  'apps/web/src/test/turbo-inputs-guard.ts': 0,
  'packages/contracts/src/events/topic-consumers.repo.spec.ts': 0,
  'packages/nest-common/src/kafka/log-creator.spec.ts': 0,
  'packages/nest-common/src/tenancy/raw-sql-inventory.spec.ts': 0,
  'scripts/check-service-boundaries-lib.mjs': 0,
  'scripts/eligibility-clock-derive.mjs': 0,
  'scripts/url-parsing-guard-lib.mjs': 0,
  'services/audit-service/test/authorization.int-spec.ts': 0,
  'services/construction-service/src/shared/idempotency-forget.spec.ts': 0,
  'services/identity-service/src/prisma/transaction-boundary.spec.ts': 0,
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
