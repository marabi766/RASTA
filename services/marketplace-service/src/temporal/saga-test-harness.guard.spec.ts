import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import * as ts from 'typescript';
// eslint-disable-next-line @typescript-eslint/no-require-imports -- the shared CommonJS lister
const { authoredFiles } = require('../../../../scripts/authored-source-inventory.cjs') as {
  authoredFiles: (dir: string) => string[];
};

/**
 * A test that drives a saga on a Temporal test server owns nothing past its
 * test (FU-214): its worker runs through `runBounded` (or `onWorker`, which is
 * built on it), whose deadline ends every wait and SDK call the body makes and
 * is awaited before the worker stops. What breaks that, and is refused here:
 *
 * - `runUntil` called directly: nothing bounds the body, and a timer raced
 *   against it (`within`) abandons a drive that runs on into later tests.
 * - a wall-clock timer (`setTimeout`, `setInterval`, `timers/promises`): a
 *   count of pauses or a step timer instead of the run's deadline.
 * - the step helpers FU-214 removed (`within`, `STEP_DEADLINE_MS`,
 *   `pollWithin`), by name.
 * - `terminate` outside `cleanUp`: after the run's deadline its signal is
 *   aborted, and the stop fails at once, leaving the workflow running (or,
 *   with `.catch`, silently so).
 *
 * #812 added cases written against the old helpers to a file this rule had
 * just moved off them; the merge was textually clean and only the train's
 * typecheck saw it. Every spec that starts a test server or a worker is
 * scanned, a new file included: a file is exempt only by being pinned below,
 * with its exact count, so a new violation in it fails as well.
 */
const PACKAGE = join(__dirname, '..', '..');

type Rule = 'runUntil' | 'timer' | 'removed helper' | 'terminate';
const RULES: readonly Rule[] = ['runUntil', 'timer', 'removed helper', 'terminate'];

/**
 * Files written before the rule, not yet moved onto the harness (FU-214
 * follow-up). Each count is exact: one more fails, and one fewer asks for the
 * pin to come down, so the list only shrinks.
 */
const NOT_YET_ON_THE_HARNESS: Record<string, Partial<Record<Rule, number>>> = {
  // Its `eventually` returns silently after 3000 x 10 ms; its workers run under `bounded`.
  'src/temporal/workflows-rollover.spec.ts': { timer: 2 },
  'src/temporal/workflows-owed-work.spec.ts': { runUntil: 1, timer: 2, terminate: 1 },
  'src/temporal/activity-cancellation.spec.ts': { runUntil: 1, timer: 1 },
  'test/dispute-settle-resume.int-spec.ts': { runUntil: 1, timer: 1, terminate: 1 },
  'test/saga-activity-replay.int-spec.ts': { runUntil: 1 },
  'test/saga-start-workflow.int-spec.ts': { runUntil: 1 },
  // Its worker runs under `runBounded`; the terminate is on the success path only.
  'test/saga-held-proof-wait.int-spec.ts': { terminate: 1 },
};

/**
 * The harness's own tests: a stand-in worker's `runUntil` and the timers whose
 * expiry they measure. Exact counts, as above.
 */
const THE_HARNESS_ITSELF: Record<string, Partial<Record<Rule, number>>> = {
  'src/temporal/legacy-handoff.spec.ts': { runUntil: 2, timer: 5 },
};
const PINNED = { ...NOT_YET_ON_THE_HARNESS, ...THE_HARNESS_ITSELF };

const REMOVED_HELPERS = new Set(['within', 'STEP_DEADLINE_MS', 'pollWithin']);
const TIMERS = new Set(['setTimeout', 'setInterval']);

const TERMINATES = new Set(['terminate', 'terminateWorkflowExecution']);
const TIMER_MODULE = /^(node:)?timers(\/promises)?$/;

