import {
  MAX_RETURN_LINES,
  MAX_RETURN_QUANTITY,
  ORDER_LINE_ID_MAX,
  RETURN_REASON_MAX,
  isReturnCommand,
  type ReturnCommand,
} from './return-fields';
import type { ReturnRequestBody } from './return-request';
import {
  fencedSlot,
  keysUnder,
  locate,
  ownedHere,
  purgeForeign,
  storedKeyOf,
  type AccountTags,
  type AnswerOutcome,
  type Binding,
  type StoredKey,
} from './unresolved-tenancy';

export type { AnswerOutcome };

/**
 * A return command whose outcome is unknown, kept in `sessionStorage` so that
 * a reload cannot turn "maybe done" back into a fresh form with a fresh key —
 * `lib/unresolved-dispute.ts`'s rules, with the shared slot of PR 332
 * (`lib/unresolved-statement.ts` on that branch), for return requests.
 *
 * ## Why a fresh key is not safe here
 *
 * A request sent under key K can commit unseen; the same lines asked again
 * under a new key are a **second request** for the same goods (the service
 * then refuses only what no longer fits the order). Only the original key with
 * the original body is answered by the service's stored response instead of
 * being executed again. A decision or a withdrawal repeated under a new key is
 * refused by the state it left behind, but its outcome is just as unknown until
 * the page is read again, so it is held the same way.
 *
 * ## What is kept
 *
 * Per slot — an order's request form, or one return request's commands — the
 * command, the submission id, a request's body exactly as it was sent (reason
 * and lines: what makes the retry the same request), the original correlation
 * id, when it was saved, and its replay stamp (`server/return-replay.ts`, a
 * signed deadline, not a credential), with the two one-way login tags
 * (`submissionBinding`). No token, no session value, no CSRF value.
 *
 * ## One unresolved command per slot, never replaced
 *
 * A request's authorize and reject forms (the supplier's) and its cancel form
 * (the buyer's) share its slot: a new submission never **replaces** another
 * submission's record — saving it is refused (`HELD`) and the form is not sent
 * — and a record is cleared only by the submission it belongs to
 * (`clearUnresolvedReturn` takes its id), on a definite outcome of that
 * submission. Otherwise an authorization whose answer was lost could be
 * overwritten by a rejection, whose refusal would then erase the
 * authorization's key and its warning. Every change is announced to the page's
 * other forms (`subscribeUnresolvedReturns`), which stay view-only while
 * another command holds the slot.
 *
 * ## Never silently gone
 *
 * An entry older than the session's lifetime, and every entry at logout, is
 * **reduced** to a marker — no body, no login tag, no stamp — shown view-only
 * as "the outcome is unknown" until the person acknowledges it. A confirmed
 * answer (the action redirects) drops it; otherwise only the person does, with
 * the labelled action the uncertainty view offers once the same request has
 * been tried again or can no longer be. Another person's page drops every
 * entry of anyone else (`purgeForeignUnresolvedReturns`).
 */

const KEY_PREFIX = 'rasta.unresolved-return.';
const VERSION = 1;

const SUBMISSION_ID = /^sub_[A-Za-z0-9_-]{8,128}$/;
const MAX_TAG_LENGTH = 128;
const MAX_STAMP_LENGTH = 4096;
const ORDER_LINE_ID = /^[A-Za-z0-9_-]+$/;

/**
 * Until when the server will let the same request be sent again: `token` is
 * checked by the action, `until` (milliseconds since the epoch) only decides
 * which controls are drawn.
 */
export interface ReplayStamp {
  readonly token: string;
  readonly until: number;
}

/** A fresh submission id for one return form, with its signed replay deadline. */
export interface ReturnSubmission {
  readonly id: string;
  readonly replay: ReplayStamp;
}

export interface UnresolvedReturn {
  readonly command: ReturnCommand;
  readonly submissionId: string;
  /** A request's body as sent; null for every other command, and in a marker. */
  readonly body: ReturnRequestBody | null;
  /** Null while the first send has not been answered. */
  readonly correlationId: string | null;
  /** Milliseconds since the epoch, browser clock. */
  readonly savedAt: number;
  /** Null in a marker, and once the server has said the deadline passed. */
  readonly replay: ReplayStamp | null;
  /** True for the outcome-unknown marker: nothing re-sendable is kept. */
  readonly marker: boolean;
}

