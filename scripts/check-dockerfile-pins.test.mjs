import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';
import { authoredFiles } from './authored-source-inventory.cjs';
import {
  DIGEST_VARIANTS,
  SOURCED_LIBRARIES,
  TAGLESS,
  tokenizeShell,
  validateDockerfilePins,
  validateInfraImagePins,
} from './check-dockerfile-pins-lib.mjs';
import { continuedDollar, shellInvocation } from './ci-shell-text-lib.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const A = `sha256:${'a'.repeat(64)}`;
const B = `sha256:${'b'.repeat(64)}`;
const file = (text, name = 'services/x/Dockerfile') => ({ name, text });
const pinned = (digest = A) =>
  [
    `FROM node:22-alpine@${digest} AS deps`,
    'RUN npm install -g pnpm@11.22.0',
    'FROM deps AS build',
    `FROM node:22-alpine@${digest} AS runtime`,
  ].join('\n');

test('the committed Dockerfiles pass', () => {
  const result = spawnSync(process.execPath, [join(root, 'scripts', 'check-dockerfile-pins.mjs')], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /17 Dockerfiles on one base/);
  assert.match(result.stdout, /infra image pins: \d+ image references in \d+ files, all pinned/);
});

test('a pinned file, including a FROM of an earlier stage, passes', () => {
  assert.deepEqual(validateDockerfilePins([file(pinned())]).errors, []);
});

test('a moving tag is refused', () => {
  const { errors } = validateDockerfilePins([file('FROM node:22-alpine AS deps')]);
  assert.match(errors[0], /not pinned by digest/);
});

test('two services on different digests are refused', () => {
  const { errors } = validateDockerfilePins([
    file(pinned(A), 'services/a/Dockerfile'),
    file(pinned(B), 'services/b/Dockerfile'),
  ]);
  assert.match(errors.join('\n'), /disagree/);
});

test('a bare apk upgrade is refused; a named one-package stop-gap is not', () => {
  assert.equal(
    validateDockerfilePins([file(`${pinned()}\nRUN apk --no-cache upgrade`)]).errors.length,
    1,
  );
  assert.deepEqual(
    validateDockerfilePins([file(`${pinned()}\nRUN apk --no-cache upgrade openssl`)]).errors,
    [],
  );
});

test('a truncated digest is not a digest', () => {
  const { errors } = validateDockerfilePins([file('FROM node:22-alpine@sha256:abc AS deps')]);
  assert.match(errors[0], /not pinned/);
});

// --- compose, workflow and CI-script images (L7-45) ------------------------

const C = `sha256:${'c'.repeat(64)}`;
const NO_EXEMPTIONS = {
  digestVariants: new Map(),
  tagless: new Map(),
  evaluatedOutputs: new Map(),
};
const compose = (text) => ({ name: 'docker-compose.yml', kind: 'compose', text });
const workflowYaml = (text) => ({ name: '.github/workflows/ci.yml', kind: 'workflow', text });
/** A workflow whose one step runs `script`; extra top-level keys merged in. */
const workflow = (script, extra = {}) =>
  workflowYaml(stringify({ ...extra, jobs: { a: { 'runs-on': 'x', steps: [{ run: script }] } } }));
const shell = (text) => ({ name: 'infrastructure/x/ci-up.sh', kind: 'shell', text });
const infra = (files, policy = NO_EXEMPTIONS) => validateInfraImagePins(files, policy);
const PINNED = `postgis/postgis:16-3.4@${A}`;
const notPinned = /is not pinned by digest/;

test('a compose image pinned as tag@digest is accepted; tag-only and digest-only are refused', () => {
  const ok = infra([compose(`services:\n  postgres:\n    image: ${PINNED}`)]);
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.images.length, 1);
  assert.match(
    infra([compose('services:\n  r:\n    image: redis:7.4-alpine')]).errors[0],
    notPinned,
  );
  assert.match(
    infra([compose(`services:\n  r:\n    image: redis@${A}`)]).errors[0],
    /has no tag — pin it as <tag>@sha256/,
  );
});

test('compose: a quoted image key is still the image (Codex finding 1)', () => {
  for (const key of ["'image'", '"image"']) {
    const { errors } = infra([compose(`services:\n  postgres:\n    ${key}: postgres:16`)]);
    assert.equal(errors.length, 1, key);
    assert.match(errors[0], /service postgres\): image postgres:16 is not pinned/);
  }
});

test('compose: an image inherited through an anchor and a << merge key is resolved (Codex finding 1)', () => {
  const merged = [
    'x-base: &base',
    '  image: postgres:16',
    '  restart: always',
    'services:',
    '  db:',
    '    <<: *base',
    '    environment: { A: 1 }',
    '  copy: *base',
  ].join('\n');
  const { errors } = infra([compose(merged)]);
  assert.equal(errors.length, 2);
  assert.match(errors[0], /service db\): image postgres:16 is not pinned/);
  assert.match(errors[1], /service copy\): image postgres:16 is not pinned/);
  assert.deepEqual(infra([compose(merged.replace('postgres:16', `postgres:16@${A}`))]).errors, []);
});

test('compose: every profile is checked, not only the default one', () => {
  const { errors } = infra([
    compose(
      `services:\n  a:\n    image: ${PINNED}\n  ui:\n    profiles: [tools]\n    image: kafka-ui:v1`,
    ),
  ]);
  assert.match(errors[0], /service ui\): image kafka-ui:v1 is not pinned/);
});

test('compose interpolation: a default is checked, a variable without one fails closed', () => {
  const at = (image) => infra([compose(`services:\n  db:\n    image: "${image}"`)]).errors;
  assert.match(at('${PG_IMAGE:-postgres:16}')[0], /image postgres:16 is not pinned/);
  assert.deepEqual(at(`\${PG_IMAGE:-postgres:16@${A}}`), []);
  assert.match(at('${PG_IMAGE}')[0], /has no default this check can resolve/);
  assert.match(at('postgres:${PG_TAG}')[0], /has no default/);
});

test('compose: extends in the same file is followed; another file, build: and include: fail closed', () => {
  const base = `services:\n  base:\n    image: ${PINNED}\n`;
  assert.deepEqual(infra([compose(`${base}  child:\n    extends: base`)]).errors, []);
  assert.deepEqual(infra([compose(`${base}  child:\n    extends: { service: base }`)]).errors, []);
  assert.match(
    infra([compose(`${base}  child:\n    extends: { file: other.yml, service: x }`)]).errors[0],
    /extends a service in another file/,
  );
  assert.match(
    infra([compose('services:\n  app:\n    build: ./app')]).errors[0],
    /builds its image here/,
  );
  assert.match(
    infra([compose(`include: [other.yml]\n${base}`)]).errors[0],
    /include: brings in services this check does not read/,
  );
});

test('workflow: services:, container: and uses: docker:// images are checked', () => {
  const jobs = (job) => workflowYaml(stringify({ jobs: { a: job } }));
  const cases = [
    jobs({ services: { redis: { image: 'redis:7.4-alpine' } } }),
    jobs({ container: 'node:22-alpine' }),
    jobs({ container: { image: 'node:22-alpine' } }),
    jobs({ steps: [{ uses: 'docker://alpine:3.20' }] }),
  ];
  for (const file of cases) {
    const { errors } = infra([file]);
    assert.equal(errors.length, 1, file.text);
    assert.match(errors[0], notPinned);
  }
});

