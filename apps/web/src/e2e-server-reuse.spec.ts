/**
 * @jest-environment node
 */
import childProcess, { spawn, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import net, { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { OWNED_MARKER, serverStart } from '../e2e/server-reuse';

/**
 * TASK 325 (review of #675): the suite starts its servers through `e2e/own-server.mjs`, which says
 * "ready" only while the server it launched is the sole holder of the port. These tests run the real
 * launcher against real sockets (it needs Linux `ss` and `ps`, as CI and rasta-dev have).
 */

const WEB = join(__dirname, '..');
const LAUNCHER = join(WEB, 'e2e', 'own-server.mjs');

const work = mkdtempSync(join(tmpdir(), 'own-server-spec-'));
const held: Server[] = [];
const launched: ChildProcess[] = [];

afterEach(async () => {
  // The whole group: a killed launcher would leave its server behind.
  for (const child of launched.splice(0)) {
    try {
      process.kill(-child.pid!, 'SIGKILL');
    } catch {
      // already gone
    }
  }
  await Promise.all(
    held.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});
afterAll(() => rmSync(work, { recursive: true, force: true }));

async function until(what: string, check: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** A listener in THIS process: not in the launcher's tree, so a foreign holder. */
async function hold(port: number, host: string): Promise<void> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  held.push(server);
}

async function ipv6Available(): Promise<boolean> {
  try {
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '::1', resolve);
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return true;
  } catch {
    return false;
  }
}

/** The server the launcher starts: records that it ran, optionally waits for a gate, then listens. */
const SERVER = join(work, 'server.cjs');
writeFileSync(
  SERVER,
  `
  const fs = require('node:fs');
  const [port, host, tag] = process.argv.slice(2);
  const file = (name) => ${JSON.stringify(work)} + '/' + tag + '.' + name;
  fs.writeFileSync(file('ran'), String(process.pid));
  const listen = () => {
    const server = require('node:net').createServer();
    server.on('error', () => process.exit(1));
    server.listen(Number(port), host, () => fs.writeFileSync(file('listening'), 'y'));
    setInterval(() => { if (fs.existsSync(file('stop'))) process.exit(0); }, 25);
  };
  const gated = fs.existsSync(file('gate'));
  if (!gated) listen();
  else {
    const wait = setInterval(() => { if (!fs.existsSync(file('gate'))) { clearInterval(wait); listen(); } }, 25);
  }
`,
);

interface Launch {
  child: ChildProcess;
  stdout: () => string;
  stderr: () => string;
  exit: () => number | null | undefined;
  tag: string;
  mark: (name: string) => void;
  has: (name: string) => boolean;
}

let counter = 0;
function launch(port: number, host = '127.0.0.1', opts: { gated?: boolean; path?: string } = {}) {
  const tag = `t${++counter}`;
  const file = (name: string) => join(work, `${tag}.${name}`);
  // A gated server waits for its gate file to disappear: `mark('gate')` is the closed gate.
  if (opts.gated) writeFileSync(file('gate'), '');
  const child = spawn(process.execPath, [LAUNCHER, String(port)], {
    cwd: WEB,
    env: {
      ...process.env,
      ...(opts.path === undefined ? {} : { PATH: opts.path }),
      OWN_SERVER_COMMAND: `"${process.execPath}" "${SERVER}" ${port} ${host} ${tag}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  launched.push(child);
  let out = '';
  let err = '';
  let code: number | null | undefined;
  child.stdout!.on('data', (chunk: Buffer) => (out += chunk.toString()));
  child.stderr!.on('data', (chunk: Buffer) => (err += chunk.toString()));
  child.on('exit', (status) => (code = status));
  const result: Launch = {
    child,
    tag,
    stdout: () => out,
    stderr: () => err,
    exit: () => code,
    mark: (name) => writeFileSync(file(name), ''),
    has: (name) => existsSync(file(name)),
  };
  return result;
}

const READY = (port: number) => `${OWNED_MARKER} ${port}`;
const open = (port: number, host: string) =>
  new Promise<boolean>((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false)); // port still taken ⇒ the server is still alive
    probe.listen(port, host, () => probe.close(() => resolve(true)));
  });

jest.setTimeout(30_000);

describe('own-server.mjs (the suite’s only way to start a server locally)', () => {
  it('says ready only once its own server holds the port, and takes the server down with it', async () => {
    const port = await freePort();
    const run = launch(port);
    await until('the ready line', () => run.stdout().includes(READY(port)));
    expect(run.has('listening')).toBe(true);
    expect(run.exit()).toBeUndefined();
    run.child.kill('SIGTERM');
    await until('the launcher to exit', () => run.exit() !== undefined);
    expect(await open(port, '127.0.0.1')).toBe(true); // the server went down with the launcher
  });

  it('does not say ready while its server has not bound the port yet', async () => {
    const port = await freePort();
    const run = launch(port, '127.0.0.1', { gated: true });
    await until('the server to have been launched', () => run.has('ran'));
    await new Promise((resolve) => setTimeout(resolve, 800)); // several polls with nothing listening
    expect(run.stdout()).not.toContain(OWNED_MARKER);
    rmSync(join(work, `${run.tag}.gate`));
    await until('the ready line', () => run.stdout().includes(READY(port)));
    expect(run.has('listening')).toBe(true);
  });

  // F1: the proof must cover every address the browser can reach, not the first one that answers.
  it.each([['127.0.0.2'], ['::1']])(
    'refuses when a foreign server holds the same port on another address (%s) while ours holds 127.0.0.1',
    async (foreign) => {
      if (foreign === '::1' && !(await ipv6Available())) {
        // No IPv6 loopback on this machine: 127.0.0.2 above is the same rule on a second address.
        return;
      }
      const port = await freePort();
      const run = launch(port, '127.0.0.1', { gated: true });
      await until('the server to have been launched', () => run.has('ran'));
      await hold(port, foreign); // binds after the launcher's own check, before our server binds
      rmSync(join(work, `${run.tag}.gate`));
      await until('the launcher to refuse', () => run.exit() !== undefined);
      expect(run.exit()).toBe(1);
      expect(run.stdout()).not.toContain(OWNED_MARKER);
      expect(run.stderr()).toContain(`port ${port} is held by a server this run did not start`);
      expect(run.stderr()).toContain(`pid ${process.pid}`);
      expect(await open(port, '127.0.0.1')).toBe(true); // our server was taken down too
    },
  );

  // F2, first order: the foreign server is already there when the launch starts.
  it('refuses a port that is already held, names the holder, and never runs the command', async () => {
    const port = await freePort();
    await hold(port, '127.0.0.1');
    const run = launch(port);
    await until('the launcher to refuse', () => run.exit() !== undefined);
    expect(run.exit()).toBe(1);
    expect(run.stderr()).toContain(`port ${port} is held by a server this run did not start`);
    expect(run.stderr()).toContain(`pid ${process.pid}`);
    expect(run.has('ran')).toBe(false);
    expect(run.stdout()).not.toContain(OWNED_MARKER);
  });

  // F2, first order, the window: free at the launcher's check, taken before our server binds.
  it('is not ready when a foreign server wins the bind after the check', async () => {
    const port = await freePort();
    const run = launch(port, '127.0.0.1', { gated: true });
    await until('the server to have been launched', () => run.has('ran'));
    await hold(port, '127.0.0.1');
    rmSync(join(work, `${run.tag}.gate`));
    await until('the launcher to exit', () => run.exit() !== undefined);
    expect(run.exit()).not.toBe(0);
    expect(run.stdout()).not.toContain(OWNED_MARKER);
  });

  // F2, second order: ready, and then our server goes away and a foreign one takes its place.
  it('ends when its server exits, so a replacement cannot inherit the readiness', async () => {
    const port = await freePort();
    const run = launch(port);
    await until('the ready line', () => run.stdout().includes(READY(port)));
    run.mark('stop');
    await until('the launcher to exit', () => run.exit() !== undefined);
    await hold(port, '127.0.0.1');
    expect(run.stdout().match(new RegExp(OWNED_MARKER, 'g'))).toHaveLength(1);
  });

  it('kills its server and fails when a foreign server appears on another address after ready', async () => {
    const port = await freePort();
    const run = launch(port);
    await until('the ready line', () => run.stdout().includes(READY(port)));
    await hold(port, '127.0.0.2');
    await until('the launcher to refuse', () => run.exit() !== undefined);
    expect(run.exit()).toBe(1);
    expect(run.stderr()).toContain(`port ${port} is held by a server this run did not start`);
    expect(await open(port, '127.0.0.1')).toBe(true);
  });

  // Fail closed: what cannot be listed is not proof of a free port or of ownership.
  it('refuses, running nothing, when ss is not there to prove anything', async () => {
    const port = await freePort();
    const run = launch(port, '127.0.0.1', { path: join(work, 'no-such-bin') });
    await until('the launcher to refuse', () => run.exit() !== undefined);
    expect(run.exit()).toBe(1);
    expect(run.stderr()).toContain('could not be read');
    expect(run.has('ran')).toBe(false);
  });

  it('treats a socket whose owner ss cannot show as foreign', async () => {
    const port = await freePort();
    const bin = join(work, `bin-${port}`);
    const fake = join(bin, 'ss');
    mkdirSync(bin);
    writeFileSync(fake, `#!/bin/sh\necho 'LISTEN 0 511 [::1]:${port} [::]:*'\n`, { mode: 0o755 });
    const run = launch(port, '127.0.0.1', { path: `${bin}:/usr/bin:/bin` });
    await until('the launcher to refuse', () => run.exit() !== undefined);
    expect(run.exit()).toBe(1);
    expect(run.stderr()).toContain('a process that could not be identified');
    expect(run.has('ran')).toBe(false);
  });
});

describe('the Playwright config (F3: reloads must not reject this run’s own servers)', () => {
  type Entry = {
    command: string;
    url?: string;
    wait?: { stdout: RegExp };
    reuseExistingServer?: boolean;
    env?: Record<string, string>;
  };

  async function loadConfig(ci: boolean): Promise<{ webServer: Entry[] }> {
    const saved = { CI: process.env.CI, worker: process.env.TEST_WORKER_INDEX };
    if (ci) process.env.CI = '1';
    else delete process.env.CI;
    delete process.env.TEST_WORKER_INDEX; // the UI-mode loader sets none
    try {
      let config: { webServer: Entry[] } | undefined;
      await jest.isolateModulesAsync(async () => {
        // The real package refuses to be required twice in one process.
        jest.doMock('@playwright/test', () => ({
          defineConfig: (value: unknown) => value,
          devices: { 'Desktop Chrome': {}, 'Pixel 5': {} },
        }));
        config = (await import('../playwright.config')).default as unknown as {
          webServer: Entry[];
        };
      });
      return config!;
    } finally {
      if (saved.CI === undefined) delete process.env.CI;
      else process.env.CI = saved.CI;
      if (saved.worker !== undefined) process.env.TEST_WORKER_INDEX = saved.worker;
    }
  }

  it('opens no socket and starts no process while it loads, so a reload sees nothing to refuse', async () => {
    const spies = [
      jest.spyOn(childProcess, 'spawnSync'),
      jest.spyOn(childProcess, 'execFileSync'),
      jest.spyOn(childProcess, 'execSync'),
      jest.spyOn(childProcess, 'spawn'),
      jest.spyOn(net, 'connect'),
      jest.spyOn(net.Socket.prototype, 'connect'),
    ];
    try {
      await expect(loadConfig(false)).resolves.toBeDefined();
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it('never reuses a server, and locally waits for the launcher’s proof instead of a URL', async () => {
    const local = (await loadConfig(false)).webServer;
    expect(local).toHaveLength(3);
    for (const entry of local) {
      expect(entry.reuseExistingServer).toBe(false);
      expect(entry.url).toBeUndefined();
      expect(entry.command).toMatch(/^node e2e\/own-server\.mjs \d+$/);
      expect(entry.env?.OWN_SERVER_COMMAND).toBeTruthy();
      const port = /(\d+)$/.exec(entry.command)![1];
      expect(entry.wait!.stdout.test(`${OWNED_MARKER} ${port}\n`)).toBe(true);
      expect(entry.wait!.stdout.test(`${OWNED_MARKER} ${Number(port) + 1}\n`)).toBe(false);
    }
    expect(local.map((entry) => entry.env!.OWN_SERVER_COMMAND)).toEqual([
      'pnpm run build && pnpm run start',
      'node e2e/layout/mock-gateway.mjs',
      expect.stringMatching(/^pnpm exec next start --port \d+$/),
    ]);
  });

  it('keeps CI as it was: no launcher, the URL poll, no reuse', async () => {
    const ci = (await loadConfig(true)).webServer;
    expect(ci.map((entry) => entry.command)).toEqual([
      'pnpm run start',
      'node e2e/layout/mock-gateway.mjs',
      expect.stringMatching(/^pnpm exec next start --port \d+$/),
    ]);
    for (const entry of ci) {
      expect(entry.reuseExistingServer).toBe(false);
      expect(entry.url).toBeTruthy();
      expect(entry.wait).toBeUndefined();
    }
  });

  it('serverStart refuses reuse in both modes', () => {
    for (const ci of [true, false]) {
      expect(serverStart({ ci, port: 1, command: 'x', url: 'http://localhost:1' })).toMatchObject({
        reuseExistingServer: false,
      });
    }
  });

  it('pins the marker and the command variable the launcher and the config share', () => {
    const launcher = readFileSync(LAUNCHER, 'utf8');
    expect(launcher).toContain(`const MARKER = '${OWNED_MARKER}';`);
    expect(launcher).toContain('process.env.OWN_SERVER_COMMAND');
    expect(
      serverStart({ ci: false, port: 7, command: 'cmd', url: 'u' }).env.OWN_SERVER_COMMAND,
    ).toBe('cmd');
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

  it('lets no config with a webServer reuse a listener or start one outside serverStart', () => {
    const found = configs(root);
    expect(found.map((path) => path.slice(root.length + 1)).sort()).toEqual([
      'apps/web/playwright.config.ts',
      'tests/e2e/playwright.config.ts',
    ]);
    for (const path of found) {
      const text = readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
      if (!/\bwebServer\b/.test(text)) continue;
      expect(text).toContain('...serverStart(');
      expect(text).not.toMatch(/reuseExistingServer\s*:/);
    }
  });
});
