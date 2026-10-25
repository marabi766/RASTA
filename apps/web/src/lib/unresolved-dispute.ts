import {
  DISPUTE_COMMAND_FIELDS,
  DISPUTE_FIELD_LIMITS,
  EMPTY_DISPUTE_FORM,
  isDisputeCommand,
  type DisputeCommand,
  type DisputeFormValues,
} from './transaction-dispute-fields';
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
  type StartOutcome,
} from './unresolved-tenancy';

export type { AnswerOutcome, StartOutcome };

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
 * id, when it was saved and its replay stamp, with the two one-way login tags
 * (`submissionBinding`) — no token, no session value, no CSRF value
 * (`unresolved-order.ts` says why each is safe to hold). The replay stamp is a
 * signed deadline, not a credential (`server/dispute-replay.ts`).
 *
 * The same key is a replay only while economic-service still holds its
 * idempotency record. **The server decides that** (`server/dispute-replay.ts`,
 * PR 319 review 2, finding 2): the stamp's signed deadline is checked in the
 * action before every send. The stamp's `until` is kept here only to draw the
 * right controls; past it, or from another login (the id is bound to the old
 * one), the entry is only shown.
 *
 * ## Never silently gone: the outcome-unknown marker
 *
 * Expiring the text must never bring fresh controls back (PR 319 review 2,
 * finding 1): a resolution under K that committed unseen, followed by a new
 * dispute, would be resolved by the old decision under a fresh key. So an
 * entry older than the session's lifetime, and every entry at logout, is
 * **reduced** rather than removed: to a marker with no text, no login tag and
 * no stamp — the command, the ids, the time and the owner tag. It is shown
 * view-only, as "the outcome is unknown", for as long as this tab lives, and no
 * fresh form is drawn while it is there.
 *
 * ## Forgetting it
 *
 * A confirmed answer (the action redirects) drops it. Otherwise only the
 * person drops it, with the labelled action the uncertainty view offers once
 * the same request has been tried again or can no longer be — never by a
 * reload, a refusal, an expiry or a logout alone. Each names the submission
 * it is about and touches no other (`fencedSlot`, PR 405 review 3, R1): a late
 * answer for a command the person set aside, after another took the slot, is
 * kept aside as a content-free record, and the other is left as it is. Another person's page
 * reduces every entry of anyone else to a content-free marker
 * (`purgeForeignUnresolvedDisputes`), and nothing that cannot be attributed —
 * an entry from an organization this person's token no longer lists, one that
 * does not read — is removed at all: each holds every fresh dispute command on
 * this device until the person acknowledges the duplicate risk
 * (`disputeQuarantine`, `lib/unresolved-tenancy.ts`; PR 405 review 2, F1).
 */

const KEY_PREFIX = 'rasta.unresolved-dispute.';
const VERSION = 2;

const SUBMISSION_ID = /^sub_[A-Za-z0-9_-]{8,128}$/;
const MAX_TAG_LENGTH = 128;
/** A signed payload (`server/signed-payload.ts`), whose own ceiling is 4096. */
const MAX_STAMP_LENGTH = 4096;

/**
 * Until when the server will let the same request be sent again
 * (`server/dispute-replay.ts`): `token` is checked by the action, `until`
 * (milliseconds since the epoch) only decides which controls are drawn.
 */
export interface ReplayStamp {
  readonly token: string;
  readonly until: number;
}

/** A fresh submission id for one dispute form, with its signed replay deadline. */
export interface DisputeSubmission {
  readonly id: string;
  readonly replay: ReplayStamp;
}

export interface UnresolvedDispute {
  readonly command: DisputeCommand;
  readonly submissionId: string;
  /** Empty in a marker: the text is no longer kept. */
  readonly values: DisputeFormValues;
  /** Null while the first send has not been answered. */
  readonly correlationId: string | null;
  /** Milliseconds since the epoch, browser clock. */
  readonly savedAt: number;
  /** Null in a marker, and once the server has said the deadline passed. */
  readonly replay: ReplayStamp | null;
  /** True for the outcome-unknown marker: no text, never re-sent, kept until acknowledged. */
  readonly marker: boolean;
}

