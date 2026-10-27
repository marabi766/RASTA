/**
 * @jest-environment node
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  alive,
  LOCK,
  plantApp as plant,
  plantFakeNext,
  runDriver,
  runModule,
  startDriver,
  SCRIPTS,
  url,
  WEB,
  type Result,
} from './test/build-scripts';
import { cleanupFixtures } from './test/build-lifetime';
import { MANIFEST_PATH } from './test/server-action-manifest';

/**
 * The binding between the coverage check and the build it reads: Node guard, the layout the
 * build itself reports, and the receipt the build writes for itself. The build lock, and what
 * happens when a process of the build crashes, is killed or cannot write its report, is in
 * server-action-build-ownership.spec.ts.
 */
const SECRET = 'SECRET-CONFIG-VALUE-MUST-NOT-LEAK';

afterEach(cleanupFixtures);

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

describe('one immutable snapshot for the checker (r3 F1)', () => {
  let web: string;
  const MANIFEST = JSON.stringify({ node: {}, edge: {}, encryptionKey: SECRET });
  const put = (relative: string, text: string): void => {
    mkdirSync(join(web, relative, '..'), { recursive: true });
    writeFileSync(join(web, relative), text);
  };
  beforeEach(() => {
    web = mkdtempSync(join(tmpdir(), 'snapshot-'));
    put('.next/BUILD_ID', 'id-one');
    put('.next/server/server-reference-manifest.json', MANIFEST);
    runModule(
      `import { writeReceipt } from ${JSON.stringify(url('build-receipt.mjs'))};\nwriteReceipt(${JSON.stringify(web)}, { distDir: '.next', tsconfigPath: 'tsconfig.json', cleanDistDir: true });\nconsole.log('null');`,
    );
  });
  afterEach(() => rmSync(web, { recursive: true, force: true }));

  /**
   * Runs `checkedSnapshot` with a reader that, right after the manifest has been read for the
   * hash, replaces the file on disk (and counts the reads): a checker that opens the manifest
   * a second time to parse it would get the replacement.
   */
  const check = (
    swapAfterFirstRead: boolean,
  ): { problems: string[]; manifestText?: string; reads: number } =>
    runModule(`
      import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
      import { checkedSnapshot } from ${JSON.stringify(url('build-receipt.mjs'))};
      let reads = 0;
      const read = (full) => {
        if (!existsSync(full) || !statSync(full).isFile()) return null;
        const bytes = readFileSync(full);
        if (full.endsWith('server-reference-manifest.json')) {
          reads += 1;
          if (${swapAfterFirstRead}) writeFileSync(full, '{"swapped":true}');
        }
        return bytes;
      };
      const result = checkedSnapshot(${JSON.stringify(web)}, { read });
      console.log(JSON.stringify({ ...result, reads }));
    `).out as { problems: string[]; manifestText?: string; reads: number };

  it('reads the manifest once and hands the checker the very bytes it hashed', () => {
    const result = check(false);
    expect(result.problems).toEqual([]);
    expect(result.reads).toBe(1);
    expect(result.manifestText).toBe(MANIFEST);
  });

  it('a manifest swapped right after the hash is still the bytes that were hashed (no reopen)', () => {
    const result = check(true);
    expect(result.reads).toBe(1);
    expect(result.problems).toEqual([]);
    expect(result.manifestText).toBe(MANIFEST);
    expect(result.manifestText).not.toContain('swapped');
  });

  it('a manifest swapped BEFORE the read is refused (hash differs from the receipt)', () => {
    put('.next/server/server-reference-manifest.json', '{"swapped":true}');
    const result = check(false);
    expect(result.manifestText).toBeUndefined();
    expect(result.problems).toEqual([
      expect.stringContaining('not the manifest the receipt was written for'),
    ]);
  });

  it('the checker script opens no artifact itself: it only uses the snapshot', () => {
    const source = readFileSync(join(SCRIPTS, 'check-server-action-coverage.mjs'), 'utf8');
    expect(source).not.toMatch(/readFileSync|readFile\b|MANIFEST_PATH|MANIFEST_FILE|node:fs/);
    expect(source).toMatch(/checkedSnapshot\(webDir\)/);
    expect(source).toMatch(/compiledActions\(\s*snapshot\.manifestText/);
  });

  it('refuses while a build owns the package, before and after the read', () => {
    const ask = (before: boolean, after: boolean): string[] =>
      runModule(`
        import { checkedSnapshot } from ${JSON.stringify(url('build-receipt.mjs'))};
        const answers = [${before}, ${after}];
        const result = checkedSnapshot(${JSON.stringify(web)}, { buildInProgress: () => answers.shift() });
        console.log(JSON.stringify(result.problems));
      `).out as string[];
    expect(ask(false, false)).toEqual([]);
    expect(ask(true, false)).toEqual([expect.stringContaining('a build is running')]);
    expect(ask(false, true)).toEqual([expect.stringContaining('a build is running')]);
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

describe('reading what the build reported (r2 F1, r3 F3, r4 F3)', () => {
  const NONCE = 'n-this';
  const ROOT = 100;
  const CONFIG = {
    kind: 'config',
    outputDir: '/w/.next',
    distDir: '.next',
    tsconfigPath: 'tsconfig.json',
    cleanDistDir: true,
  };
  const rec = (pid: number, extra: object, tid = 0, nonce = NONCE): object => ({
    nonce,
    pid,
    tid,
    ...extra,
  });
  /** One completed loader call: its begin record and its result. */
  const loaded = (pid: number, call = 1, tid = 0, layout: object = CONFIG): object[] => [
    rec(pid, { kind: 'config-begin', call }, tid),
    rec(pid, { ...layout, call }, tid),
  ];
  const ROOT_START = rec(ROOT, { kind: 'start', ppid: 1 });
  const ROOT_CONFIG = loaded(ROOT);
  const keysFor = (text: string | null): string[] => {
    const dir = mkdtempSync(join(tmpdir(), 'capture-'));
    const file = join(dir, 'c.jsonl');
    if (text !== null) writeFileSync(file, text);
    try {
      const { out } = runModule(
        `import { readCapture, layoutProblems } from ${JSON.stringify(url('build-layout.mjs'))};\nconsole.log(JSON.stringify(layoutProblems(readCapture(${JSON.stringify(file)}, { nonce: ${JSON.stringify(NONCE)}, rootPid: ${ROOT} }))));`,
      );
      return (out as string[]).map((line) => line.split(':')[0]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const lines = (...records: Array<object | object[]>): string =>
    records
      .flat()
      .map((r) => JSON.stringify(r))
      .join('\n') + '\n';
  const CHILD = { kind: 'spawn', child: 200, node: true };
  const CHILD_START = rec(200, { kind: 'start', ppid: ROOT });
  const THREAD = { kind: 'spawn', thread: 3, node: true };
  const THREAD_START = rec(ROOT, { kind: 'start', ppid: 1 }, 3);
  it.each([
    ['the build process alone, default layout', lines(ROOT_START, ROOT_CONFIG), []],
    [
      'a worker that started and reported the same layout',
      lines(ROOT_START, ROOT_CONFIG, rec(ROOT, CHILD), CHILD_START, loaded(200)),
      [],
    ],
    [
      'a worker that started and never loaded the config (nothing to disagree with)',
      lines(ROOT_START, ROOT_CONFIG, rec(ROOT, CHILD), CHILD_START),
      [],
    ],
    [
      'a child that is not a Node process (a shell, git) and left no record',
      lines(ROOT_START, ROOT_CONFIG, rec(ROOT, { kind: 'spawn', child: 300, node: false })),
      [],
    ],
    [
      'repeated loads, in the build process and a worker thread, each completed',
      lines(
        ROOT_START,
        ROOT_CONFIG,
        loaded(ROOT, 2),
        rec(ROOT, THREAD),
        THREAD_START,
        loaded(ROOT, 1, 3),
        loaded(ROOT, 2, 3),
      ),
      [],
    ],
    ['no capture file (the build did not report)', null, ['next config']],
    ['an empty capture', '', ['next config']],
    ['a torn line', lines(ROOT_START, ROOT_CONFIG) + '{"distDir"', ['next config']],
    ['the build process never reported its start', lines(ROOT_CONFIG), ['next config']],
    ['no config record at all', lines(ROOT_START), ['next config']],
    [
      'only records of another invocation',
      lines(rec(ROOT, { kind: 'start', ppid: 1 }, 0, 'n-other'), rec(ROOT, CONFIG, 0, 'n-other')),
      ['next config'],
    ],
    [
      'a Node worker the build started that never reported (config replaced NODE_OPTIONS / deleted the capture variable)',
      lines(ROOT_START, ROOT_CONFIG, rec(ROOT, CHILD)),
      ['next config'],
    ],
    [
      'a worker thread the build started that never reported',
      lines(ROOT_START, ROOT_CONFIG, rec(ROOT, THREAD)),
      ['next config'],
    ],
    [
      'a worker started for another invocation does not stand in for this one',
      lines(
        ROOT_START,
        ROOT_CONFIG,
        rec(ROOT, CHILD),
        rec(200, { kind: 'start', ppid: ROOT }, 0, 'n-other'),
      ),
      ['next config'],
    ],
    [
      'a worker thread that reported its start',
      lines(ROOT_START, ROOT_CONFIG, rec(ROOT, THREAD), THREAD_START),
      [],
    ],
    [
      // r4 F3, the reviewer's trigger: the worker's start is there, its config record was lost.
      'a worker that began loading the config and never reported what it got',
      lines(
        ROOT_START,
        ROOT_CONFIG,
        rec(ROOT, CHILD),
        CHILD_START,
        rec(200, { kind: 'config-begin', call: 1 }),
      ),
      ['next config'],
    ],
    [
      'the build process: a second load that began and never reported',
      lines(ROOT_START, ROOT_CONFIG, rec(ROOT, { kind: 'config-begin', call: 2 })),
      ['next config'],
    ],
    [
      'a worker thread: one of two loads unreported',
      lines(
        ROOT_START,
        ROOT_CONFIG,
        rec(ROOT, THREAD),
        THREAD_START,
        loaded(ROOT, 1, 3),
        rec(ROOT, { kind: 'config-begin', call: 2 }, 3),
      ),
      ['next config'],
    ],
    [
      'a config result with no begin (a report out of order or forged)',
      lines(ROOT_START, ROOT_CONFIG, rec(ROOT, { ...CONFIG, call: 2 })),
      ['next config'],
    ],
    [
      'a loader call reported twice',
      lines(ROOT_START, ROOT_CONFIG, rec(ROOT, { ...CONFIG, call: 1 })),
      ['next config'],
    ],
    [
      'a record from a process that never reported its start',
      lines(ROOT_START, ROOT_CONFIG, loaded(200)),
      ['next config'],
    ],
    [
      'the build process loaded nothing, only a worker did',
      lines(ROOT_START, rec(ROOT, CHILD), CHILD_START, loaded(200)),
      ['next config'],
    ],
    [
      'a record of a kind the preload does not write',
      lines(ROOT_START, ROOT_CONFIG, rec(ROOT, { kind: 'end' })),
      ['next config'],
    ],
    [
      'a worker that saw another distDir',
      lines(
        ROOT_START,
        ROOT_CONFIG,
        rec(ROOT, CHILD),
        CHILD_START,
        loaded(200, 1, 0, { ...CONFIG, distDir: '.next-alt', outputDir: '/w/.next-alt' }),
      ),
      ['next config'],
    ],
    [
      'a worker that saw another tsconfig',
      lines(
        ROOT_START,
        ROOT_CONFIG,
        rec(ROOT, CHILD),
        CHILD_START,
        loaded(200, 1, 0, { ...CONFIG, tsconfigPath: 'x.json' }),
      ),
      ['next config'],
    ],
    [
      'a worker that kept old output',
      lines(
        ROOT_START,
        ROOT_CONFIG,
        rec(ROOT, CHILD),
        CHILD_START,
        loaded(200, 1, 0, { ...CONFIG, cleanDistDir: false }),
      ),
      ['next config'],
    ],
  ])('%s', (_name, text, keys) => {
    expect(keysFor(text)).toEqual(keys);
  });

  it('names an unreported load in its own fixed sentence', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'capture-')), 'c.jsonl');
    writeFileSync(
      file,
      lines(ROOT_START, ROOT_CONFIG, rec(ROOT, { kind: 'config-begin', call: 2 })),
    );
    const { out } = runModule(
      `import { readCapture, layoutProblems } from ${JSON.stringify(url('build-layout.mjs'))};\nconsole.log(JSON.stringify(layoutProblems(readCapture(${JSON.stringify(file)}, { nonce: ${JSON.stringify(NONCE)}, rootPid: ${ROOT} }))));`,
    );
    rmSync(join(file, '..'), { recursive: true, force: true });
    expect(out).toEqual([
      'next config: a build process loaded the configuration and never reported what it got; refusing',
    ]);
  });
});

describe('the preload reaches every process and thread the build starts (r3 F3)', () => {
  it('whatever the caller passed: replaced NODE_OPTIONS, deleted capture variables, an empty env, a worker thread', () => {
    const dir = mkdtempSync(join(tmpdir(), 'preload-'));
    const capture = join(dir, 'c.jsonl');
    const script = join(dir, 'parent.cjs');
    writeFileSync(
      script,
      `
      const cp = require('node:child_process');
      const wt = require('node:worker_threads');
      if (process.argv[2] === 'child') process.exit(0);
      if (!wt.isMainThread) return;
      process.env.NODE_OPTIONS = '--max-old-space-size=512';
      delete process.env.RASTA_BUILD_CAPTURE;
      delete process.env.RASTA_BUILD_NONCE;
      cp.fork(__filename, ['child']);
      cp.spawnSync(process.execPath, [__filename, 'child'], { env: {} });
      cp.spawn(process.execPath, [__filename, 'child'], { env: { NODE_OPTIONS: '' } });
      cp.spawn('sh', ['-c', '"' + process.execPath + '" "' + __filename + '" child']);
      new wt.Worker(__filename, { env: {} });
    `,
    );
    try {
      const run = spawnSync(process.execPath, [script], {
        env: {
          ...process.env,
          RASTA_BUILD_CAPTURE: capture,
          RASTA_BUILD_NONCE: 'n-test',
          NODE_OPTIONS: `--require=${JSON.stringify(join(SCRIPTS, 'capture-next-config.cjs'))}`,
        },
        timeout: 30_000,
      });
      expect(run.status).toBe(0);
      // the parent exits before async children necessarily finished their preload
      const deadline = Date.now() + 10_000;
      let records: Array<{
        kind: string;
        pid: number;
        tid: number;
        child?: number;
        thread?: number;
        node?: boolean;
        nonce: string;
      }> = [];
      const read = (): typeof records =>
        existsSync(capture)
          ? readFileSync(capture, 'utf8')
              .split('\n')
              .filter(Boolean)
              .map((l) => JSON.parse(l))
          : [];
      const missing = (): number => {
        records = read();
        const starts = new Set(
          records.filter((r) => r.kind === 'start').map((r) => `${r.pid}:${r.tid}`),
        );
        return records
          .filter((r) => r.kind === 'spawn' && r.node)
          .filter(
            (r) => !starts.has(r.thread !== undefined ? `${r.pid}:${r.thread}` : `${r.child}:0`),
          ).length;
      };
      while (missing() > 0 && Date.now() < deadline)
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
      const spawns = records.filter((r) => r.kind === 'spawn');
      // fork, spawnSync, spawn (empty NODE_OPTIONS), sh, worker thread
      expect(spawns).toHaveLength(5);
      expect(spawns.filter((r) => r.node)).toHaveLength(4);
      expect(missing()).toBe(0);
      expect(records.every((r) => r.nonce === 'n-test')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('where the build wrote (r2 F1)', () => {
  it('accepts the package`s own .next and refuses any other directory it reported', () => {
    const web = mkdtempSync(join(tmpdir(), 'where-'));
    try {
      mkdirSync(join(web, '.next'));
      mkdirSync(join(web, 'other'));
      const ask = (outputDir: string): string[] =>
        runModule(
          `import { outputDirProblems } from ${JSON.stringify(url('build-layout.mjs'))};\nconsole.log(JSON.stringify(outputDirProblems({ captured: true, consistent: true, missing: 0, incomplete: 0, distDir: '.next', cleanDistDir: true, outputDir: ${JSON.stringify(outputDir)} }, ${JSON.stringify(join(web, '.next'))})));`,
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
    /** The production default: the build's output goes to the driver's own stdout/stderr. */
    inherit?: boolean;
    /** Added to the build's environment (`FAULT` names the record the fault preload fails). */
    env?: Record<string, string>;
  }
  // r4 F1: a process the config starts in the build process (not in its workers) that keeps
  // writing into `.next` and records its pid; it never exits by itself.
  const WRITER = `import { spawn } from 'node:child_process';\nif (!process.env.IS_NEXT_WORKER && !globalThis.__writer) {\n  globalThis.__writer = true;\n  spawn(process.execPath, ['-e', ${JSON.stringify(
    "const fs = require('fs'); fs.writeFileSync('writer.pid', String(process.pid)); setInterval(() => { fs.mkdirSync('.next', { recursive: true }); fs.writeFileSync('.next/from-writer', String(Date.now())); }, 100);",
  )}], { stdio: 'ignore' }).unref();\n}\n`;
  let fault: string;
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
      // r3 F3, the reviewer's first trigger: the config replaces NODE_OPTIONS (dropping the
      // preload Next would pass on) and workers pick another tsconfig.
      name: 'nodeOptionsReplaced',
      config: `process.env.NODE_OPTIONS = '--max-old-space-size=2048';\nexport default { typescript: { tsconfigPath: process.env.IS_NEXT_WORKER ? 'tsconfig.build.json' : 'tsconfig.json' } };`,
      stale: true,
    },
    {
      // r3 F3, the second: the capture variables are deleted before workers start.
      name: 'captureDeleted',
      config: `delete process.env.RASTA_BUILD_CAPTURE;\ndelete process.env.RASTA_BUILD_NONCE;\nexport default { typescript: { tsconfigPath: process.env.IS_NEXT_WORKER ? 'tsconfig.build.json' : 'tsconfig.json' } };`,
      stale: true,
    },
    {
      // A Node process the build starts that never gets to report (killed at once).
      name: 'silentChild',
      config: `import { spawn } from 'node:child_process';\nspawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }).kill('SIGKILL');\nexport default {};`,
      stale: true,
    },
    {
      // r3: the production default stdio. The layout values reach the refusal path; none may be printed.
      name: 'secretDistDir',
      config: `export default { distDir: '.next-${SECRET}', generateBuildId: async () => '${SECRET}' };`,
      stale: true,
      inherit: true,
    },
    {
      name: 'failing',
      config: 'export default {};',
      stale: true,
      page: "import x from './does-not-exist';\nexport default function P(){return <p>{x}</p>}",
    },
    {
      // r4 F3, the reviewer's trigger: workers pick another tsconfig, and their config
      // records cannot be written (EIO on the capture file only).
      name: 'workerConfigLost',
      config: `export default { typescript: { tsconfigPath: process.env.IS_NEXT_WORKER ? 'tsconfig.build.json' : 'tsconfig.json' } };`,
      stale: true,
      env: { FAULT: 'config:child:EIO' },
    },
    {
      // r4 addendum B: `next build` exits 0 while a process it started still writes.
      name: 'writerAfterSuccess',
      config: `${WRITER}export default {};`,
      stale: true,
    },
    {
      // r4 F1 (c): the build fails while a process it started still writes.
      name: 'writerAfterFailure',
      config: `${WRITER}export default {};`,
      stale: true,
      page: "import x from './does-not-exist';\nexport default function P(){return <p>{x}</p>}",
    },
  ];
  const dirs: Record<string, string> = {};
  const results: Record<string, Result> = {};
  let root: string;
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'wrapper-'));
    ({ fault } = plantFakeNext(join(root, 'fake')));
    for (const fixture of FIXTURES) {
      dirs[fixture.name] = join(root, fixture.name);
      plant(dirs[fixture.name], fixture.config, fixture.page, fixture.stale);
    }
    const done = await Promise.all(
      FIXTURES.map((f) =>
        runDriver(dirs[f.name], {
          inherit: f.inherit,
          env: f.env && { ...f.env, NODE_OPTIONS: `--require=${JSON.stringify(fault)}` },
        }),
      ),
    );
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

  it.each([
    ['nodeOptionsReplaced', 'the config replaced NODE_OPTIONS before workers started'],
    ['captureDeleted', 'the config deleted the capture variables before workers started'],
  ])('%s (%s): workers are still observed, and their other tsconfig is refused', (name) => {
    const { status, problems } = results[name];
    expect(status).toBe(1);
    expect(problems).toEqual([expect.stringContaining('next config:')]);
    expect(existsSync(join(dirs[name], '.next/server-action-build-receipt.json'))).toBe(false);
    expect(existsSync(join(dirs[name], '.next/stale-marker'))).toBe(false);
  });

  it('a Node process the build started that never reported is refused, with no receipt', () => {
    const { status, problems } = results.silentChild;
    expect(status).toBe(1);
    expect(problems).toEqual([expect.stringContaining('never reported')]);
    expect(existsSync(join(dirs.silentChild, '.next/server-action-build-receipt.json'))).toBe(
      false,
    );
  });

  it('a worker whose config record cannot be written (EIO): the build is stopped and refused, no receipt (r4 F3)', () => {
    const { status, problems } = results.workerConfigLost;
    expect(status).toBe(1);
    expect(problems).toEqual([
      'next config: a build process could not write its report; refusing',
      'build: processes of this build could not be confirmed stopped; the build lock is kept; refusing',
    ]);
    expect(existsSync(join(dirs.workerConfigLost, '.next/server-action-build-receipt.json'))).toBe(
      false,
    );
    expect(existsSync(join(dirs.workerConfigLost, LOCK))).toBe(true);
  });

  it.each([
    ['writerAfterSuccess', 'exited 0'],
    ['writerAfterFailure', 'failed'],
  ])(
    '%s: `next build` %s while a process it started still writes: refused, and that process is gone before the lock is (r4 F1 c, B)',
    (name) => {
      const { status, problems } = results[name];
      expect(status).toBe(1);
      expect(problems).toEqual([
        'next build: a process it started was still running after it exited; refusing',
      ]);
      const writer = Number(readFileSync(join(dirs[name], 'writer.pid'), 'utf8'));
      // The case is not vacuous: the writer did write into `.next` during the build ...
      expect(existsSync(join(dirs[name], '.next/from-writer'))).toBe(true);
      // ... and it was stopped and awaited before the wrapper returned and released the lock.
      expect(alive(writer)).toBe(false);
      expect(existsSync(join(dirs[name], LOCK))).toBe(false);
      expect(existsSync(join(dirs[name], '.next/server-action-build-receipt.json'))).toBe(false);
    },
  );

  it('production default stdio (inherit): layout values reach the refusal and nothing prints them', () => {
    const { status, problems, printed } = results.secretDistDir;
    expect(status).toBe(1);
    expect(problems).toEqual([expect.stringContaining('distDir:')]);
    // The case is not vacuous: the secret really is the distDir the build used ...
    expect(existsSync(join(dirs.secretDistDir, `.next-${SECRET}/BUILD_ID`))).toBe(true);
    // ... our scripts' own output is fixed sentences ...
    expect(JSON.stringify(problems)).not.toContain(SECRET);
    expect(printed).toContain('"status":1');
    // ... and the driver's whole output, with Next's own build log inherited, has no value.
    // (Judgment call, unchanged: the log of `next build` itself is Next's and is not captured or
    // discarded; this config prints nothing, and this case shows our scripts add nothing.)
    expect(printed).not.toContain(SECRET);
  });
});

describe('two invocations in one package (r3 F1: real `next build`)', () => {
  const CONFIG =
    "export default { typescript: { tsconfigPath: process.env.RASTA_TEST_ALT === '1' ? 'tsconfig.build.json' : 'tsconfig.json' } };";
  let root: string;
  const paths = (name: string): { dir: string; pause: string } => ({
    dir: join(root, name),
    pause: join(root, `${name}-pause`),
  });
  const waitFor = async (file: string): Promise<void> => {
    for (let i = 0; i < 2400 && !existsSync(file); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(existsSync(file)).toBe(true);
  };
  const buildId = (dir: string): string => readFileSync(join(dir, '.next/BUILD_ID'), 'utf8').trim();
  const checkReceipt = (dir: string): string[] =>
    runModule(
      `import { receiptProblems } from ${JSON.stringify(url('build-receipt.mjs'))};\nconsole.log(JSON.stringify(receiptProblems(${JSON.stringify(dir)})));`,
    ).out as string[];
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'race-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('the reviewer`s interleaving, B refusing: B cannot replace `.next` while A is paused before its receipt', async () => {
    const { dir, pause } = paths('refuse');
    mkdirSync(pause);
    plant(dir, CONFIG);
    const a = runDriver(dir, { pauseDir: pause });
    await waitFor(join(pause, 'paused'));
    const idWhilePaused = buildId(dir);
    const b = await runDriver(dir, { lockWaitMs: 1500, env: { RASTA_TEST_ALT: '1' } });
    expect(b.status).toBe(1);
    expect(b.problems).toEqual([expect.stringContaining('build lock:')]);
    // B changed nothing: A's output is still there, whole.
    expect(buildId(dir)).toBe(idWhilePaused);
    writeFileSync(join(pause, 'go'), '');
    const resultA = await a;
    expect(resultA).toMatchObject({ status: 0, problems: [] });
    const receipt = JSON.parse(
      readFileSync(join(dir, '.next/server-action-build-receipt.json'), 'utf8'),
    ) as { buildId: string; layout: { tsconfigPath: string } };
    expect(receipt.buildId).toBe(idWhilePaused);
    expect(receipt.layout.tsconfigPath).toBe('tsconfig.json');
    expect(checkReceipt(dir)).toEqual([]);
  }, 280_000);

  it('the same interleaving, B waiting: B runs only after A finished, and no receipt names the wrong build', async () => {
    const { dir, pause } = paths('wait');
    mkdirSync(pause);
    plant(dir, CONFIG);
    const a = runDriver(dir, { pauseDir: pause });
    await waitFor(join(pause, 'paused'));
    const idA = buildId(dir);
    const b = runDriver(dir, { lockWaitMs: 240_000, env: { RASTA_TEST_ALT: '1' } });
    // B is queued behind A; give it time to prove it did not touch `.next`.
    await new Promise((resolve) => setTimeout(resolve, 3000));
    expect(buildId(dir)).toBe(idA);
    writeFileSync(join(pause, 'go'), '');
    const [resultA, resultB] = await Promise.all([a, b]);
    expect(resultA).toMatchObject({ status: 0, problems: [] });
    // B then built with the other tsconfig, which the wrapper refuses: it replaced A's output
    // and left no receipt, so nothing certifies B's artifacts with A's layout.
    expect(resultB.status).toBe(1);
    expect(resultB.problems).toEqual([expect.stringContaining('typescript.tsconfigPath:')]);
    expect(buildId(dir)).not.toBe(idA);
    expect(existsSync(join(dir, '.next/server-action-build-receipt.json'))).toBe(false);
    expect(checkReceipt(dir)).toEqual([expect.stringContaining('receipt.json: missing')]);
  }, 280_000);

  it('the wrapper killed between starting `next build` and publishing it (r4 F1 b): the lock is free at once, and that build never writes', async () => {
    const { dir } = paths('killed');
    plant(dir, 'export default {};');
    const record = join(root, 'killed-child.json');
    const a = await startDriver(dir, {
      afterSpawn: 'kill',
      recordChild: record,
      handshakeMs: 20_000,
    }).done;
    expect(a.signal).toBe('SIGKILL');
    const { pid, capturePath } = JSON.parse(readFileSync(record, 'utf8')) as {
      pid: number;
      capturePath: string;
    };
    // The orphan is alive, waiting for a handshake that cannot come; the lock names a dead
    // wrapper and no group, so nothing is in progress and B takes the package over at once.
    expect(alive(pid)).toBe(true);
    expect(
      runModule(
        `import { buildInProgress } from ${JSON.stringify(url('build-lock.mjs'))};\nconsole.log(JSON.stringify(buildInProgress(${JSON.stringify(dir)})));`,
      ).out,
    ).toBe(false);
    const b = await runDriver(dir, { lockWaitMs: 5_000 });
    expect(b).toMatchObject({ status: 0, problems: [] });
    // A's `next build` never got past the preload: it wrote no record, no output.
    for (let i = 0; i < 300 && alive(pid); i += 1) await new Promise((r) => setTimeout(r, 100));
    expect(alive(pid)).toBe(false);
    expect(existsSync(capturePath)).toBe(false);
    rmSync(join(capturePath, '..'), { recursive: true, force: true });
    expect(checkReceipt(dir)).toEqual([]);
  }, 280_000);
});
