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

/**
 * The infrastructure images are pinned too: every image `docker-compose.yml`
 * starts and every image CI starts — a `services:`/`container:` image, a
 * `*_IMAGE` variable, or the image a `docker run|create|pull` names, in a
 * workflow or in a script CI runs (`infrastructure/docker/kafka/ci-up.sh`).
 * `tag@sha256:<digest>`; the tag is for the reader, Docker reads the digest.
 *
 * And one repository, one digest, wherever it appears: compose and CI start
 * the same Postgres, the same Keycloak, the same broker. `DIGEST_VARIANTS`
 * names the repositories deliberately run at two digests, each with why.
 *
 * Fails closed: a `docker run` flag it does not know, an image it cannot
 * resolve to text (a GitHub expression, an unknown variable), is a problem,
 * not a pass.
 */

const PINNED_IMAGE =
  /^(?<repository>[a-z0-9][a-z0-9._/-]*?)(?::(?<tag>[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}))?@(?<digest>sha256:[0-9a-f]{64})$/;

/** Repositories pinned at more than one digest on purpose. Remove an entry when its reason goes. */
export const DIGEST_VARIANTS = new Map([
  [
    'cgr.dev/chainguard/minio-client',
    'compose minio-init runs the `-dev` variant for the shell its script needs; CI runs `mc` as the entrypoint on the plain variant (ci.yml env MC_IMAGE)',
  ],
]);

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

const words = (command) =>
  [...command.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map(([raw, dq, sq, bare]) => ({
    raw,
    value: dq ?? sq ?? bare,
  }));

/** Each `docker <verb>` command on a non-comment line, joined across `\` continuations. */
function dockerCommands(text, verbs) {
  const lines = text.split('\n');
  const commands = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (/^\s*#/.test(lines[index])) continue;
    const start = lines[index].search(new RegExp(`\\bdocker\\s+(?:${verbs})\\b`));
    if (start === -1) continue;
    let command = lines[index].slice(start);
    let last = index;
    while (/\\\s*$/.test(command) && last + 1 < lines.length) {
      last += 1;
      command = `${command.replace(/\\\s*$/, ' ')}${lines[last]}`;
    }
    commands.push({ line: index + 1, words: words(command).slice(1) });
  }
  return commands;
}

/** The image a `docker run|create|pull` names, or a problem. */
function imageOf(args) {
  for (let index = 1; index < args.length; index += 1) {
    const { raw, value } = args[index];
    if (/^"?\$\{[A-Za-z_][A-Za-z0-9_]*\[@\]\}"?$/.test(raw)) continue; // "${flags[@]}"
    if (!value.startsWith('-')) return { image: value };
    if (value.includes('=') || BOOL_FLAGS.has(value)) continue;
    if (VALUE_FLAGS.has(value)) {
      index += 1;
      continue;
    }
    return { problem: `cannot tell whether docker option ${value} takes a value` };
  }
  return { problem: 'names no image' };
}

const VARIABLE = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/;
const unquote = (value) => value.trim().replace(/^(['"])(.*)\1$/, '$2');

/**
 * @param {Array<{ name: string, text: string, kind: 'compose' | 'workflow' | 'shell' }>} files
 * @returns {{ errors: string[], images: Array<{ where: string, ref: string }> }}
 */
export function validateInfraImagePins(files) {
  const errors = [];
  const images = [];

  for (const { name, text, kind } of files) {
    const lines = text.split('\n');
    const variables = new Map();
    const localTags = new Set();

    lines.forEach((line, index) => {
      const where = `${name}:${index + 1}`;
      if (/^\s*#/.test(line)) return;
      const keyed = line.match(/^\s*(?:-\s+)?image:\s*(\S.*?)\s*(?:#.*)?$/);
      if (keyed) images.push({ where, ref: unquote(keyed[1]) });
      if (kind === 'workflow') {
        const container = line.match(/^\s*container:\s*([^\s#{][^#]*?)\s*(?:#.*)?$/);
        if (container) images.push({ where, ref: unquote(container[1]) });
        const action = line.match(/^\s*(?:-\s+)?uses:\s*['"]?docker:\/\/([^'"\s]+)/);
        if (action) images.push({ where, ref: action[1] });
        const env = line.match(/^\s*([A-Z0-9_]*_IMAGE):\s*(\S.*?)\s*(?:#.*)?$/);
        if (env) {
          variables.set(env[1], unquote(env[2]));
          images.push({ where, ref: unquote(env[2]) });
        }
      }
      if (kind === 'shell') {
        // IMAGE="${KAFKA_IMAGE:-repo:tag@sha256:…}" or IMAGE="repo:tag@sha256:…"
        const assigned = line.match(
          /^\s*([A-Za-z_][A-Za-z0-9_]*)="(?:\$\{[A-Za-z_][A-Za-z0-9_]*:-([^}]+)\}|([^"$]+))"\s*$/,
        );
        if (assigned) variables.set(assigned[1], { where, ref: assigned[2] ?? assigned[3] });
      }
    });

    // A local tag of a pinned image (`docker tag <pinned> <local>`) is that image.
    for (const { words: args } of dockerCommands(text, 'tag')) {
      const [, source, target] = args.map((word) => word.value);
      if (source && target && PINNED_IMAGE.test(source)) localTags.add(target);
    }

    for (const { line, words: args } of dockerCommands(text, 'run|create|pull')) {
      const where = `${name}:${line}`;
      const { image, problem } = imageOf(args);
      if (problem) {
        errors.push(`${where}: docker ${args[0]?.value} ${problem}`);
        continue;
      }
      if (localTags.has(image)) continue;
      const variable = image.match(VARIABLE);
      if (variable) {
        const known = variables.get(variable[1]);
        if (known === undefined) {
          errors.push(`${where}: image ${image} is a variable this check cannot resolve`);
        } else if (kind === 'shell') {
          images.push(known);
        } // a workflow `*_IMAGE` is already collected where it is defined
        continue;
      }
      images.push({ where, ref: image });
    }
  }

  const digestsByRepository = new Map();
  for (const { where, ref } of images) {
    const pinned = ref.match(PINNED_IMAGE);
    if (!pinned) {
      errors.push(`${where}: image ${ref} is not pinned by digest (tag@sha256:<digest>)`);
      continue;
    }
    const { repository, digest } = pinned.groups;
    if (!digestsByRepository.has(repository)) digestsByRepository.set(repository, new Map());
    const seen = digestsByRepository.get(repository);
    if (!seen.has(digest)) seen.set(digest, where);
  }
  for (const [repository, seen] of digestsByRepository) {
    if (seen.size > 1 && !DIGEST_VARIANTS.has(repository)) {
      const at = [...seen].map(([digest, where]) => `${digest} (${where})`).join(', ');
      errors.push(`${repository} is pinned at ${seen.size} digests: ${at}`);
    }
  }
  for (const repository of DIGEST_VARIANTS.keys()) {
    if (digestsByRepository.get(repository)?.size === 1) {
      errors.push(`DIGEST_VARIANTS lists ${repository}, which is no longer pinned at two digests`);
    }
  }
  return { errors, images };
}
