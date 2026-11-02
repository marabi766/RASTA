import { ulid } from 'ulid';
import { tryGetContext, type RequestContext } from '../context/request-context';
import { isServiceCorrelationId } from '../middleware/request-context.middleware';

/**
 * Whose request an event records, and the chain it continues (PR #483 r2 N1,
 * r3 F1/F2).
 *
 * An event built inside its request takes this from the request context and
 * from nothing else (`buildOutboxRow`). Work done **after** its request ended
 * — a durable queue drained later by a worker — cannot read that context, so
 * the request's provenance is captured when it is received, persisted with
 * the work, and restored for the event. That restoration is the one place a
 * provenance enters an event other than from the ambient context, and it is
 * deliberately narrow:
 *
 *   - An {@link OutboxProvenance} is opaque. Only {@link captureOutboxProvenance}
 *     (the verified ambient context) and {@link restoreOutboxProvenance} (a
 *     persisted capture) issue one; an object literal neither type-checks (the
 *     brand's key is not exported) nor passes at runtime (issued values are
 *     remembered, {@link isOutboxProvenance}).
 *   - `restoreOutboxProvenance` and `buildRestoredOutboxRow` are referenced
 *     only by the registration intake (`scripts/outbox-provenance-restoration-guard.test.mjs`
 *     fails on any other file).
 *   - The ordinary `OutboxMessageInput` carries no provenance at all.
 */

/**
 * The principal of the request.
 *
 * `USER` / `SERVICE`: as the auth guard verified it — the platform user id, or
 * the calling service. `ANONYMOUS`: an HTTP request that presented no
 * credential, on a public route; it has no id, by definition, and is never
 * given one. `null` (on {@link OutboxProvenance.actor}) is not a request at
 * all: background work, which the audit trail records as the producing
 * service (`SYSTEM`).
 */
export type OutboxActor =
  { readonly type: 'USER' | 'SERVICE'; readonly id: string } | { readonly type: 'ANONYMOUS' };

/** The brand's key. Not exported: no code outside this module can write it. */
declare const issuedByThePlatform: unique symbol;

/**
 * A provenance the platform captured — opaque, see the module comment. Holds
 * no credential: a bearer token is never part of it, so it is safe to persist.
 */
export interface OutboxProvenance {
  readonly actor: OutboxActor | null;
  readonly correlationId: string;
  readonly [issuedByThePlatform]: true;
}

/** Its stored form: what a queue table keeps in its own columns, apart from the work. */
export interface PersistedOutboxProvenance {
  readonly actorType: 'USER' | 'SERVICE' | 'ANONYMOUS' | null;
  readonly actorId: string | null;
  readonly correlationId: string;
}

/** `actor.id` bound: the audit trail's `actor_id VARCHAR(256)`, printable ASCII, no spaces. */
const PROVENANCE_ACTOR_ID = /^[\x21-\x7E]{1,256}$/;

/** Every provenance this module issued. A copy, a spread or a literal is not in it. */
const issued = new WeakSet<object>();

function issue(actor: OutboxActor | null, correlationId: string): OutboxProvenance {
  const provenance = Object.freeze({
    actor: actor === null ? null : Object.freeze({ ...actor }),
    correlationId,
  });
  issued.add(provenance);
  return provenance as unknown as OutboxProvenance;
}

/** Whether `value` was issued by this module — not merely shaped like one. */
export function isOutboxProvenance(value: unknown): value is OutboxProvenance {
  return typeof value === 'object' && value !== null && issued.has(value);
}

/**
 * The principal of `context`: the one rule an event built inside its request
 * and a capture for later both use, so the two cannot drift.
 *
 * `ANONYMOUS` only for a context the HTTP pipeline created and no credential
 * upgraded (`authType: 'ANONYMOUS'`, `RequestContextMiddleware` and the auth
 * guard's public-route branch). Every background context — a consumer, a
 * sweeper, a scheduler (`createSystemContext`, `authType: 'SERVICE'`) — and
 * no context at all is `null`: system work, never anonymous.
 */
export function actorOf(context: RequestContext | undefined): OutboxActor | null {
  if (context?.userId) return { type: 'USER', id: context.userId };
  if (context?.callerService) return { type: 'SERVICE', id: context.callerService };
  if (context?.authType === 'ANONYMOUS') return { type: 'ANONYMOUS' };
  return null;
}

/**
 * The provenance of the request being handled now, to persist with work that
 * will finish after it: the verified ambient context and nothing else — there
 * is no parameter to hand it another. Outside any context: no actor, and a
 * fresh correlation id.
 */
export function captureOutboxProvenance(): OutboxProvenance {
  const context = tryGetContext();
  return issue(actorOf(context), context?.correlationId ?? ulid());
}

/** The stored form of a provenance this module issued; refuses anything else. */
export function persistedOutboxProvenance(provenance: OutboxProvenance): PersistedOutboxProvenance {
  assertIssued(provenance);
  const { actor, correlationId } = provenance;
  return {
    actorType: actor === null ? null : actor.type,
    actorId: actor !== null && actor.type !== 'ANONYMOUS' ? actor.id : null,
    correlationId,
  };
}

/**
 * A persisted capture, back as a provenance — **the registration intake's
 * only** (see the module comment; the restoration guard holds the boundary).
 *
 * The row is the only witness, so it is held to what a capture can produce: a
 * correlation id a verified service may forward (`isServiceCorrelationId`); a
 * `USER` or `SERVICE` with a bounded printable id; `ANONYMOUS` or none with no
 * id at all. Anything else is refused, not published.
 */
export function restoreOutboxProvenance(row: PersistedOutboxProvenance): OutboxProvenance {
  if (!isServiceCorrelationId(row.correlationId)) {
    throw new Error('outbox provenance: the correlation id is not one the platform issues');
  }
  switch (row.actorType) {
    case null:
    case 'ANONYMOUS':
      if (row.actorId !== null) {
        throw new Error('outbox provenance: an anonymous or system origin has no actor id');
      }
      return issue(row.actorType === null ? null : { type: 'ANONYMOUS' }, row.correlationId);
    case 'USER':
    case 'SERVICE':
      if (row.actorId === null || !PROVENANCE_ACTOR_ID.test(row.actorId)) {
        throw new Error('outbox provenance: the actor id is not a bounded identifier');
      }
      return issue({ type: row.actorType, id: row.actorId }, row.correlationId);
    default:
      throw new Error('outbox provenance: the actor must be a USER, a SERVICE or ANONYMOUS');
  }
}

/** Throws unless `value` was issued by this module. */
export function assertIssued(value: unknown): asserts value is OutboxProvenance {
  if (!isOutboxProvenance(value)) {
    throw new Error(
      'outbox provenance: not one the platform captured (only captureOutboxProvenance and ' +
        'restoreOutboxProvenance issue one)',
    );
  }
}