/** Where an entry is kept: an order's request form, or one return request. */
export type ReturnScope =
  | { readonly kind: 'ORDER'; readonly orderId: string }
  | { readonly kind: 'RETURN'; readonly returnId: string };

type Stored = Omit<UnresolvedReturn, 'marker'> & {
  readonly v: typeof VERSION;
  readonly marker: boolean;
  readonly scope: string;
  readonly owner: string;
  readonly session?: string;
};

export type RestoredReturn =
  /** Same login, before the replay deadline: the same request may be sent again. */
  | { readonly kind: 'RETRYABLE'; readonly entry: UnresolvedReturn }
  /** Another login, past the replay deadline, or a marker: shown, never re-sent. */
  | { readonly kind: 'VIEW_ONLY'; readonly entry: UnresolvedReturn };

let accountClosing = false;

/** Same-tab listeners: the forms of a page, told when a slot changes (`sessionStorage` is per tab). */
const listeners = new Set<() => void>();

/** Called on every save and clear; returns the unsubscribe. */
export function subscribeUnresolvedReturns(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function changed(): void {
  for (const listener of [...listeners]) listener();
}

export function markReturnsClosing(): void {
  accountClosing = true;
}

export function markReturnsOpen(): void {
  accountClosing = false;
}

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

function scopeOf(scope: ReturnScope): string {
  return scope.kind === 'ORDER' ? `order.${scope.orderId}` : `return.${scope.returnId}`;
}

/** Which commands a slot holds: the request on an order, the three decisions on a request. */
function belongs(scope: string, command: ReturnCommand): boolean {
  return scope.startsWith('order.') === (command === 'REQUEST');
}

function tag(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_TAG_LENGTH;
}

function replayOf(value: unknown): ReplayStamp | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'object') return undefined;
  const stamp = value as Record<string, unknown>;
  if (
    typeof stamp.token !== 'string' ||
    stamp.token.length === 0 ||
    stamp.token.length > MAX_STAMP_LENGTH ||
    typeof stamp.until !== 'number' ||
    !Number.isFinite(stamp.until)
  ) {
    return undefined;
  }
  return { token: stamp.token, until: stamp.until };
}

function bodyOf(value: unknown): ReturnRequestBody | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'object') return undefined;
  const body = value as Record<string, unknown>;
  if (
    typeof body.reason !== 'string' ||
    body.reason.length < 1 ||
    body.reason.length > RETURN_REASON_MAX ||
    !Array.isArray(body.lines) ||
    body.lines.length < 1 ||
    body.lines.length > MAX_RETURN_LINES
  ) {
    return undefined;
  }
  const lines: { orderLineId: string; quantity: number }[] = [];
  for (const raw of body.lines) {
    if (typeof raw !== 'object' || raw === null) return undefined;
    const line = raw as Record<string, unknown>;
    if (
      typeof line.orderLineId !== 'string' ||
      line.orderLineId.length > ORDER_LINE_ID_MAX ||
      !ORDER_LINE_ID.test(line.orderLineId) ||
      typeof line.quantity !== 'number' ||
      !Number.isInteger(line.quantity) ||
      line.quantity < 1 ||
      line.quantity > MAX_RETURN_QUANTITY
    ) {
      return undefined;
    }
    lines.push({ orderLineId: line.orderLineId, quantity: line.quantity });
  }
  return { reason: body.reason, lines };
}

