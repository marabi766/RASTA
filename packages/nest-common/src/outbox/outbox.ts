import { ulid } from 'ulid';
import type { OperationBudget } from '@rasta/config';
import {
  EVENT_HEADERS,
  assertSafeStreamSeq,
  formatStreamSeq,
  type EventEnvelope,
} from '@rasta/contracts';
import { tryGetContext, type RequestContext } from '../context/request-context';
import { isServiceCorrelationId } from '../middleware/request-context.middleware';

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
  /**
   * The tenant the event belongs to. Omitted: the request context's tenant, as
   * before. `null`: explicitly none — a genuinely platform-scoped event, which
   * must not inherit whatever tenant the acting user happens to have selected.
   */
  organizationId?: string | null;
  /** The event that caused this one, for causal tracing. */
  causationId?: string;
  occurredAt?: Date;
  /**
   * ADR-051 Phase B3 — this event's position in its stream, **already
   * allocated** by `allocateStreamSeqSql` inside the caller's transaction.
   *
   * Deliberately an input rather than something this function obtains.
   * `buildOutboxRow` is pure and does no I/O, which is what lets it be called
   * inside a transaction callback and unit-tested without a database; hiding
   * an allocation in here would need a client, would break that, and would put
   * the counter write somewhere a reader would not look for it.
   *
   * Optional, and it must stay optional: a legacy call site that has not been
   * migrated still produces a valid envelope with no stream fields, which is
   * exactly the mixed-version behaviour ADR-051 § 4 requires.
   */
  streamSeq?: number;
  /**
   * The stream this sequence belongs to — `partitionKey`, under the name the
   * envelope uses. Supplied explicitly rather than derived, so a caller cannot
   * allocate against one key and label the envelope with another.
   */
  streamKey?: string;
  /**
   * The event's id, when it must be reproducible. Omitted (every ordinary
   * call site): a fresh ULID. Supplied only by an operator-run re-emission of
   * a fact that already exists, so that running it twice yields the same id and
   * a consumer's idempotency marker makes the second run a no-op. Must be a
   * ULID: the id is also the outbox primary key and the consumers' marker.
   */
  eventId?: string;
  /**
   * Whose request this event records, and the chain it continues — for work
   * done **after** that request ended: a durable queue drained later by a
   * worker, where no request context is left to read (PR #483 r2 N1).
   *
   * Omitted (every call inside its request): taken from the request context,
   * as always — {@link captureOutboxProvenance} is that rule. Supplied: the
   * provenance captured by that same function when the request was received
   * and persisted with the work, and then **the ambient context is not read
   * at all** — not the actor, the correlation, the trace or the tenant
   * (`organizationId` falls back to none). A worker running inside some other
   * context cannot lend it its own. Validated: a provenance that is not one
   * the platform could have captured is refused here, not published.
   */
  provenance?: OutboxProvenance;
}

/**
 * An event's provenance on the envelope: the verified principal the work is
 * on behalf of (`actor`), and the correlation id of the request it began in.
 *
 * `actor` is the platform user id or the calling service, as the auth guard
 * verified it — never anything the request's body says — and `null` when the
 * request had neither: anonymous, which the audit trail records as the
 * producing service (`SYSTEM`). Holds no credential: a bearer token is never
 * part of it, so it is safe to persist.
 */
export interface OutboxProvenance {
  readonly actor: { readonly type: 'USER' | 'SERVICE'; readonly id: string } | null;
  readonly correlationId: string;
}

/** `actor.id` bound: the audit trail's `actor_id VARCHAR(256)`, printable ASCII, no spaces. */
const PROVENANCE_ACTOR_ID = /^[\x21-\x7E]{1,256}$/;

/**
 * The provenance of the request in `context`: the one rule both an event built
 * inside its request and work queued for later use, so the two cannot drift.
 * The actor comes only from the verified context (`userId`, else
 * `callerService`); the correlation id is the context's — already adopted or
 * minted by the request pipeline — or `fallbackCorrelationId` when there is
 * no context at all.
 */
