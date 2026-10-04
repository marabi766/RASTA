import { LineCounter, parseDocument } from 'yaml';

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
    text.split('\n').forEach((line, index) => {
      const from = line.match(/^FROM\s+(\S+)(?:\s+AS\s+(\S+))?/i);
      if (from) {
        const [, image, stage] = from;
        if (stage) stages.add(stage);
        if (stages.has(image) && !image.includes(':')) return; // FROM <earlier stage>
        const digest = image.match(DIGEST);
        if (!digest) {
          errors.push(`${name}:${index + 1}: FROM ${image} is not pinned by digest`);
        } else {
          digests.add(`${image.split('@')[0]}${digest[0]}`);
        }
      }
      if (/^\s*RUN\b.*\bapk\b[^\n]*\bupgrade\b\s*(?:&&|;|$)/.test(line)) {
        errors.push(
          `${name}:${index + 1}: \`apk upgrade\` without a package name makes the image unreproducible`,
        );
      }
    });
  }

  if (digests.size > 1) {
    errors.push(`Dockerfiles disagree on the base image digest: ${[...digests].join(', ')}`);
  }
  return { errors, digests: [...digests] };
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
const SHELLS = new Set(['bash', 'sh']);
const EXEMPT = /#\s*image-pin-exempt:(.*)$/;

class ShellSyntaxError extends Error {}

/**
 * Splits a shell script into simple commands. Each word keeps its unquoted
 * value; a word built from a command substitution is `opaque`. Substitutions
 * and the bodies of here-documents fed to bash/sh come back as `nested`
 * scripts with the line they start on. Lines are 0-based.
 */
export function tokenizeShell(src) {
  const commands = [];
  const nested = [];
  const heredocs = [];
  let words = [];
  let word = null;
  let line = 0;
  let startLine = null;
  let i = 0;

  const ensureWord = () => {
    if (!word) word = { value: '', opaque: false };
    if (startLine === null) startLine = line;
  };
  const pushWord = () => {
    if (word) words.push(word);
    word = null;
  };
  const endCommand = () => {
    pushWord();
    if (words.length > 0) commands.push({ startLine, endLine: line, words });
    words = [];
    startLine = null;
  };
  /** The index just past the `)` that closes the `(` at `open`, quotes respected. */
  const closingParen = (open) => {
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
    throw new ShellSyntaxError(`unclosed "(" at line ${line + 1}`);
  };
  const countLines = (text) => (text.match(/\n/g) ?? []).length;
  const substitution = () => {
    // at `$(`, `$((` or a backtick
    ensureWord();
    word.opaque = true;
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
    if (!body.startsWith('(')) nested.push({ script: body, line });
    line += countLines(src.slice(i, end));
    word.value += '$(…)';
    i = end;
  };

  while (i < src.length) {
    const c = src[i];
    if (c === '\\') {
      if (src[i + 1] === '\n') {
        i += 2;
        line += 1;
        continue;
      }
      ensureWord();
      word.value += src[i + 1] ?? '';
      i += 2;
      continue;
    }
    if (c === '\n') {
      endCommand();
      line += 1;
      i += 1;
      while (heredocs.length > 0) {
        const { delimiter, strip, feedsShell } = heredocs.shift();
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
        if (feedsShell) nested.push({ script: body.join('\n'), line: bodyLine });
      }
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      pushWord();
      i += 1;
      continue;
    }
    if (c === '#' && !word) {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === ';' || c === '&' || c === '|') {
      endCommand();
      i += src[i + 1] === c || (c === '|' && src[i + 1] === '&') ? 2 : 1;
      continue;
    }
    if (c === '(' || c === ')') {
      endCommand();
      i += 1;
      continue;
    }
    if (c === '<' && src[i + 1] === '<' && src[i + 2] === '<') {
      // a here-string: the word after it is data, not a delimiter
      pushWord();
      i += 3;
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
      const first = words[0]?.value;
      heredocs.push({
        delimiter: match[1] ?? match[2] ?? match[3],
        strip,
        feedsShell: SHELLS.has(first) || /\/(?:ba)?sh$/.test(first ?? ''),
      });
      i += match[0].length;
      continue;
    }
    if (c === "'") {
      ensureWord();
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
      i += 1;
      let closed = false;
      while (i < src.length) {
        const d = src[i];
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
          substitution();
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
      let depth = 0;
      let j = i + 1;
      for (; j < src.length; j += 1) {
        if (src[j] === '{') depth += 1;
        else if (src[j] === '}' && --depth === 0) break;
      }
      if (j >= src.length) throw new ShellSyntaxError(`unclosed "\${" at line ${line + 1}`);
      word.value += src.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    ensureWord();
    word.value += c;
    i += 1;
  }
  endCommand();
  if (heredocs.length > 0) throw new ShellSyntaxError('here-document is never closed');
  return { commands, nested };
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
 * @param {{ digestVariants?: Map<string, { digests: string[], reason: string }>, tagless?: Map<string, string>, composeFiles?: string[] }} [policy]
 * @returns {{ errors: string[], images: Array<{ where: string, ref: string }> }}
 */
export function validateInfraImagePins(files, policy = {}) {
  const digestVariants = policy.digestVariants ?? DIGEST_VARIANTS;
  const tagless = policy.tagless ?? TAGLESS;
  const composeFiles = policy.composeFiles ?? COMPOSE_FILES;
  const errors = [];
  const images = [];
  const usedTagless = new Set();

  for (const file of files) {
    try {
      if (file.kind === 'compose') composeImages(file, images, errors);
      else if (file.kind === 'workflow') workflowImages(file, images, errors, composeFiles);
      else
        shellImages(
          file.text,
          { file: file.name, lineOf: (n) => n + 1, env: new Map(), composeFiles },
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

function workflowImages({ name, text }, images, errors, composeFiles) {
  const { doc, js, lineAt } = parseYaml(text);
  // Local tags carry across steps, in document order, as they do on the runner.
  const state = { localTags: new Set() };
  if (!isObject(js)) throw new Error('not a mapping');
  const env = new Map(); // every env variable, at any level, with every value it is given
  const addEnv = (block, path) => {
    if (!isObject(block)) return;
    for (const [key, value] of Object.entries(block)) {
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
        shellImages(
          step.run,
          { file: name, lineOf: (n) => first + n, env, composeFiles },
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
  const vars = new Map();
  const restore = (value) => value.replace(/__GHEXPR(\d+)__/g, (_, n) => expressions[Number(n)]);

  for (const command of parsed.commands) {
    const where = `${ctx.file}:${ctx.lineOf(command.startLine)}`;
    let words = command.words;
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
      for (const { value, opaque } of assignments) {
        const [, variable, assigned] = value.match(ASSIGNMENT);
        vars.set(variable, opaque ? null : restore(assigned));
      }
      continue;
    }
    words = words.slice(index);
    const at = words.findIndex(({ value }) => /(^|\/)docker(-compose)?$/.test(value));
    if (at === -1) continue;
    let isExempt = false;
    for (let line = command.startLine - 1; line <= command.endLine; line += 1) {
      if (exempt.has(line)) isExempt = true;
    }
    if (isExempt) continue;
    const problem = (text) => errors.push(`${where}: ${text}`);
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
    shellImages(inner, { ...ctx, lineOf: (n) => ctx.lineOf(line + n) }, images, errors, state);
  }
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