function parse(raw: string, scope: string): Stored | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const entry = value as Record<string, unknown>;
  if (
    entry.v !== VERSION ||
    entry.scope !== scope ||
    !isReturnCommand(entry.command) ||
    !belongs(scope, entry.command) ||
    !tag(entry.submissionId) ||
    !SUBMISSION_ID.test(entry.submissionId) ||
    !(entry.correlationId === null || tag(entry.correlationId)) ||
    !tag(entry.owner) ||
    typeof entry.savedAt !== 'number' ||
    !Number.isFinite(entry.savedAt)
  ) {
    return null;
  }
  const common = {
    v: VERSION,
    scope,
    command: entry.command,
    submissionId: entry.submissionId,
    correlationId: entry.correlationId,
    savedAt: entry.savedAt,
    owner: entry.owner,
  } as const;
  if (entry.marker === true) return { ...common, marker: true, replay: null, body: null };

  const replay = replayOf(entry.replay);
  const body = bodyOf(entry.body);
  if (entry.marker !== false || !tag(entry.session) || replay === undefined || body === undefined) {
    return null;
  }
  // A request carries the body it sent; nothing else carries one.
  if ((entry.command === 'REQUEST') !== (body !== null)) return null;
  return { ...common, marker: false, session: entry.session, replay, body };
}

/** What a marker keeps: nothing of the body, the login or the stamp. */
function markerOf(entry: Stored): string {
  return JSON.stringify({
    v: VERSION,
    marker: true,
    scope: entry.scope,
    command: entry.command,
    submissionId: entry.submissionId,
    correlationId: entry.correlationId,
    savedAt: entry.savedAt,
    owner: entry.owner,
  });
}

function stored(store: Storage, key: string): Stored | null {
  const located = storedKeyOf(KEY_PREFIX, key);
  const raw = store.getItem(key);
  return located === null || raw === null ? null : parse(raw, located.scope);
}

/** `parse` for `lib/unresolved-tenancy.ts`, which hands the key too. */
const parseEntry = (raw: string, key: StoredKey): Stored | null => parse(raw, key.scope);

/** The quarantine of this kind (`lib/unresolved-tenancy.ts`, `app/UnresolvedQuarantine.tsx`). */
/** The one slot per scope, fenced to its submission (`lib/unresolved-tenancy.ts`). */
const slot = fencedSlot(KEY_PREFIX, parseEntry, { closing: () => accountClosing, changed });

export const returnQuarantine = slot.quarantine;

/**
 * Logout: every entry reduced to a marker; a record that does not read, and one
 * from before entries were kept per organization, are left as they are.
 */
export function purgeAllUnresolvedReturns(): void {
  markReturnsClosing();
  try {
    const store = storage();
    if (!store) return;
    for (const key of keysUnder(store, KEY_PREFIX)) {
      // An entry from before entries were kept per organization stays as it is: whose it
      // is cannot be told here, and it is never written over (PR 405 review 2, F1).
      if (storedKeyOf(KEY_PREFIX, key)?.kind !== 'TENANT') continue;
      const entry = stored(store, key);
      if (entry) store.setItem(key, markerOf(entry));
    }
  } catch {
    // Unavailable storage holds nothing to purge.
  }
  changed();
}

/**
 * A page for this person: entries of anyone else are reduced to content-free
 * markers; theirs stay, for every organization, and nothing that cannot be
 * attributed is touched (`lib/unresolved-tenancy.ts`).
 */
export function purgeForeignUnresolvedReturns(tags: AccountTags): void {
  try {
    const store = storage();
    if (!store) return;
    purgeForeign(store, KEY_PREFIX, tags, parseEntry);
  } catch {
    // See above.
  }
}

/**
 * `SAVED`: stored. `HELD`: another submission's record holds this slot — it is
 * left exactly as it was, and this one must not be sent. `UNAVAILABLE`: storage
 * refused it, or a logout has started.
 */
export type SaveOutcome = 'SAVED' | 'HELD' | 'UNAVAILABLE';

/**
 * What is stored for `entry`, or null to keep a marker as it is: a marker is
 * never turned back into something that can be re-sent. When the slot already
 * keeps this submission, its first command, body and time stay, and a withdrawn
 * replay stays withdrawn.
 */
