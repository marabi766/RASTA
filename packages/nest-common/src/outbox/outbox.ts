import { ulid } from 'ulid';
import { EVENT_HEADERS, type EventEnvelope } from '@rasta/contracts';
import { tryGetContext } from '../context/request-context';

/**
 * Transactional Outbox (ADR-021).
 *
 * Domain code never publishes to Kafka directly. It writes an outbox row in
 * the *same database transaction* as the state change, and a relay publishes
 * it afterwards. Without this, "save the order" and "publish ORDER_CREATED"
 * are two non-atomic operations, and a crash between them produces either a
 * lost event (commission never charged) or a phantom event (commission charged
 * for an order that rolled back).
 *
 * The delivery guarantee is at-least-once. Exactly-once across a broker
 * boundary is expensive and brittle; at-least-once plus idempotent consumers
 * reaches the same end state for far less machinery.
 */

export interface OutboxMessageInput<TPayload = unknown> {
  aggregateType: string;
  aggregateId: string;
  eventName: string;
  eventVersion?: number;
  topic: string;
  payload: TPayload;
  /**
   * Kafka partition key. Defaults to `aggregateId`, which is what gives
   * ordering per aggregate — the property the wallet and tender flows depend on.
   */
  partitionKey?: string;
  aggregateVersion?: number;
  organizationId?: string;
  /** The event that caused this one, for causal tracing. */
  causationId?: string;
  occurredAt?: Date;
}

export interface OutboxRow {
  id: string;
  aggregateType: string;
  aggregateId: string;
  eventName: string;
  eventVersion: number;
  topic: string;
  partitionKey: string;
  payload: unknown;
  headers: Record<string, string>;
  organizationId: string | null;
  correlationId: string;
  createdAt: Date;
  publishedAt: Date | null;
  attempts: number;
  lastError: string | null;
}

export interface BuildOutboxOptions {
  producer: string;
  producerVersion?: string;
}

/**
 * Builds the row to insert. Pure — takes no I/O — so it can be called inside a
 * transaction callback and unit-tested without a database.
 */
export function buildOutboxRow<TPayload>(
  input: OutboxMessageInput<TPayload>,
  options: BuildOutboxOptions,
): Omit<OutboxRow, 'publishedAt' | 'attempts' | 'lastError'> {
  const context = tryGetContext();
  const eventId = ulid();
  const occurredAt = input.occurredAt ?? new Date();
  const correlationId = context?.correlationId ?? eventId;
  const organizationId = input.organizationId ?? context?.organizationId ?? null;

  const envelope: EventEnvelope<TPayload> = {
    eventId,
    eventName: input.eventName,
    eventVersion: input.eventVersion ?? 1,
    occurredAt: occurredAt.toISOString(),
    producer: options.producer,
    producerVersion: options.producerVersion ?? '0.0.0',
    aggregateType: input.aggregateType,
    aggregateId: input.aggregateId,
    ...(input.aggregateVersion !== undefined ? { aggregateVersion: input.aggregateVersion } : {}),
    ...(organizationId ? { tenantId: organizationId } : {}),
    correlationId,
    ...(input.causationId ? { causationId: input.causationId } : {}),
    ...(context?.traceId && context.spanId
      ? { traceparent: `00-${context.traceId}-${context.spanId}-01` }
      : {}),
    ...(context?.userId
      ? { actor: { type: 'USER' as const, id: context.userId } }
      : context?.callerService
        ? { actor: { type: 'SERVICE' as const, id: context.callerService } }
        : {}),
    payload: input.payload,
  };

  return {
    id: eventId,
    aggregateType: input.aggregateType,
    aggregateId: input.aggregateId,
    eventName: input.eventName,
    eventVersion: envelope.eventVersion,
    topic: input.topic,
    partitionKey: input.partitionKey ?? input.aggregateId,
    payload: envelope,
    headers: buildHeaders(envelope),
    organizationId,
    correlationId,
    createdAt: occurredAt,
  };
}

