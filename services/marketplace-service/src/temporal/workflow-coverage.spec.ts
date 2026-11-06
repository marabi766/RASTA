import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  addHits,
  foldDelivery,
  useJestCompilerOptions,
  type CoverageData,
  type FileHits,
} from '../../test/temporal-workflow-coverage';

const hits = (path: string, s: number, f: number, b: number[], hash = 'same'): FileHits => ({
  path,
  hash,
  s: { 0: s },
  f: { 0: f },
  b: { 0: b },
});

describe('workflow bundle coverage (FU-157)', () => {
  describe('wiring', () => {
    const configFile = join(__dirname, '..', '..', 'jest.config.js');
    const SETUP = 'temporal-workflow-coverage.setup.ts';

    const setupFilesFor = (argv: string[]): string[][] => {
      const previous = process.argv;
      process.argv = ['node', 'jest', ...argv];
      try {
        let config!: { projects: { setupFilesAfterEnv: string[] }[] };
        jest.isolateModules(() => (config = jest.requireActual(configFile)));
        return config.projects.map((project) => project.setupFilesAfterEnv);
      } finally {
        process.argv = previous;
      }
    };

    it('measures the bundle in every project when coverage is on', () => {
      for (const argv of [['--coverage'], ['--coverage=true'], ['--collectCoverage']]) {
        for (const files of setupFilesFor(argv)) {
          expect(files.some((file) => file.endsWith(SETUP))).toBe(true);
        }
      }
    });

    it('costs a plain test run nothing', () => {
      for (const argv of [[], ['--coverage=false'], ['--no-coverage']]) {
        for (const files of setupFilesFor(argv)) {
          expect(files.some((file) => file.endsWith(SETUP))).toBe(false);
        }
      }
    });

    it('the gate command turns coverage on and keeps every workflow spec in the run', () => {
      const { scripts } = JSON.parse(
        readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'),
      );
      expect(scripts['test:coverage'].split(' ')).toContain('--coverage');
      expect(scripts['test:coverage']).not.toMatch(
        /testPathIgnorePatterns|temporal|selectProjects/,
      );
    });
  });

  describe('addHits', () => {
    it('adds statements, functions and each branch arm', () => {
      const into = hits('/f.ts', 1, 2, [3, 0]);
      addHits(into, hits('/f.ts', 10, 20, [0, 40]));
      expect(into).toMatchObject({ s: { 0: 11 }, f: { 0: 22 }, b: { 0: [3, 40] } });
    });

    it('refuses counters from code compiled differently', () => {
      const into = hits('/f.ts', 1, 1, [1], 'jest');
      expect(() => addHits(into, hits('/f.ts', 1, 1, [1], 'bundle'))).toThrow(
        /compiled differently/,
      );
      expect(into.s[0]).toBe(1);
    });

    it('refuses counters it cannot identify', () => {
      const into: FileHits = { path: '/f.ts', s: {}, f: {}, b: {} };
      expect(() => addHits(into, { ...into })).toThrow(/compiled differently/);
    });
  });

  describe('foldDelivery', () => {
    it('keeps this service source and drops legacy copies and fixtures', () => {
      const into: CoverageData = {};
      foldDelivery(
        into,
        {
          '/svc/src/temporal/workflows.ts': hits('/svc/src/temporal/workflows.ts', 1, 1, [1]),
          '/tmp/legacy/workflows.ts': hits('/tmp/legacy/workflows.ts', 1, 1, [1]),
          '/svc/src/temporal/.legacy-a1/workflows.ts': hits('/l.ts', 1, 1, [1]),
          '/svc/test/fixtures/x.workflow.ts': hits('/svc/test/fixtures/x.workflow.ts', 1, 1, [1]),
        },
        '/svc/src/',
      );
      expect(Object.keys(into)).toEqual(['/svc/src/temporal/workflows.ts']);
    });

    it('adds up later deliveries rather than keeping each copy', () => {
      const file = '/svc/src/a.ts';
      const into: CoverageData = {};
      foldDelivery(into, { [file]: hits(file, 1, 0, [1, 0]) }, '/svc/src/');
      foldDelivery(into, { [file]: hits(file, 0, 1, [0, 1]) }, '/svc/src/');
      expect(into[file]).toMatchObject({ s: { 0: 1 }, f: { 0: 1 }, b: { 0: [1, 1] } });
    });
  });

  describe('useJestCompilerOptions', () => {
    it("replaces the bundler's compiler options", () => {
      const rule = {
        use: { loader: '/x/swc-loader/index.js', options: { jsc: { target: 'es2017' } } },
      };
      useJestCompilerOptions({ module: { rules: [{ use: { loader: 'other' } }, rule] } }, { a: 1 });
      expect(rule.use.options).toEqual({ a: 1, sourceMap: true });
    });

    it('refuses a bundler without the rule rather than measuring nothing comparable', () => {
      expect(() => useJestCompilerOptions({ module: { rules: [] } })).toThrow(/no swc-loader rule/);
    });
  });
});
