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
    directory: fixture,
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

// Keep the full document path, YAML parser and exception contract in the matrix,
// without reparsing unrelated production steps thousands of times.
const grammarWorkflow = stringify({
  jobs: {
    quality: { steps: [unitStep(realDoc)] },
    [exception.job]: { steps: [securityStep(realDoc)] },
  },
});
const grammarProblems = (file, document, run, scripts = realScripts) =>
  unitStepProblems({ 'ci.yml': grammarWorkflow, [file]: stringify(document(run)) }, scripts);
const implicitForms = [
  'pnpm turbo run test:unit',
  'pnpm turbo test:unit',
  'pnpm --reporter append-only turbo run test:unit',
  'pnpm -C . turbo run test:unit',
  'pnpm --filter=@rasta/web turbo run test:unit',
  'pnpm turbo --cwd . run test:unit',
  'pnpm turbo run --filter @rasta/web test:unit',
  'pnpm node scripts/run-test-phases.mjs test',
  'pnpm --reporter append-only node --no-warnings scripts/run-test-phases.mjs test',
  'pnpm node --require ./setup.cjs scripts/run-test-phases.mjs test',
  'npx pnpm turbo run test:unit',
  'pnpm exec pnpm turbo run test:unit',
  'pnpm dlx pnpm node scripts/run-test-phases.mjs test',
  'npx --no-install pnpm --filter @rasta/web node scripts/run-test-phases.mjs test',
  './node_modules/.bin/turbo run test:unit',
  '/usr/bin/node scripts/run-test-phases.mjs test',
  './node_modules/.bin/pnpm turbo run test:unit',
  'pnpm ./node_modules/.bin/turbo run test:unit',
  'pnpm /usr/bin/node scripts/run-test-phases.mjs test',
  '/usr/bin/npx ./node_modules/.bin/turbo run test:unit',
  'pnpm exec /usr/bin/node ./scripts/run-test-phases.mjs test',
  'pnpm dlx ./node_modules/.bin/turbo run test:unit',
  'pnpm run-script test:unit',
  'pnpm t',
];
for (const [file, document] of scannedLocations) {
  for (const command of implicitForms) {
    for (const newline of [null, '\n', '\r\n']) {
      const run = newline ? command.replaceAll(' ', ` \\${newline}`) : command;
      test(`r4 implicit and path matrix ${file}: ${JSON.stringify(run)}`, () => {
        refused(grammarProblems(file, document, run), /literal unbounded/);
      });
    }
  }
  // Superset of all 1,408 reviewer escapes: the original 22 forms, all delimiter
  // quote styles, both heredoc operators, cat/shell recipients, both quote leaks.
  for (const command of continuationForms) {
    for (const operator of ['<<', '<<-']) {
      for (const delimiter of ['TXT', "'TXT'", '"TXT"']) {
        for (const program of ['cat', 'bash']) {
          for (const data of ["it's a note", 'an unmatched "']) {
            const tab = operator === '<<-' ? '\t' : '';
            const run = `${program} ${operator}${delimiter}\n${tab}${data}\n${tab}TXT\n${command}`;
            test(`r4 heredoc quote boundary ${file}: ${JSON.stringify(run)}`, () => {
              refused(
                grammarProblems(file, document, run),
                /literal unbounded|unterminated .* quote/,
              );
            });
          }
        }
      }
    }
  }
}

const refusalCases = [
  ["pnpm $'test:unit'", 'ANSI-C quoting'],
  ["$'pnpm' run test:unit", 'ANSI-C quoting'],
  ['pnpm $"test:unit"', 'locale quoting'],
  ['$"pnpm" run test:unit', 'locale quoting'],
  ["$\\\n'pnpm' run test:unit", 'unrecognised dollar construct'],
  ["pnpm $\\\n'test:unit'", 'unrecognised dollar construct'],
  ['$\\\n"pnpm" run test:unit', 'unrecognised dollar construct'],
  ['pnpm $\\\r\n"test:unit"', 'unrecognised dollar construct'],
  ['echo "$\\\n(pnpm test)"', 'unrecognised dollar construct'],
  ['echo $', 'unrecognised dollar construct'],
  ["echo 'unterminated", 'unterminated single quote'],
  ['echo "unterminated', 'unterminated double quote'],
  ['echo trailing\\', 'dangling backslash'],
  ["cat <<'TXT'\nit's a note\n", 'unbalanced heredoc'],
  ['cat <<-TXT\n\tdata\n TXT', 'unbalanced heredoc'],
  ['cat <<TXT', 'unbalanced heredoc'],
  ['(cat <<TXT)', 'unbalanced heredoc'],
  ['cat <<"TXT"suffix\nTXT', 'unsupported heredoc delimiter'],
  ['cat <<TXT\n$(pnpm test)\nTXT', 'unquoted heredoc expansion or escape'],
  ['cat <<TXT\n`pnpm test`\nTXT', 'unquoted heredoc expansion or escape'],
  ['cat <<TXT\ndata\\\nTXT', 'unquoted heredoc expansion or escape'],
  ['cat <(pnpm test)', 'process substitution'],
  ['cat >(pnpm test)', 'process substitution'],
  ['echo $((1+2))', 'arithmetic expansion'],
  ['echo $[1+2]', 'legacy arithmetic expansion'],
  ["cat <<$'TXT'\ndata\nTXT", 'ANSI-C/locale heredoc delimiter'],
  ['cat <<$"TXT"\ndata\nTXT', 'ANSI-C/locale heredoc delimiter'],
  ['COMMAND=(pnpm test)', 'array assignment'],
  ['(( 1 + 2 ))', 'arithmetic command'],
  ['echo `pnpm test`', 'backtick command substitution'],
  ['echo ${name', 'unbalanced parameter expansion'],
  ['echo ${{ expression', 'unbalanced GitHub expression'],
  ['echo $(echo safe', 'unbalanced group'],
  ['(echo safe', 'unbalanced group'],
  ['echo safe)', 'unbalanced group'],
  ['{ echo safe', 'unbalanced group'],
  ['echo safe }', 'unbalanced group'],
  ['pnpm {test,test:unit}', 'brace expansion'],
  ['pnpm te*', 'pathname expansion'],
  ['pnpm tes?', 'pathname expansion'],
  ['pnpm [t]est', 'pathname expansion'],
  ['echo @(one|two)', 'extended pathname expansion'],
  ['echo ~user', 'tilde expansion'],
  ['echo safe;; pnpm test', 'unsupported control operator'],
  ['echo safe |& pnpm test', 'unsupported control operator'],
  ['echo safe &&& pnpm test', 'unsupported control operator'],
  ['echo safe &> output', 'combined output redirection'],
  ['echo safe <> output', 'unsupported redirection operator'],
  ['echo safe >', 'missing redirection target'],
  ['echo safe > > output', 'missing redirection target'],
  ['echo safe\vdata', 'unmodelled character'],
];
for (const [file, document] of scannedLocations) {
  for (const [run, construct] of refusalCases) {
    test(`finite grammar refusal ${file}: ${construct}: ${JSON.stringify(run)}`, () => {
      const problems = grammarProblems(file, document, run);
      assert.ok(
        problems.some(
          (problem) =>
            problem.startsWith(`${file} `) &&
            problem.includes('/ (unnamed): unsupported shell construct: ') &&
            problem.includes(construct),
        ),
        JSON.stringify(problems),
      );
    });
  }
}

