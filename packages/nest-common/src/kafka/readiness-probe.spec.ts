import {
  KAFKA_PROBE_MAX_TIMEOUT_MS,
  KafkaReadinessProbe,
  kafkaProbeTimeoutMs,
  type AdminFactory,
} from './readiness-probe';

/**
 * D-052 phase 4b, Codex r1 on #293 (F2): a readiness probe in flight while the
 * broker had stopped answering held its HTTP request, and the HTTP server's
 * close waits for open requests — past SHUTDOWN_TIMEOUT_MS. The probe now
 * answers within its bound, and at once when the shutdown begins.
 *
 * Fake timers; the admin client is a fake whose every call can be held. The
 * publishers' own specs run the probe through real kafkajs and Nest's HTTP close.
 */

type Step = 'connect' | 'listTopics' | 'disconnect';

/** An admin client per probe; each step answers, fails or is held as told. */
function adminFactory(behaviour: Partial<Record<Step, 'ok' | 'fail' | 'hang'>> = {}) {
  const calls: Step[] = [];
  let created = 0;
  const step = (name: Step) => (): Promise<never> => {
    calls.push(name);
    const how = behaviour[name] ?? 'ok';
    if (how === 'hang') return new Promise<never>(() => undefined);
    if (how === 'fail') return Promise.reject(new Error(`${name} refused`));
    return Promise.resolve(undefined as never);
  };
  const kafka: AdminFactory = {
    admin: () => {
      created += 1;
      return {
        connect: step('connect'),
        listTopics: step('listTopics') as never,
        disconnect: step('disconnect'),
      };
    },
  };
  return { kafka, calls, created: () => created };
}

const quiet = { debug: jest.fn() };

/** Lets the probe's promise chain run. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

describe('KafkaReadinessProbe', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    quiet.debug.mockClear();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('a broker that answers: healthy, and the client is closed', async () => {
    const { kafka, calls } = adminFactory();
    const probe = new KafkaReadinessProbe(kafka, { timeoutMs: 1000, logger: quiet });
    await expect(probe.check()).resolves.toBe(true);
    await settle();
    expect(calls).toEqual(['connect', 'listTopics', 'disconnect']);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('a probe that fails half-way: not healthy, and the client is still closed', async () => {
    const { kafka, calls } = adminFactory({ listTopics: 'fail' });
    const probe = new KafkaReadinessProbe(kafka, { timeoutMs: 1000, logger: quiet });
    await expect(probe.check()).resolves.toBe(false);
    await settle();
    expect(calls).toEqual(['connect', 'listTopics', 'disconnect']);
  });

  it.each(['connect', 'listTopics'] as const)(
    'a %s the broker never answers: not healthy at exactly the bound, and the client closed then',
    async (held) => {
      const { kafka, calls } = adminFactory({ [held]: 'hang' });
      const probe = new KafkaReadinessProbe(kafka, { timeoutMs: 1000, logger: quiet });
      let answer: boolean | undefined;
      void probe.check().then((healthy) => (answer = healthy));

      await jest.advanceTimersByTimeAsync(999);
      expect(answer).toBeUndefined();
      await jest.advanceTimersByTimeAsync(1);
      expect(answer).toBe(false);
      expect(calls[calls.length - 1]).toBe('disconnect');
      expect(quiet.debug).toHaveBeenCalledWith('Kafka readiness probe: no answer within 1000 ms');
    },
  );

  it('a close the broker holds does not hold the answer, and is abandoned one bound later', async () => {
    const { kafka } = adminFactory({ disconnect: 'hang' });
    const probe = new KafkaReadinessProbe(kafka, { timeoutMs: 1000, logger: quiet });
    await expect(probe.check()).resolves.toBe(true);
    expect(jest.getTimerCount()).toBe(1);
    await jest.advanceTimersByTimeAsync(1000);
    expect(jest.getTimerCount()).toBe(0);
    expect(quiet.debug).toHaveBeenCalledWith(
      expect.stringMatching(/^Kafka readiness probe: disconnect did not finish/),
    );
  });

  it('the shutdown begins with a probe in flight: it answers "not healthy" at once, not at its bound', async () => {
    const { kafka, calls } = adminFactory({ connect: 'hang' });
    const probe = new KafkaReadinessProbe(kafka, { timeoutMs: 1000, logger: quiet });
    let answer: boolean | undefined;
    void probe.check().then((healthy) => (answer = healthy));
    await settle();
    expect(calls).toEqual(['connect']);

    probe.close();
    await settle();
    expect(answer).toBe(false);
    expect(calls).toEqual(['connect', 'disconnect']);
  });

  it('after the shutdown began, no probe opens a client', async () => {
    const { kafka, created } = adminFactory();
    const probe = new KafkaReadinessProbe(kafka, { timeoutMs: 1000, logger: quiet });
    probe.close();
    probe.close();
    await expect(probe.check()).resolves.toBe(false);
    expect(created()).toBe(0);
  });

  it('closed in the same tick a probe began: the client is closed and never connects', async () => {
    const { kafka, calls } = adminFactory();
    const probe = new KafkaReadinessProbe(kafka, { timeoutMs: 1000, logger: quiet });
    const answer = probe.check();
    probe.close();
    await expect(answer).resolves.toBe(false);
    await settle();
    expect(calls).toEqual(['disconnect']);
  });

  it('an admin() that throws: not healthy, no exception', async () => {
    const probe = new KafkaReadinessProbe(
      {
        admin: () => {
          throw new Error('no client');
        },
      },
      { timeoutMs: 1000, logger: quiet },
    );
    await expect(probe.check()).resolves.toBe(false);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('refuses a bound that is not a positive integer', () => {
    const { kafka } = adminFactory();
    for (const timeoutMs of [0, -1, 1.5, Number.NaN]) {
      expect(() => new KafkaReadinessProbe(kafka, { timeoutMs, logger: quiet })).toThrow(
        /timeoutMs/,
      );
    }
  });
});

describe('kafkaProbeTimeoutMs', () => {
  it('is a quarter of the budget, at most 2 s, at least 1 ms', () => {
    expect(kafkaProbeTimeoutMs({ shutdownBudgetMs: 23_000 })).toBe(KAFKA_PROBE_MAX_TIMEOUT_MS);
    expect(kafkaProbeTimeoutMs({ shutdownBudgetMs: 2_000 })).toBe(500);
    expect(kafkaProbeTimeoutMs({ shutdownBudgetMs: 3 })).toBe(1);
    // A script's connection: the default timeout's budget.
    expect(kafkaProbeTimeoutMs({})).toBe(KAFKA_PROBE_MAX_TIMEOUT_MS);
  });
});
