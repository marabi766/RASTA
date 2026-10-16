import type { OrganizationDirectory } from '../organization/organization-directory';
import type {
  ClaimedTask,
  PolicyReconciliationRepository,
} from './policy-reconciliation.repository';
import { PolicyReconciliationSweeper } from './policy-reconciliation.sweeper';
import type { PolicySuspensionService } from './policy-suspension.service';

/**
 * D-052: the reconciliation sweep stops with the relay and the purge, in the
 * destroy phase, by their shared deadline — no new task once stopping, and no
 * wait past the deadline for the one being worked. What a sweep does with what
 * it claimed is proven against the database by the integration suites.
 */

const INTERVAL_MS = 1000;

const task = (id: string, organizationId: string): ClaimedTask => ({
  id,
  organizationId,
  policyId: `APL_${id}`,
  unionId: 'ORG_U',
  sourceEventId: 'EVT_1',
  movedOrganizationId: organizationId,
  correlationId: `COR_${id}`,
  attempts: 0,
  generation: 0,
  leaseToken: 'TOKEN',
});

function build(tasks: ClaimedTask[]) {
  const reconciliations = {
    claimDue: jest.fn(async () => tasks),
    markDone: jest.fn(async () => true),
    backlog: jest.fn(async () => ({ open: 1, due: 1, oldestDueAgeSeconds: 1 })),
  };
  const directory = { isWithin: jest.fn(async (): Promise<boolean> => true) };
  const sweeper = new PolicyReconciliationSweeper(
    reconciliations as unknown as PolicyReconciliationRepository,
    {} as unknown as PolicySuspensionService,
    directory as unknown as OrganizationDirectory,
    {
      intervalMs: INTERVAL_MS,
      batchSize: 10,
      leaseSeconds: 60,
      backoffSeconds: 30,
      backoffMaxSeconds: 100,
    },
  );
  return { sweeper, reconciliations, directory };
}

describe('PolicyReconciliationSweeper.stop', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  /** A sweep the timer started over three tasks, held in the first one's question. */
  async function heldInTheFirstTask() {
    const built = build([task('PRT_1', 'ORG_E'), task('PRT_2', 'ORG_F'), task('PRT_3', 'ORG_G')]);
    let answer: () => void = () => undefined;
    built.directory.isWithin.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          answer = () => resolve(true);
        }),
    );
    built.sweeper.start();
    await jest.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(built.directory.isWithin).toHaveBeenCalledTimes(1);
    return { ...built, answer: () => answer() };
  }

  it('starts no further task once stopping, and waits for the one in flight', async () => {
    const { sweeper, reconciliations, directory, answer } = await heldInTheFirstTask();

    let stopped = false;
    const stopping = sweeper.stop({ deadlineAt: Date.now() + 5000 }).then(() => {
      stopped = true;
    });
    await jest.advanceTimersByTimeAsync(100);
    expect(stopped).toBe(false);

    answer();
    await stopping;
    expect(reconciliations.markDone).toHaveBeenCalledTimes(1);
    expect(directory.isWithin).toHaveBeenCalledTimes(1);
  });

  it('returns by the deadline when the task in flight never finishes', async () => {
    const { sweeper } = await heldInTheFirstTask();

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
    const { sweeper, reconciliations } = build([]);
    sweeper.start();

    const first = sweeper.stop({ deadlineAt: Date.now() + 1000 });
    expect(sweeper.stop()).toBe(first);
    await first;
    sweeper.start(); // not once stopped
    await jest.advanceTimersByTimeAsync(3 * INTERVAL_MS);
    expect(reconciliations.claimDue).not.toHaveBeenCalled();
  });
});
