import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';
import {
  parsedProblems,
  UNBOUNDED_EXCEPTIONS,
  unitStepProblems,
} from './check-unit-step-concurrency-lib.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const realWorkflow = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
const realScripts = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts;
const realDoc = parse(realWorkflow);
const [exception] = UNBOUNDED_EXCEPTIONS;
const unitStep = (doc) => doc.jobs.quality.steps.find((step) => step.name === 'Unit tests');
const securityStep = (doc) =>
  doc.jobs[exception.job].steps.find((step) => step.name === exception.step);
const problemsAfter = (edit, scripts = realScripts) => {
  const doc = structuredClone(realDoc);
  edit(doc);
  return parsedProblems({ 'ci.yml': doc }, scripts);
};
const refused = (problems, pattern) =>
  assert.ok(
    problems.some((problem) => pattern.test(problem)),
    JSON.stringify(problems),
  );
const extraRun = (run, job = 'quality') =>
  problemsAfter((doc) => doc.jobs[job].steps.push({ name: 'Another command', run }));

test('real workflow passes as YAML and as parsed text', () => {
  assert.deepEqual(unitStepProblems({ 'ci.yml': realWorkflow }, realScripts), []);
  assert.deepEqual(
    problemsAfter(() => {}),
    [],
  );
  assert.equal(realScripts['test:unit'], 'turbo run test:unit');
});

