import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import {
  executionChain,
  parseCommands,
  SHELL_WORD,
  shellInvocation,
  SYSTEM_PATH,
} from './ci-shell-text-lib.mjs';

/**
 * FU-340 part B (D-173, fail closed): the ONE model of what CI may write or restore over a path
 * of the checkout before that path is run or read. A guard that proves a file from the
 * repository's copy asks here what a step may have put there since:
 *  - the SQL guard (utc-clock-sites-lib.mjs) for the file of a `psql -f`: a write of its own or
 *    an earlier step of the job that may reach the file (`stale`) leaves the site unresolved;
 *  - the shell reader (prisma-lifecycle-suppression-lib.mjs) for everything a step runs, uses,
 *    builds or mounts, named or not (`pnpm` reads `.npmrc` and `package.json`, a build its whole
 *    context): a step writes nothing into the checkout that this model reads but a reviewed
 *    output (`writeProblems`). A command the model has no contract for (`command`) is the
 *    reader's own to judge, by its policy; what such a program writes is not proven there.
 *
 * A target is `{ path }` (a path of the checkout, '' its root: a write to a directory is a write
 * to everything below it) or `{ unknown }`: it cannot be placed (computed, a pattern, absolute
 * elsewhere, climbing with `..`, relative in a text that changes directory). A target written
 * out as a place outside the checkout is none: /tmp, /dev/null, a file the runner names,
 * `$RUNNER_TEMP/…` (a text or a step `env` that names one of those other than to expand it is
 * unknown; an `env` above the step is the shell reader's: its `PROTECTED`).
 * No value is followed: `dir=…` then `> "$dir/x"` is unknown, and so is a text with `${{ … }}`.
 *
 * Read: a redirection of any command; the operands of a program of `WRITERS` (which one is the
 * destination depends on options this does not read, so each may be; of `curl`, `wget` and
 * `psql` the values of the options that name a file, until FU-340 part C reads their whole
 * grammar; a word that starts computed may be any option; a backup or another second
 * destination goes where no word says: unknown); a `-c` body, `eval` and `trap` text; what an
 * action restores (`ACTIONS`, every input of each read or listed). The commands of `QUIET` write
 * no file of their own. EVERY other command is unknown (PR #1130 r1 F2): a program outside
 * these lists (`node x.mjs f`, `pnpm`, `sort -o f`, `pg_dump -f f`, `sed`, whose program is not
 * read: its `w`), a repository script, a script file a shell is started on or sources, a
 * function, a computed command word, `xargs`; and so are an action or an input outside the
 * table and text the tokenizer does not read. A guard that still reads a file after an unknown
 * write does so on a review of the steps it comes from: each target names its `step`.
 * Not read (D-173: an accidental edit, not a hostile one): a function or a file on `PATH` named
 * like a program of the lists, what the SQL of a file `psql` reads writes (a `\o`: the SQL guard
 * leaves that site unresolved), a path that reaches a file
 * through a link the repository holds, a service container given the workspace as a volume.
 */
const sha256 = (text) => `sha256:${createHash('sha256').update(text).digest('hex')}`;
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const list = (text) => new Set(text.split(' ').filter(Boolean));
const unknown = (text) => ({ unknown: text });

/**
 * What the tokenizer does not model but still reads as commands: nothing hides behind these.
 * A backslash inside `$( )` is read as bash reads it; inside backticks it is not (bash removes it
 * first, so an escaped backtick starts a command the tokenizer sees as text): no backticks at all.
 */
export const READ_PAST = new Set([
  'redirection',
  'a pipeline, an || list or a background command',
  'a subshell or an arithmetic command',
  'an unbalanced closing parenthesis',
  'a non-ASCII character',
  'a backslash inside a command substitution',
  'a parameter expansion with an operator, subscript or nested text',
]);

