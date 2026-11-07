/**
 * FU-077: the ONE reader of shell text for every CI guard that reads commands out of
 * .github/workflows/ci.yml or repository scripts (ci-node-test-timeouts-lib.mjs,
 * check-unit-step-concurrency-lib.mjs, check-dockerfile-pins-lib.mjs, and any new guard).
 *
 * shellTextProblem is the character policy every guard applies BEFORE its own grammar,
 * so no guard sees a different command list than another one for the same text. Bash
 * reads a carriage return as a WORD character, never as a line end: `echo a\r# ; node x`
 * runs `node x`, while a guard that turns CR into a newline (or into a blank) reads a
 * comment there and misses the command. Other control characters and the Unicode blanks
 * and line separators that look like a space or a line break are word characters to bash
 * too. All of them are refused, never normalized. Visible non-ASCII text (an em dash in a
 * comment) is a word character that looks like one, so it stays readable.
 *
 * parseCommands is the closed-grammar command tokenizer (moved here from the node --test
 * guard unchanged except for its character check): a new guard that must prove what a
 * command runs imports it from this module. Its grammar is ASCII-only on top of the shared
 * policy.
 */
const UNREADABLE =
  // eslint-disable-next-line no-control-regex -- matching control characters is the point
  /[\0-\x08\x0b-\x1f\x7f-\x9f\u00a0\u1680\u180e\u2000-\u200f\u2028-\u202f\u205f-\u2064\u3000\ufeff]/u;
const NON_ASCII = /[^\t\n\x20-\x7e]/;
const MAX_DEPTH = 4;

/** Why `text` cannot be read as shell text by any guard, or null. Not a string is unreadable. */
export function shellTextProblem(text) {
  if (typeof text !== 'string') return 'text that is not a string';
  return UNREADABLE.test(text)
    ? 'a carriage return, control or invisible blank character (bash reads it as part of a word)'
    : null;
}

/** A word naming a shell, as a path or a bare name: sh, bash, dash, ksh, zsh, ash, csh, tcsh, fish, rbash. */
export const SHELL_WORD = /(?:^|\/)(?:r?ba|da|k|z|a|c|tc|fi)?sh$/;
const SHELL_LONG_OPTIONS = new Set(['--norc', '--noprofile', '--posix', '--login', '--noediting']);
const computed = (word) => Boolean(word.opaque || word.dynamic || word.value.includes('$'));
/** A script operand that is standard input under another name: the shell reads a pipe, not a file. */
const STDIN_FILE = /^(?:\/dev\/stdin|\/dev\/fd\/\d+|\/proc\/(?:self|\d+)\/fd\/\d+)$/;

/**
 * FU-092: what ONE shell invocation runs, decided from the words after the shell word and
 * never assumed: `{ body }` (the -c operand, a word to read as a script), `{ file }` (the
 * script operand, which the caller must prove it reads), `{ stdin: true }` (the commands come
 * from standard input: a pipe, a here-string, a here-document or the terminal), or
 * `{ problem }` (`/dev/stdin` and `/dev/fd/N` operands are standard input, not files). Bash accepts `-` and `+` option clusters alike (`bash +c 'cmd'` runs cmd,
 * `+sc` too), `-o`/`-O` take a value even inside a cluster (`-eo pipefail -c`), `-` is `--`,
 * and a computed word may be an option, a body or a file: all of those are refused, never
 * read as "some other operand". A long option other than the listed inert ones can name a
 * file the shell runs (--rcfile, --init-file). `name` is the shell word, for the message.
 */
