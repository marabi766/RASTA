/**
 * The scenario's own logical clock.
 *
 * Never `Date.now()`. A presentation that runs twice — once rehearsed at
 * 10am and once live at 2pm — must produce byte-identical timestamps in its
 * activity log for the two runs to be comparable at all, and a wall-clock
 * read would make every snapshot a function of when it happened to be taken.
 * `SCENARIO_EPOCH` matches `fixtures.ts`'s `T.now`, so a scenario event and a
 * static fixture timestamp read as the same story rather than two.
 */
export const SCENARIO_EPOCH = '2026-09-05T12:00:00.000Z';

const STEP_MINUTES = 15;

/** The next logical instant, deterministic given the current one. */
export function advanceClock(currentIso: string): string {
  const next = Date.parse(currentIso) + STEP_MINUTES * 60_000;
  return new Date(next).toISOString();
}
