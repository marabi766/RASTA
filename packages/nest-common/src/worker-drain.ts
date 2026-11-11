import type { OutboxStopOptions } from './outbox/outbox';
import type { OutboxStoppable } from './outbox/outbox-shutdown';
import type { WorkerBoundary } from './worker-boundary';

const MAX_TIMER_MS = 2_147_483_647;

/** Join direct work and broker shutdown; failures never release the database early. */
export class WorkerDrain {
  private stopping?: Promise<void>;
  private deadline = Infinity;
  private timer?: ReturnType<typeof setTimeout>;
  private pending = 0;
  private finished = false;
  private readonly failures: unknown[] = [];
  private readonly observed = new Set<Promise<unknown>>();
  private resolve!: () => void;
  private reject!: (error: unknown) => void;

  constructor(
    private readonly worker: WorkerBoundary,
    private readonly broker: OutboxStoppable,
    private readonly warn: () => void,
  ) {}

  stop(options: OutboxStopOptions = {}): Promise<void> {
    this.worker.stopAt(options.deadlineAt);
    const first = !this.stopping;
    this.stopping ??= new Promise<void>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
    if (this.finished) return this.stopping;
    const remaining =
      options.deadlineAt === undefined
        ? Infinity
        : Number.isFinite(options.deadlineAt)
          ? Math.max(0, options.deadlineAt - Date.now())
          : 0;
    const deadline = performance.now() + remaining;
    const tighter = deadline < this.deadline;
    if (tighter) this.deadline = deadline;
    if (first) {
      const current = this.worker.current;
      if (current) this.observe(current);
    }
    if (first || tighter) {
      // Call synchronously so tightening reaches EventConsumer immediately; catch sync throws too.
      try {
        this.observe(this.broker.stop(options));
      } catch (error) {
        this.failures.push(error);
      }
      this.arm();
    }
    return this.stopping;
  }

  private observe(work: Promise<unknown>): void {
    // EventConsumer returns one shared promise, including when its deadline is tightened.
    if (this.observed.has(work)) return;
    this.observed.add(work);
    this.pending++;
    void work
      .catch((error: unknown) => {
        this.failures.push(error);
      })
      .then(() => {
        this.pending--;
        if (!this.pending) this.finish(false);
      });
  }

  private arm(): void {
    clearTimeout(this.timer);
    const remaining = this.deadline - performance.now();
    if (remaining <= 0) void Promise.resolve().then(() => this.finish(true));
    else if (!this.pending) this.finish(false);
    else if (Number.isFinite(remaining)) {
      this.timer = setTimeout(() => this.arm(), Math.min(remaining, MAX_TIMER_MS));
    }
  }

  private finish(abandoned: boolean): void {
    if (this.finished) return;
    this.finished = true;
    clearTimeout(this.timer);
    if (abandoned) {
      this.worker.abandon();
      this.warn();
    }
    if (this.failures.length === 1) this.reject(this.failures[0]);
    else if (this.failures.length > 1)
      this.reject(new AggregateError(this.failures, 'Worker drain failed'));
    else this.resolve();
  }
}
