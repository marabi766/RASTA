/**
 * Static no-retry / manual-rerun contract for the ADR-055 campaign workflow
 * draft.
 *
 * Every mutation starts from the committed draft and changes one thing, so a
 * rejection is attributable to that change and the committed draft itself is
 * proven to pass. Nothing here needs Docker, PostgreSQL, GitHub or the network;
 * nothing is installed under `.github/workflows/`; files live only in temporary
 * directories that are removed afterwards.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CAMPAIGN_SLOT_COUNT,
  MAX_REPORTED_PROBLEMS,
  formatWorkflowCheck,
  parseWorkflowDraft,
  validateWorkflowDraft,
} from './aggregation-campaign-workflow-lib.mjs';
import { runWorkflowCheckCli } from './aggregation-campaign-workflow.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const DRAFT_RELATIVE =
  'docs/evidence/adr-055/fresh-run-campaign-workflow-draft-2026-09-16.yaml.txt';
const DRAFT_PATH = join(repoRoot, DRAFT_RELATIVE);
const DRAFT = readFileSync(DRAFT_PATH, 'utf8');
const CLI = join(here, 'aggregation-campaign-workflow.mjs');

const temporaryDirs = [];
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'aggregation-campaign-workflow-test-'));
  temporaryDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of temporaryDirs) rmSync(dir, { recursive: true, force: true });
});

const CHECKOUT_SHA = '11d5960a326750d5838078e36cf38b85af677262';
const UPLOAD_SHA = 'ea165f8d65b6e75b540449e92b4886f43607fa02';
const SLOT_LIST = Array.from({ length: CAMPAIGN_SLOT_COUNT }, (_, i) => i + 1).join(', ');
const SLOT_LINE = `        slot: [${SLOT_LIST}]`;
const INVOCATION =
  'pnpm run calibrate:aggregation-stress -- --pairs 1 --slot "${{ matrix.slot }}" "$RUNNER_TEMP/adr-055-fresh-run-slot-${{ matrix.slot }}.txt"';
const GUARD_BLOCK = `      - name: Refuse any attempt other than the first
        # Effective shell logic, not a step condition: a skipped guard would be
        # a silent pass. Runs before checkout and before any measurement.
        run: |
          if [ "\${{ github.run_attempt }}" != "1" ]; then
            echo 'github.run_attempt is not 1; a second attempt of a campaign slot is not evidence' >&2
            exit 1
          fi

`;
const CHECKOUT_LINE = `      - uses: actions/checkout@${CHECKOUT_SHA} # v4\n`;

/** Replaces exactly one occurrence, so a mutation cannot silently miss. */
function mutate(from, to, text = DRAFT) {
  const first = text.indexOf(from);
  assert.ok(first >= 0, `mutation anchor not found: ${from.slice(0, 60)}`);
  assert.equal(
    text.indexOf(from, first + 1),
    -1,
    `mutation anchor not unique: ${from.slice(0, 60)}`,
  );
  return text.slice(0, first) + to + text.slice(first + from.length);
}

function assertRejected(text, pattern, label) {
  const result = validateWorkflowDraft(text);
  assert.equal(result.ok, false, `${label}: expected rejection`);
  assert.ok(
    result.problems.some((problem) => pattern.test(problem)),
    `${label}: no problem matched ${pattern}; got ${JSON.stringify(result.problems)}`,
  );
}

// ---------------------------------------------------------------------------
// The committed draft

test('the committed draft is present, non-executable and passes the whole contract', () => {
  assert.ok(DRAFT_RELATIVE.endsWith('.yaml.txt'));
  assert.ok(!DRAFT_RELATIVE.startsWith('.github/'));
  assert.ok(DRAFT.includes(SLOT_LINE), 'literal 1..59 slot line');
  assert.ok(DRAFT.includes(GUARD_BLOCK), 'guard block anchor');
  assert.ok(DRAFT.includes(INVOCATION), 'invocation anchor');
  const result = validateWorkflowDraft(DRAFT);
  assert.deepEqual(result, { ok: true, problems: [] });
});

test('the draft invokes the calibration mode through the existing package script', () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  assert.equal(
    pkg.scripts['calibrate:aggregation-stress'],
    'node scripts/aggregation-evidence.mjs --calibrate',
  );
  assert.equal(
    pkg.scripts['check:aggregation-campaign-workflow'],
    'node scripts/aggregation-campaign-workflow.mjs',
  );
});