/** `node` is the name of a property (`o.within`, `{ within: 1 }`), not a reference. */
const isPropertyName = (node: ts.Identifier): boolean => {
  const parent = node.parent;
  return (
    (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
    (ts.isPropertyAssignment(parent) && parent.name === node)
  );
};

/** What in `source` breaks the rule, one entry per occurrence. */
function violations(source: string, file = 'spec.ts'): { rule: Rule; line: number }[] {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const found: { rule: Rule; line: number }[] = [];
  const at = (node: ts.Node, rule: Rule) =>
    found.push({ rule, line: tree.getLineAndCharacterOfPosition(node.getStart()).line + 1 });
  const visit = (node: ts.Node, inCleanUp: boolean): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const first = node.arguments[0];
      if (ts.isIdentifier(callee) && callee.text === 'cleanUp') inCleanUp = true;
      if (ts.isPropertyAccessExpression(callee) && TERMINATES.has(callee.name.text) && !inCleanUp) {
        at(node, 'terminate');
      }
      // `require('node:timers/promises')`, `import('timers')`.
      const loads =
        (ts.isIdentifier(callee) && callee.text === 'require') ||
        callee.kind === ts.SyntaxKind.ImportKeyword;
      if (loads && first && ts.isStringLiteral(first) && TIMER_MODULE.test(first.text)) {
        at(node, 'timer');
      }
    }
    // Called or not (`w.runUntil.bind(w)`, `w['runUntil']`).
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'runUntil') at(node, 'runUntil');
    if (
      ts.isElementAccessExpression(node) &&
      ts.isStringLiteral(node.argumentExpression) &&
      node.argumentExpression.text === 'runUntil'
    ) {
      at(node, 'runUntil');
    }
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      TIMER_MODULE.test(node.moduleSpecifier.text)
    ) {
      at(node, 'timer');
      return; // Its names are this one import.
    }
    if (ts.isIdentifier(node)) {
      // Any reference, called or passed on (`promisify(setTimeout)`), but not
      // `jest.setTimeout`: jest's own budget, not a wait.
      const parent = node.parent;
      const ofJest =
        ts.isPropertyAccessExpression(parent) &&
        parent.name === node &&
        ts.isIdentifier(parent.expression) &&
        parent.expression.text === 'jest';
      // The name a destructuring reads (`{ setTimeout: wait } = …`): the load is the finding.
      const readName = ts.isBindingElement(parent) && parent.propertyName === node;
      if (TIMERS.has(node.text) && !ofJest && !readName) at(node, 'timer');
      if (REMOVED_HELPERS.has(node.text) && !isPropertyName(node)) at(node, 'removed helper');
    }
    ts.forEachChild(node, (child) => visit(child, inCleanUp));
  };
  visit(tree, false);
  return found;
}

/** Where `found` is off its pin, in either direction: one more fails, and so does one fewer. */
function offPin(
  file: string,
  found: { rule: Rule; line: number }[],
  pinned: Partial<Record<Rule, number>>,
): string[] {
  return RULES.flatMap((rule) => {
    const lines = found.filter((v) => v.rule === rule).map((v) => v.line);
    const allowed = pinned[rule] ?? 0;
    return lines.length === allowed
      ? []
      : [`${file}: ${rule} ${lines.length} (pinned ${allowed}) at ${lines.join(', ')}`];
  });
}

/** The authored specs under `dir`, through the repository's one lister (FU-102). */
const specs = (dir: string): string[] =>
  authoredFiles(dir).filter((path) => /\.(int-)?spec\.ts$/.test(path));

/**
 * It starts a Temporal test server or a real worker: what the rule is about.
 * Read off the code, not its comments, and by what it imports, so an alias
 * (`Worker as W`) does not hide it. A file that replaces `@temporalio/worker`
 * with a mock (`jest.mock`) runs no real worker, unless it starts a server too.
 */
