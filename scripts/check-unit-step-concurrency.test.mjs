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
import {
  EXEMPT_SCRIPTS,
  nodeTestSegments,
  nodeTestTimeoutProblems,
  reachableScripts,
  runsNodeTest,
  UNIT_STEP,
} from './ci-node-test-timeouts-lib.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const realWorkflow = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
const realScripts = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts;
const realDoc = parse(realWorkflow);
const contracts = JSON.parse(readFileSync(join(root, 'packages/contracts/package.json'), 'utf8'));
const realPackages = { [contracts.name]: contracts.scripts };
const [exception] = UNBOUNDED_EXCEPTIONS;
const unitStep = (doc) => doc.jobs['quality-unit'].steps.find((step) => step.name === 'Unit tests');
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
const extraRun = (run, job = 'quality-unit') =>
  problemsAfter((doc) => doc.jobs[job].steps.push({ name: 'Another command', run }));

test('real workflow passes as YAML and as parsed text', () => {
  assert.deepEqual(unitStepProblems({ 'ci.yml': realWorkflow }, realScripts), []);
  assert.deepEqual(
    problemsAfter(() => {}),
    [],
  );
  assert.equal(realScripts['test:unit'], 'turbo run test:unit');
});

// Task 310: main 3fa1beeb hung 43 minutes in this step. Every node --test of the
// quality job keeps a --test-timeout, and this step keeps its own limit and its
// per-test watchdog.
const timeoutProblemsAfter = (edit, scripts = realScripts) => {
  const doc = structuredClone(realDoc);
  const copy = structuredClone(scripts);
  const packages = structuredClone(realPackages);
  edit(doc, copy, packages);
  return nodeTestTimeoutProblems(doc, copy, packages);
};
const boundedStep = (doc) =>
  doc.jobs['quality-unit'].steps.find((step) => step.name === UNIT_STEP.step);
