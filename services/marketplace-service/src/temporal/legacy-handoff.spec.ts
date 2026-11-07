import { handOff, isQuiet, queryQuiet, type HandoffHandle } from '../../test/legacy-handoff';

type Events = Parameters<typeof isQuiet>[0];
const ev = (eventId: number, attributes: Record<string, unknown> = {}) => ({
  eventId,
  ...attributes,
});
const scheduled = (id: number) => ev(id, { activityTaskScheduledEventAttributes: {} });
const completed = (id: number, of: number) =>
  ev(id, { activityTaskCompletedEventAttributes: { scheduledEventId: of } });
const timer = (id: number) => ev(id, { timerStartedEventAttributes: {} });
const taskDone = (id: number) => ev(id, { workflowTaskCompletedEventAttributes: {} });
const taskStarted = (id: number) => ev(id, { workflowTaskStartedEventAttributes: {} });
const taskScheduled = (id: number) => ev(id, { workflowTaskScheduledEventAttributes: {} });

describe('isQuiet: a history with nothing in flight (FU-147, FU-192)', () => {
  const cases: [string, unknown[], boolean][] = [
    ['empty', [], false],
    ['ends in an armed timer', [taskDone(4), timer(5)], true],
    ['ends in an answered task with no command', [timer(5), taskDone(9)], true],
    ['ends in a scheduled workflow task', [timer(5), taskScheduled(6)], false],
    ['ends in a started workflow task', [timer(5), taskScheduled(6), taskStarted(7)], false],
    ['an activity still running', [scheduled(5), taskDone(9)], false],
    ['an activity answered', [scheduled(5), completed(6, 5), taskDone(9)], true],
  ];
  it.each(cases)('%s', (_name, events, expected) => {
    expect(isQuiet(events as Events)).toBe(expected);
  });
});

/** A handle whose history ends in a started task until `settle()` is called and `lag` more reads pass. */
function handleWith(lag: number) {
  let settled = false;
  let reads = 0;
  let queriedAt = -1;
  const handle = {
    fetchHistory: async () => {
      reads += 1;
      if (queriedAt >= 0 && reads - queriedAt > lag) settled = true;
      return { events: [timer(5), ...(settled || queriedAt < 0 ? [] : [taskStarted(7)])] };
    },
    query: async () => {
      queriedAt = reads;
      return { phase: 'AWAITING_CONFIRMATION' };
    },
  } as unknown as HandoffHandle;
  return { handle, settled: () => settled, queried: () => queriedAt >= 0 };
}

describe('handing a cacheless worker over', () => {
  it('stops only from a quiet history that the final query left behind', async () => {
    const { handle, settled } = handleWith(3);
    await handOff(handle, () => queryQuiet(handle, 'status'));
    expect(settled()).toBe(true);
  });

  it('asks only once the history is quiet', async () => {
    let reads = 0;
    const query = jest.fn(async () => reads);
    const handle = {
      fetchHistory: async () => ({
        events: reads++ < 2 ? [timer(5), taskStarted(7)] : [timer(5), taskDone(8)],
      }),
      query,
    } as unknown as HandoffHandle;
    await expect(queryQuiet(handle, 'status')).resolves.toBeGreaterThanOrEqual(3);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('returns what the drive returned', async () => {
    const { handle } = handleWith(0);
    await expect(handOff(handle, async () => 'driven')).resolves.toBe('driven');
  });
});