test('the validator stays outside pnpm verify, the test scripts and ordinary CI', () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  for (const [name, command] of Object.entries(pkg.scripts)) {
    if (name === 'check:aggregation-campaign-workflow') continue;
    assert.ok(!command.includes('aggregation-campaign-workflow'), `script ${name} must not run it`);
  }
  const ci = readFileSync(join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.ok(!ci.includes('aggregation-campaign-workflow'));
  assert.ok(!ci.includes('fresh-run-campaign-workflow-draft'));
});

// ---------------------------------------------------------------------------
// Parser subset

test('the parser reads the fixed subset and rejects what it does not understand', () => {
  const parsed = parseWorkflowDraft(
    'a: 1 # c\nb:\n  - x: \'y\'\n    z: "w"\n  - plain\nc: |\n  one\n\n  two\nd: >-\n  p\n  q\ne: [1, 2]\n',
  );
  assert.equal(parsed.ok, true);
  const { entries } = parsed.root;
  assert.equal(entries.get('a').value.value, '1');
  assert.equal(entries.get('b').value.items[0].entries.get('x').value.value, 'y');
  assert.equal(entries.get('b').value.items[1].value, 'plain');
  assert.equal(entries.get('c').value.value, 'one\n\ntwo\n');
  assert.equal(entries.get('d').value.value, 'p q');
  assert.deepEqual(
    entries.get('e').value.items.map((item) => item.value),
    ['1', '2'],
  );

  const refused = {
    tab: 'a:\n\tb: 1\n',
    crlf: 'a: 1\r\n',
    bom: '\ufeffa: 1\n',
    anchor: 'a: &x 1\n',
    alias: 'a: *x\n',
    tag: 'a: !!str 1\n',
    flowMap: 'a: {b: 1}\n',
    mergeKey: '<<: *x\n',
    documentMarker: '---\na: 1\n',
    duplicate: 'a: 1\na: 2\n',
    nestedDuplicate: 'a:\n  b: 1\n  b: 1\n',
    nullValue: 'a:\nb: 1\n',
    unterminatedFlow: 'a: [1, 2\n',
    emptyFlowItem: 'a: [1, , 2]\n',
    quotedFlowItem: "a: ['1']\n",
    badIndent: 'a:\n  b: 1\n   c: 2\n',
    plainContinuation: 'a: one\n  two\n',
    ambiguousPlain: 'a: b: c\n',
    empty: '',
    commentsOnly: '# nothing\n',
  };
  for (const [label, text] of Object.entries(refused)) {
    assert.equal(parseWorkflowDraft(text).ok, false, label);
  }
  assert.equal(parseWorkflowDraft(42).ok, false);
});

// ---------------------------------------------------------------------------
// Slot matrix

test('the matrix must be exactly the literal integers 1..59, each once, with no other axis', () => {
  const withSlots = (list) => mutate(SLOT_LINE, `        slot: [${list}]`);
  const numbers = Array.from({ length: CAMPAIGN_SLOT_COUNT }, (_, i) => String(i + 1));

  assertRejected(withSlots(numbers.slice(0, 58).join(', ')), /has 58 entries/, '58 slots');
  assertRejected(withSlots([...numbers, '60'].join(', ')), /has 60 entries/, '60 slots');
  assertRejected(
    withSlots(['1', '1', ...numbers.slice(2)].join(', ')),
    /entry 1 is repeated/,
    'duplicate slot',
  );
  assertRejected(
    withSlots(['1', '1', ...numbers.slice(2)].join(', ')),
    /missing slot 2/,
    'duplicate implies missing',
  );
  assertRejected(
    withSlots(numbers.filter((n) => n !== '30').join(', ')),
    /missing slot 30/,
    'missing slot',
  );
  assertRejected(
    withSlots([...numbers.slice(0, 58), '60'].join(', ')),
    /out of range/,
    'out-of-range slot',
  );
  assertRejected(withSlots(['0', ...numbers.slice(1)].join(', ')), /unquoted integers/, 'zero');
  assertRejected(
    withSlots(numbers.map((n) => (n === '7' ? '7.5' : n)).join(', ')),
    /unquoted integers/,
    'non-integer',
  );
  assertRejected(
    withSlots(numbers.map((n) => (n === '7' ? '07' : n)).join(', ')),
    /unquoted integers/,
    'leading zero',
  );
  assertRejected(
    withSlots(numbers.map((n) => (n === '7' ? '-7' : n)).join(', ')),
    /unquoted integers/,
    'signed',
  );
  assertRejected(
    withSlots(numbers.map((n) => (n === '7' ? "'7'" : n)).join(', ')),
    /malformed/,
    'quoted',
  );

  assertRejected(
    mutate(SLOT_LINE, `${SLOT_LINE}\n        shard: [1, 2]`),
    /matrix axis "shard" is not allowed/,
    'extra axis',
  );
  assertRejected(
    mutate(SLOT_LINE, `${SLOT_LINE}\n        include:\n          - slot: 60`),
    /matrix axis "include" is not allowed/,
    'include',
  );
  assertRejected(
    mutate(SLOT_LINE, `${SLOT_LINE}\n        exclude:\n          - slot: 7`),
    /matrix axis "exclude" is not allowed/,
    'exclude',
  );
});

