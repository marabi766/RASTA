/**
 * @jest-environment node
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { MANIFEST_PATH } from './test/server-action-manifest';

/**
 * The binding between the coverage check and the build it reads: Node guard, Next's
 * effective configuration, and the receipt the build writes for itself. The modules under
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
  it('writes the receipt right after `next build`, and nothing else is the build', () => {
    // Exactly this: a flag such as --turbopack or --experimental-build-mode generate
    // (which reuses an old BUILD_ID) or a dropped receipt step would break the binding.
    expect(pkg.scripts.build).toBe('next build && node scripts/write-build-receipt.mjs');
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
  const write = (): string[] =>
    runModule(
      `import { writeReceipt } from ${JSON.stringify(url('build-receipt.mjs'))};\nconsole.log(JSON.stringify(writeReceipt(${JSON.stringify(web)})));`,
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

describe("Next's effective configuration (r5 F2)", () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'layout-'));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  interface Case {
    name: string;
    config: string;
    settings?: string;
    env?: Record<string, string | undefined>;
    /** Key names the refusal must name (empty: the layout is supported). */
    refuses: string[];
  }
  const CASES: Case[] = [
    { name: 'the real web config', config: 'REAL', refuses: [] },
    { name: 'the defaults', config: 'export default {};', refuses: [] },
    {
      name: 'a literal distDir',
      config: "export default { distDir: '.next-alt' };",
      refuses: ['distDir'],
    },
    {
      name: 'a computed key (the reviewer’s sequence)',
      config:
        "const nextConfig = {};\nnextConfig['dist' + 'Dir'] = '.next-alt';\nexport default nextConfig;",
      refuses: ['distDir'],
    },
    {
      name: 'an imported settings module',
      config: "import settings from './settings.mjs';\nexport default { ...settings.next };",
      settings: "export default { next: { distDir: 'out' } };",
      refuses: ['distDir'],
    },
    {
      name: 'a spread',
      config:
        "const base = { distDir: 'out' };\nexport default { reactStrictMode: true, ...base };",
      refuses: ['distDir'],
    },
    {
      name: 'a function-form config',
      config:
        "export default (phase) => (phase === 'phase-production-build' ? { distDir: 'out' } : {});",
      refuses: ['distDir'],
    },
    {
      name: 'an environment-dependent config under the build’s NODE_ENV',
      config:
        "export default { distDir: process.env.NODE_ENV === 'production' ? '.next-prod' : '.next' };",
      refuses: ['distDir'],
    },
    {
      name: 'an environment variable',
      config: "export default { distDir: process.env.ALT_DIST_DIR || '.next' };",
      env: { ALT_DIST_DIR: 'elsewhere' },
      refuses: ['distDir'],
    },
    {
      name: 'the same variable unset',
      config: "export default { distDir: process.env.ALT_DIST_DIR || '.next' };",
      refuses: [],
    },
    {
      name: 'a dot-slash spelling',
      config: "export default { distDir: './.next' };",
      refuses: ['distDir'],
    },
    {
      name: 'another tsconfig',
      config: "export default { typescript: { tsconfigPath: 'tsconfig.build.json' } };",
      refuses: ['typescript.tsconfigPath'],
    },
    {
      name: 'the default tsconfig, spelled out',
      config: "export default { typescript: { tsconfigPath: 'tsconfig.json' } };",
      refuses: [],
    },
    {
      name: 'a build that keeps old output',
      config: 'export default { cleanDistDir: false };',
      refuses: ['cleanDistDir'],
    },
    {
      name: 'a config that throws a message with a value',
      config: `throw new Error('${SECRET}');`,
      refuses: ['next config'],
    },
    {
      name: 'a config that prints a value and warns about an unknown key',
      config: `console.log('${SECRET}');\nconsole.error('${SECRET}');\nexport default { unknownKey: '${SECRET}', experimental: { unknownFlag: '${SECRET}' } };`,
      refuses: [],
    },
  ];

  it('is read with the loader Next’s build uses, in the build’s environment, and says only a fixed sentence and a key', () => {
    const real = readFileSync(join(WEB, 'next.config.mjs'), 'utf8');
    const prepared = CASES.map((c, index) => {
      const dir = join(root, `case-${index}`);
      mkdirSync(dir);
      writeFileSync(join(dir, 'package.json'), '{"name":"fixture","version":"0.0.0"}');
      writeFileSync(join(dir, 'next.config.mjs'), c.config === 'REAL' ? real : c.config);
      if (c.config === 'REAL') {
        writeFileSync(
          join(dir, 'upload-limit.cjs'),
          readFileSync(join(WEB, 'upload-limit.cjs'), 'utf8'),
        );
      }
      if (c.settings) writeFileSync(join(dir, 'settings.mjs'), c.settings);
      return { dir, env: c.env ?? {} };
    });
    const code = `
      import { effectiveBuildLayout, layoutProblems } from ${JSON.stringify(url('build-layout.mjs'))};
      const results = [];
      for (const { dir, env } of ${JSON.stringify(prepared)}) {
        const layout = await effectiveBuildLayout(dir, { nextFrom: ${JSON.stringify(WEB)}, env: { ...env, NODE_ENV: undefined } });
        results.push(layoutProblems(layout));
      }
      process.stdout.write(JSON.stringify(results) + '\\n');
    `;
    const { out, stdout, stderr } = runModule(code);
    const results = out as string[][];
    CASES.forEach((c, i) => {
      const keys = results[i].map((line) => line.split(':')[0]);
      expect([c.name, keys]).toEqual([c.name, c.refuses]);
    });
    // Nothing a config printed or threw reaches the output, and no problem line quotes a value.
    expect(stdout.replace(/\n$/, '').split('\n').length).toBe(1);
    expect(stdout + stderr).not.toContain(SECRET);
    expect(JSON.stringify(results)).not.toMatch(/\.next-alt|\.next-prod|elsewhere|out"/);
  });
});