for (const [run, pattern] of [
  ['RESULT=$(pnpm turbo run test:unit)', /literal unbounded/],
  ['echo "$(pnpm node scripts/run-test-phases.mjs test)"', /literal unbounded/],
  ['echo "$(echo "$(pnpm test)")"', /literal unbounded/],
  ['(pnpm turbo run test:unit)', /literal unbounded/],
  ['{ pnpm node scripts/run-test-phases.mjs test; }', /literal unbounded/],
  ['if pnpm turbo run test:unit; then echo done; fi', /literal unbounded/],
  ['FLAG=value /usr/bin/node scripts/run-test-phases.mjs test', /literal unbounded/],
  ['>output pnpm test', /literal unbounded/],
  ['pnpm >output test:unit', /literal unbounded/],
  ['pnpm 2>&1 test:unit', /literal unbounded/],
  ['pnpm turbo --unknown test:unit', /unrecognised launcher option/],
  ['pnpm node --unknown scripts/run-test-phases.mjs test', /unrecognised launcher option/],
]) {
  test(`modelled command boundary finds invocation: ${run}`, () => {
    for (const [file, document] of scannedLocations)
      refused(grammarProblems(file, document, run), pattern);
  });
}

const grammarControls = [
  "cat <<'TXT'\nit's a note\nan unmatched \"\npnpm test\nTXT\npnpm run build",
  'cat <<-TXT\n\tdata\n\tTXT\npnpm run build',
  'cat <<"TXT"\n$(pnpm test)\n`pnpm test`\nTXT\npnpm run build',
  'cat <<\'ONE\' <<-"TWO"\n\'single quote\nONE\n\t"double quote\n\tTWO\npnpm run build',
  'cat <<TXT\ndata\nTXT',
  'echo "literal <(pnpm test) and ${name}"',
  'echo \'$"literal" and $\'',
  'echo "literal $\'test:unit\'"',
  "echo 'literal `pnpm test` ${name:-value} {a,b} ~ *'",
  'echo "$(echo \'quoted\')"; pnpm run build',
  '(echo safe); { pnpm run build; }',
  'example() { echo safe; }; example',
  'if [ "$name" = "value" ]; then pnpm run build; fi',
  'for item in $(seq 1 3); do echo "$item"; done',
  'NAME=value pnpm run build >output 2>&1',
  'cat <input | tee output >>log',
  'pnpm turbo run test:unit --concurrency=3',
  '/usr/bin/pnpm /usr/bin/node scripts/run-test-phases.mjs build',
  'bash scripts/build.sh',
  'pnpm install --frozen-lockfile',
  'pnpm run turbo run test:unit',
  'echo "# ${{ github.ref }}"',
  'pnpm ${task}',
  'echo "a literal $"',
  'pnpm "test$"',
  'echo "$(cat <<\'TXT\'\n)"quote\nTXT\n)"; pnpm run build',
];
for (const run of grammarControls) {
  test(`finite grammar accepted control: ${JSON.stringify(run)}`, () => {
    for (const [file, document] of scannedLocations)
      assert.deepEqual(grammarProblems(file, document, run), []);
  });
}
test('implicit pnpm dispatch uses the supplied root scripts before executable lookup', () => {
  for (const [file, document] of scannedLocations) {
    for (const [name, command] of [
      ['turbo', 'run test:unit'],
      ['node', 'scripts/run-test-phases.mjs test'],
    ])
      assert.deepEqual(
        grammarProblems(file, document, `pnpm ${name} ${command}`, {
          ...realScripts,
          [name]: 'echo safe',
        }),
        [],
      );
    assert.deepEqual(grammarProblems(file, document, 'pnpm help test:unit'), []);
  }
});

