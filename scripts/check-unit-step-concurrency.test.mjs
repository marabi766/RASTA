import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';
import {
  MAX_CONCURRENCY,
  parsedProblems,
  UNBOUNDED_EXCEPTIONS,
  unitStepProblems,
} from './check-unit-step-concurrency-lib.mjs';

const read = (path) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
const realWorkflow = read('../.github/workflows/ci.yml');
const realScripts = JSON.parse(read('../package.json')).scripts;
const [exception] = UNBOUNDED_EXCEPTIONS;

// Every negative control edits (a copy of) the real workflow, so a check is
// exercised against the steps it protects, not a toy.
const realDoc = parse(realWorkflow);
const problemsAfter = (edit, { scripts = realScripts, extraFiles = {} } = {}) => {
  const doc = structuredClone(realDoc);
  edit(doc);
  const extra = Object.fromEntries(Object.entries(extraFiles).map(([f, t]) => [f, parse(t)]));
  return parsedProblems({ 'ci.yml': doc, ...extra }, scripts);
};
const unitStep = (doc) => doc.jobs.quality.steps.find((step) => step.name === 'Unit tests');
const securityStep = (doc) =>
  doc.jobs[exception.job].steps.find((step) => step.name === exception.step);
const addStep = (doc, job, step) => doc.jobs[job].steps.push(step);

/** At least one problem, and one of them is the one `pattern` names. */
const assertRefused = (problems, pattern) => {
  assert.ok(
    problems.some((problem) => pattern.test(problem)),
    `expected a problem matching ${pattern}, got ${JSON.stringify(problems, null, 2)}`,
  );
};

test('the real workflow and package.json hold, parsed here or from text', () => {
  assert.deepEqual(unitStepProblems({ 'ci.yml': realWorkflow }, realScripts), []);
  assert.deepEqual(
    unitStepProblems({ 'ci.yml': stringify(realDoc, { lineWidth: 0 }) }, realScripts),
    [],
  );
  assert.deepEqual(
    problemsAfter(() => {}),
    [],
  );
});

test('a bounded step passes at every allowed value, and `bash` is an allowed shell', () => {
  for (let n = 1; n <= MAX_CONCURRENCY; n += 1) {
    assert.deepEqual(
      problemsAfter((doc) => {
        unitStep(doc).run = `pnpm run test:unit --concurrency=${n}`;
      }),
      [],
    );
  }
  assert.deepEqual(
    problemsAfter((doc) => {
      unitStep(doc).shell = 'bash';
      securityStep(doc).shell = 'bash';
    }),
    [],
  );
});

test('turbo default, an over-limit value, a zero, a percentage and a jest-bound flag are refused', () => {
  for (const run of [
    'pnpm run test:unit',
    `pnpm run test:unit --concurrency=${MAX_CONCURRENCY + 1}`,
    'pnpm run test:unit --concurrency=10',
    'pnpm run test:unit --concurrency=0',
    'pnpm run test:unit --concurrency=50%',
    'pnpm run test:unit -- --concurrency=3',
  ]) {
    const problems = problemsAfter((doc) => {
      unitStep(doc).run = run;
    });
    assert.ok(problems.length > 0, run);
  }
  assertRefused(
    problemsAfter((doc) => {
      unitStep(doc).run = 'pnpm run test:unit --concurrency=4';
    }),
    /concurrency 4 is outside 1\.\.3/,
  );
  assertRefused(
    problemsAfter((doc) => {
      unitStep(doc).run = 'pnpm run test:unit';
    }),
    /runs unit suites with "pnpm run test:unit"/,
  );
});

test('a renamed, removed or duplicated bounded step is refused rather than skipped', () => {
  assertRefused(
    problemsAfter((doc) => {
      unitStep(doc).name = 'Tests';
    }),
    /exactly one "Unit tests" step .* found 0/,
  );
  assertRefused(
    problemsAfter((doc) => {
      doc.jobs.quality.steps = doc.jobs.quality.steps.filter((step) => step.name !== 'Unit tests');
    }),
    /found 0/,
  );
  assertRefused(
    problemsAfter((doc) => {
      addStep(doc, 'quality', { ...unitStep(doc) });
    }),
    /found 2/,
  );
  // The bounded command must be the whole step, not one line of it.
  assertRefused(
    problemsAfter((doc) => {
      unitStep(doc).run = 'echo start\npnpm run test:unit --concurrency=3\n';
    }),
    /found 0/,
  );
});