for (const value of ['1', '3', '12']) {
  test(`root bound accepts positive integer ${value} without duplicating the configured number`, () => {
    assert.deepEqual(
      problemsAfter(() => {}, {
        ...realScripts,
        'test:unit:ci': `turbo run test:unit --concurrency=${value}`,
      }),
      [],
    );
  });
}
for (const script of [
  undefined,
  'turbo run test:unit',
  'turbo run test:unit --concurrency=0',
  'turbo run test:unit --concurrency=50%',
  'turbo run test:unit -- --concurrency=3',
  'turbo run test:unit --concurrency=3 --concurrency=4',
  'pnpm exec jest --concurrency=3',
  'turbo run test:unit --concurrency=3; true',
]) {
  test(`invalid root bound: ${script}`, () => {
    refused(
      problemsAfter(() => {}, { ...realScripts, 'test:unit:ci': script }),
      /package.json test:unit:ci/,
    );
  });
}
for (const [name, edit, pattern] of [
  [
    'missing',
    (doc) => {
      doc.jobs.quality.steps = doc.jobs.quality.steps.filter((step) => step.name !== 'Unit tests');
    },
    /found 0/,
  ],
  [
    'renamed',
    (doc) => {
      unitStep(doc).name = 'Tests';
    },
    /found 0/,
  ],
  [
    'moved job',
    (doc) => {
      doc.jobs.security.steps.push(unitStep(doc));
      doc.jobs.quality.steps = doc.jobs.quality.steps.filter((step) => step.name !== 'Unit tests');
    },
    /found 0/,
  ],
  [
    'duplicate',
    (doc) => {
      doc.jobs.quality.steps.push({ ...unitStep(doc) });
    },
    /found 2/,
  ],
  [
    'duplicate with different run',
    (doc) => {
      doc.jobs.quality.steps.push({ name: 'Unit tests', run: 'echo test' });
    },
    /found 2/,
  ],
  [
    'wrong run',
    (doc) => {
      unitStep(doc).run = 'pnpm run test:unit';
    },
    /run must be exactly/,
  ],
  [
    'extra line',
    (doc) => {
      unitStep(doc).run += '\necho done';
    },
    /run must be exactly/,
  ],
  [
    'missing run',
    (doc) => {
      delete unitStep(doc).run;
    },
    /run must be exactly/,
  ],
]) {
  test(`bounded step ${name} is refused`, () => refused(problemsAfter(edit), pattern));
}
for (const level of ['step', 'job']) {
  for (const key of ['if', 'continue-on-error']) {
    for (const value of [false, true, '${{ false }}', 'always()']) {
      test(`${level} ${key}: ${value} is refused`, () => {
        refused(
          problemsAfter((doc) => {
            (level === 'step' ? unitStep(doc) : doc.jobs.quality)[key] = value;
          }),
          new RegExp(`${level} must not set ${key}`),
        );
      });
    }
  }
}
for (const command of [
  'pnpm run test:unit',
  'pnpm test:unit',
  'pnpm -w test:unit',
  'pnpm --filter @rasta/web run test:unit',
  'pnpm run test',
  'pnpm test',
  'pnpm -r test',
  'turbo run test:unit',
  'turbo test:unit',
  'turbo run test',
  'pnpm exec turbo run test:unit',
  'npx turbo run test:unit',
  'node scripts/run-test-phases.mjs test',
  './scripts/run-test-phases.mjs test',
  'echo start && pnpm run test:unit',
  'true; pnpm test',
  'turbo run test:unit --concurrency=0',
  'turbo run test:unit --concurrency=50%',
  'turbo run test:unit -- --concurrency=3',
  'turbo run test:unit --concurrency=3 --concurrency=4',
]) {
  test(`literal unbounded invocation refused: ${command}`, () =>
    refused(extraRun(command), /literal unbounded unit invocation/));
}
for (const job of ['quality', 'security', 'integration-security']) {
  test(`all jobs scanned: ${job}`, () =>
    refused(extraRun('echo start\npnpm test', job), /literal unbounded/));
}
for (const command of [
  'pnpm run format:check --ignore-path test',
  'pnpm --filter @rasta/web exec playwright test',
  'pnpm run test:unit-step-concurrency',
  'pnpm run test:integration',
  'pnpm run test:coverage',
  'turbo run build',
  'turbo run build --filter test:unit',
  'pnpm --filter test run format:check',
  'turbo run test:unit --concurrency=3',
  'turbo run test:unit --concurrency 2',
  'pnpm exec turbo run test:unit --concurrency=3',
  'echo "pnpm run test:unit"',
]) {
  test(`command-position control accepted: ${command}`, () =>
    assert.deepEqual(extraRun(command), []));
}
for (const [name, edit] of [
  [
    'removed',
    (doc) => {
      securityStep(doc).run = 'echo nothing';
    },
  ],
  [
    'duplicate line',
    (doc) => {
      securityStep(doc).run += `\n${exception.command}`;
    },
  ],
  [
    'duplicate step',
    (doc) => {
      doc.jobs[exception.job].steps.push({ ...securityStep(doc) });
    },
  ],
  [
    'changed command',
    (doc) => {
      securityStep(doc).run = securityStep(doc).run.replace('subtree visibility', 'other');
    },
  ],
  [
    'changed name',
    (doc) => {
      securityStep(doc).name = 'Different';
    },
  ],
  [
    'changed job',
    (doc) => {
      doc.jobs.quality.steps.push(securityStep(doc));
      doc.jobs[exception.job].steps = doc.jobs[exception.job].steps.filter(
        (step) => step.name !== exception.step,
      );
    },
  ],
]) {
  test(`exception ${name} is refused`, () =>
    refused(problemsAfter(edit), /must match exactly once/));
}
test('exception workflow identity is exact', () => {
  const doc = structuredClone(realDoc);
  const step = securityStep(doc);
  step.run = 'echo removed';
  refused(
    parsedProblems(
      {
        'ci.yml': doc,
        'other.yml': {
          jobs: { [exception.job]: { steps: [{ name: exception.step, run: exception.command }] } },
        },
      },
      realScripts,
    ),
    /literal unbounded/,
  );
});
test('other workflows and composite metadata are scanned', () => {
  for (const [file, doc] of [
    ['other.yaml', { jobs: { other: { steps: [{ run: 'pnpm test' }] } } }],
    ['local/ci/unit/action.yaml', { runs: { using: 'composite', steps: [{ run: 'pnpm test' }] } }],
  ])
    refused(parsedProblems({ 'ci.yml': realDoc, [file]: doc }, realScripts), /literal unbounded/);
});
test('malformed YAML, duplicate keys, unreadable documents and scalar documents fail closed', () => {
  for (const text of ['jobs: [', 'jobs: {}\njobs: {}', new Error('unreadable'), 'null', 'hello']) {
    refused(
      unitStepProblems({ 'ci.yml': realWorkflow, 'other.yml': text }, realScripts),
      /not readable YAML/,
    );
  }
});
test('YAML merge keys cannot hide a skipped unit step', () => {
  const doc = structuredClone(realDoc);
  unitStep(doc)['<<'] = { if: false };
  refused(unitStepProblems({ 'ci.yml': stringify(doc) }, realScripts), /step must not set if/);
});

