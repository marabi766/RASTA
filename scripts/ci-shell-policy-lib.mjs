import {
  ASSIGN_LIKE,
  DECLARERS,
  executionChain,
  parseCommands,
  shellInvocation,
  vector,
} from './ci-shell-text-lib.mjs';

/**
 * THREAT MODEL (PM decision D-173). This reader guards against ACCIDENTAL REGRESSION: a
 * contributor editing a workflow, an action or a Dockerfile in good faith. It is not a defence
 * against a hostile insider, who can edit the guard itself.
 * CONTRACT: whatever it reads it reads as bash does, and whatever it cannot read with certainty
 * it REFUSES. It does not model every shell feature; a feature it does not model is a refusal,
 * never a guess. A new form is admitted by adding the exact reviewed form to a policy.
 * KNOWN LIMITS (outside D-173, or a policy's to close by listing less; FU-340 holds the list):
 *  - a program a policy lists as `true` is read no further than its name: what `curl`, `tee`,
 *    `rm` or a repository script does with its operands, its input and the files it writes;
 *  - no value is traced: what a variable holds where a reviewed line uses it (`"$SCAN_BASE"`, a
 *    value of several lines written to `$GITHUB_ENV`), and what a file holds when it is run
 *    after an earlier command of the same text wrote it;
 *  - a redirection's target is known not to be a word of the command; it is not judged;
 *  - a name is bound by more than the forms the name rule is asked about (`read`, `printf -v`,
 *    `mapfile`, `getopts`, `let`): they are refused only while a policy does not list them;
 *  - shell state is not modelled: `set` options, traps, a function named like a listed program
 *    (its body is read as commands, by the same policy), startup files;
 *  - an expansion with an operator (`${x:-…}`) is read while its text holds plain characters
 *    alone (FU-340); what the operator does with the value it expands is not.
 *
 * FU-334: the ONE default-deny reader of shell text for a guard that must prove what a step, a
 * RUN or a container runs (the Prisma lifecycle-suppression guard now; the browser-install guard
 * next, FU-338). It follows the image-pin check's rule (check-dockerfile-pins-lib.mjs,
 * `programProblem`): the shared tokenizer and execution boundary name the word that runs, and
 * that word passes only as an entry of a table. Nothing is refused by its spelling.
 *
 * A guard hands `readShell` a policy and gets back problems and the commands that were read:
 *
 *  - `programs`: every word that may stand where a command runs. `true` is a program whose
 *    operands are data; a function is its grammar, `(args, context) => problem | null`, and sees
 *    every word after the program; a wrapper's grammar sees the command it runs too (r1 F4).
 *    A word that is not an own key holding one of the two is refused: a wrapper (`env`,
 *    `xargs`, `sudo`, `npx`, `timeout`), `source`, a glob (`/usr/bin/ap[t]-get`), a variable.
 *  - `file(path, state)`: why a program named by a path is not one this guard reads, or null.
 *  - `name(NAME)`: why a variable may not be bound here, or null. Without the rule, none may.
 *    Every form that binds one is asked (r1 F3): `A=b`, a declaration (`export`, `readonly`,
 *    `declare`, `typeset`, `local`), `unset`, `for`/`select NAME`. The forms that bind a name
 *    the text computes or hides are the tokenizer's refusals (`${x:=v}`, `${!x}`, `$(( ))`).
 *  - `tolerated`: the tokenizer's findings the guard reads past. Every other one is a problem.
 *  - `unlisted`: how the guard words a refused command word.
 *
 * A grammar reads what its program runs through `context`: `context.shell(args, name, policy)`
 * decides one shell invocation by `shellInvocation` — a `-c` body is read by this same reader
 * under `policy`, a script file is `policy.file`'s to admit, standard input is refused — and
 * `context.state` is the text so far: the directory it starts in (`cwd`), whether this command
 * runs after a `context.leave()` of its own or an enclosing subshell (`moved`), whether it also
 * stands in the and-list of that command, so runs only if it succeeded (`chained`, FU-340),
 * whether it stands in a loop, where what follows it also runs before it (`looped`), and
 * the names assigned so far (`assigned`, in any subshell). `context.before` holds the words of the
 * command before the grammar's own (`!`, `then`, a prefix assignment). Pure: text in, problems out.
 */