function buildHeaders(envelope: EventEnvelope): Record<string, string> {
  const headers: Record<string, string> = {
    [EVENT_HEADERS.eventId]: envelope.eventId,
    [EVENT_HEADERS.eventName]: envelope.eventName,
    [EVENT_HEADERS.eventVersion]: String(envelope.eventVersion),
    [EVENT_HEADERS.correlationId]: envelope.correlationId,
    [EVENT_HEADERS.producer]: envelope.producer,
  };
  if (envelope.tenantId) headers[EVENT_HEADERS.tenantId] = envelope.tenantId;
  if (envelope.causationId) headers[EVENT_HEADERS.causationId] = envelope.causationId;
  if (envelope.traceparent) headers[EVENT_HEADERS.traceparent] = envelope.traceparent;
  return headers;
}

// ---------------------------------------------------------------------------
// Relay
// ---------------------------------------------------------------------------

/** A claim: the fence the database wrote, and the rows it covers. */
export interface OutboxClaim {
  /** `null` only when nothing was claimed. */
  token: string | null;
  rows: OutboxRow[];
  /** How many of these were taken back from an expired lease. */
  reclaimed: number;
}

export interface ClaimRequest {
  limit: number;
  /** Diagnostic metadata only — which process holds this. Never a fence. */
  owner: string;
  leaseSeconds: number;
}

export interface RetryBackoff {
  baseSeconds: number;
  maxSeconds: number;
}

/**
 * Persistence port. Implemented per service against its own Prisma client.
 *
 * Every mutation takes the claim token and returns how many rows it actually
 * touched. Both halves matter: the token is what makes a stale claimant
 * harmless, and the count is how the relay learns it was fenced — a silent
 * `void` would let ownership be lost without anything noticing (ADR-050).
 */
export interface OutboxStore {
  /**
   * Claims up to `limit` rows and fences them on a freshly generated token.
   *
   * Selection and reservation are one statement, so no window exists between
   * them. The lease does not decide ownership; the token does.
   */
  claimPending(request: ClaimRequest): Promise<OutboxClaim>;

  /** Acknowledges publication. Returns rows updated; the shortfall was fenced. */
  markPublished(ids: readonly string[], token: string): Promise<number>;

  /** Records a failure and schedules the retry with the database clock. */
  markFailed(id: string, token: string, error: string, backoff: RetryBackoff): Promise<number>;

  /** Gives rows back without counting a failure. Returns rows released. */
  release(ids: readonly string[], token: string): Promise<number>;

  /**
   * Extends the lease and returns the ids **still owned**.
   *
   * Ids rather than a count, so a partial renewal does not force the relay to
   * abandon rows it still legitimately holds.
   */
  renew(
    ids: readonly string[],
    token: string,
    leaseSeconds: number,
    deadlineMs: number,
  ): Promise<string[]>;

  /** Age of the oldest unpublished row, in seconds. Feeds the stuck-relay alert. */
  oldestPendingAgeSeconds(): Promise<number>;
}

/** Broker port. */
export interface EventPublisher {
  publish(rows: readonly OutboxRow[]): Promise<void>;
}

export interface OutboxRelayOptions {
  store: OutboxStore;
  publisher: EventPublisher;
  pollIntervalMs?: number;
  batchSize?: number;
  /** Identifies the process in `claim_owner`. Diagnostic only, never a fence. */
  owner?: string;
  leaseSeconds?: number;
  backoff?: RetryBackoff;
  shutdownGraceSeconds?: number;
  logger?: {
    debug(obj: object, msg?: string): void;
    info?(obj: object, msg?: string): void;
    warn(obj: object, msg?: string): void;
    error(obj: object, msg?: string): void;
  };
  onBatchPublished?: (count: number) => void;
  onPublishFailed?: (row: OutboxRow, error: unknown) => void;
  /** Rows a mutation could not touch because the token no longer matched. */
  onFenced?: (count: number) => void;
  /** Rows taken back from an expired lease. */
  onReclaimed?: (count: number) => void;
  /** Rows claimed, whatever their previous state. */
  onClaimAttempt?: (count: number) => void;
  /** Injection seam for the tests; nothing else should pass this. */
  now?: () => number;
}

/** ADR-050 §Heartbeat timing. Three attempts before expiry, at every lease size. */
export const RENEWAL_INTERVAL_DIVISOR = 4;
/** Ceiling on one renewal's `statement_timeout`, in milliseconds. */
export const RENEWAL_DEADLINE_CEILING_MS = 30_000;

export function renewalIntervalMs(leaseSeconds: number): number {
  return (leaseSeconds * 1000) / RENEWAL_INTERVAL_DIVISOR;
}

