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

/** Exercise the production coordinator factory, including its database phase ordering. */
export function coordinateDatabaseTeardown(
  providers: unknown,
  databaseToken: object,
  envToken: unknown,
  shutdownToken: object,
  pool: TeardownPool,
): Promise<void> {
  const provider = (
    providers as {
      provide?: object;
      inject?: unknown[];
      useFactory?: (...args: unknown[]) => { stop(): Promise<void> };
    }[]
  ).find((candidate) => candidate.provide === shutdownToken);
  if (!provider?.useFactory || !provider.inject) throw new Error('Missing shutdown factory');
  const { inject, useFactory } = provider;
  expect(inject).toContain(databaseToken);
  expect('onModuleDestroy' in pool).toBe(false);
  const startedAt = Date.now();
  const stops: unknown[] = [];
  const args = inject.map((token) => {
    if (token === envToken) return { SHUTDOWN_TIMEOUT_MS: 25_000 };
    if (token === databaseToken)
      return {
        stop: (options?: { deadlineAt?: number }) => {
          expect(stops).toHaveLength(inject.length - 2);
          expect(options?.deadlineAt).toBe(startedAt + 23_000);
          return pool.stop(options);
        },
      };
    return {
      stop: async () => {
        if (token === inject[0]) await new Promise((resolve) => setTimeout(resolve, 22_000));
        stops.push(token);
      },
    };
  });
  return useFactory(...args).stop();
}
