/**
 * @jest-environment node
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
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
  heldWriters,
  HOLD_RELEASE,
  HOLD_SOCKET,
  liveMembers,
  plantFakeApp,
  plantFakeNext,
  releaseAll,
  releaseHold,
  type Plan,
} from './test/build-scripts';
import { ownedProcesses } from './test/owned-processes';

/**
 * The lifetime of a held fake writer (FU-216, follow-up of FU-199). A writer held until its test
 * releases it must end when (a) its owner is gone in ANY way — a zombie the parent has not reaped
 * and a process that reused the pid answer `kill(pid, 0)` as "alive", so the owner is a
 * connection the kernel closes at exit, never a pid — and (b) the test released it, with the
 * release JOINED: `releaseHold` returns only once the writer is gone, so nothing that follows (the
 * `afterAll` that removes the marker) can strand it. Real processes, no fake clocks.
 *
 * The fixture owns its own lifetime too (F1): every process is registered when it is spawned, the
 * owner its parent spawns has a shutdown channel (a file it polls) rather than a saved pid, and the
 * teardown joins everything and REPORTS what it could not.
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
net.createServer((c) => { c.on('error', () => {}); c.on('data', () => {}); c.write('1'); }).listen(path.join(dir, ${JSON.stringify(HOLD_SOCKET)}), () => {
  fs.writeFileSync(path.join(dir, 'owner.pid.tmp'), String(process.pid));
  fs.renameSync(path.join(dir, 'owner.pid.tmp'), path.join(dir, 'owner.pid'));
});
// Slow to end on purpose: only a teardown that JOINS the owner sees it gone when it returns.
let leaving = false;
setInterval(() => {
  if (!leaving && (fs.existsSync(path.join(dir, 'owner-exit')) || !fs.existsSync(dir))) {
    leaving = true;
    setTimeout(() => process.exit(0), 300);
  }
}, 20);`;
// The owner's parent never returns to its event loop, so nothing reaps the owner: it ends a zombie.
const PARENT = `const cp = require('child_process');
const owner = cp.spawn(process.execPath, ['-e', ${JSON.stringify(OWNER)}, process.argv[1]], { stdio: 'ignore' });
// Before anything else can happen, so the fixture knows what to wait for (to observe, never to signal).
const fs = require('fs'), path = require('path');
fs.writeFileSync(path.join(process.argv[1], 'owner.spawned.tmp'), String(owner.pid));
fs.renameSync(path.join(process.argv[1], 'owner.spawned.tmp'), path.join(process.argv[1], 'owner.spawned'));
const gate = new Int32Array(new SharedArrayBuffer(4));
for (let i = 0; i < 1200; i += 1) Atomics.wait(gate, 0, 0, 50);`;

describe('a held fake writer ends with its owner and with its release (FU-216)', () => {
  let root: string;
  let nextFrom: string;
  let n = 0;
  const owned = ownedProcesses();
  const dirs: string[] = [];
  let leftovers = false;
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
    return owned.own(
      spawn(process.execPath, [join(nextFrom, 'node_modules/next/dist/bin/next')], {
        cwd: dir,
        stdio: 'ignore',
      }),
    );
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
  beforeEach(() => owned.afterJoin(() => releaseAll(dirs.splice(0))));
  afterEach(async () => {
    // Joins every process and the held writers; a failure fails THIS case and keeps the root.
    await owned.teardown().catch((error) => {
      leftovers = true;
      throw error;
    });
  });
  afterAll(() => {
    if (leftovers) throw new Error(`${root}: kept, fixture processes were not joined`);
    rmSync(root, { recursive: true, force: true });
  });

  /**
   * The external owner of `dir`: registered with the fixture the moment its parent is spawned, so a
   * case that fails at any later point still ends it — through its shutdown channel (`owner-exit`,
   * or the removal of the directory), never a signal to a saved pid.
   */
  const startOwner = async (dir: string): Promise<{ ownerPid: number; parent: ChildProcess }> => {
    const { child: parent } = owned.own(
      spawn(process.execPath, ['-e', PARENT, dir], { stdio: 'ignore' }),
    );
    const spawnedPid = (): number | undefined => {
      try {
        return Number(readFileSync(join(dir, 'owner.spawned'), 'utf8'));
      } catch {
        return undefined; // not spawned yet (or the parent never got to it)
      }
    };
    const parentSettled = (): boolean => parent.exitCode !== null || parent.signalCode !== null;
    owned.signal(() => {
      try {
        writeFileSync(join(dir, 'owner-exit'), '');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; // dir gone: owner ends
      }
    });
    owned.watch(`the owner in ${dir}`, () => {
      const pid = spawnedPid();
      return pid === undefined ? parentSettled() : liveMembers([pid])[0].length === 0;
    });
    await waitFor(() => existsSync(join(dir, 'owner.pid')));
    return { ownerPid: Number(readFileSync(join(dir, 'owner.pid'), 'utf8')), parent };
  };
  /** An owner that has exited and stays unreaped (`zombie`), or one that is gone altogether. */
  const withOwner = async (
    dir: string,
    how: 'zombie' | 'gone',
  ): Promise<{ ownerPid: number; writer: ReturnType<typeof startWriter> }> => {
    const { ownerPid, parent } = await startOwner(dir);
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

  it('(F1) a case that fails after its owner started (writer readiness times out) leaves no owner, parent or writer running', async () => {
    const dir = app({}, 'external');
    const { ownerPid, parent } = await startOwner(dir);
    plantFakeApp(dir, { holdUntilRelease: true }, 'external');
    const writer = startWriter(dir);
    // The forced readiness timeout: the case fails before it ever writes `owner-exit`.
    await expect(waitFor(() => existsSync(join(dir, 'never-written')), 200)).rejects.toThrow();
    expect(liveMembers([ownerPid])[0]).toEqual([ownerPid]); // it would run on, out of the test's reach
    await owned.teardown(); // what the afterEach hook does for a failed case
    expect(liveMembers([ownerPid])[0]).toEqual([]);
    expect(parent.exitCode !== null || parent.signalCode !== null).toBe(true);
    expect(writer.child.exitCode !== null || writer.child.signalCode !== null).toBe(true);
    expect(heldWriters()).toEqual([]);
  });

  it('(F1) a teardown that cannot prove a process ended REPORTS it, and does not swallow the rest', async () => {
    const dir = app({ holdUntilRelease: true });
    const writer = startWriter(dir);
    await waitFor(() => hasRun(dir, writer));
    const stuck = Object.assign(new EventEmitter(), {
      pid: 0,
      exitCode: null,
      signalCode: null,
      kill: () => true, // a process that does not die
    }) as unknown as ChildProcess;
    owned.own(stuck);
    owned.watch('a stuck owner', () => false);
    owned.watch('an unobservable owner', () => {
      throw new Error('census unreadable');
    });
    owned.afterJoin(() => {
      throw new Error('cleanup refused');
    });
    const failure = await owned.teardown(300).then(
      () => undefined,
      (error: AggregateError) => error,
    );
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure?.errors.map((e: Error) => e.message)).toEqual([
      'a stuck owner: still running 300 ms after its shutdown request',
      'an unobservable owner: census unreadable',
      'process 0: did not exit 300 ms after SIGKILL',
      'cleanup: cleanup refused',
    ]);
    await waitFor(() => writer.child.exitCode !== null || writer.child.signalCode !== null);
    await releaseHold(dir); // the registered writer's own sweep still happens
  });

  it('(F2) a writer connected but not yet accepted by its owner does no work, and the sweep leaves none held', async () => {
    // The owner's event loop is busy: the kernel completes the writer's connect from the backlog while
    // the owner's `connection` callback is still pending. The sweep then runs before that callback.
    const dir = app({ holdUntilRelease: true, unresponsive: 'sync' });
    const writer = startWriter(dir);
    const touched = (): string[] =>
      readdirSync(dir).filter((f) => f.startsWith('connected-') || f.startsWith('ran-'));
    const gate = new Int32Array(new SharedArrayBuffer(4));
    const patience = Date.now() + 30_000;
    while (touched().length === 0 && Date.now() < patience) Atomics.wait(gate, 0, 0, 10);
    expect(touched().length).toBeGreaterThan(0); // the writer is connected at kernel level
    Atomics.wait(gate, 0, 0, 300); // long enough for a writer that did not wait to start its work
    // Same tick, before the pending `connection` callback can run: the end-of-case sweep.
    await releaseHold(dir, { lenient: true });
    expect(readdirSync(dir).filter((f) => f.startsWith('ran-'))).toEqual([]); // no work unregistered
    expect(await endsWithin(writer.exited, 5_000)).toBe(72); // refused, not left running
    expect(heldWriters()).toEqual([]);
  });

  it('(F2) a writer that connects while the sweep joins another is refused, not accepted late', async () => {
    const dir = app({ holdUntilRelease: true });
    const first = startWriter(dir);
    await waitFor(() => hasRun(dir, first)); // registered and working
    const second = startWriter(dir);
    const gate = new Int32Array(new SharedArrayBuffer(4));
    const patience = Date.now() + 30_000;
    const connected = (): boolean =>
      existsSync(join(dir, `connected-${second.child.pid}`)) || hasRun(dir, second);
    while (!connected() && Date.now() < patience) Atomics.wait(gate, 0, 0, 10); // blocks the owner
    Atomics.wait(gate, 0, 0, 300);
    await releaseHold(dir, { lenient: true }); // joins `first`; `second` is accepted only after the fence
    expect(hasRun(dir, second)).toBe(false);
    expect(await endsWithin(second.exited, 5_000)).toBe(72);
    expect(await endsWithin(first.exited, 5_000)).toBe(0);
    expect(heldWriters()).toEqual([]);
  });

  it('a directory planted without a hold is a test bug, unless the end-of-case sweep asks leniently', async () => {
    const dir = app({});
    await expect(releaseHold(dir)).rejects.toThrow(`${dir}: planted without holdUntilRelease`);
    await expect(releaseHold(dir, { lenient: true })).resolves.toBeUndefined();
  });
});