// Round 6: every reproduced command context, in both workflow extensions and
// both composite extensions, unwrapped and continued with LF/CRLF.
const r6Wrappers = [
  'time',
  'time -p',
  'time !',
  '! time',
  'coproc',
  'command',
  'command -p',
  'exec',
  'exec -a worker -c -l',
  'env FLAG=value',
  'env -i --unset=OLD --chdir . FLAG=value',
  'nice',
  'nice -n 5',
  'nohup',
  'timeout 30s',
  'timeout --signal TERM --kill-after=2s --foreground 30s',
  'xargs',
  'xargs -0 -r -n 1 -P 2',
  '! time -p env FLAG=value command nice -n 1 timeout 30s nohup exec',
];
const r6Evaluations = [
  (command) => `eval '${command}'`,
  (command) => `eval ${command}`,
  (command) => `eval 'pn'"pm" 'run' 'test:'"unit"; ${command}`,
  (command) => `eval 'eval "${command}"'`,
];
const r6Interpreters = [
  'sh',
  '/bin/bash',
  'dash',
  'zsh',
  'ksh',
  'rbash',
  '/bin/rbash',
  'source /dev/stdin',
  '. /dev/stdin',
  'bash /proc/self/fd/0',
  'bash /proc/thread-self/fd/0',
  'bash //dev/stdin',
  'bash /dev/./stdin',
  'pnpm exec /bin/rbash /proc/self/fd/0',
  'npx pnpm exec env FLAG=value bash /proc/thread-self/fd/0',
  '(bash /proc/self/fd/0)',
  '{ pnpm exec bash //dev/stdin; }',
];
const continued = (run, newline) => {
  if (!newline) return run;
  const end = run.indexOf('\n');
  const header = end < 0 ? run : run.slice(0, end);
  return (header.replaceAll(' ', ` \\\n`) + (end < 0 ? '' : run.slice(end))).replaceAll(
    '\n',
    newline,
  );
};
for (const [file, document] of scannedLocations) {
  for (const newline of [null, '\n', '\r\n']) {
    for (const command of continuationForms) {
      for (const wrapper of r6Wrappers) {
        const run = continued(`${wrapper} ${command}`, newline);
        test(`r6 A wrapper FOUND ${file}: ${JSON.stringify(run)}`, () =>
          refused(grammarProblems(file, document, run), /literal unbounded/));
      }
      for (const evaluation of r6Evaluations) {
        const run = continued(evaluation(command), newline);
        test(`r6 B literal eval FOUND ${file}: ${JSON.stringify(run)}`, () =>
          refused(grammarProblems(file, document, run), /literal unbounded/));
      }
    }
    for (const interpreter of r6Interpreters) {
      for (const operator of ['<<', '<<-']) {
        for (const delimiter of ['TXT', "'TXT'", '"TXT"']) {
          const tab = operator === '<<-' ? '\t' : '';
          for (const producer of ['', 'cat ']) {
            const header = producer
              ? `${producer}${operator}${delimiter} | ${interpreter}`
              : `${interpreter} ${operator}${delimiter}`;
            const run = continued(`${header}\n${tab}pnpm run test:unit\n${tab}TXT`, newline);
            test(`r6 C interpreter FOUND ${file}: ${JSON.stringify(run)}`, () =>
              refused(grammarProblems(file, document, run), /literal unbounded/));
          }
        }
      }
    }
  }
}
for (const [file, document] of scannedLocations) {
  for (const run of [
    // B': main's actual credential-loading forms, plus all expansion families.
    'eval "${x}"',
    'eval "${asset_credentials}" && eval "${fleet_credentials}"',
    'eval "${kafka_credentials}"',
    'eval "$x"',
    'eval "${x:-${y}}"',
    'eval "$(echo \'pnpm run test:unit\')"',
    'eval "`echo pnpm run test:unit`"',
    'eval $(pnpm run test:unit)',
    'command env FLAG=value eval "${x:-value}"',
    'pnpm exec eval "${x:-value}"',
    'eval "pre${x}post"',
    'source "$x"',
    '. "${x:-fallback}"',
    'source /outside/repo/file.sh',
    '. /dev/stdin',
    'eval "echo pnpm run test:unit $x"',
    'eval "echo safe"',
    // Quoted data remains data until a known interpreter receives it.
    'echo "eval pnpm run test:unit"',
    "cat <<'TXT' | cat\npnpm run test:unit\nTXT",
    "bash <<'TXT'\npnpm run build\nTXT",
    "cat <<'TXT' | bash /proc/self/fd/0\necho safe\nTXT",
    "bash <<< 'pnpm run build'",
    "cat <<< 'pnpm run test:unit'",
    "echo 'pnpm run build' | bash",
    'command -v pnpm run test:unit',
    'command -V pnpm run test:unit',
    'env --unset "$x" pnpm run build',
    'timeout 20s pnpm run build',
  ]) {
    test(`r6 accepted control ${file}: ${JSON.stringify(run)}`, () =>
      assert.deepEqual(grammarProblems(file, document, run), []));
  }
  for (const run of [
    'eval "pnpm run test:unit $x"',
    'eval "$x pnpm run test:unit"',
    'eval pnpm run test:unit "$x"',
    'eval "pnpm run test:unit ${x:-fallback}"',
    'eval "pnpm run test:unit $(echo safe)"',
    'eval "pnpm run test:unit `echo safe`"',
    // Literal concatenation/quote removal and literal eval recursion.
    "eval 'pn'\"pm\" 'run' 'test:'\"unit\"",
    'eval "pnpm run te""st:unit"',
    "eval -- 'pnpm run test:unit'",
    'eval "echo safe; pnpm run test:unit"',
    "sh -c 'pnpm test'",
    "bash <<< 'pnpm run test:unit'",
    "source /proc/self/fd/0 <<< 'pnpm run test:unit'",
    ". arbitrary-path <<< 'pnpm run test:unit'",
    "cat <<< 'pnpm run test:unit' | bash /not-a-stdin-spelling",
    "echo 'pnpm run test:unit' | rbash arbitrary-path",
    "(cat <<'TXT'\npnpm run test:unit\nTXT\n) | (env FLAG=value rbash)",
    "(bash) <<'TXT'\npnpm run test:unit\nTXT",
    "(echo 'pnpm run test:unit'; echo safe) | bash /proc/self/fd/0",
    "cat <<'TXT' | (echo safe; bash /proc/self/fd/0)\npnpm run test:unit\nTXT",
    "cat <<'TXT' | cat | (pnpm exec rbash)\npnpm run test:unit\nTXT",
    "cat <<'ONE' <<'TWO' | bash\necho safe\nONE\npnpm run test:unit\nTWO",
    "echo safe | bash <<'TXT'\npnpm run test:unit\nTXT",
  ]) {
    test(`r6 branch FOUND ${file}: ${JSON.stringify(run)}`, () =>
      refused(grammarProblems(file, document, run), /literal unbounded/));
  }
  for (const [run, pattern] of [
    ...Object.keys({
      time: 0,
      command: 0,
      exec: 0,
      env: 0,
      nice: 0,
      nohup: 0,
      timeout: 0,
      xargs: 0,
    }).map((wrapper) => [`${wrapper} --unknown pnpm test`, /unmodelled wrapper option/]),
    ['eval -unknown pnpm test', /unmodelled evaluation option/],
    ['env --unset', /missing wrapper option value/],
    ['time -p=bad pnpm test', /wrapper switch takes no value/],
    ['timeout', /missing timeout duration/],
    ['bash <<< "$x"', /interpreter input payload unavailable/],
    ['cat generated.sh | bash /proc/self/fd/0', /interpreter pipeline payload unavailable/],
    ['fetch-command | source /anything', /interpreter pipeline payload unavailable/],
    ["cat <<'TXT' | bash <unknown\npnpm test\nTXT", /interpreter input payload unavailable/],
    ['source', /missing source path/],
    ['source -bad', /unmodelled evaluation option/],
  ]) {
    test(`r6 branch REFUSED ${file}: ${JSON.stringify(run)}`, () =>
      refused(grammarProblems(file, document, run), pattern));
  }
}
for (const site of ['source', '.']) {
  test(`r6 B repo source recursively scanned via CLI: ${site}`, (t) => {
    const fixture = cliFixture(t);
    fixture.doc.jobs.quality.steps.push({ run: `${site} ./ci/one.sh` });
    fixture.workflow();
    fixture.write('ci/one.sh', '# test:unit\n. ./ci/two.sh');
    fixture.write('ci/two.sh', 'pnpm run test:unit');
    let result = fixture.run();
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /Another command|literal unbounded/);
    fixture.write('ci/two.sh', 'pnpm run build');
    result = fixture.run();
    assert.equal(result.status, 0, result.stderr);
    fixture.write('ci/two.sh', '# test:unit\n. ./ci/one.sh');
    result = fixture.run();
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /recursive source cycle/);
  });
}
test('r6 B unreadable repo source refuses via CLI', (t) => {
  const fixture = cliFixture(t);
  fixture.doc.jobs.quality.steps.push({ run: 'source ./ci/directory' });
  fixture.workflow();
  fixture.write('ci/directory/child', '');
  const result = fixture.run();
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /EISDIR/);
});

