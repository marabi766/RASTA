import {
  DISPUTE_COMMAND_FIELDS,
  DISPUTE_FIELD_LIMITS,
  EMPTY_DISPUTE_FORM,
  isDisputeCommand,
  type DisputeCommand,
  type DisputeFormValues,
} from './transaction-dispute-fields';
import type { Binding } from './unresolved-order';

/**
 * A dispute command whose outcome is unknown, kept in `sessionStorage` per
 * transaction so that a reload cannot turn "maybe done" back into a blank form
 * with a fresh key (PR 319 review 1, finding 2).
 *
 * ## Why a fresh key is not safe here
 *
 * The state machine does not make a repeated command harmless:
 * `PENDING_SETTLEMENT → DISPUTED → PENDING_SETTLEMENT` is legal. A resolution
 * sent under key K can commit unseen, the payer can then open a **new**
 * dispute, and the same resolution sent again under a new key would resolve
 * the new one. Only the original key with the original body is answered by the
 * service's stored result (a replay) instead of being executed again.
 *
 * ## What is kept, and how long it may be re-sent
 *
 * The command, the submission id, the one text field, the original correlation
 * id and when it was saved, with the two one-way login tags
 * (`submissionBinding`) — no token, no session value, no CSRF value
 * (`unresolved-order.ts` says why each is safe to hold).
 *
 * The same key is a replay only while economic-service still holds its
 * idempotency record. Its retention is configuration there
 * (`ECONOMIC_IDEMPOTENCY_TTL_HOURS`, no lower than one hour), so this module
 * offers the re-send for **one hour** after the entry was saved — written
 * before the request left, so the service's record, if any, is younger. Past
 * that, or from another login (the id is bound to the old one), the entry is
 * only shown: a re-send could execute as a new command.
 *
 * ## Forgetting it
 *
 * A confirmed answer (the action redirects) drops it. Otherwise only the
 * person drops it, with the labelled action the uncertainty view offers once
 * the same request has been tried again or can no longer be — never by a
 * reload, and never by a refusal alone.
 */

const KEY_PREFIX = 'rasta.unresolved-dispute.';
const VERSION = 1;

/** One hour: the floor of economic-service's idempotency retention (`ECONOMIC_IDEMPOTENCY_TTL_HOURS` ≥ 1). */
export const DISPUTE_REPLAY_WINDOW_SECONDS = 60 * 60;

const SUBMISSION_ID = /^sub_[A-Za-z0-9_-]{8,128}$/;
const MAX_TAG_LENGTH = 128;

export interface UnresolvedDispute {
  readonly command: DisputeCommand;
  readonly submissionId: string;
  readonly values: DisputeFormValues;
  /** Null while the first send has not been answered. */
  readonly correlationId: string | null;
  /** Milliseconds since the epoch, browser clock. */
  readonly savedAt: number;
}

interface Stored extends UnresolvedDispute {
  readonly v: typeof VERSION;
  readonly owner: string;
  readonly session: string;
}

export type RestoredDispute =
  /** Same login, inside the replay window: the same request may be sent again. */
  | { readonly kind: 'RETRYABLE'; readonly dispute: UnresolvedDispute }
  /** Another login, or past the replay window: shown, never re-sent. */
  | { readonly kind: 'VIEW_ONLY'; readonly dispute: UnresolvedDispute };

let accountClosing = false;

export function markDisputesClosing(): void {
  accountClosing = true;
}

export function markDisputesOpen(): void {
  accountClosing = false;
}

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

function keyOf(transactionId: string): string {
  return `${KEY_PREFIX}${transactionId}`;
}

function tag(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_TAG_LENGTH;
}

