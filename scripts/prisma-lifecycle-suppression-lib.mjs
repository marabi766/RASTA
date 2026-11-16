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
import { READ_PAST, writeProblems } from './ci-write-targets-lib.mjs';

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
 * it; what a program reads from a variable outside `PROTECTED`; what a listed program itself
 * writes into the checkout. FU-340 part B: a step writes nothing into the checkout that the
 * shared model (ci-write-targets-lib.mjs) can see but a reviewed output, so a file a later step
 * runs or reads as configuration is still the repository's. PR #1100 r1 (F1 containers and services, F2 directories, F3
 * the computed matrix) and FU-340 part A (a `cd` that may not have run, one record per write to
 * an environment file, protected names in an `env`) are closed by refusal at the places marked.
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
const UNLISTED = 'a command this check cannot prove hands on the environment';
/** A file of this repository run by its path: a listed program in the sense of the header. */
const REPO_FILE = /^(?:scripts|infrastructure)\/(?!.*\.\.)[\w./-]+$/;
/**
 * The names no text binds but a reviewed line (r1 F3): a package manager option as a variable
 * (`pnpm_config_<setting>`), the search path, a shell's startup file, everything the runner
 * itself sets (`GITHUB_*`), and what the reviewed environment-file lines are written from.
 * FU-340 (PM): shell text, an `env` mapping and an ENV/ARG set none of them but as a pair
 * reviewed in `ENV_PAIRS` or `DOCKER_ENV`. #1118 F4, by family and not by name: what makes a
 * program a step starts load code or a startup file that is not the repository's: the dynamic
 * loader (`LD_*`), bash (`BASH*`, `SHELLOPTS`, `PS4`, `IFS`), git (`GIT_*`: its ssh command, its
 * configuration, its helpers), `node` (every `NODE_*`), `go` (`GO…`, `CGO_*`: flags, toolchain,
 * compiler, `CC`, `CXX`), `openssl` (`OPENSSL_*`: its configuration loads modules), `docker`
 * (`DOCKER_*`: its plugins and helpers), `gitleaks` (`GITLEAKS_CONFIG*`: its rules), what `pnpm`
 * starts (`TURBO_*`, `PRISMA_*` but the one this check is about, `COREPACK_*`, `PLAYWRIGHT_*`,
 * any `*_BINARY_PATH`), the startup files of `psql` and `curl`, and where every one of them
 * looks for its own (`HOME`, `XDG_*`) or `mktemp` puts a file (`TMPDIR`); and `INPUT_*`, the
 * form an action reads its inputs in (they are given in `with`, where they are read). PR #1154
 * r1 F3: `PNPM_HOME`, which the reviewed `PATH` line of every image puts on the search path;
 * the service and system files of `psql` (`PGSERVICEFILE`, `PGSYSCONFDIR`); what glibc loads
 * (`GCONV_PATH`, `GLIBC_TUNABLES`); and where two programs listed by name alone write with no
 * word saying so (`MC_CONFIG_DIR`, `RANDFILE`). A list of families is not closed: a name outside
 * it that a program reads is not refused (the reverse list is FU-340 part C). These names are
 * read as the programs read them, in capitals (F5): `goal=` or `cc=` in a text is a variable of
 * its own. A package manager option (`PROTECTED`) is read in any case, as npm reads it.
 */
const PROTECTED = /^(?:p?npm_config_\w*|PATH|CDPATH|BASH_ENV|ENV|GITHUB_\w*|RUNNER_TEMP)$/i;
const LOADED =
  /^(?:LD_\w+|GCONV_PATH|GLIBC_TUNABLES|BASH\w*|SHELLOPTS|PS\d|IFS|HOME|XDG_\w+|TMPDIR|GIT_\w+|GO[A-Z\d]+|CGO_\w+|CC|CXX|OPENSSL_\w+|RANDFILE|DOCKER_\w+|GITLEAKS_CONFIG\w*|MC_CONFIG_DIR|PNPM_HOME|TURBO_\w+|PRISMA_(?!SKIP_POSTINSTALL_GENERATE$)\w+|COREPACK_\w+|PLAYWRIGHT_\w+|\w+_BINARY_PATH|PSQLRC|PGSYSCONFDIR|PGSERVICEFILE|CURL_HOME|INPUT_\w+)$/;
