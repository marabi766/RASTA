import { RastaError } from '@rasta/nest-common';
import type {
  ClaimedTask,
  PolicyReconciliationRepository,
} from './policy-reconciliation.repository';
import { PolicyReconciliationSweeper } from './policy-reconciliation.sweeper';
import type { PolicySuspensionService, SuspendResult } from './policy-suspension.service';

const options = {
  intervalMs: 1000,
  batchSize: 10,
  leaseSeconds: 60,
  backoffSeconds: 30,
  backoffMaxSeconds: 100,
};

const task = (overrides: Partial<ClaimedTask> = {}): ClaimedTask => ({
  id: 'PRT_1',
  organizationId: 'ORG_E',
  policyId: 'APL_1',
  unionId: 'ORG_U',
  sourceEventId: 'EVT_1',
  movedOrganizationId: 'ORG_E',
  correlationId: 'COR_1',
  attempts: 0,
  generation: 0,
  leaseToken: 'TOKEN',
  movedAt: new Date('2026-10-06T10:00:00.000Z'),
  ...overrides,
});

function build(tasks: ClaimedTask[] = []) {
  const reconciliations = {
    claimDue: jest.fn(async () => tasks),
    markDone: jest.fn(async () => true),
    ownershipOf: jest.fn(() => ({ verify: jest.fn(), finish: jest.fn() })),
    retryLater: jest.fn(async () => 1),
    backlog: jest.fn(async () => ({ open: 1, due: 1, oldestDueAgeSeconds: 12.4 })),
  };
  const suspension = {
    suspend: jest.fn(async (): Promise<SuspendResult> => 'SUSPENDED'),
  };
  const directory = { isWithin: jest.fn(async () => false) };
  const sweeper = new PolicyReconciliationSweeper(
    reconciliations as unknown as PolicyReconciliationRepository,
    suspension as unknown as PolicySuspensionService,
    directory,
    options,
  );
  return { sweeper, reconciliations, suspension, directory };
}

