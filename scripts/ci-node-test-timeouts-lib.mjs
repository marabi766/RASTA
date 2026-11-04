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
 * the same grammar. The command word must be node, pnpm, turbo or an INERT_SHAPES entry used
 * in its listed argument shape. So no
 * arithmetic exists (`((`, `$((`, `$[`, `let`, `[[`, subscripts and unknown assignments are
 * outside it) and no control flow: the first top-level command really runs. The execution
 * context has one policy too: see contextProblems.
 *
 * A step limit on every one of the quality job's ~35 `node --test` steps cannot
 * exist: the job budget rule (ci-integration-split-lib.mjs) adds step limits to the
 * job's setup allowance, and 35 limits do not fit in the job.
 */
import { parseCommands } from './ci-shell-text-lib.mjs';

/** The shared tokenizer lives in ci-shell-text-lib.mjs (FU-077); re-exported for existing callers. */
export { parseCommands };
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

const operand = (value) => !value.startsWith('-');
/**
 * FU-077 R5: a command other than node, pnpm and turbo is inert - runs no root script and
 * no `node --test` - only in one of these argument shapes, the ones this repository uses.
 * Any other argument refuses, since many options load code the guard does not read
 * (eslint -c/--rulesdir/--format, prettier --plugin/--config, jest --testRunner,
 * tsc --build of another project). Words are compared one argv entry at a time.
 */
const INERT_SHAPES = {
  echo: () => true, // prints its words; a substitution in them is read as a command of its own
  true: (args) => args.length === 0,
  eslint: (args) => args.length > 0 && args.every(operand),
  prettier: (args) => args.length > 1 && args[0] === '--check' && args.slice(1).every(operand),
  tsc: (args) =>
    args[0] === '-p' &&
    operand(args[1] ?? '-') &&
    (args.length === 2 || (args.length === 3 && args[2] === '--noEmit')),
  jest: (args) => {
    const rest = [...args];
    if (rest[0] === '--selectProjects' && operand(rest[1] ?? '-')) rest.splice(0, 2);
    return rest.length === 0 || (rest.length === 1 && rest[0] === '--passWithNoTests');
  },
  prisma: (args) => args.length === 1 && args[0] === 'generate',
};
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
const clip = (words) =>
  words
    .map((entry) => entry.value)
    .join(' ')
    .slice(0, 80);
const literal = (entries) => entries.every((entry) => !entry.dynamic);
const sameWords = (words, expected) =>
  words.length === expected.length &&
  words.every((word, index) => !word.dynamic && word.value === expected[index]);

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
  // FU-077 R4: argv boundaries are kept: `pnpm "install --frozen-lockfile"` is ONE word, which
  // pnpm runs as a script of that name, not as an install.
  if (values.length === 2 && values[0] === 'install' && values[1] === '--frozen-lockfile') return;
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
    if (filtered) packageScript(found, values[1], script, target[script]);
    else found.follows.add(script);
  }
}

/** One workspace package script, read once per command line. */
function packageScript(found, pkg, name, text) {
  const key = `${pkg} ${name}`;
  if (found.read.has(key)) return;
  found.read.add(key);
  if (typeof text !== 'string') return found.problems.push(`${key} is not text`);
  // A package script may not call pnpm or turbo again: no root scripts, packages or task graph.
  const inner = analyse(text, {}, {});
  found.nodeTests.push(...inner.nodeTests);
  found.timeouts.push(...inner.timeouts.map((entry) => `${key}: ${entry}`));
  found.problems.push(...inner.problems.map((reason) => `${key}: ${reason}`));
}

/**
 * FU-077 R5: turbo runs package scripts, so it is never inert. Only `turbo run <task>`
 * (optionally `--concurrency=<n>`) is read: the task and every task it depends on in the
 * task graph (`turbo`: task -> dependsOn, from every turbo.json), in every read package.
 */
