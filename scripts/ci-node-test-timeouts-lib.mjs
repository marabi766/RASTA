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
 * check. Its grammar is CLOSED, everything outside it is refused: printable ASCII only,
 * simple commands joined by a newline, `;` or `&&`, each one leading KNOWN_ENV assignments
 * and then words of literals, quotes, plain `$NAME`/`${NAME}` and `$( )`/backticks read by
 * the same grammar. The command word must be node, pnpm or an INERT_COMMANDS entry. So no
 * arithmetic exists (`((`, `$((`, `$[`, `let`, `[[`, subscripts and unknown assignments are
 * outside it) and no control flow: the first top-level command really runs. The execution
 * context has one policy too: see contextProblems.
 *
 * A step limit on every one of the quality job's ~35 `node --test` steps cannot
 * exist: the job budget rule (ci-integration-split-lib.mjs) adds step limits to the
 * job's setup allowance, and 35 limits do not fit in the job.
 */
export const MAX_FILE_BUDGET_MS = 540_000;
/**
 * FU-111: the former `quality` job is five parallel `quality-*` jobs and an aggregate
 * named `quality`. Every `quality-*` job is read here, found by its prefix so a job added
 * later is read too, never skipped; the aggregate runs no test.
 */
export const QUALITY_JOB_PREFIX = 'quality-';
export const UNIT_STEP = {
  job: 'quality-unit',
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
const INERT_COMMANDS = new Set(['echo', 'true', 'turbo', 'eslint', 'prettier', 'tsc']);
/**
 * The only names a shell assignment or a YAML `env` of this job may set. Any other can
 * change what a command means (NODE_OPTIONS, BASH_ENV, PATH, npm_config_script_shell, an
 * arithmetic RANDOM): add one only after checking that the shell, node and pnpm ignore it.
 */
const KNOWN_ENV = new Set(
  'NODE_VERSION PNPM_VERSION MINIO_IMAGE MC_IMAGE TRIVY_VERSION TEMPORAL_TEST_SERVER_DIR SERVICE_ENV_WITHHELD_PUSH_BEFORE SERVICE_ENV_WITHHELD_BASE base'.split(
    ' ',
  ),
);
/** What pnpm runs on its own: on install, and on a run that finds stale dependencies. */
const INSTALL_SCRIPTS =
  'pnpm:devPreinstall preinstall install postinstall preprepare prepare postprepare'.split(' ');
const NODE_PLAIN_OPTIONS = new Set(['--test', '--no-warnings', '--enable-source-maps']);
const NODE_VALUE_OPTIONS = /^--test-concurrency=/;
const SCRIPT_NAME = /^[A-Za-z0-9][A-Za-z0-9:_.-]*$/;
const BUDGET = /^[1-9][0-9]{0,8}$/;
const MAX_DEPTH = 4;
/** The shell reads CR, other control characters and non-ASCII blanks as word characters. */
const UNREADABLE_TEXT = /[^\t\n\x20-\x7e]/;

/** `${NAME}`, `${1}`, `${@}`: the only parameter expansions that cannot run or hide a command. */
const PLAIN_EXPANSION = /^\{(?:[A-Za-z_][A-Za-z0-9_]*|[0-9]+|[@*#?!$-])\}/;

/**
 * Tokenize shell text into commands {words, depth} of words {value, dynamic}. `dynamic` marks
 * a word the shell computes ($var, globs, braces); command substitutions are parsed by the
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
  if (UNREADABLE_TEXT.test(String(text)))
    out.problems.push('a carriage return, control or non-ASCII character');
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
  const endWord = () => {
    if (word) words.push(word);
    word = null;
  };
  const endCommand = () => {
    endWord();
    if (words.length) commands.push({ words, depth });
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
      if (text[at + 1] === '\n') {
        // Bash deletes it before it reads tokens, so inside a word it can join `$` and `(`.
        if (word) refuse('a line continuation inside a word');
        at++;
      } else if (at + 1 < text.length) add(text[++at]);
      else refuse('a backslash at the end of the text');
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
          if (text[at + 1] === '\n') refuse('a line continuation inside a word');
          else if ('"\\$`'.includes(text[at + 1] ?? 'x')) add(text[++at]);
          else add('\\');
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
      refuse('a subshell or an arithmetic command');
      endCommand();
    } else if (char === ')') {
      endCommand();
      if (mode === 'paren') return at;
      refuse('an unbalanced closing parenthesis');
    } else if (char === '&' && text[at + 1] === '&') {
      at++;
      endCommand();
    } else if (char === '|' || char === '&') {
      refuse('a pipeline, an || list or a background command');
      endCommand();
    } else if (char === '\n' || char === ';') {
      endCommand();
    } else if (char === ' ' || char === '\t') {
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

function nodeCommand(args, found, unconditional) {
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
      // Any other preload is code the guard does not read, even inline (a data: URL).
      if (next?.value !== UNIT_STEP.watchdog || next.dynamic)
        return found.problems.push(`a node --import that is not the watchdog (${text})`);
      options.imports.push(next.value);
    } else if (value.startsWith('--test-timeout=')) options.timeouts.push(value.slice(15));
    else if (value === '--test-timeout') options.timeouts.push('');
    else if (value === '--test') options.test = true;
    else if (!NODE_PLAIN_OPTIONS.has(value) && !NODE_VALUE_OPTIONS.test(value))
      return found.problems.push(`an unlisted node option ${value} (${text})`);
  }
  if (!options.test) return;
  found.nodeTests.push({ text, unconditional, ...options });
  const [budget] = options.timeouts;
  if (options.timeouts.length !== 1 || !BUDGET.test(budget) || Number(budget) > MAX_FILE_BUDGET_MS)
    found.timeouts.push(text);
}

/**
 * The pnpm forms a quality step may use: `install --frozen-lockfile`, `run <root script>`
 * and `--filter <read package> run <script>` (or `build`). Nothing else: a `--dir` or an
 * unknown selector can select the root, a package that was not read is unproven.
 */
function pnpmCommand(args, scripts, packages, found) {
  const text = clip([{ value: 'pnpm' }, ...args]);
  if (!literal(args)) return found.problems.push(`a computed pnpm argument (${text})`);
  const values = args.map((entry) => entry.value);
  for (const name of INSTALL_SCRIPTS) if (Object.hasOwn(scripts, name)) found.follows.add(name);
  if (values.join(' ') === 'install --frozen-lockfile') return;
  const filtered = values[0] === '--filter';
  const rest = filtered ? values.slice(2) : values;
  const name = rest[0] === 'run' ? rest[1] : filtered && rest[0] === 'build' ? 'build' : undefined;
  if (name === undefined || !SCRIPT_NAME.test(name) || rest.length !== (rest[0] === 'run' ? 2 : 1))
    return found.problems.push(`a pnpm form that is not "pnpm run <script>" (${text})`);
  if (filtered && !Object.hasOwn(packages, values[1]))
    return found.problems.push(`a pnpm --filter on a package that was not read (${text})`);
  const target = filtered ? packages[values[1]] : scripts;
  if (!Object.hasOwn(target, name))
    return found.problems.push(`an unknown script ${name} (${text})`);
  for (const script of [`pre${name}`, name, `post${name}`]) {
    if (!Object.hasOwn(target, script)) continue;
    if (!filtered) {
      found.follows.add(script);
      continue;
    }
    // A package script may not call pnpm again: no root or package scripts are passed on.
    const inner = analyse(target[script], {}, {});
    found.nodeTests.push(...inner.nodeTests);
    found.timeouts.push(...inner.timeouts);
    found.problems.push(...inner.problems.map((reason) => `${values[1]} ${script}: ${reason}`));
  }
}

/** What one command line runs: node --test commands, root scripts followed, unprovable parts. */
export function analyse(text, scripts, packages = {}) {
  const found = { nodeTests: [], timeouts: [], follows: new Set(), problems: [] };
  const parsed = parseCommands(String(text));
  found.problems.push(...parsed.problems);
  for (const [index, { words: written, depth }] of parsed.commands.entries()) {
    let words = written;
    // Leading NAME=value assignments; the NAME= part must not itself be computed.
    const assignment = ({ value, cut = Infinity }) => {
      const name = /^[A-Za-z_][A-Za-z0-9_]*=/.exec(value);
      return name !== null && name[0].length <= cut;
    };
    for (; words.length && assignment(words[0]); words = words.slice(1)) {
      const [name] = words[0].value.split('=');
      if (!KNOWN_ENV.has(name)) found.problems.push(`an assignment to ${name} (${clip(written)})`);
    }
    if (!words.length) continue;
    const [command, ...args] = words;
    if (command.dynamic) found.problems.push(`a computed command word (${clip(words)})`);
    else if (command.value === 'node')
      nodeCommand(args, found, index === 0 && depth === 0 && words === written);
    else if (command.value === 'pnpm') pnpmCommand(args, scripts, packages, found);
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

function textProblems(label, text, scripts, packages, problems) {
  const found = analyse(text, scripts, packages);
  for (const text of found.timeouts)
    problems.push(
      `${label} runs node --test without exactly one --test-timeout=<ms> of at most ${MAX_FILE_BUDGET_MS} before the files: ${text}`,
    );
  for (const reason of found.problems)
    problems.push(`${label} cannot be proven bounded: ${reason}`);
  return found;
}

const READABLE_SHELLS = new Set(['bash', 'sh']);
const isMap = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * The execution context of every step of the job, resolved the way Actions does it
 * (workflow defaults.run, then job defaults.run, then the step) and checked at each
 * level that sets something: the shell must be a plain bash or sh, the directory the
 * repository root (so a root script means the root script), and `env` a plain map
 * of KNOWN_ENV names, the same policy as a shell assignment. Anything else is refused.
 */
function contextProblems(doc, job, id) {
  const problems = [];
  const levels = [
    ['workflow', doc, doc?.defaults?.run, doc?.defaults],
    ['job', job, job?.defaults?.run, job?.defaults],
  ];
  for (const [label, owner, run, defaults] of levels) {
    const name = label === 'job' ? `job ${id}` : 'the workflow';
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
    .filter((key) => !KNOWN_ENV.has(key))
    .map((key) => `${name} sets ${key}, which may change what its commands mean`);
}

/** `packages`: the scripts of each workspace package a `--filter` may name; unread ones are refused. */
export function nodeTestTimeoutProblems(doc, scripts, packages = {}) {
  const problems = [];
  const ids = Object.keys(isMap(doc?.jobs) ? doc.jobs : {}).filter((id) =>
    id.startsWith(QUALITY_JOB_PREFIX),
  );
  if (!ids.includes(UNIT_STEP.job)) return [`job ${UNIT_STEP.job} has no readable steps`];
  const queue = [];
  for (const id of ids) {
    const job = doc.jobs[id];
    const steps = job?.steps;
    if (!Array.isArray(steps)) {
      problems.push(`job ${id} has no readable steps`);
      continue;
    }
    // A different shell, directory or shell-reading environment changes what the text means.
    problems.push(...contextProblems(doc, job, id));
    for (const step of steps) {
      if (step?.run === undefined) continue;
      // A command that cannot be read is not proven free of node --test.
      if (typeof step.run !== 'string') {
        problems.push(`step "${step.name}": run is not text`);
        continue;
      }
      queue.push(
        ...textProblems(`step "${step.name}"`, step.run, scripts, packages, problems).follows,
      );
    }
  }
  const steps = doc.jobs[UNIT_STEP.job].steps ?? [];
  const names = new Set();
  while (queue.length) {
    const name = queue.pop();
    if (names.has(name)) continue;
    names.add(name);
    if (typeof scripts[name] !== 'string') problems.push(`script ${name} is not text`);
    else if (!Object.hasOwn(EXEMPT_SCRIPTS, name))
      queue.push(
        ...textProblems(`script ${name}`, scripts[name], scripts, packages, problems).follows,
      );
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
  // The step must really run the script that carries the budget and the preload: being
  // somewhere in the text is not running. Only this exact, unconditional command counts.
  const unitRun = typeof unit.run === 'string' ? parseCommands(unit.run) : undefined;
  const [only] = unitRun?.commands ?? [];
  if (
    unitRun?.problems.length !== 0 ||
    unitRun.commands.length !== 1 ||
    only.words.map((word) => word.value).join('\n') !== `pnpm\nrun\n${UNIT_STEP.script}` ||
    unit.if !== undefined ||
    unit['continue-on-error'] !== undefined
  )
    problems.push(
      `step "${UNIT_STEP.step}" must run ${UNIT_STEP.script} unconditionally and nothing else`,
    );
  // The preload is an argument of the one node --test command, before its files, and that
  // command is the first one of the script, so it really runs.
  // Read by the same parser as every other command: a construct it refuses is not a preload.
  const watched = analyse(scripts[UNIT_STEP.script] ?? '', scripts, packages);
  const tests = watched.nodeTests;
  if (
    watched.problems.length > 0 ||
    tests.length !== 1 ||
    !tests[0].unconditional ||
    tests[0].imports.join('\n') !== UNIT_STEP.watchdog
  )
    problems.push(
      `${UNIT_STEP.script} must preload ${UNIT_STEP.watchdog} (--import ${UNIT_STEP.watchdog}) and nothing else, before its files`,
    );
  return problems;
}