describe('PolicyReconciliationSweeper (Q-83)', () => {
  it('suspends a policy whose union no longer governs, under the lease it holds, in the policy’s own tenant', async () => {
    const { sweeper, reconciliations, suspension, directory } = build([task()]);

    const outcome = await sweeper.runOnce();

    expect(directory.isWithin).toHaveBeenCalledWith('ORG_U', 'ORG_E');
    expect(suspension.suspend).toHaveBeenCalledWith(
      { id: 'APL_1', organizationId: 'ORG_E' },
      expect.objectContaining({
        reason: 'ORGANIZATION_MOVED',
        eventId: 'EVT_1',
        movedOrganizationId: 'ORG_E',
        movedAt: new Date('2026-10-06T10:00:00.000Z'),
        callerService: 'organization-service',
      }),
      expect.anything(),
    );
    expect(reconciliations.ownershipOf).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'PRT_1' }),
    );
    expect(outcome).toMatchObject({ claimed: 1, suspended: 1, confirmed: 0, retried: 0 });
  });

  it('finishes the task when the union still governs, and gives it back when a later move landed since the claim', async () => {
    const { sweeper, reconciliations, suspension, directory } = build([
      task(),
      task({ id: 'PRT_2', policyId: 'APL_2' }),
    ]);
    directory.isWithin.mockResolvedValue(true);
    reconciliations.markDone.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    const outcome = await sweeper.runOnce();

    expect(suspension.suspend).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ confirmed: 1, requeued: 1, suspended: 0 });
    // One question for the (union, organization) pair, whatever the number of tasks it answers.
    expect(directory.isWithin).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['NOTHING', { confirmed: 1, notOwned: 0, suspended: 0 }],
    ['NOT_OWNER', { confirmed: 0, notOwned: 1, suspended: 0 }],
  ] as const)('counts a suspension that answers %s', async (answer, expected) => {
    const { sweeper, suspension } = build([task()]);
    suspension.suspend.mockResolvedValue(answer);
    expect(await sweeper.runOnce()).toMatchObject(expected);
  });

  it('puts a task whose lookup failed back for later, by exponential backoff capped at the maximum, and goes on', async () => {
    const { sweeper, reconciliations, directory, suspension } = build([
      task({ attempts: 1 }),
      task({ id: 'PRT_2', policyId: 'APL_2', unionId: 'ORG_U2', attempts: 5 }),
      task({ id: 'PRT_3', policyId: 'APL_3', unionId: 'ORG_U3', attempts: 0 }),
    ]);
    directory.isWithin.mockRejectedValueOnce(
      RastaError.upstreamUnavailable('organization-service'),
    );
    directory.isWithin.mockRejectedValueOnce(new Error('boom'));
    directory.isWithin.mockResolvedValueOnce(false);

    const outcome = await sweeper.runOnce();

    expect(outcome).toMatchObject({ claimed: 3, retried: 2, suspended: 1 });
    expect(reconciliations.retryLater).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ id: 'PRT_1' }),
      'UPSTREAM_UNAVAILABLE',
      60,
    );
    expect(reconciliations.retryLater).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ id: 'PRT_2' }),
      'INTERNAL',
      100,
    );
    // One task failing never stalls the batch.
    expect(suspension.suspend).toHaveBeenCalledTimes(1);
  });

  it('survives a task it cannot even put back: the lease expires and it is taken again', async () => {
    const { sweeper, reconciliations, directory } = build([task()]);
    directory.isWithin.mockRejectedValue(new Error('down'));
    reconciliations.retryLater.mockRejectedValue(new Error('database down'));
    await expect(sweeper.runOnce()).resolves.toMatchObject({ retried: 1 });
  });

  it('reports a sweep without a backlog reading rather than failing it', async () => {
    const { sweeper, reconciliations } = build([task()]);
    reconciliations.backlog.mockRejectedValue(new Error('database down'));
    await expect(sweeper.runOnce()).resolves.toMatchObject({ claimed: 1 });
  });

  it('claims nothing, asks nothing, when nothing is due', async () => {
    const { sweeper, directory, reconciliations } = build([]);
    await expect(sweeper.runOnce()).resolves.toMatchObject({ claimed: 0 });
    expect(directory.isWithin).not.toHaveBeenCalled();
    expect(reconciliations.backlog).not.toHaveBeenCalled();
    expect(reconciliations.claimDue).toHaveBeenCalledWith(10, 60, expect.any(String));
  });

  describe('the timer', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('sweeps on its interval, never beside itself, survives a sweep that fails as a whole, and stops', async () => {
      const { sweeper, reconciliations } = build([]);
      let release: () => void = () => undefined;
      reconciliations.claimDue.mockImplementationOnce(
        () =>
          new Promise<ClaimedTask[]>((resolve) => {
            release = () => resolve([]);
          }),
      );

      sweeper.start();
      sweeper.start(); // a second start is not a second timer
      await jest.advanceTimersByTimeAsync(options.intervalMs);
      expect(reconciliations.claimDue).toHaveBeenCalledTimes(1);
      // The first sweep is still running: the next tick does not start another.
      await jest.advanceTimersByTimeAsync(options.intervalMs);
      expect(reconciliations.claimDue).toHaveBeenCalledTimes(1);

      release();
      reconciliations.claimDue.mockRejectedValueOnce(new Error('database down'));
      await jest.advanceTimersByTimeAsync(options.intervalMs);
      expect(reconciliations.claimDue).toHaveBeenCalledTimes(2);
      await jest.advanceTimersByTimeAsync(options.intervalMs);
      expect(reconciliations.claimDue).toHaveBeenCalledTimes(3);

      await sweeper.stop();
      await jest.advanceTimersByTimeAsync(options.intervalMs * 3);
      expect(reconciliations.claimDue).toHaveBeenCalledTimes(3);
    });
  });
});