// Every quality-* job (FU-111 split the one quality job into five), not the aggregate.
const qualityJobIds = Object.keys(realDoc.jobs).filter((id) => id.startsWith('quality-'));
const qualityNodeTestScripts = [
  ...new Set(
    qualityJobIds.flatMap((id) =>
      realDoc.jobs[id].steps.flatMap((step) =>
        typeof step.run === 'string' ? [...reachableScripts(step.run, realScripts)] : [],
      ),
    ),
  ),
].filter((name) => nodeTestSegments(realScripts[name]).length > 0);
test('FU-111: every quality-* job is read for node --test, and a later one too', () => {
  assert.deepEqual(qualityJobIds, [
    'quality-guards',
    'quality-lint',
    'quality-types',
    'quality-unit',
    'quality-build',
  ]);
  for (const id of qualityJobIds) {
    refused(
      timeoutProblemsAfter((doc) =>
        doc.jobs[id].steps.push({ name: 'Unbounded', run: 'node --test scripts/x.test.mjs' }),
      ),
      /Unbounded|--test-timeout/,
    );
  }
  refused(
    timeoutProblemsAfter((doc) => {
      doc.jobs['quality-later'] = {
        'runs-on': 'ubuntu-latest',
        steps: [{ name: 'Later', run: 'node --test scripts/x.test.mjs' }],
      };
    }),
    /Later|--test-timeout/,
  );
  refused(
    timeoutProblemsAfter(
      (doc) => (doc.jobs['quality-lint'].defaults = { run: { shell: 'python {0}' } }),
    ),
    /job quality-lint sets defaults\.run/,
  );
  refused(
    timeoutProblemsAfter((doc) => delete doc.jobs['quality-unit']),
    /job quality-unit has no readable steps/,
  );
});
test('task 310: the real quality job bounds every node --test', () => {
  assert.deepEqual(nodeTestTimeoutProblems(realDoc, realScripts, realPackages), []);
  // The class is found, not listed: the step that hung and the slowest others.
  for (const name of [UNIT_STEP.script, 'test:backup-restore-drill-lib', 'test:ci-trivy-db'])
    assert.ok(qualityNodeTestScripts.includes(name), name);
  assert.ok(qualityNodeTestScripts.length >= 40, String(qualityNodeTestScripts.length));
  assert.deepEqual(Object.keys(EXEMPT_SCRIPTS), ['lint:scripts']);
});
for (const name of qualityNodeTestScripts.filter((script) => !(script in EXEMPT_SCRIPTS))) {
  for (const [label, edit] of [
    ['missing', (text) => text.replaceAll(/ --test-timeout=\d+/g, '')],
    ['zero', (text) => text.replaceAll(/--test-timeout=\d+/g, '--test-timeout=0')],
    ['text', (text) => text.replaceAll(/--test-timeout=\d+/g, '--test-timeout=soon')],
    [
      'above the maximum',
      (text) => text.replaceAll(/--test-timeout=\d+/g, '--test-timeout=541000'),
    ],
    ['spaced form', (text) => text.replaceAll(/--test-timeout=(\d+)/g, '--test-timeout $1')],
  ]) {
    test(`task 310: ${label} --test-timeout is refused in ${name}`, () => {
      const problems = timeoutProblemsAfter((_doc, all) => {
        all[name] = edit(all[name]);
      });
      refused(
        problems,
        new RegExp(`script ${name.replaceAll('.', '\\.')} runs node --test without`),
      );
    });
  }
}
test('task 310: a new node --test is found directly and through script chains', () => {
  for (const [run, scripts] of [
    ['node --test scripts/new.test.mjs', {}],
    ['node --no-warnings --test scripts/new.test.mjs', {}],
    ['pnpm exec node --test scripts/new.test.mjs', {}],
    ['FOO=1 node --test=scripts/new.test.mjs', {}],
    ['true && node --test scripts/new.test.mjs --test-timeout=999999', {}],
    ['echo hi\nnode --test --test-timeout=0 x', {}],
    ['pnpm run test:new', { 'test:new': 'node --test scripts/new.test.mjs' }],
    ['pnpm run a', { a: 'pnpm run b', b: 'pnpm run c', c: 'true && node --test x' }],
    ['pnpm run a', { a: 'node --test --test-timeout=300000 x && node --test y' }],
  ]) {
    const problems = timeoutProblemsAfter((doc, all) => {
      Object.assign(all, scripts);
      doc.jobs['quality-unit'].steps.push({ name: 'Brand new step', run });
    });
    refused(
      problems,
      /(?:step "Brand new step"|script (?:test:new|c|a)) (?:runs node --test without|cannot be proven bounded)/,
    );
  }
  // A bounded one passes; so does a step in another job.
  assert.deepEqual(
    timeoutProblemsAfter((doc) => {
      doc.jobs['quality-unit'].steps.push({
        name: 'Fine',
        run: 'node --test --test-timeout=300000 scripts/x.test.mjs',
      });
      doc.jobs.security.steps.push({ name: 'Other job', run: 'node --test y' });
    }),
    [],
  );
});
// Task 312 (#606 r1 F1): the guard reads effective arguments, not text. Each form
// below was ACCEPTED by the text-matching guard of the previous head and is
// ineffective or undecidable: Node ignores options after the first file, a later
// --test-timeout=0 wins, comments and quoted payloads are not arguments, and a
// wrapper (absolute node, pnpm exec, sh -c ...) hides the command.
const B = '--test-timeout=300000';
const ineffectiveForms = {
  'a budget after the file (Node ignores it)': `node --test scripts/x.test.mjs ${B}`,
  'a budget after the file in a later segment': `true && node --test x ${B} && true`,
  'a later zero that disables the budget': `node --test ${B} --test-timeout=0 x`,
  'a second, different budget': `node --test ${B} --test-timeout=200000 x`,
  'the same budget twice': `node --test ${B} ${B} x`,
  'a budget in a comment': `node --test x # ${B}`,
  'a budget in a quoted file argument': `node --test "x ${B}"`,
  'a budget in an echo payload': `echo '${B}' && node --test x`,
  'a budget in a separate echo command': `echo ${B}; node --test x`,
  'an absolute node': `/usr/bin/node --test ${B} x`,
  'a quoted absolute node': `"/usr/bin/node" --test ${B} x`,
  'a relative node': `./node_modules/.bin/node --test ${B} x`,
  'node without a budget behind a quoted --test': 'node "--test" x',
  'node without a budget behind a quoted command': "'node' '--test' x",
  'a quoted option name that is not a budget': `node --test '--test-timeout=0' x`,
  'a budget given as a separate word': 'node --test --test-timeout 300000 x',
  'a budget through the --test= form': `node ${B} --test=x`,
  'an unlisted node option': `node --test --test-isolation=none ${B} x`,
  'an unlisted option before --test': `node --watch --test ${B} x`,
  'a computed option': `node --test ${B} $EXTRA x`,
  'a computed budget': 'node --test --test-timeout=$MS x',
  'a computed command word': `$NODE --test ${B} x`,
  'a brace-expanded budget': 'node --test --test-timeout={0,300000} x',
  'a glob in the option position': `node --test ${B} --test-timeo* x`,
  'a command substitution that runs node --test': 'echo "$(node --test x)"',
  'a backtick substitution that runs node --test': 'echo `node --test x`',
  'node --test inside a compound command': 'if true; then node --test x; fi',
  'a redirection': `node --test ${B} x > out.txt`,
  'pnpm exec delegation': `pnpm exec node --test ${B} x`,
  'pnpm exec behind workspace options': `pnpm --filter pkg exec node --test x`,
  'pnpm dlx delegation': 'pnpm dlx node --test x',
  'pnpm falling back to a binary': 'pnpm node --test x',
  'a pnpm script call with an option': 'pnpm run --silent test:bounded',
  'a pnpm script call with an option before run': 'pnpm --silent run test:bounded',
  'a pnpm script call with arguments': `pnpm run test:bounded ${B}=0`,
  'a pnpm script call with -- arguments': 'pnpm run test:bounded -- --test-timeout=0',
  'a pnpm script call into another directory': 'pnpm --dir elsewhere run test:bounded',
  'a pnpm script call for another package': 'pnpm --filter pkg run test:bounded',
  'a pnpm script that does not exist': 'pnpm run test:missing',
  'a pnpm built-in that is also a script name': 'pnpm exec',
  'npx delegation': `npx node --test ${B} x`,
  'env delegation': `env node --test ${B} x`,
  'a shell string': `sh -c "node --test x"`,
  'bash -c': `bash -c 'node --test ${B} x'`,
  'xargs delegation': 'echo x | xargs node --test',
  eval: 'eval "node --test x"',
  'a computed pnpm script name': 'pnpm run $SCRIPT',
  'a pnpm script name with a computed suffix': 'pnpm run test:bounded$SUFFIX',
  'node with a computed suffix': `node$SUFFIX --test ${B} x`,
  'an unterminated quote': `node --test ${B} 'x`,
};
for (const [label, run] of Object.entries(ineffectiveForms)) {
  for (const where of ['step', 'script']) {
    test(`task 312: ${label} is refused (${where})`, () => {
      const problems = timeoutProblemsAfter((doc, all) => {
        all['test:bounded'] = `node --test ${B} scripts/bounded.test.mjs`;
        all.exec = `node --test ${B} scripts/exec.test.mjs`; // shadowed by the pnpm built-in
        if (where === 'step') doc.jobs['quality-unit'].steps.push({ name: 'Escape', run });
        else {
          all['test:escape'] = run;
          doc.jobs['quality-unit'].steps.push({ name: 'Escape', run: 'pnpm run test:escape' });
        }
      });
      assert.notDeepEqual(problems, [], run);
    });
  }
}
test('task 312: the commands the quality job really uses are still accepted', () => {
  for (const run of [
    `node --test ${B} scripts/x.test.mjs scripts/y.test.mjs`,
    `node '--test' "--test-timeout=300000" 'scripts/x.test.mjs'`,
    `node --no-warnings --test ${B} --test-concurrency=1 x`,
    `node --test ${B} --import ${UNIT_STEP.watchdog} x`,
    `base=1 SERVICE_ENV_WITHHELD_BASE="$(node scripts/print.mjs)" node --test ${B} x`,
    `node --test ${B} x # a comment mentioning --test-timeout=0 and a stray ' quote`,
    `pnpm run test:bounded # && node --test unbounded.test.mjs`,
    `node --test \\\n  ${B} \\\n  x`,
    `pnpm --filter @rasta/contracts build && node --test ${B} x`,
    `pnpm --filter @rasta/contracts run build\nnode scripts/check.mjs --test`,
    `base="$(node scripts/print.mjs)"\nSERVICE_ENV_WITHHELD_BASE="$base" pnpm run test:bounded`,
    'node scripts/check.mjs --test-timeout=0 && echo done',
    'prettier --check "**/*.{ts,json}" && eslint scripts && turbo run lint --concurrency=3',
    'pnpm install --frozen-lockfile',
  ]) {
    const problems = timeoutProblemsAfter((doc, all) => {
      all['test:bounded'] = `node --test ${B} scripts/bounded.test.mjs`;
      doc.jobs['quality-unit'].steps.push({ name: 'Fine', run });
    });
    assert.deepEqual(problems, [], run);
  }
});
test('task 312: a step that changes the shell or directory is not readable as root scripts', () => {
  for (const extra of [{ shell: 'python {0}' }, { 'working-directory': 'services/x' }])
    refused(
      timeoutProblemsAfter((doc) =>
        doc.jobs['quality-unit'].steps.push({
          name: 'Odd',
          run: 'pnpm run test:progress',
          ...extra,
        }),
      ),
      /"Odd" sets shell or working-directory/,
    );
  refused(
    timeoutProblemsAfter((doc) => {
      doc.jobs['quality-unit'].defaults = { run: { 'working-directory': 'x' } };
    }),
    /sets defaults\.run/,
  );
});
// Task 322 (#606 r2 F1): ONE conservative scanner reads every command, and it REFUSES
// what it does not fully understand instead of skipping it. Each construct below hides a
// harmless `true`, so only its refusal can catch it (the reviewer's unbudgeted
// `node --test x` variants are in the second table). Every reason is asserted by name.
const REFUSALS = {
  'a parameter expansion with a default word': [
    '${UNSET:-$(true)}',
    /parameter expansion with an operator/,
  ],
  'a parameter expansion with an alternative': [
    '${UNSET:+$(true)}',
    /parameter expansion with an operator/,
  ],
  'a parameter expansion that assigns': ['${UNSET:=word}', /parameter expansion with an operator/],
  'a parameter expansion that substitutes': [
    '${UNSET//a/$(true)}',
    /parameter expansion with an operator/,
  ],
  'an array subscript': ['${ARR[$(true)]}', /parameter expansion with an operator/],
  'an indirect expansion': ['${!NAME}', /parameter expansion with an operator/],
  'a length expansion': ['${#NAME}', /parameter expansion with an operator/],
  'a quoted word in an expansion': ['${UNSET:-"a b"}', /parameter expansion with an operator/],
  'a workflow expression': ['${{ github.ref }}', /parameter expansion with an operator/],
  'a backslash-escaped parenthesis': [
    String.raw`$(echo \) true)`,
    /backslash inside a command substitution/,
  ],
  'an escaped quote in a substitution': [
    String.raw`$(echo \" true)`,
    /backslash inside a command substitution/,
  ],
  'a backslash in a backtick substitution': [
    '`echo \\` true`',
    /backslash inside a command substitution/,
  ],
  'an escaped quote in a quoted string in a substitution': [
    '$(echo "a\\"b" true)',
    /backslash inside a command substitution/,
  ],
  'a stray backslash in a quoted string in a substitution': [
    '$(echo "a\\)" true)',
    /backslash inside a command substitution/,
  ],
  'a commented parenthesis': ['$(true # )\ntrue)', /comment inside a command substitution/],
  'a comment in a backtick substitution': ['`true # x`', /comment inside a command substitution/],
  'an arithmetic expansion': ['$((1 + 2))', /arithmetic expansion/],
  'a bracket arithmetic expansion': ['$[1 + 2]', /arithmetic expansion/],
  'ANSI-C quoting': ["$'a\\'b'", /ANSI-C or locale quoting/],
  'locale quoting': ['$"a"', /ANSI-C or locale quoting/],
  'a here-document': ['<<EOF\nx\nEOF\n', /here-document/],
  'a here-string': ['<<< word', /here-document/],
  'a closing parenthesis without an opening one': [') true', /unbalanced closing parenthesis/],
  'an unterminated substitution': ['$(true', /unterminated command substitution/],
  'an unterminated backtick substitution': ['`true', /unterminated command substitution/],
  'substitutions nested too deeply': [
    '$(true $(true $(true $(true $(true)))))',
    /nested too deeply/,
  ],
};
const POSITIONS = {
  'an inert argument': (x) => `true ${x}`,
  'an assignment': (x) => `FOO=${x} true`,
  'a node file argument': (x) => `node --test ${B} ${x}`,
  'a pnpm-free echo': (x) => `echo ${x}`,
  'a double-quoted word': (x) => `echo "${x}"`,
};
for (const [label, [construct, reason]] of Object.entries(REFUSALS)) {
  for (const [position, place] of Object.entries(POSITIONS)) {
    // Quotes, here-documents and closers change meaning inside "..." or after `=`.
    if (position === 'a double-quoted word' && /^(?:ANSI|locale|a here|a closing)/.test(label))
      continue;
    const run = place(construct);
    for (const where of ['step', 'script'])
      test(`task 322: ${label} as ${position} is refused (${where})`, () => {
        const problems = timeoutProblemsAfter((doc, all) => {
          if (where === 'step') doc.jobs['quality-unit'].steps.push({ name: 'Escape', run });
          else {
            all['test:escape'] = run;
            doc.jobs['quality-unit'].steps.push({ name: 'Escape', run: 'pnpm run test:escape' });
          }
        });
        refused(problems, reason);
      });
  }
}
// The reviewer's executable reproductions: bash runs `node --test x` in each, with no budget.
for (const [label, run] of Object.entries({
  'a default word with a substitution': 'echo "${UNSET:-$(node --test x)}"',
  'an escaped parenthesis': String.raw`echo "$(echo \); node --test x)"`,
  'a commented parenthesis': 'echo "$(true # )\nnode --test x)"',
  'a quoted parenthesis': 'echo "$(echo ")"; node --test x)"',
  'a case pattern parenthesis': 'echo "$(case x in a) node --test x;; esac)"',
  'a backtick body behind an escape': 'echo "`echo \\`; node --test x`"',
  'an operator in an assignment': 'FOO=${UNSET:-$(node --test x)} true',
  'a subscript in a node file argument': `node --test ${B} \${ARR[$(node --test y)]}`,
}))
  for (const where of ['step', 'script'])
    test(`task 322: reviewer reproduction ${label} is refused (${where})`, () => {
      const problems = timeoutProblemsAfter((doc, all) => {
        if (where === 'step') doc.jobs['quality-unit'].steps.push({ name: 'Escape', run });
        else {
          all['test:escape'] = run;
          doc.jobs['quality-unit'].steps.push({ name: 'Escape', run: 'pnpm run test:escape' });
        }
      });
      assert.notDeepEqual(problems, [], run);
    });
