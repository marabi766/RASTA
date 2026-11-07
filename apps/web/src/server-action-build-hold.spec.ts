/**
 * @jest-environment node
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  alive,
  heldWriters,
  HOLD_RELEASE,
  HOLD_SOCKET,
  liveMembers,
  plantFakeApp,
  plantFakeNext,
  releaseHold,
  type Plan,
} from './test/build-scripts';

/**
 * The lifetime of a held fake writer (FU-216, follow-up of FU-199). A writer held until its test
 * releases it must end when (a) its owner is gone in ANY way — a zombie the parent has not reaped
 * and a process that reused the pid answer `kill(pid, 0)` as "alive", so the owner is a
 * connection the kernel closes at exit, never a pid — and (b) the test released it, with the
 * release JOINED: `releaseHold` returns only once the writer is gone, so nothing that follows (the
 * `afterAll` that removes the marker) can strand it. Real processes, no fake clocks.
 */
jest.setTimeout(60_000);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const waitFor = async (test: () => boolean, ms = 30_000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!test() && Date.now() < deadline) await sleep(25);
  expect(test()).toBe(true);
};

// The owner: a process that serves the hold socket, writes its pid, and exits when told to.
const OWNER = `const net = require('net'), fs = require('fs'), path = require('path');
const dir = process.argv[1];
net.createServer((c) => { c.on('error', () => {}); c.on('data', () => {}); }).listen(path.join(dir, ${JSON.stringify(HOLD_SOCKET)}), () => {
  fs.writeFileSync(path.join(dir, 'owner.pid.tmp'), String(process.pid));
  fs.renameSync(path.join(dir, 'owner.pid.tmp'), path.join(dir, 'owner.pid'));
});
setInterval(() => { if (fs.existsSync(path.join(dir, 'owner-exit'))) process.exit(0); }, 20);`;
// The owner's parent never returns to its event loop, so nothing reaps the owner: it ends a zombie.
const PARENT = `const cp = require('child_process');
cp.spawn(process.execPath, ['-e', ${JSON.stringify(OWNER)}, process.argv[1]], { stdio: 'ignore' });
const gate = new Int32Array(new SharedArrayBuffer(4));
for (let i = 0; i < 1200; i += 1) Atomics.wait(gate, 0, 0, 50);`;

