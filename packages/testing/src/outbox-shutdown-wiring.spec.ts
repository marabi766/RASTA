import {
  publisherCloseProblems,
  runOutboxShutdownProvider,
  type ParticipantStop,
} from './outbox-shutdown-wiring';

const ENV = Symbol('ENV');
class Relay {}
class Purge {}
class Publisher {}

/** A coordinator shaped like `OutboxShutdown`, whose order the test chooses. */
function provider(order: 'after' | 'beside', options: { deadlines?: 'one' | 'two' } = {}) {
  return {
    inject: [Relay, Purge, Publisher, ENV],
    useFactory: (...args: unknown[]) => {
      const [relay, purge, publisher, env] = args as [
        { stop(o: { deadlineAt: number }): Promise<void> },
        { stop(o: { deadlineAt: number }): Promise<void> },
        { stop(o: { deadlineAt: number }): Promise<void> },
        { SHUTDOWN_TIMEOUT_MS: number },
      ];
      let stopping: Promise<void> | undefined;
      const drain = async () => {
        const deadlineAt = 1000 + env.SHUTDOWN_TIMEOUT_MS;
        const publisherDeadline = options.deadlines === 'two' ? deadlineAt + 1 : deadlineAt;
        if (order === 'beside') {
          await Promise.all([
            relay.stop({ deadlineAt }),
            purge.stop({ deadlineAt }),
            publisher.stop({ deadlineAt: publisherDeadline }),
          ]);
        } else {
          await Promise.all([relay.stop({ deadlineAt }), purge.stop({ deadlineAt })]);
          await publisher.stop({ deadlineAt: publisherDeadline });
        }
      };
      return { stop: () => (stopping ??= drain()) };
    },
  };
}

const run = (p: ReturnType<typeof provider>): Promise<ParticipantStop[]> =>
  runOutboxShutdownProvider(p, { env: { SHUTDOWN_TIMEOUT_MS: 5000 }, envToken: ENV });

describe('outbox shutdown wiring helpers', () => {
  it('a publisher closed after the drain, by its deadline, once: no problem', async () => {
    const stops = await run(provider('after'));
    expect(stops.map((stop) => stop.token)).toEqual([Relay, Purge, Publisher]);
    expect(publisherCloseProblems(stops, Publisher)).toEqual([]);
  });

  it('a publisher closed beside the drain is reported, participant by participant', async () => {
    const stops = await run(provider('beside'));
    expect(publisherCloseProblems(stops, Publisher)).toEqual([
      "the publisher is closed before Relay's stop returned",
      "the publisher is closed before Purge's stop returned",
    ]);
  });

  it('a publisher with a deadline of its own is reported', async () => {
    const stops = await run(provider('after', { deadlines: 'two' }));
    expect(publisherCloseProblems(stops, Publisher)).toEqual([
      'the participants do not share one deadline: 6000, 6001',
    ]);
  });

  it('a publisher the coordinator does not close is reported', () => {
    const stops: ParticipantStop[] = [{ token: Relay, deadlineAt: 1, after: [] }];
    expect(publisherCloseProblems(stops, Publisher)).toEqual([
      'the publisher is stopped 0 time(s), not once',
    ]);
  });

  it('a participant stopped twice is reported', () => {
    const stops: ParticipantStop[] = [
      { token: Relay, deadlineAt: 1, after: [] },
      { token: Relay, deadlineAt: 1, after: [] },
      { token: Publisher, deadlineAt: 1, after: [Relay] },
    ];
    expect(publisherCloseProblems(stops, Publisher)).toEqual(['Relay is stopped more than once']);
  });

  describe('the database pools (Codex r2 on #458)', () => {
    class Pool {}
    const stopsOf = (order: Array<[unknown, unknown[]]>): ParticipantStop[] =>
      order.map(([token, after]) => ({ token, deadlineAt: 6000, after }));

    it('pools closed last — after the drain and the publisher — are no problem', () => {
      const stops = stopsOf([
        [Relay, []],
        [Purge, []],
        [Publisher, [Relay, Purge]],
        [Pool, [Relay, Purge, Publisher]],
      ]);
      expect(publisherCloseProblems(stops, Publisher, [Pool])).toEqual([]);
    });

    it('a pool closed beside a participant still running is reported', () => {
      const stops = stopsOf([
        [Relay, []],
        [Pool, []],
        [Purge, []],
        [Publisher, [Relay, Purge]],
      ]);
      expect(publisherCloseProblems(stops, Publisher, [Pool])).toEqual([
        "Pool is closed before Relay's stop returned",
        "Pool is closed before Purge's stop returned",
        "Pool is closed before Publisher's stop returned",
      ]);
    });

    it('a pool the coordinator never closes is reported', () => {
      const stops = stopsOf([
        [Relay, []],
        [Publisher, [Relay]],
      ]);
      expect(publisherCloseProblems(stops, Publisher, [Pool])).toEqual(['Pool is never closed']);
    });
  });
});