test('every docker command on a line is checked, after ; && || | (Codex finding 2)', () => {
  for (const separator of [' ; ', ' && ', ' || ', ' | ', ' & ']) {
    const { errors } = infra([
      workflow(`docker pull ${PINNED}${separator}docker run ubuntu:24.04`),
    ]);
    assert.equal(errors.length, 1, separator);
    assert.match(errors[0], /image ubuntu:24\.04 is not pinned/, separator);
  }
});

test('docker \\ newline run … is one command (Codex finding 2)', () => {
  const { errors } = infra([workflow('set -e\ndocker \\\n  run --rm \\\n  ubuntu:24.04 true\n')]);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /ci\.yml:\d+: image ubuntu:24\.04 is not pinned/);
});

test('docker inside $( ), backticks, a subshell or a here-document fed to bash is found', () => {
  for (const script of [
    'id=$(docker run -d ubuntu:24.04)',
    'id=`docker run -d ubuntu:24.04`',
    'echo "$(docker run ubuntu:24.04)"',
    '( cd /tmp && docker run ubuntu:24.04 )',
    'bash <<EOF\ndocker run ubuntu:24.04\nEOF\n',
    'if true; then docker run ubuntu:24.04; fi',
    'timeout 60 docker run ubuntu:24.04',
  ]) {
    const { errors } = infra([workflow(script)]);
    assert.ok(
      errors.some((e) => /ubuntu:24\.04 is not pinned/.test(e)),
      `${script}\n${errors.join('\n')}`,
    );
  }
});

test('text that only mentions docker is not a command', () => {
  for (const script of [
    '# docker run ubuntu:24.04 in a comment',
    'echo "docker run ubuntu:24.04"',
    "echo 'docker run ubuntu:24.04'",
    'cat <<EOF\ndocker run ubuntu:24.04\nEOF\n',
    'grep -q x <<< "docker run ubuntu:24.04"',
  ]) {
    assert.deepEqual(infra([workflow(script)]).errors, [], script);
  }
});

test('a docker verb, option or global option the check cannot classify fails closed', () => {
  assert.match(
    infra([workflow('docker build -t x .')]).errors[0],
    /docker build is not a command this check can classify/,
  );
  assert.match(
    infra([workflow('docker buildx bake')]).errors[0],
    /docker buildx is not a command this check can classify/,
  );
  assert.match(
    infra([workflow(`docker run --frobnicate x ${PINNED}`)]).errors[0],
    /cannot tell whether docker option --frobnicate takes a value/,
  );
  assert.match(
    infra([workflow(`docker --weird run ${PINNED}`)]).errors[0],
    /global option --weird/,
  );
  assert.deepEqual(infra([workflow(`docker -H tcp://x:2375 run ${PINNED}`)]).errors, []);
  assert.deepEqual(
    infra([workflow('docker logs --tail 5 x; docker exec x true; docker rm -f x')]).errors,
    [],
  );
});

test('docker compose may name only the compose file this check validates', () => {
  assert.deepEqual(infra([workflow('docker compose -f docker-compose.yml up -d')]).errors, []);
  assert.deepEqual(infra([workflow('docker compose --profile tools up -d')]).errors, []);
  assert.match(
    infra([workflow('docker compose -f other.yml up -d')]).errors[0],
    /a compose file this check does not validate/,
  );
});

test('a script the check cannot split fails closed', () => {
  assert.match(
    infra([shell("docker run 'ubuntu:24.04")]).errors[0],
    /cannot split this script into commands \(unclosed single quote/,
  );
});

test('image-pin-exempt with a reason exempts that command; without one it is an error', () => {
  const exempt = workflow(
    'docker run ubuntu:24.04 true # image-pin-exempt: a throwaway probe of the runner itself',
  );
  assert.deepEqual(infra([exempt]).errors, []);
  const above = workflow(
    '# image-pin-exempt: same probe, marked on the line above\ndocker run ubuntu:24.04',
  );
  assert.deepEqual(infra([above]).errors, []);
  const bare = infra([workflow('docker run ubuntu:24.04 # image-pin-exempt:')]).errors;
  assert.ok(bare.some((e) => /image-pin-exempt needs a reason/.test(e)));
  assert.ok(bare.some((e) => /ubuntu:24\.04 is not pinned/.test(e)));
});

test('variables: workflow env, ${{ env.X }}, shell defaults; anything unresolved fails closed', () => {
  const minio = `cgr.dev/x/minio:1@${A}`;
  const env = { env: { MINIO_IMAGE: minio } };
  assert.deepEqual(infra([workflow('docker run -d "$MINIO_IMAGE" server /data', env)]).errors, []);
  assert.deepEqual(
    infra([workflow('docker run -d ${{ env.MINIO_IMAGE }} server', env)]).errors,
    [],
  );
  assert.match(
    infra([
      workflow('docker run -d "$MINIO_IMAGE"', { env: { MINIO_IMAGE: 'minio/minio:latest' } }),
    ]).errors[0],
    notPinned,
  );
  assert.match(
    infra([workflow('docker run -d "$OTHER"')]).errors[0],
    /variable this check cannot resolve/,
  );
  assert.match(
    infra([workflow('docker run -d ${{ matrix.image }}')]).errors[0],
    /expression \$\{\{ matrix\.image \}\}, which this check cannot resolve/,
  );
  assert.match(
    infra([workflow('IMG=$(cat image.txt)\ndocker run "$IMG"')]).errors[0],
    /set from a command substitution/,
  );
  const script = (image) =>
    shell(
      `IMAGE="\${KAFKA_IMAGE:-${image}}"\ndocker run --rm --user 0 \\\n  --entrypoint bash "\${IMAGE}" /x.sh`,
    );
  assert.match(
    infra([script('apache/kafka:3.9.0')]).errors[0],
    /ci-up\.sh:2: image apache\/kafka:3\.9\.0 is not pinned/,
  );
  assert.deepEqual(infra([script(`apache/kafka:3.9.0@${A}`)]).errors, []);
});

test('a local tag of a pinned image is that image, across steps; a local tag of a moving one is not', () => {
  const steps = (source) =>
    workflowYaml(
      stringify({
        jobs: {
          a: {
            steps: [
              { run: `docker pull ${source}\ndocker tag ${source} \\\n  rasta/clamav-pinned:ci\n` },
              { run: 'docker run --rm rasta/clamav-pinned:ci -c true' },
            ],
          },
        },
      }),
    );
  assert.deepEqual(infra([steps(`clamav/clamav:1.5.4@${A}`)]).errors, []);
  const { errors } = infra([steps('clamav/clamav:1.5.4')]);
  assert.ok(errors.length >= 2, errors.join('\n')); // the pull, the tag's source, the run
  assert.ok(errors.some((e) => /rasta\/clamav-pinned:ci is not pinned/.test(e)));
});

test('one repository at two digests is refused, naming both places', () => {
  const { errors } = infra([
    compose(`services:\n  db:\n    image: ${PINNED}`),
    workflowYaml(
      stringify({ jobs: { a: { services: { pg: { image: `postgis/postgis:16-3.4@${B}` } } } } }),
    ),
  ]);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /postgis\/postgis is pinned at 2 digests/);
  assert.match(errors[0], /docker-compose\.yml:3/);
  assert.match(errors[0], /ci\.yml:\d+/);
});

