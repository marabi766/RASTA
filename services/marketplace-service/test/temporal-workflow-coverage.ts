import { join, sep } from 'node:path';
import { WorkflowCoverage } from '@temporalio/nyc-test-coverage';
import type { bundleWorkflowCode, Worker, WorkerOptions } from '@temporalio/worker';

/**
 * The one place a workflow spec's Worker gets measured (FU-157).
 *
 * Temporal runs workflow code from a webpack bundle in its own V8 context, where
 * Jest's instrumentation does not reach. `@temporalio/nyc-test-coverage` instruments
 * the bundle and sends the counters out through a sink; this file hands them to Jest.
 *
 * It wraps `@temporalio/worker` for the whole test file rather than asking each spec
 * to call it, so a new spec cannot forget. A spec that mocks the module with its own
 * factory (`worker.shutdown.spec.ts`) replaces the wrapper and starts no real Worker.
 *
 * What the package alone does not cover in this repository, and this file does:
 *
 * - **One set of coordinates.** Istanbul merges by location in the *compiled* file, and
 *   Jest and Temporal compile differently, so a plain merge counts every branch twice
 *   and maps half of them through the wrong source map. The bundle is therefore compiled
 *   with Jest's own SWC options; the same output gives the same coverage hash, which is
 *   checked instead of assumed.
 * - **Bounded memory.** The interceptor sends the whole map on every activation. The
 *   package queues each copy until the end of the file; here they are added up on arrival.
 * - **Only this service's source.** Specs also run temporary legacy copies and test
 *   fixtures, which must not enter the report.
 * - **One bundle per file.** A Worker given `workflowsPath` compiles its own bundle, which
 *   instrumentation makes slower. Each path is bundled once per test file.
 *
 * Whatever cannot be measured fails the test file instead of lowering the number quietly.
 */

const swcOptions: object = jest.requireActual('../../../jest.swc.cjs');

const SOURCE_ROOT = join(__dirname, '..', 'src') + sep;

export interface FileHits {
  path: string;
  hash?: string;
  s: Record<string, number>;
  f: Record<string, number>;
  b: Record<string, number[]>;
}
export type CoverageData = Record<string, FileHits>;
/** Where Istanbul keeps its counters, and where Jest reads them when the file ends. */
type CoverageGlobal = { __coverage__?: CoverageData };

/** Adds the counters of `from` to `into`. Both must come from the same compiled code. */
export function addHits(into: FileHits, from: FileHits): void {
  if (!into.hash || into.hash !== from.hash) {
    throw new Error(
      `Workflow coverage of ${from.path}: the bundle was compiled differently from Jest ` +
        `(hash ${from.hash} against ${into.hash}), so its counters cannot be added.`,
    );
  }
  for (const key of Object.keys(from.s)) into.s[key] = (into.s[key] ?? 0) + (from.s[key] ?? 0);
  for (const key of Object.keys(from.f)) into.f[key] = (into.f[key] ?? 0) + (from.f[key] ?? 0);
  for (const key of Object.keys(from.b)) {
    const hits = (into.b[key] ??= []);
    from.b[key]?.forEach((count, arm) => (hits[arm] = (hits[arm] ?? 0) + count));
  }
}

/**
 * A file the report may count: this service's source, the same files Jest would
 * instrument. Legacy copies sit in `src/temporal/.legacy-*` (they must resolve the same
 * modules) and exist only while their spec runs.
 */
function isServiceSource(file: string, root: string): boolean {
  return (
    file.startsWith(root) &&
    !file
      .slice(root.length)
      .split(sep)
      .some((s) => s.startsWith('.'))
  );
}

/** Folds one sink delivery into `into`, keeping this service's source only. */
export function foldDelivery(into: CoverageData, delivery: CoverageData, root = SOURCE_ROOT): void {
  for (const [file, hits] of Object.entries(delivery)) {
    if (!isServiceSource(file, root)) continue;
    const held = into[file];
    if (held) addHits(held, hits);
    else into[file] = hits;
  }
}

/** Compiles the bundle with Jest's options; a bundler without the rule refuses to run. */
export function useJestCompilerOptions<Config extends { module?: { rules?: unknown[] } }>(
  config: Config,
  options: object = swcOptions,
): Config {
  const rule = config.module?.rules?.find((candidate) =>
    String((candidate as { use?: { loader?: unknown } }).use?.loader).includes('swc-loader'),
  ) as { use: { options?: object } } | undefined;
  if (!rule) throw new Error('Workflow coverage: the Temporal bundler has no swc-loader rule');
  rule.use.options = { ...options, sourceMap: true };
  return config;
}

export function installWorkflowCoverage(): void {
  // The package does nothing unless the global exists, and a spec that loads no
  // instrumented module before its first Worker would otherwise go unmeasured.
  (globalThis as unknown as CoverageGlobal).__coverage__ ??= {};

  const coverage = new WorkflowCoverage();
  const held: CoverageData = {};
  const problems: unknown[] = [];
  let workflowWorkers = 0;
  let deliveries = 0;

  const sinks = {
    coverage: {
      merge: {
        fn: (_info: unknown, delivery: CoverageData) => {
          deliveries += 1;
          // A throw here would only be logged by the Worker.
          try {
            foldDelivery(held, delivery);
          } catch (error) {
            problems.push(error);
          }
        },
        callDuringReplay: false,
      },
    },
  };

  jest.doMock('@temporalio/worker', () => {
    const actual: {
      Worker: typeof Worker;
      bundleWorkflowCode: typeof bundleWorkflowCode;
    } = jest.requireActual('@temporalio/worker');
    const bundles = new Map<string, ReturnType<typeof bundleWorkflowCode>>();
    const bundleOnce = (workflowsPath: string) => {
      let bundle = bundles.get(workflowsPath);
      if (!bundle) {
        bundle = actual.bundleWorkflowCode(
          coverage.augmentBundleOptions({
            workflowsPath,
            webpackConfigHook: (config) => useJestCompilerOptions(config),
          }),
        );
        bundles.set(workflowsPath, bundle);
      }
      return bundle;
    };

    const create = actual.Worker.create.bind(actual.Worker);
    actual.Worker.create = async (options: WorkerOptions) => {
      const { workflowsPath, ...rest } = options;
      if (!workflowsPath && !options.workflowBundle) return create(options);
      if (options.bundlerOptions || options.interceptors?.workflowModules?.length) {
        throw new Error('Workflow coverage: a customised bundle needs handling in this helper');
      }
      workflowWorkers += 1;
      return create({
        ...rest,
        workflowBundle: workflowsPath ? await bundleOnce(workflowsPath) : options.workflowBundle,
        sinks: { ...rest.sinks, ...sinks },
      } as WorkerOptions);
    };

    return {
      ...actual,
      bundleWorkflowCode: (options: Parameters<typeof bundleWorkflowCode>[0]) => {
        if (Object.keys(options).join() !== 'workflowsPath' || !options.workflowsPath) {
          throw new Error('Workflow coverage: a customised bundle needs handling in this helper');
        }
        return bundleOnce(options.workflowsPath);
      },
    };
  });

  // Jest reads the global after the framework finishes, so this is the last moment.
  afterAll(() => {
    if (problems.length > 0) throw problems[0];
    if (workflowWorkers > 0 && deliveries === 0) {
      throw new Error(
        `Workflow coverage: ${workflowWorkers} Worker(s) ran and no counters came back; ` +
          'the measurement is broken, not the workflow.',
      );
    }
    foldDelivery(((globalThis as unknown as CoverageGlobal).__coverage__ ??= {}), held);
  });
}
