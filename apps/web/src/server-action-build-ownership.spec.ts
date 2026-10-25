/**
 * @jest-environment node
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
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
  plantFakeApp,
  plantFakeNext,
  runDriver,
  runModule,
  startDriver,
  url,
  type Plan,
} from './test/build-scripts';

/**
 * Ownership of the package's output lasts as long as every process that could write it
 * (Codex PR-420 r3 F1, r4 brief), and a report that cannot be written ends the build where
 * the wrapper sees it (r3 F3). Everything here runs as real processes: the lock in competing
 * Node processes, the wrapper in a driver process, `next build` as the fake one of
 * `plantFakeNext` (fast, and doing exactly what each case needs) — the same wrapper, lock and
 * preload as production. The real `next build` cases are in
 * server-action-build-binding.spec.ts.
 */
// Each case runs real processes (a fake build is 0.2-3 s); the default 5 s is too tight for a
// loaded CI runner.
jest.setTimeout(60_000);

const IMPORT_LOCK = `import { acquireBuildLock, buildInProgress } from ${JSON.stringify(url('build-lock.mjs'))};`;
const nonce = (c: string): string => c.repeat(24);
const deadPid = (): number => spawnSync(process.execPath, ['-e', '1']).pid as number;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const waitFor = async (test: () => boolean, ms = 30_000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!test() && Date.now() < deadline) await sleep(25);
  expect(test()).toBe(true);
};

