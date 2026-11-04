/**
 * Task 310: a `node --test` run that hangs holds the quality job to its limit
 * (main 3fa1beeb, run 41562129261: 43 minutes in a step that takes ~80 s).
 * Fail closed, by class:
 *
 *  - EVERY `node --test` that a quality-job step runs, directly or through any
 *    `pnpm run <script>` chain, carries `--test-timeout=<ms>` (at most
 *    MAX_FILE_BUDGET_MS). On Node 22 the parent runner enforces it on each test
 *    FILE as a whole, and it kills a child that spins in a synchronous loop, which
 *    a timer inside the stuck process cannot do. A missing, zero, non-numeric or
 *    oversized value is refused.
 *  - The unit-step concurrency step, the one that hung, also has its own
 *    `timeout-minutes` (an external bound, for a runner that is itself stuck) and
 *    preloads the per-test stall watchdog that names the stuck test.
 *
 * The commands are PARSED (quotes, comments, separators, command substitution),
 * never matched as text, so what is checked is what the shell would run: a
 * budget in a comment, in a quoted payload or after the file arguments (Node
 * ignores options after the first file) does not count, exactly one finite
 * `--test-timeout=<ms>` must precede the files, and only the command forms below
 * are understood. Anything else - a path or wrapper around node, `pnpm exec`,
 * `npx`, `sh -c`, a pnpm call with options or arguments, a computed word, an
 * unlisted node option, a redirection - is refused, never assumed bounded.
 *
 * ONE scanner (parseCommands) reads every command of the guard and of the watchdog
 * check, and it refuses what it does not fully understand instead of skipping it: a
 * parameter expansion with anything but a plain name, `$((`, `$'..'`, here-documents,
 * and escapes or comments inside a command substitution. The execution context is
 * resolved at every level (workflow `defaults.run`, job `defaults.run`, the step's
 * `shell`/`working-directory`, `env` names the shell reads, local `uses`): see
 * contextProblems.
 *
 * A step limit on every one of the quality job's ~35 `node --test` steps cannot
 * exist: the job budget rule (ci-integration-split-lib.mjs) adds step limits to the
 * job's setup allowance, and 35 limits do not fit in the job.
 */
export const MAX_FILE_BUDGET_MS = 540_000;
export const UNIT_STEP = {
  job: 'quality',
  step: 'Unit-step concurrency is bounded',
  script: 'test:unit-step-concurrency',
  maxMinutes: 10,
  watchdog: './scripts/test-stall-watchdog.mjs',
};
/** Scripts the guard does not read, each with the reason; a stale entry is refused. */
export const EXEMPT_SCRIPTS = {
  'lint:scripts':
    'lint-scripts-registration.test.mjs pins its command shape (an option after --test throws)',
};

