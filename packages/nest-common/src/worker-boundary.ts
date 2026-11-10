import { AsyncLocalStorage } from 'node:async_hooks';

const workers = new AsyncLocalStorage<WorkerBoundary>();

export class WorkerAbandonedError extends Error {
  constructor() {
    super('Worker abandoned; operation/result refused');
  }
}

/** A permanent, per-worker boundary, inherited by nested services and transaction callbacks. */
export class WorkerBoundary {
  private deadline = Infinity;
  private abandonedAtStop = false;
  private readonly pending = new Set<Promise<unknown>>();

  constructor(private readonly warn: (message: string) => void) {}

  get abandoned(): boolean {
    if (performance.now() >= this.deadline) this.abandonedAtStop = true;
    return this.abandonedAtStop;
  }

  stopAt(deadline: number | undefined): void {
    if (deadline !== undefined && !Number.isFinite(deadline)) this.abandon();
    if (deadline !== undefined) {
      this.deadline = Math.min(
        this.deadline,
        performance.now() + Math.max(0, deadline - Date.now()),
      );
    }
  }

  abandon(): void {
    this.abandonedAtStop = true;
  }

  assertActive(): void {
    if (!this.abandoned) return;
    this.warn('Abandoned worker: refusing new operation or dropping late result');
    throw new WorkerAbandonedError();
  }

  get current(): Promise<unknown> | undefined {
    return this.pending.size ? Promise.allSettled([...this.pending]) : undefined;
  }

  run<T>(work: () => Promise<T>): Promise<T> {
    const running = workers.run(this, async () => work());
    this.pending.add(running);
    void running.finally(() => this.pending.delete(running)).catch(() => undefined);
    return running;
  }
}

export function assertWorkerActive(): void {
  workers.getStore()?.assertActive();
}

/** Check both outcomes: a late rejection must never enter ordinary failure recovery. */
export async function workerOperation<T>(work: () => PromiseLike<T>): Promise<T> {
  assertWorkerActive();
  try {
    const result = await work();
    assertWorkerActive();
    return result;
  } catch (error) {
    assertWorkerActive();
    throw error;
  }
}