test('DIGEST_VARIANTS names the exact digests: those pass, a third is refused, an unused one is stale (Codex finding 3)', () => {
  const policy = {
    digestVariants: new Map([['x/mc', { digests: [A, B], reason: 'two variants, on purpose' }]]),
    tagless: new Map(),
    evaluatedOutputs: new Map(),
  };
  const at = (...digests) =>
    infra(
      [
        compose(
          `services:\n${digests.map((d, i) => `  s${i}:\n    image: x/mc:1@${d}`).join('\n')}`,
        ),
      ],
      policy,
    ).errors;
  assert.deepEqual(at(A, B), []);
  const third = at(A, B, C);
  assert.equal(third.length, 1);
  assert.match(
    third[0],
    new RegExp(`x/mc is pinned at ${C}, which is not one of the 2 digests DIGEST_VARIANTS allows`),
  );
  assert.match(
    at(A)[0],
    new RegExp(`DIGEST_VARIANTS allows x/mc@${B}, which nothing uses any more`),
  );
});

test('TAGLESS names exact references: listed ones pass, any other digest-only image is refused, an unused entry is stale (Codex finding 4)', () => {
  const policy = {
    digestVariants: new Map(),
    tagless: new Map([[`x/minio@${A}`, 'no tag published']]),
    evaluatedOutputs: new Map(),
  };
  assert.deepEqual(infra([compose(`services:\n  m:\n    image: x/minio@${A}`)], policy).errors, []);
  assert.match(
    infra([compose(`services:\n  m:\n    image: x/minio@${B}`)], policy).errors.join('\n'),
    /x\/minio@sha256:b+ has no tag/,
  );
  assert.match(
    infra([compose(`services:\n  m:\n    image: x/minio:1@${A}`)], policy).errors[0],
    /TAGLESS lists x\/minio@sha256:a+, which nothing uses without a tag any more/,
  );
});

test('the committed exemptions say why and are exact', () => {
  for (const [repository, { digests, reason }] of DIGEST_VARIANTS) {
    assert.equal(digests.length, 2, repository);
    assert.ok(reason.length > 40, repository);
  }
  for (const [reference, reason] of TAGLESS) {
    assert.match(reference, /^[a-z0-9./-]+@sha256:[0-9a-f]{64}$/);
    assert.match(reason, /could not be verified/);
  }
});

test('tokenizeShell joins continuations and splits at every separator', () => {
  const { commands } = tokenizeShell('a 1 \\\n  2; b && c || d | e\n# x\nf "g h" \'i\'');
  assert.deepEqual(
    commands.map((c) => c.words.map((w) => w.value).join(' ')),
    ['a 1 2', 'b', 'c', 'd', 'e', 'f g h i'],
  );
  assert.equal(commands[0].startLine, 0);
  assert.equal(commands.at(-1).startLine, 3);
});

// FU-077 R1: bash reads a carriage return as a word character, so `echo a\r# ; docker
// run x` runs docker. The pin guard reads shell text through the shared policy and
// refuses it instead of splitting there (it used to treat CR as a blank).
test('FU-077: a carriage return or control character is refused, not read past', () => {
  for (const src of ['echo a\r# ; docker run node:22', 'docker run node:22', 'true\x0b'])
    assert.throws(() => tokenizeShell(src), /carriage return, control or invisible blank/);
  const { errors } = validateDockerfilePins([file(`FROM node:22@${A}\rFROM node:latest\n`)]);
  assert.ok(
    errors.some((error) => /cannot be read: a carriage return/.test(error)),
    errors.join(),
  );
  const workflow = stringify({
    jobs: { j: { steps: [{ run: 'echo a\r# ; docker run node:22' }] } },
  });
  const infra = validateInfraImagePins([
    { kind: 'workflow', name: '.github/workflows/x.yml', text: workflow },
  ]);
  assert.ok(
    infra.errors.some((error) => /carriage return/.test(error)),
    infra.errors.join(),
  );
});

// PR #727 r2 F2: text bash EXPANDS or EVALUATES is read, never skipped: substitutions in a
// `${…}` operand, an arithmetic body or an expanding here-document; a literal `bash -c` or
// eval body; a shell anywhere in a command reading a here-document. A shell reading a pipe or
// a here-string, and eval of computed text, refuse. Ten shapes x run/create/pull x shell and
// workflow input: each one finds the unpinned image or refuses at that line.
const SHAPES = {
  'parameter default': (v) => `echo \${V:-$(docker ${v} alpine:latest)}`,
  'assignment prefix default': (v) => `X=\${V:-$(docker ${v} alpine:latest)} true`,
  'arithmetic substitution': (v) => `echo $(( 1 + $(docker ${v} alpine:latest) ))`,
  'expanding here-document': (v) => `cat <<EOF\n$(docker ${v} alpine:latest)\nEOF`,
  'expanding <<- here-document': (v) => `cat <<-EOF\n\t\`docker ${v} alpine:latest\`\n\tEOF`,
  'bash -c body': (v) => `bash -c 'docker ${v} alpine:latest'`,
  'eval body': (v) => `eval 'docker ${v} alpine:latest'`,
  'here-string into bash': (v) => `bash <<< 'docker ${v} alpine:latest'`,
  'pipeline into sh': (v) => `echo 'docker ${v} alpine:latest' | sh`,
  'env-prefixed quoted here-document': (v) => `env bash <<'EOF'\ndocker ${v} alpine:latest\nEOF`,
};
const bare = { evaluatedOutputs: new Map(), digestVariants: new Map(), tagless: new Map() };
const asInput = (kind, body) =>
  kind === 'shell'
    ? { kind, name: 'scripts/x.sh', text: body }
    : {
        kind,
        name: '.github/workflows/x.yml',
        text: stringify({ jobs: { j: { steps: [{ run: body }] } } }),
      };
test('PR #727 r2 F2: expanded, evaluated and shell-input text is read or refused, never skipped', () => {
  for (const [shape, script] of Object.entries(SHAPES))
    for (const verb of ['run', 'create', 'pull'])
      for (const kind of ['shell', 'workflow']) {
        const { errors, images } = validateInfraImagePins([asInput(kind, script(verb))], bare);
        assert.ok(
          images.some(({ ref }) => ref === 'alpine:latest') || errors.length > 0,
          `${shape} ${verb} ${kind}: ${JSON.stringify({ errors, images })}`,
        );
      }
});
// FU-092: a script a shell is told to run must be one of the run's shell files.
const credsFile = { kind: 'shell', name: 'infra/creds.sh', text: 'true' };
test('PR #727 r2 F2: the controls stay readable; computed eval and -c bodies refuse', () => {
  const ok = (body, policy = bare) => {
    const { errors } = validateInfraImagePins([credsFile, asInput('shell', body)], policy);
    assert.deepEqual(errors, [], body);
  };
  // FU-092: a script operand counts only when it is a shell file of the run.
  const withFile = (body) => [
    { kind: 'shell', name: 'infrastructure/x.sh', text: 'true' },
    asInput('shell', body),
  ];
  assert.deepEqual(validateInfraImagePins(withFile('bash infrastructure/x.sh'), bare).errors, []);
  ok(`docker run --rm --entrypoint sh node:22@${A} -c 'true'`);
  ok('cat <<EOF\n$HOME and \\$(not run)\nEOF');
  ok('echo $((count + 1))');
  ok('c="$(KAFKA_SECRETS_DIR="${d}" bash infra/creds.sh service x)"\neval "${c}"', {
    ...bare,
    evaluatedOutputs: new Map([['infra/creds.sh', 'prints exports only']]),
  });
  const refusedWith = (body, pattern, policy = bare) => {
    const { errors } = validateInfraImagePins([credsFile, asInput('shell', body)], policy);
    assert.ok(
      errors.some((error) => pattern.test(error)),
      `${body}: ${errors.join()}`,
    );
  };
  refusedWith('eval "$X"', /eval runs text this check cannot read/);
  const creds = { ...bare, evaluatedOutputs: new Map([['infra/creds.sh', 'prints exports only']]) };
  for (const body of [
    'c="$(bash infra/creds.sh)"\nc+="; docker run x"\neval "${c}"',
    'c="$(bash infra/creds.sh)"\nread -r c\neval "${c}"',
    'eval "${c}"\nc="$(bash infra/creds.sh)"',
  ])
    refusedWith(body, /eval runs text/, creds);
  refusedWith('bash --rcfile x.sh', /option --rcfile is not one this check reads/);
  refusedWith('c="$(bash other.sh)"\neval "${c}"', /eval runs text/);
  refusedWith('bash -c "$X"', /bash -c runs a body this check cannot read/);
  refusedWith('bash < x.sh', /reads its commands from a redirection/);
  refusedWith('bash -s x', /reads its commands from a pipe, a here-string or the terminal/);
  refusedWith('true', /EVALUATED_OUTPUTS lists a.sh, which nothing evaluates/, {
    ...bare,
    evaluatedOutputs: new Map([['a.sh', 'why']]),
  });
});

