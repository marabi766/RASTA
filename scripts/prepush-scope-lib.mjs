import { execFileSync } from 'node:child_process';
import { accessSync, constants, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
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
      // Resolve only; never load Turbo's JS launcher (it can run npm install).
      const executable = command === 'turbo' ? installedTurbo(cwd) : command;
      const argv = args;
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

function installedTurbo(cwd) {
  const platform = { linux: 'linux', darwin: 'darwin', win32: 'windows' }[process.platform];
  const arch = { x64: '64', arm64: 'arm64' }[process.arch];
  if (!platform || !arch) throw new Error('Unsupported Turbo platform');
  const rootRequire = createRequire(join(cwd, 'package.json'));
  const turboRequire = createRequire(realpathSync(rootRequire.resolve('turbo/package.json')));
  const suffix = `${platform}-${arch}/bin/turbo${platform === 'windows' ? '.exe' : ''}`;
  for (const prefix of ['@turbo/', 'turbo-']) {
    try {
      const binary = turboRequire.resolve(`${prefix}${suffix}`);
      accessSync(binary, constants.X_OK);
      return binary;
    } catch {
      // Try the other installed package spelling, never an installer or shim.
    }
  }
  throw new Error('Missing installed native Turbo binary');
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
  // Build the reverse package graph from ALL tasks, including prerequisites.
  // Filtered dry-runs are not evidence that their own closure is complete.
  const graph = new Map();
  for (const task of all.tasks) {
    if (
      !byName.has(task.package) ||
      task.taskId !== `${task.package}#${task.task}` ||
      graph.has(task.taskId) ||
      !Array.isArray(task.dependencies) ||
      !Array.isArray(task.resolvedTaskDefinition?.inputs) ||
      task.resolvedTaskDefinition.inputs.some((input) => typeof input !== 'string')
    )
      throw new Error('Prepush scope: malformed task graph');
    graph.set(task.taskId, task);
  }
  for (const task of graph.values()) {
    if (task.dependencies.some((id) => typeof id !== 'string' || !graph.has(id)))
      throw new Error('Prepush scope: incomplete task graph');
  }
  const closure = (seeds) => {
    const result = new Set(seeds);
    let previousSize;
    do {
      previousSize = result.size;
      for (const task of graph.values()) {
        if (task.dependencies.some((id) => result.has(graph.get(id).package)))
          result.add(task.package);
      }
    } while (result.size !== previousSize);
    return result;
  };
  const validate = (packages, seeds = packages) => {
    if (
      packages.some((name) => !byName.has(name)) ||
      [...closure(seeds)].some((name) => !packages.includes(name))
    )
      throw new Error('Prepush scope: incomplete dependent selection');
  };
  const committed = dryRun(run, [`--filter=...[${changes.mergeBase}]`]);
  const selected = new Set(committed.packages);
  if ([...selected].some((name) => name !== '//' && !byName.has(name)))
    throw new Error('Prepush scope: unknown selected package');
  if (selected.has('//')) return { ...changes, packages: all.packages, broad: true };
  validate(committed.packages);
  for (const task of tasks) {
    if (changes.paths.some((path) => path.startsWith(`${task.directory}/`)))
      selected.add(task.package);
  }
  const result = selected.size
    ? dryRun(
        run,
        [...selected].map((name) => `--filter=...${name}`),
      ).packages
    : [];
  validate(result, selected);
  // Until repository-read coverage is enforced, ANY workspace may contain an
  // undeclared reader. Include them all; input declarations alone cannot prove
  // a narrow selection safe, even for a new file or a new test package.
  if (changes.paths.length) return { ...changes, packages: all.packages, broad: true };
  return { ...changes, packages: result, broad: false };
}

export function scopeFromRoot(root, base) {
  return planScope({
    run: scopeRunner(root),
    base,
    turboSource: readFileSync(`${root}/turbo.json`, 'utf8'),
  });
}