test('task 322: expansions and substitutions that are fully understood are still accepted', () => {
  for (const run of [
    'echo "${HOME}" ${1} "${@}" "${#}" $HOME "$(node scripts/print.mjs)"',
    'echo "$(echo ")")" && echo "$(echo \'(\')"',
    'echo "$(echo "$(true)")" `true`',
    'echo \'${X:-$(node --test x)}\' "\\${X:-y}"',
    `base="$(true)" SERVICE_ENV_WITHHELD_BASE=\${HOME} node --test ${B} x`,
  ]) {
    const problems = timeoutProblemsAfter((doc) =>
      doc.jobs['quality-unit'].steps.push({ name: 'Fine', run }),
    );
    assert.deepEqual(problems, [], run);
  }
});
// The effective context: workflow defaults.run, job defaults.run, the step, and the
// environment the shell reads, each resolved and checked on its own.
const CONTEXT_EDITS = {
  'workflow python shell': [
    (doc) => (doc.defaults = { run: { shell: 'python {0}' } }),
    /the workflow sets defaults\.run/,
  ],
  'workflow bash with options': [
    (doc) => (doc.defaults = { run: { shell: 'bash -x {0}' } }),
    /the workflow sets defaults\.run/,
  ],
  'workflow working directory': [
    (doc) => (doc.defaults = { run: { 'working-directory': 'tests/e2e' } }),
    /the workflow sets defaults\.run/,
  ],
  'workflow bash in another directory': [
    (doc) => (doc.defaults = { run: { shell: 'bash', 'working-directory': '.' } }),
    /the workflow sets defaults\.run/,
  ],
  'workflow run as text': [
    (doc) => (doc.defaults = { run: 'bash' }),
    /the workflow sets defaults\.run to something/,
  ],
  'workflow run as a list': [
    (doc) => (doc.defaults = { run: [] }),
    /the workflow sets defaults\.run to something/,
  ],
  'workflow defaults as text': [
    (doc) => (doc.defaults = 'run'),
    /the workflow has defaults that cannot be read/,
  ],
  'workflow defaults empty': [
    (doc) => (doc.defaults = null),
    /the workflow has defaults that cannot be read/,
  ],
  'job python shell': [
    (doc) => (doc.jobs['quality-unit'].defaults = { run: { shell: 'python {0}' } }),
    /job quality-unit sets defaults\.run/,
  ],
  'job working directory': [
    (doc) => (doc.jobs['quality-unit'].defaults = { run: { 'working-directory': 'x' } }),
    /job quality-unit sets defaults\.run/,
  ],
  'job run as text': [
    (doc) => (doc.jobs['quality-unit'].defaults = { run: 'bash' }),
    /job quality-unit sets defaults\.run to something/,
  ],
  'job defaults as a list': [
    (doc) => (doc.jobs['quality-unit'].defaults = []),
    /job quality-unit has defaults that cannot be read/,
  ],
  'step python shell': [
    (doc) => (boundedStep(doc).shell = 'python {0}'),
    /step "Unit-step concurrency is bounded" sets shell or working-directory/,
  ],
  'step bash with options': [
    (doc) => (boundedStep(doc).shell = 'bash -e {0}'),
    /sets shell or working-directory/,
  ],
  'step shell as a list': [
    (doc) => (boundedStep(doc).shell = ['bash']),
    /sets shell or working-directory/,
  ],
  'step working directory': [
    (doc) => (boundedStep(doc)['working-directory'] = '.'),
    /sets shell or working-directory/,
  ],
  'workflow BASH_ENV': [(doc) => (doc.env.BASH_ENV = './x.sh'), /the workflow sets BASH_ENV/],
  'workflow NODE_OPTIONS': [
    (doc) => (doc.env.NODE_OPTIONS = '--x'),
    /the workflow sets NODE_OPTIONS/,
  ],
  'job PATH': [
    (doc) => (doc.jobs['quality-unit'].env = { PATH: '/x' }),
    /job quality-unit sets PATH/,
  ],
  'step BASH_FUNC': [
    (doc) => (boundedStep(doc).env = { 'BASH_FUNC_node%%': '() { :; }' }),
    /sets BASH_FUNC_node%%/,
  ],
  'workflow env as an expression': [
    (doc) => (doc.env = '${{ fromJSON(inputs.env) }}'),
    /the workflow has an env that cannot be read/,
  ],
  'step env as a list': [
    (doc) => (boundedStep(doc).env = ['PATH=/x']),
    /has an env that cannot be read/,
  ],
};
for (const uses of ['./.github/actions/x', './', 'docker://alpine'])
  CONTEXT_EDITS[`step uses ${uses}`] = [
    (doc) => doc.jobs['quality-unit'].steps.push({ name: 'Local', uses }),
    /step "Local" uses .* which cannot be read/,
  ];