/** Exercise actual CLI discovery in a disposable repository-shaped filesystem. */
function cliFixture(t) {
  const fixture = mkdtempSync(join(tmpdir(), 'unit-tripwire-'));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const write = (path, text) => {
    mkdirSync(dirname(join(fixture, path)), { recursive: true });
    writeFileSync(join(fixture, path), text);
  };
  mkdirSync(join(fixture, 'scripts'));
  for (const name of ['check-unit-step-concurrency.mjs', 'check-unit-step-concurrency-lib.mjs'])
    cpSync(join(root, 'scripts', name), join(fixture, 'scripts', name));
  symlinkSync(join(root, 'node_modules'), join(fixture, 'node_modules'), 'dir');
  write('package.json', JSON.stringify({ type: 'module', scripts: realScripts }));
  const doc = structuredClone(realDoc);
  // The real main may gain composites unrelated to this fixture.
  for (const job of Object.values(doc.jobs))
    job.steps = job.steps?.filter((step) => !step.uses?.startsWith('./'));
  const workflow = () => write('.github/workflows/ci.yml', stringify(doc));
  workflow();
  return {
    write,
    doc,
    workflow,
    run: () =>
      spawnSync(process.execPath, [join(fixture, 'scripts/check-unit-step-concurrency.mjs')], {
        encoding: 'utf8',
        timeout: 10000,
      }),
  };
}
test('CLI follows arbitrary local uses recursively, both metadata extensions, and handles cycles', (t) => {
  const fixture = cliFixture(t);
  fixture.doc.jobs.quality.steps.push({ uses: './ci/outer' });
  fixture.workflow();
  fixture.write(
    'ci/outer/action.yml',
    stringify({ runs: { using: 'composite', steps: [{ uses: './tools/inner' }] } }),
  );
  fixture.write(
    'tools/inner/action.yaml',
    stringify({
      runs: { using: 'composite', steps: [{ uses: './ci/outer' }, { run: 'echo safe' }] },
    }),
  );
  assert.equal(fixture.run().status, 0);
  fixture.write(
    'tools/inner/action.yaml',
    stringify({
      runs: { using: 'composite', steps: [{ uses: './ci/outer' }, { run: 'pnpm test' }] },
    }),
  );
  const result = fixture.run();
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /local\/tools\/inner\/action.yaml.*literal unbounded/);
});
for (const metadata of ['missing', 'malformed', 'unreadable']) {
  test(`CLI refuses ${metadata} referenced action metadata`, (t) => {
    const fixture = cliFixture(t);
    fixture.doc.jobs.quality.steps.push({ uses: './ci/broken' });
    fixture.workflow();
    if (metadata === 'malformed') fixture.write('ci/broken/action.yml', 'runs: [');
    // A directory at the metadata path is unreadable as a file even as root.
    if (metadata === 'unreadable') fixture.write('ci/broken/action.yml/child', '');
    const result = fixture.run();
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /local\/ci\/broken\/action.yml: not readable YAML/);
  });
}