test('a dynamic matrix is refused', () => {
  assertRejected(
    mutate(SLOT_LINE, '        slot: ${{ fromJSON(needs.plan.outputs.slots) }}'),
    /matrix\.slot must be a literal sequence/,
    'dynamic slot axis',
  );
  assertRejected(
    mutate(SLOT_LINE, '        slot: ${{ fromJSON(needs.plan.outputs.slots) }}'),
    /expression context is not allowed/,
    'dynamic expression',
  );
  assertRejected(
    mutate(`      matrix:\n${SLOT_LINE}`, '      matrix: ${{ fromJSON(vars.SLOTS) }}'),
    /strategy\.matrix must be a literal mapping/,
    'dynamic matrix',
  );
});

// ---------------------------------------------------------------------------
// Job shape

test('fail-fast, timeout, runner and job count are exact', () => {
  assertRejected(
    mutate('      fail-fast: false', '      fail-fast: true'),
    /fail-fast must be exactly false/,
    'fail-fast true',
  );
  assertRejected(
    mutate('      fail-fast: false\n', ''),
    /fail-fast must be exactly false/,
    'fail-fast missing',
  );
  assertRejected(
    mutate('      fail-fast: false', '      fail-fast: False'),
    /fail-fast must be exactly false/,
    'fail-fast spelling',
  );
  assertRejected(
    mutate('      fail-fast: false', '      fail-fast: false\n      max-parallel: 5'),
    /strategy key "max-parallel"/,
    'max-parallel',
  );
  assertRejected(
    mutate('    timeout-minutes: 45', '    timeout-minutes: 60'),
    /timeout-minutes must be exactly 45/,
    'wrong timeout',
  );
  assertRejected(
    mutate('    timeout-minutes: 45\n', ''),
    /timeout-minutes must be exactly 45/,
    'missing timeout',
  );
  assertRejected(
    mutate('    timeout-minutes: 45', "    timeout-minutes: '45'"),
    /timeout-minutes must be exactly 45/,
    'quoted timeout',
  );
  assertRejected(
    mutate('    runs-on: ubuntu-24.04', '    runs-on: ubuntu-latest'),
    /runs-on must be exactly ubuntu-24\.04/,
    'runner',
  );
  assertRejected(
    `${DRAFT}\n  second-job:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: echo hi\n`,
    /exactly one campaign job, found 2/,
    'extra job',
  );
  assertRejected(
    mutate('    runs-on: ubuntu-24.04', "    runs-on: ubuntu-24.04\n    if: github.ref == 'x'"),
    /job key "if" is not allowed/,
    'job condition',
  );
  assertRejected(
    mutate('    runs-on: ubuntu-24.04', '    runs-on: ubuntu-24.04\n    needs: plan'),
    /job key "needs" is not allowed/,
    'needs',
  );
  assertRejected(
    mutate('    services:\n', '    services:\n      redis:\n        image: redis:7\n'),
    /services must be exactly one postgres container/,
    'second service container',
  );
  assertRejected(
    mutate('        image: postgis/postgis:16-3.4', '        image: postgres:16'),
    /services must be exactly one postgres container/,
    'different database image',
  );
});