CONTEXT_EDITS['a step that is not a map'] = [
  (doc) => doc.jobs['quality-unit'].steps.push(null),
  /step "undefined" cannot be read/,
];
for (const name of [
  'BASH_ENV',
  'ENV',
  'SHELLOPTS',
  'BASHOPTS',
  'PATH',
  'IFS',
  'CDPATH',
  'NODE_OPTIONS',
])
  CONTEXT_EDITS[`job ${name} (shell-read variable)`] = [
    (doc) => (doc.jobs['quality-unit'].env = { [name]: 'x' }),
    new RegExp(`job quality-unit sets ${name}`),
  ];
for (const [label, [edit, reason]] of Object.entries(CONTEXT_EDITS))
  test(`task 322: ${label} is refused`, () => refused(timeoutProblemsAfter(edit), reason));
test('task 322: a plain bash or sh at any level, and ordinary env names, are accepted', () => {
  for (const edit of [
    (doc) => (doc.defaults = { run: { shell: 'bash' } }),
    (doc) => (doc.jobs['quality-unit'].defaults = { run: { shell: 'sh' } }),
    (doc) => (boundedStep(doc).shell = 'bash'),
    (doc) => (boundedStep(doc).env = { TEMPORAL_TEST_SERVER_DIR: 'x', NODE_VERSION: '22' }),
  ])
    assert.deepEqual(timeoutProblemsAfter(edit), []);
});
test('task 322: the step must run the unit-step script, and the script must be readable', () => {
  refused(
    timeoutProblemsAfter((doc) => (boundedStep(doc).run = `echo pnpm run ${UNIT_STEP.script}`)),
    /must run test:unit-step-concurrency/,
  );
  refused(
    timeoutProblemsAfter((doc) => (boundedStep(doc).run = `pnpm run ${UNIT_STEP.script} ${B}`)),
    /must run test:unit-step-concurrency/,
  );
  refused(
    timeoutProblemsAfter(
      (doc) => (boundedStep(doc).run = `pnpm run ${UNIT_STEP.script} && true \${X:-a}`),
    ),
    /must run test:unit-step-concurrency/,
  );
  // Appended after the real command, behind a refused construct: the watchdog check alone
  // (not the generic one) names it.
  refused(
    timeoutProblemsAfter((_doc, all) => {
      all[UNIT_STEP.script] = `${realScripts[UNIT_STEP.script]} && echo "\${UNSET:-$(true)}"`;
    }),
    /must preload/,
  );
});
// The watchdog preload is an argument of the one node --test command, before its files.
{
  const watchdog = UNIT_STEP.watchdog;
  const preload = `${UNIT_STEP.preload} ${watchdog} `;
  for (const [label, edit] of Object.entries({
    'after the files': (text) => text.replace(preload, '').replace(' && ', ` ${preload}&& `),
    'in a comment': (text) => text.replace(preload, '').replace(' && ', ` # ${preload}\n&& `),
    'in an echo': (text) => `${text.replace(preload, '')} && echo ${preload}`,
    'in a quoted file argument': (text) => text.replace(preload, `"x ${preload}" `),
    'next to another preload': (text) => text.replace(preload, `--import ./other.mjs ${preload}`),
    twice: (text) => text.replace(preload, `${preload}${preload}`),
    computed: (text) => text.replace(watchdog, '$WATCHDOG'),
    'as the --require=<file> form': (text) => text.replace(preload, `--require=${watchdog} `),
    // FU-118: the runner never loads an --import preload, so it would not guard the runner.
    'as an --import the runner never loads': (text) =>
      text.replace(preload, `--import ${watchdog} `),
    'with a second node --test command': (text) => `${text} && node --test ${B} y`,
  }))
    test(`task 312: a watchdog preload ${label} is refused`, () => {
      refused(
        timeoutProblemsAfter((_doc, all) => {
          all[UNIT_STEP.script] = edit(realScripts[UNIT_STEP.script]);
        }),
        /must preload|cannot be proven bounded/,
      );
    });
}
// Task 4003 (#669 r1): the grammar is closed. Each harmful input first does its harm under the
// real bash, node or pnpm, then the guard refuses it, so no case is vacuous.
const inTemp = (use) => {
  const dir = mkdtempSync(join(tmpdir(), 'guard-4003-'));
  try {
    return use(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
const bashStderr = (run, shims = ['node', 'pnpm']) =>
  inTemp((dir) => {
    for (const name of shims)
      writeFileSync(join(dir, name), `#!/bin/sh\necho "RAN ${name} $*" >&2\n`, { mode: 0o755 });
    const env = { PATH: `${dir}:${process.env.PATH}` };
    return spawnSync('bash', ['-c', run], { encoding: 'utf8', env }).stderr;
  });
const pnpmStdout = (scripts, argv, extra = {}) =>
  inTemp((cwd) => {
    const { packageManager } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    const manifest = { name: 'rasta', packageManager, scripts };
    writeFileSync(join(cwd, 'package.json'), JSON.stringify(manifest));
    writeFileSync(join(cwd, 'pnpm-workspace.yaml'), 'packages: []\n');
    // The repository's own pnpm, never a download (a Corepack shim would fetch the latest).
    const env = { ...extra, PATH: process.env.PATH, HOME: process.env.HOME };
    env.COREPACK_ENABLE_NETWORK = '0';
    return spawnSync('pnpm', argv, { cwd, encoding: 'utf8', env }).stdout;
  });
const refusedAtBoth = (run, reason, edit = () => {}) => {
  for (const where of ['step', 'script']) {
    const problems = timeoutProblemsAfter((doc, all, packages) => {
      edit(all, packages);
      if (where === 'script') all['test:escape'] = run;
      const command = where === 'step' ? run : 'pnpm run test:escape';
      doc.jobs['quality-unit'].steps.push({ name: 'Escape', run: command });
    });
    refused(problems, reason);
  }
};
const UNBUDGETED = /RAN node --test \/dev\/null/;
const PRELOAD = '--import data:text/javascript,console.error(String.fromCharCode(82,65,78))';
test('task 4003: F1 a carriage return or other unreadable character is refused', () => {
  assert.match(bashStderr('echo \r#; node --test /dev/null'), UNBUDGETED);
  for (const run of ['echo \r#; true', 'true\r\n', 'echo "\r"', 'echo a #', 'echo \f#'])
    refusedAtBoth(run, /a carriage return, control/);
});
test('task 4003: F2 arithmetic evaluation is refused wherever it can start', () => {
  const inner = "'arr[$(node --test /dev/null)]'";
  for (const [run, reason] of [
    [`a=${inner}; ((x=a+1))`, /an assignment to a /],
    [`base=${inner}; ((base))`, /a subshell or an arithmetic command/],
    [`base=${inner}; if ((base)); then true; fi`, /a subshell or an arithmetic command/],
    [`base=${inner}; echo "$(( base ))"`, /arithmetic expansion/],
    [`base=${inner}; let base`, /the command let/],
    [`base=${inner}; [[ base -eq 1 ]]`, /computed command word/],
    [`RANDOM=${inner}`, /an assignment to RANDOM /],
    [`SRANDOM=${inner}`, /an assignment to SRANDOM /],
    [`OPTIND=${inner}`, /an assignment to OPTIND /],
  ]) {
    assert.match(bashStderr(run), UNBUDGETED, run);
    refusedAtBoth(run, reason);
  }
});
test('task 4003: F3 inline assignments, env files and shell overrides meet one policy', () => {
  for (const [run, reason] of [
    [`NODE_OPTIONS='${PRELOAD}' node /dev/null`, /an assignment to NODE_OPTIONS /],
    [`node '${PRELOAD.replace(' ', "' '")}' /dev/null`, /a node --import that is not the watchdog/],
  ]) {
    assert.match(bashStderr(run, []), /RAN/);
    refusedAtBoth(run, reason);
  }
  for (const option of ['--env-file', '--env-file-if-exists']) {
    const ran = inTemp((dir) => {
      writeFileSync(join(dir, 'x.env'), `NODE_OPTIONS=${PRELOAD}\n`);
      return bashStderr(`node ${option}=${join(dir, 'x.env')} /dev/null`, []);
    });
    assert.match(ran, /RAN/);
    refusedAtBoth(`node ${option}=x.env /dev/null`, /an unlisted node option --env-file/);
  }
  const script = { x: 'echo HERE' };
  assert.match(pnpmStdout(script, ['run', 'x']), /^HERE$/m);
  const override = { PNPM_CONFIG_SCRIPT_SHELL: '/bin/true' };
  assert.doesNotMatch(pnpmStdout(script, ['run', 'x'], override), /^HERE$/m);
  const spellings = ['NPM', 'PNPM'].flatMap((tool) => [
    `${tool}_CONFIG_SCRIPT_SHELL`,
    `${tool.toLowerCase()}_config_script_shell`,
  ]);
  for (const name of spellings) {
    refusedAtBoth(`${name}=/bin/true pnpm run test:progress`, new RegExp(`assignment to ${name} `));
    for (const level of [(doc) => doc, (doc) => doc.jobs['quality-unit'], boundedStep])
      refused(
        timeoutProblemsAfter((doc) => (level(doc).env = { [name]: '/bin/true' })),
        new RegExp(`sets ${name}, which may change`),
      );
  }
  // A shell override in a pnpm config file of the repository is the same source.
  for (const file of ['.npmrc', 'pnpm-workspace.yaml'])
    assert.doesNotMatch(readFileSync(join(root, file), 'utf8'), /script-?shell|shell-?emulator/i);
});
test('task 4003: F4 a required command must really run, at both boundaries', () => {
  const required = `pnpm run ${UNIT_STEP.script}`;
  const never = [
    (x) => `true || ${x}`,
    (x) => `if ! true; then ${x}; fi`,
    (x) => `while ! true; do ${x}; done`,
  ];
  for (const wrap of never) assert.doesNotMatch(bashStderr(wrap(required)), /RAN pnpm/);
  const other = [(x) => `echo "$(${x})"`, (x) => `echo x && ${x}`, (x) => `base=1 ${x}`];
  const mustRun = /must run test:unit-step-concurrency unconditionally/;
  for (const wrap of [...never, ...other]) {
    refused(
      timeoutProblemsAfter((doc) => (boundedStep(doc).run = wrap(required))),
      mustRun,
    );
    const script = wrap(realScripts[UNIT_STEP.script]);
    refused(
      timeoutProblemsAfter((_doc, all) => (all[UNIT_STEP.script] = script)),
      /must preload/,
    );
  }
  refused(
    timeoutProblemsAfter((doc) => (boundedStep(doc).if = 'false')),
    mustRun,
  );
  refused(
    timeoutProblemsAfter((doc) => (boundedStep(doc)['continue-on-error'] = true)),
    mustRun,
  );
});
test('task 4003: F5 a pnpm target is resolved and read, never exempted by script name', () => {
  const selectors = ['--dir .', '-C .', '--filter rasta', '-F rasta'];
  const bad = (all) => (all.build = all.lint = all.typecheck = 'node --test /dev/null');
  for (const selector of selectors) {
    const argv = [...selector.split(' '), 'run', 'build'];
    assert.match(pnpmStdout({ build: 'echo HERE' }, argv), /^HERE$/m);
    for (const name of ['build', 'lint', 'typecheck'])
      for (const run of [`pnpm ${selector} run ${name}`, `pnpm ${selector} ${name}`])
        refusedAtBoth(run, /a pnpm form that is not|a package that was not read/, bad);
  }
  const contract = '@rasta/contracts';
  const inContract = (name, text) => (_all, packages) => (packages[contract][name] = text);
  for (const [run, reason, edit] of [
    [
      `pnpm --filter ${contract} build`,
      /without exactly one/,
      inContract('build', 'node --test x'),
    ],
    [`pnpm --filter ${contract} build`, /prebuild: the command sh/, inContract('prebuild', 'sh x')],
    [`pnpm --filter ${contract} run test:unit`, /test:unit: the command jest/],
    [`pnpm --filter ${contract} run missing`, /an unknown script missing/],
    [`pnpm --filter ${contract} lint`, /a pnpm form that is not/],
    [`pnpm --filter ${contract}... build`, /a package that was not read/],
    ['pnpm --filter constructor build', /a package that was not read/],
  ])
    refusedAtBoth(run, reason, edit);
  // Omitting the table of read packages opens nothing.
  refused(nodeTestTimeoutProblems(realDoc, realScripts), /a package that was not read/);
});
test('task 4003: what pnpm runs on its own around a script is read too', () => {
  const scripts = { prex: 'echo A', x: 'echo B', postx: 'echo C', postinstall: 'echo D' };
  const output = pnpmStdout(scripts, ['run', 'x']);
  for (const line of ['A', 'B', 'C']) assert.match(output, new RegExp(`^${line}$`, 'm'));
  assert.match(pnpmStdout(scripts, ['install', '--offline']), /\bD$/m);
  for (const name of ['pretest:progress', 'posttest:progress', 'preinstall', 'postinstall'])
    refusedAtBoth(
      'pnpm run test:progress',
      new RegExp(`script ${name} runs node --test without`),
      (all) => {
        all[name] = 'node --test /dev/null';
      },
    );
  refusedAtBoth(
    'pnpm install --frozen-lockfile',
    /script prepare runs node --test without/,
    (all) => {
      all.prepare = 'node --test /dev/null';
    },
  );
});
test('task 4003: other forms outside the grammar are refused', () => {
  const split = 'echo "$\\\n(node --test /dev/null)"';
  assert.match(bashStderr(split), UNBUDGETED);
  for (const [run, reason] of [
    [split, /a line continuation inside a word/],
    ['echo $\\\n(true)', /a line continuation inside a word/],
    ['echo $\\\n{X:-$(true)}', /a line continuation inside a word/],
    ['true\\', /a backslash at the end/],
    ['true | true', /a pipeline/],
    ['true || true', /a pipeline/],
    ['true & true', /a pipeline/],
    ['if true; then true; fi', /the command if/],
    ['! true', /the command !/],
    ['(true)', /a subshell/],
    ['f() { true; }', /a subshell/],
    ['pnpm install --ignore-scripts', /a pnpm form/],
    ['pnpm build', /a pnpm form/],
  ])
    refusedAtBoth(run, reason);
});
test('task 310: cycles terminate, inherited names are not scripts, other commands are free', () => {
  assert.equal(runsNodeTest('pnpm run a', { a: 'pnpm run b', b: 'pnpm run a' }), false);
  assert.equal(runsNodeTest('pnpm constructor', {}), false);
  assert.equal(runsNodeTest('pnpm toString', {}), false);
  assert.equal(runsNodeTest('echo "node-test" && pnpm run build', { build: 'tsc' }), false);
  assert.equal(runsNodeTest('pnpm run a', { a: 'node --test x' }), true);
  assert.deepEqual(
    timeoutProblemsAfter((doc) =>
      doc.jobs['quality-unit'].steps.push({ name: 'Plain', run: 'echo done' }),
    ),
    [],
  );
});
test('task 310: an unreadable run or job is refused, not assumed free of node --test', () => {
  refused(
    timeoutProblemsAfter((doc) => doc.jobs['quality-unit'].steps.push({ name: 'Odd', run: ['a'] })),
    /"Odd": run is not text/,
  );
  refused(
    nodeTestTimeoutProblems({ jobs: { 'quality-unit': {} } }, realScripts),
    /no readable steps/,
  );
});
test('task 310: an exemption that no longer applies is refused', () => {
  refused(
    timeoutProblemsAfter((_doc, all) => {
      all['lint:scripts'] = 'eslint scripts';
    }),
    /exempt script lint:scripts is not a node --test script/,
  );
  refused(
    timeoutProblemsAfter((_doc, all) => {
      delete all['lint:scripts'];
    }),
    /exempt script lint:scripts is not a node --test script/,
  );
});
test('task 310: the unit-step step keeps its step limit, file budget and watchdog', () => {
  const script = realScripts[UNIT_STEP.script];
  assert.match(script, /--test-timeout=540000 /);
  assert.match(script, /--require \.\/scripts\/test-stall-watchdog\.mjs /);
  assert.match(script, /scripts\/test-stall-watchdog\.test\.mjs/);
  assert.equal(boundedStep(realDoc)['timeout-minutes'], UNIT_STEP.maxMinutes);
  for (const [edit, pattern] of [
    [(text) => text.replace(/--require \S+ /, ''), /must preload/],
    [(text) => text.replace('--require ./', '--require ../'), /must preload/],
    [(text) => text.replace('--require ./', '--import ./'), /must preload/],
    [
      (text) => text.replace(/ --test-timeout=\d+/, ''),
      /script test:unit-step-concurrency runs node/,
    ],
  ])
    refused(
      timeoutProblemsAfter((_doc, all) => {
        all[UNIT_STEP.script] = edit(script);
      }),
      pattern,
    );
  for (const [value, pattern] of [
    [UNIT_STEP.maxMinutes + 1, /timeout-minutes must be at most/],
    [undefined, /needs a whole-minute timeout-minutes/],
    [0, /needs a whole-minute timeout-minutes/],
    ['10', /needs a whole-minute timeout-minutes/],
    [2.5, /needs a whole-minute timeout-minutes/],
  ])
    refused(
      timeoutProblemsAfter((doc) => {
        if (value === undefined) delete boundedStep(doc)['timeout-minutes'];
        else boundedStep(doc)['timeout-minutes'] = value;
      }),
      pattern,
    );
  refused(
    timeoutProblemsAfter((doc) => {
      doc.jobs['quality-unit'].steps = doc.jobs['quality-unit'].steps.filter(
        (step) => step.name !== UNIT_STEP.step,
      );
    }),
    /not found/,
  );
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
      doc.jobs['quality-unit'].steps = doc.jobs['quality-unit'].steps.filter(
        (step) => step.name !== 'Unit tests',
      );
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
      doc.jobs['quality-unit'].steps = doc.jobs['quality-unit'].steps.filter(
        (step) => step.name !== 'Unit tests',
      );
    },
    /found 0/,
  ],
  [
    'duplicate',
    (doc) => {
      doc.jobs['quality-unit'].steps.push({ ...unitStep(doc) });
    },
    /found 2/,
  ],
  [
    'duplicate with different run',
    (doc) => {
      doc.jobs['quality-unit'].steps.push({ name: 'Unit tests', run: 'echo test' });
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
            (level === 'step' ? unitStep(doc) : doc.jobs['quality-unit'])[key] = value;
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
for (const job of ['quality', 'quality-lint', 'quality-unit', 'security', 'integration-security']) {
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
      doc.jobs['quality-unit'].steps.push(securityStep(doc));
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
  fixture.doc.jobs['quality-unit'].steps.push({ uses: './ci/outer' });
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
    fixture.doc.jobs['quality-unit'].steps.push({ uses: './ci/broken' });
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
  fixture.doc.jobs['quality-unit'].steps.push({ uses: './ci/outer' });
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
    'quality-unit': { steps: [unitStep(realDoc)] },
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
    fixture.doc.jobs['quality-unit'].steps.push({ run: `${site} ./ci/one.sh` });
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
  fixture.doc.jobs['quality-unit'].steps.push({ run: 'source ./ci/directory' });
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
    // TASK 863: known invalid prefixes refuse before opaque expansion dispatch.
    ['eval "--unknown $x"', /unmodelled evaluation option/],
    ['source "-bad $x"', /unmodelled evaluation option/],
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
  fixture.doc.jobs['quality-unit'].steps.push(step);
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
  fixture.doc.jobs['quality-unit'].steps.push(step);
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
  fixture.doc.jobs['quality-unit'].steps.push(step);
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
  fixture.doc.jobs['quality-unit'].steps.push(step);
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

// TASK 863 / r9: validate known eval/source options before dynamic dispatch at
// the shared classifier boundary. No expansion values or new shell grammar.
const r9Reproductions = [
  'eval --unknown "$x"',
  'eval "--unknown $x"',
  'builtin -- eval --unknown "$x"',
  `eval 'eval --unknown "$x"'`,
  'source "--unknown $x"',
  '. "-bad $x"',
];
for (const run of r9Reproductions) {
  test(`r9 reviewer REFUSED: ${run}`, () => refused(extraRun(run), /unmodelled evaluation option/));
}
test('r9 CLI refuses known prefixes directly and through all five repository entries', (t) => {
  const fixture = cliFixture(t);
  for (const [index, run] of r9Reproductions.entries()) {
    const path = `./ci/options-${index}.sh`;
    fixture.write(path, `# test:unit\n${run}`);
    for (const entry of [run, ...r8Entries.map((site) => `${site} ${path}`)])
      fixture.doc.jobs['quality-unit'].steps.push({ name: 'r9 prefix', run: entry });
  }
  fixture.workflow();
  const result = fixture.run();
  assert.equal(result.status, 1, result.stderr);
  assert.equal(
    [...result.stderr.matchAll(/unmodelled evaluation option/g)].length,
    r9Reproductions.length * (1 + r8Entries.length),
    result.stderr,
  );
});
const r9Paths = [(run) => run, (run) => `builtin -- ${run}`, (run) => `eval ${r8Quote(run)}`];
const r9Wrappers = ['', 'env FLAG=value', 'command --', 'pnpm exec', 'npx', 'timeout 1'];
for (const [file, document] of scannedLocations) {
  for (const newline of [null, '\n', '\r\n', '\r']) {
    for (const program of ['eval', 'source', '.']) {
      for (const args of ['--unknown "$x"', '"--unknown $x"', '"-bad${x}"', '"-${x:-safe}"']) {
        for (const enter of r9Paths) {
          for (const wrapper of r9Wrappers) {
            const run = continued(`${wrapper} ${enter(`${program} ${args}`)}`.trim(), newline);
            test(`r9 order REFUSED ${file} ${JSON.stringify(newline)}: ${run}`, () => {
              refused(r7Problems(file, document, run), /unmodelled evaluation option/);
              for (const site of r8Entries) {
                // The existing token-bearing-script rule must reach this same
                // boundary without an actual unbounded invocation in the file.
                const reader = (path) => ({ path, text: `# test:unit\n${run}` });
                refused(
                  r7Problems(file, document, `${site} ./ci/options.sh`, reader),
                  /unmodelled evaluation option/,
                );
              }
            });
          }
        }
      }
    }
  }
  for (const run of [
    'eval "$x--unknown"',
    'eval "${x:---unknown}"',
    'eval -- "echo safe $x"',
    'eval "echo --unknown $x"',
    'source "$x--unknown"',
    '. "${x:--bad}"',
    'source -- /outside.sh "$x"',
    '. /outside.sh "-bad $x"',
  ]) {
    for (const enter of r9Paths) {
      test(`r9 opaque ACCEPTED ${file}: ${enter(run)}`, () =>
        assert.deepEqual(r7Problems(file, document, enter(run)), []));
    }
  }
}
