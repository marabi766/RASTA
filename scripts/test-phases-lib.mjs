/**
 * The two-phase test run: every workspace test task in parallel, then — for
 * `test:integration` — the database stress proofs alone.
 *
 * Why there is a second phase at all. `pnpm test:integration` runs each
 * service's suites concurrently through turbo, against one
 * PostgreSQL. identity-service's `security-event-aggregation.int-spec.ts`
 * holds two deliberate 500-write proofs that serialize on one hot row, so
 * their pace is the database's commit latency. Measured on 2026-09-14
 * (PROJECT_MEMORY, AUD-004 follow-up): alone, each burst took ~22 s at ~22 WAL
 * syncs/s with no capture over 5 s; beside the other services' integration
 * suites the same bursts took 42–124 s, WAL syncs fell to ~7/s, and captures
 * crossed the 5 s statement bound (`57014`) or the burst crossed its 60 s
 * window. The waits were on the row lock behind a WAL-stalled holder, never on
 * connection acquisition. The proofs are about row serialization, not about
 * how much unrelated I/O a shared volume absorbs — so they run once, after
 * every other workspace test task has finished.
 *
 * Why only `test:integration` has it. The spec needs a real PostgreSQL, and
 * `pnpm verify` runs `pnpm test`, which `docs/14` requires to stay runnable
 * on a machine without Docker. `test` therefore stops after the workspace
 * phase; `validateInfraFreeTestTask` keeps each service's `test` unit-only for
 * the same reason.
 *
 * This file is pure: the orchestrator (`run-test-phases.mjs`) and the contract
 * gate (`check-test-phases.mjs`) read the real files and hand them in.
 */

/** The root tasks the orchestrator accepts. Only `test:integration` runs phase two. */
export const WORKSPACE_TASKS = Object.freeze(['test', 'test:integration']);

/** The orchestrator the root scripts must invoke, relative to the repository root. */
export const ORCHESTRATOR = 'scripts/run-test-phases.mjs';

/** The one exclusive phase: identity's aggregation stress spec, alone. */
export const EXCLUSIVE_PHASE = Object.freeze({
  package: '@rasta/identity-service',
  packageDir: 'services/identity-service',
  task: 'test:aggregation-stress',
  jestProject: 'aggregation-stress',
  spec: 'test/security-event-aggregation.int-spec.ts',
});

/** The CI steps that must keep exercising the stress proofs. */
export const CI_STEPS = Object.freeze({
  integration: 'Integration tests',
  security: 'Tenant isolation and authorization tests',
});

/**
 * The manual ADR-055 calibration campaign. It runs the stress project several
 * more times against a database it measures, so it must stay out of every
 * ordinary gate: a quality run that silently ran it would take many minutes
 * longer and would report an environment measurement as a product result.
 * ADR-055 is `Proposed` and sets no threshold, so nothing may depend on it yet.
 */
export const CALIBRATION_SCRIPT = 'calibrate:aggregation-stress';

/**
 * Turns the orchestrator's argv into the turbo invocations it runs.
 *
 * `test` runs the workspace phase alone; `test:integration` runs it and then
 * the exclusive phase. The stress spec is an `.int-spec.ts` against a real
 * PostgreSQL, so it belongs to the integration task — and `pnpm verify` runs
 * `pnpm test`, which `docs/14` requires to stay runnable without Docker.
 * Until 2026-09-20 `test` ran the exclusive phase too, so `verify` on a
 * machine with no database died there. That was invisible for as long as the
 * workspace phase died first on `DATABASE_URL_ORGANIZATION`.
 *
 * The proofs lose no coverage: CI's `Integration tests` step runs
 * `test:integration` unfiltered, and its `${CI_STEPS.security}` step runs
 * `test:integration -- --testNamePattern=…`, whose `concurren` selects them.
 *
 * `pnpm run test:integration -- --testNamePattern=X` reaches the orchestrator
 * as `test:integration -- --testNamePattern=X`; everything after `--` is
 * forwarded to every phase, so a filtered CI gate filters the exclusive phase
 * exactly as it filters the parallel one. Anything else is refused: a turbo
 * `--filter` here would silently decide whether the stress proofs run, and a
 * filtered workspace run is `pnpm exec turbo run <task> --filter …` by name.
 */
