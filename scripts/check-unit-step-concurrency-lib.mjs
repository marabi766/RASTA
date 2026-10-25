/**
 * Fails unless every invocation of the workspace's unit suites in CI is the
 * bounded one in the "Unit tests" step (or a named exception below), and that
 * step really runs and really fails the job.
 *
 *   node scripts/check-unit-step-concurrency.mjs   (the command-line wrapper)
 *
 * Why it is a gate: `turbo run test:unit` starts 10 package tasks at once by
 * default, and every jest in them opens its own worker pool. On the 4-vCPU
 * runner apps/web's axe specs then took ~8x their solo time, and a test over
 * jest's 5 s default failed the job (TASK 239/240; eleven web specs carry
 * `jest.setTimeout(20_000)` as symptom relief).
 *
 * What it holds (PR #450 r1, Codex F1: one named command was checked, so a
 * second unbounded invocation, a skipped step or a swallowed failure passed):
 *
 * 1. Every unit invocation is found by what it runs, not by the step's name:
 *    a package manager calling a unit script (`test:unit`, `test`, and any
 *    root script that reaches them, e.g. `verify`), turbo with the `test` or
 *    `test:unit` task (`pnpm exec turbo …`, `npx turbo …`), or
 *    `run-test-phases.mjs test` — in every step of every job of every workflow
 *    and in any local composite action. `test:unit` spelled anywhere else in
 *    a workflow (an env value, an `echo`) is refused too.
 * 2. Exactly one is bounded: `pnpm run test:unit --concurrency=<1-3>`, the
 *    whole `run:` of ci.yml's quality / "Unit tests" (its duration is the
 *    tracked metric). Any other invocation must be an entry of
 *    UNBOUNDED_EXCEPTIONS, matched by workflow, job, step and exact line; an
 *    entry that matches nothing is refused as stale.
 * 3. Each of those steps runs unconditionally and propagates failure: no
 *    `if:` on the step, its job or any job it needs; no `continue-on-error`
 *    on the step or job; the default or `bash` shell (both `-e`); no working
 *    directory; no shell start-up variable in its env; and no construct in its
 *    script that skips or absorbs the line (`||`, `set +`, `exit`, `trap`,
 *    `!`, `&`, control flow, here-documents, continuations, `source`/`eval`,
 *    an open quote).
 * 4. The root `test:unit` script is `turbo run test:unit`, so the flag reaches
 *    turbo and not the packages' jest/node:test runners.
 *
 * What it cannot see: what a called program does (a package script, a shell
 * script). Static: reads the workflow and action files and package.json only.
 */
import { parse as parseYaml } from 'yaml';

export const MAX_CONCURRENCY = 3;
/** The one bounded invocation, and the step whose duration is reported. */
export const BOUNDED = { workflow: 'ci.yml', job: 'quality', step: 'Unit tests' };
const BOUNDED_COMMAND = /^pnpm run test:unit --concurrency=(\d+)$/;
export const ROOT_UNIT_SCRIPT = 'turbo run test:unit';

/**
 * Unit invocations that keep turbo's default concurrency, each with its
 * reason. `trustedLines` are lines of the same step exempt from the script
 * checks, with the reason in `reason`.
 */
export const UNBOUNDED_EXCEPTIONS = [
  {
    workflow: 'ci.yml',
    job: 'integration-security',
    step: 'Tenant isolation and authorization tests',
    command:
      'pnpm run test -- --testNamePattern="(tenant|isolation|authorization|subtree visibility)"',
    trustedLines: [
      'kafka_credentials="$(bash infrastructure/docker/kafka/kafka-credentials.sh tests)"',
      'eval "${kafka_credentials}"',
    ],
    reason:
      'TASK 240 bounded the unit step only and did not measure this phase (most tests are ' +
      'filtered out by the pattern; 48 tasks in 2m38 with builds, no timeout seen); bounding ' +
      'it is a PM decision. The eval runs kafka-credentials.sh `tests` output, which is ' +
      "`export NAME='value'` lines only.",
  },
];

