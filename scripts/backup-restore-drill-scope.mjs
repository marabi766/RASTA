// Full-drill inputs traced from backup-restore-drill-main.mjs (preflight, bootstrap,
// migration and seed), prisma.mjs and the seeds' repository imports. Deliberately
// cover whole input families, including future services and bootstrap scripts.
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DRILL_PATHS = [
  '**/*.prisma',
  '**/migrations/**',
  'services/*/prisma/**',
  '**/docker-compose*.yml',
  '**/docker-compose*.yaml',
  'infrastructure/docker/postgres/**',
  '.github/workflows/ci.yml',
  '.github/workflows/backup-drill-monthly.yml',
  'scripts/backup-restore-drill*',
  'scripts/prisma*',
  'scripts/infra-preflight-lib.mjs',
  'scripts/check-kafka-credential-scope-lib.mjs',
  'scripts/database-services.mjs',
  '.env*',
  'services/*/.env*',
  'services/*/tsconfig*.json',
  // Seeds import config/nest-common; the build includes their workspace dependencies.
  'packages/**',
  // The organization seed uses its repository/service; economic seeds the cutover.
  'services/organization-service/src/**',
  'services/economic-service/src/reward/evaluation-cutover.ts',
  'turbo.json',
  'tsconfig*.json',
];

// Scope runs before install. Read only the supported block forms; any new YAML
// representation refuses narrowing. Tests independently use the full YAML reader.
export function installPaths(source = readFileSync('pnpm-workspace.yaml', 'utf8')) {
  if (/\b(?:file|link):/.test(source)) throw Error('Unclassified local install input');
  const blocks = new Map();
  const knownKeys = new Set([
    'packages',
    'patchedDependencies',
    'catalog',
    'allowBuilds',
    'overrides',
    'blockExoticSubdeps',
    'minimumReleaseAge',
    'minimumReleaseAgeStrict',
    'minimumReleaseAgeExclude',
    'trustPolicy',
    'trustPolicyExclude',
  ]);
  let key;
  for (const line of source.split(/\r?\n/)) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    if (line.includes('\t')) throw Error('Unsupported workspace indentation');
    if (!line.startsWith(' ')) {
      if (!knownKeys.has(/^([A-Za-z][A-Za-z0-9]*):/.exec(line)?.[1]))
        throw Error('Unclassified workspace setting');
      const header = /^([A-Za-z][A-Za-z0-9]*):(?:\s+#.*)?$/.exec(line);
      key = header?.[1];
      if (/^['"]?(packages|patchedDependencies)['"]?:/.test(line) && !key)
        throw Error('Unsupported install input configuration');
      if (key) {
        if (blocks.has(key)) throw Error('Duplicate workspace key');
        blocks.set(key, []);
      }
    } else if (key) blocks.get(key).push(line);
  }
  const packages = blocks.get('packages');
  if (!packages?.length) throw Error('Missing workspace globs');
  const scalar = (value) => {
    const plain = value.replace(/^(['"])(.*)\1$/, '$2');
    if (
      !/^[A-Za-z0-9_@./*+-]+$/.test(plain) ||
      plain.split('/').some((part) => ['', '.', '..'].includes(part))
    )
      throw Error('Unsupported install path');
    return plain;
  };
  const paths = packages.map((line) => {
    const item = /^ {2}- (.+?)(?:\s+#.*)?$/.exec(line);
    if (!item) throw Error('Unsupported workspace glob');
    return `${scalar(item[1])}/package.*`;
  });
  for (const line of blocks.get('patchedDependencies') ?? []) {
    const entry = /^ {2}[^:]+: (.+?)(?:\s+#.*)?$/.exec(line);
    if (!entry) throw Error('Unsupported patch reference');
    paths.push(scalar(entry[1]));
  }
  return [...paths, '**/package.*', '**/.npmrc', '**/*pnpm*', '**/.yarnrc*'];
}

const match = (path, pattern) => {
  const expression = pattern
    .split(/(\*\*\/|\*\*|\*)/)
    .map((part) =>
      part === '**/'
        ? '(?:.*/)?'
        : part === '**'
          ? '.*'
          : part === '*'
            ? '[^/]*'
            : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    )
    .join('');
  return new RegExp(`^${expression}$`, 's').test(path);
};

// Only a proven ordinary PR may skip. Missing/malformed/fork metadata runs the
// drill; mq/train-* is unconditional, before any diff (including docs-only).
export function ordinaryPr(eventName, event, repository) {
  const pr = event?.pull_request;
  return (
    eventName === 'pull_request' &&
    typeof pr?.head?.ref === 'string' &&
    /^[\w./-]+$/.test(pr.head.ref) &&
    !pr.head.ref.startsWith('mq/') &&
    pr.head.repo?.full_name === repository &&
    typeof repository === 'string' &&
    repository.length > 0 &&
    pr.base?.ref === 'main' &&
    [pr.base.sha, pr.head.sha].every((sha) => /^[a-f0-9]{40}$/.test(sha ?? ''))
  );
}

export function shouldRun(eventName, event, repository, diff, inputs = installPaths) {
  if (!ordinaryPr(eventName, event, repository)) return true;
  try {
    // Hooks and legacy root pnpm settings can read arbitrary repository files.
    if (
      ['.pnpmfile.cjs', '.pnpmfile.mjs'].some((path) => existsSync(path)) ||
      /pnpmfile/.test(readFileSync('.npmrc', 'utf8')) ||
      JSON.parse(readFileSync('package.json', 'utf8')).pnpm
    )
      return true;
    const patterns = [...DRILL_PATHS, ...inputs()];
    const paths = diff(event.pull_request.base.sha, event.pull_request.head.sha);
    if (!Array.isArray(paths) || !paths.length) return true;
    return paths.some(
      (path) =>
        typeof path !== 'string' ||
        !path ||
        path.startsWith('/') ||
        path.split('/').includes('..') ||
        patterns.some((pattern) => match(path, pattern)) ||
        // Only ordinary documentation has a known irrelevant classification.
        // A patch may itself live under docs, so install inputs take precedence.
        !/^docs\/[A-Za-z0-9_./-]+\.md$/.test(path),
    );
  } catch {
    return true;
  }
}

export function gatePassed(eventName, event, repository, needs) {
  // A selector failure or missing answer never proves permission to skip.
  if (needs?.scope?.result !== 'success') return false;
  const selection = needs.scope.outputs?.run;
  if (selection === 'true') return needs.drill?.result === 'success';
  return (
    selection === 'false' &&
    ordinaryPr(eventName, event, repository) &&
    needs.drill?.result === 'skipped'
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const { GITHUB_EVENT_NAME: name, GITHUB_REPOSITORY: repository } = process.env;
  if (process.argv[2] === '--gate') {
    const passed = gatePassed(name, event, repository, JSON.parse(process.env.NEEDS));
    process.stdout.write(`Full backup restore drill gate: ${passed ? 'passed' : 'FAILED'}\n`);
    process.exitCode = passed ? 0 : 1;
  } else {
    const run = shouldRun(name, event, repository, (base, head) => {
      const output = execFileSync(
        'git',
        ['diff', '--no-renames', '--name-only', '-z', `${base}...${head}`, '--'],
        { encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024 },
      );
      if (!output.endsWith('\0')) throw new Error('Incomplete diff');
      return output.slice(0, -1).split('\0');
    });
    appendFileSync(process.env.GITHUB_OUTPUT, `run=${run}\n`);
    process.stdout.write(`Full backup restore drill selected: ${run}\n`);
  }
}
