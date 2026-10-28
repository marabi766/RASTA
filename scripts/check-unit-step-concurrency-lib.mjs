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
 * Covered static syntax: LF/CRLF/CR, backslash-newline continuations outside
 * single quotes, shell word-start comments outside quotes, quoted/escaped words,
 * and command separators ; && || | and newlines (also & and parentheses).
 * Literal pnpm [run] test[:unit], turbo [run] test[:unit] (direct or via
 * pnpm exec/dlx or npx), and node/direct run-test-phases.mjs test are checked.
 * Launcher options are limited to LAUNCHER_OPTIONS below; unknown options before
 * the command fail loudly. This is not arbitrary-shell, environment-resolution
 * or root-script alias analysis.
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

/** One extractor for every run block; source stays exact for the exception identity. */
function* logicalCommands(script) {
  script = script.replace(/\r\n?/g, '\n');
  let words = [];
  let word = '';
  let started = false;
  let quote = null;
  let source = '';
  const endWord = () => {
    if (started) words.push(word);
    word = '';
    started = false;
  };
  for (let i = 0; i < script.length; i += 1) {
    const char = script[i];
    const next = script[i + 1];
    if (char === '\\' && quote !== "'") {
      if (next === '\n') {
        source += char + next;
        i += 1;
        continue;
      }
      if (next && (!quote || /[\\"$`]/.test(next))) {
        word += next;
        source += char + next;
        started = true;
        i += 1;
        continue;
      }
    }
    if (quote) {
      source += char;
      if (char === quote) quote = null;
      else word += char;
      continue;
    }
    // A hash starts a comment only at the start of an unquoted, unescaped word.
    if (char === '#' && !started) {
      while (i < script.length && script[i] !== '\n') source += script[i++];
      i -= 1;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      source += char;
    } else if (/[;|&()\n]/.test(char)) {
      endWord();
      if (words.length) yield { words, source: source.trim() };
      words = [];
      source = '';
      if ((char === '&' || char === '|') && next === char) i += 1;
    } else if (/\s/.test(char)) {
      endWord();
      source += char;
    } else {
      started = true;
      word += char;
      source += char;
    }
  }
  endWord();
  if (words.length) yield { words, source: source.trim() };
}

// Explicit arity: 0 is a switch, 1 consumes a value (also --name=value).
// Deliberately finite: a new launcher option needs review and a regression case.
const LAUNCHER_OPTIONS = {
  pnpm: {
    '-w': 0,
    '--workspace-root': 0,
    '-r': 0,
    '--recursive': 0,
    '-s': 0,
    '--silent': 0,
    '--reporter': 1,
    '--filter': 1,
    '-F': 1,
    '--dir': 1,
    '-C': 1,
    '--workspace-root-dir': 1,
  },
  'pnpm run': {
    '-r': 0,
    '--recursive': 0,
    '--parallel': 0,
    '--stream': 0,
    '--aggregate-output': 0,
    '--if-present': 0,
    '--silent': 0,
    '--filter': 1,
    '-F': 1,
    '--workspace-concurrency': 1,
    '--reporter': 1,
  },
  'pnpm exec': {
    '-r': 0,
    '--recursive': 0,
    '--parallel': 0,
    '--shell-mode': 0,
    '-c': 0,
  },
  'pnpm dlx': {
    '--package': 1,
    '-p': 1,
    '--allow-build': 1,
    '--silent': 0,
    '--reporter': 1,
  },
  npx: {
    '--no-install': 0,
    '--yes': 0,
    '-y': 0,
    '--no': 0,
    '--package': 1,
    '-p': 1,
    '--cache': 1,
  },
  node: {
    '--no-warnings': 0,
    '--trace-warnings': 0,
    '--enable-source-maps': 0,
    '--require': 1,
    '-r': 1,
    '--import': 1,
    '--loader': 1,
    '--conditions': 1,
    '-C': 1,
    '--env-file': 1,
    '-e': 1,
    '--eval': 1,
    '-p': 1,
    '--print': 1,
  },
  turbo: {
    '--filter': 1,
    '-F': 1,
    '--cache-dir': 1,
    '--concurrency': 1,
    '--cwd': 1,
    '--force': 0,
    '--no-cache': 0,
    '--parallel': 0,
  },
};

function optionWidth(words, i, launcher) {
  const [name, ...inlineValue] = words[i].split('=');
  const arity = LAUNCHER_OPTIONS[launcher][name];
  if (arity === undefined) throw new Error(`unrecognised launcher option: ${launcher} ${name}`);
  if (arity === 0 && inlineValue.length)
    throw new Error(`launcher switch must not take a value: ${launcher} ${name}`);
  if (arity === 1 && !(inlineValue.length ? inlineValue.join('=') : words[i + 1]))
    throw new Error(`missing launcher option value: ${launcher} ${name}`);
  return arity === 1 && !inlineValue.length ? 2 : 1;
}

function afterOptions(words, launcher) {
  let i = 0;
  while (words[i]?.startsWith('-') && words[i] !== '--') {
    const width = optionWidth(words, i, launcher);
    // Node's eval/print value is the program; later words are its arguments.
    // Evaluating that code is outside this literal-file tripwire's scope.
    if (launcher === 'node' && ['-e', '--eval', '-p', '--print'].includes(words[i].split('=')[0]))
      return [];
    i += width;
  }
  if (words[i] === '--') i += 1;
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
    args = afterOptions(args, 'pnpm');
    if (['exec', 'dlx'].includes(args[0]))
      return unbounded(afterOptions(args.slice(1), `pnpm ${args[0]}`));
    if (args[0] === 'run') args = afterOptions(args.slice(1), 'pnpm run');
    return ['test', 'test:unit'].includes(args[0]);
  }
  if (program === 'npx') return unbounded(afterOptions(args, 'npx'));
  if (program === 'turbo') {
    args = afterOptions(args, 'turbo');
    if (args[0] === 'run') args = args.slice(1);
    const tasks = [];
    for (let i = 0; i < args.length && args[i] !== '--';) {
      if (args[i].startsWith('-')) i += optionWidth(args, i, 'turbo');
      else tasks.push(args[i++]);
    }
    // Bounds may precede "run" too, so inspect the original argument list.
    return (
      tasks.some((word) => ['test', 'test:unit'].includes(word)) && !turboBounded(words.slice(1))
    );
  }
  if (program === 'node') [program, ...args] = afterOptions(args, 'node');
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
      // Keep the accepted exception's whole-line identity, even in compound commands.
      const exactLines = new Set(
        step.run
          .replace(/\r\n?/g, '\n')
          .split('\n')
          .map((line) => line.trim()),
      );
      for (const { words, source } of logicalCommands(step.run)) {
        try {
          if (!unbounded(words)) continue;
        } catch (error) {
          problems.push(`${where}: ${error.message}`);
          continue;
        }
        const exception = UNBOUNDED_EXCEPTIONS.find(
          (entry) =>
            entry.workflow === file &&
            entry.job === jobId &&
            entry.step === step.name &&
            entry.command === source &&
            exactLines.has(entry.command),
        );
        if (exception) exceptionUses.set(exception, exceptionUses.get(exception) + 1);
        else problems.push(`${where}: literal unbounded unit invocation: ${source}`);
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