// FU-092 (PR #727 r2 F2 residuals): every expansion and evaluation stage keeps the execution it
// carries or refuses it. Each row is an escape that returned no image and no error on d409a643,
// while bash ran the docker command. `image`: the script is read and the image found; a pattern:
// refused with that reason. Three verbs x shell and workflow input.
const RESIDUALS = {
  'here-document operator before a quoted shell': [
    (v) => `<<'EOF' bash\ndocker ${v} alpine:latest\nEOF`,
    'image',
  ],
  'here-document operator before env bash': [
    (v) => `<<EOF env bash\ndocker ${v} alpine:latest\nEOF`,
    'image',
  ],
  // PR #805 r2 F1: the expanded text is what runs, so any expansion in the body refuses.
  'expanding here-document into bash, substitution in a comment': [
    (v) => `bash <<EOF\n# $(docker ${v} alpine:latest)\nEOF`,
    /expanding here-document read by a shell contains an expansion/,
  ],
  'expanding here-document into bash, substitution in single quotes': [
    (v) => `bash <<EOF\necho '$(docker ${v} alpine:latest)'\nEOF`,
    /expanding here-document read by a shell contains an expansion/,
  ],
  'escaped newline after $ in a here-document': [
    (v) => `cat <<EOF\n$\\\n(docker ${v} alpine:latest)\nEOF`,
    /line continuation after "\$"/,
  ],
  'escaped newline after $ in arithmetic': [
    (v) => `echo $(( 1 + $\\\n(docker ${v} alpine:latest) ))`,
    /line continuation after "\$"/,
  ],
  'escaped newline after $ in a parameter default': [
    (v) => `echo \${V:-$\\\n(docker ${v} alpine:latest)}`,
    /line continuation after "\$"/,
  ],
  'escaped newline after $ in a double-quoted word': [
    (v) => `echo "$\\\n(docker ${v} alpine:latest)"`,
    /line continuation after "\$"/,
  ],
  'bash +c': [(v) => `bash +c 'docker ${v} alpine:latest'`, 'image'],
  'bash +sc': [(v) => `bash +sc 'docker ${v} alpine:latest'`, 'image'],
  'bash -eo pipefail -c': [(v) => `bash -eo pipefail -c 'docker ${v} alpine:latest'`, 'image'],
  'bash with a computed option': [
    (v) => `OPT=-c; bash "$OPT" 'docker ${v} alpine:latest'`,
    /bash has a computed option or operand/,
  ],
  'a pipe into bash -': [
    (v) => `echo 'docker ${v} alpine:latest' | bash -`,
    /reads its commands from a pipe/,
  ],
  'a pipe into bash /dev/stdin': [
    (v) => `echo 'docker ${v} alpine:latest' | bash /dev/stdin`,
    /reads its commands from a pipe/,
  ],
  'a script that is not a CI shell file': [
    (v) => `printf '%s' 'docker ${v} alpine:latest' > tools/other.sh\nbash tools/other.sh`,
    /runs tools\/other\.sh, a script this check does not read/,
  ],
  'a literal here-string into bash': [(v) => `bash <<< 'docker ${v} alpine:latest'`, 'image'],
  'ash -c': [(v) => `ash -c 'docker ${v} alpine:latest'`, 'image'],
  'fish -c': [(v) => `fish -c 'docker ${v} alpine:latest'`, /syntax this check does not read/],
};
const outcome = (kind, body, policy = bare) => {
  const { errors, images } = validateInfraImagePins([asInput(kind, body)], policy);
  return { errors, found: images.some(({ ref }) => ref === 'alpine:latest') };
};
test('FU-092: shell dispatch, heredoc ownership and escaped newlines keep or refuse the execution', () => {
  for (const [shape, [script, expected]] of Object.entries(RESIDUALS))
    for (const verb of ['run', 'create', 'pull'])
      for (const kind of ['shell', 'workflow']) {
        const { errors, found } = outcome(kind, script(verb));
        const at = `${shape} ${verb} ${kind}: ${JSON.stringify(errors)}`;
        if (expected === 'image') assert.ok(found, at);
        else
          assert.ok(
            errors.some((error) => expected.test(error)),
            at,
          );
      }
});
test('FU-092: the controls stay readable', () => {
  const ok = (body) => assert.deepEqual(outcome('shell', body).errors, [], body);
  ok("<<'EOF' bash\necho hi\nEOF");
  ok("bash +c 'echo hi'");
  ok("bash -eo pipefail -c 'echo hi'");
  ok('bash <<< "echo hi"');
  ok('cat <<EOF\n$HOME \\\nand more\nEOF');
  const files = [
    { kind: 'shell', name: 'infrastructure/x.sh', text: 'true' },
    asInput('shell', 'bash -- ./infrastructure/x.sh'),
  ];
  assert.deepEqual(validateInfraImagePins(files, bare).errors, []);
});
test('FU-092: a workflow step that runs elsewhere does not read a relative script by name', () => {
  const yaml = (extra) =>
    stringify({
      jobs: { j: { steps: [{ run: 'bash infrastructure/x.sh', ...extra }] } },
    });
  const files = (text) => [
    { kind: 'shell', name: 'infrastructure/x.sh', text: 'true' },
    { kind: 'workflow', name: '.github/workflows/x.yml', text },
  ];
  assert.deepEqual(validateInfraImagePins(files(yaml({})), bare).errors, []);
  assert.match(
    validateInfraImagePins(files(yaml({ 'working-directory': 'tools' })), bare).errors.join(),
    /runs infrastructure\/x\.sh, a script this check does not read/,
  );
});
test('FU-092: shellInvocation reads bash the way bash reads its options', () => {
  const words = (...values) => values.map((value) => ({ value }));
  const run = (...values) => shellInvocation(words(...values), 'bash');
  assert.equal(run('+c', 'x').body.value, 'x');
  assert.equal(run('-ec', 'x').body.value, 'x');
  assert.equal(run('-co', 'pipefail', 'x').body.value, 'x');
  assert.equal(run('-o', 'pipefail', '-c', 'x').body.value, 'x');
  assert.equal(run('--norc', '-c', 'x').body.value, 'x');
  assert.equal(run('-sc', 'x').body.value, 'x'); // -c wins over -s, as in bash
  assert.equal(run('--', 'file.sh').file.value, 'file.sh');
  assert.equal(run('-', 'file.sh').file.value, 'file.sh'); // `-` is `--`
  assert.equal(run('file.sh', '-c').file.value, 'file.sh');
  assert.deepEqual(run('-s', 'x'), { stdin: true });
  assert.deepEqual(run(), { stdin: true });
  assert.deepEqual(run('-'), { stdin: true });
  for (const refused of [
    ['--rcfile', 'x'],
    ['--init-file', 'x'],
    ['+'],
    ['-1'],
    ['-c'],
    ['-o'],
    ['$X', 'y'],
    ['-c', '$X'],
    ['-o', '$X', '-c', 'y'],
  ])
    assert.ok(run(...refused).problem, refused.join(' '));
  assert.ok(shellInvocation([{ value: 'x', opaque: true }], 'bash').problem);
  assert.ok(shellInvocation(words('-c', 'x'), '/bin/fish').problem);
  assert.equal(continuedDollar('a$\\\n(', 1), true);
  assert.equal(continuedDollar('a$\\\n\\\n(', 1), true);
  assert.equal(continuedDollar('a$\\(', 1), false);
  assert.equal(continuedDollar('a\\\n$(', 1), false);
});
// FU-092 (PR #727 r2 F2, eval rows): an evaluated variable's provenance is proved, not counted.
// The one approved producer, assigned unconditionally in the group the eval runs in (or one
// above it), is the only way a variable is evaluated.
test('FU-092: eval of a producer output needs proven provenance', () => {
  const creds = { ...bare, evaluatedOutputs: new Map([['infra/creds.sh', 'prints exports only']]) };
  const producer = 'c="$(bash infra/creds.sh)"';
  const refusedWith = (body) => {
    const { errors } = validateInfraImagePins([credsFile, asInput('shell', body)], creds);
    assert.ok(
      errors.some((error) => /^scripts\/x\.sh:\d+: eval runs text/.test(error)),
      `${body}: ${errors.join()}`,
    );
  };
  const approved = (body) => {
    const { errors } = validateInfraImagePins([credsFile, asInput('shell', body)], creds);
    assert.deepEqual(errors, [], body);
  };
  approved(`${producer}\neval "\${c}"`);
  approved(`${producer}\n( eval "\${c}" && true )`);
  approved(`( ${producer} && eval "\${c}" )`);
  approved(`( ${producer} && eval "\${c}" && true & )`); // the same backgrounded list
  approved(`( ${producer} && d="$(bash infra/creds.sh)" && eval "\${c}" && eval "\${d}" )`);
  approved(`${producer}\neval "\${c}"\nfor n in 1 2; do echo "$n"; done`);
  for (const body of [
    // a computed variable NAME is written (the name never appears as text)
    `${producer}\nprintf -v "$(printf '\\143')" '%s' 'docker run alpine:latest'\neval "\${c}"`,
    `${producer}\nprintf "$fmt" c 'docker run alpine:latest'\neval "\${c}"`,
    `${producer}\nread -r "$name"\neval "\${c}"`,
    `${producer}\ndeclare -n ref=c\nref='docker run alpine:latest'\neval "\${c}"`,
    `${producer}\nsource ./other.sh\neval "\${c}"`,
    // a default assignment writes it
    `${producer}\n: "\${c:=docker run alpine:latest}"\neval "\${c}"`,
    // the producer may not run: a conditional block, a || list, a subshell, a function
    `if false; then\n  ${producer}\nfi\neval "\${c}"`,
    `false || ${producer}\neval "\${c}"`,
    `( ${producer} )\neval "\${c}"`,
    `f() {\n  ${producer}\n}\neval "\${c}"`,
    `true && ${producer}\neval "\${c}"`,
    `false &&\n${producer}\neval "\${c}"`,
    `${producer} &\neval "\${c}"`,
    `${producer} | cat\neval "\${c}"`,
    `${producer} && true &\neval "\${c}"`,
    // the eval is inside a block that may run it again with another value
    `${producer}\nwhile true; do eval "\${c}"; done`,
  ])
    refusedWith(body);
});