const unassignable = (name) =>
  PROTECTED.test(name)
    ? `sets ${name}: a package manager option, the search path or an environment file is not text's to set`
    : LOADED.test(name) || /^NODE_/.test(name)
      ? `sets ${name}: what ${/^NODE_/.test(name) ? 'node' : 'a program'} loads is not text's to set`
      : null;
/**
 * FU-340: the only settings of a protected name in a YAML `env`, each with the value as written.
 * #1118 F3: a pair is reviewed for one level of one file, `<path>: <level>: NAME=value`, the
 * level being `workflow`, `job`, `step` or `service`: what a service container may be given is
 * not thereby given to every step. None names code to load: the major version
 * `actions/setup-node` installs, the mode the services and their tests start in, and `go`
 * refusing to change go.mod or to fetch another toolchain (trivy-db-check).
 */
export const ENV_PAIRS = new Set([
  '.github/workflows/ci.yml: workflow: NODE_VERSION=22',
  '.github/workflows/backup-drill-monthly.yml: workflow: NODE_VERSION=22',
  '.github/workflows/ci.yml: step: NODE_ENV=test',
  '.github/workflows/ci.yml: step: GOFLAGS=-mod=readonly',
  '.github/workflows/ci.yml: step: GOTOOLCHAIN=local',
]);
/**
 * The instructions that set a protected name: every image puts pnpm's home on the path and runs
 * in production mode. F3: that home is the one written here, so the `PATH` line names `/pnpm`.
 */
const DOCKER_ENV = new Set([
  'ENV PNPM_HOME=/pnpm',
  'ENV PATH="$PNPM_HOME:$PATH"',
  'ENV NODE_ENV=production',
]);
/**
 * #1118 F2: the runner's own files are named in a reviewed line of shell text (`ENV_FILE`),
 * never handed on as a value: `OUT: ${{ github.env }}` then `>> "$OUT"` wrote records no line
 * here had read. In an expression `github` is followed by a written-out member that is none of
 * the four; an index, a call on the whole context or one of them may be such a file. Where an
 * expression ends is not read (`}}` may stand in a string of it): the value from the first on.
 */