test('the step must run: `if:` on it, on its job or on a job it needs is refused', () => {
  for (const condition of [false, '${{ false }}', 'always()', "github.event_name == 'push'"]) {
    assertRefused(
      problemsAfter((doc) => {
        unitStep(doc).if = condition;
      }),
      /"Unit tests"\): has `if: /,
    );
  }
  assertRefused(
    problemsAfter((doc) => {
      doc.jobs.quality.if = false;
    }),
    /quality.*job "quality" has `if: false`/,
  );
  // integration-security needs quality: a skipped quality skips the exception's job too.
  assertRefused(
    problemsAfter((doc) => {
      doc.jobs.quality.if = false;
    }),
    /integration-security.*job "quality" has `if: false`/,
  );
  assertRefused(
    problemsAfter((doc) => {
      securityStep(doc).if = false;
    }),
    /Tenant isolation and authorization tests"\): has `if: false`/,
  );
});

test('failure must propagate: step- or job-level continue-on-error is refused', () => {
  for (const value of [true, '${{ true }}']) {
    assertRefused(
      problemsAfter((doc) => {
        unitStep(doc)['continue-on-error'] = value;
      }),
      /has step-level `continue-on-error`/,
    );
    assertRefused(
      problemsAfter((doc) => {
        doc.jobs.quality['continue-on-error'] = value;
      }),
      /job "quality" has `continue-on-error`/,
    );
    assertRefused(
      problemsAfter((doc) => {
        doc.jobs[exception.job]['continue-on-error'] = value;
      }),
      /job "integration-security" has `continue-on-error`/,
    );
  }
  assert.deepEqual(
    problemsAfter((doc) => {
      unitStep(doc)['continue-on-error'] = false;
    }),
    [],
  );
});

test('the script must execute: a non-bash shell at step, job or workflow level is refused', () => {
  for (const shell of ['echo {0}', 'sh', 'pwsh', 'bash +e {0}']) {
    assertRefused(
      problemsAfter((doc) => {
        unitStep(doc).shell = shell;
      }),
      /runs under `shell: /,
    );
  }
  assertRefused(
    problemsAfter((doc) => {
      doc.jobs.quality.defaults = { run: { shell: 'echo {0}' } };
    }),
    /"Unit tests"\): runs under `shell: echo \{0\}`/,
  );
  assertRefused(
    problemsAfter((doc) => {
      doc.defaults = { run: { shell: 'echo {0}' } };
    }),
    /Tenant isolation.*runs under `shell: echo \{0\}`/,
  );
});

test('the script must run at the workspace root, without a shell start-up variable', () => {
  assertRefused(
    problemsAfter((doc) => {
      unitStep(doc)['working-directory'] = 'apps/web';
    }),
    /runs in `working-directory: apps\/web`/,
  );
  assertRefused(
    problemsAfter((doc) => {
      doc.jobs.quality.defaults = { run: { 'working-directory': 'apps/web' } };
    }),
    /runs in `working-directory: apps\/web`/,
  );
  assertRefused(
    problemsAfter((doc) => {
      unitStep(doc).env.BASH_ENV = './no-errexit.sh';
    }),
    /sets BASH_ENV/,
  );
  assertRefused(
    problemsAfter((doc) => {
      doc.env.SHELLOPTS = 'braceexpand';
    }),
    /sets SHELLOPTS/,
  );
});

