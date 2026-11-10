interface TeardownPool {
  stop(options?: { deadlineAt?: number }): Promise<{ drained: boolean }>;
  client: { $connect(): Promise<unknown> };
}

/** Shared stalled-query regression, run against each service's actual Prisma adapter. */
export function describeDatabaseTeardown(
  open: () => TeardownPool,
  prototype: { $disconnect(): Promise<void> },
  coordinate: (pool: TeardownPool) => Promise<void>,
): void {
  it.each(['normal', 'stalled'])('database close: %s', async (mode) => {
    jest.useFakeTimers();
    let finish!: (error?: Error) => void;
    const query = new Promise<void>((resolve, fail) => {
      finish = (error) => (error ? fail(error) : resolve());
    });
    const disconnect = jest.spyOn(prototype, '$disconnect').mockImplementation(() => query);
    try {
      const prisma = open();
      let returned = false;
      const closing = coordinate(prisma).then(() => {
        returned = true;
      });
      await jest.advanceTimersByTimeAsync(0);
      if (mode === 'normal') finish();
      await jest.advanceTimersByTimeAsync(23_000);
      expect(returned).toBe(true); // The query is STILL unresolved in the stalled cases.
      await closing;
      await expect(prisma.stop()).resolves.toEqual({ drained: mode === 'normal' });
      expect(prisma.stop()).toBe(prisma.stop());
      expect(disconnect).toHaveBeenCalledTimes(1);
      await expect(prisma.client.$connect()).rejects.toThrow('Database shutdown');
      finish(mode === 'stalled' ? new Error('late disconnect rejection') : undefined);
      await jest.advanceTimersByTimeAsync(0);
    } finally {
      finish();
      jest.restoreAllMocks();
      jest.useRealTimers();
    }
  });
}
