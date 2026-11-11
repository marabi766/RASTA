import { parseDocument } from 'yaml';
import { dockerInstructions } from './check-dockerfile-pins-lib.mjs';

/**
 * No dependency lifecycle hook generates the Prisma client (FU-329).
 *
 * `@prisma/client` generates from its postinstall hook unless this variable is set, and that
 * generation is outside scripts/prisma-generate.mjs: one attempt, no retry, and a failure the
 * hook swallows. `pnpm install` runs the hook, and so do `pnpm deploy`, a rebuild, an add and a
 * `pnpm run` that finds stale dependencies; a script or an action a step starts can run any of
 * them. So the rule is about where a command runs, not which command it is:
 *
 *  - Dockerfile: a RUN is read only inside a stage that set the variable with the one ENV form
 *    (or started FROM such a stage). Outside one, a RUN may hold only commands that start no
 *    other program (`INERT_RUN`), and no other instruction may name a package manager.
 *  - workflow: every step of every job runs under the variable from its workflow, job or step
 *    `env`. A job that calls another workflow is refused: `env` does not reach it.
 *  - composite action: its steps inherit the calling step's environment (which the workflow rule
 *    covers), so it may not name the variable at all.
 *
 * Everywhere the variable may be named only by that one setting, never in a command (an
 * assignment, an unset, a `$GITHUB_ENV` line), and a script that names a package manager may
 * not use a command that replaces the environment (`env`, `su`, `sudo`). What cannot be read is
 * refused. Not proven: that a program a step starts hands its own environment on unchanged.
 *
 * Pure: text in, problems and the lifecycle commands found out.
 */
export const VARIABLE = 'PRISMA_SKIP_POSTINSTALL_GENERATE';

const DOCKER_SETTING = `${VARIABLE}=true`;
const PACKAGE_MANAGER = /p?np[mx]|yarn|corepack|\bbunx?\b/i;
/** The subcommands that install or rebuild dependencies: the inventory only, never the verdict. */
const LIFECYCLE =
  /\b(pnpm|npm|yarn)\b(?:\s+(?!-)\S*[=@/.]\S*|\s+-\S+)*?\s+(install|i|ci|add|deploy|rebuild|update|up|import|dlx|prune|dedupe|remove|fetch)(?=\s|$)/g;
