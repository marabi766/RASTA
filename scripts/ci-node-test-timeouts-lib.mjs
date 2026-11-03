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

/**
 * Tokenize shell text into commands of words {value, dynamic}. `dynamic` marks a word
 * the shell computes ($var, globs, braces); command substitutions are parsed as
 * commands of their own. `problems` lists syntax that is not understood.
 */
export function parseCommands(text, depth = 0) {
  const commands = [];
  const problems = [];
  let words = [];
  let word = null;
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
  const substitute = (start, open, close) => {
    // `start` indexes the opening bracket; returns the index of the closing one.
    let level = 0;
    for (let at = open === close ? start + 1 : start; at < text.length; at++) {
      if (text[at] === open && open !== close) level++;
      else if (text[at] === close && (open === close || --level === 0)) {
        if (depth >= MAX_DEPTH) problems.push('command substitutions nested too deeply');
        else {
          const inner = parseCommands(text.slice(start + 1, at), depth + 1);
          commands.push(...inner.commands);
          problems.push(...inner.problems);
        }
        return at;
      }
    }
    problems.push('unterminated command substitution');
    return text.length;
  };
  const dollar = (at) => {
    markDynamic();
    const rest = text.slice(at + 1);
    if (rest.startsWith('(')) return substitute(at + 1, '(', ')');
    if (rest.startsWith('{'))
      return rest.indexOf('}') < 0 ? text.length : at + 1 + rest.indexOf('}');
    return at + (/^(?:[A-Za-z_][A-Za-z0-9_]*|[0-9@*#?!$-])/.exec(rest)?.[0].length ?? 0);
  };
  for (let at = 0; at < text.length; at++) {
    const char = text[at];
    if (char === '\\') {
      if (text[at + 1] === '\n') at++;
      else if (at + 1 < text.length) add(text[++at]);
    } else if (char === "'") {
      const end = text.indexOf("'", at + 1);
      if (end < 0) {
        problems.push('unterminated quote');
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
        if (text[at] === '\\' && '"\\$`\n'.includes(text[at + 1] ?? 'x')) {
          if (text[++at] !== '\n') add(text[at]);
        } else if (text[at] === '$') at = dollar(at);
        else if (text[at] === '`') {
          markDynamic();
          at = substitute(at, '`', '`');
        } else add(text[at]);
      }
      if (!closed) problems.push('unterminated quote');
    } else if (char === '$') {
      at = dollar(at);
    } else if (char === '`') {
      markDynamic();
      at = substitute(at, '`', '`');
    } else if (char === '#' && !word) {
      while (at + 1 < text.length && text[at + 1] !== '\n') at++;
    } else if (char === '<' || char === '>') {
      problems.push('redirection');
    } else if ('\n;&|()'.includes(char)) {
      endCommand();
    } else if (char === ' ' || char === '\t' || char === '\r') {
      endWord();
    } else {
      if ('*?[~{}'.includes(char)) markDynamic();
      add(char);
    }
  }
  endCommand();
  return { commands, problems };
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

export function nodeTestTimeoutProblems(doc, scripts) {
  const problems = [];
  const job = doc?.jobs?.[UNIT_STEP.job];
  const steps = job?.steps;
  if (!Array.isArray(steps)) return [`job ${UNIT_STEP.job} has no readable steps`];
  // A different shell or directory changes what the command text means.
  if (job.defaults?.run !== undefined)
    problems.push(`job ${UNIT_STEP.job} sets defaults.run, so its commands cannot be read`);
  const queue = [];
  for (const step of steps) {
    if (step?.run === undefined) continue;
    // A command that cannot be read is not proven free of node --test.
    if (typeof step.run !== 'string') {
      problems.push(`step "${step.name}": run is not text`);
      continue;
    }
    if (step['working-directory'] !== undefined || !['bash', 'sh', undefined].includes(step.shell))
      problems.push(`step "${step.name}" sets shell or working-directory, so it cannot be read`);
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
  // The preload is an argument of the one node --test command, before its files.
  const tests = analyse(scripts[UNIT_STEP.script] ?? '', scripts).nodeTests;
  if (tests.length !== 1 || tests[0].imports.join('\n') !== UNIT_STEP.watchdog)
    problems.push(
      `${UNIT_STEP.script} must preload ${UNIT_STEP.watchdog} (--import ${UNIT_STEP.watchdog}) and nothing else, before its files`,
    );
  return problems;
}