test('workflow line endings are normalized before parsing (CRLF and CR)', () => {
  for (const newline of ['\r\n', '\r']) {
    assert.deepEqual(
      unitStepProblems({ 'ci.yml': realWorkflow.replaceAll('\n', newline) }, realScripts),
      [],
    );
  }
});
test('CLI scans conventional action metadata even before a workflow references it', (t) => {
  const fixture = cliFixture(t);
  fixture.write(
    '.github/actions/future/action.yaml',
    stringify({ runs: { using: 'composite', steps: [{ run: 'pnpm test' }] } }),
  );
  const result = fixture.run();
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /local\/\.github\/actions\/future\/action.yaml.*literal unbounded/);
});

test('CLI normalizes CR-only workflow and composite metadata before discovery', (t) => {
  const fixture = cliFixture(t);
  fixture.doc.jobs.quality.steps.push({ uses: './ci/outer' });
  fixture.write('.github/workflows/ci.yml', stringify(fixture.doc).replaceAll('\n', '\r'));
  fixture.write(
    'ci/outer/action.yml',
    stringify({ runs: { using: 'composite', steps: [{ uses: './ci/inner' }] } }).replaceAll(
      '\n',
      '\r',
    ),
  );
  fixture.write(
    'ci/inner/action.yml',
    stringify({ runs: { using: 'composite', steps: [{ run: 'pnpm test' }] } }),
  );
  const result = fixture.run();
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /local\/ci\/inner\/action.yml.*literal unbounded/);
});