const clip = (text) => (text.length > 80 ? `${text.slice(0, 77)}...` : text);

/** A word the shell does not compute. */
export const plain = (word) => Boolean(word) && !word.dynamic;

/**
 * A word that is exactly one word when it runs: written out, or computed only inside double
 * quotes and not a vector (`"$@"`, `"${a[@]}"`). An unquoted `$x` may be none or several.
 */
const unquoted = (source) => source.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '');
export const oneWord = (word) =>
  plain(word) || (!vector({ value: word.source }) && !/[$`*?[\]{}~]/.test(unquoted(word.source)));
const written = (word) => (word.dynamic ? word.value.slice(0, word.cut) : word.value);
/** The programs whose operands are names they bind, and those whose first operand is. */
const BINDERS = new Set([...DECLARERS, 'unset']);
const LOOPS = new Set(['for', 'select']);
/** The words a loop starts with: its condition and its body run again, up to its `done`. */
const LOOP_STARTS = new Set([...LOOPS, 'while', 'until']);

/**
 * A closed option grammar. `flags` take no value; `values` take one, attached with `=` or as the
 * next word. An option's name is always written out, and one that is not listed is a problem:
 * `--shell-mode`, `-c`, `--config.x=y` are refused by not being in the table. Every other word is
 * written out too, unless the grammar says `computed`: then a value or an operand may be computed
 * as long as it is one word (its value is not read: `"$range"` may hold an option).
 * `{ operands, options }` with each option as `{ name, value }` (the word, or null), or `{ problem }`.
 */
export function readOptions(args, { flags = '', values = '', computed = false } = {}) {
  const [bare, valued] = [new Set(flags.split(' ')), new Set(values.split(' '))];
  const data = (word) => plain(word) || (computed && Boolean(word) && oneWord(word));
  const [operands, options] = [[], []];
  for (let at = 0; at < args.length; at++) {
    const word = args[at];
    if (!data(word)) return { problem: `\`${clip(word.value)}\` is computed` };
    const [name] = written(word).split('=');
    if (!name.startsWith('-')) operands.push(word);
    else if (written(word).includes('=') && valued.has(name))
      options.push({ name, value: { ...word, value: word.value.slice(name.length + 1) } });
    else if (word.value === name && bare.has(name)) options.push({ name, value: null });
    else if (
      word.value === name &&
      valued.has(name) &&
      data(args[at + 1]) &&
      !written(args[at + 1]).startsWith('-') // r1 F2: a program may read that as an option of its own
    )
      options.push({ name, value: args[++at] });
    else return { problem: `option \`${clip(word.value)}\` is not one this check reads` };
  }
  return { operands, options };
}

/** Why the policy does not read the file a path names, or null. No `file` rule admits no file. */
const admits = (policy, path, state) =>
  policy.file ? policy.file(path, state) : 'is not a file this check reads';

/**
 * @param {string} text
 * @param {object} policy See the header.
 * @param {{ cwd: string, moved: boolean, assigned: Set<string> }} [state]
 * @returns {{ problems: string[], commands: Array<{ words: object[], program: object, args: object[] }> }}
 */
