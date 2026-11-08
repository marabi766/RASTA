import type { ChildProcess } from 'node:child_process';

/**
 * The lifetime of a fixture's processes (FU-216 F1). Every process a case starts is registered
 * the moment it is spawned, BEFORE anything can fail, and `teardown()` ends and JOINS all of them
 * within a deadline: a join that cannot be proven is REPORTED (an `AggregateError` thrown from the
 * hook that called it), never swallowed, and the caller removes nothing the processes may still
 * use unless `teardown()` returned.
 *
 * A process the case did not start itself (an owner its parent spawned) cannot be signalled by a
 * saved pid. It has an owned shutdown channel instead — `signal()`, e.g. a file it polls — and the
 * fixture observes its end with `watch()`; the pid is read only to observe, never to signal.
 */
export interface OwnedProcesses {
  /** Registers a child at spawn; returns it with a promise of its exit. */
  own(child: ChildProcess): { child: ChildProcess; exited: Promise<number | null> };
  /** A shutdown request to a process this fixture cannot signal directly; runs first. */
  signal(request: () => void | Promise<void>): void;
  /** `ended()` must become true by the deadline; `what` names it in the report. */
  watch(what: string, ended: () => boolean): void;
  /** Runs after every process is joined (e.g. the sweep that releases held writers). */
  afterJoin(step: () => void | Promise<void>): void;
  /**
   * The WHOLE teardown is capped by `ms`: shutdown requests are cut off at the deadline; watches,
   * kill joins and cleanup steps end at the deadline too, but never before a short grace of their
   * own (watches at least 1000 ms after they began, so an owner is never given up after a single
   * poll; joins at least 500 ms after the kill; steps at least 1000 ms after the cleanup began).
   * Every grace is a FLOOR, never a choice made by comparing the clock with the deadline: a timer
   * armed for the deadline fires up to 1 ms before the clock reaches it (FU-263), and a phase
   * that ends 1 ms before the deadline needs the grace as much as one that ends after it. What is
   * still running is SIGKILLed, the cleanup steps still run, and the leftover is REPORTED.
   * Whatever is registered while it runs (a case body the runner abandoned keeps calling `own()`) is drained in further
   * rounds against the same deadline (at most 5; registrations that never stop are reported).
   */
  teardown(ms?: number): Promise<void>;
  /**
   * True while anything is registered and not yet torn down (children, shutdown requests, watches,
   * cleanup steps), while a teardown runs, and for good once one failed (its leftovers are no
   * longer tracked anywhere, so no later clean teardown can vouch for them). A hook that the test
   * runner abandons on its own timeout never reaches its `catch`, so the leftovers guard (the one
   * that keeps the fixture root) reads this instead of a flag set after the await. Concurrent
   * `teardown()` calls share the one running teardown and its result; a call that arrives while it
   * runs is covered by it, including what was registered after it began.
   */
  readonly unjoined: boolean;
}

/** A SIGKILLed process is gone within this even when the budget is spent. */
const JOIN_GRACE_MS = 500;
/** A watched owner is observed for this long when the budget is already spent: it is not orphaned. */
const WATCH_GRACE_MS = 1_000;
/** A cleanup step runs for this long even when the budget is spent. */
const STEP_GRACE_MS = 1_000;
/** Registrations that never stop cannot hold a teardown for ever. */
const MAX_ROUNDS = 5;
const bound = (ms: number, grace: number, from: string): string =>
  `${ms} ms deadline (at least ${grace} ms after ${from})`;

