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
 * Finite modelled lexical grammar (everything else REFUSES with its construct):
 * LF/CRLF/CR; space/tab; backslash escapes/continuations; single/double quotes;
 * word-start comments; literal words; ; && || | & and newline separators;
 * balanced () / standalone {} groups; control-word prefixes; assignments;
 * < > >> <& >& redirects; << / <<- with literal bare/single/double-quoted
 * alphanumeric/underscore delimiters and isolated DATA payloads. Shell stdin
 * and shell command strings refuse, including heredocs piped to a shell.
 * Simple $name / ${name} / positional parameters and GitHub expressions are
 * opaque dynamic atoms; balanced $(commands) uses this same lexer recursively.
 * Their resolved values/field splitting are outside the dynamic scope above.
 * ANSI-C/locale quotes, dangling escapes/quotes, process substitution, arithmetic,
 * backticks, complex parameter/brace/pathname/tilde expansion, here-strings and
 * unsupported operators refuse. Quoted literals do not acquire shell syntax.
 * Literal pnpm [run] test[:unit], turbo [run] test[:unit] (direct or via
 * pnpm exec/dlx, implicit pnpm dispatch or npx), and node/direct phase-runner
 * calls are checked. All executable positions use one basename normalizer.
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
function logicalCommands(script) {
  script = script.replace(/\r\n?/g, '\n');
  const commands = [];
  let i = 0;
  const refuse = (construct) => {
    throw new Error(`unsupported shell construct: ${construct}`);
  };
  const scan = (closing = null) => {
    let words = [];
    let word = '';
    let started = false;
    let quote = null;
    let source = '';
    let redirect = false;
    let shellInput = false;
    const heredocs = [];
    const endWord = () => {
      if (started) {
        if (!redirect) words.push(word);
        redirect = false;
      }
      word = '';
      started = false;
    };
    const endCommand = () => {
      endWord();
      if (redirect) refuse('missing redirection target');
      if (words.length) commands.push({ words, source: source.trim(), shellInput });
      words = [];
      source = '';
      shellInput = false;
    };
    while (i < script.length) {
      const char = script[i];
      const next = script[i + 1];
      if (char === '\\' && quote !== "'") {
        if (!next) refuse('dangling backslash');
        if (next === '\n') {
          source += char + next;
          i += 2;
          continue;
        }
        if (!quote || /[\\"$`]/.test(next)) {
          word += next;
          source += char + next;
          started = true;
          i += 2;
          continue;
        }
      }
      if (quote === "'") {
        source += char;
        if (char === quote) quote = null;
        else word += char;
        i += 1;
        continue;
      }
      // Expansion boundaries are lexical; resolved values are never executed.
      if (char === '$') {
        if (!quote && (next === "'" || next === '"'))
          refuse(next === "'" ? 'ANSI-C quoting' : 'locale quoting');
        if (next === '[') refuse('legacy arithmetic expansion');
        const begin = i;
        if (next === '(') {
          if (script[i + 2] === '(') refuse('arithmetic expansion');
          i += 2;
          scan(')');
        } else if (next === '{') {
          const github = script[i + 2] === '{';
          const end = script.indexOf(github ? '}}' : '}', i + 2);
          if (end < 0)
            refuse(github ? 'unbalanced GitHub expression' : 'unbalanced parameter expansion');
          if (
            !github &&
            !/^(?:[A-Za-z_][A-Za-z_0-9]*|[0-9@*#?$!-])$/.test(script.slice(i + 2, end))
          )
            refuse('complex parameter expansion');
          i = end + (github ? 2 : 1);
        } else {
          const parameter = script.slice(i + 1).match(/^(?:[A-Za-z_][A-Za-z_0-9]*|[0-9@*#?$!-])/);
          if (!parameter) {
            // In double quotes these are literal dollars beside quote marks.
            // Every other unknown prefix refuses, including a continuation
            // that might assemble a different dollar construct after joining.
            if (!quote || !['"', "'"].includes(next)) refuse('unrecognised dollar construct');
            word += '$';
            source += char;
            started = true;
            i += 1;
            continue;
          }
          i += 1 + parameter[0].length;
        }
        word += '\0'; // An opaque atom cannot accidentally equal a literal command.
        source += script.slice(begin, i);
        started = true;
        continue;
      }
      if (char === '`') refuse('backtick command substitution');
      if (quote) {
        source += char;
        if (char === quote) quote = null;
        else word += char;
        i += 1;
        continue;
      }
      if (char === '#' && !started) {
        while (i < script.length && script[i] !== '\n') source += script[i++];
        continue;
      }
      if (char === '"' || char === "'") {
        quote = char;
        started = true;
        source += char;
      } else if (char === '<' || char === '>') {
        if (next === '(') refuse('process substitution');
        if (redirect) refuse('missing redirection target');
        // A directly attached numeric file descriptor is not a command word.
        if (/^\d+$/.test(word)) {
          word = '';
          started = false;
        }
        endWord();
        const begin = i;
        if (script.startsWith('<<<', i)) refuse('here-string');
        if (script.startsWith('<<', i)) {
          i += 2;
          const tabs = script[i] === '-';
          if (tabs) i += 1;
          if (/^[ \t]*\$['"]/.test(script.slice(i))) refuse('ANSI-C/locale heredoc delimiter');
          const delimiter = script
            .slice(i)
            .match(
              /^[ \t]*(?:'([A-Za-z_0-9]+)'|"([A-Za-z_0-9]+)"|([A-Za-z_0-9]+))(?=[ \t\n;|&)]|$)/,
            );
          if (!delimiter) refuse('unsupported heredoc delimiter');
          heredocs.push({ delimiter: delimiter[1] ?? delimiter[2] ?? delimiter[3], tabs });
          heredocs[heredocs.length - 1].quoted = Boolean(delimiter[1] ?? delimiter[2]);
          shellInput = true;
          i += delimiter[0].length;
        } else {
          i += 1;
          if (next === char || next === '&') i += 1;
          if (/[<>|]/.test(script[i] ?? '')) refuse('unsupported redirection operator');
          redirect = true;
        }
        source += script.slice(begin, i);
        continue;
      } else if (char === '(' || (char === '{' && !started && /[ \t\n]/.test(next ?? ''))) {
        if (char === '(' && next === '(') refuse('arithmetic command');
        if (char === '(' && /[?*+!@]$/.test(word)) refuse('extended pathname expansion');
        if (char === '(' && word.includes('=')) refuse('array assignment');
        endCommand();
        i += 1;
        scan(char === '(' ? ')' : '}');
        continue;
      } else if (char === ')' || char === '}') {
        if (closing !== char) refuse(`unbalanced group ${char}`);
        endCommand();
        if (heredocs.length) refuse('unbalanced heredoc');
        i += 1;
        return;
      } else if (/[;|&\n]/.test(char)) {
        if (char === '&' && next === '>') refuse('combined output redirection');
        if ((char === '&' || char === '|') && next === char && script[i + 2] === char)
          refuse('unsupported control operator');
        if ((char === ';' && /[;&]/.test(next ?? '')) || (char === '|' && next === '&'))
          refuse('unsupported control operator');
        endCommand();
        i += 1;
        if ((char === '&' || char === '|') && next === char) i += 1;
        if (char === '\n') {
          for (const { delimiter, tabs, quoted } of heredocs) {
            let found = false;
            while (i < script.length) {
              const end = script.indexOf('\n', i);
              const line = script.slice(i, end < 0 ? script.length : end);
              i = end < 0 ? script.length : end + 1;
              if ((tabs ? line.replace(/^\t+/, '') : line) === delimiter) {
                found = true;
                break;
              }
              if (!quoted && /[$`\\]/.test(line)) refuse('unquoted heredoc expansion or escape');
            }
            if (!found) refuse(`unbalanced heredoc ${delimiter}`);
          }
          heredocs.length = 0;
        }
        continue;
      } else if (char === ' ' || char === '\t') {
        endWord();
        source += char;
      } else {
        // Assignments do not undergo pathname expansion; [ and ] delimit test.
        if (char === '{') refuse('brace expansion');
        if (char === '~') refuse('tilde expansion');
        if (!/[A-Za-z0-9_./:@%=+,#!?*[\]-]/.test(char))
          refuse(`unmodelled character ${JSON.stringify(char)}`);
        if (
          '?*['.includes(char) &&
          !/^[A-Za-z_][A-Za-z_0-9]*=/.test(word) &&
          !(char === '[' && !started && /[ \t]/.test(next ?? ''))
        )
          refuse('pathname expansion');
        started = true;
        word += char;
        source += char;
      }
      i += 1;
    }
    if (quote) refuse(`unterminated ${quote === "'" ? 'single' : 'double'} quote`);
    if (heredocs.length) refuse('unbalanced heredoc');
    if (closing) refuse(`unbalanced group ${closing}`);
    endCommand();
  };
  scan();
  return commands;
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

// Built-ins/aliases from the pinned pnpm 11.22.0 command inventory.
// Root scripts take precedence over implicit exec;
// neither this inventory nor a script's body is executable/alias resolution.
const PNPM_BUILTINS = new Set(
  `access add adduser approve-builds audit bin bugs c cache cat-file cat-index change ci clean
   clean-install completion config create dedupe deploy deprecate dislink dist-tag dist-tags dlx
   docs doctor edit env exec fetch find find-hash get help home i ic ignored-builds import info
   init install install-clean install-test issues it la lane licenses link list ll ln login logout
   ls m multi outdated owner owners pack pack-app patch patch-commit patch-remove peers ping pkg
   prefix profile prune publish purge rb rebuild recursive remove repo restart rm root rt run run-script
   runtime s sbom se search self-update set set-script setup show ss stage star stars store
   team token un undeprecate uni uninstall unlink unpublish unstar up update upgrade v version
   view whoami why with xmas`.split(/\s+/),
);
const executable = (word) => word?.split('/').pop();

/** Literal launchers only; arguments to other programs are never searched as commands. */
function unbounded(words, rootScripts, shellInput = false) {
  while (
    /^[A-Za-z_][A-Za-z_0-9]*=/.test(words[0] ?? '') ||
    ['if', 'then', 'elif', 'else', 'do', 'while', 'until', '!'].includes(words[0])
  )
    words = words.slice(1);
  let [program, ...args] = words;
  program = executable(program);
  if (program === 'pnpm') {
    args = afterOptions(args, 'pnpm');
    if (['exec', 'dlx'].includes(args[0]))
      return unbounded(afterOptions(args.slice(1), `pnpm ${args[0]}`), rootScripts, shellInput);
    if (['run', 'run-script'].includes(args[0]))
      return ['test', 'test:unit'].includes(afterOptions(args.slice(1), 'pnpm run')[0]);
    if (['test', 'test:unit', 't'].includes(args[0])) return true;
    if (!args[0] || PNPM_BUILTINS.has(args[0]) || Object.hasOwn(rootScripts ?? {}, args[0]))
      return false;
    return unbounded(afterOptions(args, 'pnpm exec'), rootScripts, shellInput);
  }
  if (program === 'npx') return unbounded(afterOptions(args, 'npx'), rootScripts, shellInput);
  if (
    ['bash', 'sh', 'dash', 'zsh', 'ksh'].includes(program) &&
    (shellInput || !args[0] || args[0].startsWith('-') || /^\/dev\/(stdin|fd\/0)$/.test(args[0]))
  )
    throw new Error('unsupported shell construct: shell stdin or command string');
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
  return executable(program) === 'run-test-phases.mjs' && args[0] === 'test';
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
      let commands;
      try {
        commands = logicalCommands(step.run);
      } catch (error) {
        problems.push(`${where}: ${error.message}`);
        continue;
      }
      for (const { words, source, shellInput } of commands) {
        try {
          if (!unbounded(words, rootScripts, shellInput)) continue;
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