export function readShell(
  text,
  policy,
  state = { cwd: policy.cwd ?? '', moved: false, assigned: new Set() },
) {
  const left = state.moved ? [''] : []; // the subshells a grammar has marked as having left `cwd`
  const entered = new Set(); // FU-340: the and-lists a `leave()` stands in, as `scope list`
  let loops = 0; // FU-340: the loops open around a command, each from its first word to its `done`
  const problems = [];
  const commands = [];
  const read = parseCommands(text);
  for (const unread of read.problems)
    if (!policy.tolerated?.has(unread)) problems.push(`${unread} is not read`);
  const grammarOf = (name) => (Object.hasOwn(policy.programs, name) ? policy.programs[name] : null);
  // FU-340 (#1099 r2 F4): ONE lookup admits a word of the chain and finds its grammar. A word is
  // looked up as written out, or as a word of the grammar itself (`[`, `{`, `[[`) spelled exactly
  // so: `$x[` and `"$x"{` are words the shell computes, whatever is left of them here.
  const entryOf = ({ value, dynamic, source }) =>
    dynamic && source !== value ? null : grammarOf(value);
  const listed = (word) => entryOf(word) === true || typeof entryOf(word) === 'function';
  for (const { words: all, scope, list } of read.commands) {
    // r1 F1: a redirection's target is no word of the command: `>echo env -i x` runs `env`.
    const words = all.filter((word) => !word.redirect);
    state.moved = left.some((at) => at === '' || scope === at || scope.startsWith(`${at}/`));
    state.chained = entered.has(`${scope} ${list}`);
    const refuse = (why) =>
      problems.push(`\`${clip(words.map((word) => word.value).join(' '))}\` ${why}`);
    const { chain, problem } = executionChain(words);
    if (problem) refuse(problem);
    loops += chain.filter((at) => LOOP_STARTS.has(words[at].value)).length;
    state.looped = loops > 0;
    if (words[chain.at(-1)]?.source === 'done') loops -= 1;
    const bind = (name) => {
      state.assigned.add(name);
      const unbound = policy.name
        ? policy.name(name)
        : 'assigns a variable, which its policy does not read';
      if (unbound) refuse(unbound);
    };
    for (const at of chain) {
      const { value, dynamic } = words[at];
      // A computed word is a word of the grammar (`[`, `{`) or nothing this reader knows.
      if (!listed(words[at]) && (dynamic || admits(policy, value, state) !== null))
        refuse(`runs \`${value}\`, ${policy.unlisted ?? 'a program this check does not list'}`);
    }
    const last = chain.at(-1) ?? words.length;
    for (const [at, word] of words.slice(0, last).entries()) {
      if (chain.includes(at)) continue;
      const name = ASSIGN_LIKE.test(written(word)) && /^\w+/.exec(written(word))?.[0];
      if (!name || /^\w+\[/.test(written(word)))
        refuse('has a word before its command that is not an assignment to a written-out name');
      else bind(name);
    }
    const program = words[last];
    if (!program) continue;
    const args = words.slice(last + 1);
    commands.push({ words, program, args });
    const bound = BINDERS.has(program.value) ? args : LOOPS.has(program.value) ? [args[0]] : [];
    for (const word of bound) {
      const name =
        /^[A-Za-z_]\w*(?=\+?=)/.exec(written(word ?? { value: '' }))?.[0] ??
        (plain(word) && /^[A-Za-z_]\w*$/.test(word.value) ? word.value : null);
      if (name) bind(name);
      else
        refuse(
          `is not a form of \`${program.value}\` this check reads: a word is not a written-out name`,
        );
    }
    const context = {
      state,
      /** From here on, in this subshell, a relative path is no longer one of the starting directory. */
      leave() {
        left.push(scope);
        if (list) entered.add(`${scope} ${list}`);
      },
      /** What `name args…` runs as a shell, read under `inner`: a problem, or null. */
      shell(shellArgs, name, inner = policy) {
        const invoked = shellInvocation(shellArgs, name, { startupState: true });
        if (invoked.problem) return invoked.problem;
        if (invoked.stdin) return `${name} reads its commands from standard input`;
        if (invoked.file) {
          const unread = admits(inner, invoked.file.value, state);
          return unread && `${name} runs ${clip(invoked.file.value)}, which ${unread}`;
        }
        const body = readShell(invoked.body.value, inner, { ...state, assigned: new Set() });
        commands.push(...body.commands);
        return body.problems.length > 0 ? `${name} -c runs ${body.problems.join('; ')}` : null;
      },
    };
    // r1 F4: every word of the chain that has a grammar is asked, a wrapper before what it runs.
    for (const at of chain) {
      const grammar = entryOf(words[at]);
      const asked = { ...context, before: words.slice(0, at) };
      const unread = typeof grammar === 'function' ? grammar(words.slice(at + 1), asked) : null;
      if (unread) refuse(`is not a form of \`${words[at].value}\` this check reads: ${unread}`);
    }
  }
  return { problems, commands };
}

// `docker run|create|pull` options: those that take a value, and those that do not. The image-pin
// check and every guard that reads a container's command find the image by this ONE table.
export const DOCKER_RUN_VALUES = new Set([
  '-e',
  '--env',
  '--env-file',
  '-v',
  '--volume',
  '--mount',
  '--tmpfs',
  '--name',
  '--network',
  '--net',
  '-w',
  '--workdir',
  '-u',
  '--user',
  '--entrypoint',
  '-h',
  '--hostname',
  '-p',
  '--publish',
  '--platform',
  '-l',
  '--label',
  '--add-host',
  '--cap-add',
  '--cap-drop',
  '-m',
  '--memory',
  '--cpus',
  '--shm-size',
  '--ulimit',
  '--restart',
  '--pull',
  '--security-opt',
  '--device',
  '--health-cmd',
]);
export const DOCKER_RUN_FLAGS = new Set([
  '--rm',
  '-d',
  '--detach',
  '-i',
  '--interactive',
  '-t',
  '--tty',
  '-it',
  '--init',
  '--read-only',
  '-q',
  '--quiet',
  '-a',
  '--all-tags',
]);

/**
 * `docker run [options] IMAGE [command…]`, the words after `run`: `{ options, image, command }`
 * with each option as `{ name, value }` (the value word, or null), or `{ problem }`. An option
 * outside the table, a computed option name and a word that may be several words before the
 * command (it would move the image) are problems. A guard then admits the options it has reviewed.
 */
export function dockerRun(args) {
  const options = [];
  for (let at = 0; at < args.length; at++) {
    const word = args[at];
    if (!oneWord(word)) return { problem: `\`${clip(word.source)}\` may be several words` };
    const written = word.dynamic ? word.value.slice(0, word.cut) : word.value;
    if (!written.startsWith('-')) {
      if (word.dynamic && written !== '') return { problem: 'the image is partly computed' };
      return { options, image: word, command: args.slice(at + 1) };
    }
    const [name] = written.split('=');
    if (written.includes('=') && DOCKER_RUN_VALUES.has(name))
      options.push({ name, value: { ...word, value: word.value.slice(name.length + 1) } });
    else if (plain(word) && DOCKER_RUN_FLAGS.has(name)) options.push({ name, value: null });
    else if (plain(word) && DOCKER_RUN_VALUES.has(name) && args[at + 1] && oneWord(args[at + 1]))
      options.push({ name, value: args[++at] });
    else return { problem: `docker option \`${clip(word.value)}\` is not one this check reads` };
  }
  return { problem: 'names no image' };
}

/**
 * The shell that reads a step's `run` text: the step's `shell`, else the job's, else the
 * workflow's `defaults.run.shell`, else the runner's default (bash; a composite step has none).
 * `{ shell }`, or `{ problem }` when ANY level that is written is not exactly one of `shells`: a
 * template (`bash -e {0}`, `env -i bash {0}`), another interpreter or an expression reads the
 * text as something this reader does not.
 */
export function effectiveShell({
  step,
  job,
  workflow,
  composite = false,
  shells = ['bash', 'sh'],
}) {
  const written = [step?.shell, job?.defaults?.run?.shell, workflow?.defaults?.run?.shell];
  for (const shell of written)
    if (shell !== undefined && !shells.includes(shell))
      return { problem: `shell ${clip(String(shell))} is not one this check reads` };
  const shell = written.find((value) => value !== undefined);
  if (shell === undefined && composite) return { problem: 'a composite step names no shell' };
  return { shell: shell ?? 'bash' };
}