// PR #727 r2 F3: Dockerfile instructions are read with BuildKit's whitespace and
// continuation rules, and every Dockerfile must have a base instruction that was read.
test('PR #727 r2 F3: an indented, continued or lower-case FROM is read; none at all refuses', () => {
  for (const text of [
    ' FROM alpine:latest\n',
    '\tFROM alpine:latest\n',
    'FROM \\\n  alpine:latest\n',
    'from alpine:latest\n',
    `  FROM node:22@${A} AS a\n  FROM alpine:latest\n`,
  ]) {
    const { errors } = validateDockerfilePins([file(text)]);
    assert.ok(
      errors.some((error) => /FROM alpine:latest is not pinned by digest/.test(error)),
      `${JSON.stringify(text)}: ${errors.join()}`,
    );
  }
  for (const [text, pattern] of [
    ['RUN true\n', /no FROM instruction was read/],
    ['', /no FROM instruction was read/],
    ['# escape=`\nFROM alpine:latest\n', /the parser directive escape/],
    ['# syntax=example/other\nFROM alpine:latest\n', /the parser directive syntax/],
    [`FROM --platform=linux/amd64 node:22@${A}\n`, /is not a form this check reads/],
    [`FROM node:22@${A}\nRUN apk \\\n  upgrade\n`, /apk upgrade/],
    [`FROM node:22@${A}\nRUN <<EOF\nFROM x\nEOF\n`, /a here-document/],
    [`FROM node:22@${A}\nRUN true \\`, /a continuation that never ends/],
  ]) {
    const { errors } = validateDockerfilePins([file(text)]);
    assert.ok(
      errors.some((error) => pattern.test(error)),
      `${JSON.stringify(text)}: ${errors.join()}`,
    );
  }
  const good = `# syntax=docker/dockerfile:1.7\n# a note, then FROM inside text: FROM x\n  FROM node:22@${A} AS a\n  # a comment\n  FROM a\n`;
  assert.deepEqual(validateDockerfilePins([file(good)]).errors, []);
});

