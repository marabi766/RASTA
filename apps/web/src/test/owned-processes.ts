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
  teardown(ms?: number): Promise<void>;
}

export function ownedProcesses(): OwnedProcesses {
  const children: { child: ChildProcess; exited: Promise<number | null> }[] = [];
  const signals: (() => void | Promise<void>)[] = [];
  const watched: { what: string; ended: () => boolean }[] = [];
  const steps: (() => void | Promise<void>)[] = [];
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  const settled = (child: ChildProcess): boolean =>
    child.exitCode !== null || child.signalCode !== null;

  return {
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
    async teardown(ms = 15_000) {
      const failures: Error[] = [];
      const attempt = async (what: string, run: () => void | Promise<void>): Promise<void> => {
        try {
          await run();
        } catch (error) {
          failures.push(new Error(`${what}: ${(error as Error).message}`));
        }
      };
      for (const request of signals.splice(0)) await attempt('shutdown request', request);
      // Watched processes first: a parent must not be killed before the process it spawned is
      // known to have ended, or that process is orphaned out of reach.
      const deadline = Date.now() + ms;
      for (const { what, ended } of watched.splice(0)) {
        let done = false;
        for (;;) {
          try {
            done = ended();
          } catch (error) {
            failures.push(new Error(`${what}: ${(error as Error).message}`));
            done = true; // reported; nothing more can be observed
          }
          if (done || Date.now() >= deadline) break;
          await sleep(25);
        }
        if (!done)
          failures.push(new Error(`${what}: still running ${ms} ms after its shutdown request`));
      }
      for (const { child, exited } of children.splice(0)) {
        if (!settled(child)) child.kill('SIGKILL'); // our own handle
        const joined = await Promise.race([exited.then(() => true), sleep(ms).then(() => false)]);
        if (!joined)
          failures.push(new Error(`process ${child.pid}: did not exit ${ms} ms after SIGKILL`));
      }
      for (const step of steps.splice(0)) await attempt('cleanup', step);
      if (failures.length > 0) throw new AggregateError(failures, 'fixture processes not joined');
    },
  };
}
