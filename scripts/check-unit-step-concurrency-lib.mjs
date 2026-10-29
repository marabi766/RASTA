/**
 * Tripwire for accidental regressions of the bound in static workflow text.
 * The bound is constructed once in package.json's test:unit:ci script.
 * This is NOT a security boundary or a proof of shell execution/failure handling.
 * Workflow changes are reviewed code; code review handles deliberate evasion.
 *
 * Out of scope by design (review r2): set -n / set -o noexec, set -e +e,
 * shell execution effects (including exec), cd, startup files through $GITHUB_ENV,
 * BASH_ENV and fromJSON env, eval of a reassigned credential variable,
 * dynamic commands via env/matrix (including composites/reusable workflows),
 * versioned npx/pnpm dlx launchers, and aliases running recursive Jest.
 * Finite modelled lexical grammar (everything else REFUSES with its construct):
 * LF/CRLF/CR; space/tab; backslash escapes/continuations; single/double quotes;
 * word-start comments; literal words; ; && || | & and newline separators;
 * balanced () / standalone {} groups; control-word prefixes; assignments;
 * < > >> <& >& redirects; << / <<- with literal bare/single/double-quoted
 * alphanumeric/underscore delimiters and isolated DATA payloads; <<< here-strings.
 * A: time (-p), !, coproc, builtin, command, exec, env, nice, nohup, timeout and xargs
 * recursively expose their remaining command words; unmodelled options refuse.
 * B': FULLY LITERAL eval arguments are joined and recursively parsed with this
 * lexer. ANY expansion ($var, ${..}, $(..), backticks) makes the argument DYNAMIC:
 * out of scope by D-074, neither parsed nor refused; its literal words OUTSIDE
 * expansions are still classified. source/. of a literal repo path scans that
 * file after the unit-token pre-check below; a non-repo literal path is dynamic,
 * UNLESS C feeds it.
 * C: heredoc/here-string/pipeline input reaching sh/bash/dash/zsh/ksh/rbash or
 * source/. is parsed as commands, independent of stdin path spelling. A payload
 * that cannot be obtained statically refuses. Pipeline/group relationships and
 * redirection precedence are preserved; arbitrary producer behavior is not run.
 * Only descriptor 0 supplies stdin; its last redirection wins. Unknown input
 * refuses. Shell -c operands anywhere in the option vector use this lexer;
 * literal repo shell scripts are scanned regardless of their stdin or arguments.
 * Simple $name, ANY balanced ${...} parameter expansion, positional parameters
 * and GitHub expressions are opaque dynamic atoms in run blocks AND scripts;
 * balanced $(commands) uses this same lexer recursively.
 * Their resolved values/field splitting are outside the dynamic scope above.
 * ANSI-C/locale quotes, dangling escapes/quotes, process substitution, arithmetic,
 * backticks (except dynamic evaluation arguments), brace/pathname/tilde
 * expansion, and
 * unsupported operators refuse. Quoted literals do not acquire shell syntax.
 * Literal pnpm [run] test[:unit], turbo [run] test[:unit] (direct or via
 * pnpm exec/dlx, implicit pnpm dispatch or npx), and node/direct phase-runner
 * calls are checked. All executable positions use one basename normalizer.
 * Launcher options are limited to LAUNCHER_OPTIONS below; unknown options before
 * the command fail loudly. This is not arbitrary-shell, environment-resolution
 * or root-script alias analysis.
 * Repo-script pre-check (TASK 858): token-free text is accepted WITHOUT full
 * parsing. The classifier's unit triggers are test:unit; run-test-phases.mjs;
 * pnpm [options] [run|run-script] [options] test|t; turbo [options] [run] test.
 * The pre-check conservatively searches these spellings after removing quotes,
 * escapes and continuations (options/other intervening words may overmatch).
 * Direct Jest is not a trigger in the existing run-block classifier. Comments
 * and data may trigger parsing too. Only token-bearing scripts use the finite
 * lexer and recurse into literal repo paths; token-free scripts are opaque.
 * This exemption applies only to repo scripts, never workflow run blocks.
 */
import { parse as parseYaml } from 'yaml';

export const BOUNDED = { workflow: 'ci.yml', job: 'quality', step: 'Unit tests' };
export const BOUNDED_COMMAND = 'pnpm run test:unit:ci';

