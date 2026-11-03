import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { parse } from 'yaml';
import { scopeFromRoot } from './prepush-scope-lib.mjs';

const refuse = () => {
  throw new Error('Prepush parity: execution or CI coverage refused');
};
const load = (root, file) => readFileSync(`${root}/${file}`, 'utf8');

// Compare the whole executable step, including env, shell, conditions and
// failure handling. No regex that silently ignores a new command spelling.
export function validateParity(workflow, manifest, scripts) {
  const job = parse(workflow)?.jobs?.quality;
  if (
    job?.name !== 'Lint, types and unit tests' ||
    !Array.isArray(job.steps) ||
    !job.steps.length ||
    manifest?.version !== 1 ||
    !Array.isArray(manifest.steps) ||
    !isDeepStrictEqual(Object.keys(job).sort(), manifest.jobKeys) ||
    !isDeepStrictEqual(job.env, manifest.jobEnv) ||
    job.steps.length !== manifest.steps.length
  )
    refuse();
  const checks = [];
  for (const [index, step] of job.steps.entries()) {
    const entry = manifest.steps[index];
    if (!isDeepStrictEqual(step, entry.ci)) refuse();
    if (entry.script !== undefined) {
      if (
        entry.reason !== undefined ||
        step.run !== `pnpm run ${entry.script}` ||
        step.env !== undefined ||
        step.if !== undefined ||
        step['continue-on-error'] !== undefined ||
        typeof entry.command !== 'string' ||
        scripts[entry.script] !== entry.command ||
        !/^node --test scripts\/prepush-(scope|parity)\.test\.mjs$/.test(entry.command)
      )
        refuse();
      checks.push(entry);
    } else if (typeof entry.reason !== 'string' || !entry.reason.trim()) refuse();
  }
  if (
    !['test:prepush-scope', 'test:prepush-parity'].every((name) =>
      checks.some((c) => c.script === name),
    ) ||
    new Set(checks.map((c) => c.script)).size !== checks.length
  )
    refuse();
  return checks;
}

export function controlledEnv(base) {
  if (!/^[a-f0-9]{40,64}$/.test(base)) refuse();
  const env = {
    NODE_ENV: 'test',
    CI: 'true',
    TURBO_TELEMETRY_DISABLED: '1',
    SERVICE_ENV_WITHHELD_BASE: base,
  };
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'SystemRoot']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

export function executeCheck(root, entry, env) {
  // The audited direct Node command avoids package-manager hooks and shell
  // startup files. Neither inherited NODE_OPTIONS nor root .env is loaded.
  execFileSync(process.execPath, entry.command.split(' ').slice(1), {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
    maxBuffer: 64 * 1024 * 1024,
  });
}

// Inputs are root + base only. A previously printed selection is never accepted.
export function runParity(
  root,
  base,
  {
    select = scopeFromRoot,
    execute = executeCheck,
    read = load,
    report = (line) => process.stdout.write(`${line}\n`),
  } = {},
) {
  const scope = select(root, base);
  const env = controlledEnv(scope.resolvedBase);
  const inputs = () => [
    read(root, '.github/workflows/ci.yml'),
    JSON.parse(read(root, 'scripts/prepush-parity.json')),
    JSON.parse(read(root, 'package.json')).scripts,
  ];
  const before = inputs();
  const checks = validateParity(...before);
  const receipts = [];
  for (const entry of checks) {
    report(`CI quality / ${entry.ci.name ?? entry.script}: ${entry.script}`);
    const expected = { script: entry.script, command: entry.command, env: { ...env } };
    execute(root, entry, { ...env });
    receipts.push(expected); // Only after successful synchronous execution.
  }
  const after = inputs();
  if (!isDeepStrictEqual(before, after)) refuse();
  const finalScope = select(root, scope.resolvedBase);
  if (!isDeepStrictEqual(scope, finalScope)) refuse();
  validateParity(...after);
  if (
    !isDeepStrictEqual(
      receipts,
      checks.map((entry) => ({
        script: entry.script,
        command: entry.command,
        env,
      })),
    )
  )
    refuse();
  const exclusions = before[1].steps.filter((entry) => entry.reason);
  for (const entry of exclusions)
    report(`EXCLUDED ${entry.ci.name ?? entry.ci.run ?? entry.ci.uses}: ${entry.reason}`);
  report(
    `Parity slice only: ${receipts.length} checks passed; ${exclusions.length} explicit exclusions. Full prepush gate remains incomplete.`,
  );
  return { scope, receipts, exclusions };
}