/** Instructions that run nothing while the image is built or started. */
const DOCKER_INERT = new Set('ARG WORKDIR COPY ADD LABEL EXPOSE USER VOLUME STOPSIGNAL'.split(' '));
const DOCKER_STARTS = new Set(['CMD', 'ENTRYPOINT', 'HEALTHCHECK']);
/** All a RUN outside a suppressed stage may hold: one of these, with plain words only. */
const INERT_RUN = /^(?:addgroup|adduser|rm|mkdir|chown|chmod)(?: [\w@%+=:,./-]+)+$/;
const REPLACES_ENVIRONMENT = /(?:^|[\s;&|(/'"=])(env|su|sudo|runuser|doas)(?=$|[\s;&|)'"])/;
const SHELLS = new Set(['bash', 'sh']);
/** The environment-replacing command of a script that also names a package manager, if any. */
const wrapped = (script) =>
  PACKAGE_MANAGER.test(script) ? script.match(REPLACES_ENVIRONMENT)?.[1] : undefined;

const clip = (text) => (text.length > 80 ? `${text.slice(0, 77)}...` : text);
const lifecycle = (text) => [...text.matchAll(LIFECYCLE)].map((found) => `${found[1]} ${found[2]}`);

/** Which rule reads this repository path, or null. Anything Docker or GitHub would run is read. */
export function lifecycleFileKind(path) {
  if (/(?:^|\/)(?:[^/]*\.)?dockerfile(?:\.[^/]*)?$/i.test(path)) return 'dockerfile';
  if (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(path)) return 'workflow';
  if (/(?:^|\/)action\.ya?ml$/.test(path)) return 'action';
  return null;
}

/**
 * @param {string} name
 * @param {string} text
 * @returns {{ errors: string[], commands: string[] }}
 */
export function dockerfileLifecycle(name, text) {
  const instructions = dockerInstructions(text);
  if (instructions.problem)
    return { errors: [`${name}: cannot be read: ${instructions.problem}`], commands: [] };
  const errors = [];
  const commands = [];
  const stages = new Map(); // lower-case stage name -> the variable is set at its end
  let stage = null;
  let suppressed = false;
  for (const { line, keyword, rest } of instructions.list) {
    const refuse = (problem) => errors.push(`${name}:${line}: ${problem}`);
    if (keyword === 'FROM') {
      if (stage) stages.set(stage, suppressed);
      const from = rest.match(/^(\S+)(?:\s+AS\s+(\S+))?$/i);
      if (!from) refuse(`FROM ${clip(rest)} is not a form this check reads`);
      suppressed = from ? stages.get(from[1].toLowerCase()) === true : false;
      stage = from?.[2]?.toLowerCase() ?? null;
    } else if (keyword === 'ENV' && rest === DOCKER_SETTING) {
      suppressed = true;
    } else if (rest.includes(VARIABLE)) {
      refuse(`${VARIABLE} may be set only by the instruction \`ENV ${DOCKER_SETTING}\``);
    } else if (keyword === 'RUN') {
      const wrapper = wrapped(rest);
      if (wrapper) refuse(`\`${wrapper}\` can replace the environment of what it runs`);
      else if (suppressed) commands.push(...lifecycle(rest));
      else if (!rest.split(' && ').every((command) => INERT_RUN.test(command)))
        refuse(
          `RUN ${clip(rest)} is outside a stage that sets \`ENV ${DOCKER_SETTING}\`: ` +
            'a dependency lifecycle hook there generates the Prisma client unwrapped',
        );
    } else if (DOCKER_STARTS.has(keyword)) {
      if (!suppressed && PACKAGE_MANAGER.test(rest))
        refuse(`${keyword} names a package manager outside a stage that sets ${VARIABLE}`);
    } else if (keyword !== 'ENV' && !DOCKER_INERT.has(keyword)) {
      refuse(`${keyword} is not an instruction this check reads`);
    }
  }
  return { errors, commands };
}

/** How often the variable is named, in a key or a value, anywhere in the parsed value. */
function named(value) {
  if (typeof value === 'string') return value.includes(VARIABLE) ? 1 : 0;
  if (value === null || typeof value !== 'object') return 0;
  return Object.entries(value).reduce((sum, [key, held]) => sum + named(key) + named(held), 0);
}

/**
 * The parsed YAML with its aliases resolved (ci.yml repeats steps through them), so an aliased
 * step is read at every place it runs; or the reason it is refused. Merge keys are not applied.
 */
function readYaml(name, text) {
  const document = parseDocument(text, { uniqueKeys: true, merge: false });
  if (document.errors.length > 0)
    return { problem: `${name}: cannot be read: ${document.errors[0].message}` };
  const value = document.toJS();
  return { value, named: named(value) };
}

const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Problems of the steps themselves: a shell this check does not know, an environment wrapper. */
function stepProblems(where, step, errors, commands) {
  if (!record(step)) return void errors.push(`${where} is not a mapping`);
  if (step.shell !== undefined && !SHELLS.has(step.shell))
    errors.push(`${where}: shell ${clip(String(step.shell))} is not one this check reads`);
  if (step.run === undefined) return;
  if (typeof step.run !== 'string') return void errors.push(`${where}: run is not text`);
  const wrapper = wrapped(step.run);
  if (wrapper) errors.push(`${where}: \`${wrapper}\` can replace the environment of what it runs`);
  commands.push(...lifecycle(step.run));
}

/**
 * @param {string} name
 * @param {string} text
 * @returns {{ errors: string[], commands: string[] }}
 */
export function workflowLifecycle(name, text) {
  const read = readYaml(name, text);
  if (read.problem) return { errors: [read.problem], commands: [] };
  const errors = [];
  const commands = [];
  const workflow = read.value;
  let settings = 0;
  // Set at this level, or not; a value other than the string 'true' is refused, never read past.
  const sets = (where, owner) => {
    if (owner.env !== undefined && !record(owner.env)) {
      errors.push(`${where}: env is not a mapping this check reads`);
      return false;
    }
    if (!owner.env || !Object.hasOwn(owner.env, VARIABLE)) return false;
    settings += 1;
    if (owner.env[VARIABLE] === 'true') return true;
    errors.push(`${where}: ${VARIABLE} must be the string 'true'`);
    return false;
  };
  if (!record(workflow) || !record(workflow.jobs) || Object.keys(workflow.jobs).length === 0)
    return { errors: [`${name}: no jobs were read`], commands };
  const everywhere = sets(name, workflow);
  const shell = workflow.defaults?.run?.shell;
  if (shell !== undefined && !SHELLS.has(shell))
    errors.push(`${name}: shell ${clip(String(shell))} is not one this check reads`);
  for (const [id, job] of Object.entries(workflow.jobs)) {
    const where = `${name}: job ${id}`;
    if (!record(job) || !Array.isArray(job.steps)) {
      errors.push(`${where} has no steps this check reads (a called workflow gets no env)`);
      continue;
    }
    const jobShell = job.defaults?.run?.shell;
    if (jobShell !== undefined && !SHELLS.has(jobShell))
      errors.push(`${where}: shell ${clip(String(jobShell))} is not one this check reads`);
    const inJob = sets(where, job);
    for (const [index, step] of job.steps.entries()) {
      const at = `${where} step ${index + 1}`;
      stepProblems(at, step, errors, commands);
      const inStep = record(step) && sets(at, step);
      if (!everywhere && !inJob && !inStep)
        errors.push(
          `${at} runs without ${VARIABLE}: 'true' in its workflow, job or step env: ` +
            'a dependency lifecycle hook there generates the Prisma client unwrapped',
        );
    }
  }
  if (read.named !== settings)
    errors.push(`${name}: ${VARIABLE} may be named only as a workflow, job or step env entry`);
  return { errors, commands };
}

/**
 * @param {string} name
 * @param {string} text
 * @returns {{ errors: string[], commands: string[] }}
 */
export function actionLifecycle(name, text) {
  const read = readYaml(name, text);
  if (read.problem) return { errors: [read.problem], commands: [] };
  const errors = [];
  const commands = [];
  const runs = record(read.value) ? read.value.runs : undefined;
  if (!record(runs) || runs.using !== 'composite' || !Array.isArray(runs.steps))
    return { errors: [`${name}: not a composite action this check reads`], commands };
  for (const [index, step] of runs.steps.entries())
    stepProblems(`${name}: step ${index + 1}`, step, errors, commands);
  if (read.named !== 0)
    errors.push(`${name}: an action inherits ${VARIABLE} from its caller and may not name it`);
  return { errors, commands };
}