// PR #805 r2 F1: text that is generated, rewritten or handed to another program as a command
// string is never "nothing relevant". Each shape returned no image and no error on ea79eb47
// while bash ran the docker command: it is read (the image is found) or refused.
const GENERATED = {
  'expanding here-document into bash, substitution output as the script': `bash <<EOF\n$(printf '%s\\n' 'docker run alpine:latest')\nEOF`,
  'expanding here-document into bash, a variable as the script': `payload='docker run alpine:latest'\nbash <<EOF\n$payload\nEOF`,
  'a command substitution as the executable': `$(printf '%s%s run alpine:latest' dock er)`,
  'a variable as the executable': `c=docker\n$c run alpine:latest`,
  'a quoted variable as the executable behind env': `c=docker\nenv "$c" run alpine:latest`,
  'source of a here-document through /dev/stdin': `source /dev/stdin <<'EOF'\ndocker run alpine:latest\nEOF`,
  'dot of a here-document through /dev/stdin': `. /dev/stdin <<'EOF'\ndocker run alpine:latest\nEOF`,
  'source of a file that is not a CI shell file': `source tools/other.sh`,
  'xargs rewrites the shell text': `printf '%s\\n' 'docker run alpine:latest' | xargs -I{} bash -c '{}'`,
  'find -exec rewrites the shell text': `find . -maxdepth 0 -exec sh -c '{}' \\;`,
  'flock command string': `flock /tmp/l -c 'docker run alpine:latest'`,
  'su command string': `su -c 'docker run alpine:latest' nobody`,
  'script command string': `script -qc 'docker run alpine:latest' /dev/null`,
  'ssh command string': `ssh host 'docker run alpine:latest'`,
  'watch command string': `watch -n1 'docker run alpine:latest'`,
  'flock behind env options': `env -u FOO flock /tmp/l -c 'docker run alpine:latest'`,
  'ssh behind timeout operands': `timeout 5 ssh host 'docker run alpine:latest'`,
  'sudo -s command string': `sudo -s 'docker run alpine:latest'`,
  'a computed command string for su': `cmd='docker run alpine:latest'\nsu -c "$cmd" nobody`,
  'commands piped into ssh': `printf '%s\\n' 'docker run alpine:latest' | ssh host`,
  'env -S splits a string into a command': `env -S 'docker run alpine:latest'`,
  alias: `alias d='docker run alpine:latest'\nd`,
  'trap handler': `trap 'docker run alpine:latest' EXIT`,
  'trap handler behind a computed text': `h='docker run alpine:latest'\ntrap "$h" EXIT`,
  'BASH_ENV assigned in the script': `BASH_ENV=./other.sh bash -c true`,
  'BASH_ENV exported': `export BASH_ENV=./other.sh\nbash -c true`,
  'BASH_ENV behind env': `env BASH_ENV=./other.sh bash -c true`,
};
test('PR #805 r2 F1: generated and rewritten shell text is read or refused, never dropped', () => {
  for (const [shape, script] of Object.entries(GENERATED))
    for (const kind of ['shell', 'workflow']) {
      const { errors, found } = outcome(kind, script);
      assert.ok(errors.length > 0 || found, `${shape} (${kind}): nothing read, nothing refused`);
    }
});
test('PR #805 r2 F1: a workflow env that a shell evaluates at startup refuses', () => {
  for (const level of ['workflow', 'job', 'step']) {
    const step = { run: 'true', ...(level === 'step' && { env: { BASH_ENV: './x.sh' } }) };
    const doc = {
      ...(level === 'workflow' && { env: { BASH_ENV: './x.sh' } }),
      jobs: { j: { ...(level === 'job' && { env: { BASH_ENV: './x.sh' } }), steps: [step] } },
    };
    const { errors } = validateInfraImagePins(
      [{ kind: 'workflow', name: '.github/workflows/x.yml', text: stringify(doc) }],
      bare,
    );
    assert.ok(
      errors.some((error) => /env sets BASH_ENV/.test(error)),
      level,
    );
  }
});
test('PR #805 r2 F1: string runners keep the command string they carry', () => {
  for (const script of [
    `flock /tmp/l -c 'docker run alpine:latest'`,
    `su -c 'docker run alpine:latest' nobody`,
    `script -qc 'docker run alpine:latest' /dev/null`,
    `ssh host 'docker run alpine:latest'`,
    `watch -n1 'docker run alpine:latest'`,
    `trap 'docker run alpine:latest' EXIT`,
  ])
    assert.ok(outcome('shell', script).found, script);
});
test('PR #805 r2 F1: the harmless controls stay readable', () => {
  for (const body of [
    "flock /tmp/l -c 'echo hi'",
    "ssh host 'uptime'",
    "trap 'echo bye' EXIT",
    'trap - EXIT\ntrap -l',
    'bash <<EOF\necho hi\nEOF',
    "bash <<'EOF'\necho $HOME\nEOF",
    'cat <<EOF\n$HOME\nEOF',
    'x=$(date)\necho "$x"',
    'timeout 5 sleep 1',
    'env FOO=1 true',
    'BASH_ENV_NOT=1 true',
  ])
    assert.deepEqual(outcome('shell', body).errors, [], body);
});

// PR #805 r2 F2: the eval exemption proves where the evaluated variable came from. Every row
// is a producer that did not reach the evaluating shell, or a write the first-word reader of
// ea79eb47 did not see; each was approved there and printed the docker marker under bash.
test('PR #805 r2 F2: eval provenance survives prefixes, declarations and list boundaries', () => {
  const creds = { ...bare, evaluatedOutputs: new Map([['infra/creds.sh', 'prints exports only']]) };
  const producer = 'c="$(bash infra/creds.sh)"';
  const evaluate = (body) => validateInfraImagePins([credsFile, asInput('shell', body)], creds);
  assert.deepEqual(evaluate(`${producer}\neval "\${c}"`).errors, []);
  for (const body of [
    `${producer}\nbuiltin printf -v "$(printf '\\143')" '%s' 'docker run alpine:latest'\neval "\${c}"`,
    `${producer}\ncommand printf -v "$(printf '\\143')" '%s' 'docker run alpine:latest'\neval "\${c}"`,
    `${producer}\nbuiltin read -r "$name"\neval "\${c}"`,
    `${producer}\ncommand read -r "$name"\neval "\${c}"`,
    `${producer}\nbuiltin declare -n ref=c\nref=x\neval "\${c}"`,
    `${producer}\ncommand -p printf -v "$n" x\neval "\${c}"`,
    `function f { ${producer}; }\neval "\${c}"`,
    `function f {\n  ${producer}\n}\neval "\${c}"`,
    `coproc { ${producer}; }\neval "\${c}"`,
    `coproc NAMED { ${producer}; }\neval "\${c}"`,
    `time if false; then\n  ${producer}\nfi\neval "\${c}"`,
    `! if false; then\n  ${producer}\nfi\neval "\${c}"`,
    `time while false; do\n  ${producer}\ndone\neval "\${c}"`,
    `time case x in y)\n  ${producer}\n  ;;\nesac\neval "\${c}"`,
    `! { ${producer}; }\neval "\${c}"`,
    `${producer} || true &\neval "\${c}"`,
    `${producer} || true &\n( eval "\${c}" )`,
    `${producer} || exit 1 &\neval "\${c}"`,
  ])
    assert.ok(
      evaluate(body).errors.some((error) => /^scripts\/x\.sh:\d+: eval runs text/.test(error)),
      body,
    );
  // a list that ends before the background marker is still the producer's own
  assert.deepEqual(evaluate(`${producer} || true\neval "\${c}"`).errors, []);
  // the real CI shape: top-level producer, evaluated in a backgrounded subshell
  assert.deepEqual(evaluate(`${producer}\n( eval "\${c}" && true & )`).errors, []);
});

