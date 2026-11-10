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
