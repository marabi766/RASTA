import { ownerTopicOf, type EventEnvelope } from '@rasta/contracts';
import type { EventDelivery } from './event-consumer';

/**
 * Where an event sits in its producer's history, for a consumer that applies
 * STATE (a replica, a status) rather than appends facts.
 *
 * `<topic>` and `<topic>.retry` are separate streams, so a replayed event can
 * be delivered after a newer one that was applied first: the same key does not
 * order across them. A consumer that stores the position of the last event it
 * applied per (subject, producer) can tell such an event from a fresh one and
 * leave the newer state alone.
 *
 * The position is the envelope's `streamSeq` when the producer sequenced it,
 * else `occurredAt` with the event id as the tie-breaker (ULIDs sort by time).
 * It is a plain JSON value so a service stores it in one `jsonb` column.
 */
export type SourcePosition = {
  /** `streamSeq` of the stream `streamKey`, when the producer sequenced the event. */
  seq: number | null;
  streamKey: string | null;
  /** `occurredAt` as an ISO instant. */
  at: string;
  eventId: string;
};

/** The position `envelope` holds in its producer's stream. */
export function sourcePositionOf(envelope: EventEnvelope): SourcePosition {
  const stated = new Date(envelope.occurredAt);
  return {
    seq: envelope.streamSeq ?? null,
    streamKey: envelope.streamSeq === undefined ? null : (envelope.streamKey ?? null),
    at: Number.isNaN(stated.getTime()) ? envelope.occurredAt : stated.toISOString(),
    eventId: envelope.eventId,
  };
}

/**
 * Whether `incoming` is strictly older than `applied`: the event must not
 * change state that a newer event already set. An equal position is not
 * older — applying it again is the idempotent case, and `processed_event`
 * decides whether it is a duplicate at all.
 *
 * Two sequenced events of one stream compare by sequence; anything else
 * (unsequenced, or from a different stream key) by `occurredAt`, then event id.
 */
export function isOlderThanApplied(
  applied: SourcePosition | null | undefined,
  incoming: SourcePosition,
): boolean {
  if (!applied) return false;
  if (
    applied.seq !== null &&
    incoming.seq !== null &&
    applied.streamKey !== null &&
    applied.streamKey === incoming.streamKey
  ) {
    return incoming.seq < applied.seq;
  }
  const a = Date.parse(applied.at);
  const b = Date.parse(incoming.at);
  if (Number.isNaN(a) || Number.isNaN(b)) return false;
  if (b !== a) return b < a;
  return incoming.eventId < applied.eventId;
}

/** Positions per producer, as stored: `{ "asset-service": SourcePosition, … }`. */
export type SourcePositions = Record<string, SourcePosition>;

/** Reads what a `jsonb` column returned; anything malformed reads as no position. */
export function readSourcePositions(value: unknown): SourcePositions {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const out: SourcePositions = {};
  for (const [producer, raw] of Object.entries(value)) {
    if (typeof raw !== 'object' || raw === null) continue;
    const p = raw as Partial<SourcePosition>;
    if (typeof p.at !== 'string' || typeof p.eventId !== 'string') continue;
    out[producer] = {
      seq: typeof p.seq === 'number' ? p.seq : null,
      streamKey: typeof p.streamKey === 'string' ? p.streamKey : null,
      at: p.at,
      eventId: p.eventId,
    };
  }
  return out;
}

/**
 * The delivery as if it had arrived on the topic that owns the event. A replay
 * on `<topic>.retry` is the same event as on `<topic>`; consumers that key on
 * the delivery topic (audit's projections, notification's source topic) must
 * not see the retry twin as a different topic. Other deliveries are returned
 * as they are.
 */
export function originalDelivery(delivery: EventDelivery): EventDelivery {
  const topic = ownerTopicOf(delivery.topic);
  return topic === delivery.topic ? delivery : Object.freeze({ ...delivery, topic });
}