function turboCommand(args, packages, turbo, found) {
  const text = clip([{ value: 'turbo' }, ...args]);
  const values = args.map((entry) => entry.value);
  const [verb, task, ...rest] = values;
  if (
    !literal(args) ||
    verb !== 'run' ||
    !SCRIPT_NAME.test(task ?? '') ||
    rest.length > 1 ||
    !rest.every((value) => /^--concurrency=[1-9][0-9]?$/.test(value))
  )
    return found.problems.push(`a turbo form that is not "turbo run <task>" (${text})`);
  if (!isMap(turbo)) return found.problems.push(`a turbo task graph that was not read (${text})`);
  // A `pkg#task` (or a root `//#task`) entry runs a script outside this model: refused.
  const scoped = Object.entries(turbo).find(
    ([name, depends]) =>
      name.includes('#') ||
      !Array.isArray(depends) ||
      depends.some((entry) => String(entry).includes('#')),
  );
  if (scoped) return found.problems.push(`a turbo task ${scoped[0]} that is not read (${text})`);
  const tasks = new Set();
  for (const queue = [task]; queue.length;) {
    const name = queue.pop();
    if (tasks.has(name)) continue;
    if (!Array.isArray(turbo[name]))
      return found.problems.push(
        `a turbo task ${name} that the task graph does not hold (${text})`,
      );
    tasks.add(name);
    queue.push(...turbo[name].map((entry) => String(entry).replace(/^\^/, '')));
  }
  for (const [pkg, own] of Object.entries(packages))
    for (const name of tasks)
      for (const script of [`pre${name}`, name, `post${name}`])
        if (Object.hasOwn(own, script)) packageScript(found, pkg, script, own[script]);
}

/** What one command line runs: node --test commands, root scripts followed, unprovable parts. */
export function analyse(text, scripts, packages = {}, turbo = undefined) {
  const found = { nodeTests: [], timeouts: [], follows: new Set(), problems: [], read: new Set() };
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
    else if (command.value === 'turbo') turboCommand(args, packages, turbo, found);
    else if (!Object.hasOwn(INERT_SHAPES, command.value))
      found.problems.push(`the command ${command.value} (${clip(words)})`);
    else if (
      (command.value !== 'echo' && !literal(args)) ||
      !INERT_SHAPES[command.value](args.map((entry) => entry.value))
    )
      found.problems.push(
        `an argument shape of ${command.value} that is not read (${clip(words)})`,
      );
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

function textProblems(label, text, scripts, packages, turbo, problems) {
  const found = analyse(text, scripts, packages, turbo);
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
    .filter((key) => !KNOWN_ENV.has(key))
    .map((key) => `${name} sets ${key}, which may change what its commands mean`);
}

/**
 * `packages`: the scripts of EVERY workspace package (a `--filter` on an unread one refuses).
 * `workspace`: { turbo: task -> dependsOn of every turbo.json }; without it a turbo
 * command refuses, so omitting it opens nothing.
 */
export function nodeTestTimeoutProblems(doc, scripts, packages = {}, workspace = {}) {
  const problems = [];
  const { turbo } = workspace;
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
    queue.push(
      ...textProblems(`step "${step.name}"`, step.run, scripts, packages, turbo, problems).follows,
    );
  }
  const names = new Set();
  while (queue.length) {
    const name = queue.pop();
    if (names.has(name)) continue;
    names.add(name);
    if (typeof scripts[name] !== 'string') problems.push(`script ${name} is not text`);
    else if (!Object.hasOwn(EXEMPT_SCRIPTS, name))
      queue.push(
        ...textProblems(`script ${name}`, scripts[name], scripts, packages, turbo, problems)
          .follows,
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
    // argv entries compared one by one (FU-077 R4): a quoted newline does not join words
    !sameWords(only.words, ['pnpm', 'run', UNIT_STEP.script]) ||
    unit.if !== undefined ||
    unit['continue-on-error'] !== undefined
  )
    problems.push(
      `step "${UNIT_STEP.step}" must run ${UNIT_STEP.script} unconditionally and nothing else`,
    );
  // The preload is an argument of the one node --test command, before its files, and that
  // command is the first one of the script, so it really runs.
  // Read by the same parser as every other command: a construct it refuses is not a preload.
  const watched = analyse(scripts[UNIT_STEP.script] ?? '', scripts, packages, turbo);
  const tests = watched.nodeTests;
  if (
    watched.problems.length > 0 ||
    tests.length !== 1 ||
    !tests[0].unconditional ||
    tests[0].imports.length !== 1 ||
    tests[0].imports[0] !== UNIT_STEP.watchdog
  )
    problems.push(
      `${UNIT_STEP.script} must preload ${UNIT_STEP.watchdog} (--import ${UNIT_STEP.watchdog}) and nothing else, before its files`,
    );
  return problems;
}
