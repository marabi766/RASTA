import { readAccessChange } from './access-change';
import type { RevocationList } from './revocation-list';

/** One message of the identity topic, as the list needs it. */
export interface RevocationLogMessage {
  partition: number;
  offset: number;
  /** The broker record's timestamp, epoch milliseconds. */
  timestampMs: number;
  value: Buffer | string | null;
}

/**
 * The identity topic, seen from one replica (addendum § 4). The Kafka
 * adapter behind it is the second PR of EXT-005; this is the whole contract
 * the feed relies on.
 */
export interface RevocationLogSource {
  /** Per partition, the offset the next record will be written at. */
  highWatermarks(): Promise<Map<number, number>>;
  /**
   * Per partition, the first offset whose record timestamp is at or after
   * `timestampMs` — the high watermark when there is none.
   */
  offsetsAt(timestampMs: number): Promise<Map<number, number>>;
  /**
   * Reads every partition from `from` on, in offset order within each, and
   * hands every record to `onMessage`. `onFailure` when reading stops for
   * good. Resolves once reading has begun.
   */
  start(
    from: Map<number, number>,
    onMessage: (message: RevocationLogMessage) => void,
    onFailure: (error: unknown) => void,
  ): Promise<void>;
  stop(): Promise<void>;
}

export interface FeedLogger {
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

export interface RevocationFeedOptions {
  /** Not current once it has not been shown caught up for longer than this. */
  maxStalenessMs: number;
  probeIntervalMs: number;
  now?: () => number;
  logger?: FeedLogger;
}

/** A high-watermark reading: everything published before `atMs` lies below `high`. */
interface Probe {
  atMs: number;
  high: Map<number, number>;
}

/**
 * Keeps one replica's `RevocationList` up to date, and knows how far it can
 * vouch for it (addendum § 4).
 *
 * **Start.** The high watermarks are read first, then every partition is read
 * from the first record inside the retention window — `now - retention`, by
 * record timestamp — so the replay is bounded by the window, not by the
 * topic's retention, and covers every partition. No consumer offset is ever
 * committed: a replica owns nothing a rebalance could move, and a restart, a
 * lost process or a new replica takes the same path.
 *
 * **Current.** The feed is current at `t` when every partition has been read
 * up to the high watermark read at `t`: every revocation committed to the
 * topic before `t` is in the list. Zero lag is not taken on trust: it has to
 * be shown, by a probe that resolves. A replica that has not been current
 * within `maxStalenessMs` — not yet caught up after start, a broker it cannot
 * reach, a reader that stopped, a partition it does not read — is not
 * current, and the gate refuses every pair it would have to evaluate.
 *
 * **Stop.** `stop()` forgets the feed's currency before it awaits anything:
 * from that call on the feed is neither current nor caught up, so the gate
 * refuses every pair and readiness is down while the source shuts down,
 * whether that resolves, rejects or never returns (PR #381 r1 F3). Every
 * `start()` and `stop()` opens a new generation; a startup step, a probe, a
 * message or a failure belongs to the generation it began in and changes
 * nothing once that one is over — so no late reading, record or callback of
 * a stopped reader can make a feed current again.
 */
export class RevocationFeed {
  private readonly positions = new Map<number, number>();
  private readonly pending: Probe[] = [];
  private currentAtMs: number | undefined;
  private lagRecords: number | undefined;
  private failed = false;
  private timer: NodeJS.Timeout | undefined;
  /** Moves on every `start()` and `stop()`; what began in an older one is ignored. */
  private generation = 0;
  /** The generation of the `start()` that has not been stopped, if any. */
  private running: number | undefined;
  private readonly now: () => number;
  private readonly maxPending: number;

  constructor(
    private readonly source: RevocationLogSource,
    private readonly list: RevocationList,
    private readonly options: RevocationFeedOptions,
  ) {
    this.now = options.now ?? Date.now;
    // A probe older than the staleness bound cannot make the feed current any
    // more; keeping more than fit in that bound only costs memory. Dropping
    // the oldest can only delay currency, never invent it.
    this.maxPending = Math.max(1, Math.ceil(options.maxStalenessMs / options.probeIntervalMs) + 1);
  }

  async start(): Promise<void> {
    this.forget();
    const generation = ++this.generation;
    this.running = generation;
    this.failed = false;

    const atMs = this.now();
    const high = await this.source.highWatermarks();
    if (!this.isRunning(generation)) return;
    const from = await this.source.offsetsAt(atMs - this.list.timing.retentionMs);
    if (!this.isRunning(generation)) return;
    for (const [partition, offset] of from) this.positions.set(partition, offset);
    this.pending.push({ atMs, high });
    this.resolveProbes();

    await this.source.start(
      from,
      (message) => {
        if (this.isRunning(generation)) this.handle(message);
      },
      (error) => {
        if (this.isRunning(generation)) this.fail(error);
      },
    );
    if (!this.isRunning(generation)) {
      // Stopped while the source was starting: the stop reached a source that
      // had not started yet, so it is stopped once more — unless a newer
      // start owns it by now.
      if (this.running === undefined) await this.source.stop();
      return;
    }
    this.timer = setInterval(() => void this.probe(), this.options.probeIntervalMs);
    this.timer.unref();
  }

