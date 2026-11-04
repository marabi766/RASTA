/**
 * @jest-environment node
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  decideServerStart,
  inspectPort,
  planServerReuse,
  portalProofPath,
  readBuildId,
  readRunMarker,
  runMarkerFile,
  type PortInspection,
  type ServerEntry,
} from '../e2e/server-reuse';

const WEB = join(__dirname, '..');

describe('decideServerStart (TASK 323: fail closed on a port that is already held)', () => {
  const base = { name: 'portal', port: 3200 };

  it('starts the server when nothing is listening', () => {
    expect(decideServerStart({ ...base, occupied: false, occupant: 'nobody', own: false })).toEqual(
      {
        action: 'start',
      },
    );
  });

  it('reuses a listener the run proved is its own', () => {
    expect(
      decideServerStart({ ...base, occupied: true, occupant: 'pid 7 (next start)', own: true }),
    ).toEqual({
      action: 'reuse',
    });
  });

  it('refuses a foreign listener and names the port and the process', () => {
    const decision = decideServerStart({
      ...base,
      occupied: true,
      occupant: 'pid 4242 (node next dev --port 3200)',
      own: false,
    });
    expect(decision.action).toBe('refuse');
    if (decision.action !== 'refuse') return;
    expect(decision.message).toContain('Port 3200');
    expect(decision.message).toContain('pid 4242 (node next dev --port 3200)');
    expect(decision.message).toContain('cannot prove');
  });

  it('refuses a listener nobody could identify', () => {
    const decision = decideServerStart({
      ...base,
      occupied: true,
      occupant: 'a process that could not be identified',
      own: false,
    });
    expect(decision.action).toBe('refuse');
  });
});

describe('portalProofPath', () => {
  const marker = { runId: 'run-1', buildId: 'build-1' };

  it('asks for the manifest of the recorded build when run, marker and disk agree', () => {
    expect(portalProofPath({ runId: 'run-1', marker, buildIdOnDisk: 'build-1' })).toBe(
      '/_next/static/build-1/_buildManifest.js',
    );
  });

  it.each([
    ['no marker', { runId: 'run-1', marker: null, buildIdOnDisk: 'build-1' }],
    ['no build on disk', { runId: 'run-1', marker, buildIdOnDisk: null }],
    [
      'an empty run id',
      { runId: '', marker: { runId: '', buildId: 'build-1' }, buildIdOnDisk: 'build-1' },
    ],
    ['a marker from another run', { runId: 'run-2', marker, buildIdOnDisk: 'build-1' }],
    [
      'a build that was replaced since the marker',
      { runId: 'run-1', marker, buildIdOnDisk: 'build-2' },
    ],
    [
      'an empty recorded build',
      { runId: 'run-1', marker: { runId: 'run-1', buildId: '' }, buildIdOnDisk: '' },
    ],
  ])('offers no proof for %s', (_name, input) => {
    expect(portalProofPath(input)).toBeNull();
  });

  it('keeps a hostile build id inside one path segment', () => {
    const path = portalProofPath({
      runId: 'run-1',
      marker: { runId: 'run-1', buildId: '../x?y' },
      buildIdOnDisk: '../x?y',
    });
    expect(path).toBe('/_next/static/..%2Fx%3Fy/_buildManifest.js');
  });
});

describe('planServerReuse', () => {
  const free: PortInspection = {
    occupied: false,
    occupant: 'nobody',
    status: null,
    controlStatus: null,
  };
  const entries: Record<'portal' | 'gateway', ServerEntry> = {
    portal: { name: 'portal', port: 3200, proofPath: '/_next/static/b/_buildManifest.js' },
    gateway: { name: 'gateway', port: 3291 },
  };
  const inspecting =
    (byPort: Record<number, PortInspection>) =>
    (port: number): PortInspection =>
      byPort[port] ?? free;

  it('starts what is free and reuses nothing', () => {
    expect(planServerReuse(entries, { ci: false, worker: false, inspect: inspecting({}) })).toEqual(
      { portal: false, gateway: false },
    );
  });

  it('reuses the portal only when the listener answers its proof path with 200', () => {
    const own: PortInspection = {
      occupied: true,
      occupant: 'pid 1',
      status: 200,
      controlStatus: 404,
    };
    expect(
      planServerReuse(entries, { ci: false, worker: false, inspect: inspecting({ 3200: own }) }),
    ).toEqual({ portal: true, gateway: false });
  });

  it.each([404, 500, 302, null])(
    'refuses a listener that answered %s to the proof path',
    (status) => {
      const foreign: PortInspection = {
        occupied: true,
        occupant: 'pid 99 (next dev)',
        status,
        controlStatus: 404,
      };
      expect(() =>
        planServerReuse(entries, {
          ci: false,
          worker: false,
          inspect: inspecting({ 3200: foreign }),
        }),
      ).toThrow(/Port 3200 \(portal\).*pid 99 \(next dev\)/);
    },
  );

  it.each([200, 302, 500, null])(
    'refuses a listener that answers the proof path 200 but a path no server has with %s (it says 200 to everything)',
    (controlStatus) => {
      const catchAll: PortInspection = {
        occupied: true,
        occupant: 'pid 8 (spa)',
        status: 200,
        controlStatus,
      };
      expect(() =>
        planServerReuse(entries, {
          ci: false,
          worker: false,
          inspect: inspecting({ 3200: catchAll }),
        }),
      ).toThrow(/Port 3200 \(portal\).*pid 8 \(spa\)/);
    },
  );

  it('refuses a 200 when the run has no proof to ask for (nothing can vouch for the listener)', () => {
    const answers: PortInspection = {
      occupied: true,
      occupant: 'pid 5 (mock)',
      status: 200,
      controlStatus: 404,
    };
    expect(() =>
      planServerReuse(entries, {
        ci: false,
        worker: false,
        inspect: inspecting({ 3291: answers }),
      }),
    ).toThrow(/Port 3291 \(gateway\).*pid 5 \(mock\)/);
    expect(() =>
      planServerReuse(
        { portal: { name: 'portal', port: 3200, proofPath: null } },
        { ci: false, worker: false, inspect: inspecting({ 3200: answers }) },
      ),
    ).toThrow(/Port 3200/);
  });

  it('names every refused port in one error', () => {
    const held = (pid: number): PortInspection => ({
      occupied: true,
      occupant: `pid ${pid}`,
      status: 404,
      controlStatus: 404,
    });
    expect(() =>
      planServerReuse(entries, {
        ci: false,
        worker: false,
        inspect: inspecting({ 3200: held(1), 3291: held(2) }),
      }),
    ).toThrow(/Port 3200[^]*Port 3291/);
  });

  it('leaves CI alone: no inspection, never a reuse, even with an own-looking listener', () => {
    const inspect = jest.fn(() => ({
      occupied: true,
      occupant: 'pid 1',
      status: 200,
      controlStatus: 404,
    }));
    expect(planServerReuse(entries, { ci: true, worker: false, inspect })).toEqual({
      portal: false,
      gateway: false,
    });
    expect(inspect).not.toHaveBeenCalled();
  });

  it('does not inspect or refuse in a worker, which starts no server', () => {
    const inspect = jest.fn(() => ({
      occupied: true,
      occupant: 'pid 1',
      status: 404,
      controlStatus: 404,
    }));
    expect(planServerReuse(entries, { ci: false, worker: true, inspect })).toEqual({
      portal: false,
      gateway: false,
    });
    expect(inspect).not.toHaveBeenCalled();
  });
});

describe('inspectPort against real sockets', () => {
  const children: ChildProcess[] = [];

  /** A server in ANOTHER process: inspectPort blocks this one while it probes. */
  async function listener(
    buildId: string,
    catchAll = false,
  ): Promise<{ port: number; pid: number }> {
    const script = `
      const http = require('node:http');
      const server = http.createServer((req, res) => {
        res.statusCode = ${catchAll} || req.url === '/_next/static/${buildId}/_buildManifest.js' ? 200 : 404;
        res.end('x');
      });
      server.listen(0, '::', () => process.stdout.write(server.address().port + '\\n'));
    `;
    const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
    children.push(child);
    const port = await new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.stdout!.once('data', (chunk: Buffer) => resolve(Number(chunk.toString().trim())));
    });
    return { port, pid: child.pid! };
  }

  afterAll(() => {
    for (const child of children) child.kill();
  });

  it('finds a free port free', async () => {
    const { port } = await listener('b');
    children.pop()!.kill();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(inspectPort(port, null)).toMatchObject({ occupied: false, status: null });
  });

  it('names the process that holds a port, and sees the proof path answer 200 only for its own build', async () => {
    const { port, pid } = await listener('build-own');
    const own = inspectPort(port, '/_next/static/build-own/_buildManifest.js');
    expect(own).toMatchObject({ occupied: true, status: 200 });
    expect(own.occupant).toContain(`pid ${pid}`);
    const foreign = inspectPort(port, '/_next/static/build-other/_buildManifest.js');
    expect(foreign).toMatchObject({ occupied: true, status: 404 });
    expect(inspectPort(port, null)).toMatchObject({ occupied: true, status: null });
  });

  it('refuses end to end: a listener without this run’s build is a thrown, named refusal', async () => {
    const { port, pid } = await listener('someone-elses-build');
    expect(() =>
      planServerReuse(
        { portal: { name: 'portal', port, proofPath: '/_next/static/mine/_buildManifest.js' } },
        { ci: false, worker: false, inspect: inspectPort },
      ),
    ).toThrow(new RegExp(`Port ${port} \\(portal\\).*pid ${pid}`));
  });

  it('treats a probe that fails as an occupied port it cannot name, and refuses', () => {
    // Port 0 is not a port: the probe exits 2. Not knowing is not "free".
    const unknown = inspectPort(0, null);
    expect(unknown.occupied).toBe(true);
    expect(unknown.occupant).toContain('the port probe failed');
    expect(() =>
      planServerReuse(
        { portal: { name: 'portal', port: 0, proofPath: '/_next/static/mine/_buildManifest.js' } },
        { ci: false, worker: false, inspect: inspectPort },
      ),
    ).toThrow(/Port 0 \(portal\).*the port probe failed/);
  });

  it('refuses end to end: a catch-all server that says 200 to every path', async () => {
    const { port, pid } = await listener('mine', true);
    expect(inspectPort(port, '/_next/static/mine/_buildManifest.js')).toMatchObject({
      status: 200,
      controlStatus: 200,
    });
    expect(() =>
      planServerReuse(
        { portal: { name: 'portal', port, proofPath: '/_next/static/mine/_buildManifest.js' } },
        { ci: false, worker: false, inspect: inspectPort },
      ),
    ).toThrow(new RegExp(`Port ${port} \\(portal\\).*pid ${pid}`));
  });

  it('reuses end to end: the listener serves the build this run recorded', async () => {
    const { port } = await listener('mine');
    expect(
      planServerReuse(
        { portal: { name: 'portal', port, proofPath: '/_next/static/mine/_buildManifest.js' } },
        { ci: false, worker: false, inspect: inspectPort },
      ),
    ).toEqual({ portal: true });
  });
});

