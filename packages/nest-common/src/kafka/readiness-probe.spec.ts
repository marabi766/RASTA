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
 * Codex r2 (R2-F1): a connect still retrying when the probe answered could
 * succeed after the probe's close and leave a connection open; it is closed
 * again when it ends.
 *
 * Fake timers; the admin client is a fake whose every call can be held. The
 * publishers' own specs run the probe through real kafkajs and Nest's HTTP close
 * (fleet's, a real connect that succeeds after the bound).
 */

type Step = 'connect' | 'listTopics' | 'disconnect';

/**
 * An admin client per probe; each step answers, fails or is held as told. A
 * `later` step is held until the test ends it with `finish`.
 */
function adminFactory(behaviour: Partial<Record<Step, 'ok' | 'fail' | 'hang' | 'later'>> = {}) {
  const calls: Step[] = [];
  let created = 0;
  const later: Partial<Record<Step, { resolve: () => void; reject: (error: Error) => void }>> = {};
  const step = (name: Step) => (): Promise<never> => {
    calls.push(name);
    const how = behaviour[name] ?? 'ok';
    if (how === 'hang') return new Promise<never>(() => undefined);
    if (how === 'later') {
      return new Promise<never>((resolve, reject) => {
        later[name] = { resolve: () => resolve(undefined as never), reject };
      });
    }
    if (how === 'fail') return Promise.reject(new Error(`${name} refused`));
    return Promise.resolve(undefined as never);
  };
  const finish = (name: Step, how: 'ok' | 'fail'): void => {
    const held = later[name];
    if (!held) throw new Error(`no held ${name}`);
    if (how === 'ok') held.resolve();
    else held.reject(new Error(`${name} refused`));
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
  return { kafka, calls, finish, created: () => created };
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

  // Codex r2 on #293, R2-F1: kafkajs's admin `disconnect()` does not cancel a
  // connect that is backing off between retries, so the connect can succeed
  // after the probe answered and closed the client. That connection must be
  // closed when it opens, and the client never asked anything.
  it.each([
    ['its bound', 'ok'],
    ['its bound', 'fail'],
    ['the shutdown', 'ok'],
  ] as const)(
    'R2-F1: answered by %s while connecting, a connect that then ends (%s) is closed again and lists nothing',
    async (answeredBy, connectEnds) => {
      const { kafka, calls, finish } = adminFactory({ connect: 'later' });
      const probe = new KafkaReadinessProbe(kafka, { timeoutMs: 1000, logger: quiet });
      let answer: boolean | undefined;
      void probe.check().then((healthy) => (answer = healthy));
      await settle();
      if (answeredBy === 'its bound') await jest.advanceTimersByTimeAsync(1000);
      else probe.close();
      await settle();
      expect(answer).toBe(false);
      expect(calls).toEqual(['connect', 'disconnect']);

      finish('connect', connectEnds);
      await settle();
      expect(calls).toEqual(['connect', 'disconnect', 'disconnect']);
      expect(quiet.debug).toHaveBeenCalledWith(
        'Kafka readiness probe: its client finished after the probe answered; closed again',
      );
      // The late close is bounded too, and leaves no timer once it finished.
      expect(jest.getTimerCount()).toBe(0);
    },
  );

  it('R2-F1: a listing that ends after the bound: the client is closed again', async () => {
    const { kafka, calls, finish } = adminFactory({ listTopics: 'later' });
    const probe = new KafkaReadinessProbe(kafka, { timeoutMs: 1000, logger: quiet });
    const answer = probe.check();
    await jest.advanceTimersByTimeAsync(1000);
    await expect(answer).resolves.toBe(false);
    expect(calls).toEqual(['connect', 'listTopics', 'disconnect']);

    finish('listTopics', 'ok');
    await settle();
    expect(calls).toEqual(['connect', 'listTopics', 'disconnect', 'disconnect']);
  });

  it('R2-F1: a late close the broker holds is abandoned one bound later, quietly', async () => {
    const { kafka, finish } = adminFactory({ connect: 'later', disconnect: 'hang' });
    const probe = new KafkaReadinessProbe(kafka, { timeoutMs: 1000, logger: quiet });
    const answer = probe.check();
    await jest.advanceTimersByTimeAsync(1000);
    await expect(answer).resolves.toBe(false);
    // The first close is held: abandoned at its own bound.
    await jest.advanceTimersByTimeAsync(1000);
    expect(jest.getTimerCount()).toBe(0);

    finish('connect', 'ok');
    await settle();
    expect(jest.getTimerCount()).toBe(1);
    await jest.advanceTimersByTimeAsync(1000);
    expect(jest.getTimerCount()).toBe(0);
    expect(
      quiet.debug.mock.calls.filter(([message]) =>
        /^Kafka readiness probe: disconnect did not finish/.test(message as string),
      ),
    ).toHaveLength(2);
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