export function planTestRun(argv) {
  const [task, ...rest] = argv;
  if (!WORKSPACE_TASKS.includes(task)) {
    throw new Error(
      `test phases: unknown task ${JSON.stringify(task ?? '')}; expected one of ${WORKSPACE_TASKS.join(', ')}`,
    );
  }
  const separator = rest.indexOf('--');
  const before = separator === -1 ? rest : rest.slice(0, separator);
  if (before.length > 0) {
    throw new Error(
      'test phases: options before `--` are not accepted (they would decide whether the exclusive ' +
        'phase runs); pass test-runner arguments after `--`, or run `pnpm exec turbo run ' +
        `${task} …` +
        '` for a filtered workspace-only run',
    );
  }
  const forwarded = separator === -1 ? [] : rest.slice(separator + 1);
  const passthrough = forwarded.length > 0 ? ['--', ...forwarded] : [];
  const plan = [{ phase: 'workspace', args: ['run', task, ...passthrough] }];
  if (task === 'test:integration') {
    plan.push({
      phase: 'exclusive',
      args: ['run', EXCLUSIVE_PHASE.task, `--filter=${EXCLUSIVE_PHASE.package}`, ...passthrough],
    });
  }
  return plan;
}

/** Splits one shell command line into words, honouring single and double quotes. */
export function shellWords(line) {
  const words = [];
  let current = '';
  let quote = null;
  let started = false;
  for (const char of line) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) words.push(current);
      current = '';
      started = false;
    } else {
      current += char;
      started = true;
    }
  }
  if (quote) throw new Error(`unterminated quote in: ${line}`);
  if (started) words.push(current);
  return words;
}

/** The `&&`-separated commands of a package.json script, each as words. */
export function scriptCommands(script) {
  return String(script ?? '')
    .split('&&')
    .map((part) => part.trim())
    .filter(Boolean)
    .map(shellWords);
}

/**
 * Words of one workflow line. A `run:` block is read a line at a time, so a
 * quoted argument continued across lines cannot be split exactly; such a line
 * falls back to whitespace, which is all the turbo/pnpm matching below needs.
 */
function lineWords(line) {
  try {
    return shellWords(line);
  } catch {
    return line.split(/\s+/).filter(Boolean);
  }
}

const sameWords = (a, b) => a.length === b.length && a.every((word, index) => word === b[index]);

/** Removes `//` and `/* *\/` comments outside strings, so turbo.json parses as JSON. */
export function stripJsonComments(text) {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];
    if (inString) {
      out += char;
      if (char === '\\') {
        out += next ?? '';
        i += 1;
      } else if (char === '"') {
        inString = false;
      }
    } else if (char === '"') {
      inString = true;
      out += char;
    } else if (char === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      out += '\n';
    } else if (char === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end === -1) throw new Error('unterminated block comment');
      i = end + 1;
    } else {
      out += char;
    }
  }
  return out;
}

/** The project names a jest command selects, or `null` when it selects none (= all). */
export function selectedProjects(words) {
  const at = words.indexOf('--selectProjects');
  if (at === -1) return null;
  const names = [];
  for (const word of words.slice(at + 1)) {
    if (word.startsWith('-')) break;
    names.push(word);
  }
  return names;
}

const asArray = (value) => (value === undefined ? [] : Array.isArray(value) ? value : [value]);

/**
 * The files a jest project would collect, from a package-relative file list.
 *
 * Jest searches the project's `rootDir` and matches `testRegex` and
 * `testPathIgnorePatterns` against the absolute path; a synthetic absolute
 * path with forward slashes is used, so a pattern that relies on a platform
 * separator is treated as not matching anything it would miss on Linux.
 */
