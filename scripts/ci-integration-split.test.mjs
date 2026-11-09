import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import {
  AGGREGATE_JOB,
  ALLOWED_CONDITIONS,
  QUALITY_GATE_JOB,
  QUALITY_JOBS,
  qualitySplitProblems,
  unitCoverageProblems,
  JOB_FLOOR_MINUTES,
  JOB_SETUP_MINUTES,
  INTEGRATION_PARTITIONS,
  SPLIT_STEPS,
  STEP_INVENTORY,
  checkIntegrationSplit,
  checkIntegrationSplitText,
  jobBudgetProblems,
  discoverIntegrationPackages,
  integrationPartitionProblems,
  integrationPartitionStepProblems,
} from './ci-integration-split-lib.mjs';
import { workspaceDirectories, workspaceManifestFiles } from './workspace-roots-lib.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TEXT = readFileSync(resolve(ROOT, '.github/workflows/ci.yml'), 'utf8');
const PARSED = parseYaml(TEXT);
const real = () => structuredClone(PARSED);
const fails = (workflow, pattern, root = ROOT) => {
  const problems = checkIntegrationSplit(workflow, root);
  assert.ok(
    problems.some((problem) => pattern.test(problem)),
    `expected a problem matching ${pattern}, got: ${JSON.stringify(problems)}`,
  );
};
const splitJobs = (workflow) =>
  Object.keys(workflow.jobs).filter((id) => id.startsWith('integration-'));
const jobRunning = (workflow, name) =>
  splitJobs(workflow).find((id) => workflow.jobs[id].steps.some((step) => step.name === name));
const stepNamed = (workflow, name) =>
  workflow.jobs[jobRunning(workflow, name)].steps.find((step) => step.name === name);
const verdict = (workflow) => workflow.jobs[AGGREGATE_JOB].steps[0];
const dropStep = (job, name) => {
  job.steps = job.steps.filter((step) => step.name !== name);
};
const escape = (text) => text.replace(/[()]/g, '\\$&');

test('disk discovery covers the live partition, including the empty gateway project', () => {
  assert.deepEqual(
    discoverIntegrationPackages(),
    Object.values(INTEGRATION_PARTITIONS).flat().sort(),
  );
  assert.deepEqual(integrationPartitionProblems(), []);
});

/** What git sees changed or untracked under the repository (the fixture must add nothing). */
const repositoryChanges = () => {
  const run = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.equal(run.status, 0, `git status failed: ${run.stderr}`);
  return run.stdout;
};

/**
 * A copy of the live workspace layout (manifests only) in the OS temp directory,
 * outside the repository: other guards walking the repository never see it and a
 * killed test leaves nothing in it. Removed in `finally`.
 */
