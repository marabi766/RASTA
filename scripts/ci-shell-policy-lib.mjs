import {
  ASSIGN_LIKE,
  executionChain,
  parseCommands,
  shellInvocation,
  vector,
} from './ci-shell-text-lib.mjs';

/**
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
 *    every word after the program. A word that is not an own key is refused: a wrapper (`env`,
 *    `xargs`, `sudo`, `npx`, `timeout`), `source`, a glob (`/usr/bin/ap[t]-get`), a variable.
 *  - `file(path, state)`: why a program named by a path is not one this guard reads, or null.
 *  - `name(NAME)`: why a variable may not be assigned here, or null. Without the rule, none may.
 *  - `tolerated`: the tokenizer's findings the guard reads past. Every other one is a problem.
 *  - `unlisted`: how the guard words a refused command word.
 *
 * A grammar reads what its program runs through `context`: `context.shell(args, name, policy)`
 * decides one shell invocation by `shellInvocation` — a `-c` body is read by this same reader
 * under `policy`, a script file is `policy.file`'s to admit, standard input is refused — and
 * `context.state` is the text so far: the directory it starts in (`cwd`), whether this command
 * runs after a `context.leave()` of its own or an enclosing subshell (`moved`), and the names
 * assigned so far (`assigned`, in any subshell). Pure: text in, problems out.
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
/**
 * `ech>o x` runs `ech`, and the tokenizer (which drops the operator) reads `echo`: a redirection
 * written into a word makes the word read another one. Only a descriptor may stand before it.
 */
const GLUED = /^(?!\d*[<>])[^<>]*[<>]/;

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
    const written = word.dynamic ? word.value.slice(0, word.cut) : word.value;
    const [name] = written.split('=');
    if (!name.startsWith('-')) operands.push(word);
    else if (written.includes('=') && valued.has(name))
      options.push({ name, value: { ...word, value: word.value.slice(name.length + 1) } });
    else if (word.value === name && bare.has(name)) options.push({ name, value: null });
    else if (word.value === name && valued.has(name) && data(args[at + 1]))
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
  const problems = [];
  const commands = [];
  const read = parseCommands(text);
  for (const unread of read.problems)
    if (!policy.tolerated?.has(unread)) problems.push(`${unread} is not read`);
  const listed = (name) => Object.hasOwn(policy.programs, name);
  for (const { words, scope } of read.commands) {
    state.moved = left.some((at) => at === '' || scope === at || scope.startsWith(`${at}/`));
    const refuse = (why) =>
      problems.push(`\`${clip(words.map((word) => word.value).join(' '))}\` ${why}`);
    const { chain, problem } = executionChain(words);
    if (problem) refuse(problem);
    if (words.some((word) => GLUED.test(unquoted(word.source))))
      refuse('writes a redirection into a word, which is then not the word this check reads');
    for (const at of chain) {
      const { value, dynamic } = words[at];
      // A computed word is a word of the grammar (`[`, `{`) or nothing this reader knows.
      const unread = dynamic
        ? /\w/.test(value) || !listed(value)
        : !listed(value) && admits(policy, value, state) !== null;
      if (unread)
        refuse(`runs \`${value}\`, ${policy.unlisted ?? 'a program this check does not list'}`);
    }
    const last = chain.at(-1) ?? words.length;
    for (const [at, word] of words.slice(0, last).entries()) {
      if (chain.includes(at)) continue;
      const assignment = word.dynamic ? word.value.slice(0, word.cut) : word.value;
      const name = ASSIGN_LIKE.test(assignment) && /^\w+/.exec(assignment)?.[0];
      if (!name || /^\w+\[/.test(assignment))
        refuse('has a word before its command that is not an assignment to a written-out name');
      else {
        state.assigned.add(name);
        const unassignable = policy.name
          ? policy.name(name)
          : 'assigns a variable, which its policy does not read';
        if (unassignable) refuse(unassignable);
      }
    }
    const program = words[last];
    if (!program) continue;
    const args = words.slice(last + 1);
    commands.push({ words, program, args });
    const grammar = plain(program) && listed(program.value) ? policy.programs[program.value] : null;
    if (typeof grammar !== 'function') continue;
    const context = {
      state,
      /** From here on, in this subshell, a relative path is no longer one of the starting directory. */
      leave() {
        left.push(scope);
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
    const unread = grammar(args, context);
    if (unread) refuse(`is not a form of \`${program.value}\` this check reads: ${unread}`);
  }
  return { problems, commands };
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