export function renewalDeadlineMs(leaseSeconds: number): number {
  return Math.min(renewalIntervalMs(leaseSeconds) / 2, RENEWAL_DEADLINE_CEILING_MS);
}

/**
 * How each owned row's publish ended, as far as this process can tell.
 *
 * `IN_FLIGHT` is the state that shapes the shutdown protocol: KafkaJS gives no
 * way to cancel a `sendBatch`, so a request that has not returned may still
 * reach the broker. Releasing such a row guarantees a replay; letting its lease
 * lapse replays only if it genuinely has to.
 */
type PublishState = 'NOT_SENT' | 'IN_FLIGHT' | 'PUBLISHED' | 'FAILED';

export class OutboxRelay {
  private timer?: NodeJS.Timeout;
  private heartbeat?: NodeJS.Timeout;
  private running = false;
  private stopped = true;

  /** Rows this relay holds and has not yet acknowledged, failed or released. */
  private owned = new Set<string>();
  private state = new Map<string, PublishState>();
  private token: string | null = null;
  private lastRenewAt = 0;
  /** Set when a renewal deadline passes with no success: no more mutations. */
  private ownershipUnknown = false;

  private readonly owner: string;
  private readonly leaseSeconds: number;
  private readonly backoff: RetryBackoff;
  private readonly shutdownGraceMs: number;
  private readonly now: () => number;

  constructor(private readonly options: OutboxRelayOptions) {
    this.owner = options.owner ?? `${process.pid}@${hostLabel()}`;
    this.leaseSeconds = options.leaseSeconds ?? 60;
    this.backoff = options.backoff ?? { baseSeconds: 5, maxSeconds: 3600 };
    this.shutdownGraceMs = (options.shutdownGraceSeconds ?? 30) * 1000;
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    const interval = this.options.pollIntervalMs ?? 500;
    this.timer = setInterval(() => {
      if (this.stopped) return;
      void this.tick();
    }, interval);
    // Do not hold the event loop open on shutdown.
    this.timer.unref?.();
  }

  /**
   * Stops polling and settles what this relay still owns.
   *
   * Three outcomes, one per row, exactly as ADR-050 specifies:
   *
   *   not sent            release it, fenced on the token. Nothing reached the
   *                       broker, so it is safe and it avoids parking the row
   *                       until the lease lapses.
   *   result known        already acknowledged or failed inside the tick.
   *   in flight, unknown  **do not release.** Keep renewing for up to the
   *                       shutdown grace so ownership is not handed over while
   *                       a request may still land, then stop renewing and
   *                       abandon it. The lease expires on its own and the next
   *                       claimant picks it up — a duplicate only if one was
   *                       genuinely needed.
   *
   * Shutdown never waits indefinitely: the grace is bounded by configuration,
   * so a pod cannot sit in `Terminating` behind a Kafka request that cannot be
   * cancelled.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;

    const deadline = this.now() + this.shutdownGraceMs;
    while (this.running && this.now() < deadline) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    const token = this.token;
    if (token) {
      const notSent = [...this.owned].filter((id) => this.state.get(id) === 'NOT_SENT');
      if (notSent.length > 0) {
        try {
          const released = await this.options.store.release(notSent, token);
          this.recordFencing(notSent.length - released, 'release');
          this.options.logger?.debug(
            { count: released, owner: this.owner },
            'Outbox shutdown released rows that had not been sent',
          );
        } catch (error) {
          this.options.logger?.error({ err: error }, 'Outbox shutdown release failed');
        }
      }

      const abandoned = [...this.owned].filter((id) => this.state.get(id) === 'IN_FLIGHT');
      if (abandoned.length > 0) {
        this.options.logger?.warn(
          { count: abandoned.length, owner: this.owner, leaseSeconds: this.leaseSeconds },
          'Outbox shutdown abandoned rows whose publish result is unknown; ' +
            'their leases will expire naturally and a duplicate delivery is possible',
        );
      }
    }

    this.stopHeartbeat();
    this.owned.clear();
    this.state.clear();
    this.token = null;
  }

  /**
   * Publishes one batch.
   *
   * Guards only against *concurrent* ticks within this process. Cross-replica
   * safety is the claim token's job, not this flag's. It deliberately does not
   * require the relay to be started, so an operator can force a drain during
   * incident response and a test can drive it deterministically.
   */
  async tick(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    this.ownershipUnknown = false;

    try {
      const claim = await this.options.store.claimPending({
        limit: this.options.batchSize ?? 100,
        owner: this.owner,
        leaseSeconds: this.leaseSeconds,
      });

      if (claim.rows.length === 0 || !claim.token) return 0;

      this.token = claim.token;
      this.owned = new Set(claim.rows.map((row) => row.id));
      this.state = new Map(claim.rows.map((row) => [row.id, 'NOT_SENT' as PublishState]));
      this.lastRenewAt = this.now();

      this.options.onClaimAttempt?.(claim.rows.length);
      if (claim.reclaimed > 0) this.options.onReclaimed?.(claim.reclaimed);

      this.options.logger?.debug(
        {
          count: claim.rows.length,
          reclaimed: claim.reclaimed,
          owner: this.owner,
          correlationId: claim.rows[0]?.correlationId,
        },
        'Outbox claim acquired',
      );

      this.startHeartbeat();

      try {
        return await this.publishBatch(claim.rows, claim.token);
      } finally {
        this.stopHeartbeat();
      }
    } catch (error) {
      this.options.logger?.error({ err: error }, 'Outbox relay tick failed');
      return 0;
    } finally {
      this.running = false;
    }
  }