test('r6 command-context boundary probes', () => {
  const probe = (run) => grammarProblems(...scannedLocations[0], run);
  const found = [
    ...r6Wrappers.map((wrapper) => `${wrapper} pnpm test`),
    'time -- pnpm test',
    'env -u OLD pnpm test',
    'env --unset=OLD pnpm test',
    'command env FLAG=value time -p ! pnpm test',
    "eval 'pnpm test'",
    'eval pnpm test',
    "eval 'pn'\"pm\" 'test'",
    "eval -- 'pnpm test'",
    `eval 'eval "pnpm test"'`,
    'eval "pnpm test $x"',
    'eval -- "pnpm test $x"',
    'eval "env --unknown $x pnpm test"',
    '. "pnpm test $x"',
    'eval "$x pnpm test"',
    'eval "pnpm test ${x:-value}"',
    'eval "${x:-${y}} pnpm test"',
    'eval "$(echo \')\') pnpm test"',
    'eval "$(echo \\) safe) pnpm test"',
    'eval "pnpm test $(echo safe)"',
    'eval "pnpm test `echo safe`"',
    "bash -c 'pnpm test' <<< 'echo safe'",
    "rbash -lc 'pnpm test' <<< 'echo safe'",
    "bash <<'TXT'\npnpm test\nTXT",
    'bash <<-TXT\n\tpnpm test\n\tTXT',
    "cat <<'TXT' | rbash arbitrary-path\npnpm test\nTXT",
    "cat <<'TXT' | source arbitrary-path\npnpm test\nTXT",
    ". arbitrary-path <<< 'pnpm test'",
    "rbash <<< 'pnpm test'",
    "cat <<< 'pnpm test' | cat | bash arbitrary-path",
    "echo 'pnpm test' | bash arbitrary-path",
    "(echo 'pnpm test'; echo safe) | bash arbitrary-path",
    "cat <<'TXT' | (echo safe; bash)\npnpm test\nTXT",
    "echo safe | (bash) <<'TXT'\npnpm test\nTXT",
    "cat <<'TXT' | (bash)\npnpm test\nTXT",
    "(bash) <<'TXT'\npnpm test\nTXT",
    "cat <<'ONE' <<'TWO' | bash\necho safe\nONE\npnpm test\nTWO",
    "pnpm exec env FLAG=value rbash <<< 'pnpm test'",
  ];
  for (const run of found) refused(probe(run), /literal unbounded/);
  for (const run of [
    'eval "${x}"',
    'eval "$x"',
    'eval "${x:-${y}}"',
    'eval $(pnpm test)',
    'eval "$(pnpm test)"',
    'eval "`pnpm test`"',
    'eval "${x:-"quoted"}"',
    'eval "$(echo \'quoted\')"',
    'eval "$(echo \') pnpm test\')"',
    'eval "$(echo \\) safe)"',
    'eval "`echo \\` safe`"',
    'pnpm exec eval "${x:-value}"',
    'npx env FLAG=value eval "${x:-value}"',
    'eval "echo safe $x"',
    "bash -s <<< 'echo safe'",
    'eval "--unknown $x"',
    'source "-bad $x"',
    'eval "${x}" "source /outside.sh"',
    'source /outside.sh',
    '. "$x"',
    "cat <<'TXT' | bash <<< 'echo safe'\npnpm test\nTXT",
    "cat <<'TXT' | (bash) <<< 'echo safe'\npnpm test\nTXT",
    "echo 'pnpm test' | cat",
    'command -v pnpm test',
    'command -V pnpm test',
    'env -u "$x" pnpm run build',
  ])
    assert.deepEqual(probe(run), [], run);
  for (const [run, pattern] of [
    // TASK 860: opaque expansions do not suppress literal interpreter/wrapper
    // input refusals. The old permissive expectations preceded this PM decision.
    ['eval "bash -c $x"', /missing shell command string/],
    ['eval "env --unknown $x"', /unmodelled wrapper option/],
    ['env --bad pnpm test', /unmodelled wrapper option/],
    ['coproc --bad pnpm test', /unmodelled wrapper option/],
    ['env --unset', /missing wrapper option value/],
    ['time -p=bad pnpm test', /wrapper switch takes no value/],
    ['timeout', /missing timeout duration/],
    ['eval --bad pnpm test', /unmodelled evaluation option/],
    ['source', /missing source path/],
    ['source -bad', /unmodelled evaluation option/],
    ['bash <<< "$x"', /interpreter input payload unavailable/],
    ['cat unknown | bash arbitrary-path', /interpreter pipeline payload unavailable/],
    ['echo "$x" | bash arbitrary-path', /interpreter pipeline payload unavailable/],
    ['bash <unknown', /interpreter input payload unavailable/],
    ['eval "${x"', /unbalanced dynamic expansion/],
    ['eval "`x"', /unbalanced dynamic backtick/],
  ])
    refused(probe(run), pattern);
  const readRepoFile = (path) =>
    path === './ci/source.sh' ? { path: 'ci/source.sh', text: 'pnpm test' } : null;
  for (const site of ['source', '.', 'source --', '. --']) {
    for (const input of ['', " <<< 'echo safe'"]) {
      const docs = {
        'ci.yml': parse(grammarWorkflow),
        'other.yml': { runs: { steps: [{ run: `${site} ./ci/source.sh${input}` }] } },
      };
      refused(parsedProblems(docs, realScripts, { readRepoFile }), /literal unbounded/);
      refused(
        parsedProblems(docs, realScripts, { readRepoFile, sources: new Set(['ci/source.sh']) }),
        /recursive source cycle/,
      );
    }
  }
});

