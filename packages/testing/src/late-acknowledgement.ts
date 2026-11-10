/** Hold a successful acknowledgement beyond its lease budget, without sleeping. */
export async function expectLateAcknowledgementIgnored<T>(
  run: () => Promise<unknown>,
  acknowledgement: { mockImplementationOnce(fn: () => Promise<T>): unknown },
  result: T,
  processing: unknown,
  elapsed: number,
  calls = 0,
): Promise<void> {
  jest.useFakeTimers();
  try {
    let commit!: (result: T) => void;
    acknowledgement.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          commit = resolve;
        }),
    );
    const sweep = run();
    await jest.advanceTimersByTimeAsync(elapsed);
    jest.setSystemTime(0); // Wall-clock rollback must not refresh the lease.
    commit(result);
    await sweep;
    expect(processing).toHaveBeenCalledTimes(calls);
  } finally {
    jest.useRealTimers();
  }
}

/** Reproduce a rejected/successful response after stop has already returned. */
export async function expectAbandonedWorkerDrops<T>(
  worker: { runOnce(): Promise<unknown>; stop(options: { deadlineAt: number }): Promise<void> },
  operation: { mockImplementationOnce(fn: () => Promise<T>): unknown },
  result: T,
  how: string,
  lateCalls: readonly unknown[],
): Promise<void> {
  jest.useFakeTimers();
  try {
    let finish = (): void => undefined;
    operation.mockImplementationOnce(
      () =>
        new Promise((resolve, reject) => {
          finish = () => (how === 'reject' ? reject(new Error('late')) : resolve(result));
        }),
    );
    const running = worker.runOnce();
    await jest.advanceTimersByTimeAsync(0);
    expect(operation).toHaveBeenCalledTimes(1);
    const stopping = worker.stop({ deadlineAt: Date.now() + 10 });
    await jest.advanceTimersByTimeAsync(10);
    await stopping;
    finish();
    await running;
    for (const calls of lateCalls) expect(calls).not.toHaveBeenCalled();
  } finally {
    jest.useRealTimers();
  }
}