export function captureOutboxProvenance(
  context: RequestContext | undefined = tryGetContext(),
  fallbackCorrelationId: string = ulid(),
): OutboxProvenance {
  return {
    actor: context?.userId
      ? { type: 'USER', id: context.userId }
      : context?.callerService
        ? { type: 'SERVICE', id: context.callerService }
        : null,
    correlationId: context?.correlationId ?? fallbackCorrelationId,
  };
}

/**
 * Refuses a provenance the platform could not have captured: a correlation id
 * outside what a verified service may forward (`isServiceCorrelationId`), an
 * actor of another type, or an actor id outside the audit trail's bound. For
 * provenance read back from storage, where the row is the only witness.
 */
export function assertOutboxProvenance(provenance: OutboxProvenance): void {
  if (!isServiceCorrelationId(provenance.correlationId)) {
    throw new Error('outbox provenance: the correlation id is not one the platform issues');
  }
  const { actor } = provenance;
  if (actor === null) return;
  if (actor.type !== 'USER' && actor.type !== 'SERVICE') {
    throw new Error('outbox provenance: the actor must be a USER or a SERVICE');
  }
  if (!PROVENANCE_ACTOR_ID.test(actor.id)) {
    throw new Error('outbox provenance: the actor id is not a bounded identifier');
  }
}

const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

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
  /**
   * ADR-051 — the persisted `outbox_message.stream_seq`.
   *
   * `null` for every row written before B3 and for any producer not yet
   * migrated. The relay reads it for one thing only: to publish one stream's
   * rows of a single claimed batch in this order ({@link orderForPublish}).
   * Selection, retry and acknowledgement are unchanged, and head-of-line
   * claiming is B4.
   */
  streamSeq?: number | null;
}

/**
 * Puts one claimed batch into the order it must reach Kafka in.
 *
 * The claim selects and returns rows by `created_at, id`. That decides *which*
 * rows a batch holds, but `created_at` is not commit order: a service stamping
 * the database's transaction-start `now()` gives the transaction that started
 * first the earlier stamp even when it queued on the stream's counter row lock
 * and committed second. `stream_seq` is allocated under that lock, so it is
 * commit order, and within one stream it is the order to publish in (ADR-051 § R4).
 *
 * Each stream's sequenced rows are re-sorted by `stream_seq` **within the
 * positions that stream already occupied**. Nothing moves across streams, and a
 * row with no `stream_seq` (written before B3, or by a producer not yet
 * migrated) stays exactly where the claim put it — so a batch with no
 * inversion comes back identical, and the change is confined to the rows that
 * were wrong.
 *
 * Batch scope only. A stream whose earlier row is not in this batch — leased by
 * another relay, in backoff, being retried — is untouched by this: that is
 * head-of-line claiming, ADR-051 B4.
 */