export const UNBOUNDED_EXCEPTIONS = [
  {
    workflow: 'ci.yml',
    job: 'integration-security',
    step: 'Tenant isolation and authorization tests',
    command:
      'pnpm run test -- --testNamePattern="(tenant|isolation|authorization|subtree visibility)"',
    reason: 'The filtered integration-security phase is outside the measured quality unit step.',
  },
];

/** One extractor for every run block; source stays exact for the exception identity. */
function logicalCommands(script, opaqueFragments = false) {
  script = script.replace(/\r\n?/g, '\n');
  const commands = [];
  let i = 0;
  const refuse = (construct) => {
    throw new Error(`unsupported shell construct: ${construct}`);
  };
  const scan = (closing = null) => {
    let words = [];
    let word = '';
    let started = false;
    let quote = null;
    let source = '';
    let redirect = false;
    let input = null;
    let pipedFrom = null;
    let last = null;
    const nodes = [];
    const heredocs = [];
    const endWord = () => {
      if (started) {
        if (!redirect) words.push(word);
        else if (redirect.kind === 'text') redirect.value = word;
        else if (redirect.kind === 'file') redirect.path = word;
        redirect = false;
      }
      word = '';
      started = false;
    };
    const endCommand = () => {
      endWord();
      if (redirect) refuse('missing redirection target');
      if (words.length) {
        last = { words, source: source.trim(), input, pipedFrom };
        nodes.push(last);
        commands.push(last);
        pipedFrom = null;
      } else if (input && last?.children) last.input = input;
      words = [];
      source = '';
      input = null;
    };
    while (i < script.length) {
      const char = script[i];
      const next = script[i + 1];
      // The expansion itself remains opaque. Outside quotes it separates
      // independently literal command fragments; inside quotes it taints a word.
      if (opaqueFragments && char === '\0') {
        if (quote) word += char;
        else endCommand();
        i += 1;
        continue;
      }
      if (char === '\\' && quote !== "'") {
        if (!next) refuse('dangling backslash');
        if (next === '\n') {
          source += char + next;
          i += 2;
          continue;
        }
        if (!quote || /[\\"$`]/.test(next)) {
          word += next;
          source += char + next;
          started = true;
          i += 2;
          continue;
        }
      }
      if (quote === "'") {
        source += char;
        if (char === quote) quote = null;
        else word += char;
        i += 1;
        continue;
      }
      // Evaluation arguments are opaque when expanded, including their internals.
      // Preserve surrounding literal text, but do not parse or refuse the expansion.
      if ((char === '$' || char === '`') && evaluationSite(words)) {
        const end = dynamicEnd(script, i);
        if (end !== null) {
          word += '\0';
          source += script.slice(i, end);
          started = true;
          i = end;
          continue;
        }
      }
      // Expansion boundaries are lexical; resolved values are never executed.
      if (char === '$') {
        if (!quote && (next === "'" || next === '"'))
          refuse(next === "'" ? 'ANSI-C quoting' : 'locale quoting');
        if (next === '[') refuse('legacy arithmetic expansion');
        const begin = i;
        if (next === '(') {
          if (script[i + 2] === '(') refuse('arithmetic expansion');
          i += 2;
          scan(')');
        } else if (next === '{') {
          const github = script[i + 2] === '{';
          if (github) {
            const end = script.indexOf('}}', i + 3);
            if (end < 0) refuse('unbalanced GitHub expression');
            i = end + 2;
          } else {
            try {
              i = dynamicEnd(script, i);
            } catch {
              refuse('unbalanced parameter expansion');
            }
          }
        } else {
          const parameter = script.slice(i + 1).match(/^(?:[A-Za-z_][A-Za-z_0-9]*|[0-9@*#?$!-])/);
          if (!parameter) {
            // In double quotes these are literal dollars beside quote marks.
            // Every other unknown prefix refuses, including a continuation
            // that might assemble a different dollar construct after joining.
            if (!quote || !['"', "'"].includes(next)) refuse('unrecognised dollar construct');
            word += '$';
            source += char;
            started = true;
            i += 1;
            continue;
          }
          i += 1 + parameter[0].length;
        }
        word += '\0'; // An opaque atom cannot accidentally equal a literal command.
        source += script.slice(begin, i);
        started = true;
        continue;
      }
      if (char === '`') refuse('backtick command substitution');
      if (quote) {
        source += char;
        if (char === quote) quote = null;
        else word += char;
        i += 1;
        continue;
      }
      if (char === '#' && !started) {
        while (i < script.length && script[i] !== '\n') source += script[i++];
        continue;
      }
      if (char === '"' || char === "'") {
        quote = char;
        started = true;
        source += char;
      } else if (char === '<' || char === '>') {
        if (next === '(') refuse('process substitution');
        if (redirect) refuse('missing redirection target');
        // A directly attached numeric file descriptor is not a command word.
        const descriptor = /^\d+$/.test(word) ? Number(word) : char === '<' ? 0 : 1;
        if (/^\d+$/.test(word)) {
          word = '';
          started = false;
        }
        endWord();
        const begin = i;
        if (script.startsWith('<<<', i)) {
          redirect = { kind: 'text', value: null };
          if (descriptor === 0) input = redirect;
          i += 3;
          source += script.slice(begin, i);
          continue;
        }
        if (script.startsWith('<<', i)) {
          i += 2;
          const tabs = script[i] === '-';
          if (tabs) i += 1;
          if (/^[ \t]*\$['"]/.test(script.slice(i))) refuse('ANSI-C/locale heredoc delimiter');
          const delimiter = script
            .slice(i)
            .match(
              /^[ \t]*(?:'([A-Za-z_0-9]+)'|"([A-Za-z_0-9]+)"|([A-Za-z_0-9]+))(?=[ \t\n;|&)]|$)/,
            );
          if (!delimiter) refuse('unsupported heredoc delimiter');
          const payload = { kind: 'text', value: '' };
          if (descriptor === 0) input = payload;
          heredocs.push({
            delimiter: delimiter[1] ?? delimiter[2] ?? delimiter[3],
            tabs,
            input: payload,
          });
          heredocs[heredocs.length - 1].quoted = Boolean(delimiter[1] ?? delimiter[2]);
          i += delimiter[0].length;
        } else {
          i += 1;
          if (next === char || next === '&') i += 1;
          if (/[<>|]/.test(script[i] ?? '')) refuse('unsupported redirection operator');
          redirect = { kind: 'file', path: null };
          if (descriptor === 0) input = redirect;
        }
        source += script.slice(begin, i);
        continue;
      } else if (char === '(' || (char === '{' && !started && /[ \t\n]/.test(next ?? ''))) {
        if (char === '(' && next === '(') refuse('arithmetic command');
        if (char === '(' && /[?*+!@]$/.test(word)) refuse('extended pathname expansion');
        if (char === '(' && word.includes('=')) refuse('array assignment');
        endCommand();
        i += 1;
        const children = scan(char === '(' ? ')' : '}');
        last = { children, pipedFrom, input };
        nodes.push(last);
        pipedFrom = null;
        input = null;
        continue;
      } else if (char === ')' || char === '}') {
        if (closing !== char) refuse(`unbalanced group ${char}`);
        endCommand();
        if (heredocs.length) refuse('unbalanced heredoc');
        i += 1;
        return nodes;
      } else if (/[;|&\n]/.test(char)) {
        if (char === '&' && next === '>') refuse('combined output redirection');
        if ((char === '&' || char === '|') && next === char && script[i + 2] === char)
          refuse('unsupported control operator');
        if ((char === ';' && /[;&]/.test(next ?? '')) || (char === '|' && next === '&'))
          refuse('unsupported control operator');
        endCommand();
        if (char === '|' && next !== '|') pipedFrom = last ?? { unknown: true };
        i += 1;
        if ((char === '&' || char === '|') && next === char) i += 1;
        if (char === '\n') {
          for (const { delimiter, tabs, quoted, input: payload } of heredocs) {
            let found = false;
            while (i < script.length) {
              const end = script.indexOf('\n', i);
              const line = script.slice(i, end < 0 ? script.length : end);
              i = end < 0 ? script.length : end + 1;
              if ((tabs ? line.replace(/^\t+/, '') : line) === delimiter) {
                found = true;
                break;
              }
              if (!quoted && /[$`\\]/.test(line)) refuse('unquoted heredoc expansion or escape');
              payload.value += (tabs ? line.replace(/^\t+/, '') : line) + '\n';
            }
            if (!found) refuse(`unbalanced heredoc ${delimiter}`);
          }
          heredocs.length = 0;
        }
        continue;
      } else if (char === ' ' || char === '\t') {
        endWord();
        source += char;
      } else {
        // Assignments do not undergo pathname expansion; [ and ] delimit test.
        if (char === '{') refuse('brace expansion');
        if (char === '~') refuse('tilde expansion');
        if (!/[A-Za-z0-9_./:@%=+,#!?*[\]-]/.test(char))
          refuse(`unmodelled character ${JSON.stringify(char)}`);
        if (
          '?*['.includes(char) &&
          !/^[A-Za-z_][A-Za-z_0-9]*=/.test(word) &&
          !(char === '[' && !started && /[ \t]/.test(next ?? ''))
        )
          refuse('pathname expansion');
        started = true;
        word += char;
        source += char;
      }
      i += 1;
    }
    if (quote) refuse(`unterminated ${quote === "'" ? 'single' : 'double'} quote`);
    if (heredocs.length) refuse('unbalanced heredoc');
    if (closing) refuse(`unbalanced group ${closing}`);
    endCommand();
    return nodes;
  };
  const nodes = scan();
  // A group's stdin is inherited by every member without its own input;
  // consumption/order is deliberately not simulated by this static tripwire.
  const connect = (items, incoming = null, input = null) => {
    for (const node of items) {
      if (!node.input && !node.pipedFrom) {
        if (input) node.input = input;
        else if (incoming) node.pipedFrom = incoming;
      }
      if (node.children) connect(node.children, node.pipedFrom, node.input);
    }
  };
  connect(nodes);
  return commands;
}

// Find only the end of an opaque expansion. ANY parameter form uses this in
// run blocks and repo scripts too; its contents are never validated/evaluated.
function dynamicEnd(text, start) {
  const first = text[start];
  const next = text[start + 1];
  if (first === '`') {
    let i = start + 1;
    for (; i < text.length; i += 1) {
      if (text[i] === '\\') i += 1;
      else if (text[i] === '`') return i + 1;
    }
    throw new Error('unsupported shell construct: unbalanced dynamic backtick');
  }
  if (next !== '(' && next !== '{') {
    const match = text.slice(start + 1).match(/^(?:[A-Za-z_][A-Za-z_0-9]*|[0-9@*#?$!-])/);
    return match ? start + 1 + match[0].length : null;
  }
  const close = next === '(' ? ')' : '}';
  let depth = 1;
  let quote = null;
  for (let i = start + 2; i < text.length; i += 1) {
    const char = text[i];
    if (char === '\\' && quote !== "'") {
      i += 1;
      continue;
    }
    // Nested substitutions have their own quotes, including inside double
    // quotes. Their braces/quotes must not close the enclosing expansion.
    if (quote !== "'" && ((char === '$' && ['{', '('].includes(text[i + 1])) || char === '`')) {
      i = dynamicEnd(text, i) - 1;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === next) depth += 1;
    if (char === close) {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  throw new Error('unsupported shell construct: unbalanced dynamic expansion');
}

const CONTROL_PREFIXES = new Set(['if', 'then', 'elif', 'else', 'do', 'while', 'until', '!']);
const WRAPPER_OPTIONS = {
  time: { '-p': 0 },
  coproc: {},
  builtin: {},
  command: { '-p': 0, '-v': 0, '-V': 0 },
  exec: { '-a': 1, '-c': 0, '-l': 0 },
  env: {
    '-i': 0,
    '--ignore-environment': 0,
    '-0': 0,
    '--null': 0,
    '-u': 1,
    '--unset': 1,
    '-C': 1,
    '--chdir': 1,
  },
  nice: { '-n': 1, '--adjustment': 1 },
  nohup: {},
  timeout: {
    '-s': 1,
    '--signal': 1,
    '-k': 1,
    '--kill-after': 1,
    '--foreground': 0,
    '--preserve-status': 0,
    '-v': 0,
    '--verbose': 0,
  },
  xargs: {
    '-0': 0,
    '--null': 0,
    '-r': 0,
    '--no-run-if-empty': 0,
    '-t': 0,
    '--verbose': 0,
    '-p': 0,
    '--interactive': 0,
    '-x': 0,
    '--exit': 0,
    '-n': 1,
    '--max-args': 1,
    '-P': 1,
    '--max-procs': 1,
    '-s': 1,
    '--max-chars': 1,
    '-d': 1,
    '--delimiter': 1,
    '-I': 1,
    '--replace': 1,
    '-L': 1,
    '--max-lines': 1,
    '-E': 1,
    '--eof': 1,
    '-a': 1,
    '--arg-file': 1,
  },
};
function commandWords(words) {
  while (words.length) {
    if (/^[A-Za-z_][A-Za-z_0-9]*=/.test(words[0]) || CONTROL_PREFIXES.has(words[0])) {
      words = words.slice(1);
      continue;
    }
    const program = executable(words[0]);
    if (!Object.hasOwn(WRAPPER_OPTIONS, program)) return words;
    let i = 1;
    while (words[i]?.startsWith('-') && words[i] !== '--') {
      const [name, ...value] = words[i].split('=');
      const arity = WRAPPER_OPTIONS[program][name];
      if (arity === undefined) throw new Error(`unmodelled wrapper option: ${program} ${name}`);
      if (arity === 0 && value.length)
        throw new Error(`wrapper switch takes no value: ${program} ${name}`);
      if (arity === 1 && !(value.length ? value.join('=') : words[i + 1]))
        throw new Error(`missing wrapper option value: ${program} ${name}`);
      i += arity === 1 && !value.length ? 2 : 1;
    }
    if (words[i] === '--') i += 1;
    if (program === 'command' && words.slice(1, i).some((word) => ['-v', '-V'].includes(word)))
      return [];
    if (program === 'timeout') {
      if (!words[i]) throw new Error('missing timeout duration');
      i += 1;
    }
    words = words.slice(i);
  }
  return words;
}
function evaluationSite(words) {
  // Called while words are still being assembled: incomplete wrapper/launcher
  // options are validated by the classifier only after the command is complete.
  try {
    words = commandWords(words);
    const program = executable(words[0]);
    if (['eval', 'source', '.'].includes(program)) return true;
    if (program === 'npx') return evaluationSite(afterOptions(words.slice(1), 'npx'));
    if (program === 'pnpm') {
      const args = afterOptions(words.slice(1), 'pnpm');
      if (['exec', 'dlx'].includes(args[0]))
        return evaluationSite(afterOptions(args.slice(1), `pnpm ${args[0]}`));
      if (args[0] && !PNPM_BUILTINS.has(args[0])) return evaluationSite(args);
    }
    return false;
  } catch {
    return false;
  }
}

// Explicit arity: 0 is a switch, 1 consumes a value (also --name=value).
// Deliberately finite: a new launcher option needs review and a regression case.
const LAUNCHER_OPTIONS = {
  pnpm: {
    '-w': 0,
    '--workspace-root': 0,
    '-r': 0,
    '--recursive': 0,
    '-s': 0,
    '--silent': 0,
    '--reporter': 1,
    '--filter': 1,
    '-F': 1,
    '--dir': 1,
    '-C': 1,
    '--workspace-root-dir': 1,
  },
  'pnpm run': {
    '-r': 0,
    '--recursive': 0,
    '--parallel': 0,
    '--stream': 0,
    '--aggregate-output': 0,
    '--if-present': 0,
    '--silent': 0,
    '--filter': 1,
    '-F': 1,
    '--workspace-concurrency': 1,
    '--reporter': 1,
  },
  'pnpm exec': {
    '-r': 0,
    '--recursive': 0,
    '--parallel': 0,
    '--shell-mode': 0,
    '-c': 0,
  },
  'pnpm dlx': {
    '--package': 1,
    '-p': 1,
    '--allow-build': 1,
    '--silent': 0,
    '--reporter': 1,
  },
  npx: {
    '--no-install': 0,
    '--yes': 0,
    '-y': 0,
    '--no': 0,
    '--package': 1,
    '-p': 1,
    '--cache': 1,
  },
  node: {
    '--no-warnings': 0,
    '--trace-warnings': 0,
    '--enable-source-maps': 0,
    '--require': 1,
    '-r': 1,
    '--import': 1,
    '--loader': 1,
    '--conditions': 1,
    '-C': 1,
    '--env-file': 1,
    '-e': 1,
    '--eval': 1,
    '-p': 1,
    '--print': 1,
  },
  turbo: {
    '--filter': 1,
    '-F': 1,
    '--cache-dir': 1,
    '--concurrency': 1,
    '--cwd': 1,
    '--force': 0,
    '--no-cache': 0,
    '--parallel': 0,
  },
};

function optionWidth(words, i, launcher) {
  const [name, ...inlineValue] = words[i].split('=');
  const arity = LAUNCHER_OPTIONS[launcher][name];
  if (arity === undefined) throw new Error(`unrecognised launcher option: ${launcher} ${name}`);
  if (arity === 0 && inlineValue.length)
    throw new Error(`launcher switch must not take a value: ${launcher} ${name}`);
  if (arity === 1 && !(inlineValue.length ? inlineValue.join('=') : words[i + 1]))
    throw new Error(`missing launcher option value: ${launcher} ${name}`);
  return arity === 1 && !inlineValue.length ? 2 : 1;
}

function afterOptions(words, launcher) {
  let i = 0;
  while (words[i]?.startsWith('-') && words[i] !== '--') {
    const width = optionWidth(words, i, launcher);
    // Node's eval/print value is the program; later words are its arguments.
    // Evaluating that code is outside this literal-file tripwire's scope.
    if (launcher === 'node' && ['-e', '--eval', '-p', '--print'].includes(words[i].split('=')[0]))
      return [];
    i += width;
  }
  if (words[i] === '--') i += 1;
  return words.slice(i);
}

const positiveInteger = (value) => /^[1-9]\d*$/.test(value ?? '');
function turboBounded(words) {
  const beforeSeparator = words.slice(0, words.includes('--') ? words.indexOf('--') : words.length);
  const bounds = [];
  for (let i = 0; i < beforeSeparator.length; i += 1) {
    const word = beforeSeparator[i];
    if (word === '--concurrency') bounds.push(beforeSeparator[++i]);
    else if (word.startsWith('--concurrency=')) bounds.push(word.slice('--concurrency='.length));
  }
  return bounds.length === 1 && positiveInteger(bounds[0]);
}

// Built-ins/aliases from the pinned pnpm 11.22.0 command inventory.
// Root scripts take precedence over implicit exec;
// neither this inventory nor a script's body is executable/alias resolution.
const PNPM_BUILTINS = new Set(
  `access add adduser approve-builds audit bin bugs c cache cat-file cat-index change ci clean
   clean-install completion config create dedupe deploy deprecate dislink dist-tag dist-tags dlx
   docs doctor edit env exec fetch find find-hash get help home i ic ignored-builds import info
   init install install-clean install-test issues it la lane licenses link list ll ln login logout
   ls m multi outdated owner owners pack pack-app patch patch-commit patch-remove peers ping pkg
   prefix profile prune publish purge rb rebuild recursive remove repo restart rm root rt run run-script
   runtime s sbom se search self-update set set-script setup show ss stage star stars store
   team token un undeprecate uni uninstall unlink unpublish unstar up update upgrade v version
   view whoami why with xmas`.split(/\s+/),
);
const executable = (word) => word?.split('/').pop();

// Pipeline data is obtained only from known literal producers, never executed.
function pipelinePayload(node) {
  if (!node) throw new Error('unsupported shell construct: interpreter input unavailable');
  if (node.children) {
    const outputs = node.children.filter(
      (child) => !node.children.some((other) => other.pipedFrom === child),
    );
    return outputs.map(pipelinePayload).join('');
  }
  const [program, ...args] = commandWords(node.words ?? []);
  if (executable(program) === 'cat' && !args.length) return inputPayload(node);
  if (
    executable(program) === 'echo' &&
    !args.some((word) => word.startsWith('-') || word.includes('\0'))
  )
    return args.join(' ') + '\n';
  throw new Error('unsupported shell construct: interpreter pipeline payload unavailable');
}
function inputPayload(node) {
  if (node.input?.kind === 'text' && node.input.value !== null && !node.input.value.includes('\0'))
    return node.input.value;
  if (!node.input && node.pipedFrom) return pipelinePayload(node.pipedFrom);
  throw new Error('unsupported shell construct: interpreter input payload unavailable');
}
function scanPayload(payload, rootScripts, context) {
  return logicalCommands(payload).some((command) =>
    unbounded(command.words, rootScripts, command, context),
  );
}
function dynamicLiterals(args, rootScripts, context) {
  // B': use the run-block lexer, including quote removal, groups and nested
  // evaluation. Expansion atoms remain opaque and never generate shell code.
  try {
    return logicalCommands(args.join(' '), true).some((command) => {
      try {
        return unbounded(command.words, rootScripts, command, context);
      } catch {
        return false; // Dynamic/incomplete fragments are never refused (D-074).
      }
    });
  } catch {
    return false;
  }
}

// Shell options stop at the script/command operand. A c in any short-option
// cluster selects the next operand, even if an earlier option included s.
function shellArguments(args) {
  let i = 0;
  let stdin = false;
  while (args[i]?.startsWith('-') && !['-', '--'].includes(args[i])) {
    const option = args[i++];
    if (!/^-[acefhlmnprstuvxBCEHPT]+$/.test(option))
      throw new Error(`unsupported shell construct: shell input option ${option}`);
    if (option.includes('s')) stdin = true;
    if (option.includes('c')) {
      if (args[i] == null)
        throw new Error('unsupported shell construct: missing shell command string');
      return { command: args[i] };
    }
  }
  if (args[i] === '--') i += 1;
  return { path: stdin ? undefined : args[i] };
}

// Same unit-launch spellings as unbounded(), intentionally an over-approximation
// before shell parsing. Never evaluate the script to discover its contents.
function hasUnitToken(text) {
  const literal = text.replace(/\\\r?\n|\\\r/g, '').replace(/[\\'"]/g, '');
  return (
    /test:unit|run-test-phases\.mjs/.test(literal) ||
    /\bpnpm\b[^\n\r;&|]*\b(?:test|t)\b/.test(literal) ||
    /\bturbo\b[^\n\r;&|]*\btest\b/.test(literal)
  );
}

function scanRepoScript(path, rootScripts, context) {
  const file = context.readRepoFile?.(path);
  if (file == null) return false; // B': non-repo literal paths are dynamic.
  if (!hasUnitToken(file.text)) return false;
  if (context.sources?.has(file.path))
    throw new Error('unsupported shell construct: recursive source cycle');
  return scanPayload(file.text, rootScripts, {
    ...context,
    sources: new Set([...(context.sources ?? []), file.path]),
  });
}
/** Literal launchers only; arguments to other programs are never searched as commands. */
function unbounded(words, rootScripts, node = {}, context = {}) {
  words = commandWords(words);
  let [program, ...args] = words;
  program = executable(program);
  if (program === 'pnpm') {
    args = afterOptions(args, 'pnpm');
    if (['exec', 'dlx'].includes(args[0]))
      return unbounded(afterOptions(args.slice(1), `pnpm ${args[0]}`), rootScripts, node, context);
    if (['run', 'run-script'].includes(args[0]))
      return ['test', 'test:unit'].includes(afterOptions(args.slice(1), 'pnpm run')[0]);
    if (['test', 'test:unit', 't'].includes(args[0])) return true;
    if (!args[0] || PNPM_BUILTINS.has(args[0]) || Object.hasOwn(rootScripts ?? {}, args[0]))
      return false;
    return unbounded(afterOptions(args, 'pnpm exec'), rootScripts, node, context);
  }
  if (program === 'npx') return unbounded(afterOptions(args, 'npx'), rootScripts, node, context);
  if (program === 'eval') {
    if (args[0] === '--') args = args.slice(1);
    if (args.some((arg) => arg.includes('\0'))) return dynamicLiterals(args, rootScripts, context);
    if (args[0]?.startsWith('-')) throw new Error(`unmodelled evaluation option: eval ${args[0]}`);
    return scanPayload(args.join(' '), rootScripts, context);
  }
  const sourcing = ['source', '.'].includes(program);
  const shell = ['bash', 'sh', 'dash', 'zsh', 'ksh', 'rbash'].includes(program);
  let shellArgs;
  if (shell) {
    shellArgs = shellArguments(args);
    if (shellArgs.command != null) return scanPayload(shellArgs.command, rootScripts, context);
    if (
      shellArgs.path &&
      !shellArgs.path.includes('\0') &&
      scanRepoScript(shellArgs.path, rootScripts, context)
    )
      return true;
  }
  if (sourcing) {
    if (args[0] === '--') args = args.slice(1);
    // Only the filename decides whether the source is literal, not its $@.
    if (args[0]?.includes('\0')) return dynamicLiterals(args, rootScripts, context);
    if (args[0]?.startsWith('-'))
      throw new Error(`unmodelled evaluation option: ${program} ${args[0]}`);
    if (!args[0]) throw new Error('unsupported shell construct: missing source path');
    if (scanRepoScript(args[0], rootScripts, context)) return true;
  }
  if ((sourcing || shell) && (node.input || node.pipedFrom)) {
    return scanPayload(inputPayload(node), rootScripts, context);
  }
  if (
    shell &&
    (!shellArgs.path || shellArgs.path === '-' || /^\/dev\/(stdin|fd\/0)$/.test(shellArgs.path))
  )
    throw new Error('unsupported shell construct: shell stdin or command string');
  if (program === 'turbo') {
    args = afterOptions(args, 'turbo');
    if (args[0] === 'run') args = args.slice(1);
    const tasks = [];
    for (let i = 0; i < args.length && args[i] !== '--';) {
      if (args[i].startsWith('-')) i += optionWidth(args, i, 'turbo');
      else tasks.push(args[i++]);
    }
    // Bounds may precede "run" too, so inspect the original argument list.
    return (
      tasks.some((word) => ['test', 'test:unit'].includes(word)) && !turboBounded(words.slice(1))
    );
  }
  if (program === 'node') [program, ...args] = afterOptions(args, 'node');
  return executable(program) === 'run-test-phases.mjs' && args[0] === 'test';
}

/** Steps in workflows and local composite metadata, regardless of its directory. */
export function* stepsOf(doc) {
  for (const [jobId, job] of Object.entries(doc?.jobs ?? {})) {
    for (const step of Array.isArray(job?.steps) ? job.steps : []) yield { jobId, job, step };
  }
  for (const step of Array.isArray(doc?.runs?.steps) ? doc.runs.steps : []) {
    yield { jobId: null, job: {}, step };
  }
}

export function unitStepProblems(files, rootScripts, context = {}) {
  const docs = {};
  for (const [file, text] of Object.entries(files)) {
    try {
      docs[file] =
        text instanceof Error ? text : parseYaml(text.replace(/\r\n?/g, '\n'), { merge: true });
    } catch (error) {
      docs[file] = error;
    }
  }
  return parsedProblems(docs, rootScripts, context);
}

export function parsedProblems(docs, rootScripts, context = {}) {
  const problems = [];
  // Exactly one Turbo command/flag; no forwarded flag or conflicting second bound.
  if (!/^turbo run test:unit --concurrency=[1-9]\d*$/.test(rootScripts?.['test:unit:ci'] ?? '')) {
    problems.push(
      'package.json test:unit:ci must be turbo run test:unit --concurrency=<positive integer>',
    );
  }
  const exceptionUses = new Map(UNBOUNDED_EXCEPTIONS.map((entry) => [entry, 0]));
  let bounded = 0;
  for (const [file, doc] of Object.entries(docs)) {
    if (doc instanceof Error || !doc || typeof doc !== 'object' || Array.isArray(doc)) {
      problems.push(`${file}: not readable YAML document`);
      continue;
    }
    for (const { jobId, job, step } of stepsOf(doc)) {
      const where = `${file} ${jobId ?? 'composite'} / ${step.name ?? '(unnamed)'}`;
      const atBounded =
        file === BOUNDED.workflow && jobId === BOUNDED.job && step.name === BOUNDED.step;
      if (atBounded) {
        bounded += 1;
        if (step.run?.trim() !== BOUNDED_COMMAND)
          problems.push(`${where}: run must be exactly ${BOUNDED_COMMAND}`);
        for (const [label, node] of [
          ['step', step],
          ['job', job],
        ]) {
          for (const key of ['if', 'continue-on-error']) {
            if (Object.hasOwn(node, key)) problems.push(`${where}: ${label} must not set ${key}`);
          }
        }
      }
      if (typeof step.run !== 'string') continue;
      // Keep the accepted exception's whole-line identity, even in compound commands.
      const exactLines = new Set(
        step.run
          .replace(/\r\n?/g, '\n')
          .split('\n')
          .map((line) => line.trim()),
      );
      let commands;
      try {
        commands = logicalCommands(step.run);
      } catch (error) {
        problems.push(`${where}: ${error.message}`);
        continue;
      }
      for (const command of commands) {
        const { source } = command;
        try {
          if (!unbounded(command.words, rootScripts, command, context)) continue;
        } catch (error) {
          problems.push(`${where}: ${error.message}`);
          continue;
        }
        const exception = UNBOUNDED_EXCEPTIONS.find(
          (entry) =>
            entry.workflow === file &&
            entry.job === jobId &&
            entry.step === step.name &&
            entry.command === source &&
            exactLines.has(entry.command),
        );
        if (exception) exceptionUses.set(exception, exceptionUses.get(exception) + 1);
        else problems.push(`${where}: literal unbounded unit invocation: ${source}`);
      }
    }
  }
  if (bounded !== 1)
    problems.push(`quality must have exactly one Unit tests step, found ${bounded}`);
  for (const [entry, count] of exceptionUses) {
    if (count !== 1)
      problems.push(
        `exception ${entry.workflow} ${entry.job} / ${entry.step} must match exactly once, found ${count}`,
      );
  }
  return problems;
}