/** Package managers whose next non-option word may be a script name. */
const PACKAGE_MANAGERS = new Set(['pnpm', 'npm', 'yarn', 'bun']);
/** After these, the words belong to another program (`pnpm exec playwright test`). */
const OTHER_PROGRAM = new Set(['exec', 'dlx', '--']);
const TURBO_UNIT_TASKS = new Set(['test', 'test:unit']);
const PHASES_UNIT_TASKS = new Set(['test']);
const UNIT_TOKEN = /(?<![\w:.-])test:unit(?![\w:.-])/;
/** Variables bash reads at start-up: they could switch errexit off before the script. */
const SHELL_STARTUP_ENV = ['BASH_ENV', 'ENV', 'SHELLOPTS', 'BASHOPTS'];

const oddCount = (line, quote) => (line.match(quote)?.length ?? 0) % 2 === 1;

/** Constructs that can skip an invocation line or absorb its failure. */
const SCRIPT_HAZARDS = [
  [/\|\|/, '`||` (`|| true` absorbs the failure)'],
  [/\bset\s+\+/, '`set +…` (turns errexit or pipefail off)'],
  [/\b(?:exit|return|trap)\b/, '`exit`/`return`/`trap` (can end the script with 0)'],
  [/(?:^|[;&|(])\s*(?:!|exec)\s/m, 'a leading `!` or `exec` (inverts or replaces the shell)'],
  [/(?:^|[^&>])&(?![&>])/m, 'a `&` background job (its exit code is not waited for)'],
  [
    /\b(?:if|then|elif|else|fi|while|until|for|do|done|case|esac|function)\b|\(\)\s*\{/,
    'shell control flow (the line may not run, or its status may be tested away)',
  ],
  [/<</, 'a here-document (the line becomes text)'],
  [/\\$/m, 'a `\\` continuation (the line becomes arguments of the previous one)'],
  [
    /\b(?:source|eval)\b|(?:^|[;&|(])\s*\.\s/m,
    '`source`/`.`/`eval` (runs code the guard cannot see)',
  ],
  [
    {
      test: (script) =>
        script.split('\n').some((line) => oddCount(line, /(?<!\\)"/g) || oddCount(line, /'/g)),
    },
    'an open quote (the line becomes part of a string)',
  ],
];

/** The simple commands of a script, split at newlines and shell operators. */
const commandsOf = (script) =>
  script
    .split(/&&|\|\||\$\(|[;&|\n()`]/)
    .map((command) => command.trim())
    .filter(Boolean);

/** A command's words with quotes and escapes removed. */
const wordsOf = (command) =>
  command
    .split(/\s+/)
    .map((word) => word.replace(/["'\\{}]/g, ''))
    .filter(Boolean);

/** Whether one simple command runs unit suites; `unitScripts` are script names. */
export function invokesUnitTests(command, unitScripts) {
  const words = wordsOf(command);
  for (const [index, word] of words.entries()) {
    const program = word.split('/').pop();
    const targets = PACKAGE_MANAGERS.has(program)
      ? unitScripts
      : program === 'turbo'
        ? TURBO_UNIT_TASKS
        : program === 'run-test-phases.mjs'
          ? PHASES_UNIT_TASKS
          : null;
    if (targets === null) continue;
    for (const next of words.slice(index + 1)) {
      if (OTHER_PROGRAM.has(next)) break;
      // `@rasta/web#test:unit` is turbo's package-qualified task.
      if (targets.has(next.split('#').pop())) return true;
    }
  }
  return false;
}

/**
 * The script names that run unit suites: `test` and `test:unit`, and every
 * root script that reaches them or the turbo task (to a fixed point).
 */
export function unitScriptNames(rootScripts) {
  const names = new Set(['test', 'test:unit']);
  for (let grew = true; grew;) {
    grew = false;
    for (const [name, body] of Object.entries(rootScripts ?? {})) {
      if (names.has(name) || typeof body !== 'string') continue;
      if (commandsOf(body).some((command) => invokesUnitTests(command, names))) {
        names.add(name);
        grew = true;
      }
    }
  }
  return names;
}

const needsOf = (job) => (job?.needs === undefined ? [] : [job.needs].flat());

/** `jobId` and every job it needs, directly or not. */
function jobAndNeeds(jobs, jobId) {
  const seen = new Set();
  const pending = [jobId];
  while (pending.length > 0) {
    const id = pending.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    pending.push(...needsOf(jobs?.[id]));
  }
  return [...seen];
}

const setOtherThanFalse = (value) => value !== undefined && value !== false;

/** Why `step` might not run, or might not fail its job when the tests fail. */
export function executionProblems(workflow, jobId, step, trustedLines = []) {
  const jobs = workflow.jobs;
  const job = jobs[jobId];
  const problems = [];
  if (step.if !== undefined) problems.push(`has \`if: ${step.if}\` (the step may be skipped)`);
  for (const id of jobAndNeeds(jobs, jobId)) {
    if (jobs[id]?.if !== undefined) {
      problems.push(`job "${id}" has \`if: ${jobs[id].if}\` (the job may be skipped)`);
    }
  }
  if (setOtherThanFalse(step['continue-on-error'])) {
    problems.push('has step-level `continue-on-error` (a failure would not fail the job)');
  }
  if (setOtherThanFalse(job['continue-on-error'])) {
    problems.push(`job "${jobId}" has \`continue-on-error\` (a failure would not fail the run)`);
  }
  const shell = step.shell ?? job.defaults?.run?.shell ?? workflow.defaults?.run?.shell;
  if (shell !== undefined && shell !== 'bash') {
    problems.push(
      `runs under \`shell: ${shell}\` (only the default or \`bash\` executes it with -e)`,
    );
  }
  const directory =
    step['working-directory'] ??
    job.defaults?.run?.['working-directory'] ??
    workflow.defaults?.run?.['working-directory'];
  if (directory !== undefined && directory !== '.') {
    problems.push(`runs in \`working-directory: ${directory}\` (not the workspace root)`);
  }
  for (const env of [step.env, job.env, workflow.env]) {
    for (const name of SHELL_STARTUP_ENV) {
      if (env !== null && typeof env === 'object' && Object.hasOwn(env, name)) {
        problems.push(`sets ${name} (bash reads it before the script)`);
      }
    }
  }
  const script = String(step.run)
    .split('\n')
    .filter((line) => !trustedLines.includes(line.trim()))
    .join('\n');
  for (const [hazard, why] of SCRIPT_HAZARDS) {
    if (hazard.test(script)) problems.push(`its script has ${why}`);
  }
  return problems;
}

/** Every step with a `run:` in a workflow (`jobs`) or composite action (`runs`). */
function* runSteps(file, doc) {
  if (file.startsWith('actions/')) {
    for (const [index, step] of (doc?.runs?.steps ?? []).entries()) {
      if (typeof step?.run === 'string') yield { jobId: null, index, step };
    }
    return;
  }
  for (const [jobId, job] of Object.entries(doc?.jobs ?? {})) {
    for (const [index, step] of (Array.isArray(job?.steps) ? job.steps : []).entries()) {
      if (typeof step?.run === 'string') yield { jobId, index, step };
    }
  }
}

/** Every string in `node` with its path, `run:` values included. */
function* stringsOf(node, path) {
  if (typeof node === 'string') yield { path, value: node };
  else if (node !== null && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) yield* stringsOf(value, `${path}.${key}`);
  }
}

/**
 * Problems with the CI unit invocations; empty when they hold.
 * `files` maps `<name>.yml` (workflows) and `actions/<path>` (composite
 * actions) to their text; `rootScripts` is package.json's `scripts`.
 */
export function unitStepProblems(files, rootScripts) {
  const docs = {};
  for (const [file, text] of Object.entries(files)) {
    try {
      // GitHub has no merge keys, but resolving them keeps a `<<:` from hiding a key here.
      docs[file] = parseYaml(text, { merge: true });
    } catch (error) {
      docs[file] = error instanceof Error ? error : new Error(String(error));
    }
  }
  return parsedProblems(docs, rootScripts);
}

/** `unitStepProblems` over parsed documents; an `Error` stands for an unreadable file. */
export function parsedProblems(docs, rootScripts) {
  const problems = [];
  if (rootScripts?.['test:unit'] !== ROOT_UNIT_SCRIPT) {
    problems.push(
      `package.json "test:unit" must be \`${ROOT_UNIT_SCRIPT}\` so the CI flag reaches turbo; ` +
        `it is ${JSON.stringify(rootScripts?.['test:unit'])}`,
    );
  }
  const unitScripts = unitScriptNames(rootScripts);
  const exceptionUses = new Map(UNBOUNDED_EXCEPTIONS.map((entry) => [entry, 0]));
  let bounded = 0;
  for (const [file, doc] of Object.entries(docs)) {
    if (doc instanceof Error) {
      problems.push(`${file}: not readable YAML (${doc.message.split('\n')[0]})`);
      continue;
    }
    /** `path\nline` of every line accepted as an invocation; `test:unit` elsewhere is refused. */
    const accepted = new Set();
    for (const { jobId, index, step } of runSteps(file, doc)) {
      const where = `${file} ${jobId === null ? 'runs' : `jobs.${jobId}`}.steps[${index}] (${JSON.stringify(step.name ?? null)})`;
      const lines = step.run
        .split('\n')
        .filter((line) =>
          commandsOf(line).some((command) => invokesUnitTests(command, unitScripts)),
        );
      if (lines.length === 0) continue;
      const atBounded =
        file === BOUNDED.workflow && jobId === BOUNDED.job && step.name === BOUNDED.step;
      let trustedLines = [];
      for (const line of lines) {
        const command = line.trim();
        const exception = UNBOUNDED_EXCEPTIONS.find(
          (entry) =>
            entry.workflow === file &&
            entry.job === jobId &&
            entry.step === step.name &&
            entry.command === command,
        );
        const match = BOUNDED_COMMAND.exec(command);
        if (atBounded && match && step.run.trim() === command) {
          const concurrency = Number(match[1]);
          if (concurrency < 1 || concurrency > MAX_CONCURRENCY) {
            problems.push(`${where}: concurrency ${concurrency} is outside 1..${MAX_CONCURRENCY}`);
          }
          bounded += 1;
        } else if (exception) {
          exceptionUses.set(exception, exceptionUses.get(exception) + 1);
          trustedLines = exception.trustedLines;
        } else {
          problems.push(
            `${where}: runs unit suites with ${JSON.stringify(command)}; only ` +
              `\`pnpm run test:unit --concurrency=<1-${MAX_CONCURRENCY}>\`, alone in ` +
              `${BOUNDED.workflow} ${BOUNDED.job} / "${BOUNDED.step}", or an UNBOUNDED_EXCEPTIONS ` +
              "entry may (turbo's default of 10 oversubscribes the runner)",
          );
          continue;
        }
        accepted.add(`.jobs.${jobId}.steps.${index}.run\n${line}`);
      }
      if (jobId === null) continue;
      for (const problem of executionProblems(doc, jobId, step, trustedLines)) {
        problems.push(`${where}: ${problem}`);
      }
    }
    for (const { path, value } of stringsOf(doc, '')) {
      for (const line of value.split('\n')) {
        if (UNIT_TOKEN.test(line) && !accepted.has(`${path}\n${line}`)) {
          problems.push(
            `${file} ${path.slice(1)}: mentions test:unit outside an accepted invocation`,
          );
        }
      }
    }
  }
  if (bounded !== 1) {
    problems.push(
      `${BOUNDED.workflow} ${BOUNDED.job} must have exactly one "${BOUNDED.step}" step running ` +
        `only \`pnpm run test:unit --concurrency=<1-${MAX_CONCURRENCY}>\`, found ${bounded}`,
    );
  }
  for (const [entry, uses] of exceptionUses) {
    if (uses !== 1) {
      problems.push(
        `UNBOUNDED_EXCEPTIONS ${entry.workflow} ${entry.job} / "${entry.step}" must match ` +
          `exactly one line, matched ${uses}: update or remove the entry`,
      );
    }
  }
  return problems;
}