export function orderForPublish(rows: readonly OutboxRow[]): OutboxRow[] {
  const positionsByStream = new Map<string, number[]>();
  rows.forEach((row, index) => {
    if (row.streamSeq === null || row.streamSeq === undefined) return;
    const stream = `${row.topic}\u0000${row.partitionKey}`;
    const positions = positionsByStream.get(stream);
    if (positions) positions.push(index);
    else positionsByStream.set(stream, [index]);
  });

  const ordered = [...rows];
  for (const positions of positionsByStream.values()) {
    if (positions.length < 2) continue;
    const bySeq = positions
      .map((position) => rows[position] as OutboxRow)
      .sort((a, b) => (a.streamSeq as number) - (b.streamSeq as number));
    positions.forEach((position, i) => {
      ordered[position] = bySeq[i] as OutboxRow;
    });
  }
  return ordered;
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
  // Explicit provenance replaces the ambient context entirely (see the input).
  if (input.provenance) assertOutboxProvenance(input.provenance);
  const context = input.provenance ? undefined : tryGetContext();
  const partitionKey = input.partitionKey ?? input.aggregateId;

  // Both stream fields travel together or not at all. A sequence without the
  // key it was allocated against is unusable to a consumer, and a key without
  // a sequence implies an ordering that was never established — so a caller
  // that supplies one and not the other has a bug, and finds out here rather
  // than in somebody's dead-letter topic.
  if ((input.streamSeq === undefined) !== (input.streamKey === undefined)) {
    throw new Error(
      'buildOutboxRow: streamSeq and streamKey must be supplied together. ' +
        `Received streamSeq=${String(input.streamSeq)}, streamKey=${String(input.streamKey)}.`,
    );
  }
  if (input.streamSeq !== undefined) {
    assertSafeStreamSeq(input.streamSeq);
    if (input.streamKey !== partitionKey) {
      // The stream is `topic + partitionKey`. Labelling the envelope with a
      // different key than the row was allocated and partitioned by would put
      // the consumer's view of the stream out of step with the producer's.
      throw new Error(
        'buildOutboxRow: streamKey must equal the partition key the sequence was ' +
          `allocated against. Received streamKey="${input.streamKey}", ` +
          `partitionKey="${partitionKey}".`,
      );
    }
  }
  if (input.eventId !== undefined && !ULID_PATTERN.test(input.eventId)) {
    throw new Error('buildOutboxRow: eventId must be a ULID when supplied.');
  }
  const eventId = input.eventId ?? ulid();
  const occurredAt = input.occurredAt ?? new Date();
  const { actor, correlationId } = input.provenance ?? captureOutboxProvenance(context, eventId);
  // `null` is an explicit "no tenant"; only an omitted value falls back.
  const organizationId =
    input.organizationId === null
      ? null
      : (input.organizationId ?? context?.organizationId ?? null);

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
    ...(actor ? { actor: { type: actor.type, id: actor.id } } : {}),
    ...(input.streamSeq !== undefined && input.streamKey !== undefined
      ? { streamSeq: input.streamSeq, streamKey: input.streamKey }
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
    partitionKey,
    payload: envelope,
    headers: buildHeaders(envelope),
    organizationId,
    correlationId,
    createdAt: occurredAt,
    // The persisted column, kept identical to the envelope by construction:
    // both read the same input, so the row and the wire cannot disagree.
    streamSeq: input.streamSeq ?? null,
  };
}

/**
 * The platform headers the relay publishes with an envelope (`EVENT_HEADERS`).
 * Exported so a consumer that dead-letters an event it held back can restore
 * them exactly as the producer's relay wrote them (#240 r8).
 */
