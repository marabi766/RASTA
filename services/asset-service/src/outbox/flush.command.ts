/**
 * Publishes asset-service's outbox until nothing is left unpublished, then
 * reports (docs/runbooks/insurance-reprojection.md, "changing the following-
 * coverage list", step 1; #240 round 5).
 *
 * Stopping every asset-service replica, as that procedure requires, also stops
 * the relay that lives inside it, so rows queued at the moment of the stop
 * would stay unpublished and the drain check could never pass. This is the
 * relay alone, run to completion by hand: it claims and publishes with the same
 * store, publisher and relay as the service, and exits.
 *
 * Kept free of the relay's and the database's concrete types so the loop's
 * decisions — when it is done, when it gives up, whether it waits — are tested
 * without a broker; `flush.cli.ts` supplies the real ones.
 */
export interface FlushOptions {
  /** One relay batch; resolves to the rows it published (0 when nothing was claimable). */
  tick: () => Promise<number>;
  /** Rows with no `published_at`, whatever their claim or backoff state. */
  unpublished: () => Promise<number>;
  /**
   * Gives up after this long: a row in backoff or under another process's lease may take that long to become claimable.
   * A deadline checked between ticks, not a bound on the run: a tick in progress
   * when it passes is finished, so the loop can overrun by one batch's publish.
   */
  maxSeconds: number;
  /** How long to wait when a tick published nothing. */
  pollMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface FlushReport {
  /** True only when the outbox holds no unpublished row. */
  drained: boolean;
  timedOut: boolean;
  published: number;
  unpublished: number;
  ticks: number;
}

export async function flushOutbox(options: FlushOptions): Promise<FlushReport> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = now() + options.maxSeconds * 1000;
  let published = 0;
  let ticks = 0;

  for (;;) {
    const sent = await options.tick();
    ticks += 1;
    published += sent;
    const unpublished = await options.unpublished();
    if (unpublished === 0) return { drained: true, timedOut: false, published, unpublished, ticks };

    const remaining = deadline - now();
    if (remaining <= 0) return { drained: false, timedOut: true, published, unpublished, ticks };
    // Progress means the next batch may be ready at once; none means the rest
    // is in backoff or leased, which only time changes.
    if (sent === 0) await sleep(Math.min(options.pollMs, remaining));
  }
}
