/**
 * Tripwire for accidental regressions of the bound in static workflow text.
 * The bound is constructed once in package.json's test:unit:ci script.
 * This is NOT a security boundary or a proof of shell execution/failure handling.
 * Workflow changes are reviewed code; code review handles deliberate evasion.
 *
 * Out of scope by design (review r2): set -n / set -o noexec, set -e +e,
 * command/builtin exec, cd, startup files exported through $GITHUB_ENV,
 * BASH_ENV and fromJSON env, eval of a reassigned credential variable,
 * dynamic commands via env/matrix (including composites/reusable workflows),
 * versioned npx/pnpm dlx launchers, and aliases running recursive Jest.
 * No shell semantics, environment resolution or root-script alias analysis.
 */
import { parse as parseYaml } from 'yaml';

export const BOUNDED = { workflow: 'ci.yml', job: 'quality', step: 'Unit tests' };
export const BOUNDED_COMMAND = 'pnpm run test:unit:ci';

export const UNBOUNDED_EXCEPTIONS = [
  {
    workflow: 'ci.yml',
    job: 'integration-security',
    step: 'Tenant isolation and authorization tests',
    command:
      'pnpm run test -- --testNamePattern="(tenant|isolation|authorization|subtree visibility)"',
    reason: 'The filtered integration-security phase is outside the measured quality unit step.',
  },
];

/** Small literal tokenizer: quoted words stay together; only command positions count. */
function commandsOf(script) {
  return script.match(/"(?:\\.|[^"\\])*"|'[^']*'|&&|\|\||[;|&()\n]|[^\s;|&()]+/g) ?? [];
}

function* commands(script) {
  let words = [];
  for (const token of commandsOf(script)) {
    if (/^(?:&&|\|\||[;|&()\n])$/.test(token)) {
      if (words.length) yield words;
      words = [];
    } else words.push(token.replace(/^(?:"(.*)"|'(.*)')$/, '$1$2'));
  }
  if (words.length) yield words;
}

/** Skip only familiar package-manager options, including their value positions. */
function afterOptions(words) {
  let i = 0;
  while (words[i]?.startsWith('-') && words[i] !== '--') {
    i += /^(?:--filter|-F|--dir|-C|--workspace-root-dir)$/.test(words[i]) ? 2 : 1;
  }
  return words.slice(i);
}

const positiveInteger = (value) => /^[1-9]\d*$/.test(value ?? '');
function turboBounded(words) {
  const beforeSeparator = words.slice(0, words.includes('--') ? words.indexOf('--') : words.length);
  const bounds = [];
  for (let i = 0; i < beforeSeparator.length; i += 1) {
    const word = beforeSeparator[i];
    if (word === '--concurrency') bounds.push(beforeSeparator[++i]);
    else if (word.startsWith('--concurrency=')) bounds.push(word.slice('--concurrency='.length));
  }
  return bounds.length === 1 && positiveInteger(bounds[0]);
}

/** Literal launchers only; arguments to other programs are never searched as commands. */
function unbounded(words) {
  let [program, ...args] = words;
  if (program === 'pnpm') {
    args = afterOptions(args);
    if (args[0] === 'exec' && args[1] === 'turbo') return unbounded(args.slice(1));
    if (args[0] === 'run') args = afterOptions(args.slice(1));
    return ['test', 'test:unit'].includes(args[0]);
  }
  if (program === 'npx' && args[0] === 'turbo') return unbounded(args);
  if (program === 'turbo') {
    if (args[0] === 'run') args = args.slice(1);
    const tasks = [];
    for (let i = 0; i < args.length && args[i] !== '--'; i += 1) {
      if (/^(?:--filter|-F|--cache-dir|--concurrency|--cwd)$/.test(args[i])) i += 1;
      else if (!args[i].startsWith('-')) tasks.push(args[i]);
    }
    return tasks.some((word) => ['test', 'test:unit'].includes(word)) && !turboBounded(args);
  }
  if (program === 'node') [program, ...args] = args;
  return program?.split('/').pop() === 'run-test-phases.mjs' && args[0] === 'test';
}

/** Steps in workflows and local composite metadata, regardless of its directory. */
export function* stepsOf(doc) {
  for (const [jobId, job] of Object.entries(doc?.jobs ?? {})) {
    for (const step of Array.isArray(job?.steps) ? job.steps : []) yield { jobId, job, step };
  }
  for (const step of Array.isArray(doc?.runs?.steps) ? doc.runs.steps : []) {
    yield { jobId: null, job: {}, step };
  }
}

export function unitStepProblems(files, rootScripts) {
  const docs = {};
  for (const [file, text] of Object.entries(files)) {
    try {
      docs[file] =
        text instanceof Error ? text : parseYaml(text.replace(/\r\n?/g, '\n'), { merge: true });
    } catch (error) {
      docs[file] = error;
    }
  }
  return parsedProblems(docs, rootScripts);
}

export function parsedProblems(docs, rootScripts) {
  const problems = [];
  // Exactly one Turbo command/flag; no forwarded flag or conflicting second bound.
  if (!/^turbo run test:unit --concurrency=[1-9]\d*$/.test(rootScripts?.['test:unit:ci'] ?? '')) {
    problems.push(
      'package.json test:unit:ci must be turbo run test:unit --concurrency=<positive integer>',
    );
  }
  const exceptionUses = new Map(UNBOUNDED_EXCEPTIONS.map((entry) => [entry, 0]));
  let bounded = 0;
  for (const [file, doc] of Object.entries(docs)) {
    if (doc instanceof Error || !doc || typeof doc !== 'object' || Array.isArray(doc)) {
      problems.push(`${file}: not readable YAML document`);
      continue;
    }
    for (const { jobId, job, step } of stepsOf(doc)) {
      const where = `${file} ${jobId ?? 'composite'} / ${step.name ?? '(unnamed)'}`;
      const atBounded =
        file === BOUNDED.workflow && jobId === BOUNDED.job && step.name === BOUNDED.step;
      if (atBounded) {
        bounded += 1;
        if (step.run?.trim() !== BOUNDED_COMMAND)
          problems.push(`${where}: run must be exactly ${BOUNDED_COMMAND}`);
        for (const [label, node] of [
          ['step', step],
          ['job', job],
        ]) {
          for (const key of ['if', 'continue-on-error']) {
            if (Object.hasOwn(node, key)) problems.push(`${where}: ${label} must not set ${key}`);
          }
        }
      }
      if (typeof step.run !== 'string') continue;
      for (const line of step.run.split('\n')) {
        if (!Array.from(commands(line)).some(unbounded)) continue;
        const exception = UNBOUNDED_EXCEPTIONS.find(
          (entry) =>
            entry.workflow === file &&
            entry.job === jobId &&
            entry.step === step.name &&
            entry.command === line.trim(),
        );
        if (exception) exceptionUses.set(exception, exceptionUses.get(exception) + 1);
        else problems.push(`${where}: literal unbounded unit invocation: ${line.trim()}`);
      }
    }
  }
  if (bounded !== 1)
    problems.push(`quality must have exactly one Unit tests step, found ${bounded}`);
  for (const [entry, count] of exceptionUses) {
    if (count !== 1)
      problems.push(
        `exception ${entry.workflow} ${entry.job} / ${entry.step} must match exactly once, found ${count}`,
      );
  }
  return problems;
}
