import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { LineCounter, parseDocument } from 'yaml';
import {
  DECLARERS,
  SHELL_WORD,
  continuedDollar,
  executionChain,
  findCommands,
  redirectWidth,
  shellInvocation,
  SYSTEM_PATH,
  unsplit,
  shellTextProblem,
} from './ci-shell-text-lib.mjs';

/**
 * Every Dockerfile's base image is pinned by digest, and all share one (L7-45).
 *
 * A moving tag (`node:22-alpine`) means two builds of one commit can produce
 * different images, and a base that changed under us is invisible in review.
 * A digest fixes the layer; one digest across every service means an update
 * is one deliberate change the scan then checks everywhere, not twelve that
 * drift apart. `apk upgrade` is refused for the same reason — it pulls
 * whatever the Alpine mirror holds that day. A single named package is the
 * documented stop-gap (docs/runbooks/base-image-update.md) and is allowed.
 *
 * Pure: text in, problems out.
 */

const DIGEST = /@sha256:[0-9a-f]{64}(?=\s|$)/;

/**
 * @param {Array<{ name: string, text: string }>} dockerfiles
 * @returns {{ errors: string[], digests: string[] }}
 */
export function validateDockerfilePins(dockerfiles) {
  const errors = [];
  const digests = new Set();

  for (const { name, text } of dockerfiles) {
    const stages = new Set();
    // FU-077 R1: the shared character policy; a CR or control character is not read past.
    const unreadable = shellTextProblem(text);
    if (unreadable) {
      errors.push(`${name}: cannot be read: ${unreadable}`);
      continue;
    }
    // FU-077 r2 F3: instructions read the way BuildKit reads them: leading whitespace before
    // the keyword, backslash continuations joined (comment lines inside one dropped), keyword
    // in any case. Only the default escape character is read; a parser directive refuses.
    const instructions = dockerInstructions(text);
    if (instructions.problem) {
      errors.push(`${name}: cannot be read: ${instructions.problem}`);
      continue;
    }
    let bases = 0;
    for (const { line, keyword, rest } of instructions.list) {
      if (keyword === 'FROM') {
        bases += 1;
        const from = rest.match(/^(\S+)(?:\s+AS\s+(\S+))?\s*$/i);
        if (!from) {
          errors.push(`${name}:${line}: FROM ${rest} is not a form this check reads`);
          continue;
        }
        const [, image, stage] = from;
        if (stages.has(image) && !image.includes(':')) {
          if (stage) stages.add(stage);
          continue; // FROM <earlier stage>
        }
        if (stage) stages.add(stage);
        const digest = image.match(DIGEST);
        if (!digest) {
          errors.push(`${name}:${line}: FROM ${image} is not pinned by digest`);
        } else {
          digests.add(`${image.split('@')[0]}${digest[0]}`);
        }
      }
      if (keyword === 'RUN' && /\bapk\b.*\bupgrade\b\s*(?:&&|;|$)/.test(rest)) {
        errors.push(
          `${name}:${line}: \`apk upgrade\` without a package name makes the image unreproducible`,
        );
      }
    }
    // A file with no base instruction read is not a pinned file.
    if (bases === 0) errors.push(`${name}: no FROM instruction was read`);
  }

  if (digests.size > 1) {
    errors.push(`Dockerfiles disagree on the base image digest: ${[...digests].join(', ')}`);
  }
  return { errors, digests: [...digests] };
}

/**
 * FU-077 r2 F3: a Dockerfile's instructions `{ line, keyword, rest }` (1-based first line),
 * or a problem. Leading whitespace is allowed before an instruction, a comment line is
 * dropped (also inside a continuation), `\` at a line end continues it. A parser directive
 * at the top other than `# syntax=docker/dockerfile:1[.x]` (an `escape=`, another frontend,
 * `check=`) refuses: it changes how the rest is read.
 * A here-document (`<<`) in an instruction refuses: its body lines are not instructions.
 */