test('a construct that skips or absorbs an invocation line is refused', () => {
  const cases = [
    ['pnpm run test:integration -- --x || true', /`\|\|`/],
    ['set +e', /`set \+…`/],
    ['exit 0', /`exit`\/`return`\/`trap`/],
    ["trap 'exit 0' ERR", /`exit`\/`return`\/`trap`/],
    ['! true', /a leading `!` or `exec`/],
    ['exec true', /a leading `!` or `exec`/],
    ['sleep 1 &', /a `&` background job/],
    ['if false; then', /shell control flow/],
    ['skip() {', /shell control flow/],
    ["cat <<'EOF'", /a here-document/],
    ['echo \\', /a `\\` continuation/],
    ['source ./no-errexit.sh', /`source`\/`\.`\/`eval`/],
    ['. ./no-errexit.sh', /`source`\/`\.`\/`eval`/],
    ['eval "set +o errexit"', /`source`\/`\.`\/`eval`/],
    ['echo "', /an open quote/],
  ];
  for (const [line, pattern] of cases) {
    assertRefused(
      problemsAfter((doc) => {
        const step = securityStep(doc);
        step.run = `${line}\n${step.run}`;
      }),
      pattern,
    );
  }
  // On the bounded step a suffix makes the command non-canonical.
  for (const run of [
    'pnpm run test:unit --concurrency=3 || true',
    'pnpm run test:unit --concurrency=3; exit 0',
    'set +e; pnpm run test:unit --concurrency=3',
  ]) {
    assertRefused(
      problemsAfter((doc) => {
        unitStep(doc).run = run;
      }),
      /found 0/,
    );
  }
  // The exception's trusted lines are exempt only verbatim.
  assertRefused(
    problemsAfter((doc) => {
      const step = securityStep(doc);
      step.run = step.run.replace('eval "${kafka_credentials}"', 'eval  "${kafka_credentials}"');
    }),
    /`source`\/`\.`\/`eval`/,
  );
});

test('another unit invocation anywhere, under any name or form, is refused', () => {
  const forms = [
    'pnpm run test:unit',
    'pnpm test:unit',
    'pnpm -w test:unit',
    'turbo run test:unit',
    'turbo test:unit',
    'pnpm exec turbo run test:unit --concurrency=3',
    'npx turbo run test --concurrency=1',
    'pnpm exec turbo run @rasta/web#test:unit',
    'pnpm test',
    'pnpm run test -- --testNamePattern=x',
    'node scripts/run-test-phases.mjs test',
    'pnpm run verify',
    'npm test',
    'bash -c "pnpm run test:unit"',
    // A second bounded copy is still a second invocation outside the step.
    'pnpm run test:unit --concurrency=3',
  ];
  for (const run of forms) {
    for (const job of ['quality', 'security', exception.job]) {
      assertRefused(
        problemsAfter((doc) => {
          addStep(doc, job, { name: 'Checks', run });
        }),
        new RegExp(`jobs\\.${job}\\.steps\\[\\d+\\] \\("Checks"\\): runs unit suites`),
      );
    }
  }
  // Inside a multi-line script of an existing step.
  assertRefused(
    problemsAfter((doc) => {
      const step = doc.jobs.quality.steps.find(
        (s) => s.name === 'Unit-step concurrency is bounded',
      );
      step.run = `${step.run}\npnpm test:unit`;
    }),
    /"Unit-step concurrency is bounded"\): runs unit suites with "pnpm test:unit"/,
  );
});

test('a root script that reaches the unit task counts as a unit invocation', () => {
  const scripts = {
    ...realScripts,
    'ci:unit': 'turbo run test:unit',
    'ci:all': 'pnpm run ci:unit',
  };
  for (const name of ['ci:unit', 'ci:all']) {
    assertRefused(
      problemsAfter(
        (doc) => {
          addStep(doc, 'security', { name: 'Checks', run: `pnpm run ${name}` });
        },
        { scripts },
      ),
      new RegExp(`runs unit suites with "pnpm run ${name}"`),
    );
  }
  assertRefused(
    problemsAfter(() => {}, { scripts: { ...realScripts, 'test:unit': 'node x.mjs' } }),
    /package.json "test:unit" must be `turbo run test:unit`/,
  );
});