function recordOf(
  scope: ReturnScope,
  entry: Omit<UnresolvedReturn, 'savedAt' | 'marker'>,
  earlier: Stored | null,
  binding: Binding,
  now: number,
): string | null {
  if (earlier?.marker) return null;
  return JSON.stringify({
    v: VERSION,
    marker: false,
    scope: scopeOf(scope),
    command: earlier ? earlier.command : entry.command,
    submissionId: entry.submissionId,
    // The body is the first send's, whatever a later answer carries.
    body: earlier ? earlier.body : entry.body,
    correlationId: entry.correlationId,
    // The entry dates from the first send.
    savedAt: earlier ? earlier.savedAt : now,
    // Once withdrawn — the server said the deadline passed — never restored.
    replay: earlier && earlier.replay === null ? null : entry.replay,
    owner: binding.owner,
    session: binding.session,
  });
}

/** Before the first send (`StartOutcome`, `lib/unresolved-tenancy.ts`). */
export function saveUnresolvedReturn(
  scope: ReturnScope,
  entry: Omit<UnresolvedReturn, 'savedAt' | 'marker'>,
  binding: Binding,
  now: number = Date.now(),
): SaveOutcome {
  if (!belongs(scopeOf(scope), entry.command)) return 'UNAVAILABLE';
  return slot.start(binding, scopeOf(scope), entry.submissionId, (earlier) =>
    recordOf(scope, entry, earlier, binding, now),
  );
}

/**
 * An answer to `entry.submissionId` still in doubt: its record is updated
 * while the slot holds it; otherwise the slot is left as it is and the answer
 * is kept aside (`SET_ASIDE`; `lib/unresolved-tenancy.ts`).
 */
export function answerUnresolvedReturn(
  scope: ReturnScope,
  entry: Omit<UnresolvedReturn, 'savedAt' | 'marker'>,
  binding: Binding,
  now: number = Date.now(),
): AnswerOutcome {
  return slot.answer(
    binding,
    scopeOf(scope),
    entry.submissionId,
    (earlier) => recordOf(scope, entry, earlier, binding, now),
    now,
  );
}

/** A definite answer to `submissionId`, from the login it was sent under: its record, and only that, goes. */
export function settleUnresolvedReturn(
  scope: ReturnScope,
  submissionId: string,
  binding: Binding,
): void {
  slot.settle(binding, scopeOf(scope), submissionId);
}

/**
 * The person sets aside the record of `submissionId` — and only that one: a
 * record another submission holds stays, and so does every other
 * organization's. A record that cannot be attributed is never removed
 * (quarantined).
 */
export function clearUnresolvedReturn(
  scope: ReturnScope,
  submissionId: string,
  binding: Binding,
): void {
  slot.release(binding, scopeOf(scope), submissionId);
}

/**
 * The unresolved return command in this slot, if this person has one.
 * Unreadable, or not this person's: read as none and left as
 * it is (quarantined). Older than the
 * session's lifetime: reduced to the marker, and read as that — never as none.
 */
export function restoreUnresolvedReturn(
  scope: ReturnScope,
  binding: Binding,
  maxAgeSeconds: number,
  now: number = Date.now(),
): RestoredReturn | null {
  try {
    const store = storage();
    const found = store ? locate(store, KEY_PREFIX, binding, scopeOf(scope)) : null;
    if (!store || found === null) return null;

    const entry = parse(found.raw, scopeOf(scope));
    // Not this person's, or does not read: none here, and left as it is (quarantined).
    if (!entry || !ownedHere(binding, found.legacy, entry.owner)) return null;
    const { command, submissionId, correlationId, savedAt } = entry;
    if (entry.marker || now - savedAt > maxAgeSeconds * 1000) {
      if (!entry.marker) store.setItem(found.key, markerOf(entry));
      return {
        kind: 'VIEW_ONLY',
        entry: {
          command,
          submissionId,
          correlationId,
          savedAt,
          body: null,
          replay: null,
          marker: true,
        },
      };
    }
    const restored: UnresolvedReturn = {
      command,
      submissionId,
      body: entry.body,
      correlationId,
      savedAt,
      replay: entry.replay,
      marker: false,
    };
    // An old-format record may have been sent for another organization: never re-sent.
    const retryable =
      !found.legacy &&
      entry.session === binding.session &&
      entry.replay !== null &&
      now < entry.replay.until;
    return { kind: retryable ? 'RETRYABLE' : 'VIEW_ONLY', entry: restored };
  } catch {
    return null;
  }
}