export function shellInvocation(args, name = 'the shell') {
  // csh, tcsh and fish do not share POSIX syntax: reading their text as sh would be a guess.
  if (/(?:^|\/)(?:c|tc|fi)sh$/.test(name))
    return { problem: `${name} is a shell whose syntax this check does not read` };
  let command = false;
  let stdin = false;
  let at = 0;
  for (; at < args.length; at++) {
    const word = args[at];
    if (computed(word))
      return {
        problem: command
          ? `${name} -c runs a body this check cannot read`
          : `${name} has a computed option or operand this check cannot read`,
      };
    const { value } = word;
    if (value === '--' || value === '-') {
      at++;
      break;
    }
    if (!/^[-+]/.test(value)) break;
    const cluster = value.startsWith('--') ? null : /^[-+]([A-Za-z]+)$/.exec(value);
    if (!cluster && !SHELL_LONG_OPTIONS.has(value))
      return { problem: `${name} option ${value} is not one this check reads` };
    // Task 368 F1: allexport exports every function the text defines (`BASH_FUNC_*`) to what it starts, and a login or
    // interactive shell reads startup files (`~/.bash_profile`, `~/.bashrc`): state this check does not read
    if (value === '--login' || (value.startsWith('-') && /^-[A-Za-z]*[ail]/.test(value)))
      return {
        problem: `${name} option ${value} exports functions or reads startup files this check does not read`,
      };
    for (const letter of cluster?.[1] ?? '') {
      if (letter === 'c') command = true;
      else if (letter === 's') stdin = true;
      else if (letter === 'o' || letter === 'O') {
        at++; // the option name: one word per o/O, also inside a cluster
        if (!args[at] || computed(args[at]))
          return { problem: `${name} option ${value} has a name this check cannot read` };
        if (letter === 'o' && /^allexport$/i.test(args[at].value))
          return { problem: `${name} -o allexport exports functions this check does not read` };
      }
    }
  }
  const operand = args[at];
  if (operand && computed(operand))
    return { problem: `${name} has a computed option or operand this check cannot read` };
  if (command)
    return operand
      ? { body: operand }
      : { problem: `${name} -c runs a body this check cannot read` };
  return stdin || !operand || STDIN_FILE.test(operand.value) ? { stdin: true } : { file: operand };
}

const CONTINUATIONS = /(?:\\\n)+/y;
/**
 * True when `text[at]` is `$` and backslash-newline pairs follow it. Bash deletes them before
 * it reads tokens, so `$\<newline>(cmd)` is a command substitution wherever `$(` is one: a
 * scanner that does not join them reads data there. Refused, never joined.
 */
export function continuedDollar(text, at) {
  if (text[at] !== '$') return false;
  CONTINUATIONS.lastIndex = at + 1;
  return CONTINUATIONS.test(text);
}

