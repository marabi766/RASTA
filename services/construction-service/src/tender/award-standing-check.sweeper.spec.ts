import type { AwardStandingCheckRepository, ClaimedCheck } from './award-standing-check.repository';
import type {
  AwardStandingCheckService,
  StandingCheckResult,
} from './award-standing-check.service';
import { AwardStandingCheckSweeper } from './award-standing-check.sweeper';

/**
 * D-052: the standing-check sweep stops with the relay and the purge, in the
 * destroy phase, by their shared deadline — no new check once stopping, and no
 * wait past the deadline for the one being made. What a sweep does with what it
 * claimed is proven against the database by the integration suites.
 */

const INTERVAL_MS = 5000;

const claim = (id: string): ClaimedCheck => ({
  id,
  organizationId: `ORG_${id}`,
  tenderId: `TND_${id}`,
  projectId: `PRJ_${id}`,
  bidId: `BID_${id}`,
  winnerOrganizationId: `ORG_W${id}`,
  awardedBy: 'USR_1',
  awardedAt: new Date('2026-10-01T10:00:00.000Z'),
  windowStart: new Date('2026-09-01T10:00:00.000Z'),
  fence: 'F1',
  attempts: 0,
});

function sweeperWith(claimed: ClaimedCheck[]) {
  const claimDue = jest.fn(async () => claimed);
  const process = jest.fn(async (_claim: ClaimedCheck): Promise<StandingCheckResult> => 'CLEAR');
  const recordFailure = jest.fn(async () => undefined);
  const sweeper = new AwardStandingCheckSweeper(
    { claimDue } as unknown as AwardStandingCheckRepository,
    { process, recordFailure } as unknown as AwardStandingCheckService,
    {
      intervalMs: INTERVAL_MS,
      batchSize: 7,
      leaseSeconds: 45,
      retryBackoffBaseSeconds: 10,
      retryBackoffMaxSeconds: 900,
    },
  );
  return { sweeper, claimDue, process };
}

describe('AwardStandingCheckSweeper.stop', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  /** A sweep the timer started over three checks, held in making the first. */
  async function heldInTheFirstCheck() {
    const built = sweeperWith([claim('A'), claim('B'), claim('C')]);
    let finish: () => void = () => undefined;
    built.process.mockImplementationOnce(
      () =>
        new Promise<StandingCheckResult>((resolve) => {
          finish = () => resolve('CLEAR');
        }),
    );
    built.sweeper.start();
    await jest.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(built.process).toHaveBeenCalledTimes(1);
    return { ...built, finish: () => finish() };
  }

  it('starts no further check once stopping, and waits for the one being made', async () => {
    const { sweeper, process, finish } = await heldInTheFirstCheck();

    let stopped = false;
    const stopping = sweeper.stop({ deadlineAt: Date.now() + 5000 }).then(() => {
      stopped = true;
    });
    await jest.advanceTimersByTimeAsync(100);
    expect(stopped).toBe(false);

    finish();
    await stopping;
    expect(process).toHaveBeenCalledTimes(1);
    expect(process.mock.calls[0]?.[0]).toMatchObject({ id: 'A' });
  });

  it('returns by the deadline when the check in flight never finishes', async () => {
    const { sweeper } = await heldInTheFirstCheck();

    let stopped = false;
    const stopping = sweeper.stop({ deadlineAt: Date.now() + 300 }).then(() => {
      stopped = true;
    });
    await jest.advanceTimersByTimeAsync(299);
    expect(stopped).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    await stopping;
    expect(stopped).toBe(true);
  });

  it('clears its timer, returns at once when idle, and is one stop', async () => {
    const { sweeper, claimDue } = sweeperWith([]);
    sweeper.start();

    const first = sweeper.stop({ deadlineAt: Date.now() + 1000 });
    expect(sweeper.stop()).toBe(first);
    await first;
    sweeper.start(); // not once stopped
    await jest.advanceTimersByTimeAsync(3 * INTERVAL_MS);
    expect(claimDue).not.toHaveBeenCalled();
  });
});