// FU-150 F1: the program that runs is found through ONE execution boundary: control words,
// wrappers with option arity, xargs and find -exec. Each of these 84 calls returned no image and no
// error on 75bf3243 while bash ran `docker <verb> alpine:latest`.
const BEHIND = {
  if: (r) => `c=docker\nif $c ${r}; then :; fi`,
  then: (r) => `c=docker\nif true; then $c ${r}; fi`,
  else: (r) => `c=docker\nif false; then :; else $c ${r}; fi`,
  elif: (r) => `c=docker\nif false; then :; elif $c ${r}; then :; fi`,
  do: (r) => `c=docker\nfor i in 1; do $c ${r}; done`,
  while: (r) => `c=docker\nwhile $c ${r}; do break; done`,
  brace: (r) => `c=docker\n{ $c ${r}; }`,
  '/usr/bin/env': (r) => `c=docker\n/usr/bin/env $c ${r}`,
  'env -u X': (r) => `c=docker\nenv -u FOO $c ${r}`,
  'timeout -s SIG N': (r) => `c=docker\ntimeout -s TERM 5 $c ${r}`,
  'sudo -u U': (r) => `c=docker\nsudo -u root $c ${r}`,
  'stdbuf -o L': (r) => `c=docker\nstdbuf -o L $c ${r}`,
  xargs: (r) => `c=docker\nprintf '%s\\n' x | xargs -I{} $c ${r}`,
  'find -exec': (r) => `c=docker\nfind . -maxdepth 0 -exec $c ${r} \\;`,
};
test('FU-150 F1: a computed program behind a control word or a wrapper refuses', () => {
  for (const [shape, script] of Object.entries(BEHIND))
    for (const verb of ['run', 'create', 'pull'])
      for (const kind of ['shell', 'workflow']) {
        const { errors, found } = outcome(kind, script(`${verb} alpine:latest`));
        assert.ok(
          errors.some((error) => /runs the command word \$c/.test(error)) || found,
          `${shape} ${verb} ${kind}: ${JSON.stringify(errors)}`,
        );
      }
});
test('FU-150 F1: nested wrappers, other control words and unknown wrapper options refuse', () => {
  for (const script of [
    'env -u X timeout -s TERM 5 nice -n 5 $c run alpine:latest',
    'flock /tmp/l $c run alpine:latest',
    'coproc $c run alpine:latest',
    'coproc NAMED { $c run alpine:latest; }',
    'function f { $c run alpine:latest; }',
    'case x in y) $c run alpine:latest;; esac',
    'time -p $c run alpine:latest',
    'if ! $c run alpine:latest; then :; fi',
    'nohup $c run alpine:latest',
    'xargs xargs $c run alpine:latest',
    'find . -exec env $c run alpine:latest \\;',
    'find . -execdir $c run alpine:latest +',
    'exec -a name $c run alpine:latest',
    'ionice -c 3 $c run alpine:latest',
    'sudo -uroot "${c}" run alpine:latest',
    // an option the wrapper table does not list is not read past
    'timeout --bogus 5 docker version',
    'sudo -Z true',
    'sudo --user root $c run alpine:latest',
    'sudo --user=root $c run alpine:latest',
    'timeout --signal TERM 5 $c run alpine:latest',
    'xargs --bogus true',
    // a redirection in front of the command word is not the command word
    '>/dev/null $c run alpine:latest',
    '2>&1 $c run alpine:latest',
    '>&2 $c run alpine:latest',
    'env -u X >/dev/null $c run alpine:latest',
    'exec >/dev/null $c run alpine:latest',
    'timeout 5 2>/dev/null $c run alpine:latest',
    '< /dev/null $c run alpine:latest',
    'timeout >/dev/null 5 $c run alpine:latest',
    'flock 2>/dev/null /tmp/l $c run alpine:latest',
    // a program the shell expands from a pattern
    '{docker,run} alpine:latest',
    'docker* run alpine:latest',
    '/usr/bin/doc?er run alpine:latest',
    'env - $c run alpine:latest',
    // a one-word command in a case body that is computed is not a pattern
    'case x in a)\n  $c\n  ;;\nesac',
    // sourcing and trapping behind a control word or a wrapper
    'if true; then source tools/other.sh; fi',
    'env -u X . tools/other.sh',
    'while true; do trap "$h" EXIT; done',
  ])
    assert.ok(outcome('shell', script).errors.length > 0, script);
});
test('FU-150 F1: wrappers and control words that run a literal program stay readable', () => {
  for (const body of [
    'env -u FOO true',
    'env A=1 B=2 true',
    '/usr/bin/env true',
    'timeout -s TERM 5 sleep 1',
    'timeout -k5 10 sleep 1',
    'sudo -u root true',
    'sudo -uroot -n true',
    'stdbuf -o L cat',
    'nice -n 5 sleep 1',
    'nice -5 sleep 1',
    'if true; then echo hi; elif false; then echo no; else echo x; fi',
    'for i in 1 2; do echo "$i"; done',
    'while read -r line; do echo "$line"; done <<< x',
    'command -v "$tool" >/dev/null',
    'printf "%s\\n" x | xargs -n1 -I{} echo {}',
    'find . -maxdepth 1 -exec echo {} \\;',
    'find . -maxdepth 1 -exec env -u FOO echo {} +',
    'f() { echo hi; }; f',
    'case "$x" in a) echo a;; b|c) echo b;; esac',
    'time -p true',
    '>/dev/null true',
    '2>&1 true',
    '>&2 echo hi',
    'exec >/dev/null',
    'exec 3>&1',
    'timeout 5 >/dev/null true',
    'true 2>&1 | cat',
    '[[ "$a" > "$b" ]] && true',
    '[ -n x ] && [[ -n y ]] && true',
    'case "$x" in\n  *-service | other) echo a ;;\n  #*) echo b ;;\n  *) echo c ;;\nesac',
    'case "$x" in a | b) true ;; esac',
    // an assignment's value is not a command, whatever its last path component is called
    'X=dir/alias true',
    'export Y=dir/trap',
    'sudo --user root true',
  ])
    assert.deepEqual(outcome('shell', body).errors, [], body);
  // a literal docker behind the same wrappers is still read as a docker command
  for (const body of [
    'env -u FOO docker run alpine:latest',
    'timeout -s TERM 5 docker run alpine:latest',
    'if true; then sudo -u root docker run alpine:latest; fi',
    "printf '%s\\n' x | xargs -I{} docker run alpine:latest",
    'find . -maxdepth 0 -exec docker run alpine:latest \\;',
  ])
    assert.ok(outcome('shell', body).found, body);
});

// FU-150 F1: `source` runs the file the EXACT path names, and only a CI .sh file this run read
// or a .bash library whose sha256 a reviewer pinned. 75bf3243 matched by suffix.
const libText = 'role_password() { :; }\n';
const sha = (text) => createHash('sha256').update(text).digest('hex');
const LIB = 'infrastructure/docker/postgres/lib/role-passwords.bash';
const withLibrary = {
  ...bare,
  sourcedLibraries: new Map([[LIB, { sha256: sha(libText), reason: 'x' }]]),
};
const library = (text = libText, name = LIB) => ({ kind: 'library', name, text });
const sourcing = (word, name = 'infrastructure/docker/postgres/init.sh') => ({
  kind: 'shell',
  name,
  text: `source ${word}\n`,
});
const sourceErrors = (script, libs = [library()]) =>
  validateInfraImagePins([...libs, script], withLibrary).errors;
