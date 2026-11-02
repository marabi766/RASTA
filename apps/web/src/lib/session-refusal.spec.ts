import { SESSION_PROBE_DEADLINE_MS, sessionHasEnded } from './session-refusal';

/**
 * PR 405 review 5, R6, PM addendum B: `/auth/session` is asked with a fixed
 * deadline. Only a 401 within it says the session ended; a timeout is
 * uncertain. The timer is cleared on every path, the request is aborted at
 * the deadline, and an answer after it is ignored — also from a `fetch` that
 * ignores the abort.
 */

let signals: AbortSignal[] = [];

function scripted(answer: () => Promise<unknown>) {
  global.fetch = ((_url: string, init: RequestInit) => {
    signals.push(init.signal as AbortSignal);
    return answer();
  }) as unknown as typeof fetch;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  jest.useFakeTimers();
  signals = [];
});

afterEach(() => {
  jest.useRealTimers();
});

it('the deadline is fixed: five seconds', () => {
  expect(SESSION_PROBE_DEADLINE_MS).toBe(5_000);
});

it.each([
  ['401', { status: 401 }, true],
  ['204', { status: 204 }, false],
  ['503', { status: 503 }, false],
] as const)(
  '%s within the deadline: %s, and the timer is cleared',
  async (_label, response, ended) => {
    scripted(async () => response);
    await expect(sessionHasEnded()).resolves.toBe(ended);
    expect(jest.getTimerCount()).toBe(0);
    expect(signals[0]!.aborted).toBe(false);
  },
);

it('a network failure: not ended, the timer cleared', async () => {
  scripted(async () => Promise.reject(new TypeError('fetch failed')));
  await expect(sessionHasEnded()).resolves.toBe(false);
  expect(jest.getTimerCount()).toBe(0);
});

it('a fetch that throws at once: not ended, the timer cleared', async () => {
  global.fetch = (() => {
    throw new TypeError('no fetch');
  }) as unknown as typeof fetch;
  await expect(sessionHasEnded()).resolves.toBe(false);
  expect(jest.getTimerCount()).toBe(0);
});

it('no answer: still pending just before the deadline, uncertain at it, the request aborted', async () => {
  scripted(() => new Promise(() => undefined));
  let settled: boolean | undefined;
  void sessionHasEnded().then((ended) => {
    settled = ended;
  });
  await jest.advanceTimersByTimeAsync(SESSION_PROBE_DEADLINE_MS - 1);
  expect(settled).toBeUndefined();
  expect(signals[0]!.aborted).toBe(false);
  await jest.advanceTimersByTimeAsync(1);
  expect(settled).toBe(false);
  expect(signals[0]!.aborted).toBe(true);
  expect(jest.getTimerCount()).toBe(0);
});

it('a 401 after the deadline, from a fetch that ignores the abort, is ignored', async () => {
  const late = deferred<{ status: number }>();
  scripted(() => late.promise);
  const answer = sessionHasEnded();
  await jest.advanceTimersByTimeAsync(SESSION_PROBE_DEADLINE_MS);
  late.resolve({ status: 401 });
  await expect(answer).resolves.toBe(false);
});

/** Headers now and a body that never ends (jsdom has no `Response`); `cancelled()` says whether it was given up. */
function stalledAnswer(status: number) {
  let cancelled = false;
  const response = {
    status,
    body: {
      cancel: async () => {
        cancelled = true;
      },
    },
  };
  return { response, cancelled: () => cancelled };
}

it.each([401, 204, 503])(
  'a %s whose body stalls: the answer is judged on its status and the body is cancelled',
  async (status) => {
    const watched = stalledAnswer(status);
    scripted(async () => watched.response);
    await expect(sessionHasEnded()).resolves.toBe(status === 401);
    expect(watched.cancelled()).toBe(true);
  },
);

it('an answer after the deadline has its body cancelled too', async () => {
  const watched = stalledAnswer(401);
  const late = deferred<unknown>();
  scripted(() => late.promise);
  const answer = sessionHasEnded();
  await jest.advanceTimersByTimeAsync(SESSION_PROBE_DEADLINE_MS);
  late.resolve(watched.response);
  await expect(answer).resolves.toBe(false);
  await jest.advanceTimersByTimeAsync(0);
  expect(watched.cancelled()).toBe(true);
});
