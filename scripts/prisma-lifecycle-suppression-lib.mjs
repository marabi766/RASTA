import { parseDocument } from 'yaml';
import { dockerInstructions } from './check-dockerfile-pins-lib.mjs';
import { executionChain, parseCommands } from './ci-shell-text-lib.mjs';

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
 *    `env`. Local called workflows are read separately: the caller's `env` does not reach them.
 *    Missing, remote, mixed runner/call and cyclic workflow calls are refused.
 *  - composite action: its steps inherit the calling step's environment (which the workflow rule
 *    covers), so it may not name the variable at all.
 *
 * Everywhere the variable may be named only by that one setting. Shell text (a RUN, a step's
 * `run`) is read by the shared tokenizer and refused unless every command word is a literal from
 * `COMMANDS`: those hand their environment on unchanged, and the few that could change it or
 * start something outside it (`export`, `unset`, `eval`, `bash`, `docker`, `pnpm`, `npm`) are held
 * to the forms in `FORMS`. So `env`, `exec`, `sudo`, a quoted or computed command word and any
 * command not listed are refused without being named here (PR #1085 r1). What an image starts
 * is `node` itself and nothing else, an `env` is a mapping written in the file, and a build names
 * a file the rule below reads as a Dockerfile.
 * Not proven: what a listed program (`node x.mjs`, a repository script, an action, an image's
 * own entry point, a `package.json` script) does with the environment it was given.
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
/**
 * All a RUN outside a suppressed stage may hold: one of these, with plain words only. The names
 * are the base image's programs only until the stage copies a file in or changes a search path.
 */
const INERT_RUN = /^(?:addgroup|adduser|rm|mkdir|chown|chmod)(?: [\w@%+=:,./-]+)+$/;
/** All a container may start: `node` itself, on a plain path or on inline text that quotes nothing. */
const STARTS_NODE = /^(?:\["node"(?:, "[\w./-]+")+\]|node -e "[^"\\$`]*")$/;
const SHELLS = new Set(['bash', 'sh']);
const list = (text) => new Set(text.split(' '));
/**
 * What the tokenizer does not model but still reads as commands: nothing hides behind these.
 * A backslash inside `$( )` is read as bash reads it; inside backticks it is not (bash removes it
 * first, so an escaped backtick starts a command the tokenizer sees as text): no backticks at all.
 */
const READ_PAST = new Set([
  'redirection',
  'a pipeline, an || list or a background command',
  'a subshell or an arithmetic command',
  'an unbalanced closing parenthesis',
  'a non-ASCII character',
  'a backslash inside a command substitution',
  'a parameter expansion with an operator, subscript or nested text',
]);
/** Every word that may stand where a command runs. Each hands its environment on as it got it. */
const COMMANDS = list(
  'if then elif else fi for while until do done break ! [ { } true test set cd exit echo cat tail tee grep seq sleep ' +
    'mkdir chmod rm mktemp command export unset eval bash docker pnpm npm node go git curl psql ' +
    'openssl gitleaks mc',
);
/** A file of this repository run by its path: a listed program in the sense of the header. */
const REPO_FILE = /^(?:scripts|infrastructure)\/(?!.*\.\.)[\w./-]+$/;
/** The one script a container is started on, read by hand: it only starts Keycloak's launcher. */
const KEYCLOAK_GATE = '/opt/keycloak/data/import/dev-realm-gate.sh';
const PNPM_EXEC = list('turbo jest playwright');
/** A container gets none of the step's environment: its words may name nothing that installs. */
const INSTALLS = new RegExp(`${PACKAGE_MANAGER.source}|\\bnode\\b|\\.(?:sh|[cm]?js)\\b`, 'i');
/** `NAME=…` with the name written out: bash runs `A$x=1` as a command, not as an assignment. */
const assigns = (word) =>
  /^[A-Za-z_]\w*\+?=/.test(word.dynamic ? word.value.slice(0, word.cut) : word.value);
const plain = (word) => word && !word.dynamic;
const isName = (word) => plain(word) && /^[A-Za-z_]\w*$/.test(word.value);
/** Any other first word a package manager runs as a script or, failing that, as a program. */
const VERBS = list(
  'install i ci add deploy rebuild update remove prune fetch audit config run build exec',
);
const TAKES_VALUE = list('--filter -F --dir -C');
/** `pnpm [options] verb …` with the verb written out; `exec` starts a listed program only. */
const runsListed = (args) => {
  const at = args.findIndex(
    (word, index) => !word.value.startsWith('-') && !TAKES_VALUE.has(args[index - 1]?.value),
  );
  const [verb, program] = [args[at], args[at + 1]];
  if (!plain(verb) || !VERBS.has(verb.value)) return false;
  return verb.value !== 'exec' || (plain(program) && PNPM_EXEC.has(program.value));
};
/** The only forms of the commands that can change the environment or start something outside it. */
const FORMS = {
  export: (args) => args.every((word) => assigns(word) || isName(word)),
  unset: (args) => args.every(isName),
  bash: (args) => plain(args[0]) && REPO_FILE.test(args[0].value),
  docker: ([verb, ...args]) =>
    /^(?:logs|tag)$/.test(verb?.value) ||
    (/^(?:run|exec)$/.test(verb?.value) &&
      !args.some((word) => INSTALLS.test(word.value) && word.value !== KEYCLOAK_GATE)),
  pnpm: runsListed,
  npm: runsListed,
};
/** `eval` runs only what the Kafka credentials script printed into the variable it names. */
const EVAL = /\beval "\$\{(\w+_credentials)\}"/g;
const credentials = (name) =>
  new RegExp(
    `\\b${name}="\\$\\((?:KAFKA_SECRETS_DIR="\\$\\{kafka_secrets_dir\\}" )?bash infrastructure/docker/kafka/kafka-credentials\\.sh [a-z -]+\\)"`,
    'g',
  );
const count = (text, pattern) => [...text.matchAll(pattern)].length;
/** The one line that may write the environment of later steps. */
const GITHUB_ENV = /^\s*(?:#.*|echo "[A-Z][A-Z0-9_]*=\$\{\w+\}" >> "\$GITHUB_ENV")$/;

/**
 * GitHub pastes an expression's value in before bash reads the text. Only a value written in the
 * workflow's own `env` is read, as one computed word; any other expression can hold a command.
 */
const EXPRESSION = /\$\{\{ env\.\w+ \}\}/g;
const clip = (text) => (text.length > 80 ? `${text.slice(0, 77)}...` : text);
const lifecycle = (text) => [...text.matchAll(LIFECYCLE)].map((found) => `${found[1]} ${found[2]}`);

/**
 * Why this shell text is not proven to run every program under the environment it was given:
 * the ONE place a RUN, a step's `run` and an action's `run` are read (PR #1085 r1 F1).
 */
export function scriptProblems(script) {
  const problems = [];
  const text = script.replace(EXPRESSION, '$_').replace(/\d*>&\d+/g, '');
  const read = parseCommands(text);
  if (text.includes('${{')) problems.push('an expression other than `${{ env.NAME }}` is not read');
  if (text.replace(/^\s*#.*$/gm, '').includes('`'))
    problems.push('a backtick command substitution is not read');
  for (const unread of read.problems)
    if (!READ_PAST.has(unread)) problems.push(`${unread} is not read`);
  let evals = 0;
  for (const { words } of read.commands) {
    const refuse = (why) =>
      problems.push(`\`${clip(words.map((w) => w.value).join(' '))}\` ${why}`);
    if (words.some((word) => word.value.includes(VARIABLE))) refuse(`names ${VARIABLE}`);
    const { chain, problem } = executionChain(words);
    if (problem) refuse(problem);
    for (const at of chain) {
      const { value, dynamic } = words[at];
      if (
        dynamic
          ? /\w/.test(value) || !COMMANDS.has(value)
          : !COMMANDS.has(value) && !REPO_FILE.test(value)
      )
        refuse(`runs \`${value}\`, a command this check cannot prove hands on the environment`);
    }
    const last = chain.at(-1) ?? words.length;
    if (!words.slice(0, last).every((word, at) => chain.includes(at) || assigns(word)))
      refuse('has a word before its command that is not an assignment to a written-out name');
    const form = FORMS[words[last]?.value];
    if (form && !form(words.slice(last + 1)))
      refuse(`is not a form of \`${words[last].value}\` this check reads`);
    if (words[last]?.value === 'eval') evals += 1;
  }
  const evaluated = [...text.matchAll(EVAL)];
  if (
    evals !== evaluated.length ||
    evaluated.some(
      ({ 1: name, index }) =>
        count(text.slice(0, index), credentials(name)) === 0 ||
        count(text, credentials(name)) !== count(text, new RegExp(`\\b${name}\\+?=`, 'g')),
    )
  )
    problems.push('`eval` runs text other than what kafka-credentials.sh printed');
  if (
    script
      .split('\n')
      .some((line) => /\b(?:GITHUB|BASH)_ENV\b/.test(line) && !GITHUB_ENV.test(line))
  )
    problems.push('writes the environment of later steps in a form this check does not read');
  return problems;
}

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
  const stages = new Map(); // lower-case stage name -> its state at its end
  let stage = null;
  let suppressed = false;
  let replaced = false; // a file was copied in or a search path changed: names prove nothing
  for (const { line, keyword, rest } of instructions.list) {
    const refuse = (problem) => errors.push(`${name}:${line}: ${problem}`);
    if (keyword === 'FROM') {
      if (stage) stages.set(stage, { suppressed, replaced });
      const from = rest.match(/^(\S+)(?:\s+AS\s+(\S+))?$/i);
      if (!from) refuse(`FROM ${clip(rest)} is not a form this check reads`);
      ({ suppressed, replaced } = stages.get(from?.[1].toLowerCase()) ?? {
        suppressed: false,
        replaced: false,
      });
      stage = from?.[2]?.toLowerCase() ?? null;
    } else if (keyword === 'ENV' && rest === DOCKER_SETTING) {
      suppressed = true;
    } else if (rest.replace(/["'\\]/g, '').includes(VARIABLE)) {
      refuse(`${VARIABLE} may be set only by the instruction \`ENV ${DOCKER_SETTING}\``);
    } else if (keyword === 'RUN') {
      if (suppressed) {
        for (const problem of scriptProblems(rest.replace(/^(?:--[a-z]+=\S+\s+)+/, '')))
          refuse(`RUN ${problem}`);
        commands.push(...lifecycle(rest));
      } else if (replaced || !rest.split(' && ').every((command) => INERT_RUN.test(command)))
        refuse(
          `RUN ${clip(rest)} is outside a stage that sets \`ENV ${DOCKER_SETTING}\`: ` +
            'a dependency lifecycle hook there generates the Prisma client unwrapped',
        );
    } else if (DOCKER_STARTS.has(keyword)) {
      const started =
        keyword === 'HEALTHCHECK' ? rest.replace(/^(?:--[a-z-]+=\w+ +)*CMD /, '') : rest;
      if (!STARTS_NODE.test(started) || PACKAGE_MANAGER.test(rest))
        refuse(
          `${keyword} ${clip(rest)} does not start \`node\` directly: a shell, a script or ` +
            `a variable there runs without ${VARIABLE}`,
        );
    } else if (keyword === 'ENV' && !/^[A-Za-z_]\w*=\S*$/.test(rest)) {
      refuse(`ENV ${clip(rest)} is not a form this check reads`);
    } else if (keyword !== 'ENV' && !DOCKER_INERT.has(keyword)) {
      refuse(`${keyword} is not an instruction this check reads`);
    } else if (keyword === 'COPY' || keyword === 'ADD' || /PATH/.test(rest)) {
      replaced = true;
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
const CALL_KEYS = new Set('name uses permissions needs if strategy with concurrency'.split(' '));

/** `env` is a mapping written in the file, or it can hold anything (`env: ${{ fromJSON(…) }}`). */
const readsEnv = (where, owner, errors) =>
  owner.env === undefined ||
  record(owner.env) ||
  !errors.push(`${where}: env is not a mapping this check reads`);

/**
 * Problems of the steps themselves: an unknown shell, an opaque `env`, a script that is not
 * proven, a build of a file the name rule above does not read (`file: Containerfile`).
 */
function stepProblems(where, step, errors, commands) {
  if (!record(step)) return void errors.push(`${where} is not a mapping`);
  readsEnv(where, step, errors);
  if (step.shell !== undefined && !SHELLS.has(step.shell))
    errors.push(`${where}: shell ${clip(String(step.shell))} is not one this check reads`);
  const built = record(step.with ?? {}) ? step.with?.file : step.with;
  if (built !== undefined && lifecycleFileKind(String(built)) !== 'dockerfile')
    errors.push(`${where}: builds ${clip(String(built))}, a file this check does not read`);
  if (step.run === undefined) return;
  if (typeof step.run !== 'string') return void errors.push(`${where}: run is not text`);
  for (const problem of scriptProblems(step.run)) errors.push(`${where}: ${problem}`);
  commands.push(...lifecycle(step.run));
}

/**
 * @param {string} name
 * @param {string} text
 * @param {Record<string, string>} workflows Independently inventoried repository workflow texts.
 * @param {string[]} ancestors Calls already being checked; no environment is inherited.
 * @returns {{ errors: string[], commands: string[] }}
 */
export function workflowLifecycle(name, text, workflows = {}, ancestors = []) {
  if (ancestors.includes(name)) return { errors: [`${name}: cyclic workflow call`], commands: [] };
  const read = readYaml(name, text);
  if (read.problem) return { errors: [read.problem], commands: [] };
  const errors = [];
  const commands = [];
  const workflow = read.value;
  let settings = 0;
  // Set at this level, or not; a value other than the string 'true' is refused, never read past.
  const sets = (where, owner, isStep) => {
    if (!isStep && !readsEnv(where, owner, errors)) return false;
    if (!record(owner.env) || !Object.hasOwn(owner.env, VARIABLE)) return false;
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
    if (record(job) && Object.hasOwn(job, 'uses')) {
      const target =
        typeof job.uses === 'string' && /^\.\/\.github\/workflows\/[\w-]+\.ya?ml$/.test(job.uses)
          ? job.uses.slice(2)
          : null;
      if (
        !target ||
        !Object.keys(job).every((key) => CALL_KEYS.has(key)) ||
        !Object.hasOwn(workflows, target) ||
        typeof workflows[target] !== 'string'
      )
        errors.push(
          `${where}: called workflow is unreadable or not a local call without runner settings`,
        );
      else {
        const called = workflowLifecycle(target, workflows[target], workflows, [
          ...ancestors,
          name,
        ]);
        errors.push(...called.errors);
        commands.push(...called.commands);
      }
      continue;
    }
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
      const inStep = record(step) && sets(at, step, true);
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