// Superset of reviewer r3's 48-case sweep: both tasks for every Turbo launcher,
// plus pnpm dlx, across all four document locations. Each has LF/CRLF and controls.
const continuationForms = [
  ...['test', 'test:unit'].flatMap((task) => [
    `pnpm run ${task}`,
    `pnpm ${task}`,
    ...['turbo', 'pnpm exec turbo', 'pnpm dlx turbo', 'npx turbo'].flatMap((launcher) => [
      `${launcher} run ${task}`,
      `${launcher} ${task}`,
    ]),
  ]),
  'node scripts/run-test-phases.mjs test',
  './scripts/run-test-phases.mjs test',
];
const scannedLocations = [
  ['other.yml', (run) => ({ jobs: { other: { steps: [{ run }] } } })],
  ['other.yaml', (run) => ({ jobs: { other: { steps: [{ run }] } } })],
  ['local/ci/action.yml', (run) => ({ runs: { using: 'composite', steps: [{ run }] } })],
  ['local/ci/action.yaml', (run) => ({ runs: { using: 'composite', steps: [{ run }] } })],
];
for (const [file, document] of scannedLocations) {
  for (const command of continuationForms) {
    for (const newline of [null, '\n', '\r\n']) {
      const label = newline === null ? 'unwrapped control' : newline === '\n' ? 'LF' : 'CRLF';
      test(`continuation matrix ${label}: ${file}: ${command}`, () => {
        const split = command.lastIndexOf(' ');
        const run = newline
          ? `${command.slice(0, split)} \\${newline}  ${command.slice(split + 1)}`
          : command;
        // Exercise actual YAML serialization/parsing, including CRLF inside run.
        refused(
          unitStepProblems(
            { 'ci.yml': realWorkflow, [file]: stringify(document(run)) },
            realScripts,
          ),
          /literal unbounded unit invocation/,
        );
      });
    }
  }
}
for (const command of [
  'pnpm --reporter append-only run test:unit',
  'npx --no-install turbo run test:unit',
  'pnpm dlx turbo run test:unit',
  'node --no-warnings scripts/run-test-phases.mjs test',
  'pnpm --reporter=append-only run test:unit',
  'pnpm run --reporter append-only test:unit',
  'pnpm exec --parallel turbo run test:unit',
  'pnpm dlx --package turbo turbo test:unit',
  'npx --package turbo --no-install turbo test:unit',
  'node --require ./setup.cjs --no-warnings scripts/run-test-phases.mjs test',
  'turbo --cwd . run test:unit',
  'turbo run --filter @rasta/web test:unit',
  'turbo run test:unit --filter test',
]) {
  test(`declared launcher options expose unbounded invocation: ${command}`, () => {
    for (const [file, document] of scannedLocations)
      refused(
        parsedProblems({ 'ci.yml': realDoc, [file]: document(command) }, realScripts),
        /literal unbounded unit invocation/,
      );
  });
}
for (const command of [
  'pnpm --unrecognised test:unit',
  'pnpm run --unrecognised test:unit',
  'pnpm exec --unrecognised turbo run test:unit',
  'pnpm dlx --unrecognised turbo run test:unit',
  'npx --unrecognised turbo run test:unit',
  'node --unrecognised scripts/run-test-phases.mjs test',
  'turbo --unrecognised run test:unit',
  'turbo run --unrecognised test:unit',
  'pnpm --unrecognised=anything build',
]) {
  test(`unknown launcher option fails loudly: ${command}`, () => {
    for (const [file, document] of scannedLocations)
      refused(
        parsedProblems({ 'ci.yml': realDoc, [file]: document(command) }, realScripts),
        /unrecognised launcher option/,
      );
  });
}
for (const command of ['pnpm --reporter', 'npx --package', 'node --require', 'turbo --cwd']) {
  test(`missing launcher option value fails closed: ${command}`, () =>
    refused(extraRun(command), /missing launcher option value/));
}
for (const command of [
  '# comment; pnpm test',
  'echo safe # comment; pnpm test',
  '\t# comment && pnpm test || turbo test:unit | pnpm test',
  '# comment with backslash \\\npnpm run build',
  'echo "# comment; pnpm test"',
  "echo '# comment; pnpm test'",
  'echo \\# pnpm test',
  'pnpm run build#suffix',
  'pnpm ""#suffix test',
  "pnpm 'test:\\\nunit'",
  'pnpm --reporter test run build',
  'npx --package test turbo build',
  'node --require test scripts/run-test-phases.mjs build',
  'turbo --concurrency 3 run test:unit',
]) {
  test(`logical command control accepted: ${JSON.stringify(command)}`, () => {
    for (const [file, document] of scannedLocations)
      assert.deepEqual(
        parsedProblems({ 'ci.yml': realDoc, [file]: document(command) }, realScripts),
        [],
      );
  });
}
for (const separator of [';', '&&', '||', '|', '\n']) {
  test(`logical command separator exposes invocation: ${JSON.stringify(separator)}`, () =>
    refused(extraRun(`echo safe ${separator} pnpm test`), /literal unbounded/));
}
for (const command of [
  '# comment; pnpm build\npnpm test',
  '# comment with backslash \\\npnpm test',
  'echo word#suffix; pnpm test',
  'echo "#"; pnpm test',
  "echo '#'; pnpm test",
  'echo \\#; pnpm test',
  'pnpm "test:\\\nunit"',
  'pnpm te\\\nst:unit',
]) {
  test(`comment and continuation boundaries retain invocation: ${JSON.stringify(command)}`, () =>
    refused(extraRun(command), /literal unbounded/));
}
test('exception command text remains exact after logical extraction', () => {
  for (const suffix of [' # comment', ' \\\n', '; true', ' && true', ' | cat'])
    refused(
      problemsAfter((doc) => {
        securityStep(doc).run = exception.command + suffix;
      }),
      /must match exactly once/,
    );
});

test('compound prefix cannot satisfy the exact exception line', () => {
  refused(
    problemsAfter((doc) => {
      securityStep(doc).run = `true; ${exception.command}`;
    }),
    /must match exactly once/,
  );
});

for (const option of ['-e', '--eval', '-p', '--print']) {
  test(`node ${option} arguments are not treated as a script filename`, () => {
    assert.deepEqual(extraRun(`node ${option} '"safe"' scripts/run-test-phases.mjs test`), []);
  });
}