test('r6 B repo source path boundaries via CLI', (t) => {
  const fixture = cliFixture(t);
  const outside = mkdtempSync(join(tmpdir(), 'unit-tripwire-outside-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(join(outside, 'external.sh'), 'pnpm test');
  fixture.write('ci/local.sh', 'pnpm test');
  symlinkSync(join(fixture.directory, 'ci/local.sh'), join(outside, 'back-link.sh'));
  symlinkSync(join(fixture.directory, 'ci/local.sh'), join(fixture.directory, 'ci/inside-link.sh'));
  symlinkSync(join(outside, 'external.sh'), join(fixture.directory, 'ci/outside-link.sh'));
  const step = { run: 'source ./ci/inside-link.sh' };
  fixture.doc.jobs.quality.steps.push(step);
  fixture.workflow();
  let result = fixture.run();
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /literal unbounded/);
  for (const path of [
    './ci/outside-link.sh',
    join(outside, 'external.sh'),
    join(outside, 'back-link.sh'),
    './ci/missing.sh',
  ]) {
    step.run = `source ${path}`;
    fixture.workflow();
    result = fixture.run();
    assert.equal(result.status, 0, result.stderr);
  }
});

// Round 7: the reviewer's exact 9 B' + 8 C forms, each at four document
// locations with plain/LF/CRLF headers (204 probes), plus all four builtins.
const r7ReviewerB = [
  `eval "pnpm run 'test:unit' $x"`,
  `eval "pnpm run \\"test:unit\\" $x"`,
  `eval "pnpm run te''st:unit $x"`,
  `eval "(pnpm run test:unit) $x"`,
  `eval "true && pnpm run 'test:unit' $x"`,
  `eval "eval pnpm run test:unit $x"`,
  'source ./ci/unit.sh "$x"',
  '. ./ci/unit.sh "$x"',
  'eval "source ./ci/unit.sh $x"',
];
const r7ReviewerC = [
  `bash <<'UNIT' 3<<'DATA'\npnpm run test:unit\nUNIT\necho safe\nDATA`,
  `bash <<'UNIT' 3<<< 'echo safe'\npnpm run test:unit\nUNIT`,
  `cat <<'UNIT' | (bash) 3<<< 'echo safe'\npnpm run test:unit\nUNIT`,
  `cat <<'UNIT' | cat 3<<< 'echo safe' | bash\npnpm run test:unit\nUNIT`,
  `cat <<'UNIT' | bash 3<<< 'echo safe'\npnpm run test:unit\nUNIT`,
  `bash -s -c 'pnpm run test:unit' <<< 'echo safe'`,
  `bash -s -ec 'pnpm run test:unit' <<< 'echo safe'`,
  `echo safe | bash ./ci/unit.sh`,
];

const r7Builtins = [
  "builtin eval 'pnpm run test:unit'",
  "builtin -- eval 'pnpm run test:unit'",
  "builtin source /dev/stdin <<'TXT'\npnpm run test:unit\nTXT",
  "builtin . /dev/stdin <<'TXT'\npnpm run test:unit\nTXT",
];
const r7ReadRepoFile = (path) =>
  ['./ci/unit.sh', './x.sh'].includes(path)
    ? { path: path.slice(2), text: 'pnpm run test:unit' }
    : null;
const r7Problems = (file, document, run, readRepoFile = r7ReadRepoFile) =>
  unitStepProblems({ 'ci.yml': grammarWorkflow, [file]: stringify(document(run)) }, realScripts, {
    readRepoFile,
  });
const r7Found = [
  ...r7ReviewerB,
  ...r7ReviewerC,
  ...r7Builtins,
  `eval "'pnpm' run test:unit $x"`,
  `eval "{ pnpm run 'test:unit'; } $x"`,
  `eval "eval 'pnpm run test:unit' $x"`,
  `eval "eval "pnpm run 'test:unit'" $x"`,
  `eval "eval source ./ci/unit.sh $x"`,
  `eval "builtin eval 'pnpm run test:unit' $x"`,
  `builtin -- eval "pnpm run 'test:unit' $x"`,
  'builtin source ./ci/unit.sh "$x"',
  'builtin -- . ./ci/unit.sh "$x"',
  'source -- ./ci/unit.sh "$x"',
  '. -- ./ci/unit.sh "${x}"',
  `eval ". ./ci/unit.sh $x"`,
  'bash ./ci/unit.sh "$x"',
  'sh -e ./x.sh "$x"',
  "bash ./ci/unit.sh <<< 'echo safe'",
  'sh -e ./x.sh <unknown',
  "echo safe | bash ./ci/unit.sh 3<<< 'echo safe'",
  "bash -ec 'pnpm run test:unit'",
  "sh -sc 'pnpm run test:unit' <<< 'echo safe'",
  "bash -s -e -c 'pnpm run test:unit' <<< 'echo safe'",
  "bash -s -ec 'pnpm run test:unit' <unknown",
  "rbash -s -lc 'pnpm run test:unit' 3<<< 'echo safe'",
  'bash -e -s -c \'eval "pnpm run test:unit"\'',
  "bash -c 'pnpm run test:unit' <<< 'pnpm run build'",
  "bash <<< 'echo safe' 0<<< 'pnpm run test:unit'",
  "bash 0<<< 'echo safe' <<'UNIT'\npnpm run test:unit\nUNIT",
  "bash <<'SAFE' <<'UNIT'\necho safe\nSAFE\npnpm run test:unit\nUNIT",
  "bash <<'UNIT' 3<<'DATA' 4<<< 'echo safe'\npnpm run test:unit\nUNIT\necho safe\nDATA",
  "bash 3<<< 'echo safe' <<'UNIT'\npnpm run test:unit\nUNIT",
  "cat <<'UNIT' | (bash 3<<'DATA'\necho safe\nDATA\n)\npnpm run test:unit\nUNIT",
  "cat 3<<< 'echo safe' <<'UNIT' | bash\npnpm run test:unit\nUNIT",
  "bash <unknown 0<<< 'pnpm run test:unit'",
];
for (const [file, document] of scannedLocations) {
  for (const newline of [null, '\n', '\r\n']) {
    for (const original of r7Found) {
      const run = continued(original, newline);
      test(`r7 boundary FOUND ${file}: ${JSON.stringify(run)}`, () =>
        refused(r7Problems(file, document, run), /literal unbounded/));
    }
  }
  for (const run of [
    'builtin eval "${x}"',
    'builtin -- eval "${x}"',
    'eval "echo pnpm run \'test:unit\' $x"',
    `eval "echo "pnpm run test:unit" $x"`,
    'eval "${x:-pnpm run test:unit}"',
    'eval "$(pnpm run test:unit)"',
    'eval "`pnpm run test:unit`"',
    'source "$x" ignored',
    'bash -- ./safe.sh "$x"',
    'sh -e ./safe.sh',
    "bash -s ./ci/unit.sh <<< 'echo safe'",
    "bash -s -c 'echo safe' <<< 'pnpm run test:unit'",
    "bash -ec 'echo safe' <<< 'pnpm run test:unit'",
    "bash -sc 'echo safe' <<< 'pnpm run test:unit'",
    "bash <<< 'pnpm run test:unit' 0<<< 'echo safe'",
    "bash <<'UNIT' 0<<< 'echo safe'\npnpm run test:unit\nUNIT",
    "bash <<'UNIT' <<'SAFE'\npnpm run test:unit\nUNIT\necho safe\nSAFE",
    "bash <<< 'echo safe' 3<<< 'pnpm run test:unit'",
    "bash 3<<< 'pnpm run test:unit' <<< 'echo safe'",
    "bash <<'SAFE' 3<<'UNIT'\necho safe\nSAFE\npnpm run test:unit\nUNIT",
    "cat <<'UNIT' | bash 0<<< 'echo safe'\npnpm run test:unit\nUNIT",
    "echo safe | cat 3<<< 'pnpm run test:unit' | bash",
    "(bash) <<< 'pnpm run test:unit' 0<<< 'echo safe'",
  ]) {
    test(`r7 boundary ACCEPTED ${file}: ${JSON.stringify(run)}`, () =>
      assert.deepEqual(r7Problems(file, document, run), []));
  }
  for (const [run, pattern] of [
    ["bash 3<<< 'pnpm run test:unit'", /shell stdin or command string/],
    ["bash 3<<'UNIT'\npnpm run test:unit\nUNIT", /shell stdin or command string/],
    ["bash <<< 'pnpm run test:unit' <unknown", /interpreter input payload unavailable/],
    ["bash <<< 'pnpm run test:unit' 0<&3", /interpreter input payload unavailable/],
    ["bash <<< 'pnpm run test:unit' 0>&3", /interpreter input payload unavailable/],
    ['bash <<< \'pnpm run test:unit\' 0<<< "$x"', /interpreter input payload unavailable/],
    ['bash -s -c', /missing shell command string/],
    ['bash --unknown', /shell input option/],
    ['builtin --unknown eval pnpm test', /unmodelled wrapper option/],
  ]) {
    test(`r7 boundary REFUSED ${file}: ${JSON.stringify(run)}`, () =>
      refused(r7Problems(file, document, run), pattern));
  }
}

test('r7 repo source and shell scripts use real filesystem via CLI', (t) => {
  const fixture = cliFixture(t);
  fixture.write('ci/unit.sh', 'pnpm run test:unit');
  const step = { run: '' };
  fixture.doc.jobs.quality.steps.push(step);
  for (const run of [
    'source ./ci/unit.sh "$x"',
    '. ./ci/unit.sh "$x"',
    'builtin -- source ./ci/unit.sh "$x"',
    `eval "source ./ci/unit.sh $x"`,
    'bash ./ci/unit.sh "$x"',
    'sh -e ./ci/unit.sh "$x"',
    "bash ./ci/unit.sh <<< 'echo safe'",
    'echo safe | sh -e ./ci/unit.sh',
  ]) {
    step.run = run;
    fixture.workflow();
    const result = fixture.run();
    assert.equal(result.status, 1, run + result.stderr);
    assert.match(result.stderr, /literal unbounded/);
  }
  fixture.write('ci/unit.sh', 'echo safe');
  step.run = 'sh -e ./ci/unit.sh "$x"';
  fixture.workflow();
  const result = fixture.run();
  assert.equal(result.status, 0, result.stderr);
});

// TASK 858(a): all parameter forms are opaque; nested quote/brace state must
// never expose their contents or swallow the following literal unit command.
const r7Parameters = [
  '${x:-safe}',
  '${arr[$i]}',
  '${BASH_SOURCE[0]}',
  '${#x}',
  '${x/a/b}',
  '${x//a/b}',
  '${!x}',
  '${x:?missing}',
  '${x:=safe}',
  '${x:+safe}',
  '${x:1:2}',
  '${x^^}',
  '${x%pattern}',
  '${x##pattern}',
  '${x:-${y:-safe}}',
  '${x:-"quoted } { text"}',
  "${x:-'quoted } { text'}",
  '${x:-"${y:-\'}\'}"}',
  '${x:-$(echo "}")}',
  '${x:-"$(echo "}")"}',
  '${x:-`echo "}"`}',
  '${x:-safe\\}tail}',
  '${x:-pnpm run test:unit}',
  '${x:-$(pnpm run test:unit)}',
];
for (const [file, document] of scannedLocations) {
  for (const parameter of r7Parameters) {
    for (const run of [
      `echo ${parameter}`,
      `echo "${parameter}"`,
      `pnpm ${parameter}`,
      `pnpm "test${parameter}"`,
    ]) {
      test(`r7 parameter ACCEPTED ${file}: ${JSON.stringify(run)}`, () =>
        assert.deepEqual(r7Problems(file, document, run), []));
    }
    for (const run of [
      `echo ${parameter}; pnpm run 'test:unit'`,
      `echo "${parameter}"; pnpm run test:unit`,
      `eval "pnpm run 'test:unit' ${parameter}"`,
    ]) {
      test(`r7 parameter FOUND ${file}: ${JSON.stringify(run)}`, () =>
        refused(r7Problems(file, document, run), /literal unbounded/));
    }
    test(`r7 parameter scanned script ${file}: ${parameter}`, () => {
      const reader = (path) =>
        path === './ci/parameter.sh' ? { path, text: `# test:unit\necho "${parameter}"` } : null;
      assert.deepEqual(r7Problems(file, document, 'bash ./ci/parameter.sh', reader), []);
      const foundReader = (path) => ({ ...reader(path), text: `echo ${parameter}; pnpm test` });
      refused(
        r7Problems(file, document, 'source ./ci/parameter.sh "$x"', foundReader),
        /literal unbounded/,
      );
    });
  }
  for (const parameter of ['${x', '${x:-${y}', '${x:-"}"', '${x:-$(echo safe}', '${x:-safe\\}']) {
    test(`r7 parameter REFUSED ${file}: ${parameter}`, () => {
      refused(r7Problems(file, document, `echo ${parameter}`), /unbalanced parameter expansion/);
      const reader = (path) => ({ path, text: `# test:unit\necho ${parameter}` });
      refused(
        r7Problems(file, document, 'sh ./ci/parameter.sh', reader),
        /unbalanced parameter expansion/,
      );
    });
  }
}

const r7InfraText = `#!/usr/bin/env bash
values=(one two)
choose() {
  case "$1" in one) echo safe ;; *) echo other ;; esac
}
choose "${'${values[0]}'}"
`;
const r7UnitTokenLaunches = [
  'pnpm test',
  'pnpm t',
  'pnpm run test',
  'pnpm run-script test',
  'pnpm --filter @rasta/example run --silent test',
  'pnpm test:unit',
  'pnpm run test:unit',
  'turbo run test',
  'turbo test',
  'turbo --filter @rasta/example run test',
  'turbo run test:unit',
  'pnpm exec turbo run test',
  'npx turbo run test',
  'node scripts/run-test-phases.mjs test',
  './scripts/run-test-phases.mjs test',
  "'pnpm' r''un 'test'",
  'pn\\pm test',
  'pnpm \\\nrun \\\ntest',
  'pnpm \\\r\nrun \\\r\ntest',
  'pnpm \\\rrun \\\rtest',
];
for (const [file, document] of scannedLocations) {
  for (const site of ['source', '.', 'builtin -- source', 'bash', 'sh -e']) {
    test(`r7 script precheck ACCEPTED ${file}: ${site}`, () => {
      const reader = (path) => ({ path, text: r7InfraText });
      assert.deepEqual(r7Problems(file, document, `${site} ./ci/infra.sh "$x"`, reader), []);
      // The exemption is specific to repo scripts. Run blocks still refuse.
      refused(r7Problems(file, document, r7InfraText), /unsupported shell construct/);
    });
  }
  for (const launch of r7UnitTokenLaunches) {
    test(`r7 script precheck FOUND ${file}: ${JSON.stringify(launch)}`, () => {
      const reader = (path) => ({ path, text: `set -eu\nhelper() { echo safe; }\n${launch}` });
      refused(r7Problems(file, document, 'bash ./ci/unit.sh', reader), /literal unbounded/);
    });
    test(`r7 script precheck REFUSED ${file}: ${JSON.stringify(launch)}`, () => {
      const reader = (path) => ({ path, text: `${r7InfraText}\n${launch}` });
      refused(r7Problems(file, document, 'sh ./ci/unit.sh', reader), /array assignment/);
    });
  }
}

test('r7 script precheck real infra, unit scripts, and recursive paths via CLI', (t) => {
  const fixture = cliFixture(t);
  const step = { run: '' };
  fixture.doc.jobs.quality.steps.push(step);
  fixture.write('ci/infra.sh', r7InfraText);
  for (const path of [
    'infrastructure/docker/postgres/00-init-databases.sh',
    'infrastructure/docker/kafka/ci-up.sh',
  ])
    fixture.write(path, readFileSync(join(root, path), 'utf8'));
  for (const path of [
    './ci/infra.sh',
    'infrastructure/docker/postgres/00-init-databases.sh',
    'infrastructure/docker/kafka/ci-up.sh',
  ]) {
    for (const site of ['source', '.', 'bash', 'sh -e']) {
      step.run = `${site} ${path} "$x"`;
      fixture.workflow();
      const result = fixture.run();
      assert.equal(result.status, 0, result.stderr);
    }
  }
  fixture.write('ci/outer.sh', '# test:unit\nsource ./ci/inner.sh "$x"');
  fixture.write('ci/inner.sh', '# test:unit\nsh -e ./ci/leaf.sh');
  step.run = 'bash ./ci/outer.sh';
  fixture.workflow();
  for (const [text, status, pattern] of [
    [r7InfraText, 0, /^$/],
    ['helper() { echo safe; }\npnpm run test:unit', 1, /literal unbounded/],
    [r7InfraText + '\npnpm run test:unit', 1, /array assignment/],
    ['# test:unit\necho "${x:-${y:-safe}}"', 0, /^$/],
    ['# test:unit\necho "${x:-${y:-safe}}"\npnpm run test:unit', 1, /literal unbounded/],
  ]) {
    fixture.write('ci/leaf.sh', text);
    const result = fixture.run();
    assert.equal(result.status, status, result.stderr);
    assert.match(result.stderr, pattern);
  }
});

// TASK 860 / r8: both review classes fail closed. These are option-vector and
// literal-failure regressions, not extensions of the finite shell grammar.
const r8Shells = ['sh', 'bash', 'dash', 'rbash', 'zsh', 'ksh'];
const r8OptionVectors = [
  '-c -e',
  '-c --',
  '+e -c',
  '-ec -x',
  '-c +e',
  '-e +x -c',
  '-s -c +x',
  '+e -sx -ec +x --',
  '-c -',
  '-c +',
  '+c',
  '-s +s -c',
];
const r8Entries = ['source', '.', 'builtin -- source', 'bash', 'sh -e'];
const r8Eval = (payload) => `eval ${JSON.stringify(payload)}`;
const r8Quote = (text) => `'${text.replaceAll("'", "'\\''")}'`;
const r8EvalSites = [
  (payload) => r8Eval(payload),
  (payload) => `builtin -- ${r8Eval(payload)}`,
  (payload) => `eval ${r8Quote(r8Eval(payload))}`,
  (payload) => `builtin -- eval ${r8Quote(r8Eval(payload))}`,
];
const r8Failures = [
  'ls *.log',
  'echo ~',
  'echo {one,two}',
  "echo $'literal'",
  'cat <(echo safe)',
  'values=(one two)',
  'bash --not-modelled',
  'bash',
  'bash <unknown',
  'source ./ci/unreadable.sh',
  'source ./ci/array.sh',
];
const r8Reader = (path) => {
  if (path === './ci/unreadable.sh') throw new Error('unreadable repo script');
  if (path === './ci/array.sh') return { path, text: 'values=(one two)\npnpm run test:unit' };
  return r7ReadRepoFile(path);
};
const r8Closed = /literal unbounded|unsupported shell construct|unreadable repo script/;
for (const [file, document] of scannedLocations) {
  for (const newline of [null, '\n', '\r\n', '\r']) {
    for (const shell of r8Shells) {
      for (const options of r8OptionVectors) {
        const original = `${shell} ${options} 'pnpm run test:unit' <<< 'echo safe'`;
        const run = continued(original, newline);
        test(`r8 options FOUND ${file} ${JSON.stringify(newline)}: ${original}`, () => {
          refused(r7Problems(file, document, run), /literal unbounded/);
          // The same vector must work when reached through a repository script.
          for (const site of r8Entries) {
            const reader = (path) => ({ path, text: run });
            refused(
              r7Problems(file, document, `${site} ./ci/options.sh`, reader),
              /literal unbounded/,
            );
          }
        });
      }
      for (const options of ['+Q -c', '-c -Q', '-c +Q', '--unknown -c', '-eo pipefail -c']) {
        const run = continued(`${shell} ${options} 'pnpm run test:unit'`, newline);
        test(`r8 options REFUSED ${file} ${JSON.stringify(newline)}: ${run}`, () => {
          refused(r7Problems(file, document, run), /shell input option/);
          for (const site of r8Entries) {
            refused(
              r7Problems(file, document, `${site} ./ci/options.sh`, (path) => ({
                path,
                text: run,
              })),
              /shell input option/,
            );
          }
        });
      }
    }
    for (const failure of r8Failures) {
      for (const payload of [
        `pnpm run test:unit $args; ${failure}`,
        `${failure}; pnpm run test:unit $args`,
        `${failure} $args; pnpm run test:unit`,
        `pnpm run test:unit; ${failure} $args; pnpm test`,
      ]) {
        for (const evaluate of r8EvalSites) {
          const run = continued(evaluate(payload), newline);
          test(`r8 literal CLOSED ${file} ${JSON.stringify(newline)}: ${run}`, () => {
            refused(r7Problems(file, document, run, r8Reader), r8Closed);
            for (const site of r8Entries) {
              const reader = (path) =>
                path === './ci/outer.sh' ? { path, text: run } : r8Reader(path);
              refused(r7Problems(file, document, `${site} ./ci/outer.sh`, reader), r8Closed);
            }
          });
        }
      }
      // A classifier refusal in one eval must not suppress adjacent independent
      // commands. Verify both the refusal AND the unit-command diagnostic.
      for (const before of [true, false]) {
        const failing = r8Eval(`${failure} $args`);
        const run = before ? `pnpm test; ${failing}` : `${failing}; pnpm test`;
        test(`r8 independent commands ${file}: ${run}`, () => {
          const problems = r7Problems(file, document, continued(run, newline), r8Reader);
          refused(problems, /literal unbounded/);
          refused(problems, /unsupported shell construct|unreadable repo script/);
        });
      }
    }
    for (const payload of [
      'pnpm --filter @rasta/* run test:unit $args',
      'source ./ci/array.sh $args',
      'bash ./ci/array.sh $args',
      'source ./ci/unreadable.sh $args',
      'bash ./ci/unreadable.sh $args',
    ]) {
      for (const evaluate of r8EvalSites) {
        const run = continued(evaluate(payload), newline);
        test(`r8 reviewer CLOSED ${file} ${JSON.stringify(newline)}: ${run}`, () =>
          refused(r7Problems(file, document, run, r8Reader), r8Closed));
      }
    }
  }
  for (const shell of r8Shells) {
    for (const options of ['-c -e', '+e -c', '-ec +x --']) {
      test(`r8 options safe operand ${file}: ${shell} ${options}`, () => {
        assert.deepEqual(
          r7Problems(file, document, `${shell} ${options} 'echo safe' 'pnpm run test:unit'`),
          [],
        );
      });
    }
    test(`r8 options stop at script operand ${file}: ${shell}`, () => {
      assert.deepEqual(
        r7Problems(file, document, `${shell} ./safe.sh -c 'pnpm run test:unit'`),
        [],
      );
      // Bash's invocation +s selects stdin too; it does not undo -s.
      refused(
        r7Problems(file, document, `${shell} -s +s ./ci/unit.sh`),
        /shell stdin or command string/,
      );
    });
    test(`r8 options missing operand ${file}: ${shell}`, () =>
      refused(r7Problems(file, document, `${shell} -c +e --`), /missing shell command string/));
  }
  for (const payload of [
    '$args',
    '${args}',
    '${args:-ls *.log}',
    '${args:-values=(one two)}',
    '${args:-bash --unknown}',
    'echo "$args"',
  ]) {
    for (const evaluate of r8EvalSites) {
      test(`r8 opaque ACCEPTED ${file}: ${evaluate(payload)}`, () =>
        assert.deepEqual(r7Problems(file, document, evaluate(payload)), []));
    }
  }
}

test('r8 CLI propagates unreadable repo script and interpreter-input refusals through eval', (t) => {
  const fixture = cliFixture(t);
  // Reading a directory fails deterministically, including when run as root.
  mkdirSync(join(fixture.directory, 'ci/unreadable.sh'), { recursive: true });
  fixture.write('ci/array.sh', 'values=(one two)\npnpm run test:unit');
  const step = { run: '' };
  fixture.doc.jobs.quality.steps.push(step);
  for (const payload of [
    'source ./ci/unreadable.sh $args',
    'source ./ci/array.sh $args',
    'bash ./ci/array.sh $args',
    'bash $args',
    'bash <unknown $args',
  ]) {
    for (const evaluate of r8EvalSites) {
      step.run = evaluate(payload);
      fixture.workflow();
      const result = fixture.run();
      assert.equal(result.status, 1, step.run + result.stderr);
      assert.match(result.stderr, /EISDIR|array assignment|shell stdin|interpreter input/);
    }
  }
});

for (const [file, document] of scannedLocations) {
  for (const failure of [
    'source ./ci/unreadable.sh',
    'source ./ci/array.sh',
    'bash <unknown',
    'bash --not-modelled',
  ]) {
    for (const payload of [`pnpm test $args; ${failure}`, `${failure} $args; pnpm test`]) {
      for (const evaluate of r8EvalSites) {
        test(`r8 complete fragments ${file}: ${evaluate(payload)}`, () => {
          const problems = r7Problems(file, document, evaluate(payload), r8Reader);
          refused(problems, /unsupported shell construct|unreadable repo script/);
          refused(problems, /literal unbounded/);
        });
      }
    }
  }
  test(`r8 reviewer complete command before literal lexer failure ${file}`, () => {
    const problems = r7Problems(file, document, 'eval "pnpm run test:unit $args; ls *.log"');
    refused(problems, /pathname expansion/);
    refused(problems, /literal unbounded/);
  });
}

for (const [file, document] of scannedLocations) {
  test(`r8 nested detection survives an earlier refusal ${file}`, () => {
    const run =
      'eval "source ./ci/unreadable.sh $args; builtin -- eval \\"source ./ci/array.sh; pnpm test\\"; bash <unknown"';
    const problems = r7Problems(file, document, run, r8Reader);
    refused(problems, /unreadable repo script/);
    refused(problems, /literal unbounded/);
  });
}
