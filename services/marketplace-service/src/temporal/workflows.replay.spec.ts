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

function fixture(name: string): unknown {
  const file = join(__dirname, '__fixtures__', `order-saga-${name}.history.json`);
  return JSON.parse(readFileSync(file, 'utf8'));
}
const history = (name: string): unknown => fixture(`pre-d083-${name}`);

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

/**
 * The release wait (FU-080). `pre-fu080-release-refused` is the code before it
 * (#625's head `dfa48a55`): a release refused, and the saga failed there. The
 * new code must end the same way, not wait. `fu080-release-wait` is the code
 * with it: the same refusal, its marker and report, a backoff, the release
 * confirmed, and the saga on to its end. Its markers also feed the drain gate's
 * test, as the real SDK's shape of them.
 */
describe('orderSaga replays histories on both sides of the release wait', () => {
  it.each([
    'pre-fu080-release-refused',
    'fu080-release-wait',
    // FU-103, the same pair: before it, authorisation exhausted ended the run
    // (`7ac5e936`), and the new code must end the same way; with it, the wait.
    'pre-fu103-authorise-exhausted',
    'fu103-authorise-wait',
    // FU-117: each site before it (`0a3b973a`) ended the run, and must replay that
    // end. So must protocol 4's own history, carrying the
    // FU-103 marker from an authorisation and then ending at the refund or the
    // filing: the reason these sites have a marker of their own. With it, the wait.
    'pre-fu117-compensate-exhausted',
    'pre-fu117-dispute-exhausted',
    'fu103-wait-then-refund-exhausted',
    'fu103-wait-then-dispute-exhausted',
    'fu117-compensate-wait',
    'fu117-dispute-wait',
    // #796 r1: each exit below ended the run before the owed-work marker (`38d0ca5d`,
    // protocol 5), and must replay that end, or a filing sent without doubt. With it,
    // the waits and the owner's answer, to their ends.
    'pre-fu117r2-lookup-refused',
    'pre-fu117r2-lookup-not-held',
    'pre-fu117r2-lookup-mismatch',
    'pre-fu117r2-cancel-refused',
    'pre-fu117r2-filing-final',
    'pre-fu117r2-compensate-final',
    'pre-fu117r2-settle-then-filing-refused',
    'pre-fu117r2-read-refused-mirrored',
    'pre-fu117r2-settled-not-recorded',
    'pre-fu117r2-settling-refused',
    'pre-fu117r2-reminder-refused',
    'fu117r2-lookup-then-cancel-wait',
    'fu117r2-filing-final-then-cancel',
    'fu117r2-settled-reconciliation',
    'fu117r2-settle-doubt-filing',
    // #796 r2 F5: what this build records. The marker commits with the call that may
    // answer final (above, it followed the answer, as no history in service does).
    'fu117r3-declared-filing-release-refund',
    'fu117r3-declared-authorise-final',
  ])('the %s history replays without divergence', async (name) => {
    await expect(
      Worker.runReplayHistory(
        { workflowsPath: require.resolve('./workflows') },
        fixture(name),
        name,
      ),
    ).resolves.toBeUndefined();
  });
});
