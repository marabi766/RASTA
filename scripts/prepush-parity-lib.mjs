import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { parse } from 'yaml';
import { scopeFromRoot } from './prepush-scope-lib.mjs';

const refuse = () => {
  throw new Error('Prepush parity: execution or CI coverage refused');
};
const load = (root, file) => readFileSync(`${root}/${file}`, 'utf8');

// Pin all workflow context and all quality-job values, not just key names.
// Repository pnpm inputs are pinned with normalized line endings; new settings require review.
const pnpmFiles = ['package.json', 'pnpm-workspace.yaml', '.npmrc'];
export function validateParity(workflow, manifest, scripts, pnpmInputs) {
  const { jobs, ...context } = parse(workflow);
  const { steps, ...job } = jobs.quality;
  if (manifest?.version !== 2) refuse();
  if (!isDeepStrictEqual(context, manifest.workflow)) refuse();
  if (!isDeepStrictEqual(job, manifest.job)) refuse();
  if (!Array.isArray(manifest.steps)) refuse();
  if (steps.length !== manifest.steps.length) refuse();
  const digests = Object.fromEntries(
    pnpmFiles.map((file) => [
      file,
      createHash('sha256').update(pnpmInputs[file].replace(/\r\n?/g, '\n')).digest('hex'),
    ]),
  );
  if (!isDeepStrictEqual(digests, manifest.pnpmInputs)) refuse();
  const checks = [];
  for (const [index, step] of steps.entries()) {
    const entry = manifest.steps[index];
    if (!isDeepStrictEqual(step, entry.ci)) refuse();
    if (entry.script !== undefined) {
      if (
        entry.reason !== undefined ||
        !isDeepStrictEqual(Object.keys(step).sort(), ['name', 'run']) ||
        step.run !== `pnpm run ${entry.script}` ||
        ['pre', 'post'].some((prefix) => scripts[`${prefix}${entry.script}`] !== undefined) ||
        scripts[entry.script] !== entry.command ||
        entry.command !==
          `node --test --test-timeout=300000 scripts/${entry.script.slice(5)}.test.mjs`
      )
        refuse();
      checks.push(entry);
    } else if (!entry.reason?.trim()) refuse();
  }
  if (
    !isDeepStrictEqual(
      checks.map((c) => c.script),
      ['test:prepush-scope', 'test:prepush-parity'],
    )
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
    Object.fromEntries(pnpmFiles.map((file) => [file, read(root, file)])),
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
  const exclusions = before[1].steps.filter((entry) => entry.reason);
  for (const entry of exclusions)
    report(`EXCLUDED ${entry.ci.name ?? entry.ci.run ?? entry.ci.uses}: ${entry.reason}`);
  report(
    `Parity slice only: ${receipts.length} checks passed; ${exclusions.length} explicit exclusions. Full prepush gate remains incomplete.`,
  );
  return { scope, receipts, exclusions };
}