export function projectFiles(project, files, packageDir) {
  const root = `${String(project.rootDir ?? '.')
    .replace(/\\/g, '/')
    .replace(/\/$/, '')}/`;
  const regexes = asArray(project.testRegex).map((pattern) => new RegExp(pattern));
  const ignores = asArray(project.testPathIgnorePatterns ?? ['/node_modules/']).map(
    (pattern) => new RegExp(pattern),
  );
  return files.filter((file) => {
    if (root !== './' && !file.startsWith(root)) return false;
    const absolute = `/repo/${packageDir}/${file}`;
    return (
      regexes.some((regex) => regex.test(absolute)) &&
      !ignores.some((regex) => regex.test(absolute))
    );
  });
}

/** Test titles in a spec source whose `it(` title names the 500-operation proofs. */
export function stressProofTitles(specSource) {
  const titles = [];
  for (const match of String(specSource).matchAll(/\bit\(\s*(['"`])((?:(?!\1).)+)\1/g)) {
    if (/\b500\b/.test(match[2])) titles.push(match[2]);
  }
  return titles;
}

function indentOf(line) {
  return line.match(/^(\s*)/)[1].length;
}

/**
 * The shell command lines of every workflow step named `name`.
 *
 * Reads the step block by indentation and its `run:` scalar, inline or block
 * (`|`/`>`). Comment and blank lines are dropped. Not a YAML parser: it only
 * has to find the commands a named step executes.
 */
export function workflowStepCommands(workflowText, name) {
  const lines = String(workflowText).split(/\r?\n/);
  const header = /^(\s*)- name:\s*(.+?)\s*$/;
  const steps = [];
  for (let i = 0; i < lines.length; i += 1) {
    const found = lines[i].match(header);
    if (!found || found[2].replace(/^['"]|['"]$/g, '') !== name) continue;
    const stepIndent = found[1].length;
    const commands = [];
    for (let j = i + 1; j < lines.length; j += 1) {
      const line = lines[j];
      if (line.trim() !== '' && indentOf(line) <= stepIndent) break;
      const run = line.match(/^(\s*)run:\s*(.*)$/);
      if (!run) continue;
      const value = run[2].trim();
      if (value !== '' && !/^[|>][-+]?$/.test(value)) {
        commands.push(value);
        continue;
      }
      for (let k = j + 1; k < lines.length; k += 1) {
        const body = lines[k];
        if (body.trim() === '') continue;
        if (indentOf(body) <= run[1].length) break;
        const text = body.trim();
        if (!text.startsWith('#')) commands.push(text);
      }
    }
    steps.push(commands);
  }
  return steps;
}

/** Every command line in the workflow's `run:` scalars. */
function allWorkflowCommands(workflowText) {
  const names = [...String(workflowText).matchAll(/^\s*- name:\s*(.+?)\s*$/gm)].map((m) =>
    m[1].replace(/^['"]|['"]$/g, ''),
  );
  return [...new Set(names)].flatMap((name) => workflowStepCommands(workflowText, name).flat());
}

const isTurboRunOf = (words, tasks) => {
  const at = words.indexOf('turbo');
  return at !== -1 && words[at + 1] === 'run' && tasks.includes(words[at + 2]);
};

/** The one jest project the parallel `test` phase may select: it needs no database. */
export const UNIT_PROJECT = 'unit';

/**
 * Checks that phase one needs no infrastructure.
 *
 * `CLAUDE.md` documents `pnpm test:unit` as the infra-free task, `pnpm
 * test:integration` as the one wanting `pnpm infra:up`, and `pnpm verify` as
 * the pre-commit gate — and `verify` runs `pnpm test`. So `test` has to stay
 * on the infra-free side of that line.
 *
 * It had drifted. Until 2026-09-20 organization's `test` was a bare `jest`
 * and identity's selected `unit integration`, so those two ran their
 * integration suites under `test` while the other nine did not. `pnpm verify`
 * from a shell without `.env` exported therefore died in
 * `organization-service` on a missing `DATABASE_URL_ORGANIZATION` — and
 * because `test` sits second-to-last in the chain, it took `build` with it.
 *
 * A bare `jest` is the trap: selecting no project selects *every* project,
 * so a service passes this silently until someone adds its first integration
 * spec. Naming the project is what makes the requirement visible.
 *
 * Scoped to `services/*`, which is where the unit/integration project split
 * lives; `packages/*` have no integration project to select.
 *
 * Returns problem strings; empty means the contract holds.
 */
export function validateInfraFreeTestTask(serviceScripts) {
  const problems = [];
  for (const [packageDir, scripts] of Object.entries(serviceScripts ?? {})) {
    const jest = scriptCommands(scripts?.test).find((words) => words[0] === 'jest');
    if (!jest) {
      problems.push(`${packageDir} script "test" must run jest`);
      continue;
    }
    const projects = selectedProjects(jest);
    if (projects === null) {
      problems.push(
        `${packageDir} script "test" names no project, so it selects every one — ` +
          `including "integration", which needs a database; select "${UNIT_PROJECT}"`,
      );
    } else if (!sameWords(projects, [UNIT_PROJECT])) {
      problems.push(
        `${packageDir} script "test" must select exactly the "${UNIT_PROJECT}" project ` +
          `(selects "${projects.join(' ')}"); integration suites run through "test:integration"`,
      );
    }
  }
  return problems;
}

/**
 * Checks that the stress spec runs exactly once, alone, after the workspace
 * phase of `pnpm test:integration` — and so in CI. It is deliberately absent
 * from `pnpm test` and `pnpm verify`, which need no database; what keeps it
 * out of *their* parallel phase is checked here too.
 *
 * Returns problem strings; empty means the contract holds.
 */
export function validateTestPhases({
  rootScripts,
  turboTasks,
  identityScripts,
  jestProjects,
  identityFiles,
  specSource,
  ciWorkflow,
}) {
  const problems = [];
  const { package: pkg, task, jestProject, spec, packageDir } = EXCLUSIVE_PHASE;

  // Root scripts: both workspace tasks go through the orchestrator.
  for (const workspaceTask of WORKSPACE_TASKS) {
    const commands = scriptCommands(rootScripts?.[workspaceTask]);
    if (commands.length !== 1 || !sameWords(commands[0], ['node', ORCHESTRATOR, workspaceTask])) {
      problems.push(
        `root script "${workspaceTask}" must be exactly \`node ${ORCHESTRATOR} ${workspaceTask}\``,
      );
    }
  }
  const direct = scriptCommands(rootScripts?.[task]);
  if (direct.length !== 1 || !sameWords(direct[0], ['turbo', 'run', task, `--filter=${pkg}`])) {
    problems.push(`root script "${task}" must be exactly \`turbo run ${task} --filter=${pkg}\``);
  }
  for (const [name, script] of Object.entries(rootScripts ?? {})) {
    if (scriptCommands(script).some((words) => isTurboRunOf(words, [...WORKSPACE_TASKS]))) {
      problems.push(
        `root script "${name}" runs a workspace test task through turbo directly, skipping the exclusive phase`,
      );
    }
  }
  const verify = scriptCommands(rootScripts?.verify);
  const verifyTests = verify.filter((words) => sameWords(words, ['pnpm', 'run', 'test']));
  if (verifyTests.length !== 1) {
    problems.push(
      `root script "verify" must run \`pnpm run test\` exactly once (found ${verifyTests.length})`,
    );
  }
  for (const gate of ['test:test-phases', 'check:test-phases']) {
    if (!verify.some((words) => sameWords(words, ['pnpm', 'run', gate]))) {
      problems.push(`root script "verify" must run \`pnpm run ${gate}\``);
    }
  }

  // The manual calibration campaign stays manual: it may not be reachable from
  // `verify`, from either workspace test task, or from the direct stress route.
  const referencesCalibration = (script) =>
    scriptCommands(script).some((words) =>
      words.some((word) => word === CALIBRATION_SCRIPT || word.endsWith(`/${CALIBRATION_SCRIPT}`)),
    );
  for (const name of ['verify', ...WORKSPACE_TASKS, EXCLUSIVE_PHASE.task]) {
    if (referencesCalibration(rootScripts?.[name])) {
      problems.push(
        `root script "${name}" reaches "${CALIBRATION_SCRIPT}"; the calibration campaign is manual only`,
      );
    }
  }
  const calibration = scriptCommands(rootScripts?.[CALIBRATION_SCRIPT]);
  if (calibration.length === 0) {
    // The campaign is manual, which means it is reachable *by name only* — so
    // the name has to exist. Without it there is no recorded invocation, and
    // the contract below would silently assert nothing.
    problems.push(
      `root script "${CALIBRATION_SCRIPT}" must exist: the calibration campaign's only entry point is manual`,
    );
  } else {
    if (
      calibration.length !== 1 ||
      calibration[0][0] !== 'node' ||
      calibration[0][1] !== 'scripts/aggregation-evidence.mjs' ||
      !calibration[0].includes('--calibrate')
    ) {
      problems.push(
        `root script "${CALIBRATION_SCRIPT}" must invoke only \`node scripts/aggregation-evidence.mjs --calibrate\``,
      );
    }
    // The pair count and report path are the caller's, after `--`. Baking
    // either in would make a recorded invocation mean something it does not.
    if (calibration[0].some((word) => word === '--pairs' || word.startsWith('--pairs='))) {
      problems.push(`root script "${CALIBRATION_SCRIPT}" must not fix a pair count`);
    }
  }

  // Turbo: the exclusive task exists and can never replay a cached green.
  const turboTask = turboTasks?.[task];
  if (!turboTask) {
    problems.push(`turbo.json has no "${task}" task`);
  } else {
    if (turboTask.cache !== false) {
      problems.push(`turbo.json "${task}" must set "cache": false, or a stale green could replay`);
    }
    if (!asArray(turboTask.dependsOn).includes('^build')) {
      problems.push(`turbo.json "${task}" must depend on "^build"`);
    }
    if (!asArray(turboTask.env).includes('DATABASE_URL_*')) {
      problems.push(`turbo.json "${task}" must pass "DATABASE_URL_*" through`);
    }
  }

  // Identity scripts: which jest projects each one selects.
  const projectNames = (jestProjects ?? []).map((project) => project.displayName);
  const selection = {};
  for (const script of ['test', 'test:integration', 'test:unit', task]) {
    const commands = scriptCommands(identityScripts?.[script]);
    const jest = commands.find((words) => words[0] === 'jest');
    if (!jest) {
      if (script !== 'test:unit') problems.push(`identity script "${script}" must run jest`);
      continue;
    }
    selection[script] = { words: jest, projects: selectedProjects(jest) ?? projectNames };
  }
  for (const script of ['test', 'test:integration', 'test:unit']) {
    if (selection[script]?.projects.includes(jestProject)) {
      problems.push(
        `identity script "${script}" selects the "${jestProject}" project; it must stay out of the parallel phase`,
      );
    }
  }
  const stressSelection = selection[task];
  if (stressSelection) {
    if (!sameWords(stressSelection.projects, [jestProject])) {
      problems.push(`identity script "${task}" must select exactly the "${jestProject}" project`);
    }
    if (!stressSelection.words.includes('--runInBand')) {
      problems.push(`identity script "${task}" must run in band`);
    }
    if (stressSelection.words.includes('--passWithNoTests')) {
      problems.push(
        `identity script "${task}" must not pass with no tests: a missing spec has to fail`,
      );
    }
  }

  // Jest: the spec is collected by the stress project only, and by nothing the
  // parallel phase selects; every other integration spec stays in the parallel phase.
  if (!(identityFiles ?? []).includes(spec)) {
    problems.push(`${packageDir}/${spec} does not exist`);
  }
  const collected = new Map(
    (jestProjects ?? []).map((project) => [
      project.displayName,
      projectFiles(project, identityFiles ?? [], packageDir),
    ]),
  );
  if (!collected.has(jestProject)) {
    problems.push(`identity jest config has no "${jestProject}" project`);
  } else if (!sameWords(collected.get(jestProject), [spec])) {
    problems.push(
      `identity jest project "${jestProject}" must collect exactly ${spec} (collects ${collected.get(jestProject).length} file(s))`,
    );
  }
  for (const script of ['test', 'test:integration']) {
    for (const name of selection[script]?.projects ?? []) {
      if ((collected.get(name) ?? []).includes(spec)) {
        problems.push(
          `identity jest project "${name}" (selected by "${script}") collects ${spec}; it would run in the parallel phase`,
        );
      }
    }
  }
  const integrationSpecs = (identityFiles ?? []).filter(
    (file) => file.startsWith('test/') && file.endsWith('.int-spec.ts') && file !== spec,
  );
  const parallelIntegration = new Set(
    (selection['test:integration']?.projects ?? []).flatMap((name) => collected.get(name) ?? []),
  );
  for (const file of integrationSpecs) {
    if (!parallelIntegration.has(file)) {
      problems.push(
        `${file} is not collected by identity "test:integration"; only ${spec} may leave it`,
      );
    }
  }
  const titles = stressProofTitles(specSource);
  if (titles.length < 2) {
    problems.push(`${spec} no longer names its two 500-operation proofs (found ${titles.length})`);
  }

  // CI: the integration step and the security gate go through the orchestrator.
  const integrationSteps = workflowStepCommands(ciWorkflow, CI_STEPS.integration);
  if (integrationSteps.length !== 1) {
    problems.push(
      `CI must have exactly one "${CI_STEPS.integration}" step (found ${integrationSteps.length})`,
    );
  } else if (
    !integrationSteps[0].some((line) =>
      sameWords(lineWords(line), ['pnpm', 'run', 'test:integration']),
    )
  ) {
    problems.push(`CI "${CI_STEPS.integration}" must run \`pnpm run test:integration\``);
  }
  const securitySteps = workflowStepCommands(ciWorkflow, CI_STEPS.security);
  if (securitySteps.length !== 1) {
    problems.push(
      `CI must have exactly one "${CI_STEPS.security}" step (found ${securitySteps.length})`,
    );
  } else {
    const gates = securitySteps[0]
      .map(lineWords)
      .filter((words) => sameWords(words.slice(0, 4), ['pnpm', 'run', 'test:integration', '--']));
    const patterns = gates.flatMap((words) =>
      words
        .filter((word) => word.startsWith('--testNamePattern='))
        .map((word) => word.slice('--testNamePattern='.length)),
    );
    if (gates.length !== 1 || patterns.length !== 1) {
      problems.push(
        `CI "${CI_STEPS.security}" must run \`pnpm run test:integration -- --testNamePattern=…\` exactly once`,
      );
    } else {
      let pattern;
      try {
        pattern = new RegExp(patterns[0]);
      } catch {
        problems.push(`CI "${CI_STEPS.security}" has an invalid --testNamePattern`);
      }
      for (const title of pattern ? titles : []) {
        if (!pattern.test(title)) {
          problems.push(
            `CI "${CI_STEPS.security}" pattern no longer selects the stress proof "${title}"`,
          );
        }
      }
    }
  }
  const workflowCommands = allWorkflowCommands(ciWorkflow);
  for (const gate of ['test:test-phases', 'check:test-phases']) {
    if (!workflowCommands.some((line) => sameWords(lineWords(line), ['pnpm', 'run', gate]))) {
      problems.push(`CI must run \`pnpm run ${gate}\``);
    }
  }
  for (const line of workflowCommands) {
    const words = lineWords(line);
    if (isTurboRunOf(words, [...WORKSPACE_TASKS, task])) {
      problems.push(
        `CI runs \`${line}\` through turbo directly, bypassing the two-phase orchestrator`,
      );
    }
    if (words.includes(CALIBRATION_SCRIPT) || words.includes('--calibrate')) {
      problems.push(
        `CI runs \`${line}\`; the ADR-055 calibration campaign is manual and must not run in ordinary CI`,
      );
    }
  }

  return problems;
}