test('permissions, concurrency, trigger, caching and secrets are fail-closed', () => {
  assertRejected(
    mutate('permissions:\n  contents: read', 'permissions:\n  contents: write'),
    /contents: read \(no write permission\)/,
    'contents write',
  );
  assertRejected(
    mutate('permissions:\n  contents: read', 'permissions:\n  contents: read\n  actions: write'),
    /no write permission/,
    'actions write',
  );
  assertRejected(
    mutate('permissions:\n  contents: read', 'permissions: write-all'),
    /no write permission/,
    'write-all',
  );
  assertRejected(
    mutate(
      '    runs-on: ubuntu-24.04',
      '    runs-on: ubuntu-24.04\n    permissions:\n      contents: write',
    ),
    /permissions may only be declared once/,
    'job permissions',
  );
  assertRejected(
    mutate('  cancel-in-progress: false', '  cancel-in-progress: true'),
    /cancel-in-progress: false/,
    'cancel true',
  );
  assertRejected(
    mutate('  cancel-in-progress: false\n', ''),
    /cancel-in-progress: false/,
    'cancel missing',
  );
  assertRejected(
    mutate(
      'on:\n  push:',
      'on:\n  workflow_dispatch:\n    inputs:\n      x:\n        type: string\n  push:',
    ),
    /on must be exactly push/,
    'dispatch trigger',
  );
  assertRejected(
    mutate('    paths: [.github/workflows/adr-055-fresh-run-first-pair.yml]\n', ''),
    /on must be exactly push/,
    'unfiltered push',
  );
  assertRejected(
    mutate(
      '    paths: [.github/workflows/adr-055-fresh-run-first-pair.yml]',
      '    paths: [scripts/aggregation-evidence.mjs]',
    ),
    /on must be exactly push/,
    'push on an ordinary source path',
  );
  assertRejected(
    mutate(
      '    paths: [.github/workflows/adr-055-fresh-run-first-pair.yml]',
      '    paths: [.github/workflows/adr-055-fresh-run-first-pair.yml, scripts/x.mjs]',
    ),
    /on must be exactly push/,
    'second trigger path',
  );
  assertRejected(
    mutate(
      '          node-version: ${{ env.NODE_VERSION }}',
      '          node-version: ${{ env.NODE_VERSION }}\n          cache: pnpm',
    ),
    /caching is not allowed/,
    'setup-node cache',
  );
  assertRejected(
    mutate(
      '          PGPASSWORD: rasta_ci_password\n          PGDATABASE',
      '          PGPASSWORD: ${{ secrets.PG }}\n          PGDATABASE',
    ),
    /expression context is not allowed/,
    'secret reference',
  );
  assertRejected(
    mutate('      - run: pnpm install --frozen-lockfile', '      - run: echo "$GITHUB_TOKEN"'),
    /secrets or tokens must not be referenced/,
    'token reference',
  );
  assertRejected(
    mutate('permissions:\n', 'defaults:\n  run:\n    shell: bash {0}\n\npermissions:\n'),
    /top-level key "defaults" is not allowed/,
    'defaults',
  );
});

test('every uses: is pinned to a full 40-hex commit SHA', () => {
  assertRejected(
    mutate(`actions/checkout@${CHECKOUT_SHA} # v4`, 'actions/checkout@v4'),
    /uses must pin owner\/repo@<40-hex commit SHA>/,
    'mutable tag',
  );
  assertRejected(
    mutate(`actions/checkout@${CHECKOUT_SHA} # v4`, 'actions/checkout@11d5960'),
    /40-hex commit SHA/,
    'short SHA',
  );
  assertRejected(
    mutate(`actions/checkout@${CHECKOUT_SHA} # v4`, 'actions/checkout@main'),
    /40-hex commit SHA/,
    'branch ref',
  );
  assertRejected(
    mutate(`actions/upload-artifact@${UPLOAD_SHA} # v4`, 'actions/upload-artifact@v4'),
    /40-hex commit SHA/,
    'mutable upload tag',
  );
  assertRejected(
    mutate(
      `actions/checkout@${CHECKOUT_SHA} # v4`,
      `actions/checkout@${CHECKOUT_SHA.toUpperCase()} # v4`,
    ),
    /40-hex commit SHA/,
    'uppercase SHA',
  );
  assertRejected(
    mutate(`actions/checkout@${CHECKOUT_SHA} # v4`, 'docker://alpine:3'),
    /40-hex commit SHA/,
    'docker action',
  );
});

// ---------------------------------------------------------------------------
// run_attempt guard