/** A live process group of our own (a detached sleeper leads it); stopped in `afterEach`. */
const groups: number[] = [];
function liveGroup(): number {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  groups.push(child.pid as number);
  return child.pid as number;
}
/** Lock processes a case started; a failed expectation must not leave one holding forever. */
const lockProcesses: ChildProcess[] = [];
afterEach(() => {
  for (const child of lockProcesses.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  for (const group of groups.splice(0)) {
    try {
      process.kill(-group, 'SIGKILL');
    } catch {
      // gone
    }
  }
});

function plantLock(web: string, owner: object, id = nonce('a'), extra: string[] = []): void {
  mkdirSync(join(web, LOCK), { recursive: true });
  writeFileSync(join(web, LOCK, `owner-${id}`), JSON.stringify({ nonce: id, ...owner }));
  for (const name of extra) writeFileSync(join(web, LOCK, name), '{}');
}

describe('the build lock (r3 F1, r4 F1)', () => {
  let web: string;
  const run = (body: string): unknown =>
    runModule(`${IMPORT_LOCK}\nconst web = ${JSON.stringify(web)};\n${body}`).out;
  const acquire = (waitMs: number): unknown =>
    run(
      `const a = await acquireBuildLock(web, { waitMs: ${waitMs} }); console.log(JSON.stringify({ ok: a.ok, busy: buildInProgress(web) }));`,
    );
  beforeEach(() => {
    web = mkdtempSync(join(tmpdir(), 'lock-'));
  });
  afterEach(() => {
    chmodSync(web, 0o700);
    if (existsSync(join(web, LOCK))) chmodSync(join(web, LOCK), 0o700);
    rmSync(web, { recursive: true, force: true });
  });

  it('a second invocation refuses after a bounded wait and leaves the owner`s lock alone', () => {
    expect(
      run(`
        const a = await acquireBuildLock(web, { waitMs: 100 });
        const t0 = Date.now();
        const b = await acquireBuildLock(web, { waitMs: 400 });
        const stillA = (() => { try { a.lock.assertHeld(); return true; } catch { return false; } })();
        console.log(JSON.stringify({ a: a.ok, b: b.ok, problem: b.problem, waited: Date.now() - t0 >= 350, stillA }));
      `),
    ).toEqual({
      a: true,
      b: false,
      problem: expect.stringContaining('build lock: another build of this package holds'),
      waited: true,
      stillA: true,
    });
  });

  it('a waiting invocation proceeds once the owner released', () => {
    expect(
      run(`
        const a = await acquireBuildLock(web, { waitMs: 100 });
        setTimeout(() => a.lock.release(), 500);
        const b = await acquireBuildLock(web, { waitMs: 10000 });
        console.log(JSON.stringify({ b: b.ok }));
      `),
    ).toEqual({ b: true });
  });

  it('a released lock is gone; releasing a lock that is no longer ours removes nothing and says so', () => {
    expect(
      run(`
        import { existsSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
        import { join } from 'node:path';
        const a = await acquireBuildLock(web, { waitMs: 100 });
        const first = a.lock.release();
        const gone = !existsSync(join(web, ${JSON.stringify(LOCK)}));
        const b = await acquireBuildLock(web, { waitMs: 100 });
        const [entry] = readdirSync(join(web, ${JSON.stringify(LOCK)}));
        const other = 'owner-' + 'c'.repeat(24);
        renameSync(join(web, ${JSON.stringify(LOCK)}, entry), join(web, ${JSON.stringify(LOCK)}, other));
        writeFileSync(join(web, ${JSON.stringify(LOCK)}, other), JSON.stringify({ pid: process.pid, nonce: 'c'.repeat(24) }));
        // ... with an update of its own in flight: that is theirs too.
        const theirs = 'pending-' + 'c'.repeat(24) + '-' + '0'.repeat(12);
        writeFileSync(join(web, ${JSON.stringify(LOCK)}, theirs), '{}');
        const second = b.lock.release();
        const keptOthers = readdirSync(join(web, ${JSON.stringify(LOCK)})).sort().join() === [other, theirs].sort().join();
        let lost = false;
        try { b.lock.assertHeld(); } catch { lost = true; }
        console.log(JSON.stringify({ first, gone, second, keptOthers, lost }));
      `),
    ).toEqual({ first: true, gone: true, second: false, keptOthers: true, lost: true });
  });

  it('a lock whose wrapper is dead and whose build never started is taken over; a live wrapper is never taken from', () => {
    plantLock(web, { pid: deadPid() });
    expect(acquire(2000)).toEqual({ ok: true, busy: true });
    rmSync(join(web, LOCK), { recursive: true, force: true });
    plantLock(web, { pid: process.pid });
    expect(acquire(300)).toEqual({ ok: false, busy: true });
  });

  it('a dead wrapper whose build group still has a live process keeps the package locked, until the group is gone', async () => {
    const group = liveGroup();
    plantLock(web, { pid: deadPid(), group });
    expect(acquire(300)).toEqual({ ok: false, busy: true });
    process.kill(-group, 'SIGKILL');
    // Asynchronously: Jest's process must get to reap the killed sleeper (a zombie is still a
    // member of its group, and so still counts as alive).
    await waitFor(() => !alive(-group));
    expect(acquire(2000)).toEqual({ ok: true, busy: true });
  });

  it('a process that cannot be probed (EPERM: pid 1 for a non-root user) counts as alive', () => {
    plantLock(web, { pid: 1 });
    expect(acquire(300)).toEqual({ ok: false, busy: true });
  });

  it.each([
    ['a torn owner entry', (w: string) => plantTorn(w)],
    [
      'two owner entries',
      (w: string) => plantLock(w, { pid: deadPid() }, nonce('a'), [`owner-${nonce('b')}`]),
    ],
    [
      'a foreign entry next to the owner',
      (w: string) => plantLock(w, { pid: deadPid() }, nonce('a'), ['note']),
    ],
    ['an owner entry whose nonce is not its name', (w: string) => plantMismatched(w)],
    [
      'a lock FILE (the r3 format), not a directory',
      (w: string) => writeFileSync(join(w, LOCK), '{"pid":1}'),
    ],
    ['a pending entry alone (no owner)', (w: string) => plantPendingOnly(w)],
  ])('%s is held, not free, and never taken over (left exactly as found)', (_name, setUp) => {
    setUp(web);
    const before = snapshot(join(web, LOCK));
    expect(acquire(300)).toEqual({ ok: false, busy: true });
    expect(snapshot(join(web, LOCK))).toEqual(before);
  });

  it('an empty lock directory is nobody`s: free, and taken', () => {
    mkdirSync(join(web, LOCK));
    expect(run('console.log(JSON.stringify(buildInProgress(web)));')).toBe(false);
    expect(acquire(300)).toEqual({ ok: true, busy: true });
  });

  it('a dead owner`s pending update is removed with it', () => {
    plantLock(web, { pid: deadPid() }, nonce('a'), [`pending-${nonce('a')}-${'0'.repeat(12)}`]);
    expect(acquire(2000)).toEqual({ ok: true, busy: true });
    expect(readdirSync(join(web, LOCK))).toHaveLength(1);
  });

  it('a lock that cannot be created (I/O error) refuses at once, with a fixed sentence', () => {
    chmodSync(web, 0o500);
    expect(
      run(
        `const a = await acquireBuildLock(web, { waitMs: 5000 }); console.log(JSON.stringify(a));`,
      ),
    ).toEqual({
      ok: false,
      problem: `build lock: ${LOCK} could not be created (details withheld); refusing (nothing was changed)`,
    });
  });

  it('is mutual exclusion: six processes never overlap in the critical section', async () => {
    const worker = `
      import { readFileSync, writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      ${IMPORT_LOCK}
      const web = process.argv[1];
      const a = await acquireBuildLock(web, { waitMs: 60000 });
      if (!a.ok) { console.log('refused'); process.exit(1); }
      const file = join(web, 'counter');
      const seen = Number(readFileSync(file, 'utf8'));
      await new Promise((r) => setTimeout(r, 60));
      writeFileSync(file, String(seen + 1));
      a.lock.release();
      console.log('done');
    `;
    writeFileSync(join(web, 'counter'), '0');
    const runs = Array.from(
      { length: 6 },
      () =>
        new Promise<number | null>((resolve) => {
          const child = spawn(process.execPath, ['--input-type=module', '-e', worker, '--', web]);
          child.on('close', resolve);
        }),
    );
    expect(await Promise.all(runs)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(readFileSync(join(web, 'counter'), 'utf8')).toBe('6');
  }, 60_000);

  /**
   * r3 F1 (d), the reviewer's interleaving: reaper R1 read a dead owner and stops at a step of
   * its removal (for as long as it likes: nothing depends on time); B reaps that owner itself
   * and takes the package; R1 resumes. B must keep its lock, and C must not get one.
   */
  describe.each([
    ['before it removes the dead owner`s pending entry', 'unlink pending', true],
    ['before it removes the dead owner`s entry', 'unlink owner', false],
    ['before it removes the directory', 'rmdir', false],
  ])('a reaper paused %s, while another reaped and B took the lock', (_name, step, pending) => {
    it('resumes harmlessly: B keeps its lock, C refuses', async () => {
      plantLock(
        web,
        { pid: deadPid() },
        nonce('a'),
        pending ? [`pending-${nonce('a')}-${'0'.repeat(12)}`] : [],
      );
      const r1 = spawnLockProcess(web, `{ waitMs: 1500, pause: pauseAt(${JSON.stringify(step)}) }`);
      await waitFor(() => existsSync(join(web, 'paused')));
      const b = spawnLockProcess(web, '{ waitMs: 5000 }', 'hold');
      await waitFor(() => existsSync(join(web, 'b-holds')));
      writeFileSync(join(web, 'go'), '');
      expect(await r1.result).toMatchObject({ ok: false });
      expect(acquire(300)).toEqual({ ok: false, busy: true });
      writeFileSync(join(web, 'b-release'), '');
      expect(await b.result).toEqual({ ok: true, heldThroughout: true, released: true });
    }, 60_000);
  });

  it('a reaper that saw a dead wrapper with no group, while that wrapper published its group and died, does not reap (decided on the entry read after)', async () => {
    plantLock(web, { pid: deadPid() });
    const r1 = spawnLockProcess(web, `{ waitMs: 1500, pause: pauseAt('inspected') }`);
    await waitFor(() => existsSync(join(web, 'paused')));
    // The wrapper published its build's group (alive) just before it died.
    plantLock(web, { pid: deadPid(), group: liveGroup() });
    writeFileSync(join(web, 'go'), '');
    expect(await r1.result).toMatchObject({ ok: false });
    expect(acquire(300)).toEqual({ ok: false, busy: true });
  }, 60_000);
});

/** Every name and byte at the lock path (a directory's entries, or a file's contents). */
function snapshot(path: string): Record<string, string> {
  if (!lstatSync(path).isDirectory()) return { '': readFileSync(path, 'utf8') };
  return Object.fromEntries(
    readdirSync(path).map((name) => [name, readFileSync(join(path, name), 'utf8')]),
  );
}

function plantTorn(web: string): void {
  mkdirSync(join(web, LOCK));
  writeFileSync(join(web, LOCK, `owner-${nonce('a')}`), '{"pid"');
}
function plantMismatched(web: string): void {
  mkdirSync(join(web, LOCK));
  writeFileSync(
    join(web, LOCK, `owner-${nonce('a')}`),
    JSON.stringify({ pid: deadPid(), nonce: nonce('b') }),
  );
}
function plantPendingOnly(web: string): void {
  mkdirSync(join(web, LOCK));
  writeFileSync(join(web, LOCK, `pending-${nonce('a')}-${'0'.repeat(12)}`), '{}');
}

/**
 * An acquirer in a process of its own. `pauseAt(step)` blocks it, synchronously, at that step
 * until `go` appears. With `hold`, it reports `b-holds` once it has the lock, keeps it until
 * `b-release`, and says whether it held it throughout.
 */
function spawnLockProcess(
  web: string,
  options: string,
  mode: 'once' | 'hold' = 'once',
): { child: ChildProcess; result: Promise<unknown> } {
  const code = `
    import { existsSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    ${IMPORT_LOCK}
    const web = process.argv[1];
    const wait = new Int32Array(new SharedArrayBuffer(4));
    const pauseAt = (wanted) => (step) => {
      if (step !== wanted) return;
      writeFileSync(join(web, 'paused'), '');
      while (!existsSync(join(web, 'go'))) Atomics.wait(wait, 0, 0, 20);
    };
    const a = await acquireBuildLock(web, ${options});
    if (${JSON.stringify(mode)} === 'hold' && a.ok) {
      writeFileSync(join(web, 'b-holds'), '');
      let heldThroughout = true;
      while (!existsSync(join(web, 'b-release'))) {
        try { a.lock.assertHeld(); } catch { heldThroughout = false; }
        await new Promise((r) => setTimeout(r, 20));
      }
      console.log(JSON.stringify({ ok: true, heldThroughout, released: a.lock.release() }));
    } else {
      console.log(JSON.stringify({ ok: a.ok }));
    }
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code, '--', web]);
  lockProcesses.push(child);
  let stdout = '';
  child.stdout?.on('data', (chunk) => (stdout += chunk));
  const result = new Promise<unknown>((resolve) =>
    child.on('close', () => resolve(JSON.parse(stdout.trim() || 'null'))),
  );
  return { child, result };
}

describe('ownership lasts as long as every process that could write (r4 F1, fake `next build`)', () => {
  let root: string;
  let nextFrom: string;
  let n = 0;
  const app = (plan: Plan): string => {
    n += 1;
    const dir = join(root, `app-${n}`);
    plantFakeApp(dir, plan);
    return dir;
  };
  const record = (dir: string): { pid: number; capturePath: string } =>
    JSON.parse(readFileSync(join(dir, 'child.json'), 'utf8'));
  const ran = (dir: string): number[] =>
    readdirSync(dir)
      .filter((f) => f.startsWith('ran-'))
      .map((f) => Number(f.slice(4)));
  const receipt = (dir: string): string[] =>
    runModule(
      `import { receiptProblems } from ${JSON.stringify(url('build-receipt.mjs'))};\nconsole.log(JSON.stringify(receiptProblems(${JSON.stringify(dir)})));`,
    ).out as string[];
  const inProgress = (dir: string): unknown =>
    runModule(
      `${IMPORT_LOCK}\nconsole.log(JSON.stringify(buildInProgress(${JSON.stringify(dir)})));`,
    ).out;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'owner-'));
    ({ nextFrom } = plantFakeNext(join(root, 'fake')));
  });
  afterAll(() => {
    for (const entry of readdirSync(root)) {
      const lock = join(root, entry, LOCK);
      if (existsSync(lock)) chmodSync(lock, 0o700);
    }
    rmSync(root, { recursive: true, force: true });
  });

  it('control: a build of the fake `next` is receipted, and leaves no lock', async () => {
    const dir = app({ workers: ['fork', 'spawnSync', 'thread'], rootLoads: 2, workerLoads: 2 });
    expect(await runDriver(dir, { nextFrom })).toMatchObject({ status: 0, problems: [] });
    expect(receipt(dir)).toEqual([]);
    expect(existsSync(join(dir, LOCK))).toBe(false);
  });

  it('(a) publishing the group fails with an I/O error: `next build` is stopped and awaited, and the lock is KEPT because it cannot be removed either; refused', async () => {
    const dir = app({});
    const a = await runDriver(dir, {
      nextFrom,
      afterSpawn: 'readonly-lock',
      recordChild: join(dir, 'child.json'),
    });
    const { pid } = record(dir);
    expect(a.status).toBe(1);
    expect(a.problems).toEqual([
      'build: unexpected failure (details withheld); refusing',
      expect.stringContaining('build lock: could not be released (details withheld)'),
    ]);
    // When the wrapper returned, its `next build` was gone, and had never got past the handshake.
    expect(alive(pid)).toBe(false);
    expect(ran(dir)).toEqual([]);
    chmodSync(join(dir, LOCK), 0o700);
    // The kept lock names a dead wrapper and no group: B takes it over and builds its own.
    const b = await runDriver(dir, { nextFrom, lockWaitMs: 5_000 });
    expect(b).toMatchObject({ status: 0, problems: [] });
    expect(receipt(dir)).toEqual([]);
  });

  it('(a) any failure between start and publication: `next build` is gone before the lock is released', async () => {
    const dir = app({});
    const a = await runDriver(dir, {
      nextFrom,
      afterSpawn: 'throw',
      recordChild: join(dir, 'child.json'),
    });
    expect(a).toMatchObject({
      status: 1,
      problems: ['build: unexpected failure (details withheld); refusing'],
    });
    expect(alive(record(dir).pid)).toBe(false);
    expect(existsSync(join(dir, LOCK))).toBe(false);
    expect(ran(dir)).toEqual([]);
  });

  it('(b) the wrapper killed before publication: B may take over at once; the orphan never writes and exits by itself', async () => {
    const dir = app({});
    const a = await runDriver(dir, {
      nextFrom,
      afterSpawn: 'kill',
      recordChild: join(dir, 'child.json'),
      handshakeMs: 3_000,
    });
    expect(a.signal).toBe('SIGKILL');
    const { pid, capturePath } = record(dir);
    expect(alive(pid)).toBe(true);
    expect(inProgress(dir)).toBe(false);
    const b = await runDriver(dir, { nextFrom, lockWaitMs: 5_000 });
    expect(b).toMatchObject({ status: 0, problems: [] });
    await waitFor(() => !alive(pid), 10_000);
    expect(ran(dir)).toHaveLength(1);
    expect(ran(dir)).not.toContain(pid);
    expect(existsSync(capturePath)).toBe(false);
    rmSync(join(capturePath, '..'), { recursive: true, force: true });
    expect(receipt(dir)).toEqual([]);
  });

  it.each([
    ['exit 0', { linger: { ms: 60_000 } }],
    [
      'exit 0, the writer asked for `detached: true` (kept in the group)',
      { linger: { ms: 60_000, detached: true } },
    ],
    ['failure (exit 1)', { linger: { ms: 60_000 }, exit: 1 }],
    // A synchronous child honours `detached` too; what it leaves running stays in the group.
    [
      'exit 0, the writer left by a `detached` spawnSync child',
      { linger: { ms: 60_000, via: 'spawnSync' } },
    ],
    [
      'exit 0, the writer left by a `detached` execFileSync child',
      { linger: { ms: 60_000, via: 'execFileSync' } },
    ],
    [
      'exit 0, the writer left by a `detached` execSync child',
      { linger: { ms: 60_000, via: 'execSync' } },
    ],
  ])(
    '(c, B) `next build` ended (%s) while a process it started writes: refused, and that process is gone before the lock is',
    async (_name, plan) => {
      const dir = app(plan as Plan);
      const result = await runDriver(dir, { nextFrom });
      expect(result).toMatchObject({
        status: 1,
        problems: ['next build: a process it started was still running after it exited; refusing'],
      });
      const writer = Number(readFileSync(join(dir, 'linger.pid'), 'utf8'));
      expect(existsSync(join(dir, '.next/from-linger'))).toBe(true);
      expect(alive(writer)).toBe(false);
      expect(existsSync(join(dir, LOCK))).toBe(false);
      expect(existsSync(join(dir, '.next/server-action-build-receipt.json'))).toBe(false);
    },
  );

  it('(B) a process that outlives `next build` briefly, inside the settle window, is waited for: receipted', async () => {
    const dir = app({ linger: { ms: 300 } });
    expect(await runDriver(dir, { nextFrom })).toMatchObject({ status: 0, problems: [] });
    expect(existsSync(join(dir, 'linger.done'))).toBe(true);
    expect(receipt(dir)).toEqual([]);
  });

  it.each([
    ['SIGTERM', 143],
    ['SIGINT', 130],
    ['SIGHUP', 129],
  ] as const)(
    '(C) the wrapper gets %s during the build: it stops and awaits the whole group, then releases; no receipt',
    async (signal, status) => {
      const dir = app({ holdMs: 60_000, linger: { ms: 60_000 } });
      const driver = startDriver(dir, { nextFrom, recordChild: join(dir, 'child.json') });
      await waitFor(() => ran(dir).length === 1 && existsSync(join(dir, 'linger.pid')));
      process.kill(driver.pid, signal);
      const result = await driver.done;
      // The wrapper itself was not killed by its build's group signal: it reported.
      expect(result).toMatchObject({
        status,
        problems: ['build: interrupted; the build was stopped before the lock was released'],
      });
      expect(alive(record(dir).pid)).toBe(false);
      expect(alive(Number(readFileSync(join(dir, 'linger.pid'), 'utf8')))).toBe(false);
      expect(existsSync(join(dir, LOCK))).toBe(false);
      expect(existsSync(join(dir, '.next/server-action-build-receipt.json'))).toBe(false);
    },
  );

  it('(C) the wrapper killed with SIGKILL after publication: the lock stays held while the build lives, and recovery waits for it (fail closed)', async () => {
    const dir = app({ holdMs: 60_000 });
    const driver = startDriver(dir, { nextFrom, recordChild: join(dir, 'child.json') });
    await waitFor(() => ran(dir).length === 1);
    process.kill(driver.pid, 'SIGKILL');
    await driver.done;
    const { pid } = record(dir);
    groups.push(pid);
    expect(inProgress(dir)).toBe(true);
    const b = await runDriver(dir, { nextFrom, lockWaitMs: 1_000 });
    expect(b.status).toBe(1);
    expect(b.problems).toEqual([expect.stringContaining('build lock: another build')]);
    expect(ran(dir)).toEqual([pid]);
    process.kill(-pid, 'SIGKILL');
    await waitFor(() => !alive(-pid));
    expect(inProgress(dir)).toBe(false);
    // The next invocation builds normally (no hold this time).
    plantFakeApp(dir, {});
    expect(await runDriver(dir, { nextFrom, lockWaitMs: 5_000 })).toMatchObject({
      status: 0,
      problems: [],
    });
  });

  it('(F) the lock cannot be released after a good build: refused, the receipt does not outlive the refusal', async () => {
    const dir = app({});
    const result = await runDriver(dir, { nextFrom, beforeReceipt: 'readonly-lock' });
    expect(result.status).toBe(1);
    expect(result.problems).toEqual([
      'build lock: could not be released (details withheld); it is free once this process has exited; refusing',
    ]);
    expect(existsSync(join(dir, '.next/server-action-build-receipt.json'))).toBe(false);
    chmodSync(join(dir, LOCK), 0o700);
    expect(inProgress(dir)).toBe(false);
  });

  it('(F) the scratch directory cannot be removed: nothing throws past the release; the lock is released', async () => {
    const dir = app({});
    const result = await runDriver(dir, {
      nextFrom,
      beforeReceipt: 'readonly-scratch',
      recordChild: join(dir, 'child.json'),
    });
    const scratch = join(record(dir).capturePath, '..');
    expect(existsSync(scratch)).toBe(true);
    chmodSync(scratch, 0o700);
    rmSync(scratch, { recursive: true, force: true });
    expect(result).toMatchObject({ status: 0, problems: [] });
    expect(existsSync(join(dir, LOCK))).toBe(false);
  });

  it('(F) the build`s processes cannot be confirmed stopped: the lock is KEPT (it names the live group) and the build refuses', async () => {
    // No settle and no stop deadline: the writer is still there when the wrapper gives up.
    const dir = app({ linger: { ms: 60_000 } });
    const result = await runDriver(dir, {
      nextFrom,
      settleMs: 0,
      stopGraceMs: 0,
      stopWaitMs: 0,
      recordChild: join(dir, 'child.json'),
    });
    expect(result).toMatchObject({
      status: 1,
      problems: [
        'build: processes of this build could not be confirmed stopped; the build lock is kept; refusing',
      ],
    });
    expect(existsSync(join(dir, LOCK))).toBe(true);
    expect(existsSync(join(dir, '.next/server-action-build-receipt.json'))).toBe(false);
    // It was sent SIGKILL: once the group is gone, the kept lock is free, and not before.
    const { pid } = record(dir);
    await waitFor(() => !alive(-pid));
    expect(inProgress(dir)).toBe(false);
    plantFakeApp(dir, {});
    expect(await runDriver(dir, { nextFrom, lockWaitMs: 5_000 })).toMatchObject({
      status: 0,
      problems: [],
    });
  });

  it('(F) the lock is no longer ours when the receipt is due: no receipt, the other owner`s entry is left alone; refused', async () => {
    const dir = app({});
    const result = await runDriver(dir, { nextFrom, beforeReceipt: 'steal-lock' });
    expect(result.status).toBe(1);
    expect(result.problems).toEqual([
      'build: unexpected failure (details withheld); refusing',
      'build lock: could not be released (details withheld); it is free once this process has exited; refusing',
    ]);
    expect(existsSync(join(dir, '.next/server-action-build-receipt.json'))).toBe(false);
    expect(readdirSync(join(dir, LOCK))).toEqual([`owner-${nonce('c')}`]);
  });

  it('every line these failures print is a fixed sentence (no errno, path or value)', async () => {
    const dir = app({ linger: { ms: 60_000 } });
    const result = await runDriver(dir, { nextFrom });
    expect(result.printed).not.toMatch(/E[A-Z]{3,}|\/tmp\/|owner-/);
  });
});

