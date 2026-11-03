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
const NODE_TEST = /(?:^|[\s(])node\s(?:[^\n]*\s)?--test(?:\s|=|$)/;
const PNPM_SCRIPT = /\bpnpm\s+(?:run\s+|run-script\s+)?([A-Za-z0-9:_.-]+)/g;
const SEGMENT = /&&|\|\||[;|\n]/;

/** Every root script a command line runs through `pnpm`, transitively (cycles cut). */
export function reachableScripts(text, scripts, seen = new Set()) {
  for (const [, name] of text.matchAll(PNPM_SCRIPT)) {
    if (seen.has(name) || !Object.hasOwn(scripts, name)) continue;
    seen.add(name);
    if (typeof scripts[name] === 'string') reachableScripts(scripts[name], scripts, seen);
  }
  return seen;
}

/** The `node --test` command segments of a command line. */
export function nodeTestSegments(text) {
  return text.split(SEGMENT).filter((segment) => NODE_TEST.test(segment));
}

export function runsNodeTest(text, scripts) {
  return (
    nodeTestSegments(text).length > 0 ||
    [...reachableScripts(text, scripts)].some(
      (name) => nodeTestSegments(String(scripts[name])).length > 0,
    )
  );
}

const budgetOf = (segment) => /(?:^|\s)--test-timeout=([1-9][0-9]{0,8})(?=\s|$)/.exec(segment)?.[1];

function segmentProblems(label, text, problems) {
  for (const segment of nodeTestSegments(text)) {
    const budget = budgetOf(segment);
    if (!budget || Number(budget) > MAX_FILE_BUDGET_MS)
      problems.push(
        `${label} runs node --test without --test-timeout=<ms> of at most ${MAX_FILE_BUDGET_MS}: ${segment.trim().slice(0, 80)}`,
      );
  }
}

export function nodeTestTimeoutProblems(doc, scripts) {
  const problems = [];
  const steps = doc?.jobs?.[UNIT_STEP.job]?.steps;
  if (!Array.isArray(steps)) return [`job ${UNIT_STEP.job} has no readable steps`];
  const names = new Set();
  for (const step of steps) {
    if (step?.run === undefined) continue;
    // A command that cannot be read is not proven free of node --test.
    if (typeof step.run !== 'string') {
      problems.push(`step "${step.name}": run is not text`);
      continue;
    }
    segmentProblems(`step "${step.name}"`, step.run, problems);
    for (const name of reachableScripts(step.run, scripts)) names.add(name);
  }
  for (const [name, reason] of Object.entries(EXEMPT_SCRIPTS)) {
    if (!reason || !names.has(name) || nodeTestSegments(String(scripts[name])).length === 0)
      problems.push(
        `exempt script ${name} is not a node --test script of the ${UNIT_STEP.job} job`,
      );
    names.delete(name);
  }
  for (const name of [...names].sort())
    segmentProblems(`script ${name}`, String(scripts[name]), problems);

  const unit = steps.find((step) => step?.name === UNIT_STEP.step);
  if (!unit) return [...problems, `step "${UNIT_STEP.step}" not found`];
  if (!Number.isInteger(unit['timeout-minutes']) || unit['timeout-minutes'] < 1)
    problems.push(`step "${UNIT_STEP.step}" needs a whole-minute timeout-minutes`);
  else if (unit['timeout-minutes'] > UNIT_STEP.maxMinutes)
    problems.push(
      `step "${UNIT_STEP.step}" timeout-minutes must be at most ${UNIT_STEP.maxMinutes}`,
    );
  const script = String(scripts[UNIT_STEP.script] ?? '');
  const preload = `--import ${UNIT_STEP.watchdog}`;
  if (!` ${script} `.includes(` ${preload} `))
    problems.push(`${UNIT_STEP.script} must preload ${UNIT_STEP.watchdog} (${preload})`);
  return problems;
}
