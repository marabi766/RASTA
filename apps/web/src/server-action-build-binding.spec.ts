/**
 * @jest-environment node
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { MANIFEST_PATH } from './test/server-action-manifest';

/**
 * The binding between the coverage check and the build it reads: Node guard, the layout the
 * build itself reports, and the receipt the build writes for itself. The modules under
 * `scripts/` are plain ESM that Jest does not transform, so each case runs them in a
 * child Node and reads one JSON line back.
 */
const WEB = join(__dirname, '..');
const SCRIPTS = join(WEB, 'scripts');
const url = (file: string): string => pathToFileURL(join(SCRIPTS, file)).href;
const SECRET = 'SECRET-CONFIG-VALUE-MUST-NOT-LEAK';

function runModule(code: string): { out: unknown; stdout: string; stderr: string } {
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    encoding: 'utf8',
    cwd: tmpdir(),
    timeout: 120_000,
  });
  const stdout = run.stdout ?? '';
  return {
    out: stdout.trim() === '' ? undefined : JSON.parse(stdout.trim().split('\n').pop() as string),
    stdout,
    stderr: run.stderr ?? '',
  };
}

describe('the build and check scripts', () => {
  const pkg = JSON.parse(readFileSync(join(WEB, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  it('builds only through the wrapper that invalidates, captures and writes the receipt', () => {
    // Exactly this: a bare `next build`, a flag such as --turbopack or
    // --experimental-build-mode generate (which reuses an old BUILD_ID) or a dropped
    // receipt step would break the binding.
    expect(pkg.scripts.build).toBe('node scripts/run-web-build.mjs');
  });
  it('never evaluates the Next configuration itself (r2 F1/F2: no second evaluation to disagree or print)', () => {
    for (const file of readdirSync(SCRIPTS)) {
      const source = readFileSync(join(SCRIPTS, file), 'utf8');
      expect([
        file,
        /loadConfig|next\.config|server\/config/.test(source.replace(/\/\/.*$/gm, '')),
      ]).toEqual(
        // the preload is the one place that names Next's loader: it watches, it does not call it
        [file, file === 'capture-next-config.cjs'],
      );
    }
  });
  it('shows no exception message in the checker', () => {
    const source = readFileSync(join(SCRIPTS, 'check-server-action-coverage.mjs'), 'utf8');
    expect(source).not.toMatch(/error\.message|\.message\b/);
  });
  it('lints the scripts directory too', () => {
    expect(pkg.scripts.lint).toBe('eslint src scripts');
  });
  it('names the manifest the same way in the receipt module and the reader', () => {
    const { out } = runModule(
      `import { MANIFEST_FILE } from ${JSON.stringify(url('build-receipt.mjs'))};\nconsole.log(JSON.stringify(MANIFEST_FILE));`,
    );
    expect(out).toBe(MANIFEST_PATH);
  });
  it('imports no TypeScript statically in the entry: the Node guard runs first', () => {
    const source = readFileSync(join(SCRIPTS, 'check-server-action-coverage.mjs'), 'utf8');
    const staticImports = [...source.matchAll(/^import[^;]*?from\s+'([^']+)';/gms)].map(
      (m) => m[1],
    );
    expect(staticImports.filter((from) => /\.[cm]?tsx?$/.test(from))).toEqual([]);
    expect(source.indexOf('nodeRefusal(process.versions.node)')).toBeLessThan(
      source.indexOf("import('../src/test/"),
    );
  });
});

describe('the Node guard (r5 F3)', () => {
  const cases: Array<[string, boolean]> = [
    ['21.9.0', false],
    ['22.0.0', false],
    ['22.13.1', false],
    ['22.17.9', false],
    ['22.18.0', true],
    ['22.23.3', true],
    ['23.5.0', false],
    ['23.6.0', true],
    ['24.0.0', true],
    ['25.1.0', true],
    ['', false],
    ['garbage', false],
    ['v22.18.0', false],
  ];
  it.each(cases)('Node %s: runs the check = %s', (version, runs) => {
    const { out } = runModule(
      `import { nodeRefusal } from ${JSON.stringify(url('node-guard.mjs'))};\nconsole.log(JSON.stringify(nodeRefusal(${JSON.stringify(version)})));`,
    );
    if (runs) expect(out).toBeNull();
    else expect(out).toEqual(expect.stringContaining('needs Node 22.18 or newer'));
  });

  it('refuses with the sentence on an old Node, before any `.ts` is imported', () => {
    // The real entry, run as Node 22.17 would: the version is faked by a preload and type
    // stripping is switched off, so an import of a `.ts` file before the guard would die with
    // ERR_UNKNOWN_FILE_EXTENSION instead of the refusal.
    const preload = `data:text/javascript,${encodeURIComponent(
      "Object.defineProperty(process.versions, 'node', { value: '22.17.0' });",
    )}`;
    const run = spawnSync(
      process.execPath,
      [
        '--no-experimental-strip-types',
        '--import',
        preload,
        join(SCRIPTS, 'check-server-action-coverage.mjs'),
      ],
      { encoding: 'utf8', cwd: tmpdir(), timeout: 60_000 },
    );
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('needs Node 22.18 or newer');
    expect(run.stderr).not.toContain('ERR_UNKNOWN_FILE_EXTENSION');
  });
});

describe('the receipt (r5 F2)', () => {
  let web: string;
  const ID = 'build-one';
  const MANIFEST = JSON.stringify({ node: {}, edge: {}, encryptionKey: SECRET });
  const put = (relative: string, text: string): void => {
    mkdirSync(join(web, relative, '..'), { recursive: true });
    writeFileSync(join(web, relative), text);
  };
  const receipt = (): { problems: string[]; out: unknown } => {
    const { out } = runModule(
      `import { receiptProblems } from ${JSON.stringify(url('build-receipt.mjs'))};\nconsole.log(JSON.stringify(receiptProblems(${JSON.stringify(web)})));`,
    );
    return { problems: out as string[], out };
  };
  const LAYOUT = { distDir: '.next', tsconfigPath: 'tsconfig.json', cleanDistDir: true };
  const write = (layout: object = LAYOUT): string[] =>
    runModule(
      `import { writeReceipt } from ${JSON.stringify(url('build-receipt.mjs'))};\nconsole.log(JSON.stringify(writeReceipt(${JSON.stringify(web)}, ${JSON.stringify(layout)})));`,
    ).out as string[];
  const finishedBuild = (id = ID, manifest = MANIFEST): void => {
    put('.next/BUILD_ID', id);
    put('.next/server/server-reference-manifest.json', manifest);
    expect(write()).toEqual([]);
  };

  beforeEach(() => {
    web = mkdtempSync(join(tmpdir(), 'receipt-'));
  });
  afterEach(() => rmSync(web, { recursive: true, force: true }));

  it('accepts the artifacts of one finished build', () => {
    finishedBuild();
    expect(receipt().problems).toEqual([]);
  });
  it('refuses when there is no receipt (a build that did not finish, or a restored .next)', () => {
    put('.next/BUILD_ID', ID);
    put('.next/server/server-reference-manifest.json', MANIFEST);
    expect(receipt().problems).toEqual([
      expect.stringContaining('server-action-build-receipt.json: missing'),
    ]);
  });
  it('refuses when BUILD_ID is missing or empty, and writes no receipt for it', () => {
    put('.next/server/server-reference-manifest.json', MANIFEST);
    expect(write()).toEqual([expect.stringContaining('BUILD_ID: missing or empty')]);
    put('.next/BUILD_ID', '  \n');
    expect(write()).toEqual([expect.stringContaining('BUILD_ID: missing or empty')]);
    expect(receipt().problems.length).toBe(1);
  });
  it('refuses a BUILD_ID removed after the receipt was written', () => {
    finishedBuild();
    rmSync(join(web, '.next/BUILD_ID'));
    expect(receipt().problems).toEqual([expect.stringContaining('BUILD_ID: missing or empty')]);
  });
  it('refuses a receipt written by an older build than BUILD_ID', () => {
    finishedBuild('build-one');
    const older = readFileSync(join(web, '.next/server-action-build-receipt.json'), 'utf8');
    put('.next/BUILD_ID', 'build-two');
    put('.next/server-action-build-receipt.json', older);
    expect(receipt().problems).toEqual([expect.stringContaining('written by another build')]);
  });
  it('refuses a manifest replaced after the receipt was written', () => {
    finishedBuild();
    put('.next/server/server-reference-manifest.json', JSON.stringify({ node: { x: 1 } }));
    expect(receipt().problems).toEqual([
      expect.stringContaining('not the manifest the receipt was written for'),
    ]);
  });
  it('refuses a missing manifest and an unreadable or malformed receipt', () => {
    finishedBuild();
    put('.next/server-action-build-receipt.json', '{');
    expect(receipt().problems).toEqual([expect.stringContaining('not valid JSON')]);
    put('.next/server-action-build-receipt.json', '{"version":2}');
    expect(receipt().problems).toEqual([expect.stringContaining('unknown shape')]);
    put(
      '.next/server-action-build-receipt.json',
      '{"version":1,"buildId":"x","manifestSha256":"y"}',
    );
    expect(receipt().problems).toEqual([expect.stringContaining('unknown shape')]);
    finishedBuild();
    rmSync(join(web, '.next/server/server-reference-manifest.json'));
    expect(receipt().problems).toEqual([
      expect.stringContaining('server-reference-manifest.json: missing'),
    ]);
  });
  it('never puts the manifest in a message', () => {
    finishedBuild();
    put('.next/server/server-reference-manifest.json', `{"encryptionKey":"${SECRET}"}`);
    expect(JSON.stringify(receipt().problems)).not.toContain(SECRET);
  });
});

describe('the layout the receipt records (r2 F1)', () => {
  let web: string;
  const put = (relative: string, text: string): void => {
    mkdirSync(join(web, relative, '..'), { recursive: true });
    writeFileSync(join(web, relative), text);
  };
  const recorded = (layout: object): string[] => {
    put('.next/BUILD_ID', 'id');
    put('.next/server/server-reference-manifest.json', '{}');
    runModule(
      `import { writeReceipt } from ${JSON.stringify(url('build-receipt.mjs'))};\nwriteReceipt(${JSON.stringify(web)}, ${JSON.stringify(layout)});\nconsole.log('null');`,
    );
    return (
      runModule(
        `import { receiptProblems } from ${JSON.stringify(url('build-receipt.mjs'))};\nconsole.log(JSON.stringify(receiptProblems(${JSON.stringify(web)})));`,
      ).out as string[]
    ).map((line) => line.split(':')[0]);
  };
  beforeEach(() => {
    web = mkdtempSync(join(tmpdir(), 'recorded-'));
  });
  afterEach(() => rmSync(web, { recursive: true, force: true }));

  it.each([
    [
      'the default layout',
      { distDir: '.next', tsconfigPath: 'tsconfig.json', cleanDistDir: true },
      [],
    ],
    ['no tsconfigPath set', { distDir: '.next', cleanDistDir: true }, []],
    ['another distDir', { distDir: '.next-alt', cleanDistDir: true }, ['distDir']],
    ['a dot-slash distDir', { distDir: './.next', cleanDistDir: true }, ['distDir']],
    [
      'another tsconfig',
      { distDir: '.next', tsconfigPath: 'tsconfig.build.json', cleanDistDir: true },
      ['typescript.tsconfigPath'],
    ],
    ['old output kept', { distDir: '.next', cleanDistDir: false }, ['cleanDistDir']],
    ['no distDir recorded', { cleanDistDir: true }, ['distDir']],
  ])('%s', (_name, layout, keys) => {
    expect(recorded(layout)).toEqual(keys);
  });
});

describe('reading what the build reported (r2 F1)', () => {
  const LINE = {
    outputDir: '/w/.next',
    distDir: '.next',
    tsconfigPath: 'tsconfig.json',
    cleanDistDir: true,
  };
  const keysFor = (text: string | null): string[] => {
    const dir = mkdtempSync(join(tmpdir(), 'capture-'));
    const file = join(dir, 'c.jsonl');
    if (text !== null) writeFileSync(file, text);
    try {
      const { out } = runModule(
        `import { readCapture, layoutProblems } from ${JSON.stringify(url('build-layout.mjs'))};\nconsole.log(JSON.stringify(layoutProblems(readCapture(${JSON.stringify(file)}))));`,
      );
      return (out as string[]).map((line) => line.split(':')[0]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const lines = (...records: object[]): string =>
    records.map((r) => JSON.stringify(r)).join('\n') + '\n';
  it.each([
    ['one record of the default layout', lines(LINE), []],
    ['the same record from a worker too', lines(LINE, LINE), []],
    ['no capture file (the build did not report)', null, ['next config']],
    ['an empty capture', '', ['next config']],
    ['a torn line', '{"distDir"', ['next config']],
    [
      'a worker that saw another distDir',
      lines(LINE, { ...LINE, distDir: '.next-alt', outputDir: '/w/.next-alt' }),
      ['next config'],
    ],
    [
      'a worker that saw another tsconfig',
      lines(LINE, { ...LINE, tsconfigPath: 'x.json' }),
      ['next config'],
    ],
    [
      'a worker that kept old output',
      lines(LINE, { ...LINE, cleanDistDir: false }),
      ['next config'],
    ],
  ])('%s', (_name, text, keys) => {
    expect(keysFor(text)).toEqual(keys);
  });
});

describe('where the build wrote (r2 F1)', () => {
  it('accepts the package`s own .next and refuses any other directory it reported', () => {
    const web = mkdtempSync(join(tmpdir(), 'where-'));
    try {
      mkdirSync(join(web, '.next'));
      mkdirSync(join(web, 'other'));
      const ask = (outputDir: string): string[] =>
        runModule(
          `import { outputDirProblems } from ${JSON.stringify(url('build-layout.mjs'))};\nconsole.log(JSON.stringify(outputDirProblems({ captured: true, consistent: true, distDir: '.next', cleanDistDir: true, outputDir: ${JSON.stringify(outputDir)} }, ${JSON.stringify(join(web, '.next'))})));`,
        ).out as string[];
      expect(ask(join(web, '.next'))).toEqual([]);
      expect(ask(join(web, 'other'))).toEqual([expect.stringContaining('distDir:')]);
      expect(ask(join(web, 'missing'))).toEqual([expect.stringContaining('distDir:')]);
    } finally {
      rmSync(web, { recursive: true, force: true });
    }
  });
});

describe('a receipt can only describe the invocation that wrote it (r2 F1, F2: real `next build`)', () => {
  /**
   * Each case is a real `next build` of a one-page app, run through the wrapper that
   * `pnpm build` is. The keyed configs are the reviewer's: Next's CLI sets
   * NEXT_RUNTIME='nodejs' before it loads the config, a second evaluation does not.
   */
  const KEYED = "process.env.NEXT_RUNTIME === 'nodejs'";
  const CHANNELS = [
    `console.log('${SECRET}')`,
    `console.dir({ secret: '${SECRET}' })`,
    `console.dirxml('${SECRET}')`,
    `console.countReset('${SECRET}')`,
    `process.stdout.write('${SECRET}\\n')`,
    `process.stderr.write('${SECRET}\\n')`,
    `process.emitWarning('${SECRET}')`,
    `setTimeout(() => console.log('${SECRET}'), 50)`,
    `process.on('exit', () => process.stderr.write('${SECRET}\\n'))`,
  ].join(';\n');
  interface Fixture {
    name: string;
    config: string;
    /** Planted before the build: an earlier build's complete, self-consistent artifacts. */
    stale: boolean;
    page?: string;
  }
  const FIXTURES: Fixture[] = [
    { name: 'control', config: 'export default {};', stale: true },
    {
      name: 'distDir',
      config: `const c = {};\nc['dist' + 'Dir'] = ${KEYED} ? '.next-alt' : '.next';\nexport default c;`,
      stale: true,
    },
    {
      name: 'tsconfigPath',
      config: `export default { typescript: { tsconfigPath: ${KEYED} ? 'tsconfig.build.json' : 'tsconfig.json' } };`,
      stale: true,
    },
    {
      name: 'cleanDistDir',
      config: `export default { cleanDistDir: !(${KEYED}) };`,
      stale: true,
    },
    {
      name: 'channels',
      config: `${CHANNELS};\nexport default { generateBuildId: async () => 'fixed' };`,
      stale: true,
    },
    {
      name: 'failing',
      config: 'export default {};',
      stale: true,
      page: "import x from './does-not-exist';\nexport default function P(){return <p>{x}</p>}",
    },
  ];
  interface Result {
    status: number;
    problems: string[];
    printed: string;
  }
  const dirs: Record<string, string> = {};
  const results: Record<string, Result> = {};
  let root: string;
  const DRIVER = (dir: string): string => `
    import { runWebBuild } from ${JSON.stringify(url('build-run.mjs'))};
    const result = runWebBuild(${JSON.stringify(dir)}, { nextFrom: ${JSON.stringify(WEB)}, stdio: 'ignore' });
    process.stdout.write(JSON.stringify(result) + '\\n');
  `;
  const runDriver = (dir: string): Promise<Result> =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', DRIVER(dir)], {
        cwd: tmpdir(),
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => (stdout += chunk));
      child.stderr.on('data', (chunk) => (stderr += chunk));
      child.on('error', reject);
      child.on('close', () => {
        const parsed = JSON.parse(stdout.trim().split('\n').pop() as string) as Omit<
          Result,
          'printed'
        >;
        resolve({ ...parsed, printed: stdout + stderr });
      });
    });

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'wrapper-'));
    for (const fixture of FIXTURES) {
      const dir = join(root, fixture.name);
      dirs[fixture.name] = dir;
      mkdirSync(join(dir, 'app'), { recursive: true });
      writeFileSync(join(dir, 'package.json'), '{"name":"fixture","version":"0.0.0"}');
      symlinkSync(join(WEB, 'node_modules'), join(dir, 'node_modules'));
      writeFileSync(
        join(dir, 'app/layout.jsx'),
        'export default function L({ children }) { return <html><body>{children}</body></html>; }\n',
      );
      writeFileSync(
        join(dir, 'app/page.jsx'),
        fixture.page ?? 'export default function P() { return <p>hi</p>; }\n',
      );
      writeFileSync(join(dir, 'next.config.mjs'), fixture.config);
      if (fixture.stale) {
        // A complete, self-consistent earlier build: BUILD_ID, manifest and a matching receipt.
        mkdirSync(join(dir, '.next/server'), { recursive: true });
        mkdirSync(join(dir, '.next/cache'), { recursive: true });
        writeFileSync(join(dir, '.next/cache/keep'), 'x');
        writeFileSync(join(dir, '.next/stale-marker'), 'x');
        writeFileSync(join(dir, '.next/BUILD_ID'), 'old-build');
        writeFileSync(join(dir, '.next/server/server-reference-manifest.json'), '{"node":{}}');
        runModule(
          `import { writeReceipt } from ${JSON.stringify(url('build-receipt.mjs'))};\nwriteReceipt(${JSON.stringify(dir)}, { distDir: '.next', tsconfigPath: 'tsconfig.json', cleanDistDir: true });\nconsole.log('null');`,
        );
      }
    }
    const done = await Promise.all(FIXTURES.map((f) => runDriver(dirs[f.name])));
    FIXTURES.forEach((f, i) => (results[f.name] = done[i]));
  }, 280_000);
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const receiptProblems = (name: string): string[] =>
    runModule(
      `import { receiptProblems } from ${JSON.stringify(url('build-receipt.mjs'))};\nconsole.log(JSON.stringify(receiptProblems(${JSON.stringify(dirs[name])})));`,
    ).out as string[];

  it('control: a default build is receipted, from its own output only', () => {
    expect(results.control.problems).toEqual([]);
    expect(results.control.status).toBe(0);
    expect(receiptProblems('control')).toEqual([]);
    const receipt = JSON.parse(
      readFileSync(join(dirs.control, '.next/server-action-build-receipt.json'), 'utf8'),
    ) as { buildId: string; layout: unknown };
    expect(receipt.buildId).toBe(readFileSync(join(dirs.control, '.next/BUILD_ID'), 'utf8').trim());
    expect(receipt.buildId).not.toBe('old-build');
    expect(receipt.layout).toEqual({
      distDir: '.next',
      tsconfigPath: 'tsconfig.json',
      cleanDistDir: true,
    });
    // The earlier build's files are gone; Next's own cache is kept.
    expect(existsSync(join(dirs.control, '.next/stale-marker'))).toBe(false);
    expect(existsSync(join(dirs.control, '.next/cache/keep'))).toBe(true);
  });

  it.each([
    ['distDir', 'distDir:'],
    ['tsconfigPath', 'typescript.tsconfigPath:'],
    ['cleanDistDir', 'cleanDistDir:'],
  ])('%s keyed on NEXT_RUNTIME: refused, and the earlier .next is not certified', (name, key) => {
    const { status, problems } = results[name];
    expect(status).toBe(1);
    expect(problems).toEqual([expect.stringContaining(key)]);
    // The retained earlier build no longer exists to be certified.
    expect(existsSync(join(dirs[name], '.next/stale-marker'))).toBe(false);
    expect(existsSync(join(dirs[name], '.next/server-action-build-receipt.json'))).toBe(false);
    expect(receiptProblems(name)).toEqual([expect.stringContaining('receipt.json: missing')]);
  });

  it('the build really went where the keyed config said (the case is not vacuous)', () => {
    expect(existsSync(join(dirs.distDir, '.next-alt/BUILD_ID'))).toBe(true);
    expect(existsSync(join(dirs.distDir, '.next/BUILD_ID'))).toBe(false);
  });

  it('a build that fails leaves no receipt, and the earlier one is gone', () => {
    expect(results.failing.status).not.toBe(0);
    expect(existsSync(join(dirs.failing, '.next/server-action-build-receipt.json'))).toBe(false);
    expect(existsSync(join(dirs.failing, '.next/BUILD_ID'))).toBe(false);
    expect(receiptProblems('failing')).toEqual([expect.stringContaining('receipt.json: missing')]);
  });

  it('config output on every channel (log, dir, dirxml, countReset, stdout, stderr, warning, deferred, at exit) reaches nothing the scripts print', () => {
    expect(results.channels.status).toBe(0);
    expect(results.channels.problems).toEqual([]);
    expect(results.channels.printed).not.toContain(SECRET);
    expect(JSON.stringify(results)).not.toContain(SECRET);
  });
});
