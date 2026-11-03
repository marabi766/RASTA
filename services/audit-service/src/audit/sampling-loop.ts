/**
 * A periodic sample whose work is **tracked**: `stop()` ends the scheduling, and resolves
 * only when the sample in flight has finished (or after `deadlineMs`, whichever is first).
 *
 * The monitors used to `void this.sample()` and clear only the timer on destroy, so a sample
 * whose first query was still running went on to its second after the database client had
 * been disconnected (Codex on #590, F3). Whoever stops this must also be ordered **before**
 * the client's disconnect; see `PrismaService.beforeDisconnect`.
 */
export class SamplingLoop {
  private timer?: NodeJS.Timeout;
  private active?: Promise<void>;
  private stopping?: Promise<void>;

  constructor(
    private readonly sample: () => Promise<void>,
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
    const run = this.sample()
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
      if (deadline) clearTimeout(deadline);
    }
  }
}