type Stored =
  | (Omit<UnresolvedDispute, 'marker'> & {
      readonly v: typeof VERSION;
      readonly marker: false;
      readonly owner: string;
      readonly session: string;
    })
  | (Omit<UnresolvedDispute, 'marker' | 'replay'> & {
      readonly v: typeof VERSION;
      readonly marker: true;
      readonly replay: null;
      readonly owner: string;
    });

export type RestoredDispute =
  /** Same login, before the replay deadline: the same request may be sent again. */
  | { readonly kind: 'RETRYABLE'; readonly dispute: UnresolvedDispute }
  /** Another login, past the replay deadline, or a marker: shown, never re-sent. */
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
    typeof entry.savedAt !== 'number' ||
    !Number.isFinite(entry.savedAt)
  ) {
    return null;
  }
  const common = {
    v: VERSION,
    command,
    submissionId: entry.submissionId,
    correlationId: entry.correlationId,
    savedAt: entry.savedAt,
    owner: entry.owner,
  } as const;

  if (entry.marker === true) {
    return { ...common, marker: true, replay: null, values: EMPTY_DISPUTE_FORM };
  }

  const replay = replayOf(entry.replay);
  if (entry.marker !== false || !tag(entry.session) || replay === undefined) return null;
  if (typeof entry.text !== 'string') return null;
  const field = DISPUTE_COMMAND_FIELDS[command];
  const limits = DISPUTE_FIELD_LIMITS[field];
  if (entry.text.length < limits.min || entry.text.length > limits.max) return null;
  return {
    ...common,
    marker: false,
    session: entry.session,
    replay,
    values: { ...EMPTY_DISPUTE_FORM, [field]: entry.text },
  };
}

/** What a marker keeps: nothing of the text, the login or the stamp. */
function markerOf(entry: Stored): string {
  return JSON.stringify({
    v: VERSION,
    marker: true,
    command: entry.command,
    submissionId: entry.submissionId,
    correlationId: entry.correlationId,
    savedAt: entry.savedAt,
    owner: entry.owner,
  });
}

/** `parse` for `lib/unresolved-tenancy.ts`, which hands the key too. */
const parseEntry = (raw: string): Stored | null => parse(raw);

/** The one slot per transaction, fenced to its submission (`lib/unresolved-tenancy.ts`). */
const slot = fencedSlot(KEY_PREFIX, parseEntry, { closing: () => accountClosing });

/** The quarantine of this kind (`lib/unresolved-tenancy.ts`, `app/UnresolvedQuarantine.tsx`). */
export const disputeQuarantine = slot.quarantine;

/**
 * Logout: the text of an unresolved dispute does not outlive the login that
 * wrote it, but the fact that its outcome is unknown does — reduced to a
 * marker, so the same person signing in again in this tab is not offered a
 * fresh form over it. A record that does not read is left as it is.
 */
export function purgeAllUnresolvedDisputes(): void {
  markDisputesClosing();
  try {
    const store = storage();
    if (!store) return;
    for (const key of keysUnder(store, KEY_PREFIX)) {
      // An entry from before entries were kept per organization stays as it is: whose it
      // is cannot be told here, and it is never written over (PR 405 review 2, F1).
      if (storedKeyOf(KEY_PREFIX, key)?.kind !== 'TENANT') continue;
      const raw = store.getItem(key);
      const entry = raw === null ? null : parse(raw);
      if (entry) store.setItem(key, markerOf(entry));
    }
  } catch {
    // Unavailable storage holds nothing to purge.
  }
}

/**
 * A page for this person: entries of anyone else are reduced to content-free
 * markers; theirs stay, for every organization, and nothing that cannot be
 * attributed is touched (`lib/unresolved-tenancy.ts`).
 */
export function purgeForeignUnresolvedDisputes(tags: AccountTags): void {
  try {
    const store = storage();
    if (!store) return;
    purgeForeign(store, KEY_PREFIX, tags, parseEntry);
  } catch {
    // See above.
  }
}

/**
 * What is stored for `dispute`, or null to keep a marker as it is: a marker is
 * never turned back into something that can be re-sent. When the slot already
 * keeps this submission, its first command, text and time stay, and a
 * withdrawn replay stays withdrawn.
 */