describe('a report that cannot be written ends the build, visibly (r4 F3, fake `next build`)', () => {
  let root: string;
  let nextFrom: string;
  let fault: string;
  let n = 0;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'report-'));
    ({ nextFrom, fault } = plantFakeNext(join(root, 'fake')));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const build = async (
    plan: Plan,
    faultSpec: string,
  ): Promise<{ dir: string; status?: number; problems: string[] }> => {
    n += 1;
    const dir = join(root, `app-${n}`);
    plantFakeApp(dir, plan);
    const result = await runDriver(dir, {
      nextFrom,
      env: { FAULT: faultSpec, NODE_OPTIONS: `--require=${JSON.stringify(fault)}` },
    });
    return { dir, ...result };
  };
  const REFUSED = ['next config: a build process could not write its report; refusing'];

  it('control: the fault preload with no fault changes nothing', async () => {
    const { status, problems } = await build({ workers: ['fork', 'thread'] }, '');
    expect({ status, problems }).toEqual({ status: 0, problems: [] });
  });

  // Every record kind, in every role that writes it; EIO and ENOSPC both. The fake build, like
  // Next, catches a failing configuration load and ignores how its workers ended.
  it.each([
    ['start', 'root', 'EIO', {}],
    ['start', 'child', 'ENOSPC', { workers: ['fork'] }],
    ['start', 'child', 'EIO', { workers: ['spawnSync'] }],
    ['start', 'thread', 'ENOSPC', { workers: ['thread'] }],
    ['spawn', 'root', 'EIO', { workers: ['fork'] }],
    ['spawn', 'root', 'ENOSPC', { workers: ['spawnSync'] }],
    ['spawn', 'root', 'EIO', { workers: ['thread'] }],
    ['config-begin', 'root', 'ENOSPC', {}],
    ['config-begin', 'child', 'EIO', { workers: ['fork'] }],
    ['config-begin', 'thread', 'ENOSPC', { workers: ['thread'] }],
    ['config', 'root', 'EIO', {}],
    ['config', 'root', 'ENOSPC', { rootLoads: 3 }],
    ['config', 'child', 'EIO', { workers: ['fork'] }],
    ['config', 'child', 'ENOSPC', { workers: ['spawnSync'] }],
    ['config', 'thread', 'EIO', { workers: ['thread'], workerLoads: 2 }],
  ] as const)(
    'a `%s` record of the %s fails with %s: the build is stopped, refused, no receipt',
    async (kind, role, code, plan) => {
      const { dir, status, problems } = await build(plan as Plan, `${kind}:${role}:${code}`);
      expect({ status, problems }).toEqual({ status: 1, problems: REFUSED });
      // The whole build stopped right there: it never wrote its output.
      expect(existsSync(join(dir, '.next/BUILD_ID'))).toBe(false);
      expect(existsSync(join(dir, '.next/server-action-build-receipt.json'))).toBe(false);
      expect(existsSync(join(dir, LOCK))).toBe(false);
    },
  );

  it('a process that fails its report AFTER `next build` exited 0 (inside the settle window) is still seen: refused', async () => {
    const { dir, status, problems } = await build(
      { linger: { ms: 1_000, loadsAfterMs: 200 } },
      'config-begin:child:EIO',
    );
    expect({ status, problems }).toEqual({ status: 1, problems: REFUSED });
    // The build itself finished; only the report failed.
    expect(existsSync(join(dir, '.next/BUILD_ID'))).toBe(true);
    expect(existsSync(join(dir, '.next/server-action-build-receipt.json'))).toBe(false);
  });
});