const RUNNER_FILE = /\bgithub\b(?!\s*\.\s*(?!(?:env|path|output|state)\b)[a-z_])/i;
const handsOnRunnerFile = (value) =>
  typeof value === 'string' &&
  value.includes('${{') &&
  RUNNER_FILE.test(value.slice(value.indexOf('${{')));
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
// ci.yml's 14 `docker run` lines (see `DOCKER_EXEC`), then its three inline `node -e` programs
// (needs, clamd ping, scan range) and the reward cutover `psql -c`.
const REVIEWED_DIGESTS = new Set([
  'sha256:5457da3832a4bdce24d1c6d1adb54eb44e6c85342fb60768a817fd3d523dedac',
  'sha256:bf1d5134e0f94054dff9fb8a189b13e2ed3f0a4a6bd25775c446c19131c862f4',
  'sha256:7830520089d9748112e9f3560a1f909e957de3ba9a1ee5a35b92528747278aa8',
  'sha256:ad747d974f71129cdaef2ee88bfca00584e94b47f7d5d6fc36279d8d3434a96a',
  'sha256:cfd4b89a957ede94700d61c35c35c6a5ce88e106b6a600656e2dfd3168430c7f',
  'sha256:f4bd9df3ac2039b8c0651a89fe82e72c8d45de6ef79edb50bc309225b237f923',
  'sha256:934913e0c10e964bc7aedb46b2f2679914a6f7e4e29216dfdf80401d657cf320',
  'sha256:77a343cf9f0e859a5f13c1a64fa834c4eacaa85b1541ff617b1439e92c3d30a6',
  'sha256:bbc44e6837fc3052eec8be99b825b31fb7fef81230dcb8ff18718855a995dfd4',
  'sha256:69113fd31c6eb106c586e29845cc4263a91e3b4bef644322d8a6c92546c17d5a',
  'sha256:7ef4a7794fd6c7f72cd7d11d8c8ced22455254fb9a417b8792cb9c053965d2bf',
  'sha256:a8f396fca65ea8e6df7d9f40d02f6ddfa7d3556e4d0afb419d054f7dc726694d',
  'sha256:1e40ce9d14b96d7be49cbe7ce55d4cb227e789efda0feb632ad333b2d60ef1e6',
  'sha256:1e7e038737255eb60552480e8d7c7624f6be3144381f516249db6a5648ebad4c',
  'sha256:d53514bb3ad8189b1c8ec7ba4e7822f87a477542d9473cb5b5c204119ffd36e2',
  'sha256:4c9ab2743c6aa630f50072254040cb56f34e7be0b4920c7e4fca4949f01a80d3',
  'sha256:fb064447788a1770ae0fd2883cb9ec041e554c356d78c0459d8e117a26b930a9',
  'sha256:aa7427c4412c4f50f5ca558d44b322051f1c2dd4477dbf0788a42773926c5317',
]);
/** r1 F2: where a reviewed line is read: the checkout's root, or the one named here (`cd`). */
const SERVICE = 'services/<name>';
const REVIEWED_IN = { go: 'scripts/trivy-db-check', 'node dist/main.js': SERVICE };
const reviewed =
  (name, policy) =>
  (args, { state }) => {
    const text = args.map((word) => word.source).join(' ');
    const [file, ...operands] = args;
    // FU-340: after a `cd` the directory is known only in that `cd`'s own and-list
    const here = state.moved ? state.chained && SERVICE : state.cwd;
    const there = REVIEWED_IN[`${name} ${text}`] ?? REVIEWED_IN[name] ?? '';
    return ((name === 'set' || here === there) &&
      (REVIEWED[name].includes(text) || REVIEWED_DIGESTS.has(sha256(`${name} ${text}`)))) ||
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
/**
 * r1 F1 (D-173): `docker exec` and `docker run` are read only as the lines ci.yml holds, every
 * option and `-e` entry included: an `exec` here, a `run` by the sha256 of `docker run <words>`
 * with its image written IMAGE (the image-pin check judges it), after the grammar of `hostPolicy`.
 */
const DOCKER_EXEC = new Set([
  'docker exec rasta-ci-clamav clamdscan --ping 1',
  'docker exec rasta-ci-clamav clamdscan --version',
  'docker exec rasta-ci-clamav chmod 0666 /run/clamav/clamd.sock',
  'docker exec rasta-e2e-clamav clamdscan --ping 1',
  'docker exec rasta-e2e-clamav chmod 0666 /run/clamav/clamd.sock',
  'docker exec rasta-e2e-temporal temporal operator cluster health --address localhost:7233',
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
    const reviewedLine = (image) => {
      const words = args.map((word) => (word === image ? 'IMAGE' : word.source));
      const line = ['docker', verb.value, ...words].join(' ');
      return DOCKER_EXEC.has(line) || REVIEWED_DIGESTS.has(sha256(line))
        ? null
        : 'only the lines reviewed in DOCKER_EXEC and REVIEWED_DIGESTS are read';
    };
    if (plain(verb) && verb.value === 'exec') return reviewedLine();
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
      : (container([...entry, ...run.command], mounts, context) ?? reviewedLine(run.image));
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
    // r1 F2: ONE `cd`, from the checkout's root into a directory whose Dockerfile the inventory
    // holds: there `node dist/main.js` is read. Any other `cd` is refused, with its whole text.
    // FU-340: it is its command's first word (`! cd x && …` runs on after a `cd` that failed),
    // and only what `&&` joins to it is read as run there: after `;`, `||`, `fi` nothing is.
    // In a loop it also moves what stands before it, which was read as run from the checkout.
    cd: ([to, ...more], context) => {
      const { moved, cwd: started, looped } = context.state;
      context.leave();
      return !moved &&
        !looped &&
        started === '' &&
        context.before.length === 0 &&
        more.length === 0 &&
        plain(to) &&
        files.has(`${to.value}/Dockerfile`)
        ? null
        : 'only one `cd` from the checkout into a service directory of the inventory is followed';
    },
    bash: (args, context) => context.shell(args, 'bash', policy),
    docker,
    pnpm: packageManager(PNPM, { values: '--filter -F' }),
    npm: packageManager(NPM, {}),
  };
  return policy;
}
/**
 * PR #1154 r1 F1: the programs listed by name alone (`LISTED`): nothing here reads their
 * operands, so what each writes is the model's to place, by a contract (the test holds that
 * every one has one). The model leaves to this reader only a command it has no contract for
 * and this reader reads by a grammar (`judged`): an exact reviewed line (`REVIEWED`,
 * `REVIEWED_DIGESTS`, `DOCKER_EXEC`), a verb table (`PNPM`, `NPM`), a shell's `-c` body, or a
 * file run by its path, which is one of the inventory or refused.
 */
const GRAMMARS = hostPolicy(new Set(), '').programs;
export const LISTED = Object.keys(GRAMMARS).filter((name) => GRAMMARS[name] === true);
export const judged = (name) =>
  name.includes('/') || (Object.hasOwn(GRAMMARS, name) && typeof GRAMMARS[name] === 'function');
/** `eval` runs only what the Kafka credentials script printed into the variable it names. */
const EVAL = /\beval "\$\{(\w+_credentials)\}"/g;
const credentials = (name) =>
  new RegExp(
    `\\b${name}="\\$\\((?:KAFKA_SECRETS_DIR="\\$\\{kafka_secrets_dir\\}" )?bash infrastructure/docker/kafka/kafka-credentials\\.sh [a-z -]+\\)"`,
    'g',
  );
const count = (text, pattern) => [...text.matchAll(pattern)].length;
/**
 * The only lines that may name a file later steps take their environment, outputs, state or
 * search path from, or a shell its startup text, by exact text (r1 F3). FU-340 (#1099 r2 F3):
 * each writes ONE record. A line here holds no value but the runner's own directory, which no
 * text and no `env` sets (`PROTECTED`). A record whose value the text computes is read only
 * with the whole text that produces it, by sha256 (`ENV_FILE_TEXTS`): ci.yml's two "Generate
 * run secrets" steps, where each value is one `openssl rand -hex` line under `set -euo pipefail`.
 * No delimiter form (`NAME<<EOF`) is listed: the repository writes none.
 */
const ENV_FILE = /\b(?:GITHUB_(?:ENV|PATH|OUTPUT|STATE)|BASH_ENV)\b/;
const ENV_FILE_LINES = new Set([
  'echo "$RUNNER_TEMP/trivy-db-check-bin" >> "$GITHUB_PATH"',
  'echo "dir=$RUNNER_TEMP/trivy-db" >> "$GITHUB_OUTPUT"',
  'echo "archive=$RUNNER_TEMP/trivy-db-artifact" >> "$GITHUB_OUTPUT"',
]);
const ENV_FILE_TEXTS = new Set([
  'sha256:68d8d8ea6c5a4b3f437342ca1db4ce8881d99fd9a8f52b456aa6827a38b17f70',
  'sha256:4d33dbc8c2824996dcef9ad85360c97aa7c03cf8afcad1d6b97e1294e3171741',
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
  const whole = ENV_FILE_TEXTS.has(sha256(script));
  for (const { words } of parseCommands(text).commands) {
    const line = words.map(({ redirect, source }) => `${redirect ? `${redirect} ` : ''}${source}`);
    if (ENV_FILE.test(line.join(' ')) && !whole && !ENV_FILE_LINES.has(line.join(' ')))
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
  let home = false; // F3: `ENV PNPM_HOME=/pnpm` stands in this stage, so `$PNPM_HOME` is `/pnpm`
  for (const { line, keyword, rest } of instructions.list) {
    const refuse = (problem) => errors.push(`${name}:${line}: ${problem}`);
    if (keyword === 'FROM') {
      if (stage) stages.set(stage, { suppressed, replaced, home });
      const from = rest.match(/^(\S+)(?:\s+AS\s+(\S+))?$/i);
      if (!from) refuse(`FROM ${clip(rest)} is not a form this check reads`);
      ({ suppressed, replaced, home } = stages.get(from?.[1].toLowerCase()) ?? {
        suppressed: false,
        replaced: false,
        home: false,
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
      else if (unassignable(rest.split('=')[0]) && !DOCKER_ENV.has(`${keyword} ${rest}`))
        refuse(`${keyword} ${clip(rest)} ${unassignable(rest.split('=')[0])}`);
      else if (rest.includes('$PNPM_HOME') && !home)
        refuse(`${keyword} ${clip(rest)} names a PNPM_HOME this stage has not set to /pnpm`);
      if (rest === 'PNPM_HOME=/pnpm') home = true;
      if (/PATH/.test(rest)) replaced = true;
    } else if (keyword === 'RUN') {
      if (suppressed) {
        // r1 F2: no COPY origin is proven: a RUN starts in the image, with no inventory.
        const run = rest.replace(/^(?:--[a-z]+=\S+\s+)+/, '');
        for (const problem of scriptProblems(run, new Set(), '<image>')) refuse(`RUN ${problem}`);
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

/** #1118 F2: no value of an `env` or a `with` mapping hands on a file the runner reads. */
const handsOn = (where, kind, mapping, errors) => {
  for (const [name, value] of Object.entries(record(mapping) ? mapping : {}))
    if (handsOnRunnerFile(value))
      errors.push(
        `${where}: ${kind} ${clip(name)} hands on github.env, github.path, github.output or github.state: a write to it is not one of the reviewed lines`,
      );
};
/**
 * `env` is a mapping written in the file, or it can hold anything (`env: ${{ fromJSON(…) }}`);
 * and it sets no protected name but as a pair reviewed for this `level` of the file `path`
 * (`ENV_PAIRS`), at every level: workflow, job, step, service, a composite action's step.
 */
const readsEnv = (where, owner, errors, path, level) => {
  if (owner.env === undefined) return true;
  if (!record(owner.env)) return !errors.push(`${where}: env is not a mapping this check reads`);
  handsOn(where, 'env', owner.env, errors);
  for (const [name, value] of Object.entries(owner.env))
    if (!/^[A-Za-z_]\w*$/.test(name) || (value !== null && typeof value === 'object'))
      errors.push(
        `${where}: env ${clip(name)} is not a name with one value (a merge key is not read)`,
      );
    else if (
      unassignable(name) &&
      !(typeof value === 'string' && ENV_PAIRS.has(`${path}: ${level}: ${name}=${value}`))
    )
      errors.push(`${where}: env ${unassignable(name)}`);
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
/** r1 F2, F3: what a job runs and builds is the tested commit at the workspace root: no `path`, `ref`, `repository`. */
const CHECKOUT_INPUTS = list(
  'fetch-depth persist-credentials sparse-checkout sparse-checkout-cone-mode',
);
/**
 * r1 F3: the ONE matrix this check cannot list, bound to the build file that consumes it (so to
 * its key), the expression that computes it and the sha256 of its producer as parsed: the
 * `outputs` of the job `container-scope` and its step `scope`. That step runs `scripts`, which
 * print names `readdir` gave for `services/` (one path segment each, never `..`) whose directory
 * holds a Dockerfile; the test holds their text to `scriptsSha256`. Anything else resolves no file.
 */
export const MATRIX = {
  consumer: 'services/${{ matrix.service }}/Dockerfile',
  values: '${{ fromJSON(needs.container-scope.outputs.services) }}',
  producer: 'sha256:5f718bcea55f20e02f0f0c970eda934bf1204bbc971b1812c97057773de83a33',
  scripts: ['scripts/container-scope.mjs', 'scripts/container-scope-lib.mjs'],
  scriptsSha256: 'sha256:296871528cfe253d4d3025ad445f1465db6dde06d50cd8a75fcfc5ee8816690a',
};
const producerOf = ({ 'container-scope': job }) =>
  sha256(JSON.stringify([job?.outputs, job?.steps?.filter?.((step) => step?.id === 'scope')]));

/**
 * The repository files a build's `file` input names, or none when that cannot be told: a literal
 * path, or one `${{ matrix.NAME }}` whose values are a list written in the job (each is tried) or
 * the reviewed `MATRIX` (every inventory file of its shape). Any other expression resolves nothing.
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
  if (file !== MATRIX.consumer || values !== MATRIX.values) return [];
  return [...files].filter((path) => /^services\/[^/]+\/Dockerfile$/.test(path));
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
  if (!record(step.with ?? {})) return problems;
  const inputs = step.with ?? {};
  for (const key of action === 'actions/checkout' ? Object.keys(inputs) : [])
    if (!CHECKOUT_INPUTS.has(key)) problems.push(`checkout input ${clip(key)} is not read`);
  if (action !== BUILD_ACTION) return problems;
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
 * r1 F2: the ONE resolver of where a step's text starts, asked at every level like
 * `effectiveShell`: the step's own written-out directory of the checkout, else its root. A job's
 * or a workflow's `defaults` may hold `run.shell` alone: an inherited directory is refused.
 */
function effectiveDirectory({ step, job, workflow }) {
  for (const owner of [job, workflow])
    if (!/^(?:\{"run":\{(?:"shell":"\w+")?\}\})?$/.test(JSON.stringify(owner?.defaults) ?? ''))
      return { problem: 'defaults holds more than run.shell: an inherited directory is not read' };
  const cwd = step?.['working-directory'] ?? '';
  return typeof cwd === 'string' && /^(?![/-])(?!.*\.\.)[\w./-]*$/.test(cwd)
    ? { cwd }
    : { problem: 'working-directory is not a written-out directory of the checkout' };
}

/**
 * r1 F1: what a job starts outside its steps. A key not listed is refused (`container`); a
 * service's `options` and `command` are read only as the exact texts here, health commands too.
 */
const JOB_KEYS = list(
  'name permissions runs-on timeout-minutes steps needs if services strategy outputs env defaults',
);
const SERVICE_KEYS = list('image env ports options command');
const health = (command, every = '10s') =>
  `--health-cmd "${command}" --health-interval ${every} --health-timeout 5s --health-retries 10`;
const SERVICE_OPTIONS = new Set([
  health('pg_isready -U rasta'),
  health('pg_isready -U rasta', '5s'),
  health('redis-cli ping'),
  health('/mailpit readyz'),
]);
const SERVICE_COMMAND = 'postgres -c max_connections=300';
function outsideSteps(where, job, errors, path) {
  for (const key of Object.keys(job))
    if (!JOB_KEYS.has(key)) errors.push(`${where}: ${clip(key)} is not a job key this check reads`);
  const services = job.services ?? {};
  if (!record(services)) return void errors.push(`${where}: services is not a mapping`);
  for (const [id, service] of Object.entries(services)) {
    const { image, options, command } = record(service) ? service : {};
    if (
      typeof image !== 'string' ||
      !Object.keys(service).every((key) => SERVICE_KEYS.has(key)) ||
      !(options === undefined || SERVICE_OPTIONS.has(options)) ||
      !(command === undefined || command === SERVICE_COMMAND)
    )
      errors.push(`${where}: service ${clip(id)} has a key, options or a command not reviewed`);
    else readsEnv(`${where}: service ${id}`, service, errors, path, 'service');
  }
}

/**
 * Problems of the steps themselves: an unknown shell, an opaque `env`, a script that is not
 * proven, an action nobody reviewed, a build of a file outside the inventory `files`
 * (`file: Containerfile`, `/tmp/Dockerfile`, `${{ env.ROOT }}/Dockerfile`). `matrix` is the job's;
 * `before`, the steps of the same list before this one.
 */
function stepProblems(path, where, step, errors, commands, files, matrix, before, texts, inAction) {
  if (!record(step)) return void errors.push(`${where} is not a mapping`);
  const refuse = (problem) => errors.push(`${where}: ${problem}`);
  readsEnv(where, step, errors, path, 'step');
  handsOn(where, 'with', step.with, errors);
  const { problem } = effectiveShell({ step, composite: inAction && step.run !== undefined });
  if (problem) refuse(problem);
  // FU-340 part B: a local action's own steps are read, each as a step, where its file is read
  // F2: an output a local action hands on is read with that action's file, from `texts`
  const action = (local) => {
    const text = texts[`${local}/action.yml`] ?? texts[`${local}/action.yaml`];
    return typeof text === 'string' ? (readYaml(local, text).value ?? null) : null;
  };
  writeProblems(step, path, { local: () => [], before, judged, action }).forEach(refuse);
  if (step.uses !== undefined) usesProblems(step, matrix, files).forEach(refuse);
  else if (step.with !== undefined) refuse('with is given to no action');
  if (step.run === undefined) return;
  if (typeof step.run !== 'string') return void refuse('run is not text');
  const { cwd, problem: nowhere } = effectiveDirectory({ step });
  if (nowhere) return void refuse(nowhere);
  scriptProblems(step.run, files, cwd).forEach(refuse);
  commands.push(...lifecycle(step.run));
}

/**
 * @param {string} name
 * @param {string} text
 * @param {Record<string, string>} workflows Independently inventoried repository workflow and action texts.
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
  const sets = (where, owner, level) => {
    if (level && !readsEnv(where, owner, errors, name, level)) return false;
    if (!record(owner.env) || !Object.hasOwn(owner.env, VARIABLE)) return false;
    settings += 1;
    if (owner.env[VARIABLE] === 'true') return true;
    errors.push(`${where}: ${VARIABLE} must be the string 'true'`);
    return false;
  };
  if (!record(workflow) || !record(workflow.jobs) || Object.keys(workflow.jobs).length === 0)
    return { errors: [`${name}: no jobs were read`], commands };
  const everywhere = sets(name, workflow, 'workflow');
  const unread = effectiveShell({ workflow }).problem ?? effectiveDirectory({ workflow }).problem;
  if (unread) errors.push(`${name}: ${unread}`);
  for (const [id, job] of Object.entries(workflow.jobs)) {
    const where = `${name}: job ${id}`;
    if (record(job) && Object.hasOwn(job, 'uses')) {
      handsOn(where, 'with', job.with, errors);
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
    const jobShell = effectiveShell({ job }).problem ?? effectiveDirectory({ job }).problem;
    if (jobShell) errors.push(`${where}: ${jobShell}`);
    outsideSteps(where, job, errors, name);
    if (
      job.strategy?.matrix?.service === MATRIX.values &&
      producerOf(workflow.jobs) !== MATRIX.producer
    )
      errors.push(`${where}: the matrix is not computed by the producer reviewed in MATRIX`);
    const inJob = sets(where, job, 'job');
    for (const [index, step] of job.steps.entries()) {
      const at = `${where} step ${index + 1}`;
      const before = job.steps.slice(0, index);
      const matrix = job.strategy?.matrix;
      stepProblems(name, at, step, errors, commands, files, matrix, before, workflows);
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
export function actionLifecycle(name, text, texts = {}, files = new Set()) {
  const read = readYaml(name, text);
  if (read.problem) return { errors: [read.problem], commands: [] };
  const errors = [];
  const commands = [];
  const runs = record(read.value) ? read.value.runs : undefined;
  if (!record(runs) || runs.using !== 'composite' || !Array.isArray(runs.steps))
    return { errors: [`${name}: not a composite action this check reads`], commands };
  for (const [index, step] of runs.steps.entries()) {
    const before = runs.steps.slice(0, index);
    stepProblems(
      name,
      `${name}: step ${index + 1}`,
      step,
      errors,
      commands,
      files,
      null,
      before,
      texts,
      true,
    );
  }
  if (read.named !== 0)
    errors.push(`${name}: an action inherits ${VARIABLE} from its caller and may not name it`);
  return { errors, commands };
}