function recordOf(
  dispute: Omit<UnresolvedDispute, 'savedAt' | 'marker'>,
  earlier: Stored | null,
  binding: Binding,
  now: number,
): string | null {
  if (earlier?.marker) return null;
  const command = earlier ? earlier.command : dispute.command;
  const field = DISPUTE_COMMAND_FIELDS[command];
  return JSON.stringify({
    v: VERSION,
    marker: false,
    command,
    submissionId: dispute.submissionId,
    text: earlier ? earlier.values[field] : dispute.values[field],
    correlationId: dispute.correlationId,
    savedAt: earlier ? earlier.savedAt : now,
    // Once withdrawn — the server said the deadline passed — never restored.
    replay: earlier && earlier.replay === null ? null : dispute.replay,
    owner: binding.owner,
    session: binding.session,
  });
}

/**
 * Before the first send. `SAVED`: stored. `HELD`: another command's entry —
 * even a marker — holds this transaction's slot, or a quarantined record
 * holds this kind for this person (`disputeQuarantine`): nothing was written,
 * and nothing may be sent. `UNAVAILABLE`: storage refused it, or a logout has
 * started.
 */
export function saveUnresolvedDispute(
  transactionId: string,
  dispute: Omit<UnresolvedDispute, 'savedAt' | 'marker'>,
  binding: Binding,
  now: number = Date.now(),
): StartOutcome {
  return slot.start(binding, transactionId, dispute.submissionId, (earlier) =>
    recordOf(dispute, earlier, binding, now),
  );
}

/**
 * An answer to `dispute.submissionId` still in doubt: its entry is updated
 * while the slot holds it; otherwise the slot is left as it is and the answer
 * is kept aside (`SET_ASIDE`; `lib/unresolved-tenancy.ts`).
 */
export function answerUnresolvedDispute(
  transactionId: string,
  dispute: Omit<UnresolvedDispute, 'savedAt' | 'marker'>,
  binding: Binding,
  now: number = Date.now(),
): AnswerOutcome {
  return slot.answer(
    binding,
    transactionId,
    dispute.submissionId,
    (earlier) => recordOf(dispute, earlier, binding, now),
    now,
  );
}

/** A definite answer to `submissionId`: its entry, and only that one, is dropped. */
export function settleUnresolvedDispute(
  transactionId: string,
  submissionId: string,
  binding: Binding,
): void {
  slot.settle(binding, transactionId, submissionId);
}

/**
 * The person sets aside the entry the page showed — `submissionId`'s, this
 * organization's or an old-format one of theirs — and nothing else: another
 * command's entry, another organization's, and anything that cannot be
 * attributed (quarantined) stay.
 */
export function clearUnresolvedDispute(
  transactionId: string,
  submissionId: string,
  binding: Binding,
): void {
  slot.release(binding, transactionId, submissionId);
}

/**
 * The unresolved dispute command for this transaction, if this person has one.
 *
 * Unreadable, or not this person's: read as none and left as it is
 * (quarantined, `disputeQuarantine`). Older than the session's lifetime:
 * reduced to the outcome-unknown marker, and read as that — never as none.
 */
export function restoreUnresolvedDispute(
  transactionId: string,
  binding: Binding,
  maxAgeSeconds: number,
  now: number = Date.now(),
): RestoredDispute | null {
  try {
    const store = storage();
    const found = store ? locate(store, KEY_PREFIX, binding, transactionId) : null;
    if (!store || found === null) return null;

    const entry = parse(found.raw);
    if (!entry || !ownedHere(binding, found.legacy, entry.owner)) return null;

    const { command, submissionId, correlationId, savedAt } = entry;
    if (entry.marker || now - savedAt > maxAgeSeconds * 1000) {
      if (!entry.marker) store.setItem(found.key, markerOf(entry));
      return {
        kind: 'VIEW_ONLY',
        dispute: {
          command,
          submissionId,
          correlationId,
          savedAt,
          values: EMPTY_DISPUTE_FORM,
          replay: null,
          marker: true,
        },
      };
    }

    const { values, replay } = entry;
    const dispute: UnresolvedDispute = {
      command,
      submissionId,
      values,
      correlationId,
      savedAt,
      replay,
      marker: false,
    };
    // An old-format entry may have been sent for another organization: never re-sent.
    const retryable =
      !found.legacy && entry.session === binding.session && replay !== null && now < replay.until;
    return { kind: retryable ? 'RETRYABLE' : 'VIEW_ONLY', dispute };
  } catch {
    return null;
  }
}