test('the first step must effectively refuse any run_attempt other than 1', () => {
  assertRejected(mutate(GUARD_BLOCK, ''), /does not effectively refuse/, 'guard missing');
  assertRejected(
    mutate(CHECKOUT_LINE, CHECKOUT_LINE + '\n' + GUARD_BLOCK, mutate(GUARD_BLOCK, '')),
    /guard must precede checkout/,
    'guard after checkout',
  );
  const guard = (edit) => mutate(GUARD_BLOCK, edit(GUARD_BLOCK));
  assertRejected(
    guard((block) => block.replace('exit 1', 'exit 0')),
    /does not effectively refuse/,
    'exit 0',
  );
  assertRejected(
    guard((block) => block.replace('            exit 1\n', '')),
    /does not effectively refuse/,
    'no exit',
  );
  assertRejected(
    guard((block) => block.replace('!= "1" ]; then', '= "1" ]; then')),
    /does not effectively refuse/,
    'inverted comparison',
  );
  assertRejected(
    guard((block) => block.replace('!= "1" ]; then', '!= "2" ]; then')),
    /does not effectively refuse/,
    'wrong attempt',
  );
  assertRejected(
    guard((block) => block.replace('github.run_attempt }}', 'github.run_number }}')),
    /does not effectively refuse/,
    'wrong context',
  );
  assertRejected(
    guard((block) => block.replace("echo 'github", 'echo "${{ github.ref }}"; echo \'github')),
    /does not effectively refuse/,
    'extra command in guard',
  );
  assertRejected(
    mutate(
      '        run: |\n          if [ "${{ github.run_attempt }}"',
      '        if: github.run_attempt != 1\n        run: |\n          if [ "${{ github.run_attempt }}"',
    ),
    /guard\) must have no "if"/,
    'guard step condition',
  );
  assertRejected(
    mutate(
      GUARD_BLOCK,
      '      - name: Refuse any attempt other than the first\n        if: github.run_attempt != 1\n        run: exit 1\n\n',
    ),
    /guard\) must have no "if"|does not effectively refuse/,
    'condition-only guard',
  );
  assertRejected(
    mutate(
      '        run: |\n          if [ "${{ github.run_attempt }}"',
      '        continue-on-error: true\n        run: |\n          if [ "${{ github.run_attempt }}"',
    ),
    /continue-on-error is not allowed/,
    'guard continue-on-error',
  );
  assertRejected(
    guard((block) => block.replace('          fi\n', '          fi\n          true\n')),
    /does not effectively refuse/,
    'trailing command',
  );
  assertRejected(
    guard((block) => block.replace('            exit 1\n', '            # exit 1\n')),
    /does not effectively refuse/,
    'commented-out exit',
  );

  const orForm = mutate(
    GUARD_BLOCK,
    '      - name: Refuse any attempt other than the first\n        run: test "${{ github.run_attempt }}" = "1" || exit 1\n\n',
  );
  assert.deepEqual(validateWorkflowDraft(orForm), { ok: true, problems: [] });
  assertRejected(
    mutate('|| exit 1', '|| true', orForm),
    /does not effectively refuse/,
    'or-form neutralised',
  );
});

// ---------------------------------------------------------------------------
// Measurement and upload