function parse(raw: string): Stored | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const entry = value as Record<string, unknown>;
  const command = typeof entry.command === 'string' ? entry.command : undefined;
  if (
    entry.v !== VERSION ||
    !isDisputeCommand(command) ||
    !tag(entry.submissionId) ||
    !SUBMISSION_ID.test(entry.submissionId) ||
    !(entry.correlationId === null || tag(entry.correlationId)) ||
    !tag(entry.owner) ||
    !tag(entry.session) ||
    typeof entry.savedAt !== 'number' ||
    !Number.isFinite(entry.savedAt) ||
    typeof entry.text !== 'string'
  ) {
    return null;
  }
  const field = DISPUTE_COMMAND_FIELDS[command];
  const limits = DISPUTE_FIELD_LIMITS[field];
  if (entry.text.length < limits.min || entry.text.length > limits.max) return null;
  return {
    v: VERSION,
    command,
    submissionId: entry.submissionId,
    values: { ...EMPTY_DISPUTE_FORM, [field]: entry.text },
    correlationId: entry.correlationId,
    savedAt: entry.savedAt,
    owner: entry.owner,
    session: entry.session,
  };
}

function ownKeys(store: Storage): string[] {
  const keys: string[] = [];
  for (let index = 0; index < store.length; index += 1) {
    const key = store.key(index);
    if (key !== null && key.startsWith(KEY_PREFIX)) keys.push(key);
  }
  return keys;
}

/** Logout: nothing of an unresolved dispute outlives the person who signed out. */
export function purgeAllUnresolvedDisputes(): void {
  markDisputesClosing();
  try {
    const store = storage();
    if (!store) return;
    for (const key of ownKeys(store)) store.removeItem(key);
  } catch {
    // Unavailable storage holds nothing to purge.
  }
}

/** A page for `owner`: entries of anyone else, and unreadable ones, are removed. */
export function purgeForeignUnresolvedDisputes(owner: string): void {
  try {
    const store = storage();
    if (!store) return;
    for (const key of ownKeys(store)) {
      const raw = store.getItem(key);
      const entry = raw === null ? null : parse(raw);
      if (!entry || entry.owner !== owner) store.removeItem(key);
    }
  } catch {
    // See above.
  }
}

/** True when the entry is stored. False: storage refused it, or a logout has started. */
export function saveUnresolvedDispute(
  transactionId: string,
  dispute: Omit<UnresolvedDispute, 'savedAt'>,
  binding: Binding,
  now: number = Date.now(),
): boolean {
  if (accountClosing) return false;
  try {
    const store = storage();
    if (!store) return false;
    // The original save time stays: the replay window runs from the first send.
    const previous = store.getItem(keyOf(transactionId));
    const earlier = previous === null ? null : parse(previous);
    const savedAt =
      earlier && earlier.submissionId === dispute.submissionId ? earlier.savedAt : now;
    const field = DISPUTE_COMMAND_FIELDS[dispute.command];
    store.setItem(
      keyOf(transactionId),
      JSON.stringify({
        v: VERSION,
        command: dispute.command,
        submissionId: dispute.submissionId,
        text: dispute.values[field],
        correlationId: dispute.correlationId,
        savedAt,
        owner: binding.owner,
        session: binding.session,
      }),
    );
    return true;
  } catch {
    return false;
  }
}

export function clearUnresolvedDispute(transactionId: string): void {
  try {
    storage()?.removeItem(keyOf(transactionId));
  } catch {
    // See above.
  }
}

/**
 * The unresolved dispute command for this transaction, if this person has one.
 * Unreadable, someone else's, or older than the session's lifetime: removed,
 * and read as none.
 */
export function restoreUnresolvedDispute(
  transactionId: string,
  binding: Binding,
  maxAgeSeconds: number,
  now: number = Date.now(),
): RestoredDispute | null {
  try {
    const store = storage();
    const raw = store?.getItem(keyOf(transactionId));
    if (!store || raw === null || raw === undefined) return null;

    const entry = parse(raw);
    const age = entry === null ? 0 : now - entry.savedAt;
    if (!entry || age > maxAgeSeconds * 1000 || entry.owner !== binding.owner) {
      store.removeItem(keyOf(transactionId));
      return null;
    }

    const { command, submissionId, values, correlationId, savedAt } = entry;
    const dispute: UnresolvedDispute = { command, submissionId, values, correlationId, savedAt };
    const retryable =
      entry.session === binding.session && age <= DISPUTE_REPLAY_WINDOW_SECONDS * 1000;
    return { kind: retryable ? 'RETRYABLE' : 'VIEW_ONLY', dispute };
  } catch {
    return null;
  }
}
