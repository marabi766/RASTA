import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { LineCounter, parseDocument } from 'yaml';
import {
  SHELL_WORD,
  continuedDollar,
  executionChain,
  outputRedirects,
  redirectWidth,
  shellInvocation,
  SYSTEM_PATH,
  WRAPPER_NAMES,
  unsplit,
  vector,
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
// An image or program word takes ONE small form (FU-224, READONLY_FORM below):
// a literal reference, `${{ env.NAME }}`, or "$NAME" as the whole word of a
// preamble `readonly NAME=<literal>`. Every other expansion, `eval`, `xargs`,
// `find`, non-top-level `source`, nameref or vector before the image is refused
// with its line and the fix; none is modelled and proved safe.
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
 * `functions` are the names a script that sources the library may call as shell functions: the
 * ones the library defines (or sources) unconditionally at its top level and never unsets.
 * To change a library: edit it, read it again, and paste the sha256 the error prints.
 */
const library = (sha256, reason, functions = []) => ({ sha256, reason, functions });
const PSQL = 'init-time psql library; starts no container';
export const SOURCED_LIBRARIES = new Map([
  [
    'infrastructure/docker/postgres/lib/disposable-marker.bash',
    library('f05bc76561ebe1bf28e56795497be0ab39a7d58e9f907c127ba01d41cb1f3895', PSQL, [
      'mark_disposable_database',
    ]),
  ],
  [
    'infrastructure/docker/postgres/lib/role-passwords.bash',
    library('465a53878d187075ce8f8900dee4d442749f2780cab16fd6595c38600db3aa3b', PSQL, [
      'privilege_split_grants_mode',
      'resolve_role_passwords',
    ]),
  ],
  [
    'infrastructure/docker/postgres/lib/rotate-role-passwords.bash',
    library('478bf3812e7bb485509a91bc0cd44ca8ffb58daf551260f10499c7a72c1c3bbf', PSQL),
  ],
  [
    'infrastructure/docker/postgres/lib/service-privilege-split.bash',
    library('d711b13ec42b4f44ef8a3c8d7a31b28c30514408d79f5c7f6ac8eafa8f9dafbb', PSQL, [
      'split_service_privileges',
      'split_audit_database_privileges',
    ]),
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
 * running that file starts no unpinned image. A word nothing uses any more is refused. A variable
 * in a word must be declared in the one form READONLY_FORM defines (FU-224): `readonly NAME=<literal>` in the
 * script's preamble, NAME ending in BIN. Bash refuses every later write to it, so nothing needs searching.
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
        'runs inside the pinned broker image; KAFKA_BIN is that image’s Apache Kafka bin directory, a `readonly` literal in the preamble (READONLY_FORM) so no later write can change it',
    },
  ],
  [
    'infrastructure/docker/kafka/broker-entrypoint.sh',
    {
      words: ['/opt/kafka/bin/kafka-storage.sh', '/etc/kafka/docker/run'],
      reason: 'the broker image’s own tools, run inside that pinned image',
    },
  ],
]);

/**
 * FU-159 r2 F1: programs a script runs that are neither in DATA_PROGRAMS nor modeled by this check.
 * Per script: the exact program names (no path), and why running them there starts no unpinned
 * image. This is a REVIEWED exception, not a proof: each of these can run an operand, a script text
 * or a file the shell check does not read. A name nothing uses any more is refused.
 */
const TOOLING =
  'the repository’s own Node/pnpm/Go tooling and tests (their sources are reviewed in their own PRs and ' +
  'start no image by a name this check could read); not a proof, a reviewed exception';
