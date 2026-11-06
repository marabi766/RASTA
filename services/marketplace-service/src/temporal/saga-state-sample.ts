import { SAGA_START_STOP_BUDGET_MS } from '../config/operation-budgets';
import { setStateFreshUntil } from '../observability/metrics';

/** How often every replica reads the saga state, on a timer of its own. */
export const STATE_SAMPLE_INTERVAL_MS = 10_000;
/** A read's own bound: past the database's (maxWait + timeout), so their failure is seen first. */
export const STATE_READ_TIMEOUT_MS = SAGA_START_STOP_BUDGET_MS + 1_000;
/** Past this, by the monotonic clock, a sample's series are gone from the scrape. */
export const STATE_FRESH_MS = 2 * STATE_SAMPLE_INTERVAL_MS + STATE_READ_TIMEOUT_MS;

type Outcome = 'published' | 'failed' | 'timed out' | 'closed' | 'busy';

/**
 * One read of saga state and the gauges it sets (#792 r1 F3). Independent of
 * every other read and of start delivery: its own slot, its own deadline, its
 * own freshness.
 *
 * - A read past `STATE_READ_TIMEOUT_MS` withdraws its gauges at once, and its
 *   late answer is dropped.
 * - A read that never settles keeps its slot, so reads do not pile up behind
 *   it; the gauges stay withdrawn until a read answers in time again.
 * - Whatever stalls (this timer, the event loop's callbacks, a bug here), the
 *   gauges are withdrawn at scrape once `STATE_FRESH_MS` has passed since the
 *   last answer, by `performance.now()`, which no clock change moves.
 */
export class StateSample<T> {
  private reading?: Promise<unknown>;
  private closed = false;

  constructor(
    private readonly gauges: readonly { reset(): void }[],
    private readonly read: () => Promise<T>,
    private readonly publish: (value: T) => void,
    private readonly onFailure: (outcome: 'failed' | 'timed out', error?: unknown) => void,
  ) {}

  /** Starts a read unless one is still out. Answers once it is decided, not settled. */
  async take(): Promise<Outcome> {
    if (this.closed) return 'closed';
    if (this.reading) return 'busy';
    let timer: NodeJS.Timeout | undefined;
    const reading = this.read().then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    this.reading = reading.finally(() => {
      this.reading = undefined;
    });
    const deadline = new Promise<'timed out'>((resolve) => {
      timer = setTimeout(() => resolve('timed out'), STATE_READ_TIMEOUT_MS);
      timer.unref?.();
    });
    const answer = await Promise.race([reading, deadline]);
    clearTimeout(timer);
    if (this.closed) return 'closed';
    if (answer === 'timed out' || 'error' in answer) {
      this.withdraw();
      const outcome = answer === 'timed out' ? answer : 'failed';
      this.onFailure(outcome, answer === 'timed out' ? undefined : answer.error);
      return outcome;
    }
    // Withdrawn first: a reason this read no longer reports must not linger.
    this.withdraw();
    this.publish(answer.value);
    setStateFreshUntil(this.gauges, performance.now() + STATE_FRESH_MS);
    return 'published';
  }

  /** No more reads, and nothing from a read still out. */
  close(): void {
    this.closed = true;
    this.withdraw();
  }

  /** Settles with the read in flight, if any (it may never). */
  idle(): Promise<unknown> {
    return this.reading ?? Promise.resolve();
  }

  private withdraw(): void {
    setStateFreshUntil(this.gauges, undefined);
    for (const gauge of this.gauges) gauge.reset();
  }
}
