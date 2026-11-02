import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import ts from 'typescript';

// Planning only: no task is executed and no .env file is sourced. Discard child
// diagnostics: a Git/Turbo error may include a configured remote or environment.
export function scopeRunner(cwd) {
  const env = { NODE_ENV: 'test', CI: 'true', TURBO_TELEMETRY_DISABLED: '1' };
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'SystemRoot']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return (command, args) => {
    try {
      // Invoke the installed CLI directly. Nested pnpm exec can auto-install
      // dependencies and prepend human output to Turbo's JSON.
      const executable = command === 'turbo' ? process.execPath : command;
      const argv =
        command === 'turbo' ? [join(cwd, 'node_modules/turbo/bin/turbo'), ...args] : args;
      return execFileSync(executable, argv, {
        cwd,
        env,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        timeout: 120_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      throw new Error('Prepush scope: Git/Turbo command failed; selection refused');
    }
  };
}

export function changedPaths(run, base) {
  const resolvedBase = run('git', [
    'rev-parse',
    '--verify',
    '--end-of-options',
    `${base}^{commit}`,
  ]).trim();
  const mergeBase = run('git', ['merge-base', 'HEAD', resolvedBase]).trim();
  if (![resolvedBase, mergeBase].every((sha) => /^[a-f0-9]{40,64}$/.test(sha))) {
    throw new Error('Prepush scope: invalid base; selection refused');
  }
  // Separate diffs preserve a committed change even if the working tree undoes
  // it. --no-renames reports BOTH rename endpoints, including deleted owners.
  const paths = new Set();
  for (const args of [
    ['diff', '--name-only', '-z', '--no-renames', mergeBase, 'HEAD', '--'],
    ['diff', '--cached', '--name-only', '-z', '--no-renames', '--'],
    ['diff', '--name-only', '-z', '--no-renames', '--'],
    ['ls-files', '--others', '--exclude-standard', '-z'],
  ]) {
    const output = run('git', args);
    if (output && !output.endsWith('\0')) throw new Error('Prepush scope: malformed Git paths');
    for (const path of output.split('\0').filter(Boolean)) paths.add(path);
  }
  return { resolvedBase, mergeBase, paths: [...paths].sort() };
}

function dryRun(run, filters = []) {
  const data = JSON.parse(
    run('turbo', ['run', 'lint', 'typecheck', 'test:unit', '--dry=json', ...filters]),
  );
  if (
    !Array.isArray(data.packages) ||
    !Array.isArray(data.tasks) ||
    data.packages.some(
      (name) => typeof name !== 'string' || (name !== '//' && !/^@[\w-]+\/[\w.-]+$/.test(name)),
    ) ||
    new Set(data.packages).size !== data.packages.length
  )
    throw new Error('Prepush scope: malformed Turbo selection');
  return data;
}

export function planScope({ run, base = 'origin/main', turboSource }) {
  const changes = changedPaths(run, base);
  const all = dryRun(run);
  if (!all.packages.length) throw new Error('Prepush scope: empty workspace');
  const tasks = all.tasks.filter((task) => task.task === 'test:unit');
  const byName = new Map();
  for (const task of tasks) {
    if (
      !all.packages.includes(task.package) ||
      byName.has(task.package) ||
      typeof task.directory !== 'string' ||
      !/^(apps|services|packages|tests)\/[^/]+$/.test(task.directory) ||
      !Array.isArray(task.resolvedTaskDefinition?.inputs) ||
      task.resolvedTaskDefinition.inputs.some((input) => typeof input !== 'string')
    )
      throw new Error('Prepush scope: malformed Turbo task');
    byName.set(task.package, task);
  }
  if (
    byName.size !== all.packages.length ||
    new Set(tasks.map((t) => t.directory)).size !== tasks.length
  ) {
    throw new Error('Prepush scope: incomplete workspace task inventory');
  }
  const parsed = ts.parseConfigFileTextToJson('turbo.json', turboSource);
  const globals = parsed.config?.globalDependencies;
  if (parsed.error || !Array.isArray(globals) || globals.some((g) => typeof g !== 'string' || !g)) {
    throw new Error('Prepush scope: unsupported global dependencies');
  }
  // Compare literal prefixes, not glob matches: includes added/deleted paths,
  // dotfiles and future glob forms. Negation also broadens; never subtracts.
  const prefixes = globals.map((g) => inputPrefix(g));
  const committed = dryRun(run, [`--filter=...[${changes.mergeBase}]`]);
  const selected = new Set(committed.packages);
  if ([...selected].some((name) => name !== '//' && !byName.has(name)))
    throw new Error('Prepush scope: unknown selected package');
  const readers = new Set();
  for (const task of all.tasks) {
    if (!byName.has(task.package) || !Array.isArray(task.resolvedTaskDefinition?.inputs))
      throw new Error('Prepush scope: malformed task inputs');
    if (
      task.resolvedTaskDefinition.inputs.some((input) => {
        if (typeof input !== 'string') throw new Error('Prepush scope: malformed input');
        return (
          input !== '$TURBO_DEFAULT$' &&
          changes.paths.some((path) =>
            path.startsWith(inputPrefix(input, byName.get(task.package).directory)),
          )
        );
      })
    )
      readers.add(task.package);
  }
  const broad = changes.paths.some(
    (path) =>
      path.startsWith('packages/') ||
      prefixes.some((prefix) => path.startsWith(prefix)) ||
      !tasks.some((task) => path.startsWith(`${task.directory}/`)),
  );
  if (broad || selected.has('//')) return { ...changes, packages: all.packages, broad: true };
  if (changes.paths.length) {
    for (const task of tasks) {
      // Every custom input owner is a possible cross-package source reader.
      // Deliberately broad, avoiding a second implementation of Turbo globs.
      if (
        readers.has(task.package) ||
        changes.paths.some((p) => p.startsWith(`${task.directory}/`))
      ) {
        selected.add(task.package);
      }
    }
  }
  const result = selected.size
    ? dryRun(
        run,
        [...selected].map((name) => `--filter=...${name}`),
      ).packages
    : [];
  if (
    result.some((name) => !byName.has(name)) ||
    [...selected].some((name) => !result.includes(name)) ||
    (changes.paths.length && !result.length)
  ) {
    throw new Error('Prepush scope: incomplete affected selection');
  }
  return { ...changes, packages: result, broad: false };
}

// A prefix is a superset of a glob. Unknown syntax stops the prefix early,
// selecting broadly; never try to reproduce Turbo's matching/exclusion rules.
function inputPrefix(input, directory = '') {
  let pattern = input.replace(/^!/, '');
  if (pattern.startsWith('$TURBO_ROOT$/')) {
    directory = '';
    pattern = pattern.slice('$TURBO_ROOT$/'.length);
  }
  if (pattern.startsWith('/') || pattern.includes('\\') || pattern.includes('$')) return '';
  const literal = pattern.match(/^[\w./-]*/)[0];
  if (pattern.slice(literal.length).includes('..')) return '';
  const prefix = posix.join(directory, literal);
  return prefix === '.' || prefix.startsWith('..') ? '' : prefix;
}

export function scopeFromRoot(root, base) {
  return planScope({
    run: scopeRunner(root),
    base,
    turboSource: readFileSync(`${root}/turbo.json`, 'utf8'),
  });
}
