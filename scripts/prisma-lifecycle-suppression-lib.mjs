import { createHash } from 'node:crypto';
import { parseDocument } from 'yaml';
import { dockerInstructions } from './check-dockerfile-pins-lib.mjs';
import {
  dockerRun,
  effectiveShell,
  oneWord,
  plain,
  readOptions,
  readShell,
} from './ci-shell-policy-lib.mjs';
import { parseCommands, SHELL_WORD } from './ci-shell-text-lib.mjs';

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
 * `run`) is read by the shared default-deny reader (ci-shell-policy-lib.mjs) under `hostPolicy`:
 * a command word is a literal of its `programs` or a file of the inventory, or it is refused, so
 * `env`, `exec`, `sudo`, `xargs`, `npx`, a quoted or computed command word are refused without
 * being named here (PR #1085 r1). A program that can run what it is given has a closed grammar
 * there (PR #1085 r2 F1, FU-334): `pnpm`/`npm` by their option tables, so an option that is not
 * listed (`-c`, `--shell-mode`, `--config.*`) is refused; `bash` and a container's shell by
 * their `-c` body, read by the same reader; `docker` by reviewed options, mounts and container
 * programs. `node`, `git`, `go`, `psql` and `set` are read only as the exact lines of
 * `REVIEWED`, what an image starts only as the exact texts of `STARTS` (D-173). Every file is a
 * member of `files`, the inventory the caller read: a script run by its path, an action a step
 * uses, a Dockerfile a step builds. The names of `PROTECTED` are bound by no text but a
 * reviewed line.
 * Not proven (D-173: accidental regression, not a hostile edit; ci-shell-policy-lib.mjs has the
 * reader's own limits): what a listed program (`node x.mjs`, `curl`, `mc`, a repository script,
 * a reviewed action, an image's own entry point, a `package.json` script) does with the
 * environment and the operands it was given; what a variable holds where a reviewed line uses
 * it; what a program reads from a variable outside `PROTECTED`; a file a step wrote before it
 * is run or read as configuration; and the open findings of PR #1100 r1, which FU-340 holds.
 *
 * Pure: text in, problems and the lifecycle commands found out.
 */
export const VARIABLE = 'PRISMA_SKIP_POSTINSTALL_GENERATE';

const DOCKER_SETTING = `${VARIABLE}=true`;
/** The subcommands that install or rebuild dependencies: the inventory only, never the verdict. */
const LIFECYCLE =
  /\b(pnpm|npm|yarn)\b(?:\s+(?!-)\S*[=@/.]\S*|\s+-\S+)*?\s+(install|i|ci|add|deploy|rebuild|update|up|import|dlx|prune|dedupe|remove|fetch)(?=\s|$)/g;
/** Instructions that run nothing while the image is built or started. */
const DOCKER_INERT = new Set('WORKDIR COPY ADD LABEL EXPOSE USER VOLUME STOPSIGNAL'.split(' '));
const DOCKER_STARTS = new Set(['CMD', 'ENTRYPOINT', 'HEALTHCHECK']);
/**
 * All a RUN outside a suppressed stage may hold: one of these, with plain words only. The names
 * are the base image's programs only until the stage copies a file in or changes a search path.
 */
const INERT_RUN = /^(?:addgroup|adduser|rm|mkdir|chown|chmod)(?: [\w@%+=:,./-]+)+$/;
/**
 * All a container may start, by exact text (D-173): `node` on the built entry point, and the
 * health probe, whose port (written here as PORT) is the one part that differs between images.
 */
const STARTS = new Set([
  '["node", "dist/main.js"]',
  `node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||PORT)+'/health/ready',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"`,
]);
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
const UNLISTED = 'a command this check cannot prove hands on the environment';
/** A file of this repository run by its path: a listed program in the sense of the header. */
const REPO_FILE = /^(?:scripts|infrastructure)\/(?!.*\.\.)[\w./-]+$/;
/**
 * The names no text binds but a reviewed line (r1 F3): a package manager option as a variable
 * (`pnpm_config_<setting>`), the search path, a shell's startup file, and what the reviewed
 * environment-file lines are written from.
 */
const PROTECTED = /^(?:p?npm_config_\w*|PATH|BASH_ENV|ENV|GITHUB_(?:ENV|PATH)|RUNNER_TEMP)$/i;
const unassignable = (name) =>
  PROTECTED.test(name)
    ? `sets ${name}: a package manager option, the search path or an environment file is not text's to set`
    : null;
/** The one instruction that sets a protected name: every image puts pnpm's home on the path. */
const DOCKER_PATH = 'ENV PATH="$PNPM_HOME:$PATH"';
const sha256 = (text) => `sha256:${createHash('sha256').update(text).digest('hex')}`;
/**
 * A program that runs what it is given is read only as the lines reviewed here (D-173, in place
 * of PR #1101's grammars): the words after it exactly as written, joined by one blank; a long
 * line by the sha256 of `<program> <that>` (`REVIEWED_DIGESTS`). Nothing is folded: a blank changed inside a quoted
 * word is another line. `node` also runs a file the policy admits, on operands of one word each.
 */
const REVIEWED = {
  set: ['-euo pipefail'],
  git: [
    'cat-file -e "$SCAN_BASE^{commit}"',
    'cat-file -e "$SCAN_HEAD^{commit}"',
    'log -p -U0 --full-history --diff-merges=remerge "$SCAN_BASE..$SCAN_HEAD"',
    'rev-list --count "$SCAN_BASE..$SCAN_HEAD"',
    'rev-list --min-parents=3 --count "$SCAN_BASE..$SCAN_HEAD"',
  ],
  go: [
    'mod download',
    'mod verify',
    'vet ./...',
    'test -v ./...',
    'build -o "$RUNNER_TEMP/trivy-db-check-bin/trivy-db-check" .',
  ],
  psql: [
    '-U rasta -d postgres -c "SELECT 1"',
    "-X -At -c 'SHOW max_connections'",
    '-v ON_ERROR_STOP=1 -h localhost -U rasta_contract -d rasta_contract -f apps/web/e2e/fixtures/contract-statements.sql',
    '-v ON_ERROR_STOP=1 -h localhost -U rasta_marketplace -d rasta_marketplace -f apps/web/e2e/fixtures/marketplace-returns.sql',
  ],
  node: ['dist/main.js'],
};
/** ci.yml's three inline `node -e` programs (needs, clamd ping, scan range) and the reward cutover `psql -c`. */
const REVIEWED_DIGESTS = new Set([
  'sha256:d53514bb3ad8189b1c8ec7ba4e7822f87a477542d9473cb5b5c204119ffd36e2',
  'sha256:4c9ab2743c6aa630f50072254040cb56f34e7be0b4920c7e4fca4949f01a80d3',
  'sha256:fb064447788a1770ae0fd2883cb9ec041e554c356d78c0459d8e117a26b930a9',
  'sha256:aa7427c4412c4f50f5ca558d44b322051f1c2dd4477dbf0788a42773926c5317',
]);
const reviewed =
  (name, policy) =>
  (args, { state }) => {
    const text = args.map((word) => word.source).join(' ');
    const [file, ...operands] = args;
    return REVIEWED[name].includes(text) ||
      REVIEWED_DIGESTS.has(sha256(`${name} ${text}`)) ||
      (name === 'node' && plain(file) && !policy.file(file.value, state) && operands.every(oneWord))
      ? null
      : 'only the lines reviewed in REVIEWED are read';
  };

const options = (table) => (args) => readOptions(args, table).problem ?? null;
/** Every option an install-like verb is given here; an operand is a package or a directory. */
const INSTALL_OPTIONS = options({
  flags: '--frozen-lockfile --ignore-scripts --prod --legacy --offline -g',
  values: '--filter -F',
});
/** The first word after the verb is the script or program; what follows it is that one's own. */
const starts = (named) => (args) =>
  plain(args[0]) && named.test(args[0].value) ? null : 'what it starts is not one this check reads';
const INSTALL_VERBS = 'install i ci add deploy rebuild update remove prune fetch';
const verbs = (names, grammar) =>
  Object.fromEntries(names.split(' ').map((name) => [name, grammar]));
/**
 * `pnpm [--filter x]… verb …`, measured on pnpm 11.22.0: options before the verb are pnpm's own
 * (`-c`, `--shell-mode`, `--config.script-shell=x` change what runs); after `exec <program>` and
 * `run <script>` every word is handed on, quoted. A verb outside the table is a script name.
 */
const PNPM = {
  ...verbs(INSTALL_VERBS, INSTALL_OPTIONS),
  audit: options({ flags: '--prod', values: '--audit-level' }),
  config: (args) =>
    args.length === 3 &&
    args.every(plain) &&
    `${args[0].value} ${args[1].value}` === 'set store-dir'
      ? null
      : 'only `config set store-dir <path>` is read',
  run: starts(/^[A-Za-z][\w:.-]*$/),
  build: () => null,
  exec: starts(/^(?:turbo|jest|playwright)$/),
};
/**
 * npm reads an option wherever it stands, and an option it does not know as a flag: `--filter x`
 * is pnpm's, and under npm leaves `x` (or `--script-shell=…`) to be read on its own (r1 F2). So
 * npm has its own table: the install verbs, and the one option given here.
 */
const NPM = verbs('install i ci', options({ flags: '-g' }));
const packageManager = (table, before) => (args) => {
  let at = 0;
  while (plain(args[at]) && args[at].value.startsWith('-')) {
    const width = args[at].value.includes('=') ? 1 : 2;
    const { problem } = readOptions(args.slice(at, at + width), before);
    if (problem) return problem;
    at += width;
  }
  if (!plain(args[at]) || !Object.hasOwn(table, args[at].value))
    return 'its verb is not one this check reads';
  return table[args[at].value](args.slice(at + 1));
};

/**
 * A container gets none of the step's environment, so it may start only these: the first word
 * it is started on (`--entrypoint`, else the first word after the image) or a command of a `-c`
 * body. `server` and `-C` are the arguments MinIO's and mc's own entry points are given.
 */
const CONTAINER = {
  programs: verbs('clamd clamdscan freshclam promtool temporal semgrep chmod ls server -C', true),
  tolerated: READ_PAST,
  unlisted: 'a program no container is started on here',
};
/** The options of `docker run` this check has read: none names a command or a file to run. */
const RUN_OPTIONS = list('--rm -d --name --network --tmpfs -e -v -w -p --user --entrypoint');
/**
 * Every bind mount, by its exact text: none puts a file where a container program is found.
 * `$PWD` is the checkout only while the text has neither changed directory nor assigned it.
 */
export const MOUNTS = list(
  '"$PWD:/src" /tmp/clamav-socket:/run/clamav ' +
    '"$PWD/infrastructure/docker/clamav/clamd.conf:/etc/clamav/clamd.conf:ro" ' +
    '"$PWD/infrastructure/docker/clamav/freshclam.conf:/etc/clamav/freshclam.conf:ro" ' +
    '"$PWD/infrastructure/docker/prometheus:/etc/prometheus:ro" ' +
    '"$PWD/infrastructure/docker/keycloak:/opt/keycloak/data/import:ro"',
);
/**
 * The scripts a container's shell is started on, read by hand: the path in the container, the
 * mount that puts the repository file there, and the sha256 of the text that was read (the test
 * holds the file to it). dev-realm-gate.sh only starts Keycloak's launcher.
 */
export const CONTAINER_SCRIPTS = new Map([
  [
    '/opt/keycloak/data/import/dev-realm-gate.sh',
    {
      mount: '"$PWD/infrastructure/docker/keycloak:/opt/keycloak/data/import:ro"',
      file: 'infrastructure/docker/keycloak/dev-realm-gate.sh',
      sha256: 'sha256:84546a1cf8569c4693cdd96b651f5c745bd9e847ec8e394aa87a15d630c2dfb6',
    },
  ],
]);
/** `${{ env.NAME }}` as the reader sees it: one computed word (see `scriptProblems`). */
const PASTED = '__workflow_env_expression';

/** Everything a step, a RUN or a `bash -c` body may run, for the inventory `files`. */
function hostPolicy(files, cwd) {
  /** Why what a container is started on (`words`) is not read, or null. */
  const container = (words, mounts, context) => {
    const [first, ...rest] = words;
    if (!first) return null; // the image's own entry point
    if (!plain(first)) return 'what the container starts is computed';
    if (!SHELL_WORD.test(first.value))
      return Object.hasOwn(CONTAINER.programs, first.value)
        ? null
        : `\`${first.value}\` is ${CONTAINER.unlisted}`;
    const file = (path) => {
      const script = CONTAINER_SCRIPTS.get(path);
      return script && mounts.includes(script.mount) && files.has(script.file)
        ? null
        : 'is not a reviewed script of the inventory, mounted from the checkout';
    };
    return context.shell(rest, first.value, { ...CONTAINER, file });
  };
  const docker = ([verb, ...args], context) => {
    if (plain(verb) && /^(?:logs|tag)$/.test(verb.value)) return null;
    if (plain(verb) && verb.value === 'exec')
      return args.length > 1 && oneWord(args[0]) && /^[\w"$]/.test(args[0].source)
        ? container(args.slice(1), [], context)
        : 'exec names no container and command this check reads';
    if (!plain(verb) || verb.value !== 'run') return 'only run, exec, logs and tag are read';
    const run = dockerRun(args);
    if (run.problem) return run.problem;
    const unread = run.options.find(({ name }) => !RUN_OPTIONS.has(name));
    if (unread) return `option ${unread.name} is not one this check has reviewed`;
    const valuesOf = (option) =>
      run.options.filter(({ name }) => name === option).map(({ value }) => value);
    const mounts = valuesOf('-v').map(({ source }) => source);
    const { cwd: started, moved, assigned } = context.state;
    if (!mounts.every((mount) => MOUNTS.has(mount)))
      return 'a mount is not one this check has reviewed (MOUNTS)';
    if (mounts.some((mount) => mount.includes('$')) && (started || moved || assigned.has('PWD')))
      return 'a mount of $PWD after the directory changed is not the checkout';
    if (run.image.dynamic && run.image.source !== `"$${PASTED}"`)
      return 'the image is neither written out nor a value of the workflow env';
    const entry = valuesOf('--entrypoint');
    return entry.length > 1
      ? 'more than one --entrypoint'
      : container([...entry, ...run.command], mounts, context);
  };
  const file = (path, state) =>
    REPO_FILE.test(path) && !state.moved && files.has(`${state.cwd && `${state.cwd}/`}${path}`)
      ? null
      : 'is not a file of the inventory, run from the directory the text starts in';
  const policy = { tolerated: READ_PAST, unlisted: UNLISTED, name: unassignable, cwd, file };
  policy.programs = {
    ...verbs(
      'if then elif else fi for while until do done break ! [ { } true test exit echo cat tail tee ' +
        'grep seq sleep mkdir chmod rm mktemp command eval export unset curl openssl gitleaks mc',
      true,
    ),
    ...Object.fromEntries(Object.keys(REVIEWED).map((name) => [name, reviewed(name, policy)])),
    // Below the directory the text is in: a relative file is then the checkout's or built from it.
    cd: (args, context) => {
      context.leave();
      return args.length === 1 &&
        plain(args[0]) &&
        /^(?![/-])(?!.*\.\.)[\w./-]+$/.test(args[0].value)
        ? null
        : 'only a written-out directory below the current one is followed';
    },
    bash: (args, context) => context.shell(args, 'bash', policy),
    docker,
    pnpm: packageManager(PNPM, { values: '--filter -F' }),
    npm: packageManager(NPM, {}),
  };
  return policy;
}
/** `eval` runs only what the Kafka credentials script printed into the variable it names. */
const EVAL = /\beval "\$\{(\w+_credentials)\}"/g;
const credentials = (name) =>
  new RegExp(
    `\\b${name}="\\$\\((?:KAFKA_SECRETS_DIR="\\$\\{kafka_secrets_dir\\}" )?bash infrastructure/docker/kafka/kafka-credentials\\.sh [a-z -]+\\)"`,
    'g',
  );
const count = (text, pattern) => [...text.matchAll(pattern)].length;
/**
 * The only lines that may name a file later steps take their environment or search path from, or
 * a shell its startup text, by exact text (r1 F3). What the variable holds is not read.
 */
const ENV_FILE = /\b(?:GITHUB_(?:ENV|PATH)|BASH_ENV)\b/;
const ENV_FILE_LINES = new Set([
  'echo "INTERNAL_TOKEN_SECRET=${internal_secret}" >> "$GITHUB_ENV"',
  'echo "KEYCLOAK_ADMIN_PASSWORD=${keycloak_password}" >> "$GITHUB_ENV"',
  'echo "WEB_SESSION_SECRET=${web_session_secret}" >> "$GITHUB_ENV"',
  'echo "$RUNNER_TEMP/trivy-db-check-bin" >> "$GITHUB_PATH"',
]);

/**
 * GitHub pastes an expression's value in before bash reads the text. Only a value written in the
 * workflow's own `env` is read, as one computed word; any other expression can hold a command.
 */
const EXPRESSION = /\$\{\{ env\.\w+ \}\}/g;
const clip = (text) => (text.length > 80 ? `${text.slice(0, 77)}...` : text);
const lifecycle = (text) => [...text.matchAll(LIFECYCLE)].map((found) => `${found[1]} ${found[2]}`);

/**
 * Why this shell text is not proven to run every program under the environment it was given:
 * the ONE place a RUN, a step's `run` and an action's `run` are read (PR #1085 r1 F1). `files`
 * is the inventory of repository paths the caller read; `cwd` the directory the text starts in.
 */
export function scriptProblems(script, files = new Set(), cwd = '') {
  const problems = [];
  const text = script.replace(EXPRESSION, `$${PASTED}`);
  const read = readShell(text, hostPolicy(files, cwd));
  if (text.includes('${{')) problems.push('an expression other than `${{ env.NAME }}` is not read');
  if (script.includes(PASTED)) problems.push(`the name ${PASTED} is this check's own`);
  if (text.replace(/^\s*#.*$/gm, '').includes('`'))
    problems.push('a backtick command substitution is not read');
  problems.push(...read.problems);
  for (const { words } of read.commands)
    if (words.some((word) => word.value.includes(VARIABLE)))
      problems.push(`\`${clip(words.map((w) => w.value).join(' '))}\` names ${VARIABLE}`);
  const evals = read.commands.filter(({ program }) => program.value === 'eval').length;
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
  // Every command, as the tokenizer read it (a comment is none): its words and redirections as written.
  for (const { words } of parseCommands(text).commands) {
    const line = words.map(({ redirect, source }) => `${redirect ? `${redirect} ` : ''}${source}`);
    if (ENV_FILE.test(line.join(' ')) && !ENV_FILE_LINES.has(line.join(' ')))
      problems.push('writes the environment of later steps in a line this check has not reviewed');
  }
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
export function dockerfileLifecycle(name, text, _workflows, files = new Set()) {
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
    } else if (/^(?:ENV|ARG)$/.test(keyword)) {
      // One written-out name per instruction, and a protected one only by the reviewed text.
      if (!/^[A-Za-z_]\w*(?:=\S*)?$/.test(rest))
        refuse(`${keyword} ${clip(rest)} is not a form this check reads`);
      else if (unassignable(rest.split('=')[0]) && `${keyword} ${rest}` !== DOCKER_PATH)
        refuse(`${keyword} ${clip(rest)} ${unassignable(rest.split('=')[0])}`);
      if (/PATH/.test(rest)) replaced = true;
    } else if (keyword === 'RUN') {
      if (suppressed) {
        for (const problem of scriptProblems(rest.replace(/^(?:--[a-z]+=\S+\s+)+/, ''), files))
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
      if (!STARTS.has(started.replace(/\|\|\d{4}\)/, '||PORT)')))
        refuse(
          `${keyword} ${clip(rest)} does not start \`node\` directly: a shell, a script or ` +
            `a variable there runs without ${VARIABLE}`,
        );
    } else if (!DOCKER_INERT.has(keyword)) {
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

/**
 * `env` is a mapping written in the file, or it can hold anything (`env: ${{ fromJSON(…) }}`);
 * and it names no option of a package manager.
 */
const readsEnv = (where, owner, errors) => {
  if (owner.env === undefined) return true;
  if (!record(owner.env)) return !errors.push(`${where}: env is not a mapping this check reads`);
  for (const name of Object.keys(owner.env))
    if (unassignable(name)) errors.push(`${where}: env ${unassignable(name)}`);
  return true;
};

/** The actions a step may use besides the repository's own: none builds from a file it is given. */
const ACTIONS = list(
  'actions/cache actions/checkout actions/download-artifact actions/setup-node actions/upload-artifact ' +
    'aquasecurity/setup-trivy aquasecurity/trivy-action docker/setup-buildx-action pnpm/action-setup',
);
/** The one action that builds an image, and every input it is given here. */
const BUILD_ACTION = 'docker/build-push-action';
const BUILD_INPUTS = list('context file tags push load cache-from cache-to');
/**
 * A matrix value this check cannot list, by the exact expression that computes it and why every
 * value is a path segment of an inventoried Dockerfile. Not a proof: a reviewed source.
 */
const MATRIX_SOURCES = new Map([
  [
    '${{ fromJSON(needs.container-scope.outputs.services) }}',
    'scripts/container-scope.mjs prints the names of services/<name> directories that hold a Dockerfile',
  ],
]);

/**
 * The repository files a build's `file` input names, or none when that cannot be told: a literal
 * path, or one `${{ matrix.NAME }}` whose values are a list written in the job (each is tried) or
 * a reviewed source (every inventory file of that shape). Any other expression resolves nothing.
 */
function buildFiles(file, matrix, files) {
  if (typeof file !== 'string') return [];
  const [expression, ...more] = new Set(file.match(/\$\{\{.*?\}\}/g));
  if (expression === undefined) return [file];
  const name = /^\$\{\{ matrix\.([\w-]+) \}\}$/.exec(expression)?.[1];
  if (!name || more.length > 0 || !record(matrix) || Object.hasOwn(matrix, 'include')) return [];
  const values = matrix[name];
  if (Array.isArray(values) && values.every((value) => typeof value === 'string'))
    return values.map((value) => file.replaceAll(expression, value));
  if (!MATRIX_SOURCES.has(values)) return [];
  const [before, after] = file.split(expression);
  if (file.split(expression).length !== 2) return [];
  return [...files].filter(
    (path) =>
      path.startsWith(before) &&
      path.endsWith(after) &&
      /^[^/]+$/.test(path.slice(before.length, path.length - after.length)),
  );
}

/** Why a step's `uses` and `with` are not read: an unreviewed action, or a build input outside the inventory. */
function usesProblems(step, matrix, files) {
  const uses = String(step.uses);
  const local = /^\.\/(\.github\/actions\/[\w-]+)$/.exec(uses)?.[1];
  const action = /^([\w.-]+\/[\w.-]+)@[\w.-]+$/.exec(uses)?.[1];
  const problems = [];
  if (
    local
      ? !files.has(`${local}/action.yml`) && !files.has(`${local}/action.yaml`)
      : action !== BUILD_ACTION && !ACTIONS.has(action)
  )
    problems.push(`uses ${clip(uses)}, an action this check has neither read nor reviewed`);
  if (step.with !== undefined && !record(step.with))
    problems.push(`builds ${clip(String(step.with))}, a file this check does not read`);
  if (action !== BUILD_ACTION || !record(step.with ?? {})) return problems;
  const inputs = step.with ?? {};
  for (const key of Object.keys(inputs))
    if (!BUILD_INPUTS.has(key))
      problems.push(`build input ${clip(key)} is not one this check reads`);
  if (inputs.context !== undefined && inputs.context !== '.')
    problems.push(`builds from ${clip(String(inputs.context))}, not from the checkout`);
  const file = inputs.file ?? 'Dockerfile';
  const built = buildFiles(file, matrix, files);
  if (
    built.length === 0 ||
    !built.every((path) => files.has(path) && lifecycleFileKind(path) === 'dockerfile')
  )
    problems.push(`builds ${clip(String(file))}, a file this check does not read`);
  return problems;
}

/**
 * Problems of the steps themselves: an unknown shell, an opaque `env`, a script that is not
 * proven, an action nobody reviewed, a build of a file outside the inventory `files`
 * (`file: Containerfile`, `/tmp/Dockerfile`, `${{ env.ROOT }}/Dockerfile`). `matrix` is the job's.
 */
function stepProblems(where, step, errors, commands, files, matrix, composite = false) {
  if (!record(step)) return void errors.push(`${where} is not a mapping`);
  const refuse = (problem) => errors.push(`${where}: ${problem}`);
  readsEnv(where, step, errors);
  const { problem } = effectiveShell({ step, composite: composite && step.run !== undefined });
  if (problem) refuse(problem);
  if (step.uses !== undefined) usesProblems(step, matrix, files).forEach(refuse);
  else if (step.with !== undefined) refuse('with is given to no action');
  if (step.run === undefined) return;
  if (typeof step.run !== 'string') return void refuse('run is not text');
  const cwd = step['working-directory'] ?? '';
  if (typeof cwd !== 'string' || !/^(?![/-])(?!.*\.\.)[\w./-]*$/.test(cwd))
    return void refuse('working-directory is not a written-out directory of the checkout');
  scriptProblems(step.run, files, cwd).forEach(refuse);
  commands.push(...lifecycle(step.run));
}

/**
 * @param {string} name
 * @param {string} text
 * @param {Record<string, string>} workflows Independently inventoried repository workflow texts.
 * @param {Set<string>} files Every repository path of the inventory the caller read.
 * @param {string[]} ancestors Calls already being checked; no environment is inherited.
 * @returns {{ errors: string[], commands: string[] }}
 */
export function workflowLifecycle(name, text, workflows = {}, files = new Set(), ancestors = []) {
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
  const unread = effectiveShell({ workflow }).problem;
  if (unread) errors.push(`${name}: ${unread}`);
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
        const called = workflowLifecycle(target, workflows[target], workflows, files, [
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
    const jobShell = effectiveShell({ job }).problem;
    if (jobShell) errors.push(`${where}: ${jobShell}`);
    const inJob = sets(where, job);
    for (const [index, step] of job.steps.entries()) {
      const at = `${where} step ${index + 1}`;
      stepProblems(at, step, errors, commands, files, job.strategy?.matrix);
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
export function actionLifecycle(name, text, _workflows, files = new Set()) {
  const read = readYaml(name, text);
  if (read.problem) return { errors: [read.problem], commands: [] };
  const errors = [];
  const commands = [];
  const runs = record(read.value) ? read.value.runs : undefined;
  if (!record(runs) || runs.using !== 'composite' || !Array.isArray(runs.steps))
    return { errors: [`${name}: not a composite action this check reads`], commands };
  for (const [index, step] of runs.steps.entries())
    stepProblems(`${name}: step ${index + 1}`, step, errors, commands, files, null, true);
  if (read.named !== 0)
    errors.push(`${name}: an action inherits ${VARIABLE} from its caller and may not name it`);
  return { errors, commands };
}
