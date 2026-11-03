import { PLAYWRIGHT_CLI } from './playwright-cli';
/**
 * @jest-environment node
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';

/**
 * The CI guard in `e2e/tenant-isolation.spec.ts`, checked through Playwright
 * itself: the file is listed (`playwright test --list`, no browser, no portal)
 * under every combination of its two flags, and what Playwright would run is
 * read from its own report. A skip declared with `test.skip(condition)` in a
 * `describe` is applied while the file loads, so the listing already says
 * which tests a run would skip.
 *
 * The case this exists for (PR #305 review round 2): the guard used to sit
 * inside the block that `WEB_LIVE_STACK_E2E` skips, so under `CI` with that
 * flag lost, the guard was skipped too, or never registered, and the job could
 * go green with no isolation scenario run.
 */

const WEB_ROOT = path.resolve(__dirname, '../..');
const SPEC = 'e2e/tenant-isolation.spec.ts';
const FILE = path.basename(SPEC);
const GATE = 'CI runs every live tenant-isolation scenario, none skipped';
const EXP004 = 'EXP-004 — projects and inventory, created live for this run';
/** `playwright.config.ts`: the desktop project and the phone one, which this file joins. */
const PROJECTS = ['chromium', 'mobile'];
const EXP004_SCENARIOS = 5;

interface Listed {
  /** Titles from the file down to the test: `[file, test]` is a top-level test. */
  readonly titles: readonly string[];
  readonly project: string;
  readonly expectedStatus: string;
}

interface Suite {
  readonly title: string;
  readonly specs?: ReadonlyArray<{
    readonly title: string;
    readonly tests: ReadonlyArray<{
      readonly projectName: string;
      readonly expectedStatus: string;
    }>;
  }>;
  readonly suites?: readonly Suite[];
}

type Flag = 'true' | 'false' | undefined;

function list(ci: boolean, live: Flag, exp004: Flag): Listed[] {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // Playwright refuses to load test files when it sees it is inside a jest worker.
  delete env.JEST_WORKER_ID;
  delete env.CI;
  delete env.WEB_LIVE_STACK_E2E;
  delete env.WEB_LIVE_STACK_E2E_EXP004;
  if (ci) env.CI = 'true';
  if (live !== undefined) env.WEB_LIVE_STACK_E2E = live;
  if (exp004 !== undefined) env.WEB_LIVE_STACK_E2E_EXP004 = exp004;

  const cli = PLAYWRIGHT_CLI;
  const run = spawnSync(process.execPath, [cli, 'test', '--list', '--reporter=json', SPEC], {
    cwd: WEB_ROOT,
    encoding: 'utf8',
    env: { ...env, NODE_OPTIONS: '' },
    timeout: 60_000,
  });
  if (run.status !== 0) {
    throw new Error(`playwright --list exited ${run.status}: ${run.stderr}${run.stdout}`);
  }

  const listed: Listed[] = [];
  const walk = (suite: Suite, titles: readonly string[]): void => {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests) {
        listed.push({
          titles: [...titles, spec.title],
          project: test.projectName,
          expectedStatus: test.expectedStatus,
        });
      }
    }
    for (const child of suite.suites ?? []) walk(child, [...titles, child.title]);
  };
  const report = JSON.parse(run.stdout) as { suites: readonly Suite[] };
  for (const suite of report.suites) walk(suite, [suite.title]);
  return listed;
}

const gates = (listed: readonly Listed[]) => listed.filter((t) => t.titles.at(-1) === GATE);
const exp004 = (listed: readonly Listed[]) => listed.filter((t) => t.titles.includes(EXP004));

describe('under CI, both flags true: every scenario runs and the guard is not there', () => {
  let listed: Listed[];
  beforeAll(() => {
    listed = list(true, 'true', 'true');
  }, 90_000);

  it('registers no guard', () => {
    expect(gates(listed)).toEqual([]);
  });

  it('runs the five EXP-004 scenarios at both viewports', () => {
    const scenarios = exp004(listed);
    expect(scenarios).toHaveLength(EXP004_SCENARIOS * PROJECTS.length);
    expect(new Set(scenarios.map((t) => t.project))).toEqual(new Set(PROJECTS));
    expect(scenarios.filter((t) => t.expectedStatus !== 'passed')).toEqual([]);
  });

  it('skips nothing else in the file either', () => {
    expect(listed.length).toBeGreaterThan(EXP004_SCENARIOS * PROJECTS.length);
    expect(listed.filter((t) => t.expectedStatus !== 'passed')).toEqual([]);
  });
});

describe.each<[string, Flag, Flag]>([
  ['WEB_LIVE_STACK_E2E=false, WEB_LIVE_STACK_E2E_EXP004=true (review round 2)', 'false', 'true'],
  ['WEB_LIVE_STACK_E2E=true, WEB_LIVE_STACK_E2E_EXP004=false (review round 1)', 'true', 'false'],
  ['both false', 'false', 'false'],
  ['both unset', undefined, undefined],
])('under CI, %s: a guard that cannot be skipped fails the run', (_name, live, exp) => {
  let listed: Listed[];
  beforeAll(() => {
    listed = list(true, live, exp);
  }, 90_000);

  it('registers the guard at the top level of the file, outside every describe, at both viewports', () => {
    expect(gates(listed).map((t) => [t.titles, t.project])).toEqual(
      PROJECTS.map((project) => [[FILE, GATE], project]),
    );
  });

  it('expects the guard to run (and fail), not to be skipped', () => {
    expect(gates(listed).map((t) => t.expectedStatus)).toEqual(PROJECTS.map(() => 'passed'));
  });

  it('is the case the guard is for: the EXP-004 scenarios are skipped', () => {
    const scenarios = exp004(listed);
    expect(scenarios).toHaveLength(EXP004_SCENARIOS * PROJECTS.length);
    expect(scenarios.filter((t) => t.expectedStatus !== 'skipped')).toEqual([]);
  });
});

describe('locally, without CI: the plain skips apply and nothing is forced', () => {
  it('registers no guard and skips the live scenarios', () => {
    const listed = list(false, undefined, undefined);
    expect(gates(listed)).toEqual([]);
    expect(exp004(listed)).toHaveLength(EXP004_SCENARIOS * PROJECTS.length);
    expect(listed.filter((t) => t.expectedStatus !== 'skipped')).toEqual([]);
  }, 90_000);
});
