import type { ClaimedTender, TenderCloseRepository } from './tender-close.repository';
import type { CloseResult, TenderCloseService } from './tender-close.service';
import { TenderCloseSweeper } from './tender-close.sweeper';

/**
 * What a sweep does with what it claimed — the bound on it and the way one tender's
 * failure is kept from stalling the rest. The database behaviour (claim, fence, clock,
 * races) is in `test/tender-close.int-spec.ts`.
 */

const claim = (id: string): ClaimedTender => ({ id, organizationId: `ORG_${id}`, fence: 'F1' });

function sweeperWith(claimed: ClaimedTender[], results: Record<string, CloseResult | Error>) {
  const claimDue = jest.fn().mockResolvedValue(claimed);
  const close = jest.fn(async (target: { tenderId: string }) => {
    const result = results[target.tenderId] ?? 'CLOSED';
    if (result instanceof Error) throw result;
    return result;
  });
  const sweeper = new TenderCloseSweeper(
    { claimDue } as unknown as TenderCloseRepository,
    { close } as unknown as TenderCloseService,
    { intervalMs: 5000, batchSize: 7, leaseSeconds: 45 },
  );
  return { sweeper, claimDue, close };
}

describe('TenderCloseSweeper', () => {
  it('claims at most the configured batch, for the configured lease, under one fence', async () => {
    const { sweeper, claimDue } = sweeperWith([], {});

    await sweeper.runOnce();

    expect(claimDue).toHaveBeenCalledWith(7, 45, expect.stringMatching(/^[0-9A-Z]{26}$/));
  });

  it('closes each claimed tender in its own organization, under the fence it claimed with', async () => {
    const { sweeper, close } = sweeperWith([claim('A'), claim('B')], {});

    const outcome = await sweeper.runOnce();

    expect(close).toHaveBeenCalledWith({ organizationId: 'ORG_A', tenderId: 'A', fence: 'F1' });
    expect(close).toHaveBeenCalledWith({ organizationId: 'ORG_B', tenderId: 'B', fence: 'F1' });
    expect(outcome).toEqual({ claimed: 2, closed: 2, noop: 0, notDue: 0, lost: 0, failed: 0 });
  });

  it('counts every result, and a failure does not stall the rest of the batch', async () => {
    const { sweeper, close } = sweeperWith(
      [claim('A'), claim('B'), claim('C'), claim('D'), claim('E')],
      {
        A: 'NOOP',
        B: new Error('the database went away'),
        C: 'NOT_DUE',
        D: 'NOT_OWNER',
        E: 'CLOSED',
      },
    );

    const outcome = await sweeper.runOnce();

    expect(close).toHaveBeenCalledTimes(5);
    expect(outcome).toEqual({ claimed: 5, closed: 1, noop: 1, notDue: 1, lost: 1, failed: 1 });
  });

  it('does nothing when nothing is overdue', async () => {
    const { sweeper, close } = sweeperWith([], {});

    expect(await sweeper.runOnce()).toEqual({
      claimed: 0,
      closed: 0,
      noop: 0,
      notDue: 0,
      lost: 0,
      failed: 0,
    });
    expect(close).not.toHaveBeenCalled();
  });
});