const withLiveWorkspaceCopy = (use) => {
  const copy = mkdtempSync(resolve(tmpdir(), 'integration-split-live-'));
  try {
    assert.ok(relative(ROOT, copy).startsWith('..'), `${copy} must be outside ${ROOT}`);
    for (const file of ['pnpm-workspace.yaml', 'package.json', ...workspaceManifestFiles(ROOT)]) {
      mkdirSync(dirname(resolve(copy, file)), { recursive: true });
      copyFileSync(resolve(ROOT, file), resolve(copy, file));
    }
    return use(copy);
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
};

test('the workflow validator refuses a newly added, unassigned workspace on disk', () => {
  const before = repositoryChanges();
  withLiveWorkspaceCopy((copy) => {
    assert.deepEqual(checkIntegrationSplit(real(), copy), [], 'the copy mirrors the live layout');
    mkdirSync(resolve(copy, 'packages/ci-integration-discovery'));
    writeFileSync(
      resolve(copy, 'packages/ci-integration-discovery/package.json'),
      JSON.stringify({ name: '@rasta/new-workspace', scripts: { 'test:integration': 'jest' } }),
    );
    fails(
      real(),
      /@rasta\/new-workspace: expected exactly one integration partition, found 0/,
      copy,
    );
    assert.match(
      checkIntegrationSplitText(TEXT, copy).join('\n'),
      /@rasta\/new-workspace: expected exactly one integration partition, found 0/,
    );
  });
  // Nothing was created under the repository, so no concurrent guard can see it
  // and a SIGKILL cannot leave it behind.
  assert.equal(repositoryChanges(), before);
  assert.equal(existsSync(resolve(ROOT, 'packages/ci-integration-discovery')), false);
});

test('partition mutants: drop, duplicate within/across partitions, and unknown package fail', () => {
  const packages = discoverIntegrationPackages();
  assert.match(integrationPartitionProblems({ suites: packages.slice(1) }).join('\n'), /found 0/);
  assert.match(
    integrationPartitionProblems({ suites: [...packages, packages[0]] }).join('\n'),
    /found 2/,
  );
  assert.match(
    integrationPartitionProblems({ suites: packages, other: [packages[0]] }).join('\n'),
    /found 2/,
  );
  assert.match(
    integrationPartitionProblems({ suites: [...packages, '@rasta/unknown'] }).join('\n'),
    /unknown integration package/,
  );
  for (const invalid of [null, [], {}, { suites: [] }, { suites: 'all' }]) {
    assert.ok(integrationPartitionProblems(invalid).length > 0);
  }
});

test('FU-027: partition keys cannot be renamed, added or removed independently', () => {
  for (const change of ['rename', 'add', 'remove']) {
    const partitions = structuredClone(INTEGRATION_PARTITIONS);
    if (change !== 'add') delete partitions['Integration construction'];
    if (change !== 'remove') partitions['Unregistered suite'] = ['@rasta/construction-service'];
    assert.match(
      integrationPartitionStepProblems(real(), partitions).join('\n'),
      /partition step missing from suite inventory|suite inventory step has no partition/,
    );
  }
});

test('FU-027: inventory keys cannot be renamed, added or removed independently', () => {
  for (const change of ['rename', 'add', 'remove']) {
    const inventory = structuredClone(STEP_INVENTORY);
    if (change !== 'remove')
      inventory['Unregistered suite'] = inventory['Integration construction'];
    if (change !== 'add') delete inventory['Integration construction'];
    assert.match(
      integrationPartitionStepProblems(real(), INTEGRATION_PARTITIONS, inventory).join('\n'),
      /partition step missing from suite inventory|suite inventory step has no partition/,
    );
  }
});

test('FU-027: workflow suite steps cannot be renamed, added or removed independently', () => {
  for (const change of ['rename', 'add', 'remove']) {
    const workflow = real();
    const step = stepNamed(workflow, 'Integration construction');
    if (change === 'add') {
      workflow.jobs['integration-construction'].steps.push({ ...step, name: 'Unregistered suite' });
    } else if (change === 'rename') step.name = 'Unregistered suite';
    else dropStep(workflow.jobs['integration-construction'], step.name);
    fails(workflow, /workflow suite step has no partition|partition step must occur exactly once/);
  }
  for (const run of [
    'pnpm run test:integration',
    'node scripts/run-test-phases.mjs test:integration',
  ]) {
    const extra = real();
    extra.jobs.quality.steps.push({ name: 'Unregistered suite', run });
    fails(extra, /workflow integration step missing from inventory/);
  }
  const outside = real();
  outside.jobs.quality.steps.push({
    name: 'Tenant isolation and financial invariant tests',
    run: 'pnpm run test:integration',
  });
  fails(outside, /integration execution must run in an integration-\* job/);
  const workflow = real();
  workflow.jobs.quality.steps.push(
    structuredClone(stepNamed(workflow, 'Integration construction')),
  );
  fails(workflow, /partition step must occur exactly once in workflow, found 2/);
});

const workspaceFixture = (t) => {
  const root = mkdtempSync(resolve(tmpdir(), 'integration-discovery-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (file, value) => {
    mkdirSync(dirname(resolve(root, file)), { recursive: true });
    writeFileSync(resolve(root, file), JSON.stringify(value));
  };
  put('pnpm-workspace.yaml', {
    packages: [
      'apps/*',
      'services/*',
      'packages/*',
      'tests/*',
      'extensions/*/*',
      '!extensions/nested/excluded',
    ],
  });
  put('package.json', {
    name: 'orchestration',
    scripts: { 'test:integration': 'node orchestrate' },
  });
  for (const group of ['apps', 'services', 'packages', 'tests', 'extensions/nested']) {
    put(`${group}/member/package.json`, { name: group, scripts: { 'test:integration': 'jest' } });
  }
  put('extensions/nested/excluded/package.json', {
    name: 'excluded',
    scripts: { 'test:integration': 'jest' },
  });
  put('extensions/node_modules/dependency/package.json', {
    name: 'dependency',
    scripts: { 'test:integration': 'jest' },
  });
  put('apps/no-integration/package.json', { name: 'no-integration', scripts: { test: 'jest' } });
  return { root, put };
};

test('discovery follows configured roots, exclusions and new manifests independently', (t) => {
  const { root, put } = workspaceFixture(t);
  const packages = ['apps', 'services', 'packages', 'tests', 'extensions/nested'].sort();
  assert.deepEqual(discoverIntegrationPackages(root), packages);
  assert.deepEqual(integrationPartitionProblems({ suites: packages }, root), []);
  put('extensions/nested/added/package.json', {
    name: 'new-workspace',
    scripts: { 'test:integration': 'jest' },
  });
  assert.match(
    integrationPartitionProblems({ suites: packages }, root).join('\n'),
    /new-workspace:.*found 0/,
  );
});

test('unreadable/malformed discovery inputs and duplicate package names fail closed', (t) => {
  const { root, put } = workspaceFixture(t);
  put('apps/duplicate/package.json', { name: 'apps', scripts: { 'test:integration': 'jest' } });
  assert.match(integrationPartitionProblems({}, root).join('\n'), /discovery failed: duplicate/);
  put('apps/duplicate/package.json', { name: 'unique', scripts: { 'test:integration': '' } });
  assert.match(
    integrationPartitionProblems({}, root).join('\n'),
    /discovery failed:.*nonempty script/,
  );
  writeFileSync(resolve(root, 'apps/duplicate/package.json'), '{');
  assert.match(integrationPartitionProblems({}, root).join('\n'), /discovery failed/);
  for (const patterns of [null, [], ['../outside/*'], ['/tmp/*'], [null]]) {
    put('pnpm-workspace.yaml', { packages: patterns });
    assert.match(integrationPartitionProblems({}, root).join('\n'), /discovery failed/);
  }
  rmSync(resolve(root, 'pnpm-workspace.yaml'));
  assert.match(integrationPartitionProblems({}, root).join('\n'), /discovery failed/);
});

// The shared reader (scripts/workspace-roots-lib.mjs) every workspace-visiting guard
// uses; it has no test file of its own so that it cannot fall out of the CI chain.
test('workspace reader: live membership equals the manifests under the declared roots', () => {
  const declared = parseYaml(readFileSync(resolve(ROOT, 'pnpm-workspace.yaml'), 'utf8')).packages;
  const onDisk = declared.flatMap((pattern) => {
    const group = pattern.replace(/\/\*$/, '');
    return readdirSync(resolve(ROOT, group), { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() && existsSync(resolve(ROOT, group, entry.name, 'package.json')),
      )
      .map((entry) => `${group}/${entry.name}`);
  });
  assert.deepEqual(workspaceDirectories(ROOT), onDisk.sort());
  assert.ok(workspaceDirectories(ROOT).length >= 20);
  assert.ok(workspaceManifestFiles(ROOT).every((file) => file.endsWith('/package.json')));
});

test('workspace reader fails closed on a missing, malformed or empty workspace file', (t) => {
  const { root } = workspaceFixture(t);
  assert.deepEqual(workspaceDirectories(root), [
    'apps/member',
    'apps/no-integration',
    'extensions/nested/member',
    'packages/member',
    'services/member',
    'tests/member',
  ]);
  for (const text of [
    '',
    '- a\n',
    'packages: x\n',
    'packages: []\n',
    'packages: [\n',
    'other: 1\n',
  ]) {
    writeFileSync(resolve(root, 'pnpm-workspace.yaml'), text);
    assert.throws(() => workspaceDirectories(root), undefined, JSON.stringify(text));
  }
  for (const patterns of [
    ['../outside/*'],
    ['/tmp/*'],
    [null],
    [''],
    ['!'],
    ['a\\b/*'],
    ['nothing/*'],
  ]) {
    writeFileSync(resolve(root, 'pnpm-workspace.yaml'), JSON.stringify({ packages: patterns }));
    assert.throws(() => workspaceDirectories(root), undefined, JSON.stringify(patterns));
  }
  rmSync(resolve(root, 'pnpm-workspace.yaml'));
  assert.throws(() => workspaceDirectories(root));
});

/** pnpm's own answer: the members it would run `-r` over, relative to `root` (root excluded). */
const pnpmMembers = (root) => {
  const run = spawnSync('pnpm', ['ls', '-r', '--depth=-1', '--json'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 60_000,
  });
  assert.equal(run.status, 0, `pnpm ls failed: ${run.stderr}`);
  return JSON.parse(run.stdout)
    .map((project) => relative(root, project.path).split('\\').join('/'))
    .filter((directory) => directory !== '')
    .sort();
};

const declare = (root, patterns) =>
  writeFileSync(resolve(root, 'pnpm-workspace.yaml'), JSON.stringify({ packages: patterns }));

const manifest = (root, directory, file = 'package.json', text) => {
  mkdirSync(resolve(root, directory), { recursive: true });
  writeFileSync(resolve(root, directory, file), text ?? JSON.stringify({ name: directory }));
};

test('workspace reader equals the locally installed pnpm on the real repository', () => {
  assert.deepEqual(workspaceDirectories(ROOT), pnpmMembers(ROOT));
});

test('workspace reader equals pnpm on every supported form (names, *, !exclusions, dot, node_modules)', (t) => {
  const { root } = workspaceFixture(t);
  manifest(root, 'apps/.hidden');
  manifest(root, 'apps/node_modules/dependency');
  mkdirSync(resolve(root, 'apps/no-manifest'));
  manifest(root, 'literal/one/deep');
  declare(root, [
    'apps/*',
    'literal/one/deep',
    'extensions/*/*',
    '!extensions/nested/excluded',
    '!apps/no-integration',
  ]);
  assert.deepEqual(workspaceDirectories(root), pnpmMembers(root));
  assert.ok(workspaceDirectories(root).includes('literal/one/deep'));
  assert.ok(!workspaceDirectories(root).includes('apps/no-integration'));
  declare(root, ['apps/*', 'services/*', 'packages/*', 'tests/*', 'extensions/*/*']);
  assert.deepEqual(workspaceDirectories(root), pnpmMembers(root));
});

// FU-076: pnpm drops any path with a node_modules/bower_components SEGMENT
// (workspace/find-packages ignore list), whichever form reached it and wherever it sits.
test('workspace reader drops pnpm-ignored segments at the start, middle and end of every form', (t) => {
  const { root } = workspaceFixture(t);
  const ignoredDirectories = [];
  for (const ignored of ['node_modules', 'bower_components']) {
    for (const directory of [
      `${ignored}/member`, // start
      `apps/${ignored}/inner`, // middle
      `apps/${ignored}`, // end
    ]) {
      manifest(root, directory);
      ignoredDirectories.push(directory);
    }
  }
  const forms = {
    literal: ['node_modules/member', 'apps/bower_components/inner', 'apps/node_modules'],
    literalBower: ['bower_components/member', 'apps/node_modules/inner', 'apps/bower_components'],
    star: ['*/member', 'apps/*/inner', 'apps/*'],
  };
  for (const [form, patterns] of Object.entries(forms)) {
    for (const pattern of patterns) {
      declare(root, ['services/*', pattern]);
      const members = workspaceDirectories(root);
      assert.deepEqual(members, pnpmMembers(root), `${form}: ${pattern}`);
      for (const directory of ignoredDirectories) {
        assert.ok(!members.includes(directory), `${form}: ${pattern} selected ${directory}`);
      }
    }
  }
  // Negation of an ignored path excludes nothing extra and is not refused.
  for (const pattern of ['!node_modules/member', '!apps/bower_components/inner', '!apps/*']) {
    declare(root, ['services/*', 'apps/*', pattern]);
    assert.deepEqual(workspaceDirectories(root), pnpmMembers(root), pattern);
  }
  // Literal patterns that pnpm resolves to nothing still leave an empty answer an error.
  declare(root, ['node_modules/member', 'apps/bower_components']);
  assert.deepEqual(pnpmMembers(root), []);
  assert.throws(() => workspaceDirectories(root), /matched no workspace member/);
  // `**` stays unimplemented: refused, ignored segment or not.
  for (const pattern of ['**/node_modules', 'apps/**/bower_components/*', 'node_modules/**']) {
    declare(root, ['services/*', pattern]);
    assert.throws(() => workspaceDirectories(root), /unsupported workspace package pattern/);
  }
});

test('workspace reader refuses every pattern form it does not implement, alone or mixed with supported ones', (t) => {
  const { root } = workspaceFixture(t);
  const unsupported = [
    '!(apps)/*', // leading extglob: a positive pattern in pnpm, not an exclusion
    '!!apps/*',
    '@(apps|tests)/*',
    '+(apps)/*',
    '?(apps)/*',
    '*(apps)/*',
    'apps/**',
    '**',
    '**/member',
    '{apps,tests}/*',
    'apps/{member,other}',
    'apps/[a]*',
    'a?ps/*',
    'ap*/*',
    '*s/*',
    '.',
    './apps/*',
    'apps/.',
    'apps//member',
    'apps/*/',
    'apps/.hidden',
    '!apps/**',
    '!{apps,tests}/*',
  ];
  const supported = ['apps/*', 'services/*', 'packages/*', 'tests/*'];
  for (const pattern of unsupported) {
    for (const list of [[pattern], [...supported, pattern], [pattern, ...supported]]) {
      declare(root, list);
      assert.throws(
        () => workspaceDirectories(root),
        /unsupported workspace package pattern/,
        JSON.stringify(list),
      );
    }
  }
  // The incomplete answer the old reader returned for the first form.
  declare(root, ['apps/*', '!(apps)/*']);
  assert.throws(() => workspaceManifestFiles(root), /unsupported workspace package pattern/);
});

test('workspace reader refuses a symbolic-link candidate pnpm would follow', (t) => {
  const { root } = workspaceFixture(t);
  declare(root, ['apps/*', 'packages/*']);
  manifest(root, 'elsewhere/linked');
  symlinkSync('../elsewhere/linked', resolve(root, 'packages/linked'), 'dir');
  assert.ok(pnpmMembers(root).includes('packages/linked'), 'pnpm follows the link');
  assert.throws(() => workspaceDirectories(root), /packages\/linked is a symbolic link/);
  rmSync(resolve(root, 'packages/linked'));
  // A dangling link, a link to a file, and a link used as a literal path segment.
  symlinkSync('../nowhere', resolve(root, 'packages/dangling'));
  assert.throws(() => workspaceDirectories(root), /packages\/dangling is a symbolic link/);
  rmSync(resolve(root, 'packages/dangling'));
  symlinkSync('../package.json', resolve(root, 'packages/file-link'));
  assert.throws(() => workspaceDirectories(root), /packages\/file-link is a symbolic link/);
  rmSync(resolve(root, 'packages/file-link'));
  symlinkSync('elsewhere', resolve(root, 'group'), 'dir');
  declare(root, ['apps/*', 'group/linked']);
  assert.throws(() => workspaceDirectories(root), /group is a symbolic link/);
  // Exclusions walk the same way.
  declare(root, ['apps/*', '!group/linked']);
  assert.throws(() => workspaceDirectories(root), /group is a symbolic link/);
  rmSync(resolve(root, 'group'));
  declare(root, ['apps/*', 'packages/*']);
  assert.deepEqual(workspaceDirectories(root), pnpmMembers(root));
});

test('workspace reader refuses a candidate whose manifest is not package.json', (t) => {
  const { root } = workspaceFixture(t);
  declare(root, ['apps/*', 'packages/*']);
  manifest(root, 'packages/yaml', 'package.yaml', 'name: yaml\n');
  assert.ok(pnpmMembers(root).includes('packages/yaml'), 'pnpm reads package.yaml');
  assert.throws(() => workspaceDirectories(root), /packages\/yaml has package\.yaml/);
  rmSync(resolve(root, 'packages/yaml'), { recursive: true });
  manifest(root, 'packages/json5', 'package.json5', '{name: "json5"}');
  assert.ok(pnpmMembers(root).includes('packages/json5'), 'pnpm reads package.json5');
  assert.throws(() => workspaceDirectories(root), /packages\/json5 has package\.json5/);
  // Next to a package.json it is still a second, unread manifest.
  manifest(root, 'packages/json5', 'package.json');
  assert.throws(() => workspaceDirectories(root), /packages\/json5 has package\.json5/);
  rmSync(resolve(root, 'packages/json5'), { recursive: true });
  assert.deepEqual(workspaceDirectories(root), pnpmMembers(root));
});

test('the committed workflow passes', () => {
  assert.deepEqual(checkIntegrationSplitText(TEXT), []);
});

test('FU-111: every split job waits for the type check only, not for the whole quality family', () => {
  assert.equal(QUALITY_GATE_JOB, 'quality-types');
  const workflow = real();
  for (const id of splitJobs(workflow)) {
    assert.deepEqual(workflow.jobs[id].needs, QUALITY_GATE_JOB, id);
    const without = real();
    without.jobs[id].needs = 'quality-lint';
    fails(without, new RegExp(`^${id} must need ${QUALITY_GATE_JOB}$`));
  }
  // The aggregate quality check, not these jobs, demands lint, unit tests, guards and build.
  assert.deepEqual([workflow.jobs.quality.needs].flat().sort(), [
    'quality-build',
    'quality-guards',
    'quality-lint',
    'quality-types',
    'quality-unit',
  ]);
});

// FU-111: the required "Lint, types and unit tests" check aggregates the quality-* jobs.
const qualityFails = (workflow, pattern) => {
  const problems = qualitySplitProblems(workflow);
  assert.ok(
    problems.some((problem) => pattern.test(problem)),
    `expected a problem matching ${pattern}, got: ${JSON.stringify(problems)}`,
  );
  // And the whole guard sees it, as CI runs it.
  fails(workflow, pattern);
};

// The status checks main's branch protection requires (read on 2026-11-05 from
// repos/marabi766/RASTA/branches/main/protection/required_status_checks), and the one
// the merge train requires on its pull request. A job rename or split must keep each
// name on exactly one job: a required check nobody reports blocks every merge, and one
// reported by two jobs can be satisfied by the wrong one.
const REQUIRED_CHECK_NAMES = [
  'Lint, types and unit tests',
  'Integration and security tests',
  'End-to-end (economic critical path)',
  'Portal in a browser',
  'Security scans',
  'Images to build and scan',
  'ClamAV image scan and signature freshness',
  'Prometheus config and alert rules',
  'Migration reversibility and database guards',
  'Images built and scanned',
];
// The jobs that wait for the type-check gate, pinned by name: each builds and runs its own
// copy of what it tests and needs nothing of the quality jobs but a tree that type-checks.
test('FU-111: exactly these jobs wait for the type-check gate, and none for another quality job', () => {
  const workflow = real();
  const gated = Object.entries(workflow.jobs)
    .filter(([id, job]) => id !== 'quality' && [job.needs ?? []].flat().includes('quality-types'))
    .map(([id]) => id)
    .sort();
  assert.deepEqual(gated, [
    'broker-authorisation',
    'e2e',
    'integration-backup-drill',
    'integration-construction',
    'integration-contract',
    'integration-coverage',
    'integration-coverage-critical',
    'integration-economic',
    'integration-security',
    'integration-suites',
    'migration-guards',
    'migration-reversibility-chain',
    'web-browser',
  ]);
  // The aggregate is waited for by the images verdict only.
  assert.deepEqual(
    Object.entries(workflow.jobs)
      .filter(([, job]) => [job.needs ?? []].flat().includes('quality'))
      .map(([id]) => id),
    ['images'],
  );
  for (const id of ['e2e', 'web-browser', 'migration-guards', 'broker-authorisation']) {
    const mutant = real();
    mutant.jobs[id].needs = 'quality-lint';
    fails(mutant, new RegExp(`^${id} waits for quality-lint`));
    mutant.jobs[id].needs = 'quality';
    fails(mutant, new RegExp(`^${id} waits for quality;`));
  }
});

test('FU-111: every required check name is still reported by exactly one job', () => {
  const names = Object.values(real().jobs).map((job) => job.name);
  for (const required of REQUIRED_CHECK_NAMES) {
    assert.equal(names.filter((name) => name === required).length, 1, required);
  }
});

test('FU-111: the real quality split passes, with the names it pins', () => {
  const workflow = real();
  assert.deepEqual(qualitySplitProblems(workflow), []);
  assert.equal(workflow.jobs.quality.name, 'Lint, types and unit tests');
  assert.deepEqual(
    Object.keys(workflow.jobs).filter((id) => id.startsWith('quality-')),
    [...QUALITY_JOBS],
  );
  // The job names are the check names: only the aggregate may be called "Lint, types and unit tests".
  assert.deepEqual(
    Object.entries(workflow.jobs)
      .filter(([, job]) => job.name === 'Lint, types and unit tests')
      .map(([id]) => id),
    ['quality'],
  );
});

for (const [what, edit, pattern] of [
  [
    'an aggregate that stops needing one quality job',
    (w) => (w.jobs.quality.needs = w.jobs.quality.needs.filter((id) => id !== 'quality-lint')),
    /"quality" does not need quality-lint/,
  ],
  [
    'an aggregate that needs a job that is no quality job',
    (w) => w.jobs.quality.needs.push('security'),
    /"quality" needs security, not a quality job/,
  ],
  [
    'a quality job nobody needs',
    (w) => (w.jobs['quality-extra'] = { ...structuredClone(w.jobs['quality-lint']) }),
    /the quality jobs are .*quality-extra|does not need quality-extra/,
  ],
  [
    'a quality job removed',
    (w) => {
      delete w.jobs['quality-build'];
    },
    /the quality jobs are/,
  ],
  [
    'a renamed aggregate',
    (w) => (w.jobs.quality.name = 'Quality'),
    /must be named "Lint, types and unit tests"/,
  ],
  ['an aggregate without always()', (w) => delete w.jobs.quality.if, /must run if: always\(\)/],
  [
    'an aggregate with success()',
    (w) => (w.jobs.quality.if = '${{ success() }}'),
    /must run if: always\(\)/,
  ],
  [
    'an aggregate that forgives',
    (w) => (w.jobs.quality['continue-on-error'] = true),
    /sets continue-on-error/,
  ],
  [
    'a verdict that passes on anything',
    (w) => (w.jobs.quality.steps[0].run = 'echo ok'),
    /must fail unless every needed job's result is "success"/,
  ],
  [
    'a verdict that ignores skipped',
    (w) =>
      (w.jobs.quality.steps[0].run = w.jobs.quality.steps[0].run.replace(
        '!== "success"',
        '=== "failure"',
      )),
    /it passes when/,
  ],
  [
    'a job that can be skipped',
    (w) => (w.jobs['quality-unit'].if = "github.event_name == 'push'"),
    /quality-unit has a job-level if/,
  ],
  [
    'a job that is forgiven',
    (w) => (w.jobs['quality-lint']['continue-on-error'] = true),
    /quality-lint sets continue-on-error/,
  ],
  [
    'a step that is skipped',
    (w) => (w.jobs['quality-guards'].steps[8].if = 'false'),
    /quality-guards: .* has if: false/,
  ],
  [
    'a step that is forgiven',
    (w) => (w.jobs['quality-build'].steps.at(-1)['continue-on-error'] = true),
    /quality-build: .* sets continue-on-error/,
  ],
  [
    'a gate that no longer type-checks',
    (w) =>
      (w.jobs['quality-types'].steps = w.jobs['quality-types'].steps.filter(
        (step) => step.run !== 'pnpm run typecheck',
      )),
    /quality-types must run pnpm run typecheck exactly once/,
  ],
]) {
  test(`FU-111: ${what} is refused`, () => {
    const workflow = real();
    edit(workflow);
    qualityFails(workflow, pattern);
  });
}

test('the parser sees the split it is meant to check', () => {
  const workflow = real();
  assert.ok(splitJobs(workflow).length >= 2);
  assert.equal(workflow.jobs[AGGREGATE_JOB].name, 'Integration and security tests');
  for (const name of SPLIT_STEPS) assert.ok(jobRunning(workflow, name), name);
  assert.ok(workflow.jobs.images.needs.includes(AGGREGATE_JOB));
  // Only the connection report may carry a condition, and never a step of the inventory.
  assert.deepEqual(
    ALLOWED_CONDITIONS.map((entry) => [entry.job, entry.step, entry.if]),
    [
      ['integration-suites', 'PostgreSQL connection peak', 'always()'],
      ['integration-security', 'PostgreSQL connection peak', 'always()'],
    ],
  );
  for (const entry of ALLOWED_CONDITIONS) assert.ok(!SPLIT_STEPS.includes(entry.step));
});

test('a split job the aggregate does not need is refused', () => {
  const workflow = real();
  workflow.jobs[AGGREGATE_JOB].needs = workflow.jobs[AGGREGATE_JOB].needs.slice(1);
  fails(workflow, /does not need integration-/);
  const extra = real();
  extra.jobs[AGGREGATE_JOB].needs.push('quality');
  fails(extra, /needs quality, not a split job/);
});

test('an aggregate that runs only on success, or does not check results, is refused', () => {
  const onSuccess = real();
  delete onSuccess.jobs[AGGREGATE_JOB].if;
  fails(onSuccess, /must run if: always\(\)/);
  const notCancelled = real();
  notCancelled.jobs[AGGREGATE_JOB].if = '${{ !cancelled() }}';
  fails(notCancelled, /must run if: always\(\)/);
  const noVerdict = real();
  noVerdict.jobs[AGGREGATE_JOB].steps = [{ name: 'ok', run: 'true' }];
  fails(noVerdict, /must fail unless every needed job's result is "success"/);
  const renamed = real();
  renamed.jobs[AGGREGATE_JOB].name = 'Integration';
  fails(renamed, /must be named "Integration and security tests"/);
});

// The seven in-memory weakenings Codex's review of #274 found accepted.
test('Codex #274: a coverage command replaced by `true` is refused', () => {
  const workflow = real();
  stepNamed(workflow, 'Contract coverage gate').run = 'true';
  fails(workflow, /"Contract coverage gate" must run exactly/);
});

test('Codex #274: a coverage gate skipped by if: is refused', () => {
  const workflow = real();
  stepNamed(workflow, 'Contract coverage gate').if = '${{ false }}';
  fails(workflow, /"Contract coverage gate" has if: \$\{\{ false \}\}, which can skip it/);
});

test('Codex #274: a coverage gate whose failure is ignored is refused', () => {
  const workflow = real();
  stepNamed(workflow, 'Contract coverage gate')['continue-on-error'] = true;
  fails(workflow, /"Contract coverage gate" sets continue-on-error/);
});

test('Codex #274: a skipped verdict is refused', () => {
  const workflow = real();
  verdict(workflow).if = '${{ false }}';
  fails(workflow, /"integration"'s verdict sets if/);
});

test('Codex #274: a verdict whose errors are ignored is refused', () => {
  const workflow = real();
  verdict(workflow)['continue-on-error'] = true;
  fails(workflow, /"integration"'s verdict sets continue-on-error/);
});

test('Codex #274: always() combined with a success requirement is refused', () => {
  const workflow = real();
  workflow.jobs[AGGREGATE_JOB].if =
    "${{ always() && needs.integration-suites.result == 'success' }}";
  fails(workflow, /must run if: always\(\) and nothing else/);
  for (const spelling of ['always()', '${{always()}}', '${{ always() }}']) {
    const same = real();
    same.jobs[AGGREGATE_JOB].if = spelling;
    assert.deepEqual(checkIntegrationSplit(same), [], spelling);
  }
  const wrapped = real();
  wrapped.jobs[AGGREGATE_JOB].if = '${{ always() }} && success()';
  fails(wrapped, /must run if: always\(\) and nothing else/);
});

test('Codex #274: the broker and KAFKA_BROKERS both removed is refused', () => {
  const workflow = real();
  const job = workflow.jobs['integration-coverage-critical'];
  dropStep(job, 'Start the authenticated Kafka broker');
  for (const step of job.steps) if (step.env) delete step.env.KAFKA_BROKERS;
  fails(workflow, /"Contract coverage gate" lost KAFKA_BROKERS from its env/);
});

test('a test command made to pass regardless is refused', () => {
  const variants = [
    (run) => `${run} || true`,
    (run) => run.replace('pnpm run test:integration', 'echo pnpm run test:integration'),
    (run) => run.replace('pnpm run test:integration', 'true # pnpm run test:integration'),
    (run) =>
      run.replace(
        'pnpm run test:integration',
        'pnpm run test:integration -- --passWithNoTests --testPathPattern=none',
      ),
    () => '',
  ];
  for (const variant of variants) {
    const workflow = real();
    const step = stepNamed(workflow, 'Integration tests');
    step.run = variant(step.run);
    fails(workflow, /"Integration tests" must run exactly/);
  }
  const lastLine = real();
  const isolation = stepNamed(lastLine, 'Tenant isolation and financial invariant tests');
  isolation.run = isolation.run.trimEnd().split('\n').slice(0, -1).join('\n');
  fails(lastLine, /"Tenant isolation and financial invariant tests" must run exactly/);
});

test('comments and blank lines in a run are not commands', () => {
  const workflow = real();
  const step = stepNamed(workflow, 'Contract coverage gate');
  step.run = `# the gate\n\n${step.run}\n`;
  assert.deepEqual(checkIntegrationSplit(workflow), []);
});

test('the connection report may be always(); nothing else may carry that condition', () => {
  const workflow = real();
  assert.equal(stepNamed(workflow, 'PostgreSQL connection peak').if, 'always()');
  const other = real();
  stepNamed(other, 'PostgreSQL connection peak').if = 'failure()';
  fails(other, /"PostgreSQL connection peak" has if: failure\(\), which can skip it/);
  const sibling = real();
  stepNamed(sibling, 'Watch PostgreSQL connections').if = 'always()';
  fails(sibling, /"Watch PostgreSQL connections" has if: always\(\), which can skip it/);
});

test('a test step that may skip, be forgiven or run in another shell is refused', () => {
  for (const name of SPLIT_STEPS) {
    const conditional = real();
    stepNamed(conditional, name).if = "github.event_name == 'push'";
    fails(conditional, new RegExp(`"${escape(name)}" has if: .*which can skip it`));
    const forgiven = real();
    stepNamed(forgiven, name)['continue-on-error'] = '${{ true }}';
    fails(forgiven, new RegExp(`"${escape(name)}" sets continue-on-error`));
  }
  for (const key of ['shell', 'working-directory']) {
    const workflow = real();
    stepNamed(workflow, 'Audit coverage gate')[key] = key === 'shell' ? 'bash {0}' : 'apps';
    fails(workflow, new RegExp(`"Audit coverage gate" sets ${key}; a test step has only`));
  }
  const explicitFalse = real();
  stepNamed(explicitFalse, 'Audit coverage gate')['continue-on-error'] = false;
  fails(explicitFalse, /sets continue-on-error; a test step has only/);
});

test('a setup step that may skip or be forgiven is refused', () => {
  const skipped = real();
  skipped.jobs['integration-coverage'].steps.find((step) => step.name === 'Apply migrations').if =
    'false';
  fails(skipped, /integration-coverage: "Apply migrations" has if: false/);
  const forgiven = real();
  forgiven.jobs['integration-suites'].steps.find(
    (step) => step.name === 'Start the authenticated Kafka broker',
  )['continue-on-error'] = true;
  fails(
    forgiven,
    /integration-suites: "Start the authenticated Kafka broker" sets continue-on-error/,
  );
});

test('a split job or the aggregate that may skip, be forgiven or fan out is refused', () => {
  for (const id of ['integration-security', AGGREGATE_JOB]) {
    const forgiven = real();
    forgiven.jobs[id]['continue-on-error'] = true;
    fails(forgiven, new RegExp(`^${id} sets continue-on-error`));
    const matrix = real();
    matrix.jobs[id].strategy = { 'fail-fast': false, matrix: { shard: [1, 2] } };
    fails(matrix, new RegExp(`^${id} sets strategy`));
    const shell = real();
    shell.jobs[id].defaults = { run: { shell: 'bash {0}' } };
    fails(shell, new RegExp(`^${id} sets defaults`));
    const unbounded = real();
    delete unbounded.jobs[id]['timeout-minutes'];
    fails(unbounded, new RegExp(`^${id} has no timeout-minutes`));
  }
  const conditional = real();
  conditional.jobs['integration-coverage'].if = "github.event_name == 'pull_request'";
  fails(conditional, /^integration-coverage sets if:/);
  const workflowShell = real();
  workflowShell.defaults = { run: { shell: 'bash {0}' } };
  fails(workflowShell, /the workflow sets defaults/);
});

test('a test step without its time limit, or above it, is refused', () => {
  for (const name of SPLIT_STEPS) {
    const workflow = real();
    delete stepNamed(workflow, name)['timeout-minutes'];
    fails(workflow, new RegExp(`"${escape(name)}" has no timeout-minutes`));
  }
  const raised = real();
  stepNamed(raised, 'Construction coverage gate')['timeout-minutes'] = 12;
  fails(raised, /"Construction coverage gate" has timeout-minutes 12, above its 11/);
  const raisedOther = real();
  stepNamed(raisedOther, 'Contract coverage gate')['timeout-minutes'] = 9;
  fails(raisedOther, /"Contract coverage gate" has timeout-minutes 9, above its 8/);
  const expression = real();
  stepNamed(expression, 'Construction coverage gate')['timeout-minutes'] = '${{ 600 }}';
  fails(expression, /"Construction coverage gate" has no timeout-minutes/);
  const aboveJob = real();
  aboveJob.jobs['integration-suites']['timeout-minutes'] = 10;
  fails(aboveJob, /"Integration tests" has timeout-minutes 13, above its job's 10/);
  const tightened = real();
  stepNamed(tightened, 'Construction coverage gate')['timeout-minutes'] = 7;
  assert.deepEqual(checkIntegrationSplit(tightened), []);
});

const limitedSteps = (job) => job.steps.filter((step) => 'timeout-minutes' in step);
const stepSum = (job) =>
  limitedSteps(job).reduce((total, step) => total + step['timeout-minutes'], 0);

test('every job holds its steps one after the other: step limits plus setup fit the job limit', () => {
  const jobs = Object.entries(PARSED.jobs).filter(([, job]) => limitedSteps(job).length > 0);
  assert.deepEqual(
    jobs.map(([id]) => id).sort(),
    Object.keys(JOB_SETUP_MINUTES).sort(),
    'a job with step limits has a setup allowance, and an allowance belongs to such a job',
  );
  assert.deepEqual(
    Object.fromEntries(jobs.map(([id, job]) => [id, stepSum(job) + JOB_SETUP_MINUTES[id]])),
    {
      'integration-suites': 75,
      'integration-construction': 25,
      'integration-economic': 24,
      'integration-contract': 23,
      'integration-security': 35,
      'integration-coverage-critical': 35,
      'integration-coverage': 97,
      'integration-backup-drill': 8,
      'migration-reversibility-chain': 17,
      'migration-guards': 18,
      'trivy-db': 33,
      security: 33,
      'quality-unit': 25,
    },
  );
  for (const [id, job] of jobs) {
    assert.ok(stepSum(job) + JOB_SETUP_MINUTES[id] <= job['timeout-minutes'], id);
  }
});

test('a job whose step limits plus setup exceed its own limit is refused', () => {
  for (const [id, job] of Object.entries(PARSED.jobs)) {
    if (limitedSteps(job).length === 0) continue;
    const needed = stepSum(job) + JOB_SETUP_MINUTES[id];
    const message = new RegExp(
      `^${id}: its steps' timeout-minutes sum to ${stepSum(job)} .* ${needed} in all, above the job's timeout-minutes ${needed - 1}$`,
    );
    const short = real();
    short.jobs[id]['timeout-minutes'] = needed - 1;
    fails(short, message);
    const exact = real();
    exact.jobs[id]['timeout-minutes'] = needed;
    assert.deepEqual(checkIntegrationSplit(exact), [], id);
    // One more minute on any step with a limit of its own overruns the job it has.
    if (job['timeout-minutes'] === needed) {
      const over = real();
      limitedSteps(over.jobs[id]).at(-1)['timeout-minutes'] += 1;
      fails(over, new RegExp(`^${id}: its steps' timeout-minutes sum to ${stepSum(job) + 1} `));
    }
  }
  // The steps of a split job that are not in the inventory count as well.
  const peak = real();
  const connections = peak.jobs['integration-suites'].steps.find(
    (step) => step.name === 'PostgreSQL connection ceiling',
  );
  connections['timeout-minutes'] += 1;
  fails(peak, /^integration-suites: its steps' timeout-minutes sum to 68 .* 76 in all/);
});

test('a job outside the split is held to its cumulative budget too', () => {
  const extra = real();
  extra.jobs['some-new-job'] = {
    'runs-on': 'ubuntu-latest',
    'timeout-minutes': 10,
    steps: [{ name: 'slow', run: 'true', 'timeout-minutes': 5 }],
  };
  fails(extra, /^some-new-job has step time limits \(5 minutes in all\) but no setup allowance/);
  const unbounded = real();
  delete unbounded.jobs['prometheus-rules']['timeout-minutes'];
  fails(unbounded, /^prometheus-rules has no timeout-minutes/);
  const unknown = real();
  const [step] = limitedSteps(unknown.jobs['trivy-db']);
  step['timeout-minutes'] = '${{ vars.MINUTES }}';
  fails(
    unknown,
    /^trivy-db: ".*" has a timeout-minutes that is not a positive whole number of minutes/,
  );
  const gone = real();
  delete gone.jobs['migration-guards'];
  fails(gone, /^migration-guards has a declared time budget but is not a job/);
});

// Every name Object.prototype gives a plain object: a lookup by job id into the
// budget tables must not find any of them (N1 of the review of #499).
const INHERITED_KEYS = Object.getOwnPropertyNames(Object.prototype);

const jobWithId = (workflow, id, job) => {
  // `workflow.jobs[id] = ...` would set the prototype for `__proto__`.
  Object.defineProperty(workflow.jobs, id, {
    value: job,
    enumerable: true,
    writable: true,
    configurable: true,
  });
};

test('a job named like an inherited property has no setup allowance and is refused', () => {
  assert.equal(INHERITED_KEYS.length, 12, INHERITED_KEYS.join(', '));
  for (const id of INHERITED_KEYS) {
    const workflow = real();
    jobWithId(workflow, id, {
      'runs-on': 'ubuntu-latest',
      'timeout-minutes': 1,
      steps: [{ name: 'Slow', run: 'true', 'timeout-minutes': 2 }],
    });
    fails(
      workflow,
      new RegExp(`^${escape(id)} has step time limits \\(2 minutes in all\\) but no setup`),
    );
  }
});

test('a job named like an inherited property is not given a floor either', () => {
  for (const id of INHERITED_KEYS) {
    const workflow = real();
    jobWithId(workflow, id, { 'runs-on': 'ubuntu-latest', 'timeout-minutes': 1, steps: [] });
    const problems = checkIntegrationSplit(workflow);
    assert.ok(
      !problems.some((problem) => /floor|below its/.test(problem)),
      `${id}: ${JSON.stringify(problems)}`,
    );
  }
});

test('a budget entry that is not a whole number of minutes is a problem, not a pass', () => {
  const jobs = {
    slow: { 'timeout-minutes': 5, steps: [{ name: 'a', run: 'true', 'timeout-minutes': 4 }] },
  };
  // `undefined` is an own entry that is declared and wrong, not an absent one (N2 of the #509 r1 review).
  for (const bad of [() => 'x', 'x', null, undefined, NaN, Infinity, 0, -1, 0.5, 1.5, {}]) {
    const setup = jobBudgetProblems(jobs, [], { slow: bad }, {});
    assert.ok(
      setup.some((problem) =>
        /^slow has a setup allowance .* not a positive whole number of minutes/.test(problem),
      ),
      String(bad),
    );
    const floor = jobBudgetProblems(jobs, [], { slow: 1 }, { slow: bad });
    assert.ok(
      floor.some((problem) =>
        /^slow has a floor .* not a positive whole number of minutes/.test(problem),
      ),
      String(bad),
    );
  }
  assert.deepEqual(jobBudgetProblems(jobs, [], { slow: 1 }, { slow: 5 }), []);
  // The tables are checked whether or not a job uses the entry: a job without step limits has
  // no use for a setup allowance, and a floor does not need the allowance.
  const bare = { slow: { 'timeout-minutes': 5, steps: [] } };
  assert.deepEqual(jobBudgetProblems(bare, [], { slow: undefined }, {}), [
    'slow has a setup allowance in JOB_SETUP_MINUTES that is not a positive whole number of minutes',
  ]);
  // Declared and wrong is one problem, not also "no allowance".
  assert.deepEqual(jobBudgetProblems(jobs, [], { slow: undefined }, {}), [
    'slow has a setup allowance in JOB_SETUP_MINUTES that is not a positive whole number of minutes',
  ]);
  assert.deepEqual(jobBudgetProblems(jobs, [], { slow: 1 }, { slow: undefined }), [
    'slow has a floor in JOB_FLOOR_MINUTES that is not a positive whole number of minutes',
  ]);
});

test('minutes are positive whole numbers everywhere: a fraction is refused, not accepted', () => {
  const mutations = {
    'the aggregate timeout': (w) => (w.jobs[AGGREGATE_JOB]['timeout-minutes'] = 0.5),
    'a split job timeout': (w) => (w.jobs['integration-suites']['timeout-minutes'] = 70.5),
    'another job timeout': (w) => (w.jobs['prometheus-rules']['timeout-minutes'] = 0.5),
    'an inventoried step timeout': (w) =>
      (stepNamed(w, 'Integration tests')['timeout-minutes'] = 0.5),
    'a non-inventoried step timeout': (w) =>
      (w.jobs['integration-suites'].steps.find(
        (step) => step.name === 'PostgreSQL connection ceiling',
      )['timeout-minutes'] = 0.5),
    'a step timeout past its job limit': (w) =>
      (stepNamed(w, 'Integration tests')['timeout-minutes'] = 20.5),
    'a job timeout above an integer floor': (w) => (w.jobs.quality['timeout-minutes'] = 56.5),
  };
  for (const [what, mutate] of Object.entries(mutations)) {
    const workflow = real();
    mutate(workflow);
    assert.notDeepEqual(checkIntegrationSplit(workflow), [], what);
  }
  const jobs = {
    slow: { 'timeout-minutes': 5.5, steps: [{ name: 'a', run: 'true', 'timeout-minutes': 4 }] },
  };
  assert.ok(jobBudgetProblems(jobs, [], { slow: 1 }, {}).length > 0);
  assert.ok(jobBudgetProblems(jobs, [], { slow: 1.5 }, {}).length > 0);
  assert.ok(jobBudgetProblems(jobs, [], { slow: 1 }, { slow: 1.5 }).length > 0);
});

test('a step named like an inherited property is an ordinary step, not a crash', () => {
  assert.equal(INHERITED_KEYS.length, 12, INHERITED_KEYS.join(', '));
  for (const name of INHERITED_KEYS) {
    const workflow = real();
    workflow.jobs['integration-suites'].steps.push({ name, run: 'true' });
    assert.deepEqual(checkIntegrationSplit(workflow), [], name);
    // And it is not mistaken for an inventory entry: dropping a real one is still reported.
    dropStep(workflow.jobs[jobRunning(workflow, 'Audit coverage gate')], 'Audit coverage gate');
    fails(workflow, /no integration-\* job runs "Audit coverage gate"/);
  }
  // A name that is not a string never matches the inventory either (an array
  // of one name used to coerce to it and then miss the table that counts it).
  for (const name of [['Audit coverage gate'], { toString: 'x' }, 7, null, true]) {
    const workflow = real();
    workflow.jobs['integration-suites'].steps.push({ name, run: 'true' });
    assert.deepEqual(checkIntegrationSplit(workflow), [], JSON.stringify(name));
  }
});

test('a job whose measured runtime needed its limit may not go back below it', () => {
  assert.deepEqual(JOB_FLOOR_MINUTES, { 'web-browser': 37 });
  for (const [id, floor] of Object.entries(JOB_FLOOR_MINUTES)) {
    const back = real();
    back.jobs[id]['timeout-minutes'] = floor - 1;
    fails(back, new RegExp(`^${id} has timeout-minutes ${floor - 1}, below its ${floor}`));
    const missing = real();
    delete missing.jobs[id]['timeout-minutes'];
    fails(missing, new RegExp(`^${id} has no timeout-minutes`));
    const raised = real();
    // A raised limit must still hold the job's step limits plus its setup (quality-unit: 10 + 15).
    const budget = limitedSteps(raised.jobs[id]).length
      ? stepSum(raised.jobs[id]) + JOB_SETUP_MINUTES[id]
      : 0;
    raised.jobs[id]['timeout-minutes'] = Math.max(floor + 1, budget);
    assert.deepEqual(checkIntegrationSplit(raised), [], id);
  }
});

test('a test step that loses a declared variable, or changes a pinned one, is refused', () => {
  for (const [name, { env }] of Object.entries(STEP_INVENTORY)) {
    for (const key of Object.keys(env)) {
      const workflow = real();
      delete stepNamed(workflow, name).env[key];
      fails(workflow, new RegExp(`"${escape(name)}" lost ${key} from its env`));
    }
  }
  const optional = real();
  stepNamed(optional, 'Retry replay, published as ops-replay').env.RETRY_REPLAY_REQUIRED = 'false';
  fails(optional, /must set RETRY_REPLAY_REQUIRED: true, not false/);
  const production = real();
  stepNamed(production, 'Economic coverage gate').env.NODE_ENV = 'production';
  fails(production, /"Economic coverage gate" must set NODE_ENV: test/);
});

test('a declared variable set empty, or from an expression that may resolve to empty, is refused', () => {
  const REPLAY = 'Retry replay, published as ops-replay';
  // The review's trigger, in the text: every broker suite would skip.
  const at = TEXT.indexOf(`- name: ${REPLAY}`);
  const brokers = TEXT.indexOf('KAFKA_BROKERS: localhost:9092', at);
  assert.ok(at > 0 && brokers > at);
  const emptied = `${TEXT.slice(0, brokers)}KAFKA_BROKERS: ''${TEXT.slice(brokers + 29)}`;
  assert.deepEqual(checkIntegrationSplitText(emptied), [
    `${jobRunning(PARSED, REPLAY)}: "${REPLAY}" sets KAFKA_BROKERS empty`,
  ]);

  for (const [name, { env }] of Object.entries(STEP_INVENTORY)) {
    for (const key of Object.keys(env)) {
      const workflow = real();
      stepNamed(workflow, name).env[key] = '';
      fails(workflow, new RegExp(`"${escape(name)}" sets ${key} empty`));
    }
  }
  const values = [
    [' ', /sets KAFKA_BROKERS empty/],
    [null, /sets KAFKA_BROKERS to no value/],
    [['localhost:9092'], /sets KAFKA_BROKERS to no value/],
    [
      '${{ secrets.KAFKA_BROKERS }}',
      /sets KAFKA_BROKERS from \$\{\{ secrets\.KAFKA_BROKERS \}\}, which may resolve to empty/,
    ],
    ['${{ vars.KAFKA_BROKERS }}', /from \$\{\{ vars\.KAFKA_BROKERS \}\}, which may resolve/],
    ['localhost:${{env.KAFKA_PORT}}', /from \$\{\{ env\.KAFKA_PORT \}\}, which may resolve/],
    ['localhost:9092${{', /sets KAFKA_BROKERS to an unclosed expression/],
  ];
  for (const [value, pattern] of values) {
    const workflow = real();
    stepNamed(workflow, REPLAY).env.KAFKA_BROKERS = value;
    fails(workflow, pattern);
  }
  const pinned = real();
  stepNamed(pinned, REPLAY).env.RETRY_REPLAY_REQUIRED = '${{ vars.RETRY_REPLAY_REQUIRED }}';
  fails(pinned, /sets RETRY_REPLAY_REQUIRED from \$\{\{ vars\.RETRY_REPLAY_REQUIRED \}\}/);
  const workspace = real();
  stepNamed(workspace, REPLAY).env.KAFKA_SECRETS_DIR = '${{ github.workspace }}/secrets';
  fails(workspace, /sets KAFKA_SECRETS_DIR from \$\{\{ github\.workspace \}\}/);

  // runner.temp is set on every runner; a value built on it is resolved.
  const temp = real();
  stepNamed(temp, REPLAY).env.KAFKA_SECRETS_DIR = '${{runner.temp}}/elsewhere';
  assert.deepEqual(checkIntegrationSplit(temp), []);
});

test('the verdict is run, and one that passes a failed, cancelled or skipped job is refused', () => {
  const rewrite = (from, to) => {
    const workflow = real();
    const step = verdict(workflow);
    assert.ok(step.run.includes(from), from);
    step.run = step.run.replace(from, to);
    return workflow;
  };
  fails(
    rewrite('needs[name].result !== "success"', 'needs[name].result === "failure"'),
    /it passes when integration-suites cancelled/,
  );
  fails(
    rewrite(
      'needs[name].result !== "success"',
      '!["success", "skipped"].includes(needs[name].result)',
    ),
    /it passes when integration-coverage skipped/,
  );
  fails(
    rewrite('const names = Object.keys(needs);', 'const names = Object.keys(needs).slice(0, 1);'),
    /it passes when integration-security failure/,
  );
  fails(
    rewrite('process.exit(1);', 'process.exitCode = 0;'),
    /it passes when every needed job skipped/,
  );
  fails(
    rewrite("node -e '", "node -e 'process.exit(1);"),
    /it fails when every needed job succeeded/,
  );
  const echoed = real();
  verdict(echoed).run = 'echo "$NEEDS"';
  fails(echoed, /it passes when integration-suites failure/);
});

test('a verdict that cannot see the needs context, or is not alone, is refused', () => {
  const partial = real();
  verdict(partial).env.NEEDS = '${{ toJSON(needs.integration-suites) }}';
  fails(partial, /must read the needs context from one env: \$\{\{ toJSON\(needs\) \}\}/);
  const inline = real();
  verdict(inline).run = verdict(inline).run.replace('process.env.NEEDS', "'${{ toJSON(needs) }}'");
  fails(inline, /verdict run has an expression/);
  const second = real();
  second.jobs[AGGREGATE_JOB].steps.push({ name: 'after', run: 'true' });
  fails(second, /must have exactly one step, its verdict/);
  const directory = real();
  verdict(directory)['working-directory'] = 'apps';
  fails(directory, /"integration"'s verdict sets working-directory/);
});

test('the verdict runs here under the shell it names; a pipe that hides its failure is refused', () => {
  const piped = (shell) => {
    const workflow = real();
    const step = verdict(workflow);
    step.run = `${step.run.trimEnd()} | cat\n`;
    if (shell === undefined) delete step.shell;
    else step.shell = shell;
    return workflow;
  };
  // The runner's default options: `| cat` exits 0 with a dependency failed.
  fails(piped('bash -e {0}'), /it passes when integration-suites failure/);
  fails(piped('bash {0}'), /it passes when every needed job skipped/);
  fails(piped(undefined), /verdict must set shell: bash; without it the runner uses bash -e/);
  // With pipefail, as `shell: bash` runs, node's exit status survives the pipe.
  assert.deepEqual(checkIntegrationSplit(piped('bash')), []);
  assert.deepEqual(checkIntegrationSplit(piped('bash --noprofile --norc -eo pipefail {0}')), []);
  // The committed script is one command, right under any of them.
  const plain = real();
  verdict(plain).shell = 'bash -e {0}';
  assert.deepEqual(checkIntegrationSplit(plain), []);
});

test('a verdict whose shell is unset, or not one it can be run under here, is refused', () => {
  const unset = real();
  delete verdict(unset).shell;
  fails(unset, /"integration"'s verdict must set shell: bash; without it/);
  for (const shell of [
    'sh',
    'pwsh',
    'python',
    'node {0}',
    'bash -e',
    'bash -c "exit 0" {0}',
    'bash $X {0}',
    ['bash'],
  ]) {
    const workflow = real();
    verdict(workflow).shell = shell;
    fails(workflow, /"integration"'s verdict must set shell: bash, or "bash <options> \{0\}", not/);
  }
});

test('a step dropped from every job, or run twice, is refused', () => {
  for (const name of ['Contract coverage gate', 'Retry replay, published as ops-replay']) {
    const workflow = real();
    dropStep(workflow.jobs[jobRunning(workflow, name)], name);
    fails(workflow, new RegExp(`runs "${escape(name)}"`));
  }
  const twice = real();
  twice.jobs['integration-suites'].steps.push(
    structuredClone(stepNamed(twice, 'Audit coverage gate')),
  );
  fails(twice, /"Audit coverage gate" runs in more than one job/);
});

test('a step without its infrastructure is refused', () => {
  const documentJob = (workflow) => workflow.jobs[jobRunning(workflow, 'Document coverage gate')];
  const noScanner = real();
  dropStep(documentJob(noScanner), 'Start ClamAV on a Unix socket');
  fails(noScanner, /"Document coverage gate" runs without "Start ClamAV on a Unix socket"/);
  const noBucket = real();
  dropStep(documentJob(noBucket), 'Start MinIO and create the document bucket');
  fails(noBucket, /"Document coverage gate" runs without "Start MinIO/);
  const noBroker = real();
  dropStep(documentJob(noBroker), 'Start the authenticated Kafka broker');
  fails(noBroker, /runs without "Start the authenticated Kafka broker"/);
  const noMigrations = real();
  dropStep(documentJob(noMigrations), 'Apply migrations');
  fails(noMigrations, /runs without "Apply migrations"/);
  const noRedis = real();
  delete noRedis.jobs[jobRunning(noRedis, 'Integration tests')].services.redis;
  fails(noRedis, /"Integration tests" runs without a redis service container/);
  const noBuild = real();
  dropStep(documentJob(noBuild), 'Build the shared packages');
  fails(noBuild, /needs the packages built before it/);
});

test('infrastructure no step of the job reads is refused', () => {
  const workflow = real();
  const id = jobRunning(workflow, 'Construction coverage gate');
  workflow.jobs[id].services.redis = { image: 'redis' };
  fails(workflow, new RegExp(`${id} starts Redis, which no step of it reads`));
});

test('the notification SMTP suites cannot skip: Mailpit is provisioned and required', () => {
  for (const name of ['Integration tests', 'Notification coverage gate']) {
    const noMailpit = real();
    delete noMailpit.jobs[jobRunning(noMailpit, name)].services.mailpit;
    fails(noMailpit, new RegExp(`"${name}" runs without a mailpit service container`));

    const notRequired = real();
    delete stepNamed(notRequired, name).env.REQUIRE_MAILPIT;
    fails(notRequired, new RegExp(`"${name}" lost REQUIRE_MAILPIT from its env`));

    const optional = real();
    stepNamed(optional, name).env.REQUIRE_MAILPIT = '0';
    fails(optional, new RegExp(`"${name}" must set REQUIRE_MAILPIT: 1, not 0`));
  }
  const unread = real();
  const id = jobRunning(unread, 'Construction coverage gate');
  unread.jobs[id].services.mailpit = { image: 'axllent/mailpit' };
  fails(unread, new RegExp(`${id} starts Mailpit, which no step of it reads`));
});

test('invalid YAML is a problem, not a pass', () => {
  assert.equal(checkIntegrationSplitText('jobs: [unclosed').length, 1);
});

test('backup drill is required and its self-migration exemption cannot spread', () => {
  const missing = real();
  missing.jobs.integration.needs = missing.jobs.integration.needs.filter(
    (id) => id !== 'integration-backup-drill',
  );
  fails(missing, /does not need integration-backup-drill/);
  const renamed = real();
  renamed.jobs['integration-pretend-drill'] = renamed.jobs['integration-backup-drill'];
  delete renamed.jobs['integration-backup-drill'];
  renamed.jobs.integration.needs = renamed.jobs.integration.needs.map((id) =>
    id === 'integration-backup-drill' ? 'integration-pretend-drill' : id,
  );
  fails(renamed, /integration-pretend-drill: .*runs without "Apply migrations"/);
});

test('aggregate rejects backup drill failure, skip and cancellation independently', () => {
  for (const result of ['failure', 'skipped', 'cancelled']) {
    const workflow = real();
    // This weakening accepts only this result for this job; the executable validator must catch it.
    verdict(workflow).run = verdict(workflow).run.replace(
      'needs[name].result !== "success"',
      `needs[name].result !== "success" && !(name === "integration-backup-drill" && needs[name].result === "${result}")`,
    );
    fails(workflow, /must fail unless every needed job's result is "success"/);
  }
});

test('every suite shard refuses no-op commands, changed filters, missing aggregate dependencies and infrastructure', () => {
  for (const name of Object.keys(INTEGRATION_PARTITIONS)) {
    for (const change of [
      () => 'true',
      (run) => `echo ${run}`,
      (run) => `${run} || true`,
      (run) => run.replace(/--shard=\w+/, '--shard=unknown'),
    ]) {
      const workflow = real();
      const step = stepNamed(workflow, name);
      step.run = change(step.run);
      fails(workflow, /must run exactly/);
    }
    const workflow = real();
    const id = jobRunning(workflow, name);
    workflow.jobs.integration.needs = workflow.jobs.integration.needs.filter((need) => need !== id);
    fails(workflow, /does not need/);
    for (const required of [
      'Start the authenticated Kafka broker',
      'Start MinIO and create the document bucket',
      'Start ClamAV on a Unix socket',
      'Apply migrations',
      'Provision databases, roles and extensions',
    ]) {
      const missing = real();
      dropStep(missing.jobs[id], required);
      fails(missing, /runs without/);
    }
    for (const service of ['redis', 'mailpit', 'postgres']) {
      const missing = real();
      delete missing.jobs[id].services[service];
      fails(missing, /runs without/);
    }
    const extra = real();
    stepNamed(extra, name).env.UNDECLARED_OPTION = '1';
    fails(extra, /undeclared env/);
    for (const [key, value] of Object.entries(STEP_INVENTORY[name].env)) {
      if (value.includes('${{')) continue;
      const changed = real();
      stepNamed(changed, name).env[key] = 'different';
      fails(changed, /must set/);
    }
  }
});

test('FU-185: every workspace unit selection survives removal of the filtered rerun', () => {
  assert.deepEqual(unitCoverageProblems(), []);
  withLiveWorkspaceCopy((root) => {
    const file = resolve(root, 'services/identity-service/package.json');
    const original = JSON.parse(readFileSync(file, 'utf8'));
    for (const command of [
      undefined,
      'jest --selectProjects integration',
      'jest --selectProjects unit --testNamePattern=tenant',
      'true',
    ]) {
      const manifest = structuredClone(original);
      manifest.scripts['test:unit'] = command;
      writeFileSync(file, JSON.stringify(manifest));
      assert.match(unitCoverageProblems(root).join('\n'), /identity-service.*unit coverage/);
    }
  });
  for (const change of [
    (w) => dropStep(w.jobs['quality-unit'], 'Unit tests'),
    (w) => {
      w.jobs['quality-unit'].steps.find((s) => s.name === 'Unit tests').run +=
        ' -- --testNamePattern=tenant';
    },
  ]) {
    const workflow = real();
    change(workflow);
    assert.match(qualitySplitProblems(workflow).join('\n'), /unfiltered Unit tests/);
  }
});

test('FU-185 F1a: deleting test cannot hide a narrowed or missing unit selection', () => {
  withLiveWorkspaceCopy((root) => {
    const file = resolve(root, 'services/identity-service/package.json');
    const manifest = JSON.parse(readFileSync(file, 'utf8'));
    delete manifest.scripts.test;
    for (const command of ['jest --selectProjects unit --testNamePattern=x', undefined]) {
      manifest.scripts['test:unit'] = command;
      writeFileSync(file, JSON.stringify(manifest));
      assert.match(unitCoverageProblems(root).join('\n'), /identity-service.*unit coverage/);
    }
  });
});

test('FU-185 F1a: the Node unit workspace refuses a no-op or missing test:unit', () => {
  withLiveWorkspaceCopy((root) => {
    const file = resolve(root, 'tests/e2e/package.json');
    const manifest = JSON.parse(readFileSync(file, 'utf8'));
    for (const command of ['true', undefined]) {
      manifest.scripts['test:unit'] = command;
      writeFileSync(file, JSON.stringify(manifest));
      assert.match(unitCoverageProblems(root).join('\n'), /tests\/e2e.*unit coverage/);
    }
  });
});

test('FU-185 F1b: every Jest unit entry refuses passWithNoTests even when test has it', () => {
  for (const file of workspaceManifestFiles(ROOT)) {
    const original = JSON.parse(readFileSync(resolve(ROOT, file), 'utf8'));
    if (!original.scripts?.['test:unit']?.startsWith('jest')) continue;
    withLiveWorkspaceCopy((root) => {
      for (const hasTest of [true, false]) {
        const manifest = structuredClone(original);
        manifest.scripts['test:unit'] =
          manifest.scripts['test:unit'].replace(' --passWithNoTests', '') + ' --passWithNoTests';
        if (hasTest) manifest.scripts.test = manifest.scripts['test:unit'];
        else delete manifest.scripts.test;
        writeFileSync(resolve(root, file), JSON.stringify(manifest));
        const problems = unitCoverageProblems(root);
        assert.ok(
          problems.some((p) => p.startsWith(`${file}: unit coverage`)),
          `${file}: ${problems}`,
        );
      }
    });
  }
});

test('FU-185 F1b: asset unit command fails when its Jest config matches zero spec files', () => {
  withLiveWorkspaceCopy((root) => {
    const config = resolve(root, 'services/asset-service/jest.config.cjs');
    const asset = resolve(ROOT, 'services/asset-service');
    writeFileSync(
      config,
      `
      const config = require(${JSON.stringify(resolve(asset, 'jest.config.js'))});
      for (const project of config.projects) {
        project.rootDir = require('node:path').resolve(${JSON.stringify(asset)}, project.rootDir);
        if (project.displayName === 'unit') project.testRegex = 'FU185_NEVER_MATCHES_A_SPEC$';
      }
      module.exports = config;
    `,
    );
    const manifest = JSON.parse(
      readFileSync(resolve(root, 'services/asset-service/package.json'), 'utf8'),
    );
    const result = spawnSync(
      process.execPath,
      [
        resolve(asset, 'node_modules/jest/bin/jest.js'),
        ...manifest.scripts['test:unit'].split(' ').slice(1),
        '--config',
        config,
        '--runInBand',
      ],
      { cwd: asset, encoding: 'utf8', timeout: 30000 },
    );
    assert.equal(result.error, undefined);
    assert.match(result.stdout + result.stderr, /No tests found/);
    assert.equal(result.status, 1, result.stdout + result.stderr);
  });
});