describe('a held fake writer ends with its owner and with its release (FU-216)', () => {
  let root: string;
  let nextFrom: string;
  let n = 0;
  const started: ChildProcess[] = [];
  const dirs: string[] = [];
  const app = (plan: Plan, owner?: 'external'): string => {
    n += 1;
    const dir = join(root, `app-${n}`);
    mkdirSync(dir, { recursive: true });
    dirs.push(dir);
    if (owner) return dir; // planted by the case once its owner is up
    plantFakeApp(dir, plan);
    return dir;
  };
  /** The fake `next` wrote `ran-<pid>`: it connected to its owner and got into its build. */
  const hasRun = (dir: string, writer: { child: ChildProcess }): boolean =>
    existsSync(join(dir, `ran-${writer.child.pid}`));
  /** The writer, started the way the build starts it: `next` in the package directory. */
  const startWriter = (dir: string): { child: ChildProcess; exited: Promise<number | null> } => {
    const child = spawn(process.execPath, [join(nextFrom, 'node_modules/next/dist/bin/next')], {
      cwd: dir,
      stdio: 'ignore',
    });
    started.push(child);
    return { child, exited: new Promise((r) => child.once('exit', (code) => r(code))) };
  };
  const STILL_HELD = 'STILL HELD';
  const endsWithin = (
    exited: Promise<number | null>,
    ms: number,
  ): Promise<number | null | string> => Promise.race([exited, sleep(ms).then(() => STILL_HELD)]);

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'hold-'));
    ({ nextFrom } = plantFakeNext(join(root, 'fake')));
  });
  afterEach(async () => {
    for (const child of started.splice(0)) child.kill('SIGKILL'); // our own handles only
    for (const dir of dirs.splice(0)) await releaseHold(dir, { lenient: true }).catch(() => {});
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  /** An owner that has exited and stays unreaped (`zombie`), or one that is gone altogether. */
  const withOwner = async (
    dir: string,
    how: 'zombie' | 'gone',
  ): Promise<{ ownerPid: number; writer: ReturnType<typeof startWriter> }> => {
    const parent = spawn(process.execPath, ['-e', PARENT, dir], { stdio: 'ignore' });
    started.push(parent);
    await waitFor(() => existsSync(join(dir, 'owner.pid')));
    const ownerPid = Number(readFileSync(join(dir, 'owner.pid'), 'utf8'));
    plantFakeApp(dir, { holdUntilRelease: true }, 'external');
    const writer = startWriter(dir);
    await waitFor(() => hasRun(dir, writer));
    expect(alive(ownerPid)).toBe(true);
    // The owner ends while its writer is held.
    writeFileSync(join(dir, 'owner-exit'), '');
    if (how === 'gone') parent.kill('SIGKILL'); // the owner is reparented and reaped
    await waitFor(() => liveMembers([ownerPid])[0].length === 0); // exited, whatever its state
    if (how === 'zombie')
      expect(alive(ownerPid)).toBe(true); // the signal probe still sees it
    else await waitFor(() => !alive(ownerPid));
    return { ownerPid, writer };
  };
  it('(a) the owner exited and is a ZOMBIE the parent has not reaped: the writer ends (`kill(owner, 0)` still succeeds for it)', async () => {
    const dir = app({}, 'external');
    const { writer } = await withOwner(dir, 'zombie');
    expect(await endsWithin(writer.exited, 5_000)).toBe(72);
  });

  it('(a) control: the owner is gone altogether (reaped): the writer ends', async () => {
    const dir = app({}, 'external');
    const { writer } = await withOwner(dir, 'gone');
    expect(await endsWithin(writer.exited, 5_000)).toBe(72);
  });

  it('(b) releaseHold returns only once the writer is gone, so removing the marker right after cannot strand it', async () => {
    const dir = app({ holdUntilRelease: true });
    const writer = startWriter(dir);
    await waitFor(() => hasRun(dir, writer));
    expect(heldWriters()).toEqual([dir]);
    await releaseHold(dir);
    expect(heldWriters()).toEqual([]); // joined: the writer's end of the channel is closed
    rmSync(join(dir, HOLD_RELEASE), { force: true }); // what the end-of-suite cleanup does next
    expect(await endsWithin(writer.exited, 5_000)).toBe(0); // finished its own way, not held
  });

  it('(b) a writer that cannot be joined is reported, and stays on the held list', async () => {
    // A synchronous busy loop sees neither the release nor the end of its owner.
    const dir = app({ holdUntilRelease: true, unresponsive: 'sync' });
    const writer = startWriter(dir);
    await waitFor(() => existsSync(join(dir, 'unresponsive.ready')));
    await expect(releaseHold(dir, { ms: 300 })).rejects.toThrow(
      `${dir}: writer still held 300 ms after its release`,
    );
    expect(heldWriters()).toEqual([dir]);
    writer.child.kill('SIGKILL'); // our own handle
    await waitFor(() => heldWriters().length === 0);
  });

  it('a writer whose fixture directory was removed ends: nothing is left to hold it for', async () => {
    const dir = app({ holdUntilRelease: true });
    const writer = startWriter(dir);
    await waitFor(() => hasRun(dir, writer));
    rmSync(dir, { recursive: true, force: true }); // its owner is alive and never released it
    expect(await endsWithin(writer.exited, 5_000)).toBe(72);
  });

  it('a case that failed before its writer started releases nothing and a late writer is refused', async () => {
    const dir = app({ holdUntilRelease: true });
    await releaseHold(dir, { lenient: true }); // lenient: no writer ever connected
    const late = startWriter(dir); // started after the owner closed its end
    expect(await endsWithin(late.exited, 5_000)).toBe(72);
  });

  it('a directory planted without a hold is a test bug, unless the end-of-case sweep asks leniently', async () => {
    const dir = app({});
    await expect(releaseHold(dir)).rejects.toThrow(`${dir}: planted without holdUntilRelease`);
    await expect(releaseHold(dir, { lenient: true })).resolves.toBeUndefined();
  });
});