test('test:unit spelled outside an accepted invocation is refused', () => {
  assertRefused(
    problemsAfter((doc) => {
      unitStep(doc).env.TASK = 'test:unit';
      addStep(doc, 'security', { name: 'Checks', run: 'pnpm run "$TASK"' });
    }),
    /jobs.quality.steps.\d+.env.TASK: mentions test:unit/,
  );
  assertRefused(
    problemsAfter((doc) => {
      addStep(doc, 'security', { name: 'Checks', run: 'echo test:unit' });
    }),
    /mentions test:unit outside an accepted invocation/,
  );
});

test('no false positives: other programs and other test tasks are not unit invocations', () => {
  for (const run of [
    'pnpm --filter @rasta/web exec playwright test',
    'pnpm run test:unit-step-concurrency',
    'pnpm run test:integration -- --testNamePattern=x',
    'pnpm --filter @rasta/web run test:coverage',
    'pnpm exec turbo run build --filter=./packages/*',
  ]) {
    assert.deepEqual(
      problemsAfter((doc) => {
        addStep(doc, 'security', { name: 'Checks', run });
      }),
      [],
      run,
    );
  }
});

test('the exception is named and exact: changed or moved, it is refused and reported stale', () => {
  const changed = problemsAfter((doc) => {
    const step = securityStep(doc);
    step.run = step.run.replace('subtree visibility)', 'subtree visibility|.)');
  });
  assertRefused(changed, /runs unit suites with "pnpm run test -- --testNamePattern=/);
  assertRefused(changed, /UNBOUNDED_EXCEPTIONS .* matched 0: update or remove/);
  assertRefused(
    problemsAfter((doc) => {
      addStep(doc, 'quality', { name: 'Checks', run: exception.command });
    }),
    /jobs\.quality\.steps\[\d+\] \("Checks"\): runs unit suites/,
  );
  assertRefused(
    problemsAfter((doc) => {
      const step = securityStep(doc);
      step.run = `${step.run}\n${exception.command}\n`;
    }),
    /matched 2/,
  );
  // Moved whole, same step name and command, into another job: still refused.
  assertRefused(
    problemsAfter((doc) => {
      const step = securityStep(doc);
      doc.jobs[exception.job].steps = doc.jobs[exception.job].steps.filter((s) => s !== step);
      addStep(doc, 'security', step);
    }),
    /jobs\.security\.steps\[\d+\] \("Tenant isolation and authorization tests"\): runs unit suites/,
  );
});

test('a local composite action or another workflow cannot carry a unit invocation', () => {
  const action = stringify({
    runs: { using: 'composite', steps: [{ run: 'pnpm run test:unit', shell: 'bash' }] },
  });
  assertRefused(
    problemsAfter(() => {}, { extraFiles: { 'actions/unit/action.yml': action } }),
    /actions\/unit\/action.yml runs.steps\[0\] \(null\): runs unit suites/,
  );
  const other = stringify({
    on: 'push',
    jobs: {
      quality: { steps: [{ name: 'Unit tests', run: 'pnpm run test:unit --concurrency=3' }] },
    },
  });
  assertRefused(
    problemsAfter(() => {}, { extraFiles: { 'other.yml': other } }),
    /other.yml jobs.quality.steps\[0\] \("Unit tests"\): runs unit suites/,
  );
});

test('a YAML merge key cannot hide a key from the guard', () => {
  const text = realWorkflow.replace(
    /^( +)- name: Unit tests\n/m,
    '$1- name: Unit tests\n$1  <<: { continue-on-error: true }\n',
  );
  assert.notEqual(text, realWorkflow);
  assertRefused(
    unitStepProblems({ 'ci.yml': text }, realScripts),
    /step-level `continue-on-error`/,
  );
});

test('unreadable YAML fails closed', () => {
  assertRefused(
    unitStepProblems({ 'ci.yml': 'jobs: [' }, realScripts),
    /ci.yml: not readable YAML/,
  );
  assertRefused(unitStepProblems({ 'ci.yml': 'jobs: {}\n' }, realScripts), /found 0/);
});