test('FU-150 F1: source resolves the exact path of a verified library', () => {
  assert.deepEqual(
    sourceErrors(sourcing(`"$(dirname "\${BASH_SOURCE[0]}")/lib/role-passwords.bash"`)),
    [],
  );
  assert.deepEqual(sourceErrors(sourcing('"$(dirname "$0")/lib/role-passwords.bash"')), []);
  // `..` is normalised: the path that results is the exact one
  assert.deepEqual(
    sourceErrors(
      sourcing(
        '"$(dirname "$0")/../postgres/lib/role-passwords.bash"',
        'infrastructure/docker/other/init.sh',
      ),
    ),
    [],
  );
  assert.deepEqual(sourceErrors(sourcing(LIB, 'scripts/x.sh')), []);
  assert.deepEqual(sourceErrors(sourcing(`./${LIB}`, 'scripts/x.sh')), []);
  for (const [word, name] of [
    // the reviewer's probe: an arbitrary directory selects other contents
    ['"${UNTRUSTED}/lib/role-passwords.bash"', undefined],
    ['"${UNTRUSTED}/infrastructure/docker/postgres/lib/role-passwords.bash"', undefined],
    [`"$HOME/${LIB}"`, undefined],
    // a suffix of the listed path is not the path
    [`evil/${LIB}`, 'scripts/x.sh'],
    ['"$(dirname "$0")/lib/role-passwords.bash"', 'scripts/x.sh'],
    ['"$(dirname "$0")/../postgres/lib/role-passwords.bash"', 'scripts/x.sh'],
    ['"$(pwd)/lib/role-passwords.bash"', undefined],
    ['"$(dirname "$1")/lib/role-passwords.bash"', undefined],
    ['"$(cd x; dirname "$0")/lib/role-passwords.bash"', undefined],
    ['"$(dirname "$0")/lib/$name.bash"', undefined],
    ['"$(dirname "$0")/lib/*.bash"', undefined],
    [`${LIB.replace('role', 'other')}`, 'scripts/x.sh'],
    [`/${LIB}`, 'scripts/x.sh'],
  ])
    assert.ok(
      sourceErrors(sourcing(word, name)).some((error) => /source runs .*does not read/.test(error)),
      word,
    );
  // `$0` of a nested script is not the file's own
  const nested = {
    kind: 'shell',
    name: 'infrastructure/docker/postgres/init.sh',
    text: `bash <<'EOF'\nsource "$(dirname "$0")/lib/role-passwords.bash"\nEOF\n`,
  };
  assert.ok(sourceErrors(nested).some((error) => /source runs/.test(error)));
});
test('FU-150 F1: a library is read by contents: unlisted, changed or unread refuses', () => {
  const script = sourcing(LIB, 'scripts/x.sh');
  assert.ok(
    sourceErrors(script, [library('changed\n')]).some((e) =>
      /contents changed \(sha256 [0-9a-f]{64}\)/.test(e),
    ),
  );
  assert.ok(sourceErrors(script, [library('changed\n')]).some((e) => /source runs/.test(e)));
  assert.ok(sourceErrors(script, []).some((e) => /source runs/.test(e)));
  assert.ok(
    sourceErrors(script, [library(libText, 'infrastructure/new/lib.bash'), library()]).some((e) =>
      /infrastructure\/new\/lib\.bash: a \.bash file no reviewed list names/.test(e),
    ),
  );
  // text a hash of the decoded characters cannot tell apart refuses, even with the listed hash
  for (const text of ['x\uFFFD\n', 'x\r\n']) {
    const listed = {
      ...withLibrary,
      sourcedLibraries: new Map([[LIB, { sha256: sha(text), reason: 'x' }]]),
    };
    const { errors } = validateInfraImagePins([library(text), script], listed);
    assert.ok(
      errors.some((e) => /cannot be read/.test(e)),
      JSON.stringify(text),
    );
    assert.ok(
      errors.some((e) => /source runs/.test(e)),
      JSON.stringify(text),
    );
  }
  // once libraries are passed, a listed one the run did not find is stale
  const two = {
    ...withLibrary,
    sourcedLibraries: new Map([
      ...withLibrary.sourcedLibraries,
      ['scripts/gone.bash', { sha256: 'x', reason: 'x' }],
    ]),
  };
  assert.ok(
    validateInfraImagePins([library()], two).errors.some((e) =>
      /lists scripts\/gone\.bash, which was not found/.test(e),
    ),
  );
  // a library is never run as a script
  assert.ok(
    sourceErrors({ kind: 'shell', name: 'scripts/x.sh', text: `bash ${LIB}\n` }).some((e) =>
      /runs infrastructure.*does not read/.test(e),
    ),
  );
});
test('FU-150 F1: the CLI reads every .bash file of infrastructure/ and scripts/', () => {
  const cli = readFileSync(join(root, 'scripts', 'check-dockerfile-pins.mjs'), 'utf8');
  assert.match(cli, /\\\.\(\?:sh\|bash\)\$/);
  assert.match(cli, /'library'/);
  // and the committed libraries are exactly the listed ones, with the pinned contents
  // Git's file list (the inventory), never a walk: repo-relative, '/'-separated.
  const found = ['infrastructure', 'scripts']
    .flatMap((dir) => authoredFiles(join(root, dir)))
    .filter((f) => f.endsWith('.bash'))
    .map((f) => relative(root, f).split(sep).join('/'));
  assert.deepEqual([...SOURCED_LIBRARIES.keys()].sort(), found.sort());
});

// FU-150 F2: a write the checker cannot attribute to a name breaks the provenance of an evaluated
// variable wherever the writing command stands, not only as the first word of a line.
const creds150 = {
  ...bare,
  evaluatedOutputs: new Map([['infra/creds.sh', 'prints exports only']]),
};
test('FU-150 F2: writers after control words, in functions and with attached options refuse', () => {
  const producer = 'c="$(bash infra/creds.sh)"';
  const dynamic = `printf -v "$(printf '\\143')" '%s' 'docker run alpine:latest'`;
  const evaluate = (body) =>
    validateInfraImagePins([credsFile, asInput('shell', body)], creds150).errors;
  const refused = (body) =>
    assert.ok(
      evaluate(body).some((e) => /^scripts\/x\.sh:\d+: eval runs text/.test(e)),
      body,
    );
  for (const writer of [
    `if ${dynamic}; then :; fi`,
    `if true; then ${dynamic}; fi`,
    `if false; then :; else ${dynamic}; fi`,
    `if false; then :; elif ${dynamic}; then :; fi`,
    `for i in 1; do ${dynamic}; done`,
    `while ${dynamic}; do break; done`,
    `until ${dynamic}; do break; done`,
    `{ ${dynamic}; }`,
    `f() { ${dynamic}; }; f`,
    `function f { ${dynamic}; }; f`,
    `if true; then builtin ${dynamic}; fi`,
    `if true; then time -p ${dynamic}; fi`,
    "printf -vc '%s' x",
    "if true; then printf -vc '%s' x; fi",
    'read -ac <<<x',
    'if true; then read -r "$name"; fi',
    'if true; then declare -n ref=c; fi',
    'if true; then source ./other.sh; fi',
    // a computed target inside arithmetic (the name is built, never written as text)
    `n="$(printf '\\143')"\n(( \${n}=5 ))`,
    `n="$(printf '\\143')"\nx=$(( \${n}=5 ))`,
    `n="$(printf '\\143')"\nif (( \${n}=5 )); then :; fi`,
    // a declaration whose name is computed
    'export "$n=docker run alpine:latest"',
    'if true; then export "$(printf c)=x"; fi',
    // an exempt line is not read for its command word, but it may still write
    `timeout --bogus 5 printf -v "$(printf '\\143')" x # image-pin-exempt: reason\ntrue\ntrue`,
  ])
    refused(`${producer}\n${writer}\neval "\${c}"`);
  // the unrelated writers of the same shape do not break the real producer/eval shape
  for (const body of [
    `${producer}\nif true; then printf -v other '%s' x; fi\neval "\${c}"`,
    `${producer}\nfor i in 1; do echo "$i"; done\neval "\${c}"`,
    `${producer}\n{ echo hi; }\neval "\${c}"`,
    `${producer}\n( eval "\${c}" && true & )`,
    `${producer}\nn="$(printf '\\143')"\n(( n=5 ))\neval "\${c}"`,
  ])
    assert.deepEqual(evaluate(body), [], body);
});
