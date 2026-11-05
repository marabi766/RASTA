import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from '@temporalio/worker';

/**
 * `orderSaga` replays histories its previous release recorded (D-083).
 *
 * A saga runs for weeks, so every change to its commands meets histories the
 * old code wrote: on the next workflow task after a deploy, the new code
 * re-executes each one from the start and must issue exactly the commands it
 * records, or the run fails with a nondeterminism error and the order stops
 * with its money held. D-083 changed the waits — a window is now a deadline
 * kept across a dispute (`DISPUTE_RESUME_PATCH`), the dispute wait also ends
 * on a new dispute, and a pre-receipt status mirrors a decided dispute before
 * it waits — and each change is guarded so an old history replays as it ran.
 *
 * The histories are main's `orderSaga` as it was before D-083, run against
 * Temporal's time-skipping server and saved with the SDK's own
 * `historyToJSON` (host identity replaced):
 *
 * - `settled` — fulfilment and receipt reminders, a dispute raised before
 *   receipt and settled the old way (to RECEIPT_CONFIRMED), then settlement.
 * - `disputed` — still waiting in a dispute raised at CONFIRMED when the
 *   release changes: the in-flight case the deploy actually meets.
 * - `resumed` — the rollout's overlap: a new API pod resumed a dispute to
 *   CONFIRMED and a worker of the previous release carried the saga on, so
 *   the history waits at CONFIRMED with the dispute still mirrored and
 *   releases it only at RECEIPT_CONFIRMED. The new code must not add its
 *   resume-time release there (`mirrorResumed` is behind the patch).
 *
 * No server is needed: `runReplayHistory` replays locally and throws on any
 * divergence.
 */

jest.setTimeout(120_000);

function history(name: string): unknown {
  const file = join(__dirname, '__fixtures__', `order-saga-pre-d083-${name}.history.json`);
  return JSON.parse(readFileSync(file, 'utf8'));
}

describe('orderSaga replays histories recorded before D-083', () => {
  it.each(['settled', 'disputed', 'resumed'])(
    'the %s history replays without divergence',
    async (name) => {
      await expect(
        Worker.runReplayHistory(
          { workflowsPath: require.resolve('./workflows') },
          history(name),
          `legacy-${name}`,
        ),
      ).resolves.toBeUndefined();
    },
  );
});
