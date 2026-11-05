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

/**
 * FU-092: what ONE shell invocation runs, decided from the words after the shell word and
 * never assumed: `{ body }` (the -c operand, a word to read as a script), `{ file }` (the
 * script operand, which the caller must prove it reads), `{ stdin: true }` (the commands come
 * from standard input: a pipe, a here-string, a here-document or the terminal), or
 * `{ problem }`. Bash accepts `-` and `+` option clusters alike (`bash +c 'cmd'` runs cmd,
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
    for (const letter of cluster?.[1] ?? '') {
      if (letter === 'c') command = true;
      else if (letter === 's') stdin = true;
      else if (letter === 'o' || letter === 'O') {
        at++; // the option name: one word per o/O, also inside a cluster
        if (!args[at] || computed(args[at]))
          return { problem: `${name} option ${value} has a name this check cannot read` };
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
  return stdin || !operand ? { stdin: true } : { file: operand };
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
