#!/usr/bin/env node
// -----------------------------------------------------------------------------
// Proves every test in a spec file passes when it is the only test selected.
//
// A suite that passes as a file and fails one test at a time is not a suite
// that tests less — it is a suite that tests *something else*. The assertions
// still run, but the state they read was established by a sibling `it()`, so
// what they actually prove is "this holds after the six tests before it", and
// nobody wrote that down. Delete an earlier test, reorder two, or let CI
// re-run a single failure with `--testNamePattern`, and the assertion starts
// failing against unchanged production code.
//
// That is F-25, and this is the control that keeps it closed. It found the
// original five: in `maintenance-service/test/event-flow.int-spec.ts` the
// whole file passed while five of its eight tests failed alone, four of them
// as `findFirstOrThrow` raising "No record was found for a query" — a message
// that names the query and says nothing about the missing setup.
//
// How it works, in two passes:
//
//   1. Run the file whole, with `--json`, and require every test to pass.
//      That also *collects the test names from the run itself* rather than by
//      parsing `it(` out of the source, so a renamed, templated or
//      `describe.each` test cannot silently drop out of the gate.
//   2. Run each collected name again on its own, and require exactly one test
//      to run and to pass.
//
// Pass 2 is the gate; pass 1 is what makes pass 2 honest. A file that fails
// whole is reported as that, not as an independence failure.
//
// Usage:
//
//   node scripts/verify-test-independence.mjs <package-dir> <testPathPattern> [--project <name>]
//
//   node scripts/verify-test-independence.mjs services/maintenance-service event-flow
//
// It shells out to the package's own jest, so the projects, transform,
// timeouts and environment are the ones the suite normally runs under. No
// database or broker is set up here: the caller provides the same variables
// `pnpm test:integration` needs, exactly as CI already does for that step.
// -----------------------------------------------------------------------------

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith('--'));
const projectIndex = args.indexOf('--project');
const project = projectIndex >= 0 ? args[projectIndex + 1] : 'integration';

const [packageDir, testPathPattern] = positional;

if (!packageDir || !testPathPattern) {
  console.error(
    'usage: node scripts/verify-test-independence.mjs <package-dir> <testPathPattern> [--project <name>]',
  );
  process.exit(2);
}

const cwd = path.resolve(process.cwd(), packageDir);
if (!existsSync(cwd)) {
  console.error(`no such package directory: ${cwd}`);
  process.exit(2);
}

/**
 * Escapes a test name for `--testNamePattern`, which is a regex.
 *
 * Test names in this repository contain parentheses, dots and Persian text.
 * An unescaped `(` is a capture group that changes what the pattern matches;
 * an unescaped `.` matches a character the name does not contain. Either one
 * turns a passing gate into a vacuous one, so the name is escaped and then
 * anchored to the end — `$` rather than `^...$`, because jest matches against
 * the full `describe > it` name and we are given only part of it.
 */
function toPattern(fullName) {
  return `${fullName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;
}

/**
 * Jest's own entry point, resolved from the package under test.
 *
 * Run through `node <entry>` rather than through `npx jest`, because `npx`
 * resolves to a `.cmd` shim on Windows and Node will only spawn one with
 * `shell: true` — and a shelled spawn does not quote its arguments. A test
 * name is several words long, so `-t "a b c"` arrived as `-t a b c`: the
 * extra words were read as more path patterns, the pattern became an
 * alternation, and 23 tests ran where one was asked for. That is a gate
 * reporting green while measuring nothing, which is the exact failure mode
 * this script exists to catch, so it is worth not having.
 */
const jestPackageJson = createRequire(path.join(cwd, 'noop.js')).resolve('jest/package.json');
const jestBin = createRequire(import.meta.url)(jestPackageJson).bin;
const jestEntry = path.join(
  path.dirname(jestPackageJson),
  typeof jestBin === 'string' ? jestBin : jestBin.jest,
);

function runJest(extraArgs) {
  return spawnSync(
    process.execPath,
    [jestEntry, '--selectProjects', project, '--runInBand', '--json', ...extraArgs],
    { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
}

/**
 * jest writes its human-readable progress to stderr and the `--json` report to
 * stdout, but setup code in the suite can also write to stdout. The report is
 * the last complete JSON object there, so it is found by scanning back from
 * the last `{` that parses.
 */
function parseReport(stdout) {
  const start = stdout.indexOf('{"numFailedTest');
  const candidate = start >= 0 ? stdout.slice(start) : stdout;
  try {
    return JSON.parse(candidate);
  } catch {
    const brace = candidate.lastIndexOf('\n{');
    if (brace >= 0) {
      try {
        return JSON.parse(candidate.slice(brace + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

console.log(`\n== pass 1: ${packageDir} :: ${testPathPattern} — whole file ==\n`);

const whole = runJest([`--testPathPattern=${testPathPattern}`]);
const wholeReport = parseReport(whole.stdout ?? '');

if (!wholeReport) {
  console.error(whole.stderr ?? '');
  console.error('could not parse the jest --json report for the whole-file run');
  process.exit(1);
}

if (wholeReport.numTotalTests === 0) {
  console.error(`no tests matched ${testPathPattern} in project "${project}"`);
  process.exit(1);
}

if (whole.status !== 0 || wholeReport.numFailedTests > 0) {
  console.error(whole.stderr ?? '');
  console.error(
    `the file does not pass as a whole (${wholeReport.numFailedTests} failed). ` +
      'Fix that first — this gate reports independence, not correctness.',
  );
  process.exit(1);
}

const names = wholeReport.testResults
  .flatMap((file) => file.assertionResults)
  .filter((test) => test.status === 'passed')
  .map((test) => test.fullName);

console.log(`   ${names.length} tests passed as a file.\n`);
console.log(`== pass 2: each test on its own ==\n`);

const failures = [];

for (const fullName of names) {
  const single = runJest([`--testPathPattern=${testPathPattern}`, '-t', toPattern(fullName)]);
  const report = parseReport(single.stdout ?? '');

  const ran = report ? report.numPassedTests + report.numFailedTests : 0;
  const ok = single.status === 0 && report && report.numFailedTests === 0 && ran === 1;

  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${fullName}`);

  if (!ok) {
    failures.push({
      fullName,
      // `ran !== 1` is its own defect: zero means the pattern selected nothing
      // (so the gate would have passed vacuously), more than one means a name
      // is a prefix of another and the test was never really run alone.
      reason: !report
        ? 'no parsable jest report'
        : ran === 0
          ? 'the name pattern selected no test'
          : ran > 1
            ? `the name pattern selected ${ran} tests, so none ran alone`
            : 'the test failed when selected on its own',
      stderr: single.stderr ?? '',
    });
  }
}

if (failures.length > 0) {
  console.error(`\n${failures.length} test(s) depend on another test having run first (F-25):\n`);
  for (const failure of failures) {
    console.error(`  ● ${failure.fullName}`);
    console.error(`    ${failure.reason}\n`);
    console.error(failure.stderr.split('\n').slice(-40).join('\n'));
  }
  process.exit(1);
}

console.log(`\nAll ${names.length} tests pass independently.\n`);