export const REVIEWED_PROGRAMS = new Map([
  [
    '.github/workflows/ci.yml',
    {
      programs: ['node', 'pnpm', 'go', 'psql', 'openssl'],
      paths: ['$RUNNER_TEMP/trivy-db-check-bin'], // the `go build -o` directory of the trivy-db job
      reason: `${TOOLING}; psql and openssl take SQL / key material from the job’s own services`,
    },
  ],
  [
    '.github/workflows/backup-drill-monthly.yml',
    {
      programs: ['node', 'pnpm'],
      writes: ['${dir}/stdout.json', '${dir}/stderr.log', '${dir}/exit-code'],
      reason: `${TOOLING}; the writes go into the step’s own \`mkdir -m 700\` directory under RUNNER_TEMP, where no file of this run lives`,
    },
  ],
  [
    'infrastructure/docker/kafka/ci-up.sh',
    {
      programs: ['node', 'openssl'],
      writes: ['${GITHUB_ENV}', '${directory}/${variable}', '${TLS_DIR}/broker.env'],
      reason:
        'node runs scripts/kafka-acl.mjs (Kafka ACLs over the wire); openssl x509 reads the generated CA; neither starts an image. The writes are the runner’s env file and one secret file per principal in the secrets directories, and the list of variable NAMES for `docker run --env-file` in the run’s own TLS directory, never a script',
    },
  ],
  [
    'infrastructure/docker/kafka/tls.sh',
    {
      programs: ['keytool', 'openssl'],
      reason: 'generate the development CA and broker keystores in the working directory; no image',
    },
  ],
  [
    'infrastructure/docker/kafka/create-topics.sh',
    {
      programs: ['awk', 'sed', 'sort'],
      writes: ['${admin_properties}'],
      reason:
        'literal text filters over `kafka-topics` output (awk / sed program is a quoted literal, sort has no --compress-program); run inside the pinned broker image. The write is its own mktemp file',
    },
  ],
  [
    'infrastructure/docker/kafka/topic-limits.sh',
    {
      programs: ['awk'],
      reason: 'one literal awk program over topic limits; run inside the pinned broker image',
    },
  ],
  [
    'infrastructure/docker/kafka/broker-entrypoint.sh',
    {
      programs: ['sed'],
      writes: ['${format}'],
      reason:
        'JAAS escaping: a literal `s///` script; runs inside the pinned broker image. The write is its own mktemp file',
    },
  ],
  [
    'scripts/ci-pull-image.sh',
    {
      programs: ['sed'],
      reason: 'a literal `s///` script over a reference printed by docker pull',
    },
  ],
  [
    'infrastructure/docker/postgres/00-init-databases.sh',
    {
      programs: ['psql'],
      reason: 'init-time SQL over the local socket of the already running postgres',
    },
  ],
  [
    'scripts/backup-restore-drill',
    {
      programs: ['node'],
      reason: 'runs its sibling scripts/backup-restore-drill.mjs, the drill implementation',
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
  // FU-159 r2 F2: where each definition stands: `index` is the command that holds the name (`name`
  // of `name() …`, or the whole `function name …` command); an unquoted keyword and name only.
  const definitions = [];
  const arithmetic = []; // FU-159 r3 F2: the text of every `((` command
  const arithmeticLines = []; // task 365: the line of each (a prefix of the script keeps the ones before it)
  const heredocHolders = []; // and the command that owns each expanding here-document body
  // FU-202 R2: every expansion site of a redirection, whoever owns it: ALL here-string words of a command
  // (`: <<<a <<<b` expands both) and the bodies of expanding here-documents, also of a command that has no
  // words of its own (`<<EOF` alone, `<<<"${v:=x}"` alone), which no command record holds.
  const hereStrings = [];
  const heredocBodies = [];
  const opened = new Map(); // group -> the word before its ( and how many commands came before
  let pending = '';
  let pendingUsed = false; // a command already took this separator as its own
  let cmdSep = '';
  // PR #805 r2 F2: the operator in front of a `( … )` group (`a &⏎( b )`: b is in a list `a` is part of).
  let lead = '';
  let cmdLead = '';
  // FU-077 r2 F2: where each command's standard input comes from, so a shell that reads its
  // commands from a pipe or a here-string is seen.
  let input = {};

  const ensureWord = () => {
    if (!word) word = { value: '', opaque: false, split: false, segments: [] };
    if (startLine === null) {
      startLine = line;
      cmdSep = pending;
      pendingUsed = true;
      cmdLead = pending === '(' ? lead : '';
    }
  };
  // FU-159 r3 F1: the word's PARTS as written: bare text, `\x`, '…', "…" (raw, between the quotes),
  // `$(…)` and `${…}`. `value` has the quotes removed and cannot tell `"$a""b"` from `"$ab"`.
  const segment = (kind, raw) => {
    const last = word.segments.at(-1);
    if (kind === 'bare' && last?.kind === 'bare') last.raw += raw;
    else word.segments.push({ kind, raw });
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
      hereStrings.push(word);
      hereStringWord = false;
    } else if (word) {
      if (words.length === 0 && keyword('case')) cases.push('subject');
      else if (words.length === 0 && keyword('esac')) cases.pop();
      else if (words.length === 1 && words[0].value === 'function' && !words[0].quoted) {
        functions.add(word.value);
        if (!word.quoted) definitions.push({ name: word.value, index: commands.length });
      }
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
    if (body.startsWith('(')) {
      nested.push(...substitutionsIn(body, line));
      word.arith = [...(word.arith ?? []), body]; // FU-159 F2: `$(( c = 5 ))` writes c
    } else nested.push({ script: body, line });
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
      segment('esc', src.slice(i, i + 2));
      i += 2;
      continue;
    }
    if (c === '\n') {
      endCommand();
      // `a &&<newline> b` still continues the list, and `a &<newline>` still backgrounded a.
      // a pipeline's last stage took its `|`: the next line starts a list of its own
      if (pendingUsed || !['&&', '||', '|', '|&', '&', '('].includes(pending)) pending = '\n';
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
        // the command that owns the here-document is where its body (and what it runs) belongs
        const holder = commands.findIndex((c) => c.words === owner);
        // FU-159 r3 F2 + FU-202 R2: an expanding body is an expansion site (`${v:=x}`, `$((n))`)
        if (expands) {
          heredocBodies.push(body.join('\n'));
          heredocHolders.push(holder);
        }
        if (feedsShell)
          nested.push({ script: body.join('\n'), line: bodyLine, shell: true, holder });
        // FU-077 r2 F2: an unquoted delimiter expands the body, running its substitutions;
        // FU-092: also when a shell then reads the expanded body (`bash <<EOF` with `$(…)`).
        if (expands)
          nested.push(
            ...substitutionsIn(body.join('\n'), bodyLine).map((found) => ({ ...found, holder })),
          );
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
    // an inner `esac` right before `;;` ends the inner case first: that `;;` belongs to the outer one
    if (c === ';' && cases.at(-1) === 'pattern' && words.length === 0 && keyword('esac'))
      pushWord();
    if (c === ';' && /^;;&?|^;&/.test(src.slice(i, i + 3)) && cases.at(-1) === 'body') {
      endCommand();
      const op = /^;;&?|^;&/.exec(src.slice(i, i + 3))[0];
      cases[cases.length - 1] = 'pattern';
      pending = op;
      pendingUsed = false;
      i += op.length;
      continue;
    }
    // `>&2`, `2>&1`, `<&3`: the `&` belongs to the redirection, it does not background anything
    // and `>|` is the clobbering redirection, not a pipe
    if (
      (c === '&' || c === '|') &&
      word &&
      !word.quoted &&
      (c === '&' ? /[<>]$/ : />$/).test(word.value) &&
      src[i + 1] !== c
    ) {
      word.value += c;
      i += 1;
      continue;
    }
    if (c === ';' || c === '&' || c === '|') {
      endCommand();
      const pipe = c === '|' && src[i + 1] !== '|';
      const length = src[i + 1] === c || (c === '|' && src[i + 1] === '&') ? 2 : 1;
      pending = src.slice(i, i + length);
      pendingUsed = false;
      i += length;
      if (pipe) input = { pipe: true };
      continue;
    }
    if (c === '(' || c === ')') {
      // PR #805 r2 F1: `name=( … )` is an array literal: its words are elements, not commands.
      const array = c === '(' && !pending.startsWith('(') && Boolean(word?.value.endsWith('='));
      // FU-159: `name ( )` with nothing inside defines a function (read from the tokens, never
      // from the raw text, where a string or a comment can imitate it).
      const nameWord = word
        ? words.length === 0
          ? word
          : null
        : words.length === 1
          ? words[0]
          : null;
      const named = nameWord ? nameWord.value : null;
      const plain = nameWord !== null && !nameWord.quoted && named !== 'function';
      // FU-159 r3 F2: `((` evaluates arithmetic (or is nested subshells): the text inside is kept
      if (c === '(' && src[i + 1] === '(') {
        const end = matchParen(src, i);
        arithmetic.push(end === -1 ? src.slice(i + 1) : src.slice(i + 1, end - 1));
        arithmeticLines.push(line);
      }
      endCommand();
      if (c === '(') {
        groups.push(group);
        parents[nextGroup] = group;
        if (array) arrays.add(nextGroup);
        if (!array && named !== null && pending !== '(')
          opened.set(nextGroup, { name: named, count: commands.length, plain });
        group = nextGroup++;
      } else {
        const open = opened.get(group);
        if (open && commands.length === open.count) {
          functions.add(open.name);
          if (open.plain) definitions.push({ name: open.name, index: open.count - 1 });
        }
        group = groups.pop() ?? 0;
      }
      if (c === '(' && pending !== '(') lead = pending;
      pending = c;
      pendingUsed = false;
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
      segment('sq', text);
      line += countLines(text);
      i = end + 1;
      continue;
    }
    if (c === '"') {
      ensureWord();
      word.quoted = true;
      i += 1;
      const quoteStart = i;
      let closed = false;
      while (i < src.length) {
        const d = src[i];
        noContinuedDollar();
        if (d === '"') {
          closed = true;
          segment('dq', src.slice(quoteStart, i));
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
      const from = i;
      substitution();
      segment('sub', src.slice(from, i));
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
      segment('brace', src.slice(i, j + 1));
      line += countLines(src.slice(i, j + 1));
      i = j + 1;
      continue;
    }
    ensureWord();
    if ('$*?['.includes(c)) word.split = true; // an unquoted expansion or pattern: unknown word count
    word.value += c;
    segment('bare', c);
    i += 1;
  }
  endCommand();
  if (cases.length > 0) throw new ShellSyntaxError('a case with no esac');
  if (heredocs.length > 0) throw new ShellSyntaxError('here-document is never closed');
  return {
    commands,
    nested,
    parents,
    arrays,
    functions,
    definitions,
    arithmetic,
    arithmeticLines,
    hereStrings,
    heredocBodies,
    heredocHolders,
  };
}

const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s;
const SHELL_NAMES = /^(?:bash|sh|pwsh|powershell|python|cmd)$/;
const GH_EXPRESSION = /\$\{\{\s*(.*?)\s*\}\}/g;
/** a value GitHub may paste into a script: the characters of a reference, nothing a shell reads */
const SAFE_PASTE = /^[A-Za-z0-9_@:./=+,-]*$/;

/** The image a `docker run|create|pull` names (its word), or a problem. */
function imageWord(args) {
  for (let index = 1; index < args.length; index += 1) {
    const { value } = args[index];
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
 * @param {{ digestVariants?: Map<string, { digests: string[], reason: string }>, tagless?: Map<string, string>, composeFiles?: string[], evaluatedOutputs?: Map<string, string>, complete?: boolean }} [policy]
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
    // FU-159 r2 F4: every variable of the word must be read-only by then (`readonly NAME=…`)
    allows: (file, word, readonly = new Set()) => {
      if (!executedPrograms.get(file)?.words.includes(word)) return false;
      if (
        [...word.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)/g)].some(([, name]) => !readonly.has(name))
      )
        return false;
      executedUsed.add(`${file} ${word}`);
      return true;
    },
  };
  // FU-159 r2 F1: a program outside every table runs only where a reviewed entry names it.
  const reviewedPrograms = policy.reviewedPrograms ?? REVIEWED_PROGRAMS;
  const reviewedUsed = new Set();
  const reviewed = {
    allows: (file, name) => {
      if (!reviewedPrograms.get(file)?.programs.includes(name)) return false;
      reviewedUsed.add(`${file} ${name}`);
      return true;
    },
    // a program a reviewed entry names (its text operands are what the reviewer read)
    has: (file, name) => Boolean(reviewedPrograms.get(file)?.programs.includes(name)),
    // a redirect / copy target this check cannot read, named by its exact word in a reviewed entry
    writes: (file, word) => {
      if (!reviewedPrograms.get(file)?.writes?.includes(word)) return false;
      reviewedUsed.add(`${file} WRITE ${word}`);
      return true;
    },
    // `echo <one listed path> >> "$GITHUB_PATH"`: the only way a reviewed entry changes PATH
    pathEntry: (file, words) => {
      const at = executionChain(words).chain.at(-1);
      const operands = [];
      for (let k = at + 1; k < words.length; k++) {
        const width = redirectWidth(words, k);
        if (width > 0) k += width - 1;
        else operands.push(words[k]);
      }
      const path = operands[0]?.value;
      if (words[at]?.value !== 'echo' || operands.length !== 1) return false;
      if (!reviewedPrograms.get(file)?.paths?.includes(path)) return false;
      reviewedUsed.add(`${file} PATH ${path}`);
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
    reviewed,
    shellFiles,
    sourced,
    // FU-159 F3: false only for a file whose own text, and that of every file it sources, never changes directory
    sourceMoves: (path) => !texts.has(path) || fileScope(path, shared).moves,
    texts: undefined,
    libraries,
    verified,
    memo: new Map(),
  };
  const texts = new Map(
    files.filter(({ kind }) => kind === 'shell' || kind === 'library').map((f) => [f.name, f.text]),
  );
  shared.texts = texts;
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
  for (const [file, { writes = [], reason }] of reviewedPrograms)
    for (const word of writes)
      if (
        files.some((f) => f.name === file) &&
        (!reason || !reviewedUsed.has(`${file} WRITE ${word}`))
      )
        errors.push(
          `REVIEWED_PROGRAMS lists the write ${word} in ${file}, which nothing writes any more`,
        );
  for (const [file, { paths = [], reason }] of reviewedPrograms)
    for (const path of paths)
      if (
        files.some((f) => f.name === file) &&
        (!reason || !reviewedUsed.has(`${file} PATH ${path}`))
      )
        errors.push(
          `REVIEWED_PROGRAMS lists the PATH entry ${path} in ${file}, which nothing adds any more`,
        );
  for (const [file, { programs, reason }] of reviewedPrograms)
    for (const name of programs)
      if (files.some((f) => f.name === file) && (!reason || !reviewedUsed.has(`${file} ${name}`)))
        errors.push(`REVIEWED_PROGRAMS lists ${name} in ${file}, which nothing runs any more`);
  for (const [file, { words, reason }] of executedPrograms)
    for (const word of words)
      if (
        files.some(({ name }) => name === file) &&
        (!reason || !executedUsed.has(`${file} ${word}`))
      )
        errors.push(`EXECUTED_PROGRAMS lists ${word} in ${file}, which nothing runs any more`);
  // Task 367 (FU-200 F1): the CLI reads every file, so a listed file it did not find is a deleted or renamed
  // one whose exception would otherwise be skipped in silence
  if (policy.complete) {
    const present = new Set(files.map(({ name }) => name));
    for (const [table, names] of [
      ['REVIEWED_PROGRAMS', reviewedPrograms.keys()],
      ['EXECUTED_PROGRAMS', executedPrograms.keys()],
      ['EVALUATED_OUTPUTS', evaluated.allowed.keys()],
      ['SOURCED_LIBRARIES', libraries.keys()],
    ])
      for (const name of names)
        if (!present.has(name))
          errors.push(`${table} lists ${name}, which was not found among the files read`);
  }
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
  // Task 367 (review): `shell:` is a command template GitHub runs with the script path; only the named shells
  const checkShell = (value, path) => {
    if (value !== undefined && !SHELL_NAMES.test(String(value)))
      errors.push(
        `${name}:${lineAt(doc.getIn(path, true))}: shell: ${value} is a command template this check does not read; use bash or sh`,
      );
  };
  checkShell(js.defaults?.run?.shell, ['defaults', 'run', 'shell']);
  const jobs = isObject(js.jobs) ? js.jobs : {};
  for (const [jobId, job] of Object.entries(jobs)) {
    if (!isObject(job)) continue;
    addEnv(job.env, ['jobs', jobId, 'env']);
    checkShell(job.defaults?.run?.shell, ['jobs', jobId, 'defaults', 'run', 'shell']);
    (Array.isArray(job.steps) ? job.steps : []).forEach((step, index) => {
      if (!isObject(step)) return;
      addEnv(step.env, ['jobs', jobId, 'steps', index, 'env']);
      checkShell(step.shell, ['jobs', jobId, 'steps', index, 'shell']);
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
  const expressions = ctx.nested ? (ctx.expressions ?? []) : [];
  // Task 367 (review): the placeholder is a name of this check's own; text that spells it would be read back
  // as an expression GitHub pasted. A nested script carries the placeholders of the step it came from.
  if (!ctx.nested && script.includes('__GHEXPR'))
    errors.push(
      `${ctx.file}:${ctx.lineOf(0)}: the text __GHEXPR is reserved by this check for \${{ }} expressions; rename it`,
    );
  const src = script.replace(GH_EXPRESSION, (match, inner, offset) => {
    // Task 367 B3 (FU-200 F1): the value is shell TEXT, pasted before the shell parses; it is read only when it
    // is an env value with no shell syntax in it (a pinned reference), anything else is refused
    const name = /^env\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(inner)?.[1];
    const values = name === undefined ? undefined : ctx.env.get(name);
    if (!values || [...values].some((v) => !SAFE_PASTE.test(v)))
      errors.push(
        `${ctx.file}:${ctx.lineOf(script.slice(0, offset).split('\n').length - 1)}: ${match} is pasted into the script before the shell parses it, so its value can add shell syntax; use \${{ env.NAME }} of an env value that is a plain pinned reference, or pass it through the step's env: and read "$NAME"`,
      );
    expressions.push(match);
    // FU-159 r2 F1: GitHub pastes the value in before the shell parses: it is text of unknown words
    // and may name a program, so it is read as an expansion (`$NAME`), never as a literal word.
    return `$__GHEXPR${expressions.length - 1}__`;
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
  const layout = layoutOf(parsed.commands);
  const { nesting } = layout;
  const inGroup = (group, ancestor) => groupWithin(parsed, group, ancestor);
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
  // FU-159 r2 F2: the names that are certainly shell functions where each command runs
  const imports = topLevelSources(
    parsed,
    layout,
    ctx.self ?? '',
    (path, index) => ctx.self !== undefined && (ctx.sourced?.has(path) ?? false) && !movedAt(index),
  ).map(({ index, path }) => ({
    index,
    names: fileScope(path, ctx).exported,
    unsets: fileScope(path, ctx).unsets,
  }));
  const table = functionTable(parsed, layout, imports, ctx.functions ?? new Set());
  const callableAt = (position) => table.callable(position);
  // FU-092: an evaluated variable's provenance cannot be proved inside a compound command or function
  // body (`if`, loops, `{ }`: it may not run), or where this shell could write a variable under a name
  // this check cannot read. FU-159 F2 + r3 F2: the writes are the CANONICAL words of every command, the
  // text of every expansion site (here-strings, expanding here-documents), the text of `eval` and `trap`
  // run in this shell, the implicit targets of read, select, mapfile and getopts, and any arithmetic that
  // is not provably constant; no raw-source counting.
  const writes = shellWrites(parsed);
  // FU-159 r3 F3: the interpreter of a producer is external only where no function or alias can be
  // called by that name: a definition anywhere in this shell (or one it was reached from) refuses.
  // FU-202 R2: `test -v "$n"` evaluates n as an arithmetic subscript (`other[$(cmd)]` runs cmd)
  if (writes.computedTest)
    errors.push(
      `${ctx.file}:${ctx.lineOf(0)}: test -v / -R (or [[ -v ]]) names a variable by computed text, which bash evaluates as an arithmetic subscript that can run a command`,
    );
  const maybe = new Set([...(ctx.maybe ?? []), ...writes.functions]);
  const aliasing = Boolean(ctx.aliasing) || writes.aliasing;
  const shadowed = (name) => aliasing || maybe.has(name);
  // Task 367 (FU-224): the variables an image or program word may name: the preamble's `readonly NAME=<literal>`
  // declarations (READONLY_FORM), plus those of the shell this one runs in. One value, fixed before anything else ran.
  const literals = new Map([
    ...(ctx.readonly ?? []),
    ...preambleLiterals(parsed, layout, shadowed),
  ]);
  /** what `at` says about every command that holds `line`: only what ALL of them agree on */
  const agreeAtLine = (line, at) => {
    const holders = parsed.commands.flatMap((c, k) =>
      c.startLine <= line && line <= c.endLine ? [k] : [],
    );
    const sets = holders.map(at);
    return new Set([...(sets[0] ?? [])].filter((name) => sets.every((set) => set.has(name))));
  };
  const callableAtLine = (line) => agreeAtLine(line, callableAt);
  const movedAtLine = (line) => {
    const holders = parsed.commands.flatMap((c, k) =>
      c.startLine <= line && line <= c.endLine ? [k] : [],
    );
    return holders.length > 0 ? holders.some((k) => movedAt(k)) : moved;
  };
  const outputs = new Map(); // variable -> the one command substitution it was assigned from
  const restore = (value) => value.replace(/\$__GHEXPR(\d+)__/g, (_, n) => expressions[Number(n)]);
  // How many assignment-only commands of this script assign a variable one `$(…)`; the variables
  // whose every such assignment is the output of an EVALUATED_OUTPUTS script.
  const assignedFrom = new Map();
  const fromAllowed = new Map();
  for (const { words } of parsed.commands) {
    for (const { value, scripts } of assignmentsOf(words, shadowed) ?? []) {
      const [, variable, assigned] = value.match(ASSIGNMENT);
      if (assigned === '$(…)' && scripts?.length === 1) {
        assignedFrom.set(variable, (assignedFrom.get(variable) ?? 0) + 1);
        const file = evaluatedFile(scripts[0]);
        fromAllowed.set(
          variable,
          (fromAllowed.get(variable) ?? true) &&
            file !== undefined &&
            ctx.evaluated.allowed.has(file),
        );
      }
    }
  }

  // FU-092: an evaluated variable's provenance is proved or the eval refuses (see `writes`, above).
  const provenanceBroken =
    writes.unresolved || writes.evals.some((words) => !trackedEval(words, fromAllowed));
  const mentions = (name) =>
    (
      writes.texts
        .join('\n')
        .match(
          new RegExp(
            `(?<![\\w$]|\\$\\{)${name}(?![\\w])|(?<=(?:^|[\\s;&|(])-[A-Za-z]*)${name}(?![\\w])|\\$\\{${name}:?=`,
            'g',
          ),
        ) ?? []
    ).length;
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
      if (at.sep !== '&&' || !assignmentOnly(parsed.commands[k - 1]?.words ?? [], shadowed))
        return false;
    }
    return false;
  };

  // the `name` of a `name() …` definition is the definition, not a call of it
  const definitionNames = new Set(
    parsed.definitions
      .filter(({ index }) => parsed.commands[index].words[0].value !== 'function')
      .map(({ index }) => index),
  );
  const unknownWrites = []; // writes whose target this check cannot read
  for (const [position, command] of parsed.commands.entries()) {
    if (definitionNames.has(position)) continue;
    const where = `${ctx.file}:${ctx.lineOf(command.startLine)}`;
    let words = command.words;
    // PR #805 r2 F1: a variable a shell evaluates at startup is text this check does not read.
    if (words.some(({ value }) => STARTUP_TEXT.test(value)))
      errors.push(`${where}: sets a variable a shell evaluates at startup (BASH_ENV, ENV ...)`);
    // FU-159 r2 F1: text that is a command substitution once an ARITHMETIC evaluator reads it
    // (`let 'x[$(cmd)]=1'`, `declare -i`, `[[ $x -eq 1 ]]` with such a value, `$((x))`): in data it is
    // refused, wherever it stands but in the text this check reads as a script (eval, trap, a shell's
    // -c body, a docker container command).
    if (!readsText(words, ctx) && words.some((w) => !w.opaque && /\$\(|`/.test(w.value)))
      errors.push(
        `${where}: a word holds the text $( or a backtick inside quotes; an arithmetic evaluation (let, [[ ]], (( )), declare -i) would run it as a command substitution`,
      );
    // FU-159 r2 F4: PATH decides which file every command name is; a command found there is not the
    // program this check read the name of. `hash` is handled with the other stages (wordStage).
    if (words.some(({ value }) => LOOKUP_TEXT.test(value)))
      errors.push(`${where}: names PATH or CDPATH, which decide which file a command word runs`);
    for (const target of outputRedirects(words))
      if (/GITHUB_PATH/.test(target.value) && !ctx.reviewed.pathEntry(ctx.file, words))
        errors.push(
          `${where}: appends to GITHUB_PATH, which changes the program every later step finds (REVIEWED_PROGRAMS paths)`,
        );
    // FU-159 r2 F4: a write that can replace a file this run sources or executes
    const written = writeTargets(words);
    for (const target of written) {
      // an absolute path outside the scratch directories may be the checkout under another spelling
      if (unreadArgument(target) || ABSOLUTE_ELSEWHERE.test(posix.normalize(target.value))) {
        if (!ctx.reviewed.writes(ctx.file, target.value))
          unknownWrites.push(`${where} (${target.value})`);
      } else if (ctx.sourced?.has(posix.normalize(target.value)))
        errors.push(
          `${where}: writes ${posix.normalize(target.value)}, a file this run sources or executes (its contents are the ones this check read)`,
        );
      // task 367 (FU-200 F4): a directory destination (`cp x scripts/`, `mv x .`) writes INTO it
      else if (
        [...(ctx.sourced ?? [])].some((file) => {
          const dir = posix.normalize(target.value).replace(/\/$/, '');
          return file.startsWith(dir === '.' ? '' : `${dir}/`);
        })
      )
        errors.push(
          `${where}: writes into ${target.value}, a directory holding a file this run sources or executes (name a file that is not one)`,
        );
    }
    // FU-202 R1: a command of assignments ALONE, in the one genuine form (assignmentsOf): a value `$(…)` is tracked for `eval`.
    const alone = assignmentsOf(words, shadowed);
    if (alone) {
      for (const { value, scripts } of alone) {
        const [, variable, assigned] = value.match(ASSIGNMENT);
        if (assigned === '$(…)' && scripts?.length === 1) {
          outputs.set(variable, { script: scripts[0], position });
        } else outputs.delete(variable);
      }
      continue;
    }
    let index = 0;
    while (index < words.length && isAssignment(words[index])) index += 1;
    words = words.slice(index);
    if (words.length === 0) continue;
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
            callable: callableAt(position),
            readonly: literals,
            executed: ctx.executed,
            reviewed: ctx.reviewed,
            file: ctx.file,
          });
    if (staged.problem) problem(staged.problem);
    // Task 367 B1 (FU-200 F2): a `source` grants functions, and removes them, only as a top-level import that
    // always runs. Anywhere else (a branch, loop, function, group, background, pipeline, a workflow step) a
    // file that defines or unsets a function has effects this check does not order: refused
    const operand = staged.problem ? undefined : sourceOperand(command.words);
    if (operand !== undefined && !imports.some((entry) => entry.index === position)) {
      const target = operand && sourcedPath(operand, ctx.self);
      const scope = target !== undefined && ctx.texts.has(target) ? fileScope(target, ctx) : null;
      if (!scope || scope.exported.size > 0 || scope.unsets.all || scope.unsets.names.size > 0)
        problem(
          'source of a file that defines or unsets functions is not an unconditional top-level command of this script (not in an if, loop, function, group, background or pipeline); move it to the top level on its own line',
        );
    }
    for (const script of staged.scripts ?? [])
      shellImages(
        script,
        {
          ...ctx,
          moved: movedAt(position, true),
          functions: sameShell(command.words) ? callableAt(position) : new Set(),
          readonly: sameShell(command.words) ? literals : new Map(),
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
              mentions(name) === assignedFrom.get(name) &&
              inGroup(command.group, parsed.commands[from.position].group) &&
              unconditional(from.position, position),
          )
          .map(([name, from]) => [name, from.script]),
      );
      const read = shellInput(words.slice(shellAt), command.input, tracked, {
        ...ctx,
        moved: movedAt(position) || executionChain(command.words).moves,
        shadowed,
      });
      if (read.problem) problem(read.problem);
      else if (read.script !== undefined)
        shellImages(
          read.script,
          {
            ...ctx,
            moved: movedAt(position),
            functions: sameShell(command.words) ? callableAt(position) : new Set(),
            readonly: sameShell(command.words) ? literals : new Map(),
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
      // Task 365 F4 + task 367 R4: every word in front of the image is ONE word; an unquoted expansion or a
      // quoted vector (`"$@"`, `"${a[@]}"`) can move which argument is the image
      const lead = args.slice(0, args.indexOf(found.word)).find(splits);
      if (lead) {
        problem(
          `docker ${verb} has the expansion ${lead.value} before its image, which can become several arguments; write one word per argument`,
        );
        continue;
      }
      if (state.localTags.has(found.word.value)) continue;
      for (const ref of resolveImage(found.word, {
        literals,
        env: ctx.env,
        restore,
        where,
        errors,
      })) {
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
  // FU-159 r2 F4: a write to a path this check cannot read may replace a file the same script runs
  if (unknownWrites.length > 0 && runsFile(parsed.commands))
    for (const where of unknownWrites)
      errors.push(
        `${where}: writes to a path this check cannot read in a script that also sources or runs a file (the write may replace that file; REVIEWED_PROGRAMS writes)`,
      );
  for (const { script: inner, line, shell, holder } of parsed.nested) {
    const at = holder !== undefined && holder >= 0 ? holder : undefined;
    shellImages(
      inner,
      {
        ...ctx,
        nested: true,
        expressions,
        maybe,
        aliasing,
        // the directory at the commands that hold it (a substitution has no position of its own)
        moved: at === undefined ? movedAtLine(line) : movedAt(at),
        functions: shell ? new Set() : at === undefined ? callableAtLine(line) : callableAt(at),
        readonly: shell ? new Map() : literals,
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
const ABSOLUTE_ELSEWHERE = /^\/(?!(?:dev|tmp|proc\/self)(?:\/|$))/;
const LOOKUP_TEXT = /^(?:PATH|CDPATH)(?:\+?=.*)?$/;
const STARTUP_TEXT = /^(?:BASH_ENV|ENV|PROMPT_COMMAND|PS0|PS1|PS4|SHELLOPTS|BASHOPTS)(?:\+?=.*)?$/;
/**
 * Names that take text wherever they stand in a command (not `source` and `.`: those are arguments too).
 * FU-159 r2 F1: `su`, `ssh`, `watch`, `parallel`, `script`, `at`, `sg`, `runuser` ... run a string or an
 * argv this check does not rebuild: they are in no table, so they refuse like any unknown program.
 */
const TAKES_TEXT = new Set('alias trap env'.split(' '));
/** Programs that substitute into the command they run (`xargs -I{}`, `find -exec … {}`). */
const REWRITERS = new Set(['xargs', 'find']);
const computedWord = (word) => Boolean(word.opaque || word.value.includes('$'));
/**
 * PR #805 r2 F1: what the stages between a command line and the commands it runs do. A stage
 * that rewrites, generates or hands over text is read (`{ scripts }`) or refused (`{ problem }`);
 * none is "nothing relevant".
 */
function textStage(words, input, env) {
  // FU-150 F1: the shared execution boundary names the words that run the next one (control
  // words, wrappers with their options, xargs operands) and refuses a computed program.
  const { chain: list, problem, moves, inputs, bypass } = executionChain(words);
  if (problem) return { problem };
  if (list.length === 0) return {};
  // FU-159 F3: `env -C dir`, `sudo -D dir` and `chroot` run what follows from another directory.
  const here = { ...env, moved: env.moved || moves };
  // Task 367 B2/B3 (FU-200): xargs and find build command lines from input or expressions; none is read
  for (const index of list) {
    const generator = words[index].value.split('/').at(-1);
    if (REWRITERS.has(generator))
      return {
        problem: `${generator} builds command lines this check does not read; use a literal command or a for loop over an explicit list`,
      };
  }
  const final = list.at(-1);
  const unproven = programProblem(words[final], inputs, bypass, here);
  if (unproven) return { problem: unproven };
  const chain = new Set(list);
  const scripts = [];
  for (const [index, word] of words.entries()) {
    const name = word.value.split('/').at(-1);
    if (index < list[0] || !(chain.has(index) || TAKES_TEXT.has(name))) continue;
    const stage = wordStage(name, words.slice(index + 1), input, here);
    if (stage.problem) return stage;
    scripts.push(...(stage.scripts ?? []));
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
    'export local declare typeset readonly getopts mapfile readarray wait umask ulimit true false ' +
    'type hash for in do done while until if then else elif fi case esac select function { } ! ( ) ' +
    'eval source . trap alias docker docker-compose exec command builtin'
  ).split(' '),
);
/**
 * FU-159 r2 F1: the ONE table of installed programs PROVEN to run none of their operands or files as a
 * command. Anything not here, not a builtin, not a modeled dispatcher (`WRAPPERS`, the string runners,
 * the shells, `xargs` / `find`), not a function of the script and not a reviewed per-script entry
 * (`REVIEWED_PROGRAMS`) is refused: an unknown program is not assumed harmless because its
 * arguments look like text. One row per reason; add a program here only after reading what it does
 * with every option (GNU `sort --compress-program`, `tar --to-command`, `sed e`, `awk system()`,
 * `find -exec`, `make`, `git` hooks and the interpreters are NOT here).
 */
const DATA_PROGRAMS = new Set(
  Object.values({
    'file and directory utilities: operands are paths, modes or owners, read or written, never run':
      'cat cp mv rm mkdir mktemp chmod chown ls ln touch tee',
    'filters and printers: operands are patterns, field lists or counts':
      'grep head tail wc cut tr uniq',
    'path, number, time and delay printers: no operand is a command':
      'dirname basename pwd seq date sleep',
    'HTTP client: an operand is a URL, an option a header, a path or a request; curl has no way to run a program':
      'curl',
  }).flatMap((names) => names.split(' ')),
);
/** An argument whose value this check cannot read: an expansion, a pattern, a substitution. */
const unreadArgument = (word) => unsplit(word) || word.value.includes('$');
/** A path to a file (not a bare program name, not an installed program by absolute path). */
const filePath = (value) => value.includes('/') && !SYSTEM_PATH.test(value);

/**
 * FU-159 r2 F1: DEFAULT DENY. The program that finally runs (the end of the execution chain) is
 * allowed only if it is (a) a builtin or a word of the grammar, (b) in DATA_PROGRAMS, (c) a modeled
 * dispatcher whose operands this check reads (a shell, a string runner, `xargs`, `find`, a wrapper
 * with nothing left to run), (d) a shell function that is certainly one here and not called through
 * a wrapper, or a path, (e) listed for this script in REVIEWED_PROGRAMS. A path runs a FILE: it passes
 * only as a CI script of this run by its exact path, or an EXECUTED_PROGRAMS entry.
 */
function programProblem(program, inputs, bypass, env) {
  const { value } = program;
  if (filePath(value)) {
    const fixed = env.executed.allows(env.file, value, env.readonly);
    const path = posix.normalize(value);
    if (fixed || (!unreadArgument(program) && !env.moved && env.shellFiles.has(path))) return null;
    return `runs ${value}, a file this check does not read (a CI .sh file by its exact path, from a directory this script has not left, or an EXECUTED_PROGRAMS entry)`;
  }
  const name = value.split('/').at(-1);
  if (BUILTINS.has(name) || DATA_PROGRAMS.has(name) || SHELL_WORD.test(name)) return null;
  // a wrapper that is the last word has nothing to run, unless xargs hands it its operands
  if (WRAPPER_NAMES.has(name) && !inputs) return null;
  if (value === name && !bypass && env.callable.has(name)) return null;
  if (env.reviewed.allows(env.file, name)) return null;
  return `runs ${name}, a program this check does not model and has not proven to run no operand as a command (DATA_PROGRAMS, or a reviewed REVIEWED_PROGRAMS entry for this script)`;
}

/**
 * FU-159 r2 F2: `{ nesting, outer }` per command. `outer` is how many compound commands (`if`, a
 * `{ }` group, a function body, a loop) hold it; `nesting` is the same, plus one for a command that
 * stands in the SAME command as the opener (`{ source x`, `if f`): it is inside, not at the level.
 */
function layoutOf(commands) {
  let open = 0;
  const nesting = [];
  const outer = [];
  for (const { words } of commands) {
    const head = headIndex(words);
    const first = words[head]?.value;
    if (CLOSERS.has(first)) open = Math.max(0, open - 1);
    outer.push(open);
    let here = open;
    if (OPENERS.has(first)) {
      open += 1;
      const final = executionChain(words).chain.at(-1);
      if (final > head && !OPENERS.has(words[final]?.value)) here = open;
    }
    nesting.push(here);
  }
  return { nesting, outer };
}

/** `group` is `ancestor` or a subshell opened inside it: it inherits the variables set there. */
function groupWithin(parsed, group, ancestor) {
  for (let g = group; g >= 0; g = parsed.parents[g]) if (g === ancestor) return true;
  return false;
}

/** The names `unset` removes in these commands (also in literal `eval` / `trap` text), or `all`. */
function unsetTargets(commands, depth = 0, out = { names: new Set(), all: false }) {
  for (const { words, pattern } of commands) {
    if (pattern) continue;
    const { chain } = executionChain(words);
    const at = chain.at(-1);
    const rest = words.slice(at + 1);
    const program = words[at]?.value;
    const text = (script) => {
      let inner = null;
      try {
        inner = depth < 4 ? tokenizeShell(script) : null;
      } catch {
        // unreadable text: it could unset anything
      }
      if (inner) unsetTargets(inner.commands, depth + 1, out);
      else out.all = true;
    };
    if (program === 'unset') {
      for (const word of rest) {
        if (computedWord(word) || /[*?[{]/.test(word.value)) out.all = true;
        else if (!word.value.startsWith('-')) out.names.add(word.value);
      }
    } else if (program === 'eval') {
      if (rest.some(computedWord)) out.all = true;
      else text(rest.map(({ value }) => value).join(' '));
    } else if (program === 'trap') {
      const handler = rest.find(({ value }) => !value.startsWith('-') || value === '-');
      if (handler && handler.value !== '-' && handler.value !== '') {
        if (computedWord(handler)) out.all = true;
        else text(handler.value);
      }
    }
  }
  return out;
}

const nameOfWord = (word) => word.value.split('/').at(-1);

/** A command whose text operands this check reads as scripts, or runs inside a container. */
function readsText(words, ctx) {
  const { chain } = executionChain(words);
  const name = words[chain.at(-1)]?.value ?? '';
  return (
    SHELL_WORD.test(name) ||
    ctx.reviewed.has(ctx.file, name) ||
    ['eval', 'trap', 'docker', 'docker-compose'].includes(name) ||
    words.some((w) => /(?:^|\/)docker(?:-compose)?$/.test(w.value))
  );
}

/** The words a command line writes to: redirections, and what `cp` / `mv` / `ln` / `tee` / `touch` / `curl -o` name. */
function writeTargets(words) {
  const targets = outputRedirects(words);
  const { chain } = executionChain(words);
  const at = chain.at(-1);
  const name = (words[at]?.value ?? '').split('/').at(-1);
  const operands = [];
  for (let k = at + 1; k < words.length; k++) {
    const width = redirectWidth(words, k);
    if (width > 0) k += width - 1;
    else operands.push(words[k]);
  }
  // `time -o FILE` (also `--output`) writes its report to a file
  for (const index of chain) {
    if (nameOfWord(words[index]) !== 'time') continue;
    for (let k = index + 1; k < words.length && !chain.includes(k); k++) {
      const attached = /^(?:-[A-Za-z]*o|--output=)(.+)$/.exec(words[k].value);
      if (attached && !words[k].value.startsWith('--output=')) targets.push({ value: attached[1] });
      else if (attached) targets.push({ value: attached[1] });
      else if (/^(?:-[A-Za-z]*o|--output)$/.test(words[k].value))
        targets.push(words[k + 1] ?? { value: '$unknown', opaque: true });
    }
  }
  if (['cp', 'mv', 'ln', 'tee', 'touch'].includes(name))
    targets.push(...operands.filter(({ value }) => !value.startsWith('-')));
  // `uniq IN OUT` writes its second operand
  if (name === 'uniq')
    targets.push(...operands.filter(({ value }) => !value.startsWith('-')).slice(1));
  // `cp --target-directory=DIR`, `cp -tDIR` (attached; `-t DIR` leaves DIR as an operand above)
  if (['cp', 'mv', 'ln'].includes(name))
    for (const { value } of operands) {
      const attached = /^--target-directory=(.+)$|^-[A-Za-z]*t(.+)$/.exec(value);
      if (attached) targets.push({ value: attached[1] ?? attached[2] });
    }
  if (name === 'curl')
    for (const [k, { value }] of operands.entries()) {
      const unknown = { value: '$unknown', opaque: true };
      // a configuration file, a libcurl dump and `-O`/`-J` name files this check cannot read
      if (
        /^-[A-Za-z]*[OJK]|^--(?:remote-name|remote-header-name|config|libcurl|next|output-dir|etag-save|hsts|alt-svc|ssl-sessions)|%output\{/.test(
          value,
        )
      )
        targets.push(unknown);
      const long = /^--(?:output|dump-header|cookie-jar|trace|trace-ascii|stderr)(?:=(.*))?$/.exec(
        value,
      );
      // `-oFILE`, `-sSoFILE` (attached) and `-o FILE` (next word): the value starts at the first o, D or c
      const short = value.startsWith('--') ? null : /^-[A-Za-z]*?[oDc](.*)$/.exec(value);
      if (long)
        targets.push(long[1] === undefined ? (operands[k + 1] ?? unknown) : { value: long[1] });
      else if (short)
        targets.push(short[1] === '' ? (operands[k + 1] ?? unknown) : { value: short[1] });
    }
  return targets;
}

/** True when the script sources a file, runs a path, or hands a script file to a shell. */
function runsFile(commands) {
  return commands.some(({ words, pattern }) => {
    if (pattern) return false;
    const { chain, problem } = executionChain(words);
    const word = words[chain.at(-1)];
    if (problem || !word) return false;
    if (word.value === 'source' || word.value === '.' || filePath(word.value)) return true;
    return (
      SHELL_WORD.test(word.value) &&
      shellInvocation(words.slice(chain.at(-1) + 1), word.value).file !== undefined
    );
  });
}

/** `eval` and `trap` run their text in THIS shell, so its functions are there; nothing else does. */
/** the path word of a `source` / `.` command (null when it has none), or undefined for any other command */
const sourceOperand = (words) => {
  const { chain, problem, bypass } = executionChain(words);
  const at = chain.at(-1);
  return !problem && !bypass && ['source', '.'].includes(words[at]?.value)
    ? (words[at + 1] ?? null)
    : undefined;
};
const sameShell = (words) => {
  const { chain, bypass } = executionChain(words);
  return !bypass && ['eval', 'trap'].includes(words[chain.at(-1)]?.value);
};

/** The name a command calls when no wrapper stands in front of it (so a shell function can answer). */
function calledName(words) {
  const { chain, problem, bypass } = executionChain(words);
  const word = words[chain.at(-1)];
  return problem || bypass || !word || computedWord(word) || word.value.includes('/')
    ? null
    : word.value;
}

/**
 * FU-159 r2 F2: which command names are CERTAINLY shell functions where a command runs. A name is a
 * function there only if (1) it is defined exactly once in the shell, by an unquoted `name() …` or
 * `function name …` at the file's top level that always runs (not in a branch, loop, list or
 * background), or by a library or script this shell sources the same way; (2) that definition (or
 * source) comes BEFORE the command - a call inside a function body counts from the first time that
 * function runs; (3) nothing in the shell or its sources unsets it. The caller also requires that no
 * wrapper (`command`, `env`, a path) stands in front of the call.
 * `imports` are the unconditional top-level `source`s: `{ index, names, unsets }`.
 */
function functionTable(parsed, layout, imports, inherited = new Set()) {
  const { commands, definitions } = parsed;
  const { nesting, outer } = layout;
  const total = new Map();
  for (const name of [
    ...definitions.map((d) => d.name),
    ...imports.flatMap((i) => [...i.names]),
    ...inherited,
  ])
    total.set(name, (total.get(name) ?? 0) + 1);
  const unsets = unsetTargets(commands);
  for (const imported of imports) {
    for (const name of imported.unsets.names) unsets.names.add(name);
    unsets.all ||= imported.unsets.all;
  }
  const owner = new Array(commands.length).fill(-1); // the definition whose body holds the command
  const closes = [];
  for (const [di, { index: d }] of definitions.entries()) {
    const form = commands[d].words[0]?.value === 'function';
    const open = form ? d : d + 1;
    let end = open + 1;
    const group = commands[open]?.group;
    const subshell = !form && commands[open]?.sep === '(' && group !== commands[d].group;
    if (subshell)
      while (end < commands.length && groupWithin(parsed, commands[end].group, group)) end++;
    else while (end < commands.length && outer[end] > outer[d]) end++;
    for (let k = open; k < end; k++)
      if (k > open || subshell || nesting[k] > outer[k]) owner[k] = di;
    closes[di] = subshell ? end : end + 1; // the command after the whole definition
  }
  const valid = new Map(); // name -> the command that defines it
  for (const [di, { name, index: d }] of definitions.entries()) {
    const c = commands[d];
    if (
      total.get(name) === 1 &&
      outer[d] === 0 &&
      c.group === 0 &&
      LIST_STARTS.has(c.sep) &&
      !['&', '|', '|&'].includes(commands[closes[di]]?.sep) &&
      !unsets.all &&
      !unsets.names.has(name)
    )
      valid.set(name, d);
  }
  const run = new Map(); // function name -> the first time (a command index) it can run
  const timeOf = (k) =>
    owner[k] < 0 ? k : (run.get(definitions[owner[k]].name) ?? definitions[owner[k]].index);
  const named = new Set(definitions.map((d) => d.index)); // the `name` of `name() …` is no call
  const calls = commands.map(({ words, pattern }, k) =>
    pattern || (named.has(k) && words[0].value !== 'function') ? null : calledName(words),
  );
  for (let again = true, guard = 0; again && guard < 64; guard++) {
    again = false;
    for (const [k, name] of calls.entries()) {
      if (name === null) continue;
      const time = timeOf(k);
      if (time < (run.get(name) ?? Infinity)) {
        run.set(name, time);
        again = true;
      }
    }
  }
  const certain = (name) => total.get(name) === 1 && !unsets.all && !unsets.names.has(name);
  return {
    unsets,
    timeOf,
    /** the command at `k` is inside a function body */
    owned: (k) => owner[k] >= 0,
    /** the names callable by the command at `position` (a command index) */
    callable(position) {
      const time = timeOf(position);
      const names = new Set();
      for (const [name, d] of valid) if (d < time) names.add(name);
      for (const { index, names: from } of imports)
        if (index < time) for (const name of from) if (certain(name)) names.add(name);
      for (const name of inherited) if (certain(name)) names.add(name);
      return names;
    },
    /** what a shell that sources this one gets: every definition that is certain by the end */
    exported() {
      const names = new Set(valid.keys());
      for (const { names: from } of imports)
        for (const name of from) if (certain(name)) names.add(name);
      return names;
    },
  };
}

/** The top-level `source`/`.` commands of a script whose one path is resolved: `[{ index, path }]`. */
function topLevelSources(parsed, layout, self, usable) {
  const found = [];
  for (const [index, command] of parsed.commands.entries()) {
    if (command.pattern) continue;
    const { chain, problem, bypass } = executionChain(command.words);
    const at = chain.at(-1);
    const program = command.words[at]?.value;
    if (problem || bypass || (program !== 'source' && program !== '.')) continue;
    const path = sourcedPath(command.words[at + 1], self);
    if (
      path !== undefined &&
      layout.nesting[index] === 0 &&
      command.group === 0 &&
      LIST_STARTS.has(command.sep) &&
      !['&', '|', '|&'].includes(
        parsed.commands[index + 1]?.sep === '('
          ? parsed.commands[index + 1].lead
          : parsed.commands[index + 1]?.sep,
      ) &&
      usable(path, index)
    )
      found.push({ index, path });
  }
  return found;
}

/**
 * What sourcing a file does to the shell that sources it: `moves` (it can change the directory,
 * from the tokens of the file and of the files it sources, or a library whose pool has a directory
 * word), the function names it leaves and the names it unsets. Memoised; a cycle promises nothing.
 */
const unknownUnsets = () => ({ names: new Set(), all: true });
function fileScope(path, shared) {
  if (shared.memo.has(path)) return shared.memo.get(path);
  shared.memo.set(path, { moves: true, exported: new Set(), unsets: unknownUnsets() });
  let scope;
  if (path.endsWith('.bash')) {
    // a hash-pinned library: its text was read by a reviewer, not by the tokenizer
    const pinned = shared.verified.has(path);
    scope = {
      moves:
        !pinned ||
        [...shared.libraries.keys()].some((name) =>
          DIRECTORY_WORD.test(shared.texts.get(name) ?? ''),
        ),
      exported: new Set(pinned ? shared.libraries.get(path).functions : []),
      unsets: { names: new Set(), all: false },
    };
  } else {
    try {
      const parsed = tokenizeShell(shared.texts.get(path));
      const layout = layoutOf(parsed.commands);
      const moves =
        directoryChanges(parsed.commands, (word) => {
          const target = word && sourcedPath(word, path);
          return (
            target !== undefined &&
            shared.texts.has(target) &&
            fileScope(target, shared).moves === false
          );
        }).length > 0;
      const imports = moves
        ? []
        : topLevelSources(parsed, layout, path, (target) => shared.texts.has(target)).map(
            ({ index, path: target }) => ({
              index,
              names: fileScope(target, shared).exported,
              unsets: fileScope(target, shared).unsets,
            }),
          );
      const table = functionTable(parsed, layout, imports);
      // task 367 (FU-200 F2): a `return` outside every function body, or any `trap` (a DEBUG, ERR or RETURN
      // handler can `return` between two commands), ends the file early: it promises nothing
      const returns = parsed.commands.some(({ words, pattern }, k) => {
        const program = words[executionChain(words).chain.at(-1)]?.value;
        return !pattern && (program === 'trap' || (program === 'return' && !table.owned(k)));
      });
      scope = returns
        ? { moves, exported: new Set(), unsets: unknownUnsets() }
        : { moves, exported: table.exported(), unsets: table.unsets };
    } catch {
      scope = { moves: true, exported: new Set(), unsets: unknownUnsets() };
    }
  }
  shared.memo.set(path, scope);
  return scope;
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
  if (name === 'alias') return { problem: 'alias defines text a later command runs' };
  // FU-159 r2 F1: `declare -i x=…` evaluates the value as an arithmetic expression, which runs `$(…)`
  if (
    ['declare', 'typeset', 'local', 'export', 'readonly'].includes(name) &&
    args.some(({ value }) => /^-[A-Za-z]*i/.test(value))
  )
    return { problem: `${name} -i evaluates its value as arithmetic, which can run a command` };
  // Task 367 (FU-200 F4): a nameref writes the variable it names (PATH, BASH_ENV ...) under another name
  if (
    ['declare', 'typeset', 'local', 'export', 'readonly'].includes(name) &&
    args.some(({ value }) => /^[-+][A-Za-z]*n/.test(value))
  )
    return {
      problem: `${name} -n makes a name reference, which writes another variable under a name this check does not follow`,
    };
  if (name === 'coproc')
    return { problem: 'coproc writes NAME_PID variables and runs in the background' };
  // Task 367 (FU-200 F1): a reviewed program's option that runs a program of its own
  if (name === 'sort' && args.some(({ value }) => value.startsWith('--compress-program')))
    return { problem: 'sort --compress-program runs a program this check does not read' };
  // FU-159 r2 F4: `hash -p FILE NAME` makes NAME run FILE whatever PATH says
  if (name === 'hash' && args.some(({ value }) => value !== '-r'))
    return { problem: 'hash binds a command name to a file this check did not read' };
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
  return {};
}

/**
 * FU-077 r2 F2: what a shell or `eval` command runs. `{ script }` is text to read as a script
 * of its own, `{}` is input read elsewhere (a CI `.sh` file this check validates, or a
 * here-document body already read as a nested script), `{ problem }` refuses: a pipe or the
 * terminal into a shell, a computed `-c` body or eval text, a script file that is not read.
 * FU-092: the shell's own options are classified by shellInvocation (shared), and a script
 * operand counts only if it is a file of the run (`ctx.shellFiles`), never by default.
 */
function shellInput(
  [command, ...args],
  input,
  outputs,
  { evaluated, shellFiles, moved, shadowed },
) {
  const literal = (word) => !word.opaque && !word.value.includes('$');
  if (command.value === 'eval') {
    const name = args.length === 1 ? evalSubject(args[0]) : undefined;
    const source = name === undefined ? undefined : outputs.get(name);
    const file = source === undefined ? undefined : evaluatedFile(source, shadowed);
    if (file !== undefined && evaluated.allowed.has(file)) {
      evaluated.used.add(file);
      return {};
    }
    return {
      problem:
        'eval runs text this check does not read; write the command itself, or evaluate the output of a script EVALUATED_OUTPUTS lists',
    };
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

/**
 * FU-159 r3 F1: a genuine assignment word: `name=` is the unquoted, unescaped start of the word as written.
 * `comm""ands=x`, `"commands"=x`, `comm\ands=x` and `commands"="x` read the same after quote removal but are
 * the name of a command to run, not an assignment.
 */
const isAssignment = (word) => {
  const name = ASSIGNMENT.exec(word.value)?.[1];
  const [first] = word.segments ?? [];
  return name !== undefined && first?.kind === 'bare' && first.raw.startsWith(`${name}=`);
};
/** A word written as one unquoted, unescaped piece of text: `export`, not `"export"` or `\\export`. */
const plainWord = (word) => word.segments?.length === 1 && word.segments[0].kind === 'bare';
// `local` is not one: outside a function it fails and assigns nothing, inside one the name dies with it
const ASSIGNING_DECLARERS = new Set(['export', 'readonly', 'declare', 'typeset']);
/**
 * FU-202 R1: the assignment words of a command that assigns and runs nothing else, or undefined. ONE syntax-aware
 * classifier for everything that binds a variable (image variables, producer bindings, readonly proofs): leading
 * declarers must be plain words that no function or alias can replace (`shadowed`: a function named `export`
 * consumes the words and assigns nothing), and every other word an assignment AS WRITTEN (`isAssignment`).
 */
function assignmentsOf(words, shadowed) {
  let at = 0;
  while (
    at < words.length &&
    ASSIGNING_DECLARERS.has(words[at].value) &&
    plainWord(words[at]) &&
    !shadowed(words[at].value)
  )
    at += 1;
  const rest = words.slice(at);
  return rest.length > 0 && rest.every(isAssignment) ? rest : undefined;
}
const assignmentOnly = (words, shadowed) => assignmentsOf(words, shadowed) !== undefined;
/**
 * Task 367 (FU-224) READONLY_FORM: the ONE way a variable names an image or an executed program. Not
 * a proof about bash, a form so small that nothing needs proving. In the script's PREAMBLE - the first
 * commands of the script, at its top level, each alone on its list (no `&`, `|`, `&&`, `||`, redirection,
 * here-string, group or function around it) - and before any other command, only
 *   set -euo pipefail                      (`set` with the options e u x o and `pipefail`)
 *   readonly NAME=<literal>                (plain words; NAME ends in IMAGE or BIN, upper case;
 *                                           the value has no `$`, backtick or substitution)
 * may stand. Nothing ran before them, so NAME has no earlier write, no other attribute and no
 * function, alias or trap that could answer; bash refuses every later write to a readonly name
 * (assignment, `unset`, `declare`, `local`, `read`, arithmetic, `eval`, a nameref). A name declared
 * twice, or by any other spelling, is no literal at all. The first command that is neither ends the
 * preamble. The name is then read only as the whole word "$NAME" / "${NAME}".
 * NAME is not a name bash manages itself (FUNCNAME, COPROC_PID, POSIXLY_CORRECT, BASH_*, REPLY ...):
 * none of them ends in IMAGE or BIN.
 */
const READONLY_NAME = /^(?:[A-Z][A-Z0-9]*_)*(?:IMAGE|BIN)$/;
const SET_OPTION = /^(?:-[euxo]+|pipefail)$/;
function preambleLiterals(parsed, layout, shadowed) {
  const found = new Map();
  const taken = new Set();
  if (shadowed('set') || shadowed('readonly')) return found;
  for (const [index, command] of parsed.commands.entries()) {
    const { words } = command;
    const after = parsed.commands[index + 1];
    if (
      command.pattern ||
      !plainWord(words[0]) ||
      layout.outer[index] !== 0 ||
      layout.nesting[index] !== 0 ||
      command.group !== 0 ||
      !LIST_STARTS.has(command.sep) ||
      ['&', '|', '|&'].includes(after?.sep === '(' ? after.lead : after?.sep) ||
      Object.keys(command.input).length > 0 ||
      words.some((_, k) => redirectWidth(words, k) > 0)
    )
      break;
    if (words[0].value === 'set') {
      if (words.length > 1 && words.slice(1).every((w) => plainWord(w) && SET_OPTION.test(w.value)))
        continue;
      break;
    }
    const [, name, value] =
      words[0].value === 'readonly' && words.length === 2 && isAssignment(words[1])
        ? ASSIGNMENT.exec(words[1].value)
        : [];
    if (
      name === undefined ||
      !READONLY_NAME.test(name) ||
      words[1].opaque ||
      words[1].segments.some(({ raw }) => /[$`]/.test(raw))
    )
      break;
    if (taken.has(name))
      found.delete(name); // the second declaration fails: no literal
    else found.set(name, value);
    taken.add(name);
  }
  return found;
}
/**
 * Task 365 F4 + task 367 R4: a word bash may turn into several words or expand by pattern: an unquoted
 * `$`/`${…}`/`$(…)`, a glob character, a brace list, a quoted vector expansion (`"$@"`, `"${a[@]}"`).
 * `$__GHEXPRn__` is text GitHub pastes before the shell parses the step: it is not an expansion. A quoted
 * empty suffix (`$IMG""`) does not quote the expansion in front of it.
 */
const splits = (word) =>
  // a word with no quoting record cannot be shown to be one word: the generic test decides
  (word.segments === undefined ? unsplit(word) : false) ||
  vector(word) ||
  (word.segments ?? []).some(
    ({ kind, raw }) => kind !== 'sq' && kind !== 'dq' && /\$(?!__GHEXPR\d+__)|[*?[`]/.test(raw),
  ) ||
  /\{[^{}]*(?:,|\.\.)[^{}]*\}/.test(word.value);
const OPENERS = new Set('if while until for select case { function coproc'.split(' '));
const CLOSERS = new Set('fi done esac }'.split(' '));
const LIST_STARTS = new Set(['', '\n', ';', '(']);
const NAME_WRITERS = new Set(
  'read readarray mapfile getopts let declare typeset local export readonly unset printf source . compgen complete'.split(
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

/**
 * FU-159 r2 F3 + r3 F1: the only text `eval` may run unread is the value of ONE ordinary variable, quoted. The
 * word is made of exactly one part, written in double quotes, and what is between them is exactly
 * `$name` or `${name}` (raw: `"$comm""ands"`, `"\$name"`, `'$name'""` and `"${name}x"` are other words, which
 * the canonical `value` cannot tell apart), and `name` is lower-case. Every name bash writes by itself is
 * upper-case or `_` (`BASH_REMATCH`, `_`, `IFS`, `REPLY` ...): a lower-case name is written only by a command
 * that names it, which is what the canonical-word writes (`shellWrites`) count. Returns the name, or undefined.
 */
function evalSubject(word) {
  // an empty pair of quotes contributes nothing to the word: `"$name"''` is `"$name"`
  const [only, ...more] = (word?.segments ?? []).filter(
    ({ kind, raw }) => !(raw === '' && (kind === 'sq' || kind === 'dq')),
  );
  if (!only || more.length > 0 || only.kind !== 'dq') return undefined;
  return /^\$(?:\{([a-z][a-z0-9_]*)\}|([a-z][a-z0-9_]*))$/.exec(only.raw)?.slice(1).find(Boolean);
}

/** `eval "$name"` where every `name=$(…)` of the script is the output of an EVALUATED_OUTPUTS script. */
function trackedEval(words, fromAllowed) {
  const at = executionChain(words).chain.at(-1);
  if (words[at]?.value !== 'eval' || words.length !== at + 2) return false;
  const name = evalSubject(words[at + 1]);
  return name !== undefined && fromAllowed.get(name) === true;
}

/**
 * FU-202 R2: `test -v NAME` and `-R NAME` evaluate their operand like an arithmetic subscript
 * (`other[$(cmd)]`, `other[commands=42]`): an operand this check cannot read is an evaluator of computed text.
 */
const namesComputed = (words) =>
  words.some(({ value }, at) => /^-[vR]$/.test(value) && unsure(words[at + 1]));

/** True when a name-writing builtin has an operand whose NAME this check cannot read. */
function unresolvedTarget(program, rest) {
  if (!NAME_WRITERS.has(program)) return false;
  if (program === 'source' || program === '.') return true;
  if (program === 'printf')
    return (
      unsure(rest[0]) ||
      (rest[0]?.value === '-v' && unsure(rest[1])) ||
      (rest.some(({ value }) => value.includes('%n')) && rest.some(unsure))
    );
  if (['declare', 'typeset', 'local', 'export', 'readonly', 'unset'].includes(program))
    return rest.some(
      (word) =>
        /^-[A-Za-z]*n/.test(word.value) ||
        /[$`]/.test(word.value.split('=')[0]) ||
        (word.opaque && !word.value.includes('=')),
    );
  return rest.some(unsure);
}

/** An arithmetic body this check can prove constant: no name, no `$`, no backtick, nothing to evaluate. */
const CONSTANT_ARITHMETIC = /^[\s0-9+\-*/%()<>=!&|^~?:,]*$/;
// a plain name assigned a constant evaluates no data (the name is a write, which the texts count)
const CONSTANT_ASSIGNMENT = /^[\s(]*[A-Za-z_]\w*\s*=\s*\d+[\s)]*$/;
const ARITHMETIC_TESTS = new Set(['-eq', '-ne', '-lt', '-le', '-gt', '-ge']);

/**
 * FU-159 r3 F2: what bash EVALUATES in a text it expands: the body of `$((…))` and `$[…]`, every `[subscript]`,
 * a `${v:offset:length}`, and the expansions that assign through a name this check cannot read (`${!ref:=x}`),
 * run commands in this shell (`${ cmd; }`) or expand the value again (`${v@P}`).
 */
function evaluationsIn(text) {
  const bodies = [];
  let unreadable = false;
  const end = (at, close) => {
    const found = text.indexOf(close, at);
    return found === -1 ? text.length : found;
  };
  for (const { index } of text.matchAll(/\$\[/g))
    bodies.push(text.slice(index + 2, end(index + 2, ']')));
  for (const { index } of text.matchAll(/\$\(\(/g)) {
    const close = matchParen(text, index + 1);
    bodies.push(text.slice(index + 3, close === -1 ? text.length : close - 2));
  }
  for (const found of text.matchAll(/(?<=\w)\[([^\]]*)\]/g)) bodies.push(found[1]);
  for (const { index } of text.matchAll(/\$\{/g)) {
    let depth = 0;
    let at = index + 1;
    for (; at < text.length; at += 1) {
      if (text[at] === '{') depth += 1;
      else if (text[at] === '}' && --depth === 0) break;
    }
    const inner = text.slice(index + 2, at);
    // `${!ref}` reads the variable NAMED by ref, a subscript included (`a[commands=5]`): evaluated arithmetic
    if (/^[\s|]|@P$/.test(inner) || /^!(?![A-Za-z_]\w*(?:\[[@*]\]|[@*])$)/.test(inner))
      unreadable = true;
    const offset = /^[!#]?(?:[A-Za-z_]\w*|[@*]|\d+)(?:\[[^\]]*\])?:([^-=+?].*)$/s.exec(inner);
    if (offset) bodies.push(offset[1]);
  }
  return { bodies: bodies.filter((body) => !/^[@*]$/.test(body)), unreadable };
}

/**
 * FU-159 F2 + r3 F2: what this shell can write, from the CANONICAL words of its commands and from EVERY place
 * bash expands text: command words, redirection targets, here-strings, the bodies of expanding here-documents,
 * `((` commands, `[[ n -eq … ]]`, `let` and the integer attribute. `texts` are those texts (the implicit targets
 * of read/select/mapfile/getopts included); a name is written wherever it is mentioned bare, and the text of a
 * literal `eval` and `trap` handler is read the same way. Arithmetic is not followed through variables: any
 * arithmetic this check cannot prove constant (a name, `$`, a backtick) makes the writes `unresolved`, as
 * does any target it cannot read. `functions` are the names the script (and its eval text) defines; `evals`
 * the `eval` commands whose text is computed: the caller decides which of those it trusts.
 */
function shellWrites(
  parsed,
  out = {
    texts: [],
    unresolved: false,
    computedTest: false,
    functions: new Set(),
    evals: [],
    aliasing: false,
  },
  depth = 0,
) {
  const arithmetic = (body) => {
    out.texts.push(body);
    if (!CONSTANT_ARITHMETIC.test(body) && !CONSTANT_ASSIGNMENT.test(body)) out.unresolved = true;
  };
  const site = (text) => {
    out.texts.push(text);
    const { bodies, unreadable } = evaluationsIn(text);
    bodies.forEach(arithmetic);
    if (unreadable) out.unresolved = true;
  };
  parsed.arithmetic.forEach(arithmetic);
  // FU-202 R2: every here-string word and expanding here-document body of the text, whoever owns it
  for (const word of parsed.hereStrings) {
    site(word.value);
    (word.arith ?? []).forEach(arithmetic);
  }
  parsed.heredocBodies.forEach(site);
  for (const name of parsed.functions) out.functions.add(name);
  // `[[ … ]]` is split by the tokenizer at its `&&`: its operands are the commands up to the one with `]]`
  const operators = /^(?:\[\[|\]\]|!|=|==|!=|=~|<|>|\(|\)|-[A-Za-z]{1,2})$/;
  for (const [start, { words }] of parsed.commands.entries()) {
    if (!words.some(({ value, quoted }) => value === '[[' && !quoted)) continue;
    const stop = parsed.commands.findIndex(
      (c, k) => k >= start && c.words.some(({ value }) => value === ']]'),
    );
    const range = parsed.commands
      .slice(start, stop === -1 ? undefined : stop + 1)
      .flatMap((c) => c.words);
    if (range.some(({ value }) => ARITHMETIC_TESTS.has(value)))
      for (const { value } of range) if (!operators.test(value)) arithmetic(value);
    if (namesComputed(range)) out.computedTest = out.unresolved = true;
  }
  for (const { words, pattern } of parsed.commands) {
    for (const word of words) {
      site(word.value);
      (word.arith ?? []).forEach(arithmetic);
    }
    if (pattern) continue;
    const { chain, problem } = executionChain(words);
    if (problem) out.unresolved = true;
    const at = chain.at(-1) ?? -1;
    if (problem || at < 0 || at >= words.length) continue;
    const program = words[at].value;
    const rest = words.slice(at + 1);
    const text = (script) => {
      let inner = null;
      try {
        inner = depth < 4 ? tokenizeShell(script) : null;
      } catch {
        // unreadable text: unresolved below
      }
      if (inner) shellWrites(inner, out, depth + 1);
      else out.unresolved = true;
    };
    if (program === 'eval') {
      if (!rest.some(unsure)) text(rest.map(({ value }) => value).join(' '));
      else out.evals.push(words);
    } else if (program === 'trap') {
      const handler = rest.find(({ value }) => !value.startsWith('-') || value === '-');
      // a computed handler is read as the text it is: its computed command word is unresolved
      if (handler && handler.value !== '-' && handler.value !== '') text(handler.value);
    } else if (program === 'let') rest.forEach(({ value }) => arithmetic(value));
    else if (program === 'alias') out.aliasing = true;
    else if (['test', '['].includes(program) && namesComputed(rest))
      out.computedTest = out.unresolved = true;
    else if (
      ['mapfile', 'readarray', 'compgen', 'complete'].includes(program) &&
      rest.some(({ value }) => /^-[A-Za-z]*[CFW]/.test(value))
    )
      out.unresolved = true; // a callback, function or word list: text bash runs or expands in this shell
    else if (
      ['declare', 'typeset', 'local'].includes(program) &&
      rest.some(({ value }) => /^[-+][A-Za-z]*i/.test(value))
    )
      out.unresolved = true; // an integer variable evaluates every value assigned to it
    if (unresolvedTarget(program, rest)) out.unresolved = true;
  }
  return out;
}

/** The script file of `[NAME=… ]bash|sh <file> …`, the only command an evaluated output may come from. */
function evaluatedFile(source, shadowed = () => false) {
  let parsed;
  try {
    parsed = tokenizeShell(source);
  } catch {
    return undefined;
  }
  if (parsed.commands.length !== 1 || parsed.nested.length > 0) return undefined;
  const all = parsed.commands[0].words;
  // FU-202 R1: `"x=x" bash P` is a command named x=x, not an assignment before bash
  const words = all.slice(all.findIndex((word) => !isAssignment(word)));
  if (words.length < 2 || !/^(?:ba)?sh$/.test(words[0].value) || words[1].opaque) return undefined;
  // FU-159 r3 F3: `bash` is the external interpreter only where no function (or alias) can be called that
  if (shadowed(words[0].value)) return undefined;
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

/**
 * Task 367 (FU-224): the references an image word stands for, or none with a problem recorded. Only
 * three forms are read: a literal reference; a `${{ env.NAME }}` expression (GitHub pastes the pinned
 * value in before the shell parses the step); and `"$NAME"` / `"${NAME}"` as the WHOLE word, NAME one
 * of the preamble `readonly NAME=<literal>` declarations (READONLY_FORM). Every other expansion is
 * refused, never proved safe.
 */
const IMAGE_FIX =
  'write the reference literally (name:tag@sha256:<digest>), as ${{ env.NAME }}, or declare ' +
  '`readonly NAME=<literal>` (NAME ending _IMAGE) right after `set -euo pipefail` and pass "$NAME"';
function resolveImage(word, { literals, env, restore, where, errors }) {
  const value = restore(word.value);
  const refuse = (why) => {
    errors.push(`${where}: image ${value} ${why}; ${IMAGE_FIX}`);
    return [];
  };
  if (word.opaque) return refuse('is a command substitution');
  if (splits(word))
    return refuse('has an unquoted or vector expansion, which bash splits or expands');
  if (value.includes('${{')) {
    if (/[$`]/.test(value.replace(GH_EXPRESSION, '')))
      return refuse('mixes a GitHub expression with a shell expansion');
    return resolveExpressions(value, env, where, errors);
  }
  const [only] = word.segments ?? [];
  const sole =
    word.segments?.length === 1 && only.kind === 'dq'
      ? /^\$(?:([A-Za-z_]\w*)|\{([A-Za-z_]\w*)\})$/.exec(only.raw)
      : null;
  if (sole) {
    const name = sole[1] ?? sole[2];
    return literals.has(name)
      ? [literals.get(name)]
      : refuse(`names ${name}, which is no preamble readonly literal`);
  }
  return /[$`]/.test(value) ? refuse('has an expansion') : [value];
}