test('the one calibration is --pairs 1 with the slot sourced from matrix.slot', () => {
  const invocation = (text) => mutate(INVOCATION, text);
  assertRejected(
    invocation(INVOCATION.replace('--pairs 1', '--pairs 2')),
    /exactly --pairs 1/,
    'pairs 2',
  );
  assertRejected(
    invocation(INVOCATION.replace('--pairs 1', '--pairs 20')),
    /exactly --pairs 1/,
    'pairs 20',
  );
  assertRejected(
    invocation(INVOCATION.replace('--pairs 1 ', '')),
    /exactly --pairs 1/,
    'pairs missing',
  );
  for (const [label, slot] of [
    ['job index', '"${{ strategy.job-index }}"'],
    ['pair', '"${{ matrix.pair }}"'],
    ['literal', '"7"'],
    ['shell variable', '"$SLOT"'],
    ['unquoted', '${{ matrix.slot }}'],
  ]) {
    assertRejected(
      invocation(INVOCATION.replace('--slot "${{ matrix.slot }}"', `--slot ${slot}`)),
      /--slot must be bound directly/,
      label,
    );
  }
  assertRejected(
    invocation(INVOCATION.replace('--slot "${{ matrix.slot }}"', '--slot="${{ matrix.slot }}"')),
    /--slot must be bound directly/,
    '--slot=',
  );
  assertRejected(
    invocation(
      INVOCATION.replace(
        '"$RUNNER_TEMP/adr-055-fresh-run-slot-${{ matrix.slot }}.txt"',
        '"$RUNNER_TEMP/report.txt"',
      ),
    ),
    /report must be/,
    'report not named by slot',
  );
  assertRejected(invocation(`${INVOCATION} --retries 2`), /no argument beyond/, 'retry flag');
  assertRejected(invocation(`${INVOCATION} --retries 2`), /retry, rerun/, 'retry spelling');
  assertRejected(
    invocation(`for i in 1 2; do ${INVOCATION} && break; done`),
    /shell loops are not allowed/,
    'retry loop',
  );
  assertRejected(
    invocation(`${INVOCATION} || ${INVOCATION}`),
    /no argument beyond|measurement body/,
    'second invocation on one line',
  );
  assertRejected(
    invocation(`${INVOCATION}\n          ${INVOCATION}`),
    /measurement body must be exactly/,
    'second invocation line',
  );
  assertRejected(
    invocation(
      INVOCATION.replace(
        'pnpm run calibrate:aggregation-stress --',
        'node scripts/aggregation-evidence.mjs --calibrate',
      ),
    ),
    /must invoke pnpm run calibrate:aggregation-stress/,
    'bypassed package script',
  );
  assertRejected(
    mutate('          set +e\n          pnpm', '          pnpm'),
    /measurement body must be exactly/,
    'status not captured',
  );
  assertRejected(
    mutate('          exit "$status"\n', '          exit 0\n'),
    /measurement body must be exactly/,
    'status not re-raised',
  );
  assertRejected(
    mutate(
      '      - name: One-pair calibration for this slot\n',
      '      - name: One-pair calibration for this slot\n        continue-on-error: true\n',
    ),
    /continue-on-error is not allowed/,
    'step continue-on-error',
  );
  assertRejected(
    mutate('    runs-on: ubuntu-24.04', '    runs-on: ubuntu-24.04\n    continue-on-error: true'),
    /continue-on-error is not allowed/,
    'job continue-on-error',
  );
  assertRejected(
    mutate(
      `      - name: Upload this slot's calibration report`,
      `      - name: Retry a failed slot\n        if: failure()\n        run: ${INVOCATION}\n\n      - name: Upload this slot's calibration report`,
    ),
    /exactly one calibration step is required, found 2|only the report upload may carry/,
    'replacement step',
  );
  assertRejected(
    mutate(
      '      - run: pnpm install --frozen-lockfile',
      `      - uses: nick-fields/retry@${CHECKOUT_SHA}\n        with:\n          max_attempts: 3\n          command: pnpm install --frozen-lockfile`,
    ),
    /retry, rerun|names a retry/,
    'retry action',
  );
  assertRejected(
    mutate('      - run: pnpm install --frozen-lockfile', '      - run: gh run rerun --failed'),
    /retry, rerun, re-dispatch or replacement/,
    'gh rerun',
  );
  assertRejected(
    mutate(
      '      - run: pnpm install --frozen-lockfile',
      '      - run: pnpm install --frozen-lockfile\n        timeout-minutes: 5',
    ),
    /step key "timeout-minutes" is not allowed/,
    'step key',
  );
});

test('the report upload always runs and is bound to the slot report', () => {
  const upload = `        if: always()\n        uses: actions/upload-artifact@${UPLOAD_SHA} # v4`;
  const noIf = `        uses: actions/upload-artifact@${UPLOAD_SHA} # v4`;
  assertRejected(mutate(upload, noIf), /if: always\(\)/, 'missing if');
  assertRejected(
    mutate(upload, upload.replace('always()', 'failure()')),
    /if: always\(\)/,
    'failure()',
  );
  assertRejected(
    mutate(upload, upload.replace('always()', 'success()')),
    /if: always\(\)/,
    'success()',
  );
  assertRejected(
    mutate(upload, upload.replace('always()', '${{ always() }}')),
    /if: always\(\)/,
    'expression-wrapped',
  );
  const uploadStart = DRAFT.indexOf(`      - name: Upload this slot's calibration report`);
  assertRejected(
    DRAFT.slice(0, uploadStart),
    /exactly one report upload step is required, found 0/,
    'no upload',
  );
  assertRejected(
    mutate(
      '          name: adr-055-fresh-run-slot-${{ matrix.slot }}',
      '          name: adr-055-fresh-run-report',
    ),
    /artifact name must contain/,
    'artifact not named by slot',
  );
  assertRejected(
    mutate(
      '          path: ${{ runner.temp }}/adr-055-fresh-run-slot-${{ matrix.slot }}.txt',
      '          path: ${{ runner.temp }}/other-${{ matrix.slot }}.txt',
    ),
    /upload path must be/,
    'path mismatch',
  );
  assertRejected(
    mutate('          if-no-files-found: error', '          if-no-files-found: warn'),
    /if-no-files-found must be error/,
    'missing report tolerated',
  );
  assertRejected(
    mutate(
      '          if-no-files-found: error',
      '          if-no-files-found: error\n          overwrite: true',
    ),
    /upload with key "overwrite" is not allowed/,
    'overwrite',
  );
  assertRejected(
    mutate(
      '      - name: Harness tests (no infrastructure)\n',
      '      - name: Harness tests (no infrastructure)\n        if: success()\n',
    ),
    /only the report upload may carry an if: condition/,
    'result-derived branching',
  );
});