export function ownedProcesses(): OwnedProcesses {
  const children: { child: ChildProcess; exited: Promise<number | null> }[] = [];
  const signals: (() => void | Promise<void>)[] = [];
  const watched: { what: string; ended: () => boolean }[] = [];
  const steps: (() => void | Promise<void>)[] = [];
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  // Monotonic, like the timers: a wall-clock step (NTP) can neither spend nor stretch the budget.
  const now = (): number => performance.now();
  const settled = (child: ChildProcess): boolean =>
    child.exitCode !== null || child.signalCode !== null;

  const registered = (): number => children.length + signals.length + watched.length + steps.length;
  let running: Promise<void> | undefined;
  let failed = false; // sticky: a failed teardown's leftovers are not tracked any more
  return {
    get unjoined() {
      return running !== undefined || failed || registered() > 0;
    },
    own(child) {
      const exited = new Promise<number | null>((resolve) => {
        if (settled(child)) resolve(child.exitCode);
        else child.once('exit', (code) => resolve(code));
      });
      const owned = { child, exited };
      children.push(owned);
      return owned;
    },
    signal: (request) => void signals.push(request),
    watch: (what, ended) => void watched.push({ what, ended }),
    afterJoin: (step) => void steps.push(step),
    teardown(ms = 15_000) {
      // Concurrent calls share one teardown: none can report "joined" while another still runs.
      running ??= drain(ms).then(
        () => void (running = undefined),
        (error) => {
          failed = true;
          running = undefined;
          throw error;
        },
      );
      return running;
    },
  };

  async function drain(ms: number): Promise<void> {
    const deadline = now() + ms;
    const failures: Error[] = [];
    for (let n = 0; registered() > 0; n += 1) {
      if (n === MAX_ROUNDS) {
        failures.push(
          new Error(`registrations kept arriving: not drained after ${MAX_ROUNDS} rounds`),
        );
        break; // still registered, so `unjoined` stays true
      }
      await round(deadline, ms, failures);
    }
    if (failures.length > 0) throw new AggregateError(failures, 'fixture processes not joined');
  }

  async function round(deadline: number, ms: number, failures: Error[]): Promise<void> {
    const attempt = async (what: string, step: () => void | Promise<void>): Promise<void> => {
      try {
        await step();
      } catch (error) {
        failures.push(new Error(`${what}: ${(error as Error).message}`));
      }
    };
    // One deadline for every phase: a request that never settles is cut off and reported.
    for (const request of signals.splice(0)) {
      let timer: NodeJS.Timeout | undefined;
      const timedOut = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`did not finish by the ${ms} ms deadline`)),
          Math.max(deadline - now(), 0),
        );
      });
      await attempt('shutdown request', () =>
        Promise.race([Promise.resolve().then(request), timedOut]),
      ).finally(() => clearTimeout(timer));
    }
    // Watched processes first: a parent must not be killed before the process it spawned is
    // known to have ended, or that process is orphaned out of reach. The grace is a floor (FU-263):
    // `deadline` alone leaves 0-1 ms, one poll, whenever the requests ended just before it.
    const watchEnd = Math.max(deadline, now() + WATCH_GRACE_MS);
    for (const { what, ended } of watched.splice(0)) {
      let done = false;
      for (;;) {
        try {
          done = ended();
        } catch (error) {
          failures.push(new Error(`${what}: ${(error as Error).message}`));
          done = true; // reported; nothing more can be observed
        }
        if (done || now() >= watchEnd) break;
        await sleep(25);
      }
      if (!done)
        failures.push(
          new Error(
            `${what}: still running at the ${bound(ms, WATCH_GRACE_MS, 'the watches began')}`,
          ),
        );
    }
    // Everything still running is killed at once (our own handles), then joined within what is
    // left of the SAME budget: N stuck processes cost one budget, not N.
    const pending = children.splice(0);
    for (const { child } of pending) if (!settled(child)) child.kill('SIGKILL');
    const joins = pending.map(async ({ child, exited }) => {
      const joined = await Promise.race([
        exited.then(() => true),
        sleep(Math.max(deadline - now(), JOIN_GRACE_MS)).then(() => false),
      ]);
      if (!joined)
        failures.push(
          new Error(
            `process ${child.pid}: did not exit by the ${bound(ms, JOIN_GRACE_MS, 'the kill')}`,
          ),
        );
    });
    await Promise.all(joins);
    // The cleanup steps always run (they release what the processes held); a short grace beyond
    // the budget keeps a hung step from holding the hook past its own timeout.
    const stepEnd = Math.max(deadline, now() + STEP_GRACE_MS);
    for (const step of steps.splice(0)) {
      const left = Math.max(stepEnd - now(), 0);
      let timer: NodeJS.Timeout | undefined;
      const timedOut = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(`not finished by the ${bound(ms, STEP_GRACE_MS, 'the cleanup began')}`),
            ),
          left,
        );
      });
      await attempt('cleanup', () =>
        Promise.race([Promise.resolve().then(step), timedOut]),
      ).finally(() => clearTimeout(timer));
    }
  }
}