export function dockerInstructions(text) {
  const lines = text.split('\n');
  const list = [];
  let current = null;
  let leading = true;
  for (const [index, raw] of lines.entries()) {
    const directive = leading && /^\s*#\s*([A-Za-z]+)\s*=\s*(.*?)\s*$/.exec(raw);
    if (directive) {
      // The official frontend, whose instruction rules are the ones read here, is allowed.
      const [, key, value] = directive;
      if (key.toLowerCase() === 'syntax' && /^docker\/dockerfile:1(?:\.\d+)*$/.test(value))
        continue;
      return { problem: `the parser directive ${key} at line ${index + 1}` };
    }
    leading = false;
    if (/^\s*#/.test(raw)) continue;
    let body = raw.trim();
    const continues = /\\$/.test(body);
    if (continues) body = body.slice(0, -1);
    if (current) current.rest += ` ${body}`;
    else if (body !== '') {
      const match = /^([A-Za-z]+)(?:\s+([\s\S]*))?$/.exec(body);
      if (!match) return { problem: `line ${index + 1} is not an instruction` };
      current = { line: index + 1, keyword: match[1].toUpperCase(), rest: match[2] ?? '' };
    }
    if (current && !continues) {
      current.rest = current.rest.trim();
      if (/<<-?\s*["']?[A-Za-z_]/.test(current.rest))
        return { problem: `a here-document in the instruction at line ${current.line}` };
      list.push(current);
      current = null;
    }
  }
  if (current) return { problem: `a continuation that never ends (line ${current.line})` };
  return { list };
}

// =============================================================================
// Compose, workflow and CI-script images (L7-45).
//
// Every image docker-compose.yml starts, in every profile, and every image CI
// starts is pinned as `tag@sha256:<digest>`: the tag for the reader, the digest
// for Docker. One repository, one digest, wherever it appears — compose and CI
// start the same Postgres, the same broker.
//
// The files are read the way their consumers read them, not line by line:
//
//   * compose and workflows through a YAML parser, with anchors, aliases and
//     `<<` merge keys resolved and quoted keys read as keys — what
//     `docker compose config` and the Actions runner see;
//   * every shell script — a workflow `run:` and every CI `.sh` — split into its
//     commands at `;`, `&&`, `||`, `|`, `&`, newlines and parentheses, with
//     backslash continuations joined, quotes, comments and here-documents
//     respected, and `$(…)` / backticks analysed as scripts of their own; every
//     `docker` command in each is classified.
//
// Fails closed: a compose `include:`/`build:`/`extends: file:`, a variable with
// no default, a GitHub expression other than `env.X`, a docker verb or option
// this check does not know, a script it cannot tokenise — each is a problem,
// never a pass. The escape hatch is a comment on the command's line or the line
// above it: `# image-pin-exempt: <why>`, and the why is required.
// =============================================================================

const PINNED_IMAGE =
  /^(?<repository>[a-z0-9][a-z0-9._/-]*?)(?::(?<tag>[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}))?@(?<digest>sha256:[0-9a-f]{64})$/;

const MINIO = 'cgr.dev/chainguard/minio';
const MINIO_DIGEST = 'sha256:bd014394a80898e68c149f2311fdf8d5a2c2f3bb2c33b9327ae6d02b4b065ae1';
const MC = 'cgr.dev/chainguard/minio-client';
const MC_PLAIN = 'sha256:b8b144ab34694ecea25aa352c4be9de4c26ee2a02701521dce02ee5593c57338';
const MC_DEV = 'sha256:614e083a12c6dc779f13f97e01b13afda4021a8ce3f4021a2fcf23ec86f46837';

/**
 * Repositories pinned at more than one digest on purpose: the exact digests,
 * and why. A digest not listed is refused, and so is a listed one no longer
 * used. Remove an entry when its reason goes.
 */
export const DIGEST_VARIANTS = new Map([
  [
    MC,
    {
      digests: [MC_PLAIN, MC_DEV],
      reason:
        'compose minio-init runs the `-dev` variant for the shell its script needs; CI runs `mc` as the entrypoint on the plain variant (ci.yml env MC_IMAGE)',
    },
  ],
]);

const CHAINGUARD_TAGLESS =
  'Chainguard’s free cgr.dev/chainguard repositories are pinned by digest alone. Whether the registry ' +
  'publishes a version tag for this digest could not be verified when this was written: cgr.dev, ' +
  'images.chainguard.dev and edu.chainguard.dev are blocked by the authoring environment’s egress ' +
  'policy. Add the tag and drop this entry once `crane ls` shows one ' +
  '(docs/runbooks/infrastructure-image-update.md)';

/** Exact `repository@digest` references allowed without a tag, each with why. */
export const TAGLESS = new Map([
  [`${MINIO}@${MINIO_DIGEST}`, CHAINGUARD_TAGLESS],
  [`${MC}@${MC_PLAIN}`, CHAINGUARD_TAGLESS],
  [`${MC}@${MC_DEV}`, CHAINGUARD_TAGLESS],
]);

/**
 * FU-077 r2 F2: `eval "${X}"` runs text the check cannot read, so it refuses, except where X
 * is the output of `bash <one of these scripts> …` assigned in the same script. Each entry
 * says why that output starts no image; an entry nothing evaluates any more is refused.
 */
export const EVALUATED_OUTPUTS = new Map([
  [
    'infrastructure/docker/kafka/kafka-credentials.sh',
    'prints only `export KAFKA_…=<single-quoted value read from a secrets file>` lines (its printf at line 46); the script itself is read by this check as a CI shell script',
  ],
]);

/**
 * FU-150 F1: `source`/`.` runs a file in the same shell. A CI `.sh` file is read by this check
 * itself. Every `.bash` file of infrastructure/ and scripts/ (init-time psql libraries and one
 * `docker compose exec` helper: their `[[ ]]`, `(( ))` and case syntax is outside the
 * tokenizer) is listed here with the sha256 of the contents a reviewer read: it starts no
 * container (no docker, eval, `sh -c` or xargs outside comments). The CLI passes each of them as
 * kind 'library'; an unlisted one, a changed one, or a source of any other path refuses.
 * To change a library: edit it, read it again, and paste the sha256 the error prints.
 */
const library = (sha256, reason) => ({ sha256, reason });
const PSQL = 'init-time psql library; starts no container';
export const SOURCED_LIBRARIES = new Map([
  [
    'infrastructure/docker/postgres/lib/disposable-marker.bash',
    library('f05bc76561ebe1bf28e56795497be0ab39a7d58e9f907c127ba01d41cb1f3895', PSQL),
  ],
  [
    'infrastructure/docker/postgres/lib/role-passwords.bash',
    library('465a53878d187075ce8f8900dee4d442749f2780cab16fd6595c38600db3aa3b', PSQL),
  ],
  [
    'infrastructure/docker/postgres/lib/rotate-role-passwords.bash',
    library('478bf3812e7bb485509a91bc0cd44ca8ffb58daf551260f10499c7a72c1c3bbf', PSQL),
  ],
  [
    'infrastructure/docker/postgres/lib/service-privilege-split.bash',
    library('d711b13ec42b4f44ef8a3c8d7a31b28c30514408d79f5c7f6ac8eafa8f9dafbb', PSQL),
  ],
  [
    'infrastructure/docker/postgres/lib/session-statement-timeout.bash',
    library('0574ba71570533df9626ed2d10e4275c244d1e1ccd48b4c30040adb907faa49f', PSQL),
  ],
  [
    'infrastructure/docker/postgres/lib/session-timezone.bash',
    library('dc57131fb86ca11f980e18db6e39fc5a5feb5e7416cd70d39a53396cf2d9be63', PSQL),
  ],
  [
    'infrastructure/docker/postgres/lib/supplier-privilege-split.bash',
    library('dab2e70cab47909974c888a225e6dc57e8dc952255926c793e410597370c4d1a', PSQL),
  ],
  [
    'scripts/postgres-exec.bash',
    library(
      'c52673c73019f71323c49d8953f263dfd27a06ac2e5f3e23342791cd4e4b8cec',
      '`docker compose exec` in the already running compose postgres service; starts no image',
    ),
  ],
]);

/**
 * FU-159 F1: files a CI script executes by a path this check cannot resolve to a CI script it
 * reads (`${VAR}/x.sh`, an absolute path inside a container). Per script: the exact words, and why
 * running that file starts no unpinned image. A word nothing uses any more is refused.
 */
export const EXECUTED_PROGRAMS = new Map([
  [
    'infrastructure/docker/kafka/create-topics.sh',
    {
      words: [
        '${KAFKA_BIN}/kafka-topics.sh',
        '${KAFKA_BIN}/kafka-configs.sh',
        '${KAFKA_BIN}/kafka-consumer-groups.sh',
      ],
      reason:
        'runs inside the pinned broker image; KAFKA_BIN is that image’s Apache Kafka bin directory',
    },
  ],
  [
    'infrastructure/docker/kafka/broker-entrypoint.sh',
    {
      words: ['/opt/kafka/bin/kafka-storage.sh', '/etc/kafka/docker/run'],
      reason: 'the broker image’s own tools, run inside that pinned image',
    },
  ],
  [
    'infrastructure/docker/kafka/ci-up.sh',
    {
      words: ['${ROOT}/scripts/ci-pull-image.sh'],
      reason:
        'ROOT is the repository root (line "ROOT=" below the script’s own directory); scripts/ci-pull-image.sh is a CI script this check reads',
    },
  ],
]);

/** The compose file the checker validates; a `docker compose -f` naming any other fails closed. */
export const COMPOSE_FILES = ['docker-compose.yml'];

// `docker run|create|pull` options: those that take a value, and those that do not.
const VALUE_FLAGS = new Set([
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
const BOOL_FLAGS = new Set([
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
// `docker <global option>` before the verb.
const GLOBAL_VALUE_FLAGS = new Set([
  '-H',
  '--host',
  '-c',
  '--context',
  '--config',
  '-l',
  '--log-level',
]);
const GLOBAL_BOOL_FLAGS = new Set(['-D', '--debug', '--tls', '--tlsverify']);
/** Verbs that start, pull or name no image (they act on containers or local state). */
const IMAGELESS_VERBS = new Set([
  'exec',
  'logs',
  'ps',
  'rm',
  'stop',
  'start',
  'restart',
  'kill',
  'wait',
  'cp',
  'inspect',
  'port',
  'top',
  'stats',
  'network',
  'volume',
  'login',
  'logout',
  'info',
  'version',
  'events',
  'rmi',
  'images',
  'system',
  'pause',
  'unpause',
]);
const RUN_VERBS = new Set(['run', 'create', 'pull']);
const EXEMPT = /#\s*image-pin-exempt:(.*)$/;

class ShellSyntaxError extends Error {}

/**
 * The index just past the `)` closing the `(` at `open` in `src`, quotes and backslashes
 * respected, or -1.
 */
function matchParen(src, open) {
  let depth = 0;
  for (let j = open; j < src.length; j += 1) {
    const ch = src[j];
    if (ch === '\\') {
      j += 1;
    } else if (ch === "'") {
      j = src.indexOf("'", j + 1);
      if (j === -1) break;
    } else if (ch === '"') {
      j += 1;
      while (j < src.length && src[j] !== '"') j += src[j] === '\\' ? 2 : 1;
    } else if (ch === '(') {
      depth += 1;
    } else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return j + 1;
    }
  }
  return -1;
}

/**
 * FU-077 r2 F2: the command substitutions bash runs while it EXPANDS text the tokenizer
 * otherwise keeps as data: a `${…}` operand, an arithmetic `$((…))` body, the body of a
 * here-document whose delimiter is not quoted. Quotes are not treated as quoting here (in a
 * here-document they are literal), so this reads at least every substitution bash runs:
 * more is a refusal or an extra check, never a skipped command. Lines are 0-based from `line`.
 */
function substitutionsIn(text, line) {
  const found = [];
  let at = line;
  for (let j = 0; j < text.length; j += 1) {
    const ch = text[j];
    if (ch === '\n') at += 1;
    else if (ch === '\\') {
      if (text[j + 1] === '\n') at += 1;
      j += 1;
    } else if (ch === '`') {
      const end = text.indexOf('`', j + 1);
      if (end === -1) throw new ShellSyntaxError(`unclosed backtick at line ${at + 1}`);
      found.push({ script: text.slice(j + 1, end), line: at });
      at += (text.slice(j, end).match(/\n/g) ?? []).length;
      j = end;
    } else if (continuedDollar(text, j)) {
      throw new ShellSyntaxError(`a line continuation after "$" at line ${at + 1}`);
    } else if (ch === '$' && text[j + 1] === '(') {
      const end = matchParen(text, j + 1);
      if (end === -1) throw new ShellSyntaxError(`unclosed "$(" at line ${at + 1}`);
      const body = text.slice(j + 2, end - 1);
      // `$((…))` is arithmetic: what it runs is the substitutions inside it.
      if (body.startsWith('(')) found.push(...substitutionsIn(body, at));
      else found.push({ script: body, line: at });
      at += (body.match(/\n/g) ?? []).length;
      j = end - 1;
    }
  }
  return found;
}

/**
 * Splits a shell script into simple commands. Each word keeps its unquoted
 * value; a word built from a command substitution is `opaque`. Substitutions
 * (also inside `${…}`, `$((…))` and expanding here-documents) and the bodies of
 * here-documents fed to a shell come back as `nested` scripts with the line they
 * start on. Each command's `input` says whether its standard input is a pipe, a
 * here-string or a here-document. Lines are 0-based.
 */
export function tokenizeShell(src) {
  const unreadable = shellTextProblem(src);
  if (unreadable) throw new ShellSyntaxError(unreadable); // FU-077 R1: one character policy
  const commands = [];
  const nested = [];
  const heredocs = [];
  let words = [];
  let word = null;
  let line = 0;
  let startLine = null;
  let i = 0;
  // FU-092: where each command sits. `group` is the ( ) group it runs in (a subshell's variables
  // do not outlive it), `sep` the separator before it (`&&`, `||`, `|`, `;`, newline, `(`, `)`).
  let group = 0;
  let nextGroup = 1;
  const groups = [];
  const parents = [-1]; // parents[group]: the group it was opened in
  const arrays = new Set(); // the groups that are array literals
  const functions = new Set(); // names defined as `name() …` or `function name`
  const opened = new Map(); // group -> the word before its ( and how many commands came before
  let pending = '';
  let cmdSep = '';
  // PR #805 r2 F2: the operator in front of a `( … )` group (`a &⏎( b )`: b is in a list `a` is part of).
  let lead = '';
  let cmdLead = '';
  // FU-077 r2 F2: where each command's standard input comes from, so a shell that reads its
  // commands from a pipe or a here-string is seen.
  let input = {};

  const ensureWord = () => {
    if (!word) word = { value: '', opaque: false, split: false };
    if (startLine === null) {
      startLine = line;
      cmdSep = pending;
      cmdLead = pending === '(' ? lead : '';
    }
  };
  let hereStringWord = false;
  // FU-159 F1: a `case` is read as a state machine, never by guessing from a command's shape:
  // 'subject' (case WORD), 'pattern' (up to the `)` that ends it) and 'body' (up to `;;` or `esac`).
  // The commands of a pattern list are flagged `pattern`; every body is an ordinary command.
  const cases = [];
  const keyword = (value) => word && !word.quoted && word.value === value;
  const pushWord = () => {
    // A here-string's word is the command's input, not one of its arguments; it is kept as
    // that input (FU-092), so a shell reading it is seen.
    if (word && hereStringWord) {
      input = { ...input, hereString: word };
      hereStringWord = false;
    } else if (word) {
      if (words.length === 0 && keyword('case')) cases.push('subject');
      else if (words.length === 0 && keyword('esac')) cases.pop();
      else if (words.length === 1 && words[0].value === 'function') functions.add(word.value);
      const opens = cases.at(-1) === 'subject' && words.length === 2 && keyword('in');
      words.push(word);
      word = null;
      if (opens) {
        cases[cases.length - 1] = 'pattern';
        endCommand();
      }
    }
    word = null;
  };
  const endCommand = (pattern = false) => {
    pushWord();
    if (words.length > 0) {
      commands.push({
        startLine,
        endLine: line,
        words,
        input,
        group,
        sep: cmdSep,
        lead: cmdLead,
        ...(pattern ? { pattern } : {}),
      });
      input = {};
    }
    words = [];
    startLine = null;
  };
  /** The index just past the `)` that closes the `(` at `open`, quotes respected. */
  const closingParen = (open) => {
    const end = matchParen(src, open);
    if (end === -1) throw new ShellSyntaxError(`unclosed "(" at line ${line + 1}`);
    return end;
  };
  const countLines = (text) => (text.match(/\n/g) ?? []).length;
  const substitution = (quoted = false) => {
    // at `$(`, `$((` or a backtick
    ensureWord();
    word.opaque = true;
    if (!quoted) word.split = true;
    if (src[i] === '`') {
      const end = src.indexOf('`', i + 1);
      if (end === -1) throw new ShellSyntaxError(`unclosed backtick at line ${line + 1}`);
      nested.push({ script: src.slice(i + 1, end), line });
      line += countLines(src.slice(i, end));
      word.value += '`…`';
      i = end + 1;
      return;
    }
    const end = closingParen(i + 1);
    const body = src.slice(i + 2, end - 1);
    word.scripts = [...(word.scripts ?? []), body];
    // FU-077 r2 F2: an arithmetic body runs the substitutions inside it.
    if (body.startsWith('(')) nested.push(...substitutionsIn(body, line));
    else nested.push({ script: body, line });
    line += countLines(src.slice(i, end));
    word.value += '$(…)';
    i = end;
  };

  // FU-092: bash deletes backslash-newline before it reads `$(`, `${` or `$((`: refused here.
  const noContinuedDollar = () => {
    if (continuedDollar(src, i))
      throw new ShellSyntaxError(`a line continuation after "$" at line ${line + 1}`);
  };
  while (i < src.length) {
    const c = src[i];
    noContinuedDollar();
    if (c === '\\') {
      if (src[i + 1] === '\n') {
        i += 2;
        line += 1;
        continue;
      }
      ensureWord();
      word.quoted = true;
      word.value += src[i + 1] ?? '';
      i += 2;
      continue;
    }
    if (c === '\n') {
      endCommand();
      // `a &&<newline> b` still continues the list, and `a &<newline>` still backgrounded a.
      if (!['&&', '||', '|', '|&', '&', '('].includes(pending)) pending = '\n';
      line += 1;
      i += 1;
      while (heredocs.length > 0) {
        const { delimiter, strip, owner, expands } = heredocs.shift();
        // FU-092: the owner is the whole command, known only now: `<<'EOF' bash` and
        // `<<EOF env bash` put the shell AFTER the here-document operator.
        const feedsShell = owner.some(({ value }) => SHELL_WORD.test(value));
        const bodyLine = line;
        const body = [];
        let closed = false;
        while (i < src.length) {
          const eol = src.indexOf('\n', i) === -1 ? src.length : src.indexOf('\n', i);
          const text = src.slice(i, eol);
          i = eol + 1;
          line += 1;
          if ((strip ? text.replace(/^\t+/, '') : text) === delimiter) {
            closed = true;
            break;
          }
          body.push(text);
        }
        if (!closed) throw new ShellSyntaxError(`here-document ${delimiter} is never closed`);
        // PR #805 r2 F1: a shell reading an EXPANDING body runs the expanded text, which is
        // whatever its substitutions and variables print: refused, never read as written.
        if (feedsShell && expands && /[$`]/.test(body.join('\n')))
          throw new ShellSyntaxError(
            `an expanding here-document read by a shell contains an expansion (line ${bodyLine})`,
          );
        if (feedsShell) nested.push({ script: body.join('\n'), line: bodyLine });
        // FU-077 r2 F2: an unquoted delimiter expands the body, running its substitutions;
        // FU-092: also when a shell then reads the expanded body (`bash <<EOF` with `$(…)`).
        if (expands) nested.push(...substitutionsIn(body.join('\n'), bodyLine));
      }
      continue;
    }
    if (c === ' ' || c === '\t') {
      pushWord();
      i += 1;
      continue;
    }
    if (c === '#' && !word) {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (cases.at(-1) === 'pattern') {
      // `a|b)`: the alternatives and the `)` are one pattern list, not commands
      if (c === '|' && src[i + 1] !== '|') {
        pushWord();
        i += 1;
        continue;
      }
      if (c === '(' && !word && words.length === 0) {
        i += 1;
        continue;
      }
      if (c === ')') {
        endCommand(true);
        cases[cases.length - 1] = 'body';
        i += 1;
        continue;
      }
    }
    if (c === ';' && /^;;&?|^;&/.test(src.slice(i, i + 3)) && cases.at(-1) === 'body') {
      endCommand();
      const op = /^;;&?|^;&/.exec(src.slice(i, i + 3))[0];
      cases[cases.length - 1] = 'pattern';
      pending = op;
      i += op.length;
      continue;
    }
    if (c === ';' || c === '&' || c === '|') {
      endCommand();
      const pipe = c === '|' && src[i + 1] !== '|';
      const length = src[i + 1] === c || (c === '|' && src[i + 1] === '&') ? 2 : 1;
      pending = src.slice(i, i + length);
      i += length;
      if (pipe) input = { pipe: true };
      continue;
    }
    if (c === '(' || c === ')') {
      // PR #805 r2 F1: `name=( … )` is an array literal: its words are elements, not commands.
      const array = c === '(' && !pending.startsWith('(') && Boolean(word?.value.endsWith('='));
      // FU-159: `name ( )` with nothing inside defines a function (read from the tokens, never
      // from the raw text, where a string or a comment can imitate it).
      const named =
        word && words.length === 0 ? word.value : words.length === 1 ? words[0].value : null;
      endCommand();
      if (c === '(') {
        groups.push(group);
        parents[nextGroup] = group;
        if (array) arrays.add(nextGroup);
        if (!array && named !== null && pending !== '(')
          opened.set(nextGroup, { name: named, count: commands.length });
        group = nextGroup++;
      } else {
        const open = opened.get(group);
        if (open && commands.length === open.count) functions.add(open.name);
        group = groups.pop() ?? 0;
      }
      if (c === '(' && pending !== '(') lead = pending;
      pending = c;
      i += 1;
      continue;
    }
    if (c === '<' && src[i + 1] === '<' && src[i + 2] === '<') {
      // a here-string: the word after it is data, not a delimiter
      pushWord();
      input = { ...input, hereString: true };
      hereStringWord = true;
      i += 3;
      while (src[i] === ' ' || src[i] === '\t') i += 1;
      continue;
    }
    if (c === '<' && src[i + 1] === '<') {
      pushWord();
      i += 2;
      const strip = src[i] === '-';
      if (strip) i += 1;
      while (src[i] === ' ' || src[i] === '\t') i += 1;
      const match = src.slice(i).match(/^(?:'([^']*)'|"([^"]*)"|([^\s;&|<>()]+))/);
      if (!match)
        throw new ShellSyntaxError(`here-document without a delimiter at line ${line + 1}`);
      // FU-077 r2 F2: a shell anywhere in the command (`env bash`, `sudo sh`) reads the body.
      heredocs.push({
        delimiter: match[1] ?? match[2] ?? match[3],
        strip,
        owner: words,
        expands: match[3] !== undefined && !/['"\\]/.test(match[3]),
      });
      input = { ...input, hereDocument: true };
      i += match[0].length;
      continue;
    }
    if (c === "'") {
      ensureWord();
      word.quoted = true;
      const end = src.indexOf("'", i + 1);
      if (end === -1) throw new ShellSyntaxError(`unclosed single quote at line ${line + 1}`);
      const text = src.slice(i + 1, end);
      word.value += text;
      line += countLines(text);
      i = end + 1;
      continue;
    }
    if (c === '"') {
      ensureWord();
      word.quoted = true;
      i += 1;
      let closed = false;
      while (i < src.length) {
        const d = src[i];
        noContinuedDollar();
        if (d === '"') {
          closed = true;
          i += 1;
          break;
        }
        if (d === '\\' && i + 1 < src.length) {
          if (src[i + 1] === '\n') line += 1;
          else word.value += '"\\$`'.includes(src[i + 1]) ? src[i + 1] : `\\${src[i + 1]}`;
          i += 2;
          continue;
        }
        if ((d === '$' && src[i + 1] === '(') || d === '`') {
          substitution(true);
          continue;
        }
        if (d === '\n') line += 1;
        word.value += d;
        i += 1;
      }
      if (!closed) throw new ShellSyntaxError('unclosed double quote');
      continue;
    }
    if ((c === '$' && src[i + 1] === '(') || c === '`') {
      substitution();
      continue;
    }
    if (c === '$' && src[i + 1] === '{') {
      ensureWord();
      word.split = true;
      let depth = 0;
      let j = i + 1;
      for (; j < src.length; j += 1) {
        if (src[j] === '{') depth += 1;
        else if (src[j] === '}' && --depth === 0) break;
      }
      if (j >= src.length) throw new ShellSyntaxError(`unclosed "\${" at line ${line + 1}`);
      // FU-077 r2 F2: `${V:-$(cmd)}` runs cmd; its value then depends on that output.
      const inner = substitutionsIn(src.slice(i + 2, j), line);
      if (inner.length > 0) word.opaque = true;
      nested.push(...inner);
      word.value += src.slice(i, j + 1);
      line += countLines(src.slice(i, j + 1));
      i = j + 1;
      continue;
    }
    ensureWord();
    if ('$*?['.includes(c)) word.split = true; // an unquoted expansion or pattern: unknown word count
    word.value += c;
    i += 1;
  }
  endCommand();
  if (cases.length > 0) throw new ShellSyntaxError('a case with no esac');
  if (heredocs.length > 0) throw new ShellSyntaxError('here-document is never closed');
  return { commands, nested, parents, arrays, functions };
}

const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s;
const GH_EXPRESSION = /\$\{\{\s*(.*?)\s*\}\}/g;

/** The image a `docker run|create|pull` names (its word), or a problem. */
function imageWord(args) {
  for (let index = 1; index < args.length; index += 1) {
    const { value } = args[index];
    if (/^\$\{[A-Za-z_][A-Za-z0-9_]*\[@\]\}$/.test(value)) continue; // "${flags[@]}"
    if (!value.startsWith('-')) return { word: args[index] };
    if (value.includes('=') || BOOL_FLAGS.has(value)) continue;
    if (VALUE_FLAGS.has(value)) {
      index += 1;
      continue;
    }
    return { problem: `cannot tell whether docker option ${value} takes a value` };
  }
  return { problem: 'names no image' };
}

/**
 * @param {Array<{ name: string, text: string, kind: 'compose' | 'workflow' | 'shell' }>} files
 * @param {{ digestVariants?: Map<string, { digests: string[], reason: string }>, tagless?: Map<string, string>, composeFiles?: string[], evaluatedOutputs?: Map<string, string> }} [policy]
 * @returns {{ errors: string[], images: Array<{ where: string, ref: string }> }}
 */
export function validateInfraImagePins(files, policy = {}) {
  const digestVariants = policy.digestVariants ?? DIGEST_VARIANTS;
  const tagless = policy.tagless ?? TAGLESS;
  const composeFiles = policy.composeFiles ?? COMPOSE_FILES;
  const evaluated = { allowed: policy.evaluatedOutputs ?? EVALUATED_OUTPUTS, used: new Set() };
  const executedPrograms = policy.executedPrograms ?? EXECUTED_PROGRAMS;
  const executedUsed = new Set();
  const executed = {
    allows: (file, word) => {
      if (!executedPrograms.get(file)?.words.includes(word)) return false;
      executedUsed.add(`${file} ${word}`);
      return true;
    },
  };
  // FU-092: a script a shell is told to run is read only if it is one of these files.
  const shellFiles = new Set(files.filter(({ kind }) => kind === 'shell').map(({ name }) => name));
  const errors = [];
  // FU-150 F1: a library is sourceable only when this run read it and its contents are the
  // reviewed ones; nothing is approved by its path or its name.
  const libraries = policy.sourcedLibraries ?? SOURCED_LIBRARIES;
  const read = files.filter(({ kind }) => kind === 'library');
  const verified = new Set();
  for (const { name, text } of read) {
    const entry = libraries.get(name);
    // Hashed as decoded text: bytes that are not UTF-8 would decode alike, so they are refused.
    const unreadable = shellTextProblem(text) ?? (text.includes('\uFFFD') ? 'invalid UTF-8' : null);
    if (unreadable) {
      errors.push(`${name}: cannot be read: ${unreadable}`);
      continue;
    }
    const sha256 = createHash('sha256').update(text).digest('hex');
    if (!entry) errors.push(`${name}: a .bash file no reviewed list names (SOURCED_LIBRARIES)`);
    else if (entry.sha256 !== sha256)
      errors.push(
        `${name}: contents changed (sha256 ${sha256}); read it again, then update SOURCED_LIBRARIES`,
      );
    else verified.add(name);
  }
  if (read.length > 0)
    for (const name of libraries.keys())
      if (!read.some((file) => file.name === name))
        errors.push(`SOURCED_LIBRARIES lists ${name}, which was not found`);
  const sourced = new Set([...shellFiles, ...verified]);
  const shared = {
    composeFiles,
    evaluated,
    executed,
    shellFiles,
    sourced,
    // FU-159 F3: false only for a file whose own text, and that of every file it sources, never changes directory
    sourceMoves: (path) =>
      !texts.has(path) ||
      [...sourceClosure(path, texts)].some((file) => DIRECTORY_WORD.test(texts.get(file))),
  };
  const texts = new Map(
    files.filter(({ kind }) => kind === 'shell' || kind === 'library').map((f) => [f.name, f.text]),
  );
  const images = [];
  const usedTagless = new Set();

  for (const file of files) {
    try {
      if (file.kind === 'compose') composeImages(file, images, errors);
      else if (file.kind === 'workflow') workflowImages(file, images, errors, shared);
      else if (file.kind !== 'library')
        shellImages(
          file.text,
          {
            file: file.name,
            lineOf: (n) => n + 1,
            env: new Map(),
            self: file.name,
            functions: visibleFunctions(file.name, texts),
            ...shared,
          },
          images,
          errors,
        );
    } catch (error) {
      errors.push(
        `${file.name}: cannot be read by this check (${error.message}) — fix it or the check`,
      );
    }
  }

  const digestsByRepository = new Map();
  for (const { where, ref } of images) {
    const pinned = ref.match(PINNED_IMAGE);
    if (!pinned) {
      errors.push(`${where}: image ${ref} is not pinned by digest (tag@sha256:<digest>)`);
      continue;
    }
    const { repository, tag, digest } = pinned.groups;
    if (!tag) {
      const key = `${repository}@${digest}`;
      if (tagless.has(key)) usedTagless.add(key);
      else errors.push(`${where}: image ${ref} has no tag — pin it as <tag>@${digest}`);
    }
    if (!digestsByRepository.has(repository)) digestsByRepository.set(repository, new Map());
    const seen = digestsByRepository.get(repository);
    if (!seen.has(digest)) seen.set(digest, where);
  }

  for (const [repository, seen] of digestsByRepository) {
    const variant = digestVariants.get(repository);
    if (!variant) {
      if (seen.size > 1) {
        const at = [...seen].map(([digest, where]) => `${digest} (${where})`).join(', ');
        errors.push(`${repository} is pinned at ${seen.size} digests: ${at}`);
      }
      continue;
    }
    for (const [digest, where] of seen) {
      if (!variant.digests.includes(digest)) {
        errors.push(
          `${where}: ${repository} is pinned at ${digest}, which is not one of the ${variant.digests.length} digests DIGEST_VARIANTS allows for it`,
        );
      }
    }
  }
  for (const [repository, { digests }] of digestVariants) {
    const seen = digestsByRepository.get(repository) ?? new Map();
    for (const digest of digests) {
      if (!seen.has(digest)) {
        errors.push(`DIGEST_VARIANTS allows ${repository}@${digest}, which nothing uses any more`);
      }
    }
  }
  for (const [path, reason] of evaluated.allowed) {
    if (!reason || !evaluated.used.has(path))
      errors.push(`EVALUATED_OUTPUTS lists ${path}, which nothing evaluates any more`);
  }
  for (const [file, { words, reason }] of executedPrograms)
    for (const word of words)
      if (
        files.some(({ name }) => name === file) &&
        (!reason || !executedUsed.has(`${file} ${word}`))
      )
        errors.push(`EXECUTED_PROGRAMS lists ${word} in ${file}, which nothing runs any more`);
  for (const key of tagless.keys()) {
    if (!usedTagless.has(key))
      errors.push(`TAGLESS lists ${key}, which nothing uses without a tag any more`);
  }
  return { errors, images };
}

/** Parses YAML the way compose and the Actions runner do: anchors, aliases, `<<` merge keys. */
function parseYaml(text) {
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { merge: true, lineCounter, uniqueKeys: false });
  if (doc.errors.length > 0) throw new Error(doc.errors[0].message.split('\n')[0]);
  const lineAt = (node) => (node?.range ? lineCounter.linePos(node.range[0]).line : 1);
  return { doc, js: doc.toJS({ maxAliasCount: -1 }) ?? {}, lineAt };
}

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Compose's interpolation of one value: `$$`, `${VAR:-default}` / `${VAR-default}`; anything else fails closed. */
function interpolateCompose(value) {
  let problem;
  const out = value.replace(/\$\$|\$\{([^{}]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (match, braced) => {
    if (match === '$$') return '$';
    const parts = braced?.match(/^([A-Za-z_][A-Za-z0-9_]*)(:?-)(.*)$/s);
    if (parts) return parts[3];
    problem ??= `${match} has no default this check can resolve`;
    return match;
  });
  if (!problem && /\$\{/.test(out)) problem = `cannot interpolate ${value}`;
  return problem ? { problem } : { value: out };
}

function composeImages({ name, text }, images, errors) {
  const { doc, js, lineAt } = parseYaml(text);
  if (!isObject(js)) throw new Error('not a mapping');
  if ('include' in js) errors.push(`${name}: include: brings in services this check does not read`);
  if (!isObject(js.services)) {
    errors.push(`${name}: has no services: mapping`);
    return;
  }
  const services = js.services;
  const resolve = (service, chain) => {
    const definition = services[service];
    if (!isObject(definition))
      return { problem: `extends a service ${service} that is not defined` };
    if (definition.image !== undefined) return { image: definition.image };
    if (definition.extends !== undefined) {
      const target =
        typeof definition.extends === 'string'
          ? { service: definition.extends }
          : definition.extends;
      if (!isObject(target) || target.file !== undefined) {
        return { problem: 'extends a service in another file, which this check does not read' };
      }
      if (chain.includes(target.service)) return { problem: 'extends itself' };
      return resolve(target.service, [...chain, target.service]);
    }
    if (definition.build !== undefined) {
      return { problem: 'builds its image here, and this check does not read that Dockerfile' };
    }
    return { problem: 'names no image' };
  };
  for (const service of Object.keys(services)) {
    const node =
      doc.getIn(['services', service, 'image'], true) ?? doc.getIn(['services', service], true);
    const where = `${name}:${lineAt(node)} (service ${service})`;
    const { image, problem } = resolve(service, [service]);
    if (problem) {
      errors.push(`${where}: ${problem}`);
      continue;
    }
    if (typeof image !== 'string') {
      errors.push(`${where}: image is not a string`);
      continue;
    }
    const interpolated = interpolateCompose(image);
    if (interpolated.problem) errors.push(`${where}: image ${interpolated.problem}`);
    else images.push({ where, ref: interpolated.value });
  }
}

function workflowImages({ name, text }, images, errors, shared) {
  const { doc, js, lineAt } = parseYaml(text);
  // Local tags carry across steps, in document order, as they do on the runner.
  const state = { localTags: new Set() };
  if (!isObject(js)) throw new Error('not a mapping');
  const env = new Map(); // every env variable, at any level, with every value it is given
  const addEnv = (block, path) => {
    if (!isObject(block)) return;
    for (const [key, value] of Object.entries(block)) {
      if (STARTUP_TEXT.test(key))
        errors.push(`${name}: env sets ${key}, which a shell evaluates at startup`);
      if (!env.has(key)) env.set(key, new Set());
      env.get(key).add(String(value));
      if (/_IMAGE$/.test(key)) {
        const where = `${name}:${lineAt(doc.getIn([...path, key], true))}`;
        for (const ref of resolveExpressions(String(value), env, where, errors))
          images.push({ where, ref });
      }
    }
  };
  addEnv(js.env, ['env']);
  const jobs = isObject(js.jobs) ? js.jobs : {};
  for (const [jobId, job] of Object.entries(jobs)) {
    if (!isObject(job)) continue;
    addEnv(job.env, ['jobs', jobId, 'env']);
    (Array.isArray(job.steps) ? job.steps : []).forEach((step, index) => {
      if (isObject(step)) addEnv(step.env, ['jobs', jobId, 'steps', index, 'env']);
    });
  }
  const image = (ref, path) => {
    const where = `${name}:${lineAt(doc.getIn(path, true))}`;
    if (typeof ref !== 'string') return errors.push(`${where}: image is not a string`);
    for (const resolved of resolveExpressions(ref, env, where, errors))
      images.push({ where, ref: resolved });
  };
  for (const [jobId, job] of Object.entries(jobs)) {
    if (!isObject(job)) continue;
    if (isObject(job.services)) {
      for (const [service, definition] of Object.entries(job.services)) {
        const path = ['jobs', jobId, 'services', service, 'image'];
        if (isObject(definition)) image(definition.image, path);
      }
    }
    if (typeof job.container === 'string') image(job.container, ['jobs', jobId, 'container']);
    else if (isObject(job.container))
      image(job.container.image, ['jobs', jobId, 'container', 'image']);
    (Array.isArray(job.steps) ? job.steps : []).forEach((step, index) => {
      if (!isObject(step)) return;
      const uses = typeof step.uses === 'string' ? step.uses.match(/^docker:\/\/(.+)$/) : null;
      if (uses) image(uses[1], ['jobs', jobId, 'steps', index, 'uses']);
      if (typeof step.run === 'string') {
        const node = doc.getIn(['jobs', jobId, 'steps', index, 'run'], true);
        const block = node?.type === 'BLOCK_LITERAL' || node?.type === 'BLOCK_FOLDED';
        const first = lineAt(node) + (block ? 1 : 0);
        // A relative script path means another file when the step runs elsewhere than the root.
        const moved =
          step['working-directory'] !== undefined ||
          job.defaults?.run?.['working-directory'] !== undefined ||
          js.defaults?.run?.['working-directory'] !== undefined;
        shellImages(
          step.run,
          {
            file: name,
            lineOf: (n) => first + n,
            env,
            ...shared,
            shellFiles: moved ? new Set() : shared.shellFiles,
            sourced: moved ? new Set() : shared.sourced,
          },
          images,
          errors,
          state,
        );
      }
    });
  }
}

/** `${{ env.X }}` resolved to every value X is given; any other expression fails closed. */
function resolveExpressions(value, env, where, errors) {
  if (!value.includes('${{')) return [value];
  let candidates = [value];
  for (const [expression, inner] of value.matchAll(GH_EXPRESSION)) {
    const envName = inner.match(/^env\.([A-Za-z_][A-Za-z0-9_]*)$/);
    const values = envName ? env.get(envName[1]) : undefined;
    if (!values) {
      errors.push(
        `${where}: image ${value} uses the expression ${expression}, which this check cannot resolve`,
      );
      return [];
    }
    candidates = candidates.flatMap((candidate) =>
      [...values].map((v) => candidate.replace(expression, v)),
    );
  }
  return candidates;
}

/**
 * Every `docker` command in a shell script. `ctx.lineOf` maps a script line to
 * a file line; `ctx.env` holds the variables the script inherits (a workflow's
 * env), each with every value it may take.
 */
function shellImages(script, ctx, images, errors, state = { localTags: new Set() }) {
  // GitHub substitutes ${{ }} before the shell runs; keep each as one word.
  const expressions = [];
  const src = script.replace(GH_EXPRESSION, (match) => {
    expressions.push(match);
    return `__GHEXPR${expressions.length - 1}__`;
  });
  const exempt = new Map();
  src.split('\n').forEach((text, index) => {
    const marker = text.match(EXEMPT);
    if (!marker) return;
    if (marker[1].trim().length === 0) {
      errors.push(`${ctx.file}:${ctx.lineOf(index)}: image-pin-exempt needs a reason`);
    } else {
      exempt.set(index, marker[1].trim());
    }
  });

  let parsed;
  try {
    parsed = tokenizeShell(src);
  } catch (error) {
    errors.push(
      `${ctx.file}:${ctx.lineOf(0)}: cannot split this script into commands (${error.message})`,
    );
    return;
  }
  // FU-150 F1: the splitter ends a command at the `&` of `2>&1` and `>&2`; the fd that follows is
  // that redirection's target, not the first word of a command of its own (`2>&1 $c run`).
  for (const [index, command] of parsed.commands.entries())
    if (command.sep === '&' && /[<>]$/.test(parsed.commands[index - 1]?.words.at(-1)?.value ?? ''))
      command.words = command.words.slice(1);
  // FU-159 F1: the tokenizer flags the commands of a `case` pattern list; a body is a command.
  const isPattern = (index) => Boolean(parsed.commands[index].pattern);
  // FU-159 F3: a file named relative to the directory this script starts in is a different file
  // once it (or a wrapper) changes directory; in this shell and every context nested in it.
  const changes = directoryChanges(parsed.commands, (word) => {
    const path = word && sourcedPath(word, ctx.self);
    return path !== undefined && ctx.sourceMoves?.(path) === false;
  });
  const functions = new Set([...(ctx.functions ?? []), ...parsed.functions]);
  // A `cd` in a ( ) group leaves the commands outside it where they were. Inside a compound
  // command or function body (`nesting`) the order is not the text order; `later` is text that
  // runs at another time (a trap handler).
  const movedAt = (position, later = false) =>
    Boolean(ctx.moved) ||
    (changes.length > 0 &&
      (later ||
        position === undefined ||
        nesting[position] > 0 ||
        changes.some(
          (at) =>
            at < position && inGroup(parsed.commands[position].group, parsed.commands[at].group),
        )));
  const moved = movedAt();
  const movedAtLine = (line) => {
    const holders = parsed.commands.flatMap((c, k) =>
      c.startLine <= line && line <= c.endLine ? [k] : [],
    );
    return holders.length > 0 ? holders.some((k) => movedAt(k)) : moved;
  };
  const vars = new Map();
  const outputs = new Map(); // variable -> the one command substitution it was assigned from
  // Every place a name is written to (`x=`, `x+=`, `read x`, `for x in`): not after `$`/`{`.
  // `${NAME:=x}` / `${NAME=x}` assign too (FU-092).
  // FU-150 F2: also the name attached to an option (`printf -vc`, `read -ac`).
  const writes = (name) =>
    (
      src.match(
        new RegExp(
          `(?<![\\w$\\{])${name}(?![\\w])|(?<=(?:^|[\\s;&|(])-[A-Za-z]*)${name}(?![\\w])|\\$\\{${name}:?=`,
          'g',
        ),
      ) ?? []
    ).length;
  const restore = (value) => value.replace(/__GHEXPR(\d+)__/g, (_, n) => expressions[Number(n)]);
  // How many assignment-only commands of this script assign a variable one `$(…)`.
  const assignedFrom = new Map();
  for (const { words } of parsed.commands) {
    if (!assignmentOnly(words)) continue;
    for (const { value, scripts } of withoutDeclarers(words)) {
      const [, variable, assigned] = value.match(ASSIGNMENT);
      if (assigned === '$(…)' && scripts?.length === 1)
        assignedFrom.set(variable, (assignedFrom.get(variable) ?? 0) + 1);
    }
  }

  // FU-092: an evaluated variable's provenance is proved or the eval refuses. It cannot be
  // proved inside a compound command or function body (`if`, loops, `{ }`: it may not run),
  // or where a sourced file or a computed-name write (`printf -v "$(…)"`, `read "$n"`,
  // `declare -n`) could have set the variable.
  // FU-150 F2: and an arithmetic assignment whose target name is computed (`(( $n = 5 ))`).
  const provenanceBroken =
    parsed.commands.some(({ words }, index) => !isPattern(index) && dynamicWriter(words)) ||
    /\(\([^)]*[$`][^)]*(?<![=!<>])=(?!=)/.test(src);
  let open = 0;
  const nesting = parsed.commands.map(({ words }) => {
    const first = words[headIndex(words)]?.value;
    if (CLOSERS.has(first)) open = Math.max(0, open - 1);
    const at = open;
    if (OPENERS.has(first)) open += 1;
    return at;
  });
  /** `group` is `ancestor` or a subshell opened inside it: it inherits the variables set there. */
  const inGroup = (group, ancestor) => {
    for (let g = group; g >= 0; g = parsed.parents[g]) if (g === ancestor) return true;
    return false;
  };
  /**
   * The command at `position` runs whenever the command at `later` runs. A `&&` list that is
   * backgrounded or piped runs in a subshell: `later` must then be in that same list.
   */
  const unconditional = (position, later) => {
    const { group } = parsed.commands[position];
    let end = position + 1;
    // A `||` list is one list too: `producer || true &` runs all of it in the background.
    while (['&&', '||'].includes(parsed.commands[end]?.sep) && parsed.commands[end].group === group)
      end += 1;
    const after = parsed.commands[end];
    if (
      ['&', '|', '|&'].includes(after?.sep === '(' ? after.lead : after?.sep) &&
      !(later >= position && later < end)
    )
      return false;
    for (let k = position; k >= 0; k -= 1) {
      const at = parsed.commands[k];
      if (at.group !== group) return false;
      if (LIST_STARTS.has(at.sep)) return true;
      if (at.sep !== '&&' || !assignmentOnly(parsed.commands[k - 1]?.words ?? [])) return false;
    }
    return false;
  };

  for (const [position, command] of parsed.commands.entries()) {
    const where = `${ctx.file}:${ctx.lineOf(command.startLine)}`;
    let words = command.words;
    // PR #805 r2 F1: a variable a shell evaluates at startup is text this check does not read.
    if (words.some(({ value }) => STARTUP_TEXT.test(value)))
      errors.push(`${where}: sets a variable a shell evaluates at startup (BASH_ENV, ENV ...)`);
    // Assignments before a command, or alone (a variable for later commands).
    let index = 0;
    while (
      index < words.length &&
      ['export', 'local', 'readonly', 'declare'].includes(words[index].value)
    )
      index += 1;
    const assignments = [];
    while (index < words.length && ASSIGNMENT.test(words[index].value)) {
      assignments.push(words[index]);
      index += 1;
    }
    if (index === words.length) {
      for (const { value, opaque, scripts } of assignments) {
        const [, variable, assigned] = value.match(ASSIGNMENT);
        vars.set(variable, opaque ? null : restore(assigned));
        if (assigned === '$(…)' && scripts?.length === 1) {
          outputs.set(variable, { script: scripts[0], position });
        } else outputs.delete(variable);
      }
      continue;
    }
    words = words.slice(index);
    let isExempt = false;
    for (let line = command.startLine - 1; line <= command.endLine; line += 1) {
      if (exempt.has(line)) isExempt = true;
    }
    if (isExempt) continue;
    const problem = (text) => errors.push(`${where}: ${text}`);
    const at = words.findIndex(({ value }) => /(^|\/)docker(-compose)?$/.test(value));
    // PR #805 r2 F1: stages that turn text into commands keep what they carry or refuse it.
    const staged =
      parsed.arrays.has(command.group) || isPattern(position)
        ? {}
        : textStage(command.words, command.input, {
            files: ctx.sourced,
            self: ctx.self,
            shellFiles: ctx.shellFiles,
            moved: movedAt(position),
            functions,
            executed: ctx.executed,
            file: ctx.file,
          });
    if (staged.problem) problem(staged.problem);
    for (const script of staged.scripts ?? [])
      shellImages(
        script,
        {
          ...ctx,
          moved: movedAt(position, true),
          functions,
          self: undefined,
          lineOf: (n) => ctx.lineOf(command.startLine + n),
        },
        images,
        errors,
        state,
      );
    // FU-077 r2 F2: a shell or eval before any docker word runs text as commands. Words after
    // docker are the container's command, which runs inside the pinned image.
    const shellAt = (at === -1 ? words : words.slice(0, at)).findIndex(
      ({ value }) => SHELL_WORD.test(value) || value === 'eval',
    );
    if (shellAt !== -1) {
      // An evaluated variable is read only when every write to it in this script is one of
      // the tracked assignments, the latest one before this command.
      const tracked = new Map(
        [...outputs]
          .filter(
            ([name, from]) =>
              !provenanceBroken &&
              nesting[position] === 0 &&
              nesting[from.position] === 0 &&
              writes(name) === assignedFrom.get(name) &&
              inGroup(command.group, parsed.commands[from.position].group) &&
              unconditional(from.position, position),
          )
          .map(([name, from]) => [name, from.script]),
      );
      const read = shellInput(words.slice(shellAt), command.input, tracked, {
        ...ctx,
        moved: movedAt(position) || executionChain(command.words).moves,
      });
      if (read.problem) problem(read.problem);
      else if (read.script !== undefined)
        shellImages(
          read.script,
          {
            ...ctx,
            moved: movedAt(position),
            functions,
            self: undefined,
            lineOf: (n) => ctx.lineOf(command.startLine + n),
          },
          images,
          errors,
          state,
        );
    }
    if (at === -1) continue;
    const args = words.slice(at + 1);
    if (words[at].value.endsWith('docker-compose')) {
      composeCommand(args, ctx, problem);
      continue;
    }
    let verbAt = 0;
    while (verbAt < args.length && args[verbAt].value.startsWith('-')) {
      const flag = args[verbAt].value;
      if (GLOBAL_VALUE_FLAGS.has(flag)) verbAt += 2;
      else if (GLOBAL_BOOL_FLAGS.has(flag) || flag.includes('=')) verbAt += 1;
      else {
        problem(`docker global option ${flag} is not one this check knows`);
        verbAt = -1;
        break;
      }
    }
    if (verbAt === -1) continue;
    let verb = args[verbAt]?.value;
    let rest = args.slice(verbAt);
    if (verb === 'container' || verb === 'image') {
      const sub = args[verbAt + 1]?.value;
      rest = args.slice(verbAt + 1);
      if (
        (verb === 'container' && (sub === 'run' || sub === 'create')) ||
        (verb === 'image' && sub === 'pull')
      ) {
        verb = sub;
      } else if (verb === 'image' && sub === 'tag') {
        verb = 'tag';
      } else if (
        [
          'ls',
          'list',
          'inspect',
          'rm',
          'prune',
          'logs',
          'stop',
          'kill',
          'exec',
          'start',
          'restart',
          'wait',
          'cp',
          'history',
        ].includes(sub)
      ) {
        continue;
      } else {
        problem(
          `docker ${verb} ${sub ?? ''} is not a command this check can classify — exempt it with a reason if it starts no image`,
        );
        continue;
      }
    }
    if (verb === undefined) {
      problem('docker with no command');
    } else if (RUN_VERBS.has(verb)) {
      const found = imageWord(rest);
      if (found.problem) {
        problem(`docker ${verb} ${found.problem}`);
        continue;
      }
      if (state.localTags.has(found.word.value)) continue;
      for (const ref of resolveImage(found.word, { vars, env: ctx.env, restore, where, errors })) {
        if (!state.localTags.has(ref)) images.push({ where, ref });
      }
    } else if (verb === 'tag') {
      const [source, target] = rest.slice(1).map((w) => w.value);
      if (source && target && (PINNED_IMAGE.test(source) || state.localTags.has(source))) {
        state.localTags.add(target);
      } else if (source) {
        images.push({ where, ref: source });
      }
    } else if (verb === 'compose') {
      composeCommand(rest.slice(1), ctx, problem);
    } else if (!IMAGELESS_VERBS.has(verb)) {
      problem(
        `docker ${verb} is not a command this check can classify — check its image by hand and exempt it with a reason, or teach the check`,
      );
    }
  }
  for (const { script: inner, line } of parsed.nested) {
    shellImages(
      inner,
      {
        ...ctx,
        // the directory at the commands that hold it (a substitution has no position of its own)
        moved: movedAtLine(line),
        functions,
        self: undefined,
        lineOf: (n) => ctx.lineOf(line + n),
      },
      images,
      errors,
      state,
    );
  }
}

// PR #805 r2 F1: variables whose value a shell runs at startup or between commands.
const STARTUP_TEXT = /^(?:BASH_ENV|ENV|PROMPT_COMMAND|PS0|PS1|PS4|SHELLOPTS|BASHOPTS)(?:\+?=.*)?$/;
/** Programs that run an operand string as a command line, or read commands from standard input. */
const STRING_RUNNERS = new Set('flock su runuser sg script ssh watch at batch parallel'.split(' '));
const STRING_WRAPPERS = new Set(['sudo', 'doas']);
/** Names that take text wherever they stand in a command (not `source` and `.`: those are arguments too). */
const TAKES_TEXT = new Set(
  ['alias trap env xargs find', ...[...STRING_RUNNERS, ...STRING_WRAPPERS]].flatMap((names) =>
    names.split(' '),
  ),
);
/** Programs that substitute into the command they run (`xargs -I{}`, `find -exec … {}`). */
const REWRITERS = new Set(['xargs', 'find', 'parallel']);
const computedWord = (word) => Boolean(word.opaque || word.value.includes('$'));
/**
 * PR #805 r2 F1: what the stages between a command line and the commands it runs do. A stage
 * that rewrites, generates or hands over text is read (`{ scripts }`) or refused (`{ problem }`);
 * none is "nothing relevant".
 */
function textStage(words, input, env) {
  // FU-150 F1: the shared execution boundary names the words that run the next one (control
  // words, wrappers with their options, xargs operands) and refuses a computed program.
  const { chain: list, problem, moves, inputs } = executionChain(words);
  if (problem) return { problem };
  if (list.length === 0) return {};
  // FU-159 F3: `env -C dir`, `sudo -D dir` and `chroot` run what follows from another directory.
  const here = { ...env, moved: env.moved || moves };
  const final = list.at(-1);
  const unproven = programProblem(words[final], words.slice(final + 1), inputs, here);
  if (unproven) return { problem: unproven };
  const chain = new Set(list);
  const scripts = [];
  for (const [index, word] of words.entries()) {
    const name = word.value.split('/').at(-1);
    if (index < list[0] || !(chain.has(index) || TAKES_TEXT.has(name))) continue;
    const stage = wordStage(name, words.slice(index + 1), input, here);
    if (stage.problem) return stage;
    scripts.push(...(stage.scripts ?? []));
    // `find … -exec CMD … ;`: each operand command line is read like a line of its own.
    if (name === 'find')
      for (const operands of findCommands(words.slice(index + 1))) {
        const inner = textStage(operands, {}, here);
        if (inner.problem) return inner;
        scripts.push(...(inner.scripts ?? []));
      }
  }
  return { scripts };
}

/**
 * FU-159 F1: words of the grammar and builtins. They run no argument as a command (the ones that
 * do - `eval`, `source`, `.`, `trap`, `exec`, `command`, `builtin` - are read by their own stage).
 */
const BUILTINS = new Set(
  (
    ': [ [[ ]] ]] test echo printf read cd pushd popd pwd exit return break continue shift set unset ' +
    'export local declare typeset readonly let getopts mapfile readarray wait umask ulimit true false ' +
    'type hash for in do done while until if then else elif fi case esac select function { } ! ( ) ' +
    'eval source . trap alias docker docker-compose exec command builtin'
  ).split(' '),
);
/**
 * FU-159 F1: installed programs whose arguments are DATA: a path, a pattern, a text, a URL. A
 * program NOT in this table, in `WRAPPERS` or in a stage above, may run its operands as a command
 * (`taskset 1 $c`, `setpriv … $c`, `gosu u $c`): with an argument this check cannot read it is
 * refused. One row per reason; add a program here only after reading what it does with argv.
 */
const DATA_PROGRAMS = new Set(
  Object.values({
    'file utilities and text filters: arguments are paths, modes or patterns':
      'cat cp mv rm mkdir mktemp chmod chown ls ln touch tee tail head sort uniq wc cut tr sed grep awk dirname basename seq date sleep pwd cmp diff',
    'network and database clients: arguments are URLs, hosts, SQL or options':
      'curl psql keytool openssl mc',
    'language runtimes and toolchains: an argument is a file, a package or a script text, whose own spawns are outside the shell boundary':
      'node go',
    '`find -exec` operands are read by findCommands; `xargs` is a wrapper': 'find',
  }).flatMap((names) => names.split(' ')),
);
/** An argument whose value this check cannot read: an expansion, a pattern, a substitution. */
const unreadArgument = (word) => unsplit(word) || word.value.includes('$');
/** A path to a file (not a bare program name, not an installed program by absolute path). */
const filePath = (value) => value.includes('/') && !SYSTEM_PATH.test(value);
/** An argument that names a script file: a relative or absolute path, or a `.sh`/`.bash` name. */
const scriptLike = (value) => /^\.{0,2}\//.test(value) || /\.(?:sh|bash)$/.test(value);

/**
 * FU-159 F1: the program that finally runs (the end of the execution chain) is either proved to
 * run no operand as a command, or its file is a CI script this check reads, or it is refused:
 * an executable that is not read (`./x.sh`, `"$VAR/x.sh"`), a program that may delegate with an
 * argument that is not literal (or whose arguments are `xargs` input), a file passed to one.
 */
function programProblem(program, args, inputs, env) {
  const { value } = program;
  const operands = [];
  for (let at = 0; at < args.length; at++) {
    const redirect = redirectWidth(args, at);
    if (redirect > 0) at += redirect - 1;
    else operands.push(args[at]);
  }
  if (filePath(value)) {
    const fixed = env.executed.allows(env.file, value);
    const path = posix.normalize(value);
    if (fixed || (!unreadArgument(program) && !env.moved && env.shellFiles.has(path))) return null;
    return `runs ${value}, a file this check does not read (a CI .sh file by its exact path, from a directory this script has not left, or an EXECUTED_PROGRAMS entry)`;
  }
  const name = value.split('/').at(-1);
  if (
    BUILTINS.has(name) ||
    DATA_PROGRAMS.has(name) ||
    STRING_RUNNERS.has(name) ||
    SHELL_WORD.test(name) ||
    REWRITERS.has(name) ||
    env.functions.has(name)
  )
    return null;
  const unread = operands.find(
    (word) =>
      unreadArgument(word) ||
      (scriptLike(word.value) && !env.shellFiles.has(posix.normalize(word.value))),
  );
  if (!inputs && !unread) return null;
  return `runs ${name}, a program that may run its operands as a command, with ${inputs ? 'arguments from xargs input' : `the argument ${unread.value}`} (WRAPPERS or DATA_PROGRAMS, after reading what it does with argv)`;
}

const FUNCTION_DEFINITION = /(?:^|[\n;&|(){]\s*)(?:function\s+)?([A-Za-z_][\w:.+-]*)\s*\(\s*\)/g;
const definedFunctions = (text) => [...text.matchAll(FUNCTION_DEFINITION)].map(([, name]) => name);
const SOURCE_LINE =
  /(?:^|[\n;&|(){]\s*)(?:source|\.)\s+"?(?:\$\(dirname "\$\{?BASH_SOURCE(?:\[0\])?\}?"\)\/)?([^"\s$]+)"?/g;
/** The files `name` sources, directly or not, and itself (read from `source`/`.` lines of the text). */
function sourceClosure(name, texts, seen = new Set()) {
  if (seen.has(name) || !texts.has(name)) return seen;
  seen.add(name);
  for (const [, tail] of texts.get(name).matchAll(SOURCE_LINE))
    for (const path of [posix.normalize(tail), posix.join(posix.dirname(name), tail)])
      sourceClosure(posix.normalize(path), texts, seen);
  return seen;
}
/** The function names a file can call: its own and those of every file it sources, transitively. */
function visibleFunctions(name, texts) {
  const names = new Set();
  for (const file of sourceClosure(name, texts)) {
    try {
      // a .sh file is read by tokens; a hash-pinned .bash library (which the tokenizer cannot read) by text
      const defined = file.endsWith('.bash')
        ? definedFunctions(texts.get(file))
        : [...tokenizeShell(texts.get(file)).functions];
      for (const fn of defined) names.add(fn);
    } catch {
      // an unreadable file defines nothing here; it is refused where it is read
    }
  }
  return names;
}
/** A word of the text that changes directory, anywhere (a comment too: this errs toward refusing). */
const DIRECTORY_WORD = /(?<![\w$./-])(?:cd|pushd|popd|chroot)(?![\w./-])/;
/**
 * FU-159 F3: the indexes of the commands that can change this shell's working directory (`cd`,
 * `pushd`, `popd`, a wrapper option such as `env -C` or `sudo -D`, `chroot`, also inside literal
 * `eval`, `trap` and `-c` text). A relative file name means another file after that.
 */
function directoryChanges(commands, inert, depth = 0) {
  return commands.flatMap(({ words }, index) => {
    const { chain, moves } = executionChain(words);
    const inText = ({ value }) => {
      if (depth >= 4 || !/[\s;&|]/.test(value)) return false;
      try {
        return directoryChanges(tokenizeShell(value).commands, inert, depth + 1).length > 0;
      } catch {
        return false;
      }
    };
    const program = words[chain.at(-1)]?.value;
    // a sourced file runs in this shell: it may `cd` unless it is a file whose text never does
    const sources = (program === 'source' || program === '.') && !inert(words[chain.at(-1) + 1]);
    return moves || sources || ['cd', 'pushd', 'popd'].includes(program) || words.some(inText)
      ? [index]
      : [];
  });
}

/**
 * FU-150 F1: the repository path a `source` operand names, or undefined. A literal is itself
 * (normalised); the one computed form read is `$(dirname "${BASH_SOURCE[0]}")/<tail>` in a
 * top-level script (`self`, its own path), which is that script's directory plus the tail.
 * `$0` is NOT the file's own once another script sources it (FU-159). No other prefix, no suffix
 * match, no variable.
 */
function sourcedPath(word, self) {
  if (!word) return undefined;
  const exact = (path) => (/[\s$`*?[\]{}~\\]/.test(path) ? undefined : posix.normalize(path));
  if (!computedWord(word)) return exact(word.value);
  const tail = /^\$\(…\)(\/[^$]*)$/.exec(word.value)?.[1];
  const inner = word.scripts?.length === 1 ? word.scripts[0].trim() : '';
  const own = /^dirname\s+"(?:\$BASH_SOURCE|\$\{BASH_SOURCE(?:\[0\])?\})"$/.test(inner);
  return self !== undefined && tail !== undefined && own
    ? exact(posix.join(posix.dirname(self), tail))
    : undefined;
}

/** The stage the program `name` is, given the words after it. */
function wordStage(name, args, input, sourced) {
  const standardInput = input.pipe || input.hereString || input.hereDocument;
  if (name === 'alias') return { problem: 'alias defines text a later command runs' };
  if (
    (name === 'mapfile' || name === 'readarray') &&
    args.some(({ value }) => /^-[A-Za-z]*C/.test(value))
  )
    return { problem: `${name} -C runs a callback this check does not read` };
  if (name === 'trap') {
    const handler = args.find(({ value }) => !value.startsWith('-') || value === '-');
    if (!handler || handler.value === '-' || handler.value === '') return {};
    return computedWord(handler)
      ? { problem: 'trap runs a handler this check cannot read' }
      : { scripts: [handler.value] };
  }
  if (name === 'source' || name === '.') {
    const target = sourcedPath(args[0], sourced.self);
    return target !== undefined && sourced.files.has(target) && !sourced.moved
      ? {}
      : {
          problem: `${name} runs ${args[0]?.value ?? 'nothing'}, a script this check does not read (only the exact path of a CI .sh file or a hash-pinned library, from a directory this script has not left)`,
        };
  }
  if (name === 'env' && args.some(({ value }) => /^(?:-[A-Za-z]*S|--split-string)/.test(value)))
    return { problem: 'env -S splits a string into a command this check does not read' };
  if (REWRITERS.has(name) && args.some(({ value }) => SHELL_WORD.test(value) || value === 'eval'))
    return { problem: `${name} rewrites the text a shell runs` };
  const runner = STRING_RUNNERS.has(name);
  if (!runner && !STRING_WRAPPERS.has(name)) return {};
  if (runner && standardInput)
    return {
      problem: `${name} reads commands from standard input, which this check does not read`,
    };
  const scripts = [];
  for (const word of args) {
    if (computedWord(word) && runner)
      return { problem: `${name} runs a command string this check cannot read` };
    if (!computedWord(word) && /\s/.test(word.value)) scripts.push(word.value);
  }
  return { scripts };
}

/**
 * FU-077 r2 F2: what a shell or `eval` command runs. `{ script }` is text to read as a script
 * of its own, `{}` is input read elsewhere (a CI `.sh` file this check validates, or a
 * here-document body already read as a nested script), `{ problem }` refuses: a pipe or the
 * terminal into a shell, a computed `-c` body or eval text, a script file that is not read.
 * FU-092: the shell's own options are classified by shellInvocation (shared), and a script
 * operand counts only if it is a file of the run (`ctx.shellFiles`), never by default.
 */
function shellInput([command, ...args], input, outputs, { evaluated, shellFiles, moved }) {
  const literal = (word) => !word.opaque && !word.value.includes('$');
  if (command.value === 'eval') {
    if (args.length > 0 && args.every(literal))
      return { script: args.map(({ value }) => value).join(' ') };
    const name = args.length === 1 && /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(args[0].value);
    const source = name && !args[0].opaque ? outputs.get(name[1]) : undefined;
    const file = source === undefined ? undefined : evaluatedFile(source);
    if (file !== undefined && evaluated.allowed.has(file)) {
      evaluated.used.add(file);
      return {};
    }
    return { problem: 'eval runs text this check cannot read (EVALUATED_OUTPUTS)' };
  }
  if (args.some(({ value }) => value.startsWith('<')))
    return { problem: `${command.value} reads its commands from a redirection` };
  const run = shellInvocation(args, command.value);
  if (run.problem) return run;
  if (run.body) return { script: run.body.value };
  if (run.file) {
    const file = run.file.value.replace(/^\.\//, '');
    return shellFiles.has(file) && !moved
      ? {}
      : {
          problem: `${command.value} runs ${file}, a script this check does not read (only CI .sh files under infrastructure/ and scripts/ are, from a directory this script has not left)`,
        };
  }
  if (input.hereDocument && !input.pipe && !input.hereString) return {};
  if (input.hereString && !input.pipe && literal(input.hereString))
    return { script: input.hereString.value };
  return {
    problem: `${command.value} reads its commands from a pipe, a here-string or the terminal, which this check does not read`,
  };
}

const withoutDeclarers = (words) => words.filter(({ value }) => !DECLARERS.has(value));
/** An assignment-only command (`a=1`, `export a=$(x)`): it runs no program. */
const assignmentOnly = (words) => {
  const plain = withoutDeclarers(words);
  return plain.length > 0 && plain.every(({ value }) => ASSIGNMENT.test(value));
};
const OPENERS = new Set('if while until for select case { function coproc'.split(' '));
const CLOSERS = new Set('fi done esac }'.split(' '));
const LIST_STARTS = new Set(['', '\n', ';', '(']);
const NAME_WRITERS = new Set(
  'read readarray mapfile getopts let declare typeset local export readonly unset printf source .'.split(
    ' ',
  ),
);
const unsure = (word) => Boolean(word?.opaque) || /[$`]/.test(word?.value ?? '');
/**
 * Where a command's own word is, past assignments and the prefixes that run the next word
 * (`builtin printf`, `command read`, `time if`, `! {`) and their options (`command -p`).
 */
const HEAD_PREFIXES = new Set(['builtin', 'command', 'exec', 'time', '!']);
function headIndex(words) {
  let at = words.findIndex(({ value }) => !ASSIGNMENT.test(value));
  while (at >= 0 && HEAD_PREFIXES.has(words[at]?.value)) {
    at += 1;
    while (/^-/.test(words[at]?.value ?? '')) at += 1;
  }
  return at;
}

/** A command that can write a variable whose NAME this check cannot read. */
function dynamicWriter(all) {
  // FU-150 F2: the command word is found past control words (`then printf -v …`, `{ read …`),
  // prefixes and wrapper options by the shared execution boundary; unreadable ⇒ a possible write.
  const { chain, problem } = executionChain(all, { builtins: true });
  if (problem) return true;
  const at = chain.at(-1) ?? -1;
  if (at < 0 || at >= all.length) return false;
  const [command, ...rest] = all.slice(at);
  if (!NAME_WRITERS.has(command.value)) return false;
  if (command.value === 'source' || command.value === '.') return true;
  if (command.value === 'printf')
    return unsure(rest[0]) || (rest[0]?.value === '-v' && unsure(rest[1]));
  if (['declare', 'typeset', 'local', 'export', 'readonly', 'unset'].includes(command.value))
    return rest.some(
      (word) =>
        /^-[A-Za-z]*n/.test(word.value) ||
        /[$`]/.test(word.value.split('=')[0]) ||
        (word.opaque && !word.value.includes('=')),
    );
  return rest.some(unsure);
}

/** The script file of `[NAME=… ]bash|sh <file> …`, the only command an evaluated output may come from. */
function evaluatedFile(source) {
  let parsed;
  try {
    parsed = tokenizeShell(source);
  } catch {
    return undefined;
  }
  if (parsed.commands.length !== 1 || parsed.nested.length > 0) return undefined;
  const all = parsed.commands[0].words;
  const words = all.slice(all.findIndex(({ value }) => !ASSIGNMENT.test(value)));
  if (words.length < 2 || !/^(?:ba)?sh$/.test(words[0].value) || words[1].opaque) return undefined;
  return words[1].value.replace(/^\.\//, '');
}

/** `docker compose` starts what a compose file names: it must be one this check validates. */
function composeCommand(args, ctx, problem) {
  for (let index = 0; index < args.length; index += 1) {
    const { value } = args[index];
    let file;
    if (value === '-f' || value === '--file') file = args[index + 1]?.value;
    else if (value.startsWith('--file=')) file = value.slice('--file='.length);
    if (file === undefined) continue;
    if (!ctx.composeFiles.includes(file.replace(/^\.\//, ''))) {
      problem(`docker compose -f ${file}: a compose file this check does not validate`);
    }
  }
}

/** Every reference an image word may stand for, or none with a problem recorded. */
function resolveImage(word, { vars, env, restore, where, errors }) {
  if (word.opaque) {
    errors.push(
      `${where}: image ${word.value} is a command substitution this check cannot resolve`,
    );
    return [];
  }
  const value = restore(word.value);
  const expand = (text, depth) => {
    if (depth > 8) return { problem: `image ${value} expands too deeply` };
    if (text.includes('${{')) {
      const resolved = resolveExpressions(text, env, where, errors);
      return { refs: resolved };
    }
    const variable = text.match(/^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/);
    const withDefault = text.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*):?-([^}]*)\}$/);
    if (variable || withDefault) {
      const variableName = (variable ?? withDefault)[1];
      const candidates = [];
      if (vars.has(variableName)) {
        const local = vars.get(variableName);
        if (local === null) return { problem: `image ${value} is set from a command substitution` };
        candidates.push(local);
      } else if (env.has(variableName)) {
        candidates.push(...env.get(variableName));
      }
      if (withDefault) candidates.push(withDefault[2]);
      if (candidates.length === 0)
        return { problem: `image ${value} is a variable this check cannot resolve` };
      const refs = [];
      for (const candidate of candidates) {
        const inner = expand(candidate, depth + 1);
        if (inner.problem) return inner;
        refs.push(...inner.refs);
      }
      return { refs };
    }
    if (text.includes('$'))
      return { problem: `image ${value} has a variable part this check cannot resolve` };
    return { refs: [text] };
  };
  const { refs, problem } = expand(value, 0);
  if (problem) {
    errors.push(`${where}: ${problem}`);
    return [];
  }
  return refs;
}