const ELSEWHERE = /^\/(?:dev\/(?:null|stdout|stderr)|tmp\/[\w./-]+)$/;
const RUNNER_WORD =
  /^"?\$\{?(?:GITHUB_(?:ENV|PATH|OUTPUT|STATE|STEP_SUMMARY)\}?|RUNNER_TEMP\}?(?:\/[\w.-]+)+)"?$/;
// under the home directory only its cache: `~/.npmrc`, `~/.config`, `~/.local/bin` are where a
// program a step starts finds its startup file or another program
const RUNNER_INPUT = /^(?:\$\{\{ runner\.temp \}\}(?:\/[\w.-]+)*|~\/\.cache\/[\w./-]+)$/;
const climbs = (text) => text.split('/').includes('..');
/** Where a written-out path lies, read from `cwd` (null: a directory this does not know). */
function place(text, cwd) {
  if (text === '' || climbs(text) || /[\\*?[\]{}~$`#\s]/.test(text)) return unknown(text);
  if (text.startsWith('/')) return ELSEWHERE.test(text) ? null : unknown(text);
  if (cwd === null) return unknown(text);
  const path = posix.normalize(posix.join(cwd, text)).replace(/\/$/, '');
  return { path: path === '.' ? '' : path };
}
const placeWord = (word, cwd) =>
  !word.dynamic
    ? place(word.value, cwd)
    : RUNNER_WORD.test(word.source) && !climbs(word.source.replace(/"/g, ''))
      ? null
      : unknown(word.source);

/** A short option of a cluster (`-sSo`, `-#o`), or a long one, also shortened (`--out`), is one of these. */
const option =
  (letters, names = '', last = '') =>
  (text) =>
    new RegExp(`^-(?!-)\\S*[${letters}]${last}`).test(text) ||
    (/^--[a-z-]+(?:=|$)/.test(text) &&
      names.split(' ').some((name) => name.startsWith(text.slice(2).split('=')[0])));
/**
 * `attached`: the short options whose value, written in the same word, is a target. `here`: it
 * writes into the directory it runs in when a word is such an option; `there`: unless one is;
 * `alone`: when it has one operand (`ln -s /tmp/x`).
 * `values`: its operands are addresses, and only the word after such an option (the last of its
 * cluster) is a target (`curl -so f`); `refers`: such an option reads more options from a file
 * or runs a program, and `names`: such a word names a file inside a format or holds a command
 * of the program's own (`psql -c '\o f'`, `-o '|tee f'`), so what it writes is unknown.
 * `backs` (PR #1130 r1 F1): such an option makes a second destination no word names: a backup
 * of what is replaced, named by a suffix or a numbering its options or the environment
 * (`SIMPLE_BACKUP_SUFFIX`, `VERSION_CONTROL`) give; `f.1` of `curl --no-clobber -o f`; the
 * `f.warc.gz` of `wget --warc-file f`. It is not placed, so unknown.
 */
const backs = option('bS', 'backup suffix');
const WRITERS = {
  tee: {},
  truncate: {},
  dd: {},
  cp: { attached: 't', backs },
  mv: { attached: 't', backs },
  ln: { attached: 't', alone: true, backs },
  install: { attached: 't', backs, refers: option('', 'strip-program') },
  tar: {
    attached: 'Cf',
    there: option('C', 'directory'),
    backs: option('', 'backup suffix'),
    // `-P`: its members go where the archive says
    refers: option(
      'IFP',
      'to-command use-compress-program checkpoint-action info-script new-volume-script rsh-command rmt-command absolute-names',
    ),
  },
  unzip: { attached: 'd', there: option('d') },
  curl: {
    attached: 'oDc',
    values: option(
      'oDc',
      'output output-dir dump-header cookie-jar trace trace-ascii stderr etag-save libcurl hsts alt-svc',
      '$',
    ),
    here: option('OJ', 'remote-name remote-name-all remote-header-name'),
    refers: option('K', 'config'),
    names: /%output\{/,
    backs: option('', 'no-clobber'),
  },
  wget: {
    attached: 'OPoa',
    values: option(
      'OPoa',
      'output-document directory-prefix output-file append-output save-cookies rejected-log hsts-file',
      '$',
    ),
    there: option('OP', 'output-document directory-prefix'),
    refers: option('e', 'config use-askpass execute'),
    backs: option('', 'warc-file'),
  },
  psql: { attached: 'oL', values: option('oL', 'output log-file', '$'), names: /\\|^\|/ },
};
/**
 * The effect contracts (PR #1130 r1 F2): the commands that write no file of their own, only
 * what a redirection names: the shell's own words, and programs that have no option to write
 * one. `git` and `find` are such in the forms read below. Any other command is unknown.
 */
const QUIET = list(
  'if then elif else fi for while until do done case esac select function { } ! [ [[ : true ' +
    'false test echo printf set export unset local readonly declare read shift return exit ' +
    'break continue wait exec cd pushd popd sleep cat grep head tail wc cut tr date basename dirname',
);
const GIT_READS = /^(?:cat-file|log|rev-list|rev-parse|diff|show|status|ls-files|describe)$/;
/** A name the runner binds, written other than to expand it: the text may bind it itself. */
const RUNNER_NAME = /^(?:GITHUB_(?:ENV|PATH|OUTPUT|STATE|STEP_SUMMARY)|RUNNER_TEMP)$/;
const BOUND = /(?<![$\w{])(?:GITHUB_(?:ENV|PATH|OUTPUT|STATE|STEP_SUMMARY)|RUNNER_TEMP)(?!\w)/;
/** What runs in the shell of the text itself and may change its directory. */
const MOVES = /^(?:cd|pushd|popd|eval|trap|source|\.)$/;
const FIND_WRITES = /^-(?:exec|execdir|ok|okdir|delete|fls|fprint\w*)$/;
/** `eval` of what kafka-credentials.sh printed (the shell reader's `EVAL`): assignments alone. */
const CREDENTIALS = /^"\$\{\w+_credentials\}"$/;
const credentials = (name, rest) =>
  name === 'eval' && rest.length > 0 && rest.every((word) => CREDENTIALS.test(word.source));

/** Whether a command outside `WRITERS` is one of the effect contracts: it writes no file. */
const quiet = (name, rest) =>
  name === '' ||
  QUIET.has(name) ||
  credentials(name, rest) ||
  (name === 'git' && GIT_READS.test(rest[0]?.value) && !rest.some((w) => /^--ou/.test(w.value))) ||
  (name === 'find' && !rest.some((word) => word.dynamic || FIND_WRITES.test(word.value)));

/** The words a program of `WRITERS` may write, `null` standing for the directory it runs in. */
function operandTargets({ attached, here, there, alone, values, refers, names, backs }, words) {
  const end = words.findIndex((word) => !word.dynamic && word.value === '--');
  const args = end < 0 ? words : words.slice(0, end);
  const after = end < 0 || values ? [] : words.slice(end + 1);
  // before `--`, a word computed from its start or inside an option may be any option (the
  // tokenizer reads a brace expansion, `-{s,o}`, as computed)
  const open = args.filter(
    (word) =>
      word.dynamic && /^(?:-|$)/.test(word.value.slice(0, word.cut)) && placeWord(word, null),
  );
  if (open.length) return open;
  const has = (is) => args.some((word) => !word.dynamic && is(word.value));
  if (backs && has(backs))
    return [{ value: '', dynamic: true, source: 'a second destination no word names' }];
  if (refers && has(refers))
    return [{ value: '', dynamic: true, source: 'what such an option reads or runs' }];
  if (names && words.some((word) => names.test(word.value)))
    return [{ value: '', dynamic: true, source: 'what such a word names' }];
  const found = (here && has(here)) || (there && !has(there)) ? [null] : [];
  for (const [at, word] of args.entries()) {
    const operand = values
      ? at > 0 && !args[at - 1].dynamic && values(args[at - 1].value)
      : word.dynamic || !word.value.startsWith('-');
    if (operand) found.push(word);
    // `name=value`: of a program whose operands are addresses, only of an option that names a file
    const value =
      (values
        ? values(word.value) && /^--[a-z-]+=(.+)$/.exec(word.value)?.[1]
        : /^(?:--)?[\w-]+=(.+)$/.exec(word.value)?.[1]) ||
      (attached && new RegExp(`^-(?!-)\\S*?[${attached}](.+)$`).exec(word.value)?.[1]);
    if (value && !word.dynamic) found.push({ value, dynamic: false });
  }
  found.push(...after);
  const operands = found.filter((word) => word?.source !== undefined).length;
  return alone && operands === 1 ? [null, ...found] : found;
}

/**
 * What one shell text, started in `cwd`, may write: every target of every command, wherever it
 * stands (a loop, a function and `&` run a later command before an earlier one). `cwd` is a
 * directory of the checkout ('' its root); without one no relative path is placed.
 */
export function shellWrites(text, cwd = null, depth = 0) {
  if (typeof text !== 'string' || depth > 4) return [unknown('text this does not read')];
  const read = parseCommands(text);
  const unread = read.problems.find((problem) => !READ_PAST.has(problem));
  const commands = read.commands.map(({ words }) => {
    const args = words.filter((word) => !word.redirect);
    const { chain, problem, inputs, moves } = executionChain(args);
    const word = args[chain.at(-1)];
    const program = word?.value ?? '';
    const named = !program.includes('/') || SYSTEM_PATH.test(program);
    const rest = args.slice(chain.length ? chain.at(-1) + 1 : args.length);
    // a computed command word may be any program of `WRITERS`
    const computed = word?.dynamic && word.source !== program && `what ${word.source} runs`;
    // `env -S 'cp a b'` runs the words of its value; `env -C d`, `sudo -D d` run in another place
    const split = chain.some(
      (at, link) =>
        /(?:^|\/)env$/.test(args[at].value) &&
        args.slice(at + 1, chain[link + 1]).some(({ value }) => /^-(?!-)\S*S|^--split/.test(value)),
    );
    const unplaced =
      problem ??
      (inputs
        ? 'what `xargs` hands on'
        : split || moves
          ? `what \`${args[chain[0]].value}\` runs, and where`
          : computed || null);
    return { words, unplaced, rest, name: named ? program.split('/').at(-1) : program };
  });
  // after a `cd`, anywhere in the text, a relative path is not one of the directory it started
  // in; text that `eval`, `trap` or `source` runs may hold one
  const from = commands.some(({ name, rest }) => MOVES.test(name) && !credentials(name, rest))
    ? null
    : cwd;
  const targets = unread ? [unknown(`${unread}, which is not read`)] : [];
  const bare = text.replace(/^\s*#.*$/gm, '');
  if (bare.includes('`')) targets.push(unknown('a backtick command substitution'));
  if (BOUND.test(bare))
    targets.push(unknown('a name of the runner written other than to expand it'));
  const add = (word) => targets.push(word === null ? place('.', from) : placeWord(word, from));
  const inner = (words) =>
    words.some((word) => word.dynamic)
      ? targets.push(unknown(words.map((word) => word.source).join(' ')))
      : targets.push(...shellWrites(words.map((word) => word.value).join(' '), from, depth + 1));
  for (const { words, unplaced, rest, name } of commands) {
    for (const word of words) {
      const duplicate = /^\d*>&$/.test(word.redirect) && /^(?:\d+|-)$/.test(word.source);
      if (word.redirect?.includes('>') && !duplicate) add(word);
    }
    if (unplaced) targets.push(unknown(unplaced));
    else if (Object.hasOwn(WRITERS, name)) operandTargets(WRITERS[name], rest).forEach(add);
    else if (name === 'eval' && !credentials(name, rest)) inner(rest);
    // `trap - EXIT` sets none
    else if (name === 'trap')
      inner(
        rest
          .filter((word) => word.source !== '--')
          .slice(0, 1)
          .filter((w) => w.source !== '-'),
      );
    else if (SHELL_WORD.test(name)) {
      const run = shellInvocation(rest, name);
      if (run.body) inner([run.body]);
      else if (run.file)
        targets.push({
          ...unknown(`the script ${run.file.source}, which is not read`),
          command: name,
        });
      else targets.push(unknown(run.problem ?? `what ${name} reads as commands`));
    } else if (!quiet(name, rest))
      targets.push({ ...unknown(`what \`${name}\` writes`), command: name });
  }
  return targets.filter(Boolean);
}

/** A path input of an action: one path per line, written out or a place outside the checkout. */
function inputTargets(value) {
  const lines = typeof value !== 'string' ? [] : value.split('\n').map((line) => line.trim());
  const paths = lines.filter(Boolean);
  // an empty input is the action's to place
  if (paths.length === 0) return [unknown(String(value) || 'an empty path')];
  return paths.map((line) => (RUNNER_INPUT.test(line) && !climbs(line) ? null : place(line, '')));
}
/**
 * What each action a step may use writes, from its inputs as written: `writes` names the inputs
 * that are a place it writes or restores (with the place it takes when the input is absent, or
 * none: then it is unknown), `reads` the inputs that name no such place. An action that is not
 * listed is unknown, and so is an input that is in neither list: `path`, `ref` and `repository`
 * of `actions/checkout` (anything but the tested commit at the root), `output` of the scanner,
 * `outputs` of a build. A build's cache goes to the runner's cache service (`gha`) or is unknown.
 */
const action = (reads, writes = {}) => ({ reads: list(reads), writes });
const ACTIONS = {
  'actions/download-artifact': action('name pattern merge-multiple', { path: '.' }),
  'actions/cache': action('key restore-keys', { path: undefined }),
  'actions/checkout': action(
    'fetch-depth persist-credentials sparse-checkout sparse-checkout-cone-mode',
  ),
  'actions/upload-artifact': action(
    'name path retention-days include-hidden-files if-no-files-found compression-level',
  ),
  'actions/setup-node': action('node-version cache'),
  'pnpm/action-setup': action('version'),
  'aquasecurity/setup-trivy': action('version cache'),
  'aquasecurity/trivy-action': action(
    'skip-setup-trivy cache image-ref severity exit-code ignore-unfixed',
    { 'cache-dir': '.cache/trivy' },
  ),
  'docker/setup-buildx-action': action(''),
  'docker/build-push-action': action('context file tags push load cache-from', {
    'cache-to': 'type=gha',
  }),
};
const CACHE_SERVICE = /^type=gha(?:,[\w-]+=[^,\s]+)*$/;

/**
 * What one step of a workflow or an action may write: its `run` text, or what the action it uses
 * restores. `local(path)` gives the steps of a local action (`.github/actions/x`), or null when
 * the caller does not read it here.
 */
export function stepWrites(step, local = () => null, depth = 0) {
  if (!record(step)) return [{ step, ...unknown('a step that is not a mapping') }];
  // a merge key is not applied here: what it adds to the step is not read
  const targets = Object.hasOwn(step, '<<') ? [unknown('a step with a merge key')] : [];
  if (step.uses !== undefined) {
    const uses = String(step.uses);
    const name = /^([\w.-]+(?:\/[\w.-]+)+)@[\w.-]+$/.exec(uses)?.[1];
    const inputs = step.with ?? {};
    const steps = uses.startsWith('./') && depth < 4 ? local(uses.slice(2)) : null;
    if (Array.isArray(steps)) targets.push(...inOrder(steps, local, depth + 1));
    else if (!name || !Object.hasOwn(ACTIONS, name) || !record(inputs))
      targets.push(unknown(`what ${uses} writes`));
    else {
      const { reads, writes } = ACTIONS[name];
      for (const key of Object.keys(inputs))
        if (!reads.has(key) && !Object.hasOwn(writes, key))
          targets.push(unknown(`what ${name} does with its input ${key}`));
      for (const [key, absent] of Object.entries(writes)) {
        const value = inputs[key] ?? absent;
        const cache = String(value).replace(/\$\{\{ matrix\.\w+ \}\}/g, 'x');
        const found =
          key !== 'cache-to'
            ? inputTargets(value).filter(Boolean)
            : CACHE_SERVICE.test(cache)
              ? []
              : [unknown(String(value))];
        targets.push(...found);
      }
    }
  }
  if (step.run !== undefined) {
    // any other shell reads the text as another language
    if (step.shell !== undefined && step.shell !== 'bash' && step.shell !== 'sh')
      targets.push(unknown(`what the shell ${step.shell} runs`));
    if (
      !record(step.env ?? {}) ||
      Object.keys(step.env ?? {}).some((name) => RUNNER_NAME.test(name))
    )
      targets.push(unknown('an `env` that sets a name of the runner'));
    const cwd = step['working-directory'] ?? '';
    const known = typeof cwd === 'string' && /^(?![/-])[\w./-]*$/.test(cwd) && !climbs(cwd);
    targets.push(...shellWrites(step.run, known ? cwd : null));
    // GitHub pastes the value in before the shell reads the text: it can hold a command
    if (String(step.run).includes('${{')) targets.push(unknown('what an expression pastes in'));
  }
  // the innermost step a target comes from: what a review of an unknown write has read
  return targets.map((target) => ({ step, ...target }));
}

/**
 * What steps may have written once the last of them has run. The same rule holds for what this
 * model itself reads from the repository: a local action that a step before it may have
 * replaced, in the job or in the action that uses it, is not the one `local` read.
 */
function inOrder(steps, local, depth) {
  const targets = [];
  const current = (uses) => {
    const path = posix.normalize(uses).replace(/\/$/, '').replace(/^\.$/, '');
    return climbs(uses) || stale(targets, path) ? null : local(path);
  };
  for (const step of steps) targets.push(...stepWrites(step, current, depth));
  return targets;
}
/** What the steps of one job may have written, up to and including the last of `steps`. */
export const jobWrites = (steps, local = () => null) =>
  Array.isArray(steps) ? inOrder(steps, local, 0) : [unknown('steps that are not a list')];

/** Whether a write to the checkout path `written` may change what `path` holds ('' is the root). */
export const covers = (written, path) =>
  written === '' ||
  path === '' ||
  written === path ||
  path.startsWith(`${written}/`) ||
  written.startsWith(`${path}/`);

/** Why `path` is no longer proven to hold the repository's copy after `targets`, or null. */
export function stale(targets, path) {
  if (/^(?:\/|\.\.(?:\/|$))/.test(path)) return 'a path that leaves the checkout is not read here';
  const hit = targets.find((target) => target.unknown !== undefined || covers(target.path, path));
  if (!hit) return null;
  return hit.unknown !== undefined
    ? `a write to ${hit.unknown}, which this check cannot place, may have replaced it`
    : `a write to ${hit.path || 'the checkout'} may have replaced it`;
}

/**
 * The run texts reviewed by hand, by sha256: every computed target of each lies outside the
 * checkout. An edit to the text ends the review.
 *  1. ci.yml "Secret scan": `tee "$SCAN_LOG"`, the `mktemp` file under `$RUNNER_TEMP`.
 *  2. backup-drill-monthly.yml "Run the full drill": `"${dir}/…"`, `dir` being
 *     `"${RUNNER_TEMP}/backup-drill"`, assigned once in the same text.
 */
export const REVIEWED_TEXTS = new Set([
  'sha256:7d74b40b62548c6ae58e97165b4ebd77bc6792ad4a7d8c85ec296ef373c1e48a',
  'sha256:5564580934f1389438d3f794a35676840ae13fedb65aaee631d8ce15ebb3e923',
]);
/**
 * The computed inputs reviewed by hand, as `<file>: <action> <input>=<text>`: each names an
 * output a step of the same file sets to a path under `$RUNNER_TEMP` (`ci-tool-download.mjs
 * key`; the reviewed lines of the step `where`, which the caller hands on as `trivy-db`). The
 * review is of that step too, by the sha256 of it as parsed: it stands once among the steps
 * before the one that uses it (renamed, removed or moved after it, the expression is empty and
 * the action writes its default place).
 */
export const REVIEWED_INPUTS = new Map([
  [
    '.github/actions/install-ci-tool/action.yml: actions/cache path=${{ steps.pin.outputs.archive }}',
    'sha256:5e087b3d5f6d05f40cb8a7d1c94edfc70d6b65959417e779a7c3c921c8818188',
  ],
  [
    '.github/actions/restore-trivy-db/action.yml: actions/download-artifact path=${{ steps.where.outputs.archive }}',
    'sha256:a47b481968bc472fae1d8eecafe4c5e83f8c14bb4b831a7b6c8d998581bb855c',
  ],
  [
    '.github/workflows/ci.yml: aquasecurity/trivy-action cache-dir=${{ steps.trivy-db.outputs.dir }}',
    'sha256:95bcb70fbd9689c9e9de1f4d1649e9629f187828b2449161e6a0116887351454',
  ],
]);
/**
 * All a step may write inside the checkout: these paths and what lies below them. None is a
 * file of the repository or holds one (the test holds the inventory to that), and no program a
 * step starts reads one as its configuration.
 *  - `.economic-coverage`: the coverage shards the merge job downloads and reports on.
 */
export const OUTPUTS = new Set(['.economic-coverage']);

/**
 * The shell reader's rule: why a step of `file` may not write what it writes. A target this
 * cannot place is refused unless its text or its input is reviewed; a path of the checkout is
 * refused unless it is a reviewed output. So nothing a later step of the job runs, uses,
 * builds, mounts or reads as configuration, named or not, was put there by a step. `before`:
 * the steps of the same list before this one.
 */
export function writeProblems(given, file, local, before = []) {
  // the shell reader still reads `${{ env.NAME }}` as one computed word here, as its own rules
  // do (`scriptProblems`): the model refuses every expression, and proving the value from the
  // YAML for both readers is the next change (PM decision 2, its own PR)
  const step =
    record(given) && typeof given.run === 'string'
      ? { ...given, run: given.run.replace(/\$\{\{ env\.\w+ \}\}/g, '$__workflow_env_expression') }
      : given;
  const producer = (value) => {
    const id = /^\$\{\{ steps\.([\w-]+)\.outputs\.[\w-]+ \}\}$/.exec(value)?.[1];
    const named = before.filter((earlier) => record(earlier) && earlier.id === id);
    return named.length === 1 ? sha256(JSON.stringify(named[0])) : null;
  };
  const reviewed = new Set(
    record(step) && REVIEWED_TEXTS.has(sha256(String(step.run)))
      ? stepWrites(step, local).map((target) => target.unknown)
      : Object.entries(record(step?.with) ? step.with : {})
          .filter(([key, value]) => {
            const input = `${file}: ${String(step.uses).split('@')[0]} ${key}=${value}`;
            return REVIEWED_INPUTS.has(input) && REVIEWED_INPUTS.get(input) === producer(value);
          })
          .map(([, value]) => String(value)),
  );
  const problems = new Set();
  for (const { unknown: text, path, command } of stepWrites(step, local))
    // a command the model has no contract for (`command`) is the reader's own to judge: there it
    // is a program of its policy, a reviewed line or a file of the inventory, or it is refused
    if (command !== undefined) continue;
    else if (text !== undefined) {
      if (!reviewed.has(text))
        problems.add(`may write ${text}, which this check cannot tell from the checkout`);
    } else if (![...OUTPUTS].some((output) => path === output || path.startsWith(`${output}/`)))
      problems.add(
        `writes ${path || 'the checkout'}: a step writes into the checkout only the outputs reviewed in OUTPUTS`,
      );
  return [...problems];
}
