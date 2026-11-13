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
 *  - the shell reader (prisma-lifecycle-suppression-lib.mjs) is the next to ask (the second
 *    half of FU-340 part B): it shares the tokenizer's findings it reads past (`READ_PAST`).
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
 * destination depends on options this does not read, so each may be; of `curl` and `wget` the
 * values of the options that name a file, until FU-340 part C reads their whole grammar; a word
 * that starts computed may be any option); a `-c` body, `eval` and `trap` text; what an action
 * restores (`ACTIONS`, every input of each read or listed). A program this cannot place
 * (`UNPLACED`), a computed command word, `xargs`, an action or an input outside the table and
 * text the tokenizer does not read are unknown. Not read (D-173: an accidental edit, not a
 * hostile one): what any other program writes (`node x.mjs`, a repository script, `pnpm`,
 * `openssl`, `gitleaks`, `mc`, a container through a mount), a function named like a program,
 * the `w` of a `sed` script, a script file a shell is started on or sources, a path that reaches a file
 * through a link the repository holds, a service container given the workspace as a volume.
 */
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
const RUNNER_INPUT = /^(?:\$\{\{ runner\.temp \}\}(?:\/[\w.-]+)*|~\/\.[\w-][\w./-]*)$/;
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
 * `alone`: when it has one operand (`ln -s /tmp/x`). `when`: it writes only then (`sed -i`).
 * `values`: its operands are addresses, and only the word after such an option (the last of its
 * cluster) is a target (`curl -so f`); `refers`: such an option reads more options from a file,
 * and `names`: such a word names a file inside a format, so what it writes is unknown.
 */
const WRITERS = {
  tee: {},
  truncate: {},
  dd: {},
  cp: { attached: 't' },
  mv: { attached: 't' },
  ln: { attached: 't', alone: true },
  install: { attached: 't' },
  sed: { when: option('i', 'in-place') },
  tar: { attached: 'Cf', there: option('C', 'directory') },
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
  },
  wget: {
    attached: 'OPoa',
    values: option(
      'OPoa',
      'output-document directory-prefix output-file append-output save-cookies warc-file rejected-log',
      '$',
    ),
    there: option('OP', 'output-document directory-prefix'),
  },
};
/** Programs that write where no operand says, or what this does not read. */
const UNPLACED = list(
  'patch rsync scp gunzip gzip bunzip2 bzip2 unxz xz zstd unzstd busybox toybox',
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

/** The words a program of `WRITERS` may write, `null` standing for the directory it runs in. */
function operandTargets({ attached, here, there, alone, when, values, refers, names }, words) {
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
  if (when && !has(when)) return [];
  if (refers && has(refers)) return [{ value: '', dynamic: true, source: 'its options file' }];
  if (names && words.some((word) => names.test(word.value)))
    return [{ value: '', dynamic: true, source: 'a file its format names' }];
  const found = (here && has(here)) || (there && !has(there)) ? [null] : [];
  for (const [at, word] of args.entries()) {
    const operand = values
      ? at > 0 && !args[at - 1].dynamic && values(args[at - 1].value)
      : word.dynamic || !word.value.startsWith('-');
    if (operand) found.push(word);
    const value =
      /^(?:--)?[\w-]+=(.+)$/.exec(word.value)?.[1] ??
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
    else if (
      UNPLACED.has(name) ||
      (name === 'git' &&
        !(GIT_READS.test(rest[0]?.value) && !rest.some((w) => /^--ou/.test(w.value)))) ||
      (name === 'find' && rest.some((word) => word.dynamic || FIND_WRITES.test(word.value)))
    )
      targets.push(unknown(`what \`${name}\` writes`));
    else if (name === 'eval' && !credentials(name, rest)) inner(rest);
    else if (name === 'trap') inner(rest.filter((word) => word.source !== '--').slice(0, 1));
    else if (SHELL_WORD.test(name)) {
      const run = shellInvocation(rest, name);
      if (run.body) inner([run.body]);
      else if (!run.file) targets.push(unknown(run.problem ?? `what ${name} reads as commands`));
    }
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
  if (!record(step)) return [unknown('a step that is not a mapping')];
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
  return targets;
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