function drivesSagas(source: string): boolean {
  const tree = ts.createSourceFile('spec.ts', source, ts.ScriptTarget.Latest, true);
  let server = false;
  let worker = false;
  let mocked = false;
  const visit = (node: ts.Node): void => {
    const from =
      ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)
        ? node.moduleSpecifier.text
        : ts.isCallExpression(node) &&
            ts.isIdentifier(node.expression) &&
            node.expression.text === 'require' &&
            node.arguments[0] !== undefined &&
            ts.isStringLiteral(node.arguments[0])
          ? node.arguments[0].text
          : undefined;
    if (from !== undefined && SERVERS.test(from)) server = true;
    if (from === '@temporalio/worker') worker = true;
    if (ts.isIdentifier(node) && SERVER_NAMES.has(node.text)) server = true;
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const { expression: owner, name } = node.expression;
      const first = node.arguments[0];
      if (ts.isIdentifier(owner) && owner.text === 'Worker' && name.text === 'create') {
        worker = true;
      }
      if (
        ts.isIdentifier(owner) &&
        owner.text === 'jest' &&
        name.text === 'mock' &&
        first !== undefined &&
        ts.isStringLiteral(first) &&
        first.text === '@temporalio/worker'
      ) {
        mocked = true;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return server || (worker && !mocked);
}
/** This package's helper that starts a test server (the SDK's module also has mocks). */
const SERVERS = /(^|\/)temporal-environment$/;
const SERVER_NAMES = new Set(['createTemporalTestEnvironment', 'TestWorkflowEnvironment']);

describe('saga specs run their workers on the harness (FU-214)', () => {
  const governed = [...specs(join(PACKAGE, 'src')), ...specs(join(PACKAGE, 'test'))]
    .map((path) => ({ path, file: relative(PACKAGE, path).split('\\').join('/') }))
    .filter(({ path }) => drivesSagas(readFileSync(path, 'utf8')))
    .filter(({ file }) => file !== 'src/temporal/saga-test-harness.guard.spec.ts');

  it('finds the files it is about', () => {
    const files = governed.map(({ file }) => file);
    expect(files).toEqual(
      expect.arrayContaining([
        'src/temporal/workflows.spec.ts',
        'src/temporal/workflows-rollover.spec.ts',
        'src/temporal/workflows-hold-exit.spec.ts',
        'src/temporal/workflows-hold-row.spec.ts',
        ...Object.keys(PINNED),
      ]),
    );
  });

  it('no spec waits on a timer, calls runUntil, terminates outside cleanUp, or uses a removed helper beyond its pin', () => {
    const wrong = governed.flatMap(({ path, file }) =>
      offPin(file, violations(readFileSync(path, 'utf8'), file), PINNED[file] ?? {}),
    );
    expect(wrong).toEqual([]);
  });

  describe('what it refuses', () => {
    const rules = (source: string) => violations(source).map((v) => v.rule);

    it('the form #812 brought back: a worker run raced against a step timer', () => {
      expect(
        rules('await before.runUntil(within(STEP_DEADLINE_MS, handle.result(), "x"));'),
      ).toEqual(['runUntil', 'removed helper', 'removed helper']);
    });

    it('a raw runUntil on any receiver, called or not', () => {
      expect(rules('await running.runUntil(async () => body());')).toEqual(['runUntil']);
      expect(rules("await w['runUntil'](f); const run = w.runUntil.bind(w);")).toEqual([
        'runUntil',
        'runUntil',
      ]);
    });

    it('wall-clock timers, a timer import, and a poll with a count of pauses', () => {
      expect(
        rules(`
          import { setTimeout as sleep } from 'node:timers/promises';
          for (let i = 0; i < 800; i += 1) await new Promise((r) => setTimeout(r, 25));
          const t = setInterval(tick, 10);
          globalThis.setTimeout(tick, 1);
          const pause = promisify(setTimeout);
          const { setTimeout: wait } = require('node:timers/promises');
        `),
      ).toEqual(['timer', 'timer', 'timer', 'timer', 'timer', 'timer']);
      // No timer name to see: only the import says it.
      expect(rules("import * as timers from 'node:timers/promises';")).toEqual(['timer']);
    });

    it('a removed helper by name, declared or called, but not a property of that name', () => {
      expect(rules('const pollWithin = 1; async function within() {}')).toEqual([
        'removed helper',
        'removed helper',
      ]);
      expect(rules('const o = { within: 1 }; o.within;')).toEqual([]);
    });

    it('governs a file by its code: a server or a real worker, not a mock or a comment', () => {
      expect(drivesSagas('const env = await createTemporalTestEnvironment();')).toBe(true);
      expect(drivesSagas('const w = await Worker.create({ taskQueue });')).toBe(true);
      expect(drivesSagas('// Worker.create() and TestWorkflowEnvironment, in prose')).toBe(false);
      expect(
        drivesSagas("jest.mock('@temporalio/worker', () => ({})); await Worker.create({});"),
      ).toBe(false);
      // By what it imports: an alias does not hide it, nor a mock a real server.
      expect(drivesSagas("import { Worker as W } from '@temporalio/worker';")).toBe(true);
      expect(drivesSagas("import { makeEnv } from '../../test/temporal-environment';")).toBe(true);
      expect(
        drivesSagas(
          "import { TestWorkflowEnvironment as T } from '@temporalio/testing'; jest.mock('@temporalio/worker');",
        ),
      ).toBe(true);
      // The SDK's mocks are not a server.
      expect(drivesSagas("import { MockActivityEnvironment } from '@temporalio/testing';")).toBe(
        false,
      );
    });

    it('a terminate, unless it runs under cleanUp', () => {
      expect(
        rules(`
          try { await body(); } finally { await handle.terminate().catch(() => undefined); }
          await cleanUp(env.client.connection, () => handle.terminate());
          await cleanUp(connection, async () => { await latest.terminate('test finished'); });
          await service.terminateWorkflowExecution({ namespace });
        `),
      ).toEqual(['terminate', 'terminate']);
    });

    it('a pinned file is held to its exact count: one more fails, and so does one fewer', () => {
      const found = violations('await w.runUntil(a); await w.runUntil(b);');
      expect(offPin('f.ts', found, { runUntil: 2 })).toEqual([]);
      expect(offPin('f.ts', found, { runUntil: 3 })).toEqual([
        'f.ts: runUntil 2 (pinned 3) at 1, 1',
      ]);
      expect(offPin('f.ts', found, { runUntil: 1 })).toHaveLength(1);
      expect(offPin('f.ts', found, {})).toHaveLength(1);
    });

    it('not jest’s own timeout, a comment, or a string', () => {
      expect(
        rules(`
          jest.setTimeout(150_000);
          // before.runUntil(within(STEP_DEADLINE_MS, p))
          const note = 'setTimeout(resolve, 10) and runUntil';
        `),
      ).toEqual([]);
    });
  });
});
