import { assertWorkerActive, workerOperation } from '@rasta/nest-common';

const reports = new WeakMap<object, (() => void)[]>();

/** Reports describe durable effects: an unknown transaction cannot report success. */
export function reportAfterCommit(tx: object, report: () => void): void {
  const pending = reports.get(tx);
  if (!pending) throw new Error('Commit reporting requires a managed transaction');
  pending.push(report);
}

/** Covers both PrismaService.transaction and the idempotency store's client entry. */
export function withCommitReporting<T extends object>(client: T): T {
  return new Proxy(client, {
    get(target, key, receiver) {
      const value: unknown = Reflect.get(target, key, receiver);
      if (key !== '$transaction' || typeof value !== 'function') return value;
      return async (work: unknown, ...options: unknown[]): Promise<unknown> => {
        if (typeof work !== 'function') return Reflect.apply(value, target, [work, ...options]);
        const pending: (() => void)[] = [];
        const result: unknown = await workerOperation(() =>
          Reflect.apply(value, target, [
            async (tx: object) => {
              reports.set(tx, pending);
              try {
                return await work(tx);
              } finally {
                reports.delete(tx);
              }
            },
            ...options,
          ]),
        );
        for (const report of pending) {
          assertWorkerActive();
          report();
        }
        return result;
      };
    },
  });
}