  private async publishBatch(rows: readonly OutboxRow[], token: string): Promise<number> {
    const ids = rows.map((row) => row.id);
    for (const id of ids) this.state.set(id, 'IN_FLIGHT');

    try {
      await this.options.publisher.publish(rows);
    } catch (error) {
      for (const id of ids) this.state.set(id, 'NOT_SENT');
      // Fall back to per-row publishing so one poisoned message cannot block
      // the queue behind it. A row that keeps failing surfaces via its attempt
      // count and the stuck-relay alert.
      return await this.publishIndividually(rows, token, error);
    }

    for (const id of ids) this.state.set(id, 'PUBLISHED');
    const acknowledged = await this.acknowledge(ids, token);
    if (acknowledged > 0) {
      this.options.onBatchPublished?.(acknowledged);
      this.options.logger?.debug(
        { count: acknowledged, owner: this.owner },
        'Outbox batch published',
      );
    }
    return acknowledged;
  }

  private async publishIndividually(
    batch: readonly OutboxRow[],
    token: string,
    batchError: unknown,
  ): Promise<number> {
    this.options.logger?.warn(
      { err: describeError(batchError), count: batch.length },
      'Batch publish failed; retrying rows individually',
    );

    const published: string[] = [];

    for (const row of batch) {
      // A row already fenced away is not ours to publish again, and a lease we
      // can no longer renew must not outlive itself down this path either —
      // which is exactly how the old fallback could run for hours past its
      // claim.
      if (!this.owned.has(row.id) || this.ownershipUnknown) {
        this.options.logger?.warn(
          { outboxId: row.id, owner: this.owner, correlationId: row.correlationId },
          'Outbox row skipped: ownership was lost before it was published',
        );
        continue;
      }

      this.state.set(row.id, 'IN_FLIGHT');
      try {
        await this.options.publisher.publish([row]);
        this.state.set(row.id, 'PUBLISHED');
        published.push(row.id);
      } catch (error) {
        this.state.set(row.id, 'FAILED');
        await this.fail(row, token, error);
      }
    }

    const acknowledged = await this.acknowledge(published, token);
    if (acknowledged > 0) {
      this.options.onBatchPublished?.(acknowledged);
    }
    return acknowledged;
  }

  /** Acknowledges only rows still owned, and reports whatever was fenced. */
  private async acknowledge(ids: readonly string[], token: string): Promise<number> {
    const mine = ids.filter((id) => this.owned.has(id));
    if (mine.length === 0) return 0;

    if (this.ownershipUnknown) {
      // Not because fencing would fail — it would work — but because the
      // outcome is no longer predictable and has to be visible in a metric
      // rather than guessed at.
      this.recordFencing(mine.length, 'ack (ownership unknown)');
      for (const id of mine) this.owned.delete(id);
      return 0;
    }

    const acknowledged = await this.options.store.markPublished(mine, token);
    this.recordFencing(mine.length - acknowledged, 'ack');
    for (const id of mine) this.owned.delete(id);

    if (acknowledged > 0) {
      this.options.logger?.debug(
        { count: acknowledged, owner: this.owner },
        'Outbox rows acknowledged',
      );
    }
    return acknowledged;
  }

