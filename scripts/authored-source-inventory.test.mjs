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

test('file names survive byte for byte: a leading U+FEFF is part of the name, not a byte-order mark (FU-130)', () => {
  const names = [
    'a.ts',
    '\uFEFFa.ts',
    '\uFEFFdir/a.ts',
    'dir/\uFEFFb.ts',
    'dir/a\uFEFFb.ts',
    '\uFEFF\uFEFFc.ts',
    'é/\u{1F600}.ts',
  ];
  const dir = fs.mkdtempSync(join(tmpdir(), 'authored-bytes-'));
  try {
    for (const name of names) {
      fs.mkdirSync(dirname(join(dir, name)), { recursive: true });
      fs.writeFileSync(join(dir, name), 'x');
    }
    const listed = authoredFiles(dir).map(rel(dir));
    assert.deepEqual(new Set(listed).size, names.length, 'two names collapsed into one');
    assert.deepEqual([...listed].sort(), [...names].sort());
    // ...and every listed path names the file that is there (the bytes git printed are the bytes on disk)
    for (const path of authoredFiles(dir)) assert.equal(fs.readFileSync(path, 'utf8'), 'x');
    // a deleted tracked file is subtracted by its exact name, not by its BOM-less twin
    const run = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' });
    run('init', '-q');
    run('add', '-f', '.');
    run('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'x');
    fs.rmSync(join(dir, '\uFEFFa.ts'));
    assert.deepEqual(
      authoredFiles(dir).map(rel(dir)).sort(),
      names.filter((name) => name !== '\uFEFFa.ts').sort(),
    );
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
// Not "a recursive walker", and not a list of dangerous spellings: both are shapes the next spelling
// escapes (PR #772 r2 F1: 96/96). The boundary is the capability, and it is CLOSED: a file is clean only
// when every module, loader and global it touches is acquired and used in a shape proven below. What
// the guard cannot follow it refuses (checklist 11) and reports as a finding, never as `[]`.

// The listing capability is closed by PROOF, not by spelling (FU-126, PR #772 r2 F1: 96/96 escapes of
// the earlier "recognise the dangerous shape" detector). A file passes only if EVERY acquisition and
// EVERY use of a module, loader or global it contains is one of the shapes below; whatever else it
// does (an alias, a computed member, a dynamic require/import, a path builder, an object that holds a
// module, a rest binding, a global evaluator, ...) is a REFUSAL, reported as a finding, never `[]`.
//
//  acquisition: a static import / export-from / import-equals / `require('lit')` / `import('lit')` /
//               `createRequire(u)('lit')` / `const r = createRequire(u)` with a string-literal specifier.
//               A non-literal specifier (a built path included) is unproven: it may name fs.
//  fs module:   (the node fs family) may only be a receiver of a LITERAL member in SAFE_FS (or
//               `promises` / `default`, which are fs again), the initializer of a plain `const x =`,
//               or destructured by a pattern of literal SAFE keys (no rest, no computed key).
//  globals:     `process`, `module`, `require`, the global object and `eval` / `Function` are reachable
//               only through the members listed below; `.constructor` only to read its name.
//  names:       the NAME of a listing API anywhere (identifier, key, string) is refused as before.
const LISTERS = new Set([
  'readdir',
  'readdirsync',
  'opendir',
  'opendirsync',
  'glob',
  'globsync',
  'globiterate',
  'readdirp',
  'scandir',
  'scandirsync',
]);
const FS_MODULE = /^(?:fs|fs\/promises|fs-extra|graceful-fs)$/;
const LISTING_PACKAGE =
  /^(?:glob|fast-glob|globby|tinyglobby|readdirp|fdir|klaw|node-dir|recursive-readdir|walk|walkdir|dir-walker|scandir|@nodelib\/fs\.walk|@nodelib\/fs\.scandir)(?:\/.*)?$/;
const REFLECTIVE_MODULE = /^(?:vm|worker_threads|repl|inspector|data:.*|https?:.*)$/;
// members of an fs module that cannot list a directory
const SAFE_FS = new Set(
  (
    'access accessSync appendFile appendFileSync chmod chmodSync chown chownSync close closeSync constants ' +
    'copyFile copyFileSync cp cpSync createReadStream createWriteStream exists existsSync fchmod fchmodSync fchown ' +
    'fchownSync fdatasync fdatasyncSync fstat fstatSync fsync fsyncSync ftruncate ftruncateSync futimes ' +
    'futimesSync lchmod lchmodSync lchown lchownSync link linkSync lstat lstatSync lutimes lutimesSync ' +
    'mkdir mkdirSync mkdtemp mkdtempSync open openSync read readFile readFileSync readSync readlink ' +
    'readlinkSync readv readvSync realpath realpathSync rename renameSync rm rmSync rmdir rmdirSync stat ' +
    'statSync statfs statfsSync symlink symlinkSync truncate truncateSync unlink unlinkSync unwatchFile ' +
    'utimes utimesSync write writeFile writeFileSync writeSync writev writevSync Stats ' +
    // fs-extra: file operations only
    'ensureDir ensureDirSync ensureFile ensureFileSync pathExists pathExistsSync readJson readJsonSync ' +
    'writeJson writeJsonSync outputFile outputFileSync outputJson outputJsonSync remove removeSync move moveSync'
  ).split(' '),
);
const FS_CHAIN = new Set(['promises', 'default']); // an fs module again
const SAFE_MODULE = new Set([
  'createRequire',
  'builtinModules',
  'isBuiltin',
  'syncBuiltinESMExports',
]);
const GLOBAL_OBJECT = /^(?:globalThis|global|self|window)$/;
const GLOBAL_ROOTS = new Set(['process', 'module', 'require', 'eval', 'Function']);
const PROCESS_OK = new Set(
  (
    'argv argv0 arch chdir cwd emitWarning env exit exitCode execArgv execPath getegid geteuid getgid ' +
    'getuid hrtime kill memoryUsage nextTick off on once pid platform ppid release stderr stdin stdout ' +
    'title umask uptime version versions cpuUsage resourceUsage emit removeListener removeAllListeners ' +
    'listenerCount listeners send features getActiveResourcesInfo hasUncaughtExceptionCaptureCallback ' +
    'setUncaughtExceptionCaptureCallback connected disconnect channel allowedNodeEnvironmentFlags ' +
    'constrainedMemory availableMemory sourceMapsEnabled setSourceMapsEnabled debugPort'
  ).split(' '),
);
const INTERNALS = /^(?:dlopen|mainModule|getBuiltinModule|_load|_linkedBinding)$/;
const COMPARISON = new Set([
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
]);

// `jest.spyOn(globalThis, 'fetch')`, `Object.defineProperty(window, 'name', ...)`: the global object or
// `process` handed over WITH a literal member name that is not itself a loader, evaluator or internal.
const SPY_CALLEE =
  /^(?:jest\.spyOn|vi\.spyOn|Object\.defineProperty|Object\.getOwnPropertyDescriptor)$/;
const ASSERTION =
  /^(?:expect|toBe|toEqual|toStrictEqual|equal|strictEqual|notStrictEqual|deepEqual|deepStrictEqual)$/;

function listingCapabilities(file, text) {
  const kindOfFile = /\.[cm]?jsx?$/.test(file)
    ? ts.ScriptKind.JS
    : file.endsWith('.tsx')
      ? ts.ScriptKind.TSX
      : ts.ScriptKind.TS;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kindOfFile);
  if (source.parseDiagnostics?.length) return [`${file}: does not parse`];
  const found = [];
  const note = (node, what) =>
    found.push(`${file}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1} ${what}`);
  const all = [];
  const collect = (n) => {
    all.push(n);
    ts.forEachChild(n, collect);
  };
  collect(source);

  const wrapper = (n) =>
    ts.isParenthesizedExpression(n) ||
    ts.isAsExpression(n) ||
    ts.isNonNullExpression(n) ||
    ts.isAwaitExpression(n) ||
    ts.isSatisfiesExpression?.(n) ||
    ts.isTypeAssertionExpression(n);
  const unwrap = (n) => {
    while (n && wrapper(n)) n = n.expression;
    return n;
  };
  /** The outermost wrapper around `n`: the node whose parent decides how `n` is used. */
  const outer = (n) => {
    let u = n;
    while (u.parent && wrapper(u.parent) && unwrap(u.parent) === n) u = u.parent;
    return u;
  };
  const literal = (n) => (n && ts.isStringLiteralLike(n) ? n.text : undefined);
  const isMember = (n) => ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n);
  const memberName = (n) =>
    ts.isPropertyAccessExpression(n)
      ? n.name.text
      : ts.isElementAccessExpression(n)
        ? literal(n.argumentExpression)
        : undefined;
  const bare = (specifier) => specifier.replace(/^node:/, '');
  const moduleKind = (specifier) =>
    FS_MODULE.test(bare(specifier)) ? 'fs' : bare(specifier) === 'module' ? 'module' : undefined;
  // a binding name is not a use; a shorthand property `{ fs }` is one
  const slot = (n) => {
    const p = n.parent;
    return (
      p &&
      !ts.isShorthandPropertyAssignment(p) &&
      !(ts.isExportSpecifier(p) && !p.parent.parent.moduleSpecifier) && // `export { fs }` exports the binding
      (p.name === n ||
        p.propertyName === n ||
        ts.isQualifiedName(p) ||
        ts.isTypeReferenceNode(p) ||
        ts.isExpressionWithTypeArguments(p) ||
        ts.isLabeledStatement(p) ||
        ts.isBreakOrContinueStatement(p))
    );
  };
  // `import process from 'node:process'` is the global `process` under another declaration
  const processImport = (n) => {
    if (!ts.isImportClause(n) && !ts.isNamespaceImport(n)) return false;
    let decl = n;
    while (decl && !ts.isImportDeclaration(decl)) decl = decl.parent;
    return decl !== undefined && bare(decl.moduleSpecifier.text ?? '') === 'process';
  };
  const declared = new Set();
  for (const n of all)
    if (
      (ts.isVariableDeclaration(n) ||
        ts.isBindingElement(n) ||
        ts.isParameter(n) ||
        ts.isFunctionDeclaration(n) ||
        ts.isClassDeclaration(n) ||
        ts.isImportClause(n) ||
        ts.isImportSpecifier(n) ||
        ts.isNamespaceImport(n) ||
        ts.isImportEqualsDeclaration(n)) &&
      n.name &&
      ts.isIdentifier(n.name) &&
      !processImport(n)
    )
      declared.add(n.name.text);

  // ---- provenance: bindings that PROVABLY hold an fs module / node:module / a require function ----
  const handles = new Map(); // binding name -> 'fs' | 'module'
  const requirers = new Set(['require']);
  const factories = new Set(); // createRequire and its (imported or destructured) bindings
  const factoryCall = (n) => {
    n = unwrap(n);
    return (
      n &&
      ts.isCallExpression(n) &&
      ts.isIdentifier(unwrap(n.expression)) &&
      factories.has(unwrap(n.expression).text)
    );
  };
  const loaderCall = (n) =>
    ts.isCallExpression(n) &&
    (n.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(unwrap(n.expression)) && requirers.has(unwrap(n.expression).text)) ||
      factoryCall(n.expression));
  /** 'fs' | 'module' when `n` provably is such a module; undefined when it is not (or not provable). */
  const kind = (n) => {
    n = unwrap(n);
    if (!n) return undefined;
    if (ts.isIdentifier(n)) return handles.get(n.text);
    if (ts.isCallExpression(n))
      return loaderCall(n) && n.arguments.length >= 1 && literal(n.arguments[0]) !== undefined
        ? moduleKind(literal(n.arguments[0]))
        : undefined;
    if (isMember(n))
      return kind(n.expression) === 'fs' && FS_CHAIN.has(memberName(n)) ? 'fs' : undefined;
    return undefined;
  };
  let grew = true;
  const bind = (target, k) => {
    if (ts.isIdentifier(target) && handles.get(target.text) !== k) {
      handles.set(target.text, k);
      grew = true;
    }
  };
  const addFactory = (target) => {
    if (ts.isIdentifier(target) && !factories.has(target.text)) {
      factories.add(target.text);
      grew = true;
    }
  };
  /** `const { a, promises: { b } } = <module>`: literal keys only, no rest, no computed key. */
  const destructure = (pattern, k) => {
    if (!ts.isObjectBindingPattern(pattern))
      return note(pattern, 'array destructuring of a loaded module');
    for (const el of pattern.elements) {
      const key = el.propertyName ?? el.name;
      const name = ts.isComputedPropertyName(key) ? literal(key.expression) : key.text;
      if (el.dotDotDotToken) note(el, 'rest binding of a loaded module');
      else if (name === undefined) note(el, 'computed key read from a loaded module');
      else if (k === 'fs' && FS_CHAIN.has(name)) {
        if (ts.isIdentifier(el.name)) bind(el.name, 'fs');
        else destructure(el.name, 'fs');
      } else if (k === 'fs' && SAFE_FS.has(name)) {
        if (!ts.isIdentifier(el.name)) note(el, `member ${name} destructured further`);
      } else if (k === 'module' && name === 'createRequire') addFactory(el.name);
      else if (!(k === 'module' && SAFE_MODULE.has(name)))
        note(el, `member ${name} of a loaded module is not in the proven set`);
    }
  };
  const flow = (target, value) => {
    const k = kind(value);
    if (k) return ts.isIdentifier(target) ? bind(target, k) : destructure(target, k);
    if (factoryCall(value) && ts.isIdentifier(target) && !requirers.has(target.text)) {
      requirers.add(target.text);
      grew = true;
    }
  };
  while (grew) {
    grew = false;
    for (const n of all) {
      if (ts.isImportDeclaration(n) && n.importClause && !n.importClause.isTypeOnly) {
        const k = moduleKind(n.moduleSpecifier.text ?? '');
        const { name, namedBindings } = n.importClause;
        if (
          bare(n.moduleSpecifier.text ?? '') === 'process' &&
          namedBindings &&
          ts.isNamedImports(namedBindings)
        )
          for (const s of namedBindings.elements)
            if (!PROCESS_OK.has((s.propertyName ?? s.name).text))
              note(
                s,
                `import of process.${(s.propertyName ?? s.name).text} is not in the proven set`,
              );
        if (!k) continue;
        if (k === 'module' && (name || (namedBindings && ts.isNamespaceImport(namedBindings))))
          note(n, 'imports node:module as a whole');
        else if (name) bind(name, k);
        if (namedBindings && ts.isNamespaceImport(namedBindings) && k === 'fs')
          bind(namedBindings.name, k);
        if (namedBindings && ts.isNamedImports(namedBindings))
          for (const s of namedBindings.elements) {
            const member = (s.propertyName ?? s.name).text;
            if (k === 'fs' && FS_CHAIN.has(member)) bind(s.name, 'fs');
            else if (k === 'module' && member === 'createRequire') addFactory(s.name);
            else if (!(k === 'fs' ? SAFE_FS : SAFE_MODULE).has(member))
              note(s, `import of ${member} is not in the proven set`);
          }
      } else if (ts.isImportEqualsDeclaration(n)) {
        const ref = n.moduleReference;
        const k = ts.isExternalModuleReference(ref)
          ? literal(ref.expression) !== undefined && moduleKind(literal(ref.expression))
          : ts.isIdentifier(ref) && handles.get(ref.text);
        if (k) bind(n.name, k);
      } else if (ts.isVariableDeclaration(n) && n.initializer) flow(n.name, n.initializer);
      else if (
        ts.isBinaryExpression(n) &&
        n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(n.left)
      )
        flow(n.left, n.right);
    }
  }

  // ---- every node: it is either outside the capability, or one of the proven shapes ----
  const callee = (u) => u.parent && ts.isCallExpression(u.parent) && u.parent.expression === u;
  /** `u` is the target of a spy / property definition naming a member that is safe for `owner`. */
  const spied = (u, owner) => {
    const p = u.parent;
    const key =
      p && ts.isCallExpression(p) && p.arguments[0] === u ? literal(p.arguments[1]) : undefined;
    return (
      key !== undefined &&
      SPY_CALLEE.test(p.expression.getText().replace(/\s+/g, '')) &&
      !INTERNALS.test(key) &&
      (owner === 'process' ? PROCESS_OK.has(key) : !GLOBAL_ROOTS.has(key))
    );
  };
  for (const n of all) {
    if (n.kind === ts.SyntaxKind.EndOfFileToken) continue;
    // 1. the NAME of a listing API, however it is imported, aliased, keyed or reached
    const spelled =
      (ts.isIdentifier(n) || ts.isPrivateIdentifier(n) || ts.isStringLiteralLike(n)) &&
      n.text.replace(/^#/, '');
    if (
      spelled &&
      LISTERS.has(spelled.toLowerCase()) &&
      !(ts.isStringLiteralLike(n) && ts.isImportDeclaration(n.parent))
    )
      note(n, `names the directory-listing API ${spelled}`);
    if (spelled && INTERNALS.test(spelled) && !ts.isStringLiteralLike(n))
      note(n, `names a Node internal (${spelled})`); // `process['getBuiltinModule']` is a computed process member
    // 2. acquisition: only a literal specifier is proven; the module it names decides the rest
    if (loaderCall(n)) {
      const spec = literal(n.arguments[0]);
      if (
        spec === undefined ||
        (n.arguments.length !== 1 && n.expression.kind !== ts.SyntaxKind.ImportKeyword)
      )
        note(n, 'a dynamic require/import: the module it loads is unproven');
      else if (
        LISTING_PACKAGE.test(bare(spec)) ||
        REFLECTIVE_MODULE.test(bare(spec)) ||
        bare(spec) === 'process' // only a static `import process from` is followed (it is the global)
      )
        note(n, `loads ${spec}`);
    }
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier) {
      const spec = bare(n.moduleSpecifier.text ?? '');
      if (LISTING_PACKAGE.test(spec) || REFLECTIVE_MODULE.test(spec)) note(n, `imports ${spec}`);
      const clause = ts.isExportDeclaration(n) ? n.exportClause : undefined;
      if (ts.isExportDeclaration(n) && !n.isTypeOnly && moduleKind(spec)) {
        if (!clause || ts.isNamespaceExport(clause)) note(n, `re-exports ${spec} whole`);
        else
          for (const e of clause.elements)
            if (
              !(moduleKind(spec) === 'fs' ? SAFE_FS : SAFE_MODULE).has(
                (e.propertyName ?? e.name).text,
              )
            )
              note(e, `re-exports ${(e.propertyName ?? e.name).text} of ${spec}`);
      }
    }
    if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference)) {
      const spec = literal(n.moduleReference.expression);
      if (spec === undefined) note(n, 'a dynamic import-equals: the module it loads is unproven');
      else if (LISTING_PACKAGE.test(bare(spec)) || REFLECTIVE_MODULE.test(bare(spec)))
        note(n, `imports ${spec}`);
    }
    // 3. a module or a handle that is used: only the proven contexts
    const isExpr = !wrapper(n) && !slot(n) && !ts.isTypeNode(n);
    if (isExpr && kind(n)) {
      const u = outer(n);
      const p = u.parent;
      const k = kind(n);
      const m = isMember(p) && p.expression === u ? memberName(p) : undefined;
      const chain = k === 'fs' && FS_CHAIN.has(m); // judged at the link itself
      const ok =
        ts.isExpressionStatement(p) ||
        ts.isTypeOfExpression(p) ||
        ts.isTypeQueryNode(p) ||
        chain ||
        (k === 'fs' && SAFE_FS.has(m)) ||
        (ts.isVariableDeclaration(p) &&
          p.initializer === u &&
          (ts.isIdentifier(p.name) || ts.isObjectBindingPattern(p.name))) ||
        (ts.isBinaryExpression(p) &&
          p.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          p.right === u &&
          ts.isIdentifier(p.left)) ||
        ts.isImportEqualsDeclaration(p);
      if (!ok)
        note(
          n,
          isMember(p) && p.expression === u
            ? m === undefined
              ? `computed member of a loaded ${k} module`
              : `member ${m} of a loaded ${k} module is not in the proven set`
            : `a loaded ${k} module is passed on or used where the guard cannot follow it`,
        );
    }
    // loaders: require / created require / createRequire only called with a literal
    if (ts.isIdentifier(n) && !slot(n) && (requirers.has(n.text) || factories.has(n.text))) {
      const u = outer(n);
      const m = isMember(u.parent) && u.parent.expression === u ? memberName(u.parent) : undefined;
      const isRequire = requirers.has(n.text);
      if (!(
        callee(u) ||
        (isRequire && (m === 'resolve' || m === 'main')) ||
        ts.isTypeOfExpression(u.parent) ||
        ts.isTypeQueryNode(u.parent) ||
        ts.isImportSpecifier(u.parent)
      ))
        note(n, `module loader ${n.text} used in a way the guard cannot follow`);
      if (!isRequire && callee(u)) {
        const call = outer(u.parent);
        const q = call.parent;
        if (!(
          (ts.isVariableDeclaration(q) && q.initializer === call && ts.isIdentifier(q.name)) ||
          callee(call) ||
          (isMember(q) && q.expression === call && memberName(q) === 'resolve')
        ))
          note(n, 'createRequire result used where the guard cannot follow it');
      }
    }
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.name.text === 'require' &&
      !(n.initializer && factoryCall(n.initializer))
    )
      note(n, 'a binding named require that is not createRequire(...)');
    if (
      (ts.isParameter(n) ||
        ts.isFunctionDeclaration(n) ||
        ts.isClassDeclaration(n) ||
        ts.isBindingElement(n) ||
        ts.isImportClause(n) ||
        ts.isImportSpecifier(n) ||
        ts.isNamespaceImport(n)) &&
      n.name &&
      ts.isIdentifier(n.name) &&
      n.name.text === 'require'
    )
      note(n, 'a parameter, function, class or import named require');
    // 4. globals: process, module, the global object, code from text
    if (isExpr && ts.isIdentifier(n) && (n.text === 'eval' || n.text === 'Function')) {
      const p = n.parent;
      const harmless =
        ts.isTypeReferenceNode(p) ||
        ts.isTypeOfExpression(p) ||
        (ts.isBinaryExpression(p) &&
          p.right === n &&
          p.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword) ||
        (isMember(p) && p.name === n) ||
        (ts.isCallExpression(p) && /^(?:any|toBeInstanceOf)$/.test(memberName(p.expression) ?? ''));
      if (!harmless) note(n, `builds code from text, or aliases it (${n.text})`);
    }
    if (isExpr && ts.isIdentifier(n) && GLOBAL_OBJECT.test(n.text) && !declared.has(n.text)) {
      const u = outer(n);
      const p = u.parent;
      const m = isMember(p) && p.expression === u ? memberName(p) : undefined;
      if (m !== undefined && GLOBAL_ROOTS.has(m)) {
        // `globalThis.process` is `process`: judged below as a root reference
      } else if (!(
        m !== undefined ||
        ts.isTypeOfExpression(p) ||
        ts.isTypeQueryNode(p) ||
        spied(u, 'global')
      ))
        note(n, `the global object ${n.text} used where the guard cannot follow it`);
    }
    const root =
      ts.isIdentifier(n) && GLOBAL_ROOTS.has(n.text) && !declared.has(n.text) && !slot(n)
        ? n.text
        : isMember(n) &&
            ts.isIdentifier(unwrap(n.expression)) &&
            GLOBAL_OBJECT.test(unwrap(n.expression).text) &&
            !declared.has(unwrap(n.expression).text) &&
            GLOBAL_ROOTS.has(memberName(n) ?? '')
          ? memberName(n)
          : undefined;
    if (root === 'require' && isMember(n))
      note(n, 'a module loader reached through the global object');
    if (root && root !== 'require' && !(root === 'eval' || root === 'Function')) {
      const u = outer(n);
      const p = u.parent;
      const m = isMember(p) && p.expression === u ? memberName(p) : undefined;
      const ok =
        ts.isTypeOfExpression(p) ||
        ts.isTypeQueryNode(p) ||
        (root === 'process' && (PROCESS_OK.has(m) || spied(u, 'process'))) ||
        (root === 'process' && ts.isBinaryExpression(p) && COMPARISON.has(p.operatorToken.kind)) ||
        (root === 'module' &&
          (m === 'exports' || (ts.isBinaryExpression(p) && COMPARISON.has(p.operatorToken.kind))));
      if (!ok) note(n, `${root} used where the guard cannot follow it${m ? ` (${m})` : ''}`);
    } else if (
      isMember(n) &&
      ts.isIdentifier(unwrap(n.expression)) &&
      GLOBAL_OBJECT.test(unwrap(n.expression).text) &&
      /^(?:eval|Function)$/.test(memberName(n) ?? '')
    )
      note(n, 'builds code from text through the global object');
    // `.constructor` reached the Function constructor of any function: read its name, nothing else
    if (isMember(n) && memberName(n) === 'constructor') {
      const u = outer(n);
      const p = u.parent;
      if (!(
        (isMember(p) && p.expression === u && memberName(p) === 'name') ||
        (ts.isBinaryExpression(p) &&
          (COMPARISON.has(p.operatorToken.kind) ||
            p.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword)) ||
        (ts.isCallExpression(p) &&
          p.arguments.includes(u) &&
          ASSERTION.test(memberName(p.expression) ?? p.expression.getText()))
      ))
        note(n, '.constructor used where it may reach the Function constructor');
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
  // FU-126: a built path may name fs, so it is unproven (the files that do it are allow-listed rows)
  'a repository file loaded by a built path':
    "const c = require(resolve(root, 'dist/index.js')); c.build(1);",
  // FU-126: refused before as well, kept as controls
  'rest binding named like a safe member':
    "import fs from 'node:fs'; const { ...stat } = fs; stat['read' + 'dir'](d);",
  'process module imported, binding read':
    "import process from 'node:process'; process.binding('fs');",
  'loader reached through the global object':
    "globalThis.require('node:fs')['read' + 'dirSync'](d);",
  'path builder returns fs, computed member':
    "const resolve = () => 'node:fs'; require(resolve())['read' + 'dirSync'](dir);",
  'join builder with a base':
    "const join = (a, b) => b; const fs = require(join(root, 'fs')); fs['read' + 'dirSync'](d);",
  'nested destructuring, computed key':
    "import fs from 'node:fs'; const { promises: { ['read' + 'dir']: list } } = fs; list(d);",
  'nested rest binding':
    "import fs from 'node:fs'; const { promises: { ...p } } = fs; p['read' + 'dir'](d);",
  'rest of promises':
    "import fs from 'node:fs'; const { ...all } = fs.promises; all['read' + 'dir'](d);",
  'process read through the global object, aliased':
    "const g = globalThis; g.process.getBuiltinModule('fs')['read' + 'dirSync'](d);",
  'glob dist import': "import { globSync } from 'glob/dist/esm/index.js'; globSync(p);",
  'import-equals of glob': "import glob = require('glob'); glob.sync(p);",
  'import-equals fs alias, computed member':
    "import fs = require('node:fs'); fs['read' + 'dirSync'](d);",
  'import-equals alias of a namespace':
    "import fs = require('fs'); import f = fs; f['read' + 'dirSync'](d);",
};
/**
 * FU-126 (PR #772 r2 F1): shapes the earlier detector let through (`[]`) on all eight supported file
 * extensions (.js .jsx .mjs .cjs .ts .tsx .mts .cts; the TypeScript-only ones on the four TS ones).
 * Each reaches a directory reader, a loader or an evaluator by a route the old detector did not name:
 * an unproven path builder, an fs module stored on an object, process or the global object aliased
 * or reached by a computed/destructured member, `.constructor` chains, `data:` and worker code, a
 * listing package by sub-path, and TypeScript import-equals loaders. The closed detector refuses all.
 */
