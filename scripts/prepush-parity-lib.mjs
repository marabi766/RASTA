import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { parse } from 'yaml';
import { scopeFromRoot } from './prepush-scope-lib.mjs';

const refuse = () => {
  throw new Error('Prepush parity: execution or CI coverage refused');
};
// A refusal about the pinned pnpm inputs. Its message names only fixed text and package.json
// keys (JSON-quoted), never a value, so the CLI may print it.
export class PnpmInputRefusal extends Error {
  name = 'PnpmInputRefusal';
}
const refuseInput = (reason) => {
  throw new PnpmInputRefusal(`Prepush parity: pnpm inputs refused: ${reason}`);
};
const load = (root, file) => readFileSync(`${root}/${file}`, 'utf8');

// Pin all workflow context and all quality-job values, not just key names.
// Repository pnpm inputs are pinned with normalized line endings; new settings require review.
// FU-111: the one `quality` job is five parallel `quality-*` jobs and an aggregate named
// `quality`. The manifest pins every one of them and their steps in this order; a quality job
// the manifest does not list, or one it lists that is gone, refuses (fail closed), so no step
// of the family can be added, moved or dropped without an explicit entry and reason.
export const QUALITY_JOBS = [
  'quality-guards',
  'quality-lint',
  'quality-types',
  'quality-unit',
  'quality-build',
  'quality',
];
const pnpmFiles = ['package.json', 'pnpm-workspace.yaml', '.npmrc'];
const isMapping = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