  private async fail(row: OutboxRow, token: string, error: unknown): Promise<void> {
    this.options.onPublishFailed?.(row, error);

    if (this.ownershipUnknown || !this.owned.has(row.id)) {
      this.recordFencing(1, 'markFailed (ownership lost)');
      this.owned.delete(row.id);
      return;
    }

    try {
      const updated = await this.options.store.markFailed(
        row.id,
        token,
        describeError(error),
        this.backoff,
      );
      this.recordFencing(1 - updated, 'markFailed');
      if (updated > 0) {
        this.options.logger?.warn(
          {
            outboxId: row.id,
            eventName: row.eventName,
            topic: row.topic,
            attempts: row.attempts + 1,
            correlationId: row.correlationId,
            owner: this.owner,
          },
          'Outbox row failed to publish; retry scheduled with the database clock',
        );
      }
    } finally {
      this.owned.delete(row.id);
    }
  }

  // -- renewal --------------------------------------------------------------

  private startHeartbeat(): void {
    this.stopHeartbeat();
    const interval = renewalIntervalMs(this.leaseSeconds);
    this.heartbeat = setInterval(() => void this.renewOnce(), interval);
    this.heartbeat.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
  }

  /**
   * One renewal tick.
   *
   * A transient failure is retried once immediately; if that fails too the
   * attempt is deferred to the next tick, and no other mutation runs in
   * between. Ownership only becomes *unknown* once the safety margin is gone —
   * `lastSuccessfulRenewAt + lease - renewalDeadline` — which with three
   * attempts per lease tolerates two consecutive losses.
   */
  async renewOnce(): Promise<void> {
    const token = this.token;
    if (!token || this.owned.size === 0) {
      this.stopHeartbeat();
      return;
    }

    const ids = [...this.owned];
    const deadline = renewalDeadlineMs(this.leaseSeconds);

    let renewed: string[] | undefined;
    try {
      renewed = await this.options.store.renew(ids, token, this.leaseSeconds, deadline);
    } catch (first) {
      try {
        renewed = await this.options.store.renew(ids, token, this.leaseSeconds, deadline);
      } catch (second) {
        this.options.logger?.warn(
          {
            err: describeError(second),
            firstErr: describeError(first),
            owner: this.owner,
            owned: ids.length,
          },
          'Outbox lease renewal failed twice; deferring to the next tick',
        );
        this.checkOwnershipWindow();
        return;
      }
    }

    this.lastRenewAt = this.now();

    const kept = new Set(renewed);
    const lost = ids.filter((id) => !kept.has(id));
    if (lost.length > 0) {
      // Fencing in SQL stops corruption. Dropping only the rows we actually
      // lost — instead of the whole batch — is what stops needless replay of
      // the ones we still hold.
      this.recordFencing(lost.length, 'renew');
      for (const id of lost) this.owned.delete(id);
      this.options.logger?.warn(
        { count: lost.length, retained: kept.size, owner: this.owner },
        'Outbox lease partially lost; the remaining rows are still owned',
      );
    }

    if (this.owned.size === 0) this.stopHeartbeat();
  }

  /** Past the margin, this relay stops mutating and says so. */
  private checkOwnershipWindow(): void {
    const unknownAt =
      this.lastRenewAt + this.leaseSeconds * 1000 - renewalDeadlineMs(this.leaseSeconds);
    if (this.now() > unknownAt && !this.ownershipUnknown) {
      this.ownershipUnknown = true;
      this.options.logger?.error(
        { owner: this.owner, owned: this.owned.size, leaseSeconds: this.leaseSeconds },
        'Outbox lease ownership is no longer certain; no further acknowledgement or failure ' +
          'will be written by this worker for these rows',
      );
    }
  }

  private recordFencing(count: number, where: string): void {
    if (count <= 0) return;
    this.options.onFenced?.(count);
    this.options.logger?.warn(
      { count, operation: where, owner: this.owner },
      'Outbox mutation was fenced: the claim token no longer matched. ' +
        'A duplicate delivery may have occurred; that cannot be confirmed producer-side',
    );
  }
}

function hostLabel(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return (require('node:os') as typeof import('node:os')).hostname();
  } catch {
    return 'unknown-host';
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`.slice(0, 1000);
  return String(error).slice(0, 1000);
}