const ESCAPED_BEFORE = {
  'path builder returns fs, computed promises member':
    "const resolve = () => 'node:fs'; require(resolve()).promises['read' + 'dir'](dir);",
  'fs stored on an object':
    "const holder = {}; holder.fs = require('node:fs'); holder.fs['read' + 'dirSync'](d);",
  'fs stored on this':
    "class C { constructor() { this.fs = require('node:fs'); } list(d) { return this.fs['read' + 'dirSync'](d); } }",
  'fs stored in an array element':
    "const held = []; held[0] = require('node:fs'); held[0]['read' + 'dirSync'](d);",
  'process aliased, computed binding':
    "const p = process; p['bind' + 'ing']('fs')['read' + 'dir'](d);",
  'process internals through a parenthesised process': "(process).binding('fs');",
  'binding destructured from process': "const { binding } = process; binding('fs');",
  'process passed to a helper': 'use(process);',
  'global object aliased, eval member': 'const g = globalThis; g.eval(\'require("fs")\');',
  'global object aliased, computed eval': "const g = globalThis; g['ev' + 'al']('x');",
  'eval fetched from an aliased global, called through a comma':
    "const g = global; (0, g.eval)('x');",
  'Function through constructor': "(() => {}).constructor('return process')();",
  'Function through a chain of constructors': "[].constructor.constructor('return process')();",
  'data: URL import': 'import(\'data:text/javascript,import fs from "node:fs"; fs.x\');',
  'worker evaluates a string':
    "import { Worker } from 'node:worker_threads'; new Worker('x', { eval: true });",
  'node-dir sub-path import': "import paths from 'node-dir/lib/paths'; paths.files(d);",
  'node-dir required by sub-path': "require('node-dir/lib/paths').files(d);",
  'walkdir package': "import walkdir from 'walkdir'; walkdir.sync(d);",
  'Deno readDir': 'for await (const e of Deno.readDir(d)) e;',
  'Bun Glob': "new Bun.Glob('**').scanSync(d);",
  'import-equals of node-dir': "import dir = require('node-dir'); dir.files(d);",
  'import-equals of a computed module': 'import m = require(name); m.sync(p);',
};
// Found while closing the class (the process module is the global `process` under another name).
const ESCAPED_LATER = {
  'node:process required, binding read':
    "const p = require('node:process'); p.binding('fs')['read' + 'dir'](d);",
  'process module imported by name': "import { binding } from 'node:process'; binding('fs');",
};
// The spy receiver is assembled so this file carries no `jest` token: the disclosure-guard wiring
// treats a script that imports child_process and mentions `jest` as an unregistered Jest launcher
// (scripts/disclosure-jest-launches.mjs launcherCandidate). This file only runs git.
const SPY = ['j', 'est'].join('');
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
  'require read, not passed':
    "require('./x'); require.resolve('y'); typeof require; require.main === module;",
  'createRequire for a literal':
    "import { createRequire } from 'node:module'; createRequire(u)('./x');",
  'named re-export of file reads': "export { readFileSync } from 'node:fs';",
  'safe members, destructured and imported':
    "import fs, { promises, readFileSync } from 'node:fs'; import { writeFile } from 'node:fs/promises'; const { statSync, promises: { readFile } } = fs; promises.stat(p); fs.default.existsSync(p);",
  'spies on the global object by a literal name': `${SPY}.spyOn(globalThis, 'fetch'); Object.defineProperty(window, 'matchMedia', {}); ${SPY}.spyOn(process, 'exit'); globalThis.fetch(u); typeof window;`,
  'process by its safe members and the process module':
    "import process from 'node:process'; import { argv } from 'node:process'; process.env.X; process.exitCode = 1; module.exports = {}; if (require.main === module) process.exit(0);",
  'constructor read for its name':
    'expect(e.constructor).toBe(E); e.constructor.name; x.constructor === Y;',
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