  /** Not current nor caught up from this call on, before the source is awaited. */
  async stop(): Promise<void> {
    this.generation += 1;
    this.running = undefined;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.forget();
    await this.source.stop();
  }

  /** Reads the high watermarks once more; resolves when the reading is queued. */
  async probe(): Promise<void> {
    const generation = this.generation;
    if (!this.isRunning(generation)) return;
    const atMs = this.now();
    try {
      const high = await this.source.highWatermarks();
      if (!this.isRunning(generation)) return;
      this.pending.push({ atMs, high });
      while (this.pending.length > this.maxPending) this.pending.shift();
      this.resolveProbes();
    } catch (error) {
      if (!this.isRunning(generation)) return;
      // Not current until a later probe resolves: the staleness bound decides.
      this.options.logger?.warn(
        { error: errorName(error) },
        'Revocation list: the identity topic high watermarks could not be read',
      );
    }
    this.list.prune(this.now());
  }

  /** Applies one record. Never throws: what cannot be applied is held against every pair. */
  private handle(message: RevocationLogMessage): void {
    try {
      const read = readAccessChange(message.value);
      if (read.outcome === 'unreadable') {
        this.holdFor(message, read.eventName);
      } else if (read.outcome === 'change') {
        const result = this.list.apply(read.change, this.now());
        if (result === 'full') {
          this.list.hold(Math.max(message.timestampMs, read.change.atMs));
          this.options.logger?.error(
            { partition: message.partition, offset: message.offset },
            'Revocation list is full: every pair is held until this change has aged out',
          );
        }
      }
    } catch {
      this.holdFor(message, undefined);
    }
    const next = message.offset + 1;
    if (next > (this.positions.get(message.partition) ?? Number.NEGATIVE_INFINITY)) {
      this.positions.set(message.partition, next);
    }
    this.resolveProbes();
  }

  /** Whether the list can be vouched for at `nowMs`. */
  isCurrent(nowMs: number = this.now()): boolean {
    if (this.failed || this.currentAtMs === undefined) return false;
    return nowMs - this.currentAtMs <= this.options.maxStalenessMs;
  }

  /** Whether the feed has been shown caught up at least once since it started. */
  hasCaughtUp(): boolean {
    return this.currentAtMs !== undefined;
  }

  /** Whether reading has stopped for good: only a restart recovers this replica. */
  hasFailed(): boolean {
    return this.failed;
  }

  /** Seconds since the feed was last shown caught up; undefined before the first time. */
  stalenessSeconds(nowMs: number = this.now()): number | undefined {
    return this.currentAtMs === undefined ? undefined : (nowMs - this.currentAtMs) / 1000;
  }

  /** Records between the read positions and the latest high watermark read. */
  lag(): number | undefined {
    return this.lagRecords;
  }

  private isRunning(generation: number): boolean {
    return this.running === generation;
  }

  /** Everything the feed vouches for, gone: a stopped or restarting feed vouches for nothing. */
  private forget(): void {
    this.positions.clear();
    this.pending.length = 0;
    this.currentAtMs = undefined;
    this.lagRecords = undefined;
  }

  private fail(error: unknown): void {
    this.failed = true;
    this.options.logger?.error(
      { error: errorName(error) },
      'Revocation list: reading the identity topic stopped; this replica refuses every pair until restarted',
    );
  }

  private holdFor(message: RevocationLogMessage, eventName: string | undefined): void {
    this.list.hold(message.timestampMs);
    // Where it is and what it claimed to be — never its contents, nor why it
    // failed: a validation message can quote the payload (addendum § 8).
    this.options.logger?.error(
      { partition: message.partition, offset: message.offset, ...(eventName ? { eventName } : {}) },
      'Revocation list: an identity event could not be applied; every pair is held until it has aged out',
    );
  }

  private resolveProbes(): void {
    const latest = this.pending.at(-1);
    if (latest) this.lagRecords = this.behind(latest);
    for (
      let oldest = this.pending[0];
      oldest && this.behind(oldest) === 0;
      oldest = this.pending[0]
    ) {
      this.currentAtMs = oldest.atMs;
      this.pending.shift();
    }
  }

  /** Records still to read before `probe` resolves; Infinity for a partition not read at all. */
  private behind(probe: Probe): number {
    let total = 0;
    for (const [partition, high] of probe.high) {
      const position = this.positions.get(partition);
      if (position === undefined) return Number.POSITIVE_INFINITY;
      total += Math.max(0, high - position);
    }
    return total;
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
