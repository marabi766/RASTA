/**
 * @jest-environment node
 */
import childProcess, { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  alive,
  CENSUS_TIMEOUT_MS,
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
const fs0 = require('fs'), path0 = require('path');
// Written whole or not at all: the fixture reads it only once it exists.
fs0.writeFileSync(path0.join(process.argv[1], 'parent.pid.tmp'), String(process.pid));
fs0.renameSync(path0.join(process.argv[1], 'parent.pid.tmp'), path0.join(process.argv[1], 'parent.pid'));
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
  let kept = false;
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
  /** The fake `next` reached its owner at kernel level (`connected-`), or already got into its build. */
  const connectedOrRan = (dir: string, writer: { child: ChildProcess }): boolean =>
    existsSync(join(dir, `connected-${writer.child.pid}`)) || hasRun(dir, writer);
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
      kept = true; // a failed case keeps the root; a hook the runner abandons is seen by `unjoined`
      throw error;
    });
  });
  afterAll(() => {
    if (kept || owned.unjoined) throw new Error(`${root}: kept, fixture processes were not joined`);
    rmSync(root, { recursive: true, force: true });
  });

  /**
   * The external owner of `dir`: registered with the fixture the moment its parent is spawned, so a
   * case that fails at any later point still ends it — through its shutdown channel (`owner-exit`,
   * or the removal of the directory), never a signal to a saved pid.
   */
  const startOwner = async (
    dir: string,
    readyMs?: number,
  ): Promise<{ ownerPid: number; parent: ChildProcess }> => {
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
    await waitFor(() => existsSync(join(dir, 'owner.pid')), readyMs);
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

  it('(F1) a setup that fails while it waits for its owner leaves no parent running', async () => {
    const dir = app({}, 'external');
    mkdirSync(join(dir, 'owner.pid.tmp')); // the owner cannot write its pid: setup fails at the wait
    await expect(startOwner(dir, 300)).rejects.toThrow();
    await waitFor(() => existsSync(join(dir, 'parent.pid')));
    const parentPid = Number(readFileSync(join(dir, 'parent.pid'), 'utf8'));
    expect(liveMembers([parentPid])[0]).toEqual([parentPid]); // it would run on, out of reach
    await owned.teardown();
    expect(liveMembers([parentPid])[0]).toEqual([]);
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
    // A real process that dies when killed, in the SAME failing teardown: a failure elsewhere must
    // not stop it from being killed (it would run for a minute otherwise).
    const sleeper = spawn('sleep', ['60'], { stdio: 'ignore' });
    try {
      const failing = ownedProcesses(); // a failed teardown leaves its instance unjoined for good
      failing.own(stuck);
      const { exited } = failing.own(sleeper);
      failing.watch('a stuck owner', () => false);
      failing.watch('an unobservable owner', () => {
        throw new Error('census unreadable');
      });
      failing.afterJoin(() => {
        throw new Error('cleanup refused');
      });
      const failure = await failing.teardown(300).then(
        () => undefined,
        (error: AggregateError) => error,
      );
      expect(failure).toBeInstanceOf(AggregateError);
      expect(failure?.errors.map((e: Error) => e.message)).toEqual([
        'a stuck owner: still running at the 300 ms deadline (at least 1000 ms after the watches began)',
        'an unobservable owner: census unreadable',
        'process 0: did not exit by the 300 ms deadline (at least 500 ms after the kill)',
        'cleanup: cleanup refused',
      ]);
      expect(await endsWithin(exited, 2_000)).toBe(null); // killed by signal: no exit code
      expect(sleeper.signalCode).toBe('SIGKILL');
    } finally {
      sleeper.kill('SIGKILL'); // our own handle
    }
    await releaseHold(dir); // the registered writer's own sweep still happens
  });

  it('(FU-248) a process census that does not answer is killed at its bound and proves nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'census-'));
    try {
      const ps = join(dir, 'ps');
      writeFileSync(ps, '#!/bin/sh\nexec sleep 30\n', { mode: 0o700 }); // exec: the pid we bound
      const started = Date.now();
      expect(() => liveMembers([process.pid], ps, 300)).toThrow('process census failed');
      expect(Date.now() - started).toBeLessThan(5_000); // unbounded: 30 s
      // The default bound is passed to the real call too.
      expect(CENSUS_TIMEOUT_MS).toBeGreaterThan(0);
      expect(CENSUS_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
      const spy = jest.spyOn(childProcess, 'spawnSync');
      try {
        liveMembers([process.pid]);
        expect(spy.mock.calls[0][2]).toMatchObject({ timeout: CENSUS_TIMEOUT_MS });
      } finally {
        spy.mockRestore();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const stuckChild = (): ChildProcess =>
    Object.assign(new EventEmitter(), {
      pid: 0,
      exitCode: null,
      signalCode: null,
      kill: () => true,
    }) as unknown as ChildProcess;
  const settle = (p: Promise<void>): Promise<AggregateError | undefined> =>
    p.then(
      () => undefined,
      (error: AggregateError) => error,
    );

  /** A fake child that dies when killed, and records (on the clock in force) when it was. */
  const mortalChild = (): ChildProcess & { killed: boolean; killedAt: number } => {
    const child = Object.assign(new EventEmitter(), {
      pid: 0,
      exitCode: null as number | null,
      signalCode: null as string | null,
      killed: false,
      killedAt: 0,
      kill() {
        child.killed = true;
        child.killedAt = Date.now();
        child.signalCode = 'SIGKILL';
        setImmediate(() => child.emit('exit', null));
        return true;
      },
    });
    return child as unknown as ChildProcess & { killed: boolean; killedAt: number };
  };

  /**
   * Every case below is about WHEN the teardown gives up, so it runs on a virtual clock (FU-263):
   * `Date.now()`, `setTimeout` and `setImmediate` are jest's fakes and time moves only when the
   * case advances it. An assertion is then an exact instant, never a margin against how late a
   * starved event loop wakes up — a real-timer `Date.now()` predicate raced the teardown's own
   * timers and lost on loaded CI. Cases with real processes stay above, on real time.
   */
  describe('on a virtual clock', () => {
    beforeEach(() => {
      jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] });
    });
    afterEach(() => {
      jest.useRealTimers(); // before the outer afterEach: its teardown joins real processes
    });
    /** Runs the virtual clock until no timer is left, then the teardown's result. */
    const run = async <T>(pending: Promise<T>): Promise<T> => {
      await jest.runAllTimersAsync();
      return pending;
    };

    it('(FU-232) the whole teardown is capped by its budget: stuck processes cost one budget, leftovers are reported and the cleanup still runs', async () => {
      const local = ownedProcesses();
      for (let i = 0; i < 3; i += 1) local.own(stuckChild());
      local.watch('a stuck owner', () => false);
      let cleaned = false;
      local.afterJoin(() => {
        cleaned = true;
      });
      const started = Date.now();
      const pending = local.teardown(400);
      expect(local.unjoined).toBe(true); // set before anything is awaited
      const failure = await run(settle(pending));
      // The watch grace (1000) then ONE join grace (500); a join per process costs 1000 + 3 x 500.
      expect(Date.now() - started).toBe(1_500);
      expect(failure?.errors).toHaveLength(4);
      expect(cleaned).toBe(true);
      expect(local.unjoined).toBe(true); // a leftover is reported, never dropped
    });

    it('(FU-232 r2) a shutdown request that never settles is inside the same deadline', async () => {
      const local = ownedProcesses();
      local.signal(() => new Promise<void>(() => {}));
      let cleaned = false;
      local.afterJoin(() => {
        cleaned = true;
      });
      const started = Date.now();
      const failure = await run(settle(local.teardown(300)));
      expect(Date.now() - started).toBe(300); // 7105169c: never settles
      expect(failure?.errors.map((e: Error) => e.message)).toEqual([
        'shutdown request: did not finish by the 300 ms deadline',
      ]);
      expect(cleaned).toBe(true);
      expect(local.unjoined).toBe(true);
    });

    it('(FU-232 r2) a teardown that overlaps a running one shares it: it cannot report "joined" first', async () => {
      const local = ownedProcesses();
      local.own(stuckChild());
      local.signal(() => sleep(100)); // keeps the first teardown in flight
      const first = settle(local.teardown(400));
      await jest.advanceTimersByTimeAsync(20); // the first is still in its shutdown requests
      const second = settle(local.teardown());
      expect(local.unjoined).toBe(true);
      const failure = await run(second); // 7105169c: resolves clean while the first still runs
      expect(failure?.errors.map((e: Error) => e.message)).toEqual([
        'process 0: did not exit by the 400 ms deadline (at least 500 ms after the kill)',
      ]);
      expect(await first).toBe(failure);
      expect(local.unjoined).toBe(true);
    });

    it('(FU-232 r2) a clean teardown after a failed one does not clear the leftover flag', async () => {
      const local = ownedProcesses();
      local.own(stuckChild());
      expect(await run(settle(local.teardown(200)))).toBeInstanceOf(AggregateError);
      await run(local.teardown()); // nothing registered any more: the leftover is gone from every list
      expect(local.unjoined).toBe(true); // 7105169c: false, the leftover pid is forgotten
    });

    it('(FU-248 F2) the join budget is the one deadline, not a second budget per process', async () => {
      // ms=400 cannot tell: the 500 ms join grace is longer than a second budget there.
      const local = ownedProcesses();
      for (let i = 0; i < 3; i += 1) local.own(stuckChild());
      local.watch('a stuck owner', () => false);
      const started = Date.now();
      const failure = await run(settle(local.teardown(2_000)));
      expect(failure?.errors).toHaveLength(4);
      // 2000 (watch) + 500 (join grace); a per-process `sleep(ms)` join costs 2000 + 2000.
      expect(Date.now() - started).toBe(2_500);
    });

    it('(FU-248 F4) the cleanup message names the real bound, not "within ms"', async () => {
      const local = ownedProcesses();
      local.afterJoin(() => new Promise<void>(() => {}));
      const failure = await run(settle(local.teardown(100)));
      expect(failure?.errors.map((e: Error) => e.message)).toEqual([
        'cleanup: not finished by the 100 ms deadline (at least 1000 ms after the cleanup began)',
      ]);
    });

    it.each([
      [
        'is already spent',
        (): Promise<void> => new Promise<void>(() => {}), // cut off at the 100 ms deadline
        ['shutdown request: did not finish by the 100 ms deadline'],
      ],
      // FU-263: 1 ms left is what a real timer armed for the deadline leaves ~1 % of the time. A
      // watch that ended with the deadline polled once there and gave up its owner.
      ['has 1 ms left', (): Promise<void> => sleep(99), []],
    ])(
      '(FU-248, FU-263) a watched owner is not given up after one poll when the deadline %s',
      async (_when, request, expected) => {
        const local = ownedProcesses();
        const parent = mortalChild();
        local.own(parent);
        local.signal(request);
        const endsAt = Date.now() + 400; // the owner ends 300 ms after the budget
        local.watch('a slow owner', () => Date.now() >= endsAt);
        const failure = await run(settle(local.teardown(100)));
        expect(failure?.errors.map((e: Error) => e.message) ?? []).toEqual(expected); // no watch failure
        // Its parent was killed at the first poll that saw it end (polls every 25 ms), not before.
        expect(parent.killedAt - endsAt).toBeGreaterThanOrEqual(0);
        expect(parent.killedAt - endsAt).toBeLessThan(25);
      },
    );

    it('(FU-263) a watch that never sees its owner end is reported at its own floor, whatever the deadline left', async () => {
      const local = ownedProcesses();
      local.signal(() => sleep(99));
      local.watch('a stuck owner', () => false);
      const started = Date.now();
      const failure = await run(settle(local.teardown(100)));
      expect(failure?.errors.map((e: Error) => e.message)).toEqual([
        'a stuck owner: still running at the 100 ms deadline (at least 1000 ms after the watches began)',
      ]);
      expect(Date.now() - started).toBe(99 + 1_000);
    });

    it('(FU-263) a wall-clock step (NTP) neither spends nor stretches the budget: the teardown runs on a monotonic clock', async () => {
      const local = ownedProcesses();
      local.watch('a stuck owner', () => false);
      const started = performance.now();
      const pending = settle(local.teardown(2_000));
      await jest.advanceTimersByTimeAsync(100);
      jest.setSystemTime(Date.now() + 3_600_000); // the wall clock jumps an hour ahead
      const failure = await run(pending);
      expect(failure?.errors).toHaveLength(1);
      expect(performance.now() - started).toBe(2_000); // `Date.now()`: given up at 100 ms
    });

    it('(FU-252 N1a) a call that arrives mid-run is covered by the same teardown, including what registers after it began', async () => {
      const local = ownedProcesses();
      local.afterJoin(() => sleep(150)); // keeps the first run in its cleanup phase
      const first = settle(local.teardown());
      await jest.advanceTimersByTimeAsync(30); // the first run has already collected its lists
      const late = mortalChild();
      local.own(late);
      let requested = false;
      local.signal(() => void (requested = true));
      let polled = false;
      local.watch('a late owner', () => (polled = true));
      let cleaned = false;
      local.afterJoin(() => void (cleaned = true));
      const second = settle(local.teardown());
      expect(local.unjoined).toBe(true);
      expect(await run(second)).toBeUndefined();
      expect(await first).toBeUndefined();
      // Every kind of late registration was handled before either caller was told "joined".
      expect([late.killed, requested, polled, cleaned]).toEqual([true, true, true, true]);
      expect(local.unjoined).toBe(false);
    });

    it('(FU-252 N1a) a failure in an earlier round stays when a later round is clean', async () => {
      const local = ownedProcesses();
      local.own(stuckChild());
      local.afterJoin(() => sleep(50));
      const first = settle(local.teardown(300));
      await jest.advanceTimersByTimeAsync(20); // inside the join of the stuck child
      local.own(mortalChild());
      const failure = await run(first);
      expect(failure?.errors.map((e: Error) => e.message)).toEqual([
        'process 0: did not exit by the 300 ms deadline (at least 500 ms after the kill)',
      ]);
      expect(await run(settle(local.teardown()))).toBeUndefined(); // nothing left to join,
      expect(local.unjoined).toBe(true); // yet the failure is never forgotten
    });

    it.each([
      ['a child', (o: ReturnType<typeof ownedProcesses>) => o.own(mortalChild())],
      ['a shutdown request', (o: ReturnType<typeof ownedProcesses>) => o.signal(() => {})],
      ['a watch', (o: ReturnType<typeof ownedProcesses>) => o.watch('late', () => true)],
      ['a cleanup step', (o: ReturnType<typeof ownedProcesses>) => o.afterJoin(() => {})],
    ])(
      '(FU-252 N1b) %s registered after a finished teardown is unjoined until a teardown handles it',
      async (_kind, register) => {
        const local = ownedProcesses();
        await run(local.teardown());
        expect(local.unjoined).toBe(false);
        register(local); // e.g. a case body the runner abandoned keeps calling `startWriter`
        expect(local.unjoined).toBe(true);
        await run(local.teardown());
        expect(local.unjoined).toBe(false);
      },
    );

    it('(FU-252) registrations that never stop are reported after a bounded number of rounds', async () => {
      const local = ownedProcesses();
      const again = async (): Promise<void> => {
        await sleep(5);
        local.afterJoin(again); // every round registers the next one
      };
      local.afterJoin(again);
      const failure = await run(settle(local.teardown(2_000)));
      expect(failure?.errors.map((e: Error) => e.message)).toEqual([
        'registrations kept arriving: not drained after 5 rounds',
      ]);
      expect(local.unjoined).toBe(true);
    });

    it('(FU-232) a cleanup step that hangs is cut off by the budget, not awaited forever', async () => {
      const local = ownedProcesses();
      local.afterJoin(() => new Promise<void>(() => {}));
      const started = Date.now();
      const failure = await run(settle(local.teardown(300))); // handled before the clock runs
      expect(failure?.message).toBe('fixture processes not joined');
      expect(Date.now() - started).toBe(1_000); // the step grace: a hung step ends there
    });
  });

  it('(F2) a writer connected but not yet accepted by its owner does no work, and the sweep leaves none held', async () => {
    // The owner's event loop is busy: the kernel completes the writer's connect from the backlog while
    // the owner's `connection` callback is still pending. The sweep then runs before that callback.
    const dir = app({ holdUntilRelease: true, unresponsive: 'sync' });
    const writer = startWriter(dir);
    const touched = (): boolean => connectedOrRan(dir, writer);
    const gate = new Int32Array(new SharedArrayBuffer(4));
    const patience = Date.now() + 30_000;
    while (!touched() && Date.now() < patience) Atomics.wait(gate, 0, 0, 10);
    expect(touched()).toBe(true); // the writer is connected at kernel level
    Atomics.wait(gate, 0, 0, 300); // long enough for a writer that did not wait to start its work
    // Same tick, before the pending `connection` callback can run: the end-of-case sweep.
    await releaseHold(dir, { lenient: true });
    expect(hasRun(dir, writer)).toBe(false); // no work unregistered
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
    while (!connectedOrRan(dir, second) && Date.now() < patience) Atomics.wait(gate, 0, 0, 10); // blocks the owner
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