// ---------------------------------------------------------------------------
// Duplicate keys and malformed drafts

test('duplicate security-critical keys are refused, never last-wins', () => {
  const duplicates = [
    [
      'fail-fast',
      mutate('      fail-fast: false', '      fail-fast: true\n      fail-fast: false'),
    ],
    [
      'cancel-in-progress',
      mutate(
        '  cancel-in-progress: false',
        '  cancel-in-progress: true\n  cancel-in-progress: false',
      ),
    ],
    [
      'permissions',
      mutate(
        'permissions:\n  contents: read',
        'permissions:\n  contents: write\npermissions:\n  contents: read',
      ),
    ],
    ['contents', mutate('  contents: read', '  contents: write\n  contents: read')],
    [
      'timeout-minutes',
      mutate('    timeout-minutes: 45', '    timeout-minutes: 360\n    timeout-minutes: 45'),
    ],
    ['slot', mutate(SLOT_LINE, `        slot: [1]\n${SLOT_LINE}`)],
    ['if', mutate('        if: always()', '        if: failure()\n        if: always()')],
    ['jobs', `${DRAFT}jobs:\n  other:\n    runs-on: ubuntu-24.04\n`],
    [
      'run',
      mutate(
        '        run: |\n          if [ "${{',
        '        run: exit 0\n        run: |\n          if [ "${{',
      ),
    ],
  ];
  for (const [key, text] of duplicates) {
    const result = validateWorkflowDraft(text);
    assert.equal(result.ok, false, key);
    assert.match(
      result.problems[0],
      new RegExp(`malformed draft at line \\d+: duplicate key "${key}"`),
      key,
    );
  }
});

test('malformed and truncated drafts are refused', () => {
  const lines = DRAFT.split('\n');
  for (const fraction of [0.1, 0.25, 0.5, 0.75, 0.9]) {
    const truncated = lines.slice(0, Math.floor(lines.length * fraction)).join('\n');
    assert.equal(validateWorkflowDraft(truncated).ok, false, `truncated at ${fraction}`);
  }
  const midLine = DRAFT.slice(0, DRAFT.indexOf(SLOT_LINE) + 40);
  assertRejected(midLine, /malformed draft/, 'truncated inside the matrix');
  const midSha = DRAFT.slice(0, DRAFT.indexOf(UPLOAD_SHA) + 10);
  assert.equal(validateWorkflowDraft(midSha).ok, false, 'truncated inside the upload SHA');

  assertRejected('', /malformed draft/, 'empty');
  assertRejected(DRAFT.replace(/\n/g, '\r\n'), /carriage returns/, 'CRLF');
  assertRejected(
    mutate('    runs-on: ubuntu-24.04', '\truns-on: ubuntu-24.04'),
    /tab characters/,
    'tab',
  );
  assertRejected(`---\n${DRAFT}`, /document markers/, 'document marker');
  assertRejected(mutate('  contents: read', '  contents: &perm read'), /malformed/, 'anchor');
  assertRejected('x'.repeat(300 * 1024), /exceeds/, 'oversized');
  assertRejected('just some text\n', /malformed/, 'not a mapping');
  assertRejected('a: 1\n', /exactly one campaign job/, 'unrelated mapping');
});

// ---------------------------------------------------------------------------
// Output and CLI

