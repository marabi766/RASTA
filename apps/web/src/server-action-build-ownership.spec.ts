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

import { cleanupFixtures, LOST_DIAGNOSTIC, signalChild } from './test/build-lifetime';
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
const groups = new Map<number, ChildProcess>();
function liveGroup(): number {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  groups.set(child.pid as number, child);
  return child.pid as number;
}
/** Lock processes a case started; a failed expectation must not leave one holding forever. */
const lockProcesses: ChildProcess[] = [];
afterEach(async () => {
  for (const child of lockProcesses.splice(0)) signalChild(child, 'SIGKILL');
  for (const child of groups.values()) signalChild(child, 'SIGKILL');
  groups.clear();
  await cleanupFixtures();
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

  it('a new exclusive owner can finish before the old wrapper unlinks its unique receipt marker', () => {
    const nextOwner = `
      import { mkdirSync, writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      ${IMPORT_LOCK}
      import { writeReceipt } from ${JSON.stringify(url('build-receipt.mjs'))};
      const web = ${JSON.stringify(web)};
      const b = await acquireBuildLock(web, { waitMs: 0 });
      b.lock.beginOutput();
      mkdirSync(join(web, '.next/server'), { recursive: true });
      writeFileSync(join(web, '.next/BUILD_ID'), 'build-B');
      writeFileSync(join(web, '.next/server/server-reference-manifest.json'), '{"node":{}}');
      writeReceipt(web, { distDir: '.next', tsconfigPath: 'tsconfig.json', cleanDistDir: true });
      console.log(JSON.stringify({ ok: b.ok, released: b.lock.release() }));
    `;
    expect(
      run(`
      import fs from 'node:fs';
      import { spawnSync } from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      import { checkedSnapshot } from ${JSON.stringify(url('build-receipt.mjs'))};
      const a = await acquireBuildLock(web, { waitMs: 0 });
      a.lock.beginOutput();
      const unlink = fs.unlinkSync;
      let other;
      fs.unlinkSync = (file) => {
        if (file === a.lock.receiptPending && !other) {
          const b = spawnSync(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(nextOwner)}], { encoding: 'utf8' });
          other = JSON.parse(b.stdout.trim());
        }
        return unlink(file);
      };
      syncBuiltinESMExports();
      const released = a.lock.release();
      fs.unlinkSync = unlink;
      syncBuiltinESMExports();
      console.log(JSON.stringify({ released, other, problems: checkedSnapshot(web).problems }));
    `),
    ).toEqual({ released: true, other: { ok: true, released: true }, problems: [] });
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
    signalChild(groups.get(group) as ChildProcess, 'SIGKILL');
    // Asynchronously: Jest's process must get to reap the killed sleeper (a zombie is still a
    // member of its group, and so still counts as alive).
    await waitFor(() => !alive(-group));
    expect(acquire(2000)).toEqual({ ok: true, busy: true });
  });

  it.each(['EPERM', 'EIO', 'EINVAL'])(
    'only ESRCH is absence: %s keeps wrapper/group ownership and blocks reaping',
    (code) => {
      plantLock(web, { pid: deadPid(), group: deadPid() });
      expect(
        run(`
      import { pidAlive, groupAlive } from ${JSON.stringify(url('build-lock.mjs'))};
      const kill = process.kill;
      process.kill = () => { const error = new Error('withheld'); error.code = ${JSON.stringify(code)}; throw error; };
      const held = buildInProgress(web);
      const pid = pidAlive(123);
      const group = groupAlive(123);
      const attempt = await acquireBuildLock(web, { waitMs: 0 });
      process.kill = () => { const error = new Error('gone'); error.code = 'ESRCH'; throw error; };
      const absent = !pidAlive(123) && !groupAlive(123) && !buildInProgress(web);
      process.kill = kill;
      console.log(JSON.stringify({ held, pid, group, refused: !attempt.ok, absent }));
    `),
      ).toEqual({ held: true, pid: true, group: true, refused: true, absent: true });
    },
  );

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
  const caseApps = new Set<string>();
  const app = (plan: Plan): string => {
    n += 1;
    const dir = join(root, `app-${n}`);
    plantFakeApp(dir, plan);
    caseApps.add(dir);
    return dir;
  };
  const record = (dir: string): { pid: number; group: number; capturePath: string } =>
    JSON.parse(readFileSync(join(dir, 'child.json'), 'utf8'));
  const ran = (dir: string): number[] =>
    readdirSync(dir)
      .filter((f) => f.startsWith('ran-'))
      .map((f) => Number(f.slice(4)));
  const receipt = (dir: string): string[] =>
    runModule(
      `import { checkedSnapshot } from ${JSON.stringify(url('build-receipt.mjs'))};\nconsole.log(JSON.stringify(checkedSnapshot(${JSON.stringify(dir)}).problems));`,
    ).out as string[];
  const inProgress = (dir: string): unknown =>
    runModule(
      `${IMPORT_LOCK}\nconsole.log(JSON.stringify(buildInProgress(${JSON.stringify(dir)})));`,
    ).out;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'owner-'));
    ({ nextFrom } = plantFakeNext(join(root, 'fake')));
  });
  afterEach(async () => {
    for (const dir of caseApps) {
      chmodSync(dir, 0o700);
      if (existsSync(join(dir, '.next'))) chmodSync(join(dir, '.next'), 0o700);
    }
    await cleanupFixtures();
    caseApps.clear();
  });
  afterAll(() => {
    for (const entry of readdirSync(root)) {
      const lock = join(root, entry, LOCK);
      if (existsSync(lock)) chmodSync(lock, 0o700);
    }
    rmSync(root, { recursive: true, force: true });
  });

  it.each(['afterEach', 'watchdog'] as const)(
    'R5-1: %s sees a completed fixture PGID reused by an unrelated live group and sends no signal',
    async (path) => {
      const dir = app({});
      const driver = startDriver(dir, { nextFrom, recordChild: join(dir, 'child.json') });
      expect(await driver.done).toMatchObject({ status: 0 });
      // R6-1: completion is the supervisor's announced ending plus observed absence.
      expect(await driver.ended).toBe('COMPLETED');
      const { group } = record(dir);
      // The original lifetime has ended. Resume the ACTUAL cleanup/watchdog body
      // after a pause, with a model in which every old numeric ID is now live again.
      // No real ID reuse or unrelated process is needed on this shared host.
      const signals: Array<[number, unknown]> = [];
      const kill = jest.spyOn(process, 'kill').mockImplementation((target, signal) => {
        if (signal !== 0) signals.push([target, signal]);
        return true;
      });
      try {
        expect(alive(-group)).toBe(true);
        if (path === 'afterEach') await cleanupFixtures();
        else await expect(driver.watchdog()).rejects.toThrow('owned group shutdown COMPLETED');
        expect(signals).toEqual([]);
        expect(driver.signal('SIGTERM')).toBe(false);
        expect(driver.killSupervisor()).toBe(false);
        expect(await driver.root('SIGTERM')).toBe(false);
      } finally {
        // Mutant cleanup also runs under this model: never let an intentionally
        // restored numeric teardown reach the real shared host from an afterEach.
        try {
          await cleanupFixtures();
        } finally {
          kill.mockRestore();
        }
      }
    },
  );

  it('R5-1: the actual watchdog fails loudly and joins owned group cleanup', async () => {
    const dir = app({ holdMs: 60_000 });
    const driver = startDriver(dir, {
      nextFrom,
      recordChild: join(dir, 'child.json'),
    });
    await waitFor(() => ran(dir).length === 1);
    driver.expireWatchdog();
    await expect(driver.done).rejects.toThrow('fixture watchdog expired');
    await cleanupFixtures();
    // EOF confirms the supervisor lifetime ended; group members may still be
    // disappearing. This observation only asserts termination, never signals.
    await waitFor(() => !alive(-record(dir).group), 5_000);
  });

  it('control: a build of the fake `next` is receipted, and leaves no lock', async () => {
    const dir = app({ workers: ['fork', 'spawnSync', 'thread'], rootLoads: 2, workerLoads: 2 });
    expect(await runDriver(dir, { nextFrom })).toMatchObject({ status: 0, problems: [] });
    expect(receipt(dir)).toEqual([]);
    expect(existsSync(join(dir, LOCK))).toBe(false);
  });

  it('R6-1: cleanup sent while the supervisor import is pending waits for its handler and confirms termination', async () => {
    // Bounded: a regressed controller that drops the shutdown strands nothing for long.
    const dir = app({ holdMs: 10_000 });
    const driver = startDriver(dir, { nextFrom, controllerImportDelayMs: 500 });
    // Connected, but the production handler does not exist yet: request shutdown NOW.
    await driver.controllerConnected;
    await expect(cleanupFixtures()).resolves.toBeUndefined();
    expect(await driver.ended).toBe('COMPLETED');
    await driver.done;
    // COMPLETED required the supervisor's own FINAL plus observed group absence.
    for (const pid of ran(dir)) expect(alive(pid)).toBe(false);
  });

  it('R6-1: controller loss is LOST, and the watchdog rejects while inherited pipes stay held', async () => {
    // A bounded root holds the wrapper's inherited stdout/stderr pipes after its
    // supervisor dies, so the wrapper's 'close' cannot arrive until it exits.
    const dir = app({ holdMs: 4_000 });
    const driver = startDriver(dir, {
      nextFrom,
      inherit: true,
      recordChild: join(dir, 'child.json'),
      stopGraceMs: 100,
      stopWaitMs: 500,
    });
    await waitFor(() => ran(dir).length === 1);
    const { group } = record(dir);
    expect(driver.killSupervisor()).toBe(true);
    expect(await driver.ended).toBe('LOST'); // Unexpected loss is not a completed fixture.
    const started = performance.now();
    driver.expireWatchdog();
    const outcome = await Promise.race([
      driver.done.then(
        () => 'resolved',
        (error: Error) => error.message,
      ),
      sleep(2_000).then(() => 'still waiting for close'),
    ]);
    expect(outcome).toBe(`fixture watchdog expired; ${LOST_DIAGNOSTIC}`);
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(alive(-group)).toBe(true); // The pipe holder still lives: rejection did not wait.
    // Its parent died: no endpoint can authorize a root signal. Observe its natural exit.
    await waitFor(() => !alive(-group));
    await expect(cleanupFixtures()).rejects.toThrow('fixture cleanup failed');
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
    // The preload self-kills the abandoned group without a supervisor final report.
    // Observing its absence does not turn the lost lifecycle into a normal exit.
    await expect(cleanupFixtures()).rejects.toThrow('fixture cleanup failed');
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
      driver.signal(signal);
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

  it.each(['SIGTERM', 'SIGINT', 'SIGHUP'] as const)(
    'R4-1: a single %s bounds shutdown for roots ignoring TERM and blocked in synchronous work',
    async (signal) => {
      for (const unresponsive of ['ignore', 'sync'] as const) {
        const dir = app({ holdMs: 60_000, unresponsive });
        const driver = startDriver(dir, {
          nextFrom,
          recordChild: join(dir, 'child.json'),
          stopGraceMs: 150,
          stopWaitMs: 1_000,
          recordGroupEvents: true,
        });
        await waitFor(() => existsSync(join(dir, 'unresponsive.ready')));
        const started = performance.now();
        driver.signal(signal);
        const result = await driver.done;
        expect(performance.now() - started).toBeLessThan(3_150);
        expect(result).toMatchObject({
          status: 128 + { SIGTERM: 15, SIGINT: 2, SIGHUP: 1 }[signal],
          problems: ['build: interrupted; the build was stopped before the lock was released'],
        });
        const { pid, group } = record(dir);
        expect(alive(pid)).toBe(false);
        expect(alive(-group)).toBe(false);
        expect(existsSync(join(dir, LOCK))).toBe(false);
        const events = JSON.parse(readFileSync(join(dir, 'group-events.json'), 'utf8')) as string[];
        expect(events.filter((e) => e === 'send-term')).toHaveLength(1);
        expect(events.filter((e) => e === 'send-kill')).toHaveLength(1);
      }
    },
  );

  it('R4-1: TERM then INT shares one monotonic total shutdown budget, even with a frozen wall clock', async () => {
    const dir = app({ holdMs: 60_000, unresponsive: 'ignore' });
    const driver = startDriver(dir, {
      nextFrom,
      recordGroupEvents: true,
      frozenWallClock: true,
      stopGraceMs: 200,
      stopWaitMs: 1_000,
    });
    await waitFor(() => existsSync(join(dir, 'unresponsive.ready')));
    const started = performance.now();
    driver.signal('SIGTERM');
    await sleep(25);
    driver.signal('SIGINT');
    expect(await driver.done).toMatchObject({ status: 143 });
    expect(performance.now() - started).toBeLessThan(3_200);
    const events = JSON.parse(readFileSync(join(dir, 'group-events.json'), 'utf8')) as string[];
    expect(events.filter((e) => e === 'send-term')).toHaveLength(1);
    expect(events.filter((e) => e === 'send-kill')).toHaveLength(1);
  });

  it('R4-1: INT during publication followed by TERM joins the first shutdown', async () => {
    const dir = app({ holdMs: 60_000 });
    const result = await runDriver(dir, {
      nextFrom,
      afterSpawn: 'interrupt',
      mixedPublicationSignal: true,
      stopGraceMs: 150,
      stopWaitMs: 1_000,
      recordGroupEvents: true,
    });
    expect(result).toMatchObject({ status: 130 });
    expect(existsSync(join(dir, LOCK))).toBe(false);
    expect(ran(dir)).toEqual([]);
    const events = JSON.parse(readFileSync(join(dir, 'group-events.json'), 'utf8')) as string[];
    expect(events.filter((e) => e === 'send-term')).toHaveLength(1);
  });

  it('R4-2: the live supervisor reserves the PGID after root exit; it retires last, after receipt and the final possible signal', async () => {
    const dir = app({});
    const driver = startDriver(dir, {
      nextFrom,
      recordChild: join(dir, 'child.json'),
      pauseDir: dir,
      recordGroupEvents: true,
    });
    await waitFor(() => existsSync(join(dir, 'paused')));
    const { pid, group } = record(dir);
    expect(pid).not.toBe(group);
    expect(alive(pid)).toBe(false);
    expect(alive(group)).toBe(true);
    expect(alive(-group)).toBe(true);
    const census = spawnSync('ps', ['-axo', 'pid=,pgid='], { encoding: 'utf8' });
    expect(census.status).toBe(0);
    const members = census.stdout
      .trim()
      .split('\n')
      .map((line) => line.trim().split(/\s+/).map(Number))
      .filter(([, pgid]) => pgid === group)
      .map(([member]) => member);
    expect(members).toEqual([group]);
    expect(inProgress(dir)).toBe(true);
    expect((await runDriver(dir, { nextFrom, lockWaitMs: 0 })).status).toBe(1);
    writeFileSync(join(dir, 'go'), '');
    expect(await driver.done).toMatchObject({ status: 0, problems: [] });
    expect(alive(-group)).toBe(false);
    expect(existsSync(join(dir, LOCK))).toBe(false);
    expect(receipt(dir)).toEqual([]);
    const events = JSON.parse(readFileSync(join(dir, 'group-events.json'), 'utf8')) as string[];
    expect(events.indexOf('quiescent')).toBeLessThan(events.indexOf('receipt'));
    expect(events.indexOf('receipt')).toBeLessThan(events.indexOf('send-retire'));
    expect(events.indexOf('send-retire')).toBeLessThan(events.indexOf('final'));
    expect(events.indexOf('final')).toBeLessThan(events.indexOf('absent'));
  });

  it.each([false, true])(
    'R4-2: modeled PGID reuse after definite absence, late interrupts=%s: no signal reaches the reused group',
    async (interruptOnAbsence) => {
      const dir = app({});
      const result = await runDriver(dir, { nextFrom, modelReuse: true, interruptOnAbsence });
      expect(result.status).toBe(interruptOnAbsence ? 143 : 0);
      expect(JSON.parse(readFileSync(join(dir, 'reuse.json'), 'utf8'))).toEqual({
        absent: true,
        signalsToReusedGroup: 0,
      });
      expect(existsSync(join(dir, LOCK))).toBe(false);
      expect(existsSync(join(dir, '.next/server-action-build-receipt.json'))).toBe(
        !interruptOnAbsence,
      );
    },
  );

  it('R4-2: unexpected supervisor death retires signalling and keeps the lock while writers live', async () => {
    const dir = app({ holdMs: 2_000 });
    const driver = startDriver(dir, {
      nextFrom,
      recordChild: join(dir, 'child.json'),
      recordGroupEvents: true,
      stopGraceMs: 100,
      stopWaitMs: 1_000,
    });
    await waitFor(() => ran(dir).length === 1);
    const { pid, group } = record(dir);
    expect(driver.killSupervisor()).toBe(true);
    expect(await driver.done).toMatchObject({
      status: 1,
      problems: [
        'build: processes of this build could not be confirmed stopped; the build lock is kept; refusing',
      ],
    });
    expect(alive(pid)).toBe(true);
    expect(inProgress(dir)).toBe(true);
    expect(existsSync(join(dir, LOCK))).toBe(true);
    const events = JSON.parse(readFileSync(join(dir, 'group-events.json'), 'utf8')) as string[];
    expect(events.filter((e) => e === 'send-term' || e === 'send-kill')).toEqual([]);
    // Its parent died: no endpoint can authorize a root signal.
    // Observe this bounded fixture's natural exit instead of using its saved PID.
    await waitFor(() => !alive(-group));
    expect(inProgress(dir)).toBe(false);
    await expect(cleanupFixtures()).rejects.toThrow('fixture cleanup failed');
  });

  it.each(['interrupt', 'uncertain', 'supervisor-death'] as const)(
    'after receipt publication, %s removes the receipt and refuses',
    async (afterReceipt) => {
      const dir = app({});
      const result = await runDriver(dir, {
        nextFrom,
        afterReceipt,
        stopGraceMs: 100,
        stopWaitMs: 500,
      });
      expect(result.status).toBe(afterReceipt === 'interrupt' ? 130 : 1);
      expect(existsSync(join(dir, '.next/server-action-build-receipt.json'))).toBe(false);
      expect(existsSync(join(dir, LOCK))).toBe(afterReceipt !== 'interrupt');
      if (afterReceipt === 'supervisor-death') {
        await expect(cleanupFixtures()).rejects.toThrow('fixture cleanup failed');
      }
    },
  );

  it.each([
    'readonly-interrupt',
    'readonly-uncertain',
    'readonly-release',
    'readonly-marker',
  ] as const)(
    'after publication, %s cannot unlink the receipt: retain the lock and checker refusal survives wrapper/group exit',
    async (afterReceipt) => {
      const dir = app({});
      const result = await runDriver(dir, {
        nextFrom,
        afterReceipt,
        stopGraceMs: 100,
        stopWaitMs: 500,
      });
      expect(result.status).toBe(1);
      expect(existsSync(join(dir, '.next/server-action-build-receipt.json'))).toBe(true);
      expect(existsSync(join(dir, LOCK))).toBe(true);
      expect(inProgress(dir)).toBe(false); // recovery may proceed, but this receipt cannot certify
      const check =
        runModule(`import { checkedSnapshot } from ${JSON.stringify(url('build-receipt.mjs'))};
        console.log(JSON.stringify(checkedSnapshot(${JSON.stringify(dir)})));`).out;
      expect(check).toEqual({ problems: [expect.stringContaining('lock needs recovery')] });
      if (afterReceipt === 'readonly-interrupt') {
        // Pause recovery after unlinking the dead owner, before another owner exists.
        // The marker must block a checker even though the lock directory is empty.
        const reaper = spawnLockProcess(dir, "{ waitMs: 0, pause: pauseAt('rmdir') }");
        await waitFor(() => existsSync(join(dir, 'paused')));
        expect(readdirSync(join(dir, LOCK))).toEqual([]);
        const duringRecovery =
          runModule(`import { checkedSnapshot } from ${JSON.stringify(url('build-receipt.mjs'))};
          console.log(JSON.stringify(checkedSnapshot(${JSON.stringify(dir)}).problems));`).out;
        expect(duringRecovery).toEqual([expect.stringContaining('lock needs recovery')]);
        writeFileSync(join(dir, 'go'), '');
        expect(await reaper.result).toEqual({ ok: false });
      }
      expect(result.printed).not.toMatch(/E[A-Z]{3,}|owner-|\/tmp\//);
      chmodSync(dir, 0o700);
      chmodSync(join(dir, '.next'), 0o700);
      if (existsSync(join(dir, LOCK))) chmodSync(join(dir, LOCK), 0o700);
      // Recovery takes the dead lock and invalidates its old receipt before a fresh build.
      expect(await runDriver(dir, { nextFrom, lockWaitMs: 5_000 })).toMatchObject({
        status: 0,
        problems: [],
      });
      expect(receipt(dir)).toEqual([]);
    },
  );

  it('definite absence before the final acknowledgement is uncertain: retain the lock and invalidate the receipt', async () => {
    const dir = app({});
    expect(await runDriver(dir, { nextFrom, prematureAbsence: true })).toMatchObject({
      status: 1,
      problems: [
        'build: processes of this build could not be confirmed stopped; the build lock is kept; refusing',
      ],
    });
    expect(existsSync(join(dir, LOCK))).toBe(true);
    expect(existsSync(join(dir, '.next/server-action-build-receipt.json'))).toBe(false);
  });

  it('a mis-published group cannot let the root write before correct ownership publication', async () => {
    const dir = app({});
    expect(
      await runDriver(dir, {
        nextFrom,
        afterSpawn: 'mis-publish',
        stopGraceMs: 100,
        stopWaitMs: 1_000,
      }),
    ).toMatchObject({ status: 1 });
    expect(ran(dir)).toEqual([]);
    expect(existsSync(join(dir, '.next/server-action-build-receipt.json'))).toBe(false);
  });

  it.each(['error', 'malformed', 'missing-supervisor'] as const)(
    'supervisor census %s refuses with fixed diagnostics',
    async (censusFault) => {
      const dir = app({});
      const result = await runDriver(dir, {
        nextFrom,
        censusFault,
        inherit: true,
        settleMs: 1_000,
        stopGraceMs: 100,
        stopWaitMs: 1_000,
      });
      expect(result).toMatchObject({
        status: 1,
        problems: ['next build: a process it started was still running after it exited; refusing'],
      });
      expect(result.printed).not.toMatch(/census-sentinel|not-a-process|EIO|private/);
      // Verify the injected fault itself: an invalid test executable must not stand
      // in for a well-formed census whose exit status or membership is wrong.
      const probe = spawnSync(join(dir, 'census-bin/ps'), [], { encoding: 'utf8' });
      expect(probe.status).toBe(censusFault === 'error' ? 1 : 0);
      if (censusFault === 'missing-supervisor') expect(probe.stdout).toBe('1 1\n');
      if (censusFault === 'error') expect(probe.stdout).toMatch(/^\d+ \d+\n\d+ \d+\n$/);
      expect(existsSync(join(dir, '.next/server-action-build-receipt.json'))).toBe(false);
      expect(existsSync(join(dir, LOCK))).toBe(false);
    },
  );

  it('shutdown is joined before ownership release even when a surviving writer ignores TERM', async () => {
    const dir = app({ holdMs: 200, linger: { ms: 60_000, ignoreTerm: true, startupMs: 500 } });
    const result = await runDriver(dir, {
      nextFrom,
      settleMs: 0,
      stopGraceMs: 200,
      stopWaitMs: 1_000,
    });
    expect(result).toMatchObject({
      status: 1,
      problems: ['next build: a process it started was still running after it exited; refusing'],
    });
    expect(alive(Number(readFileSync(join(dir, 'linger.pid'), 'utf8')))).toBe(false);
    expect(existsSync(join(dir, LOCK))).toBe(false);
  });

  it('R4-3: prompt TERM termination is confirmed separately from an explicitly unconfirmable probe', async () => {
    const dir = app({ holdMs: 200, linger: { ms: 60_000, startupMs: 500 } });
    const result = await runDriver(dir, {
      nextFrom,
      settleMs: 0,
      stopGraceMs: 1_000,
      stopWaitMs: 1_000,
    });
    expect(result).toMatchObject({
      status: 1,
      problems: ['next build: a process it started was still running after it exited; refusing'],
    });
    expect(existsSync(join(dir, LOCK))).toBe(false);
    expect(alive(Number(readFileSync(join(dir, 'linger.pid'), 'utf8')))).toBe(false);
  });

  it('(C) the wrapper killed with SIGKILL after publication: the lock stays held while the build lives, and recovery waits for it (fail closed)', async () => {
    const dir = app({ holdMs: 60_000 });
    const driver = startDriver(dir, { nextFrom, recordChild: join(dir, 'child.json') });
    await waitFor(() => ran(dir).length === 1);
    driver.signal('SIGKILL');
    await driver.done;
    const { pid, group } = record(dir);
    expect(inProgress(dir)).toBe(true);
    const b = await runDriver(dir, { nextFrom, lockWaitMs: 1_000 });
    expect(b.status).toBe(1);
    expect(b.problems).toEqual([expect.stringContaining('build lock: another build')]);
    expect(ran(dir)).toEqual([pid]);
    expect(alive(group)).toBe(true); // orphan leader still reserves the PGID while writers live
    expect(await driver.root('SIGTERM')).toBe(true);
    await waitFor(() => !alive(-group));
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
    // Explicit uncertainty, independent of whether TERM happens to stop the writer promptly.
    const dir = app({ linger: { ms: 60_000 } });
    const result = await runDriver(dir, {
      nextFrom,
      settleMs: 0,
      stopGraceMs: 0,
      stopWaitMs: 500,
      unconfirmableProbe: true,
      recordChild: join(dir, 'child.json'),
    });
    // Startup and fixture readiness are outside the shutdown budget. Measure from
    // the first TERM request in the driver, not before its Node process even starts.
    expect(result.shutdownElapsedMs).toBeLessThan(2_500);
    expect(result).toMatchObject({
      status: 1,
      problems: [
        'build: processes of this build could not be confirmed stopped; the build lock is kept; refusing',
      ],
    });
    expect(existsSync(join(dir, LOCK))).toBe(true);
    expect(existsSync(join(dir, '.next/server-action-build-receipt.json'))).toBe(false);
    // It was sent SIGKILL: once the group is gone, the kept lock is free, and not before.
    const { group } = record(dir);
    await waitFor(() => !alive(-group));
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
    if (faultSpec) {
      // Fatal preload persistence faults kill the supervisor too. Assert LOST at
      // the test lifecycle boundary instead of silently accepting that EOF.
      await expect(cleanupFixtures()).rejects.toThrow('fixture cleanup failed');
    }
    return { dir, ...result };
  };
  const REFUSED = [
    'next config: a build process could not write its report; refusing',
    'build: processes of this build could not be confirmed stopped; the build lock is kept; refusing',
  ];

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
      expect(existsSync(join(dir, LOCK))).toBe(true);
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