/** Commands that never run a root script or `node --test` by themselves. */
const INERT_COMMANDS = new Set(['echo', 'true', 'turbo', 'eslint', 'prettier']);
/** Words the shell treats as syntax in front of a command. */
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{', 'time']);
const CLOSERS = new Set(['fi', 'done', 'esac', '}']);
/** `pnpm install` is the only pnpm built-in a quality step may use. */
const PNPM_BUILTINS = new Set(
  'add audit dlx env exec i install link list ls node outdated pack publish rebuild remove rm store up update x'.split(
    ' ',
  ),
);
/** Package scripts a workspace-targeted pnpm call may run; others cannot be read here. */
const PACKAGE_SCRIPTS = new Set(['build', 'typecheck', 'lint']);
const NODE_PLAIN_OPTIONS = new Set(['--test', '--no-warnings', '--enable-source-maps']);
const NODE_VALUE_OPTIONS = /^--(?:test-concurrency|env-file|env-file-if-exists)=/;
const SCRIPT_NAME = /^[A-Za-z0-9][A-Za-z0-9:_.-]*$/;
const BUDGET = /^[1-9][0-9]{0,8}$/;
const MAX_DEPTH = 4;

/** `${NAME}`, `${1}`, `${@}`: the only parameter expansions that cannot run or hide a command. */
const PLAIN_EXPANSION = /^\{(?:[A-Za-z_][A-Za-z0-9_]*|[0-9]+|[@*#?!$-])\}/;

/**
 * Tokenize shell text into commands of words {value, dynamic}. `dynamic` marks a word
 * the shell computes ($var, globs, braces); command substitutions are parsed by the
 * SAME scanner, in place (quotes, escapes and comments decide where one ends), and
 * their commands are returned with the others. `problems` lists everything the scanner
 * does not fully understand - it refuses, it never skips: a parameter expansion with an
 * operator (`${X:-$(cmd)}`, `${{ expr }}`), `$((`, `$[`, `$'..'`, `$".."`, a here-document,
 * a redirection, and a backslash or a comment inside a command substitution (where the
 * end of the substitution is no longer decided by plain bracket matching).
 * Text after a refused construct is still scanned, so commands after it are still seen.
 */
export function parseCommands(text) {
  const out = { commands: [], problems: [] };
  scan(String(text), 0, 0, 'top', out);
  return out;
}

/** Scans `text` from `from`; `mode` is top level, `$( )` or a backtick body. Returns the index it stopped at. */
function scan(text, from, depth, mode, out) {
  const { commands, problems } = out;
  const refuse = (reason) => {
    if (!problems.includes(reason)) problems.push(reason);
  };
  const inside = mode !== 'top';
  let words = [];
  let word = null;
  let parens = 0;
  const endWord = () => {
    if (word) words.push(word);
    word = null;
  };
  const endCommand = () => {
    endWord();
    if (words.length) commands.push(words);
    words = [];
  };
  const add = (char) => {
    word ??= { value: '', dynamic: false };
    word.value += char;
  };
  const markDynamic = () => {
    add('');
    word.dynamic = true;
    word.cut ??= word.value.length; // the literal part before the first computed character
  };
  const nested = (start, nestedMode) => {
    // `start` indexes the first character after the opening bracket; returns where it stopped.
    markDynamic();
    if (depth >= MAX_DEPTH) {
      refuse('command substitutions nested too deeply');
      return text.length;
    }
    if (nestedMode === 'paren') {
      const end = scan(text, start, depth + 1, 'paren', out);
      if (end >= text.length) refuse('unterminated command substitution');
      return end;
    }
    let end = start;
    while (end < text.length && text[end] !== '`') end += text[end] === '\\' ? 2 : 1;
    if (end >= text.length) {
      refuse('unterminated command substitution');
      end = text.length;
    }
    // The body is cut out first, then read as a command line of its own.
    scan(text.slice(start, end), 0, depth + 1, 'tick', out);
    return end;
  };
  const dollar = (at) => {
    // `at` indexes the `$`; returns the index of the last character of the expansion.
    const rest = text.slice(at + 1);
    if (rest.startsWith('((') || rest.startsWith('[')) {
      refuse('an arithmetic expansion');
      markDynamic();
      return rest.startsWith('[') ? at + 1 : at; // its content is still scanned
    }
    if (rest.startsWith('(')) return nested(at + 2, 'paren');
    if (rest.startsWith('{')) {
      markDynamic();
      const plain = PLAIN_EXPANSION.exec(rest);
      if (plain) return at + plain[0].length;
      refuse('a parameter expansion with an operator, subscript or nested text');
      return at + 1; // what follows is still scanned
    }
    if (rest.startsWith("'") || rest.startsWith('"')) {
      refuse('ANSI-C or locale quoting');
      markDynamic();
      return at;
    }
    markDynamic();
    return at + (/^(?:[A-Za-z_][A-Za-z0-9_]*|[0-9@*#?!$-])/.exec(rest)?.[0].length ?? 0);
  };
  for (let at = from; at < text.length; at++) {
    const char = text[at];
    if (char === '\\') {
      if (inside) refuse('a backslash inside a command substitution');
      if (text[at + 1] === '\n') at++;
      else if (at + 1 < text.length) add(text[++at]);
    } else if (char === "'") {
      const end = text.indexOf("'", at + 1);
      if (end < 0) {
        refuse('unterminated quote');
        break;
      }
      add('');
      for (const c of text.slice(at + 1, end)) add(c);
      at = end;
    } else if (char === '"') {
      add('');
      let closed = false;
      for (at++; at < text.length; at++) {
        if (text[at] === '"') {
          closed = true;
          break;
        }
        if (text[at] === '\\') {
          if (inside) refuse('a backslash inside a command substitution');
          if ('"\\$`\n'.includes(text[at + 1] ?? 'x')) {
            if (text[++at] !== '\n') add(text[at]);
          } else add('\\');
        } else if (text[at] === '$') at = dollar(at);
        else if (text[at] === '`') at = nested(at + 1, 'tick');
        else add(text[at]);
      }
      if (!closed) refuse('unterminated quote');
    } else if (char === '$') {
      at = dollar(at);
    } else if (char === '`') {
      at = nested(at + 1, 'tick');
    } else if (char === '#' && !word) {
      if (inside) refuse('a comment inside a command substitution');
      else while (at + 1 < text.length && text[at + 1] !== '\n') at++;
    } else if (char === '<' || char === '>') {
      refuse(text.startsWith('<<', at) ? 'a here-document' : 'redirection');
    } else if (char === '(') {
      parens++;
      endCommand();
    } else if (char === ')') {
      endCommand();
      if (parens > 0) parens--;
      else if (mode === 'paren') return at;
      else refuse('an unbalanced closing parenthesis');
    } else if ('\n;&|'.includes(char)) {
      endCommand();
    } else if (char === ' ' || char === '\t' || char === '\r') {
      endWord();
    } else {
      if ('*?[~{}'.includes(char)) markDynamic();
      add(char);
    }
  }
  endCommand();
  return text.length;
}

const clip = (words) =>
  words
    .map((entry) => entry.value)
    .join(' ')
    .slice(0, 80);
const literal = (entries) => entries.every((entry) => !entry.dynamic);

function nodeCommand(args, found) {
  const options = { test: false, timeouts: [], imports: [] };
  const text = clip(
    ['node', ...args].map((value) => (typeof value === 'string' ? { value } : value)),
  );
  let at = 0;
  for (; at < args.length; at++) {
    const { value, dynamic } = args[at];
    if (dynamic) return found.problems.push(`a computed node option (${text})`);
    if (value === '--' || !value.startsWith('-') || value === '-') break; // first file argument
    if (value === '--import') {
      const next = args[++at];
      if (!next || next.dynamic)
        return found.problems.push(`a node --import without a plain value (${text})`);
      options.imports.push(next.value);
    } else if (value.startsWith('--test-timeout=')) options.timeouts.push(value.slice(15));
    else if (value === '--test-timeout') options.timeouts.push('');
    else if (value === '--test') options.test = true;
    else if (!NODE_PLAIN_OPTIONS.has(value) && !NODE_VALUE_OPTIONS.test(value))
      return found.problems.push(`an unlisted node option ${value} (${text})`);
  }
  if (!options.test) return;
  found.nodeTests.push({ text, ...options });
  const [budget] = options.timeouts;
  if (options.timeouts.length !== 1 || !BUDGET.test(budget) || Number(budget) > MAX_FILE_BUDGET_MS)
    found.timeouts.push(text);
}

function pnpmCommand(args, scripts, found) {
  const text = clip([{ value: 'pnpm' }, ...args]);
  if (!literal(args)) return found.problems.push(`a computed pnpm argument (${text})`);
  const values = args.map((entry) => entry.value);
  if (values[0] === 'install' && values.slice(1).every((value) => /^--?[a-z-]+$/.test(value)))
    return;
  let at = 0;
  while (['--filter', '-F', '--dir', '-C'].includes(values[at])) at += 2;
  const targeted = at > 0;
  const name = ['run', 'run-script'].includes(values[at]) ? values[at + 1] : values[at];
  const explicit = name !== values[at];
  const rest = values.slice(at + (explicit ? 2 : 1));
  if (!name || !SCRIPT_NAME.test(name) || rest.length > 0 || (!explicit && PNPM_BUILTINS.has(name)))
    return found.problems.push(`a pnpm form that is not "pnpm [run] <script>" (${text})`);
  if (targeted) {
    if (!PACKAGE_SCRIPTS.has(name))
      found.problems.push(`a package script that is not read (${text})`);
  } else if (!Object.hasOwn(scripts, name))
    found.problems.push(`an unknown script ${name} (${text})`);
  else found.follows.add(name);
}

/** What one command line runs: node --test commands, root scripts followed, unprovable parts. */
export function analyse(text, scripts) {
  const found = { nodeTests: [], timeouts: [], follows: new Set(), problems: [] };
  const parsed = parseCommands(String(text));
  found.problems.push(...parsed.problems);
  for (let words of parsed.commands) {
    // Leading NAME=value assignments; the NAME= part must not itself be computed.
    const assignment = ({ value, cut = Infinity }) => {
      const name = /^[A-Za-z_][A-Za-z0-9_]*=/.exec(value);
      return name !== null && name[0].length <= cut;
    };
    while (words.length && assignment(words[0])) words = words.slice(1);
    while (words.length && !words[0].dynamic && KEYWORDS.has(words[0].value))
      words = words.slice(1);
    if (!words.length || (!words[0].dynamic && CLOSERS.has(words[0].value))) continue;
    const [command, ...args] = words;
    if (command.dynamic) found.problems.push(`a computed command word (${clip(words)})`);
    else if (command.value === 'node') nodeCommand(args, found);
    else if (command.value === 'pnpm') pnpmCommand(args, scripts, found);
    else if (!INERT_COMMANDS.has(command.value))
      found.problems.push(`the command ${command.value} (${clip(words)})`);
  }
  return found;
}

/** The `node --test` commands of a command line (not following scripts). */
export function nodeTestSegments(text) {
  return analyse(text, {}).nodeTests.map((entry) => entry.text);
}

/** Every root script a command line runs through `pnpm`, transitively (cycles cut). */
export function reachableScripts(text, scripts, seen = new Set()) {
  for (const name of analyse(text, scripts).follows) {
    if (seen.has(name)) continue;
    seen.add(name);
    if (typeof scripts[name] === 'string') reachableScripts(scripts[name], scripts, seen);
  }
  return seen;
}

export function runsNodeTest(text, scripts) {
  return (
    nodeTestSegments(text).length > 0 ||
    [...reachableScripts(text, scripts)].some(
      (name) => nodeTestSegments(String(scripts[name])).length > 0,
    )
  );
}

function textProblems(label, text, scripts, problems) {
  const found = analyse(text, scripts);
  for (const text of found.timeouts)
    problems.push(
      `${label} runs node --test without exactly one --test-timeout=<ms> of at most ${MAX_FILE_BUDGET_MS} before the files: ${text}`,
    );
  for (const reason of found.problems)
    problems.push(`${label} cannot be proven bounded: ${reason}`);
  return found;
}

/** Variables the shell or node read to decide what a command means. */
const SHELL_ENV = /^(?:BASH_ENV|ENV|SHELLOPTS|BASHOPTS|PATH|IFS|CDPATH|NODE_OPTIONS|BASH_FUNC_.*)$/;
const READABLE_SHELLS = new Set(['bash', 'sh']);
const isMap = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * The execution context of every step of the job, resolved the way Actions does it
 * (workflow defaults.run, then job defaults.run, then the step) and checked at each
 * level that sets something: the shell must be a plain bash or sh, the directory the
 * repository root (so a root script means the root script), and `env` a plain map
 * that does not name a variable the shell reads. Anything else is refused.
 */
function contextProblems(doc, job) {
  const problems = [];
  const levels = [
    ['workflow', doc, doc?.defaults?.run, doc?.defaults],
    ['job', job, job?.defaults?.run, job?.defaults],
  ];
  for (const [label, owner, run, defaults] of levels) {
    const name = label === 'job' ? `job ${UNIT_STEP.job}` : 'the workflow';
    if (defaults !== undefined && !isMap(defaults))
      problems.push(`${name} has defaults that cannot be read`);
    else if (run !== undefined && !isMap(run))
      problems.push(`${name} sets defaults.run to something that cannot be read`);
    else if (isMap(run)) {
      const shell = run.shell;
      const unreadable =
        Object.keys(run).some((key) => key !== 'shell') ||
        (shell !== undefined && !READABLE_SHELLS.has(shell));
      if (unreadable) problems.push(`${name} sets defaults.run, so its commands cannot be read`);
    }
    problems.push(...envProblems(name, owner?.env));
  }
  for (const step of job.steps) {
    const name = `step "${step?.name}"`;
    if (!isMap(step)) {
      problems.push(`${name} cannot be read`);
      continue;
    }
    if (
      step['working-directory'] !== undefined ||
      (step.shell !== undefined && !READABLE_SHELLS.has(step.shell))
    )
      problems.push(`${name} sets shell or working-directory, so it cannot be read`);
    // A local action's own steps are not read here, so it could run any node --test.
    if (typeof step.uses === 'string' && /^(?:\.|docker:)/.test(step.uses))
      problems.push(`${name} uses ${step.uses}, which cannot be read`);
    problems.push(...envProblems(name, step.env));
  }
  return problems;
}

function envProblems(name, env) {
  if (env === undefined) return [];
  if (!isMap(env)) return [`${name} has an env that cannot be read`];
  return Object.keys(env)
    .filter((key) => SHELL_ENV.test(key))
    .map((key) => `${name} sets ${key}, which changes what its commands mean`);
}

export function nodeTestTimeoutProblems(doc, scripts) {
  const problems = [];
  const job = doc?.jobs?.[UNIT_STEP.job];
  const steps = job?.steps;
  if (!Array.isArray(steps)) return [`job ${UNIT_STEP.job} has no readable steps`];
  // A different shell, directory or shell-reading environment changes what the text means.
  problems.push(...contextProblems(doc, job));
  const queue = [];
  for (const step of steps) {
    if (step?.run === undefined) continue;
    // A command that cannot be read is not proven free of node --test.
    if (typeof step.run !== 'string') {
      problems.push(`step "${step.name}": run is not text`);
      continue;
    }
    queue.push(...textProblems(`step "${step.name}"`, step.run, scripts, problems).follows);
  }
  const names = new Set();
  while (queue.length) {
    const name = queue.pop();
    if (names.has(name)) continue;
    names.add(name);
    if (typeof scripts[name] !== 'string') problems.push(`script ${name} is not text`);
    else if (!Object.hasOwn(EXEMPT_SCRIPTS, name))
      queue.push(...textProblems(`script ${name}`, scripts[name], scripts, problems).follows);
  }
  for (const [name, reason] of Object.entries(EXEMPT_SCRIPTS))
    if (!reason || !names.has(name) || analyse(scripts[name], scripts).nodeTests.length === 0)
      problems.push(
        `exempt script ${name} is not a node --test script of the ${UNIT_STEP.job} job`,
      );

  const unit = steps.find((step) => step?.name === UNIT_STEP.step);
  if (!unit) return [...problems, `step "${UNIT_STEP.step}" not found`];
  if (!Number.isInteger(unit['timeout-minutes']) || unit['timeout-minutes'] < 1)
    problems.push(`step "${UNIT_STEP.step}" needs a whole-minute timeout-minutes`);
  else if (unit['timeout-minutes'] > UNIT_STEP.maxMinutes)
    problems.push(
      `step "${UNIT_STEP.step}" timeout-minutes must be at most ${UNIT_STEP.maxMinutes}`,
    );
  // The step must really run the script that carries the budget and the preload.
  const unitRun = typeof unit.run === 'string' ? analyse(unit.run, scripts) : undefined;
  if (!unitRun || unitRun.problems.length > 0 || !unitRun.follows.has(UNIT_STEP.script))
    problems.push(
      `step "${UNIT_STEP.step}" must run ${UNIT_STEP.script} and nothing it cannot read`,
    );
  // The preload is an argument of the one node --test command, before its files.
  // Read by the same parser as every other command: a construct it refuses is not a preload.
  const watched = analyse(scripts[UNIT_STEP.script] ?? '', scripts);
  const tests = watched.nodeTests;
  if (
    watched.problems.length > 0 ||
    tests.length !== 1 ||
    tests[0].imports.join('\n') !== UNIT_STEP.watchdog
  )
    problems.push(
      `${UNIT_STEP.script} must preload ${UNIT_STEP.watchdog} (--import ${UNIT_STEP.watchdog}) and nothing else, before its files`,
    );
  return problems;
}
