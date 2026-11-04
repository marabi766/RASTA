import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';
import {
  DIGEST_VARIANTS,
  TAGLESS,
  tokenizeShell,
  validateDockerfilePins,
  validateInfraImagePins,
} from './check-dockerfile-pins-lib.mjs';

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
test('PR #727 r2 F2: the controls stay readable; computed eval and -c bodies refuse', () => {
  const ok = (body, policy = bare) => {
    const { errors } = validateInfraImagePins([asInput('shell', body)], policy);
    assert.deepEqual(errors, [], body);
  };
  ok('bash infrastructure/x.sh');
  ok(`docker run --rm --entrypoint sh node:22@${A} -c 'true'`);
  ok('cat <<EOF\n$HOME and \\$(not run)\nEOF');
  ok('echo $((count + 1))');
  ok('c="$(KAFKA_SECRETS_DIR="${d}" bash infra/creds.sh service x)"\neval "${c}"', {
    ...bare,
    evaluatedOutputs: new Map([['infra/creds.sh', 'prints exports only']]),
  });
  const refusedWith = (body, pattern, policy = bare) => {
    const { errors } = validateInfraImagePins([asInput('shell', body)], policy);
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