test('diagnostics are deterministic, bounded and free of draft values', () => {
  const noisy = DRAFT.replace(/timeout-minutes: 45/, 'timeout-minutes: 99')
    .replace(SLOT_LINE, '        slot: [1]')
    .replace('  cancel-in-progress: false', '  cancel-in-progress: true');
  const result = validateWorkflowDraft(noisy);
  assert.equal(result.ok, false);
  assert.ok(result.problems.length > MAX_REPORTED_PROBLEMS);
  const text = formatWorkflowCheck(result);
  assert.equal(text, formatWorkflowCheck(validateWorkflowDraft(noisy)));
  const problemLines = text.split('\n').filter((line) => line.startsWith('  - '));
  assert.equal(problemLines.length, MAX_REPORTED_PROBLEMS);
  assert.match(text, /… and \d+ more\nRESULT: FAIL\n$/);
  assert.ok(!text.includes('99'));

  const secretish = mutate(
    '          PGPASSWORD: rasta_ci_password\n          PGDATABASE',
    '          PGPASSWORD: ${{ secrets.SUPER_SECRET_VALUE }}\n          PGDATABASE',
  );
  assert.ok(!formatWorkflowCheck(validateWorkflowDraft(secretish)).includes('SUPER_SECRET_VALUE'));

  assert.match(formatWorkflowCheck(validateWorkflowDraft(DRAFT)), /RESULT: PASS\n$/);
});

test('the CLI exits 0 only for a valid draft and never prints a path', () => {
  const pass = spawnSync(process.execPath, [CLI, DRAFT_PATH], { encoding: 'utf8' });
  assert.equal(pass.status, 0, pass.stdout + pass.stderr);
  assert.match(pass.stdout, /RESULT: PASS/);
  assert.equal(pass.stderr, '');
  for (const leak of [DRAFT_PATH, repoRoot, 'fresh-run-campaign-workflow-draft', '.yaml.txt']) {
    assert.ok(!pass.stdout.includes(leak), 'path leaked on pass');
  }
  const again = spawnSync(process.execPath, [CLI, '--', DRAFT_PATH], { encoding: 'utf8' });
  assert.equal(again.status, 0);
  assert.equal(again.stdout, pass.stdout, 'deterministic; `--` separator accepted');

  const dir = tempDir();
  const mutated = join(dir, 'secret-location-draft.yaml.txt');
  writeFileSync(mutated, mutate('      fail-fast: false', '      fail-fast: true'));
  const fail = spawnSync(process.execPath, [CLI, mutated], { encoding: 'utf8' });
  assert.equal(fail.status, 1);
  assert.match(fail.stdout, /fail-fast must be exactly false/);
  assert.match(fail.stdout, /RESULT: FAIL/);
  for (const leak of [dir, 'secret-location-draft']) assert.ok(!fail.stdout.includes(leak));

  const missing = join(dir, 'does-not-exist-location.yaml.txt');
  const unreadable = spawnSync(process.execPath, [CLI, missing], { encoding: 'utf8' });
  assert.equal(unreadable.status, 1);
  assert.match(unreadable.stdout, /draft could not be read/);
  assert.ok(!(unreadable.stdout + unreadable.stderr).includes('does-not-exist-location'));

  for (const argv of [[], [DRAFT_PATH, DRAFT_PATH], ['--path=/secret/location'], ['--help']]) {
    const usage = spawnSync(process.execPath, [CLI, ...argv], { encoding: 'utf8' });
    assert.equal(usage.status, 2, JSON.stringify(argv));
    assert.match(usage.stdout, /usage:/);
    assert.ok(!usage.stdout.includes('/secret/location'));
    assert.ok(!usage.stdout.includes(DRAFT_PATH));
  }
});

test('the CLI value reads only the one given draft', () => {
  const read = [];
  const result = runWorkflowCheckCli({
    argv: ['--', 'some/private/place.yaml.txt'],
    readText: (path) => {
      read.push(path);
      return DRAFT;
    },
  });
  assert.deepEqual(read, ['some/private/place.yaml.txt']);
  assert.equal(result.exitCode, 0);
  assert.ok(!result.output.includes('private'));

  const thrown = runWorkflowCheckCli({
    argv: ['elsewhere/private.yaml.txt'],
    readText: () => {
      throw new Error('ENOENT elsewhere/private.yaml.txt');
    },
  });
  assert.equal(thrown.exitCode, 1);
  assert.ok(!thrown.output.includes('private'));
  assert.equal(runWorkflowCheckCli({ argv: [] }).exitCode, 2);
});