/** `${NAME}`, `${1}`, `${@}`: the only parameter expansions that cannot run or hide a command. */
const PLAIN_EXPANSION = /^\{(?:[A-Za-z_][A-Za-z0-9_]*|[0-9]+|[@*#?!$-])\}/;

/**
 * Tokenize shell text into commands {words, depth} of words {value, dynamic}. `dynamic` marks
 * a word the shell computes ($var, globs, braces); command substitutions are parsed by the
 * SAME scanner, in place (quotes, escapes and comments decide where one ends), and
 * their commands are returned with the others. `problems` lists everything the scanner
 * does not fully understand - it refuses, it never skips: a parameter expansion with an
 * operator (`${X:-$(cmd)}`, `${{ expr }}`), `$((`, `$[`, `$'..'`, `$".."`, a here-document,
 * a redirection, and a backslash or a comment inside a command substitution (where the
 * end of the substitution is no longer decided by plain bracket matching).
 * Text after a refused construct is still scanned, so commands after it are still seen.
 */
export function parseCommands(text) {
  const out = { commands: [], problems: [] };
  const unreadable =
    shellTextProblem(text) ?? (NON_ASCII.test(text) ? 'a non-ASCII character' : null);
  if (unreadable) out.problems.push(unreadable);
  scan(String(text), 0, 0, 'top', out);
  return out;
}

/** Scans `text` from `from`; `mode` is top level, `$( )` or a backtick body. Returns the index it stopped at. */
function scan(text, from, depth, mode, out) {
  const { commands, problems } = out;
  const refuse = (reason) => {
    if (!problems.includes(reason)) problems.push(reason);
  };
  const inside = mode !== 'top';
  let words = [];
  let word = null;
  const endWord = () => {
    if (word) words.push(word);
    word = null;
  };
  const endCommand = () => {
    endWord();
    if (words.length) commands.push({ words, depth });
    words = [];
  };
  const add = (char) => {
    word ??= { value: '', dynamic: false };
    word.value += char;
  };
  const markDynamic = () => {
    add('');
    word.dynamic = true;
    word.cut ??= word.value.length; // the literal part before the first computed character
  };
  const nested = (start, nestedMode) => {
    // `start` indexes the first character after the opening bracket; returns where it stopped.
    markDynamic();
    if (depth >= MAX_DEPTH) {
      refuse('command substitutions nested too deeply');
      return text.length;
    }
    if (nestedMode === 'paren') {
      const end = scan(text, start, depth + 1, 'paren', out);
      if (end >= text.length) refuse('unterminated command substitution');
      return end;
    }
    let end = start;
    while (end < text.length && text[end] !== '`') end += text[end] === '\\' ? 2 : 1;
    if (end >= text.length) {
      refuse('unterminated command substitution');
      end = text.length;
    }
    // The body is cut out first, then read as a command line of its own.
    scan(text.slice(start, end), 0, depth + 1, 'tick', out);
    return end;
  };
  const dollar = (at) => {
    // `at` indexes the `$`; returns the index of the last character of the expansion.
    const rest = text.slice(at + 1);
    if (rest.startsWith('((') || rest.startsWith('[')) {
      refuse('an arithmetic expansion');
      markDynamic();
      return rest.startsWith('[') ? at + 1 : at; // its content is still scanned
    }
    if (rest.startsWith('(')) return nested(at + 2, 'paren');
    if (rest.startsWith('{')) {
      markDynamic();
      const plain = PLAIN_EXPANSION.exec(rest);
      if (plain) return at + plain[0].length;
      refuse('a parameter expansion with an operator, subscript or nested text');
      return at + 1; // what follows is still scanned
    }
    if (rest.startsWith("'") || rest.startsWith('"')) {
      refuse('ANSI-C or locale quoting');
      markDynamic();
      return at;
    }
    markDynamic();
    return at + (/^(?:[A-Za-z_][A-Za-z0-9_]*|[0-9@*#?!$-])/.exec(rest)?.[0].length ?? 0);
  };
  for (let at = from; at < text.length; at++) {
    const char = text[at];
    if (char === '\\') {
      if (inside) refuse('a backslash inside a command substitution');
      if (text[at + 1] === '\n') {
        // Bash deletes it before it reads tokens, so inside a word it can join `$` and `(`.
        if (word) refuse('a line continuation inside a word');
        at++;
      } else if (at + 1 < text.length) add(text[++at]);
      else refuse('a backslash at the end of the text');
    } else if (char === "'") {
      const end = text.indexOf("'", at + 1);
      if (end < 0) {
        refuse('unterminated quote');
        break;
      }
      add('');
      for (const c of text.slice(at + 1, end)) add(c);
      at = end;
    } else if (char === '"') {
      add('');
      let closed = false;
      for (at++; at < text.length; at++) {
        if (text[at] === '"') {
          closed = true;
          break;
        }
        if (text[at] === '\\') {
          if (inside) refuse('a backslash inside a command substitution');
          if (text[at + 1] === '\n') refuse('a line continuation inside a word');
          else if ('"\\$`'.includes(text[at + 1] ?? 'x')) add(text[++at]);
          else add('\\');
        } else if (text[at] === '$') at = dollar(at);
        else if (text[at] === '`') at = nested(at + 1, 'tick');
        else add(text[at]);
      }
      if (!closed) refuse('unterminated quote');
    } else if (char === '$') {
      at = dollar(at);
    } else if (char === '`') {
      at = nested(at + 1, 'tick');
    } else if (char === '#' && !word) {
      if (inside) refuse('a comment inside a command substitution');
      else while (at + 1 < text.length && text[at + 1] !== '\n') at++;
    } else if (char === '<' || char === '>') {
      refuse(text.startsWith('<<', at) ? 'a here-document' : 'redirection');
    } else if (char === '(') {
      refuse('a subshell or an arithmetic command');
      endCommand();
    } else if (char === ')') {
      endCommand();
      if (mode === 'paren') return at;
      refuse('an unbalanced closing parenthesis');
    } else if (char === '&' && text[at + 1] === '&') {
      at++;
      endCommand();
    } else if (char === '|' || char === '&') {
      refuse('a pipeline, an || list or a background command');
      endCommand();
    } else if (char === '\n' || char === ';') {
      endCommand();
    } else if (char === ' ' || char === '\t') {
      endWord();
    } else {
      if ('*?[~{}'.includes(char)) markDynamic();
      add(char);
    }
  }
  endCommand();
  return text.length;
}

// =============================================================================
// FU-150: the ONE execution-position boundary. Every guard that asks "which program does this
// command line run?" asks here, so a control word, a wrapper and its options, `xargs` and
// `find -exec` cannot each hide the program in their own way.
// =============================================================================

/**
 * `a=b`, `a+=b`, `a[$i]=b`: no program runs. Only a genuine NAME token is an assignment: bash
 * expands `$c=x` and `${c}=x` first, then runs the result as a COMMAND (FU-159).
 */
export const ASSIGN_LIKE = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=/;
export const DECLARERS = new Set(['export', 'local', 'readonly', 'declare', 'typeset']);
/** Words after which the next word of the same line is a command again. */
const CONTROL_WORDS = new Set('if then else elif do while until { coproc function'.split(' '));
/**
 * Programs that run the command they are given. Per program: `v` letters of short options that
 * take a value, `b` letters that do not, `o` letters whose value (if any) is attached, `lv` and
 * `lb` the same for long options, `n` positional operands before the command, `num` a numeric
 * option (`nice -5`), `stops` letters after which nothing runs (`command -v x`). `cd`/`lcd` the short
 * and long options that change the directory the program runs in, `moves` a wrapper that always
 * does (FU-159 F3). An option not listed refuses.
 */
const WRAPPERS = {
  builtin: {},
  nohup: {},
  '!': {},
  command: { b: 'pvV', stops: 'vV' },
  exec: { v: 'a', b: 'cl' },
  env: {
    cd: 'C',
    lcd: 'chdir',
    v: 'uCSa',
    b: 'i0v',
    lv: 'unset chdir split-string argv0',
    lb: 'ignore-environment null debug',
  },
  time: { v: 'fo', b: 'pavV', lv: 'format output', lb: 'portability append verbose' },
  timeout: {
    v: 'sk',
    b: 'fpv',
    lv: 'signal kill-after',
    lb: 'foreground preserve-status verbose',
    n: 1,
  },
  nice: { v: 'n', num: true, lv: 'adjustment' },
  ionice: { v: 'cnpPu', b: 't', lv: 'class classdata pid pgid uid', lb: 'ignore' },
  setsid: { b: 'cfw', lb: 'ctty fork wait' },
  stdbuf: { v: 'ioe', lv: 'input output error' },
  sudo: {
    cd: 'D',
    lcd: 'chdir',
    v: 'ughpCDRTrtU',
    b: 'AbEHKklnPSVvB', // not -e (an editor), -i / -s (a shell): they run what no operand names
    lv: 'user group host prompt chdir chroot role type other-user close-from command-timeout',
    lb: 'askpass background preserve-env set-home non-interactive stdin reset-timestamp remove-timestamp list validate version',
  },
  doas: { v: 'uC', b: 'nL' },
  flock: {
    v: 'wE', // not -c: its operand is a command line run by `sh -c`
    b: 'sxeunoF',
    lv: 'timeout conflict-exit-code',
    lb: 'shared exclusive unlock nonblock nb close no-fork verbose',
    n: 1,
  },
  chroot: { moves: true, lv: 'userspec groups', lb: 'skip-chdir', n: 1 },
  xargs: {
    v: 'adEILnPsR',
    b: '0oprtxv',
    o: 'eil',
    lv: 'arg-file delimiter max-args max-lines max-procs max-chars process-slot-var',
    lb: 'null open-tty interactive no-run-if-empty verbose exit show-limits eof replace',
  },
};
/** The programs that run the command they are given (modeled by `executionChain`). */
export const WRAPPER_NAMES = new Set(Object.keys(WRAPPERS));
const words = (text) => text?.split(' ') ?? [];
/**
 * A redirection word (`>f`, `2>f`, `>>`, `<`, `&>f`, `>&2`): bash applies it and passes no operand,
 * wherever it stands in the command line. Alone (`>`, `2>`) it takes the next word as its target.
 */
const REDIRECT = /^(?:\d+|&)?(?:<<<|<<-|<<|<>|>>|>\||<|>)(.*)$/;
export const redirectWidth = (list, at) => {
  const match = REDIRECT.exec(list[at].value);
  return match ? (match[1] === '' ? 2 : 1) : 0;
};
/**
 * FU-159 r2 F4: the files a command line WRITES by redirection (`>f`, `2>>f`, `&>f`, `>|f`, `<>f`,
 * `>&f`, with the target attached or the next word): `{ word }` is the target word. A duplicated
 * descriptor (`>&2`, `2>&-`) writes no file.
 */
export function outputRedirects(list) {
  const found = [];
  for (let at = 0; at < list.length; at++) {
    const match = /^(?:\d+|&)?(<>|>>|>\||>)(.*)$/.exec(list[at].value);
    if (!match) continue;
    // `>& f` (stdout and stderr to f) takes the next word like a bare `>`
    const bare = match[2] === '' || match[2] === '&';
    let target = bare ? list[at + 1] : { ...list[at], value: match[2] };
    if (bare) at += 1;
    if (target && /^&(?:\d+|-)$/.test(target.value)) continue;
    if (target?.value.startsWith('&')) target = { ...target, value: target.value.slice(1) };
    if (target) found.push(target);
  }
  return found;
}

const nameOf = (word) => word.value.split('/').at(-1);
/** An installed program by absolute path (`/usr/bin/env`): its name says what it is. Any other path is a FILE. */
export const SYSTEM_PATH = /^\/(?:usr\/(?:local\/)?)?s?bin\/[^/]+$/;
/** Words of the grammar itself that are made of glob and brace characters: not a program name. */
const PUNCTUATION = new Set(['[', '[[', ']', ']]', '{', '}']);
/**
 * The program is named by a computed LAST path component: a substitution or variable (`$cmd`,
 * `$(…)`, `a/${b}`) or a pattern the shell expands (`{docker,run}`, `docker*`, `doc?er`).
 * `${D}/x.sh` is a file.
 */
export const computedProgram = (word) => {
  if (word.opaque) return true;
  const last = nameOf({ value: word.value.replace(/\$\{[^}]*\}/g, '$') });
  return last.includes('$') || (!PUNCTUATION.has(last) && /[*?[{]/.test(last));
};

/**
 * FU-224 R4 + task 368 F2: a QUOTED expansion that is still any number of words: `"$@"`, `"${@:2}"`, any `${…[@]…}`,
 * and EVERY indirection `${!…`: `"${!n}"` may name `a[@]`, and so may `"${!n:-}"`, `"${!n#}"`, `"${!n/x/y}"`,
 * `"${!n:0}"`, a nested `"${u:-${!n:-}}"`; `${!prefix@}` lists names. The rule is the opener `${!`, whatever
 * operator follows it: no list of operators. Single-quoted text is literal.
 */
const VECTOR = /\$@|\$\{@|\$\{!|\$\{[^}]*\[@\]/;
// bash deletes backslash-newline before it reads the expansion: `"${arr[\<NL>@]}"` is `"${arr[@]}"`
const joined = (text) => text.replace(/\\\n/g, '');
export const vector = (word) =>
  word.segments === undefined
    ? VECTOR.test(joined(word.value))
    : word.segments.some(({ kind, raw }) => kind !== 'sq' && VECTOR.test(joined(raw)));
/**
 * A word whose expansion has an unknown number of words (or none): an unquoted `$x`, `$(…)` or glob.
 * Quoted expansions are one word. A word read by `parseCommands` has no `split`: `dynamic` stands in.
 */
export const unsplit = (word) =>
  Boolean(word.split ?? (word.opaque || word.dynamic || /[$`*?[]/.test(word.value))) ||
  vector(word) ||
  /\{[^{}]*(?:,|\.\.)[^{}]*\}/.test(word.value); // `{a,b}` and `{1..3}`; a bare `{}` stays one word

/**
 * The index of the command word after `name`'s options and operands, `-1` for "nothing runs", or a
 * problem. Every word consumed here (an option, its value, a positional operand such as
 * `timeout`'s duration) must be ONE word: an unquoted expansion would shift the program (FU-159).
 * After `--` the positional operands are still consumed.
 */
function afterOptions(name, spec, list, from, replace = []) {
  let at = from;
  let positional = spec.n ?? 0;
  let moves = Boolean(spec.moves);
  let ended = false;
  const read = (index) => {
    if (index < list.length && unsplit(list[index]))
      return {
        problem: `${name} operand ${list[index].value} expands to an unknown number of words`,
      };
    return null;
  };
  for (; at < list.length; at++) {
    const { value } = list[at];
    if (!ended && value === '--') {
      ended = true;
      continue;
    }
    if (!ended && ASSIGN_LIKE.test(value)) continue; // env A=b cmd, sudo A=b cmd
    if (!ended && value === '-' && name === 'env') continue; // `env - cmd` is `env -i cmd`
    const redirect = redirectWidth(list, at);
    if (redirect > 0) {
      at += redirect - 1;
      continue;
    }
    if (ended || !value.startsWith('-') || value === '-') {
      if (positional === 0) break;
      positional--;
      const bad = read(at);
      if (bad) return bad;
      continue;
    }
    const bad = read(at);
    if (bad) return bad;
    if (value.startsWith('--')) {
      const [long, attached] = [value.slice(2).split('=')[0], value.includes('=')];
      if (name === 'xargs' && long === 'replace') replace.push(value.split('=')[1] ?? '{}');
      if (words(spec.lv).includes(long)) {
        if (words(spec.lcd).includes(long)) moves = true;
        if (!attached) {
          at++;
          const operand = read(at);
          if (operand) return operand;
        }
      } else if (!words(spec.lb).includes(long))
        return { problem: `${name} option ${value} is not one this check reads` };
      continue;
    }
    if (spec.num && /^-\d+$/.test(value)) continue;
    for (const [index, letter] of [...value.slice(1)].entries()) {
      const rest = index < value.length - 2;
      if (spec.stops?.includes(letter)) return { at: -1, moves };
      if (spec.cd?.includes(letter)) moves = true;
      if (spec.v?.includes(letter)) {
        // xargs -I S: the replace string is this option's value, however the cluster is spelled
        if (name === 'xargs' && letter === 'I') replace.push(rest ? value.slice(index + 2) : '');
        if (!rest) {
          at++; // `-u root`; an attached value (`-uroot`) ends the cluster
          const operand = read(at);
          if (operand) return operand;
          if (name === 'xargs' && letter === 'I')
            replace[replace.length - 1] = list[at]?.value ?? '';
        }
        break;
      }
      if (spec.o?.includes(letter)) {
        if (name === 'xargs' && letter === 'i') replace.push(value.slice(index + 2) || '{}');
        break;
      }
      if (!spec.b?.includes(letter))
        return { problem: `${name} option ${value} is not one this check reads` };
    }
  }
  return positional > 0 ? { at: list.length, moves } : { at, moves };
}

/**
 * The words of one command line that each run the next (control words, wrappers) and the program
 * that finally runs: `{ chain }` (indexes), or `{ problem }` when that program is computed or a
 * wrapper's options cannot be read. A computed program is a refusal, never "some other word".
 * A declaration builtin (`export`, `declare`, `local`, `readonly`, `typeset`) is the final program:
 * the words after it are its operands, not commands.
 * FU-159: `moves` is true when a wrapper changes the directory the program runs in; `inputs` when
 * `xargs` is in the chain (its input items become arguments, or the program itself when the
 * operand command is a wrapper that needs one, or where the replace string stands).
 */
export function executionChain(list) {
  const chain = [];
  let at = 0;
  let moves = false;
  let bypass = false; // a wrapper that runs an EXTERNAL program of the name, never a shell function
  const xargs = []; // every xargs of the chain: { from, replace }; an inner one does not hide an outer one
  const done = (extra = {}) => {
    const last = chain.at(-1);
    const hit =
      last !== undefined &&
      xargs.some(({ from, replace }) =>
        list
          .slice(from, last + 1)
          .some(({ value }) => replace.some((text) => value.includes(text))),
      );
    return {
      chain,
      moves,
      bypass,
      inputs: xargs.length > 0,
      ...(hit ? { problem: 'xargs substitutes its input into the program position' } : {}),
      ...extra,
    };
  };
  for (let step = 0; step < 64; step++) {
    for (;;) {
      const redirect = at < list.length ? redirectWidth(list, at) : 0;
      if (redirect > 0) at += redirect;
      else if (at < list.length && ASSIGN_LIKE.test(list[at].value)) at++;
      else break;
    }
    if (at >= list.length) return done();
    const word = list[at];
    chain.push(at);
    if (computedProgram(word))
      return done({ problem: `runs the command word ${word.value}, which this check cannot read` });
    if (CONTROL_WORDS.has(word.value)) {
      // `function f {` and `coproc NAME {`: the name is not a command
      at +=
        word.value === 'function' || (word.value === 'coproc' && list[at + 2]?.value === '{')
          ? 2
          : 1;
      continue;
    }
    const name = nameOf(word);
    // `./env` and `tools/nice` are files, not the wrapper of that name (FU-159).
    const named = !word.value.includes('/') || SYSTEM_PATH.test(word.value);
    const spec = named && Object.hasOwn(WRAPPERS, name) ? WRAPPERS[name] : undefined;
    if (!spec) return done();
    const replace = [];
    const next = afterOptions(name, spec, list, at + 1, replace);
    if (next.problem) return done({ problem: next.problem });
    moves ||= next.moves;
    if (name !== '!') bypass = true;
    if (name === 'xargs')
      xargs.push({ from: next.at < 0 ? list.length : next.at, replace: replace.filter(Boolean) });
    if (next.at < 0) return done();
    at = next.at;
  }
  return done({ problem: 'nests wrappers deeper than this check reads' });
}

/**
 * The operand command lines of `find -exec|-execdir|-ok|-okdir … ;|+` (each ends at `;` or `+`).
 * `dir` is set on the `-execdir` / `-okdir` ones: they run from the directory of each match, so a
 * relative program path names another file there (FU-159 r2 F4).
 */
export function findCommands(args) {
  const lists = [];
  for (let at = 0; at < args.length; at++) {
    const option = /^-(exec|execdir|ok|okdir)$/.exec(args[at].value);
    if (!option) continue;
    let end = at + 1;
    while (end < args.length && !['+', ';'].includes(args[end].value)) end++;
    lists.push(Object.assign(args.slice(at + 1, end), { dir: option[1].endsWith('dir') }));
    at = end;
  }
  return lists;
}