const EXTENSIONS = ['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'cts'];
/** The names of the cases `table` that `verdict` gets wrong, in every supported file extension. */
const wrong = (table, verdict) =>
  Object.entries(table).flatMap(([name, code]) =>
    EXTENSIONS.filter((ext) => !verdict(listingCapabilities(`x.${ext}`, code))).map(
      (ext) => `${name} (.${ext})`,
    ),
  );

test('the detector refuses every way to reach a directory listing and accepts plain file reads', () => {
  assert.deepEqual(
    wrong({ ...REFUSED, ...ESCAPED_BEFORE, ...ESCAPED_LATER }, (found) => found.length > 0),
    [],
    'not refused',
  );
  assert.deepEqual(
    wrong(ACCEPTED, (found) => found.length === 0),
    [],
    'refused',
  );
  assert.notEqual(
    listingCapabilities('x.ts', 'const x: number = readdirSync(d).length;').length,
    0,
  );
});

/**
 * Files that use a directory-listing API, hold an fs module the guard cannot follow, or (FU-126) acquire
 * a module, `process` or the global object in a way it cannot prove, and predate the inventory. Each only shrinks: moving a file onto `authoredFiles` removes its line, and a file
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
// FU-126: loads a repository module (a workspace package's `dist/index.js`, a config, a fixture) by a path
// BUILT at run time. A non-literal specifier is unproven (`require(resolve())` may name fs: PR #772 r2 F1),
// so the file is listed instead of trusted. Each only shrinks; a literal `require('./x')` needs no row.

const LOADS_BY_BUILT_PATH = [
  'apps/web/src/app/demo-mode-pages.spec.ts',
  'apps/web/src/app/organization-switch.spec.ts',
  'apps/web/src/token-roles-screens.spec.ts',
  'packages/observability/src/__tests__/telemetry-boundary.fixture.ts',
  'scripts/check-db-runtime-privileges-boundary.pg.test.mjs',
  'scripts/check-kafka-topic-limits.mjs',
  'scripts/create-topics.broker.test.mjs',
  'scripts/dead-letter-escape.broker.test.mjs',
  'scripts/kafka-acl-generate.mjs',
  'scripts/kafka-topic-limits-lib.test.mjs',
  'scripts/outbox-b2-backfill.mjs',
  'scripts/outbox-b2-backfill.pg.test.mjs',
  'scripts/outbox-b2-prisma-port.mjs',
  'scripts/outbox-b3-protocol.pg.test.mjs',
  'scripts/replay-dlq-lib.test.mjs',
  'scripts/replay-dlq.mjs',
  'scripts/runtime-preflight.e2e.mjs',
  'scripts/verify-test-independence.mjs',
  'services/economic-service/test/settlement-acting-organization-rollback.int-spec.ts',
];
// FU-126: hands `process` / the global object on (dependency injection, a registry on `process`, an
// `Object.assign(globalThis, ...)` test setup), reads an internal on purpose (`_getActiveHandles`), names an
// escape as test data (a table of code snippets), or starts worker threads (`new Worker(code)` can eval).

const PASSES_GLOBALS_ON = [
  'apps/web/src/test/build-controller.mjs', // also loads the supervisor by a built URL
  'apps/web/src/test/setup.ts',
  'packages/config/src/command-failure.js',
  'packages/nest-common/src/lifecycle/graceful-shutdown.ts',
  'packages/testing/src/disclosure-guard.ts',
  'scripts/raw-http-boundary-rule.test.mjs',
  'scripts/test-stall-watchdog-worker.mjs',
  'scripts/test-stall-watchdog.mjs',
  'services/document-service/test/outbox-durable-claim.int-spec.ts',
];
const LISTING_ALLOWED = new Set([
  ...NO_GENERATED_TREE,
  ...COVERS_GENERATED_ON_PURPOSE,
  ...OTHER_CAPABILITY,
  ...LOADS_BY_BUILT_PATH,
  ...PASSES_GLOBALS_ON,
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
    NO_GENERATED_TREE.length +
      COVERS_GENERATED_ON_PURPOSE.length +
      OTHER_CAPABILITY.length +
      LOADS_BY_BUILT_PATH.length +
      PASSES_GLOBALS_ON.length,
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
