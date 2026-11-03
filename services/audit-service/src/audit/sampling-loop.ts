/** What a sample checks: once abandoned (the shutdown deadline passed), it must do no more work. */
export interface SamplingSignal {
  readonly abandoned: boolean;
  /** Throws when abandoned; the loop swallows it like any failed sample. */
  throwIfAbandoned(): void;
}

class AbandonedSample extends Error {
  constructor() {
    super('sample abandoned at the shutdown deadline');
  }
}

class Signal implements SamplingSignal {
  abandoned = false;
  throwIfAbandoned(): void {
    if (this.abandoned) throw new AbandonedSample();
  }
}

/**
 * A periodic sample whose work is **tracked**: `stop()` ends the scheduling, and resolves
 * only when the sample in flight has finished (or after `deadlineMs`, whichever is first).
 *
 * The monitors used to `void this.sample()` and clear only the timer on destroy, so a sample
 * whose first query was still running went on to its second after the database client had
 * been disconnected (Codex on #590, F3). Whoever stops this must also be ordered **before**
 * the client's disconnect; see `PrismaService.beforeDisconnect`.
 *
 * Giving up the wait is not enough (Codex on #590 r2, F3): a sample whose first query outlived
 * the deadline resumed after the disconnect and ran its second query and wrote its metric. So
 * the sample receives a `SamplingSignal` that is abandoned **when the deadline expires** (not at
 * `stop()`: a sample that finishes inside the deadline runs to its end). Every sample must call
 * `signal.throwIfAbandoned()` before each database call after the first and before each metric
 * write; the throw ends the abandoned continuation, and `tick` swallows it like any failure.
 */
export class SamplingLoop {
  private timer?: NodeJS.Timeout;
  private active?: Promise<void>;
  private stopping?: Promise<void>;
  /** Becomes abandoned when the shutdown deadline expires with a sample still in flight. */
  private readonly signal = new Signal();

  constructor(
    private readonly sample: (signal: SamplingSignal) => Promise<void>,
    private readonly intervalMs = 60_000,
    private readonly deadlineMs = 5_000,
  ) {}

  start(): void {
    if (this.timer || this.stopping) return;
    this.tick();
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.timer.unref?.();
  }

  /** Idempotent: every caller gets the same bounded wait. */
  stop(): Promise<void> {
    this.stopping ??= this.drain();
    return this.stopping;
  }

  private tick(): void {
    // Stopped: nothing new starts. One sample at a time: a slow one is not overlapped.
    if (this.stopping || this.active) return;
    // Upkeep never takes the service down; the callers' own counters cover real faults.
    const run = this.sample(this.signal)
      .catch(() => undefined)
      .finally(() => {
        if (this.active === run) this.active = undefined;
      });
    this.active = run;
  }

  private async drain(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    const active = this.active;
    if (!active) return;
    let deadline: NodeJS.Timeout | undefined;
    const expired = new Promise<void>((resolve) => {
      deadline = setTimeout(resolve, this.deadlineMs);
    });
    try {
      await Promise.race([active, expired]);
    } finally {
      // Still running at the deadline: whatever it resumes must do no work (and the flag
      // is set before this returns, hence before the client disconnects).
      if (this.active === active) this.signal.abandoned = true;
      if (deadline) clearTimeout(deadline);
    }
  }
}
