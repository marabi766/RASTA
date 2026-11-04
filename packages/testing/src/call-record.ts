/**
 * Recording what a set of Jest spies were called with, in a form that outlives
 * their restore.
 *
 * `spy.mockRestore()` is `mockReset()` plus un-patching: it empties
 * `spy.mock.calls`. A capture helper that restores in a `finally` and hands the
 * spy (or a reader over it) back to the test therefore hands back an empty
 * history, and every `not.toHaveBeenCalled()` / `not.toContain(secret)` made on
 * it passes whatever the code under test did (FU-042, Codex review of #624).
 *
 * {@link recordCalls} closes that by construction: `restore()` takes the
 * snapshot first and `calls()` answers from it afterwards, so the order of
 * "restore" and "assert" cannot change what an assertion reads. Imports
 * nothing: the spies are structural, so any Jest spy fits.
 */

/** The part of a Jest spy this module reads and restores. */
export interface SpyLike {
  readonly mock: { readonly calls: readonly (readonly unknown[])[] };
  mockRestore(): unknown;
}

export interface CallRecord {
  /** Every call to every spy, spy by spy in the order given; after `restore()` the snapshot taken by it. */
  calls(): unknown[][];
  /** Snapshot the calls, then restore every spy (each one, even if an earlier restore threw). Idempotent. */
  restore(): void;
}

export function recordCalls(spies: readonly SpyLike[]): CallRecord {
  let snapshot: unknown[][] | undefined;
  const live = (): unknown[][] => spies.flatMap((spy) => spy.mock.calls.map((call) => [...call]));
  return {
    calls: () => snapshot ?? live(),
    restore() {
      if (snapshot) return;
      snapshot = live();
      const failures: unknown[] = [];
      for (const spy of spies) {
        try {
          spy.mockRestore();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length > 0) throw failures[0];
    },
  };
}