describe('the run marker', () => {
  let dir: string;
  const cleanup: string[] = [];

  /** A copy of the web package's e2e script in a throwaway package, where it finds its own `.next`. */
  function scratchPackage(buildId: string | null): string {
    dir = mkdtempSync(join(tmpdir(), 'web-server-reuse-'));
    mkdirSync(join(dir, 'e2e'));
    copyFileSync(join(WEB, 'e2e/record-server-run.mjs'), join(dir, 'e2e/record-server-run.mjs'));
    if (buildId !== null) {
      mkdirSync(join(dir, '.next'));
      writeFileSync(join(dir, '.next/BUILD_ID'), buildId);
    }
    return dir;
  }
  const record = (pkg: string, port: string, runId: string | null) =>
    spawnSync(process.execPath, [join(pkg, 'e2e/record-server-run.mjs'), port], {
      encoding: 'utf8',
      env: { ...process.env, WEB_E2E_RUN_ID: runId ?? '' },
    });

  afterEach(() => {
    for (const path of cleanup.splice(0)) rmSync(path, { force: true });
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('is written by the start step where runMarkerFile looks for it, and proves the run', () => {
    const pkg = scratchPackage('build-abc\n');
    cleanup.push(runMarkerFile(pkg, 39321));
    expect(record(pkg, '39321', 'run-xyz').status).toBe(0);
    const marker = readRunMarker(runMarkerFile(pkg, 39321));
    expect(marker).toEqual({ runId: 'run-xyz', buildId: 'build-abc' });
    expect(readBuildId(pkg)).toBe('build-abc');
    expect(
      portalProofPath({ runId: 'run-xyz', marker, buildIdOnDisk: readBuildId(pkg) }),
    ).not.toBeNull();
    // The next run has a new id: the old marker proves nothing for it.
    expect(
      portalProofPath({ runId: 'run-next', marker, buildIdOnDisk: readBuildId(pkg) }),
    ).toBeNull();
  });

  it('keys the marker by worktree and port', () => {
    expect(runMarkerFile('/a/web', 3200)).not.toBe(runMarkerFile('/b/web', 3200));
    expect(runMarkerFile('/a/web', 3200)).not.toBe(runMarkerFile('/a/web', 3201));
  });

  it('refuses without a run id and removes the marker an earlier run left', () => {
    const pkg = scratchPackage('build-abc');
    const file = runMarkerFile(pkg, 39322);
    cleanup.push(file);
    writeFileSync(file, JSON.stringify({ runId: 'old', buildId: 'build-abc' }));
    const result = record(pkg, '39322', null);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('WEB_E2E_RUN_ID');
    expect(readRunMarker(file)).toBeNull();
  });

  it('refuses without a build and writes no marker', () => {
    const pkg = scratchPackage(null);
    const file = runMarkerFile(pkg, 39323);
    cleanup.push(file);
    const result = record(pkg, '39323', 'run-1');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('BUILD_ID');
    expect(readRunMarker(file)).toBeNull();
  });

  it.each([
    ['not json', 'nope'],
    ['not an object', '"x"'],
    ['null', 'null'],
    ['no build id', '{"runId":"r"}'],
    ['a numeric run id', '{"runId":1,"buildId":"b"}'],
  ])('reads %s as no marker', (_name, text) => {
    const pkg = scratchPackage('b');
    const file = join(pkg, 'marker.json');
    writeFileSync(file, text);
    expect(readRunMarker(file)).toBeNull();
  });

  it('reads a missing marker file as no marker', () => {
    expect(readRunMarker(join(tmpdir(), 'web-server-reuse-does-not-exist.json'))).toBeNull();
  });
});

describe('every Playwright config goes through the rule', () => {
  const SKIP = new Set([
    'node_modules',
    '.git',
    '.next',
    'dist',
    'coverage',
    '.turbo',
    'playwright-report',
  ]);
  const root = join(WEB, '../..');

  function configs(dir: string, found: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) configs(path, found);
      else if (/^playwright(?:\.[\w-]+)?\.config\.[cm]?[jt]s$/.test(entry.name)) found.push(path);
    }
    return found;
  }

  it('lets no config with a webServer reuse a listener by anything but planServerReuse', () => {
    const found = configs(root);
    expect(found.map((path) => path.slice(root.length + 1)).sort()).toEqual([
      'apps/web/playwright.config.ts',
      'tests/e2e/playwright.config.ts',
    ]);
    for (const path of found) {
      const text = readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
      if (!/\bwebServer\b/.test(text)) continue;
      expect(text).toContain('planServerReuse');
      for (const use of text.matchAll(/reuseExistingServer\s*:\s*([^,\n]+)/g)) {
        expect(use[1]).toMatch(/^reuse\.\w+$/);
      }
    }
  });

  it("feeds the web config's rule the real CI flag, the worker flag and the real probe, and records the build before it starts", () => {
    const text = readFileSync(join(WEB, 'playwright.config.ts'), 'utf8').replace(
      /\/\*[\s\S]*?\*\/|(?<![:\w])\/\/.*$/gm,
      '',
    );
    expect(text).toContain('ci: Boolean(process.env.CI)');
    expect(text).toContain('worker: process.env.TEST_WORKER_INDEX !== undefined');
    expect(text).toContain('inspect: inspectPort');
    // CI: start only, as before. Locally: build, then record which run built it, then start.
    expect(text).toContain("process.env.CI\n        ? 'pnpm run start'");
    expect(text).toMatch(
      /pnpm run build && node e2e\/record-server-run\.mjs \$\{PORTAL_PORT\} && pnpm run start/,
    );
    // The run id the record step reads is the one the config proved against.
    expect(text).toContain('env: { WEB_E2E_RUN_ID: runId }');
  });
});