// FU-093: root package.json is pinned by a projection, not by its whole-file digest, so a PR that
// adds or edits a script no quality job reaches does not invalidate every other PR's pin.
//
// The projection (PACKAGE_JSON_PROJECTION) is { fields, scripts }:
//   fields   every top-level key except `scripts`, verbatim (packageManager, engines, a future
//            `pnpm` key, dependencies, name, ...): an unknown key is pinned, never skipped;
//   scripts  the root scripts the quality-* jobs can run, derived (not listed by hand): every
//            `pnpm run <name>` in a quality-* step's `run`, every root script those reach the
//            same way, the pre/post hook of each, and the lifecycle scripts `pnpm install` runs.
// The pin is one sha256 per entry of the canonical JSON (recursively sorted keys, no
// whitespace) of its value, so independent edits touch independent pin lines. A referenced
// script that is missing, a package manager invocation whose root scripts cannot be named, a
// malformed package.json, or a whole-file pin (the pre-FU-093 form) refuses.
// `node scripts/prepush-parity-repin.mjs` rewrites the pins with packageJsonPin() below.
export const PACKAGE_JSON_PROJECTION = 'root-scripts-reached-by-quality-jobs/v1';
const LIFECYCLE = [
  'pnpm:devPreinstall',
  'preinstall',
  'install',
  'postinstall',
  'preprepare',
  'prepare',
  'postprepare',
];
const PACKAGE_MANAGER = /\b(?:pnpm|pnpx|npm|npx|yarn|corepack)\b/g;
const COMMAND_SEPARATOR = /&&|\|\||\$\(|[\n;|&()`]/;
// A script name, never an option: `-w` after `--filter` would run the root's own script.
const SCRIPT_NAME = /^[A-Za-z0-9:_][A-Za-z0-9:_-]*$/;
const WORKSPACE_PACKAGE = /^@rasta\/[a-z0-9-]+$/;
// A command word that runs a string or an expansion could run the package manager unseen.
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const INDIRECT_COMMAND = /[$`]|^(?:eval|exec|source|\.|sh|bash|dash|zsh|xargs|command|builtin)$/;

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isMapping(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

// Root scripts one shell text runs through the package manager: [name, required][]. Only the
// shapes below are understood; any other mention of a package manager refuses, because what it
// runs cannot be named (fail closed).
function rootScriptsRun(text, where, rootName) {
  const found = [];
  for (const segment of text.split(COMMAND_SEPARATOR)) {
    const words = segment.trim().split(/\s+/);
    const command = words.find((word) => !ENV_ASSIGNMENT.test(word));
    if (command !== undefined && INDIRECT_COMMAND.test(command))
      refuseInput(`${where} runs a command through an expansion or a shell string`);
    const mentions = segment.match(PACKAGE_MANAGER) ?? [];
    if (mentions.length === 0) continue;
    const at = words.indexOf('pnpm');
    const args = words.slice(at + 1);
    if (mentions.length === 1 && at >= 0) {
      if (args.length === 2 && args[0] === 'install' && args[1] === '--frozen-lockfile') {
        found.push(...LIFECYCLE.map((name) => [name, false]));
        continue;
      }
      if (args.length === 2 && args[0] === 'run' && SCRIPT_NAME.test(args[1])) {
        found.push([args[1], true]);
        continue;
      }
      // Another workspace's own script: not a root script.
      if (
        args.length >= 3 &&
        args[0] === '--filter' &&
        WORKSPACE_PACKAGE.test(args[1]) &&
        args[1] !== rootName &&
        args.slice(2).every((word) => SCRIPT_NAME.test(word))
      )
        continue;
    }
    refuseInput(`${where} runs a package manager command whose root scripts cannot be named`);
  }
  return found;
}

export function qualityRuns(workflow) {
  const { jobs } = parse(workflow) ?? {};
  if (!isMapping(jobs)) refuseInput('the CI workflow has no jobs');
  const runs = [];
  for (const id of QUALITY_JOBS) {
    if (!isMapping(jobs[id]) || !Array.isArray(jobs[id].steps))
      refuseInput(`CI job ${JSON.stringify(id)} has no steps`);
    for (const step of jobs[id].steps) {
      if (!isMapping(step)) refuseInput(`CI job ${JSON.stringify(id)} has a malformed step`);
      if (step.run === undefined) continue;
      if (typeof step.run !== 'string')
        refuseInput(`CI job ${JSON.stringify(id)} has a malformed run`);
      runs.push({ where: `CI job ${JSON.stringify(id)}`, text: step.run });
    }
  }
  return runs;
}

export function packageJsonProjection(text, runs) {
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch {
    refuseInput('package.json is not valid JSON');
  }
  if (!isMapping(manifest) || !isMapping(manifest.scripts))
    refuseInput('package.json has no scripts mapping');
  const { scripts, ...fields } = manifest;
  if (Object.values(scripts).some((body) => typeof body !== 'string'))
    refuseInput('package.json has a script that is not a string');
  const reached = new Map();
  const visit = ([name, required], where) => {
    if (reached.has(name)) return;
    if (!Object.hasOwn(scripts, name)) {
      if (required) refuseInput(`${where} runs script ${JSON.stringify(name)}, which is missing`);
      return;
    }
    reached.set(name, scripts[name]);
    for (const hook of [`pre${name}`, `post${name}`]) visit([hook, false], where);
    const inner = `script ${JSON.stringify(name)}`;
    for (const next of rootScriptsRun(scripts[name], inner, manifest.name)) visit(next, inner);
  };
  for (const { where, text: run } of runs)
    for (const next of rootScriptsRun(run, where, manifest.name)) visit(next, where);
  for (const name of LIFECYCLE) visit([name, false], 'pnpm install');
  return { fields, scripts: Object.fromEntries(reached) };
}

const digestEach = (values) =>
  Object.fromEntries(
    Object.keys(values)
      .sort()
      .map((key) => [key, sha256(canonicalJson(values[key]))]),
  );

export function packageJsonPin(text, runs) {
  const { fields, scripts } = packageJsonProjection(text, runs);
  return {
    projection: PACKAGE_JSON_PROJECTION,
    fields: digestEach(fields),
    scripts: digestEach(scripts),
  };
}

// The pins the manifest must hold for these inputs; shared by the check and the repin helper.
export function pnpmInputPins(workflow, pnpmInputs) {
  const pins = {};
  for (const file of pnpmFiles) {
    if (typeof pnpmInputs?.[file] !== 'string') refuseInput(`${file} is missing`);
    pins[file] =
      file === 'package.json'
        ? packageJsonPin(pnpmInputs[file], qualityRuns(workflow))
        : sha256(pnpmInputs[file].replace(/\r\n?/g, '\n'));
  }
  return pins;
}

function checkPnpmInputs(workflow, pinned, pnpmInputs) {
  const actual = pnpmInputPins(workflow, pnpmInputs);
  if (!isMapping(pinned)) refuseInput('the manifest has no pnpmInputs mapping');
  const pin = pinned['package.json'];
  if (typeof pin === 'string')
    refuseInput(
      'package.json is pinned by a whole-file digest, which is no longer accepted (FU-093); repin with node scripts/prepush-parity-repin.mjs',
    );
  if (!isMapping(pin) || pin.projection !== PACKAGE_JSON_PROJECTION)
    refuseInput(`package.json pin is not the ${PACKAGE_JSON_PROJECTION} projection`);
  if (isDeepStrictEqual(actual, pinned)) return;
  const changed = [];
  for (const file of new Set([...Object.keys(actual), ...Object.keys(pinned)])) {
    if (file !== 'package.json') {
      if (actual[file] !== pinned[file]) changed.push(JSON.stringify(file));
      continue;
    }
    for (const part of ['fields', 'scripts']) {
      const now = actual[file][part];
      const was = isMapping(pin[part]) ? pin[part] : {};
      for (const key of new Set([...Object.keys(now), ...Object.keys(was)]))
        if (now[key] !== was[key]) changed.push(`package.json ${part} ${JSON.stringify(key)}`);
    }
    if (Object.keys(pin).some((key) => !['projection', 'fields', 'scripts'].includes(key)))
      changed.push('package.json pin keys');
  }
  refuseInput(
    `changed since the reviewed pin: ${changed.join(', ')}; review, then repin with node scripts/prepush-parity-repin.mjs`,
  );
}
export function validateParity(workflow, manifest, scripts, pnpmInputs) {
  const { jobs, ...context } = parse(workflow);
  if (manifest?.version !== 3) refuse();
  if (!isDeepStrictEqual(context, manifest.workflow)) refuse();
  if (!isMapping(jobs) || !isMapping(manifest.jobs)) refuse();
  const family = Object.keys(jobs).filter((id) => id === 'quality' || id.startsWith('quality-'));
  if (!isDeepStrictEqual([...family].sort(), [...QUALITY_JOBS].sort())) refuse();
  if (!isDeepStrictEqual(Object.keys(manifest.jobs), QUALITY_JOBS)) refuse();
  const steps = [];
  for (const id of QUALITY_JOBS) {
    if (!isMapping(jobs[id]) || !Array.isArray(jobs[id].steps)) refuse();
    const { steps: jobSteps, ...job } = jobs[id];
    if (!isDeepStrictEqual(job, manifest.jobs[id])) refuse();
    steps.push(...jobSteps.map((step) => ({ id, step })));
  }
  if (!Array.isArray(manifest.steps)) refuse();
  if (steps.length !== manifest.steps.length) refuse();
  checkPnpmInputs(workflow, manifest.pnpmInputs, pnpmInputs);
  const checks = [];
  for (const [index, { id, step }] of steps.entries()) {
    const entry = manifest.steps[index];
    if (entry?.job !== id) refuse();
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