export function buildHeaders(envelope: EventEnvelope): Record<string, string> {
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
  // ADR-051 § D-5: the sequence only. There is no `x-stream-key` header —
  // the partition key is already the Kafka message key, and a second copy
  // could disagree with it.
  if (envelope.streamSeq !== undefined) {
    headers[EVENT_HEADERS.streamSeq] = formatStreamSeq(envelope.streamSeq);
  }
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

  /**
   * Gives rows back without counting a failure. Returns rows released.
   *
   * Only a stop releases, and `bound` is that stop's bound, read again at each
   * step: the store waits for its connection no longer than what is left of
   * it, then issues nothing once it reads zero, and takes what is left then as
   * its own `statement_timeout` — so a release the stop no longer waits for
   * neither starts late nor goes on holding row locks (`releaseSql`).
   */
  release(ids: readonly string[], token: string, bound: OutboxReleaseBound): Promise<number>;

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

/**
 * What a caller that owns the process's shutdown budget passes to `stop()`
 * (`OutboxShutdown`). Without it a stop is bounded by the component's own
 * setting alone.
 */
export interface OutboxStopOptions {
  /**
   * Epoch milliseconds (the component's own clock) by which the stop must
   * return, shared by every component draining in the same shutdown. A stop
   * waits for the earlier of this and its own bound.
   */
  deadlineAt?: number;
}

/**
 * The bound a stop gives its release: not a number of milliseconds read once,
 * but the stop's deadline itself, read again at each step (Codex r3 on #291).
 *
 * A budget fixed when the release began would be spent by whatever precedes
 * its statements — waiting for a pooled connection above all — while the stop
 * stops waiting at its deadline regardless. Read after that wait instead, it
 * says whether there is still a stop to release for, and how long the
 * statement may take.
 */
export interface OutboxReleaseBound {
  /**
   * Milliseconds left of the stop's bound, on the relay's clock. Zero once its
   * deadline has passed, the stop has stopped waiting for this release or the
   * run has ended — and zero from then on.
   */
  remainingMs(): number;
}

/**
 * A bound `ms` from now, for a release no stop is waiting on: tests, tooling.
 * Zero once that time has passed, so nothing of such a release starts later.
 */
export function releaseWithin(ms: number, now: () => number = Date.now): OutboxReleaseBound {
  const deadlineAt = now() + ms;
  return { remainingMs: () => Math.max(0, deadlineAt - now()) };
}

/**
 * A release that found its bound spent — before its connection, after it, or
 * once its UPDATE had returned — and so wrote nothing: no statement after the
 * bound, and an UPDATE that returned after it rolled back rather than
 * committed. The rows stay claimed until their lease expires.
 */
export class OutboxReleaseAbandoned extends Error {
  constructor() {
    super('outbox release: its bound was spent, so it wrote nothing; the lease decides');
    this.name = 'OutboxReleaseAbandoned';
  }
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
 * A renewal's transaction outlives its `statement_timeout` by this much, so
 * the statement timeout is what ends a slow renewal (`renewSql`).
 */
export const RENEWAL_TRANSACTION_MARGIN_MS = 5_000;

/**
 * The relay's lease renewal, as an operation budget (#268 r4): its
 * transaction's timeout, the renewal deadline plus
 * {@link RENEWAL_TRANSACTION_MARGIN_MS}. Every service with a relay declares it.
 */
export function outboxRenewalOperationBudget(env: {
  OUTBOX_CLAIM_LEASE_SECONDS: number;
}): OperationBudget {
  const deadlineMs = renewalDeadlineMs(env.OUTBOX_CLAIM_LEASE_SECONDS);
  return {
    name: 'OUTBOX_CLAIM_LEASE_SECONDS',
    budgetMs: deadlineMs + RENEWAL_TRANSACTION_MARGIN_MS,
    derivation:
      `the outbox relay's lease renewal: its own statement timeout, ${deadlineMs} ms at this ` +
      `lease, + ${RENEWAL_TRANSACTION_MARGIN_MS} ms`,
  };
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

/**
 * One run of the relay: from construction, or the first `start()` after a
 * stop, to the return of its stop. Stops never overlap, so neither do runs: a
 * `stop()` during a stop joins it, and a `start()` during a stop takes effect
 * once that stop has returned (Codex r1 on #291, finding 1).
 *
 * Between a stop's return and the next `start()` the relay stays in the run
 * that stop ended: a forced tick claims nothing, and a repeated `stop()` is
 * that run's stop, already returned. A stop therefore always settles the run
 * it was called in, and no tick runs in a run whose stop has returned (Codex
 * r2 on #291).
 *
 * A tick and a renewal keep the run they began in, so whatever of them
 * outlives that stop (a claim, a publish or a renewal still pending at its
 * deadline) finds, when it resumes, that the stop has already settled the run,
 * and leaves it as the stop left it (Codex r1 on #280, finding 2).
 */
interface RelayRun {
  /** Set when a stop begins: from then on the run claims, publishes and renews nothing new. */
  stopping: boolean;
  /**
   * Set when that stop returns: from then on nothing of the run writes to the
   * store or to the relay's state. A stop returns with a tick still running
   * only once its own deadline has passed, so none of it remains for a release
   * or an acknowledgement: rows the run still holds return to the queue when
   * their lease expires, and any that reached the broker are delivered again —
   * at-least-once, deduplicated by consumers on the event id (ADR-021).
   */
  ended: boolean;
  /** The run's one stop, once called: every later `stop()` in the run joins it. */
  stop?: Promise<void>;
}

const newRun = (): RelayRun => ({ stopping: false, ended: false });

export class OutboxRelay {
  private timer?: NodeJS.Timeout;
  private heartbeat?: NodeJS.Timeout;
  private running = false;
  private stopped = true;
  /** Whether the current run's stop is in progress. */
  private draining = false;
  /** A `start()` made while a stop was in progress, applied when it returns. */
  private startDeferred = false;
  /** The current run; replaced by the first `start()` after its stop has returned. */
  private run: RelayRun = newRun();

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
    this.shutdownGraceMs = (options.shutdownGraceSeconds ?? 20) * 1000;
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (this.draining) {
      // Not now: a second stop would then drain the stopping run again, and
      // its return would end that run while the next one was already claiming
      // (Codex r1 on #291, finding 1). The stop in progress starts the relay
      // when it returns — unless another stop() joins it first.
      this.startDeferred = true;
      return;
    }
    if (!this.stopped) return;
    this.stopped = false;
    // A run that was never stopped (forced ticks before the first start())
    // carries on, so the next stop still fences whatever of it is pending.
    if (this.run.ended) this.run = newRun();
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
   * Shutdown never waits indefinitely: every wait of a stop — for the tick,
   * and for the release — ends by its bound, so a pod cannot sit in
   * `Terminating` behind a Kafka request that cannot be cancelled or a release
   * blocked on a lock. The bound is the shutdown grace from configuration;
   * with `deadlineAt` (`OutboxShutdown`, D-052) the tick's wait ends by the
   * earlier of the two and the release by that shared deadline. A release
   * still unfinished at its bound is abandoned: nothing was sent, and the rows
   * return to the queue when their lease expires (Codex r1 on #291, finding 2).
   * An abandoned release issues no statement after the stop has returned, and
   * commits nothing it had not by then (Codex r3 on #291; `releaseSql`).
   *
   * Once a stop has begun the run starts nothing new: no claim, no publish
   * (the per-row fallback included), no heartbeat. A claim that returns while
   * the stop still waits is released by it, unsent; a publish that returns
   * then is acknowledged or failed as usual. Whatever returns after the stop
   * has returned writes nothing and is left to its lease ({@link RelayRun}).
   *
   * One stop at a time, and one per run: a call while a stop is in progress
   * joins it — returning when it returns, by that stop's bound — and cancels a
   * `start()` made meanwhile; a call after it has returned, with no `start()`
   * since, is that same stop and returns at once rather than waiting a second
   * grace. Nothing can have run since: until the next `start()` a forced tick
   * claims nothing.
   */
  stop(options: OutboxStopOptions = {}): Promise<void> {
    this.startDeferred = false;
    const run = this.run;
    run.stop ??= this.drain(run, options.deadlineAt);
    return run.stop;
  }

  private async drain(run: RelayRun, deadlineAt: number | undefined): Promise<void> {
    run.stopping = true;
    this.draining = true;
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;

    const startedAt = this.now();
    const deadline = Math.min(startedAt + this.shutdownGraceMs, deadlineAt ?? Infinity);
    const releaseBy = deadlineAt ?? startedAt + this.shutdownGraceMs;
    try {
      while (this.running && this.now() < deadline) {
        await new Promise((resolve) => setImmediate(resolve));
      }

      const token = this.token;
      if (token) {
        const notSent = [...this.owned].filter((id) => this.state.get(id) === 'NOT_SENT');
        if (notSent.length > 0) await this.release(run, notSent, token, releaseBy);

        const abandoned = [...this.owned].filter((id) => this.state.get(id) === 'IN_FLIGHT');
        if (abandoned.length > 0) {
          this.options.logger?.warn(
            { count: abandoned.length, owner: this.owner, leaseSeconds: this.leaseSeconds },
            'Outbox shutdown abandoned rows whose publish result is unknown; ' +
              'their leases will expire naturally and a duplicate delivery is possible',
          );
        }
      }
    } finally {
      this.stopHeartbeat();
      this.owned.clear();
      this.state.clear();
      this.token = null;
      run.ended = true;
      this.draining = false;
      if (this.startDeferred) {
        this.startDeferred = false;
        this.start();
      }
    }
  }

  /**
   * The stop's release of rows nothing was sent for, waited for until
   * `releaseBy` and no longer. Not released is safe: the lease lapses on its
   * own. With no time left the release is not even begun.
   *
   * The store reads the bound again once it has a connection and before each
   * statement (Codex r3 on #291). It reads zero from the moment the stop stops
   * waiting — set here, before the stop returns, not inferred from a clock —
   * so a release whose connection arrives after the stop has returned issues
   * nothing, and one whose UPDATE returns then is rolled back. Its outcome,
   * whenever it settles, is no longer this relay's to record.
   */
  private async release(
    run: RelayRun,
    ids: string[],
    token: string,
    releaseBy: number,
  ): Promise<void> {
    let abandoned = false;
    const bound: OutboxReleaseBound = {
      remainingMs: () => (abandoned || run.ended ? 0 : Math.max(0, releaseBy - this.now())),
    };
    const boundMs = bound.remainingMs();
    if (boundMs > 0) {
      /** Whether the release ran: false when the store found the bound spent first. */
      const releasing = this.options.store.release(ids, token, bound).then(
        (released) => {
          if (abandoned) return true;
          this.recordFencing(ids.length - released, 'release');
          this.options.logger?.debug(
            { count: released, owner: this.owner },
            'Outbox shutdown released rows that had not been sent',
          );
          return true;
        },
        (error: unknown) => {
          if (abandoned || error instanceof OutboxReleaseAbandoned) return false;
          this.options.logger?.error({ err: error }, 'Outbox shutdown release failed');
          return true;
        },
      );
      if ((await withinDeadline(releasing, boundMs)) === 'finished' && (await releasing)) return;
    }
    abandoned = true;
    this.options.logger?.warn(
      { count: ids.length, owner: this.owner, leaseSeconds: this.leaseSeconds },
      'Outbox shutdown release did not finish by the shutdown deadline; the rows ' +
        'return to the queue when their lease expires',
    );
  }

  /**
   * Publishes one batch.
   *
   * Guards only against *concurrent* ticks within this process. Cross-replica
   * safety is the claim token's job, not this flag's. It deliberately does not
   * require the relay to be started, so an operator can force a drain during
   * incident response and a test can drive it deterministically — but it
   * claims nothing once a stop has begun, until the next `start()`: a stopped
   * relay stays stopped, and a tick it allowed would be one no `stop()` fences
   * (Codex r2 on #291).
   */
  async tick(): Promise<number> {
    const run = this.run;
    if (this.running || run.stopping) return 0;
    this.running = true;
    this.ownershipUnknown = false;

    try {
      const claim = await this.options.store.claimPending({
        limit: this.options.batchSize ?? 100,
        owner: this.owner,
        leaseSeconds: this.leaseSeconds,
      });

      if (claim.rows.length === 0 || !claim.token) return 0;

      if (run.ended) {
        // The stop returned while this claim was pending, so its deadline has
        // passed: nothing is published, renewed or released.
        this.options.logger?.warn(
          { count: claim.rows.length, owner: this.owner, leaseSeconds: this.leaseSeconds },
          'Outbox claim returned after the relay had stopped; its rows were not published ' +
            'and return to the queue when their lease expires',
        );
        return 0;
      }

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

      // The stop began while this claim was pending and is waiting for this
      // tick: it releases these rows, none of which was sent.
      if (run.stopping) return 0;

      this.startHeartbeat();

      try {
        return await this.publishBatch(claim.rows, claim.token, run);
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

  private async publishBatch(
    claimed: readonly OutboxRow[],
    token: string,
    run: RelayRun,
  ): Promise<number> {
    // Whatever order the store returned, one stream's rows go out in stream_seq
    // order. Done here as well as in the shared claim so a store with its own
    // claim cannot silently lose the property.
    const rows = orderForPublish(claimed);
    const ids = rows.map((row) => row.id);
    for (const id of ids) this.state.set(id, 'IN_FLIGHT');

    try {
      await this.options.publisher.publish(rows);
    } catch (error) {
      if (this.endedDuringPublish(run, ids.length)) return 0;
      for (const id of ids) this.state.set(id, 'NOT_SENT');
      // Fall back to per-row publishing so one poisoned message cannot block
      // the queue behind it. A row that keeps failing surfaces via its attempt
      // count and the stuck-relay alert.
      return await this.publishIndividually(rows, token, error, run);
    }

    // Within the stop's deadline a publish that returned is acknowledged as
    // usual — the stop waits for it so that it can be — and after it, not.
    if (this.endedDuringPublish(run, ids.length)) return 0;
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
    run: RelayRun,
  ): Promise<number> {
    this.options.logger?.warn(
      { err: describeError(batchError), count: batch.length },
      run.stopping
        ? 'Batch publish failed while the relay is stopping; no row is retried'
        : 'Batch publish failed; retrying rows individually',
    );

    const published: string[] = [];

    for (const row of batch) {
      // Once a stop has begun no further row is sent: the rest stay NOT_SENT,
      // for the stop to release.
      if (run.stopping) break;

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
        if (this.endedDuringPublish(run, published.length + 1)) return 0;
        this.state.set(row.id, 'PUBLISHED');
        published.push(row.id);
      } catch (error) {
        if (this.endedDuringPublish(run, published.length + 1)) return 0;
        this.state.set(row.id, 'FAILED');
        await this.fail(row, token, error);
      }
    }

    if (this.endedDuringPublish(run, published.length)) return 0;
    const acknowledged = await this.acknowledge(published, token);
    if (acknowledged > 0) {
      this.options.onBatchPublished?.(acknowledged);
    }
    return acknowledged;
  }

  /**
   * Whether the run's stop returned while this tick awaited a publish of
   * `count` rows. Their result is then neither acknowledged nor failed: the
   * stop has already settled the run, so they stay claimed until their lease
   * expires and are delivered again.
   */
  private endedDuringPublish(run: RelayRun, count: number): boolean {
    if (!run.ended) return false;
    if (count > 0) {
      this.options.logger?.warn(
        { count, owner: this.owner, leaseSeconds: this.leaseSeconds },
        'Outbox publish returned after the relay had stopped; its rows are not acknowledged, ' +
          'return to the queue when their lease expires and are delivered again',
      );
    }
    return true;
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
   *
   * A renewal still pending when the stop returns changes nothing once it
   * does, and is not retried.
   */
  async renewOnce(): Promise<void> {
    const run = this.run;
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
      if (run.ended) return;
      try {
        renewed = await this.options.store.renew(ids, token, this.leaseSeconds, deadline);
      } catch (second) {
        if (run.ended) return;
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

    if (run.ended) return;
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

/**
 * How `work` ended within `boundMs`: `finished`, or `abandoned` once the bound
 * passed first. A rejection counts as finished (the callers handle their own
 * errors), and the timer is cleared and unreferenced either way.
 */
export async function withinDeadline(
  work: Promise<unknown>,
  boundMs: number,
): Promise<'finished' | 'abandoned'> {
  if (boundMs <= 0) return 'abandoned';
  let timer: NodeJS.Timeout | undefined;
  const outcome = await Promise.race([
    work.then(
      () => 'finished' as const,
      () => 'finished' as const,
    ),
    new Promise<'abandoned'>((resolve) => {
      timer = setTimeout(() => resolve('abandoned'), boundMs);
      timer.unref?.();
    }),
  ]);
  clearTimeout(timer);
  return outcome;
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
