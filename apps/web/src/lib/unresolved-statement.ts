import {
  LINE_DESCRIPTION_MAX,
  MAX_STATEMENT_LINES,
  isStatementCommand,
  type StatementCommand,
} from './statement-fields';
import type { StatementLineRequest } from './statement-draft';
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
} from './unresolved-tenancy';

export type { AnswerOutcome };

/**
 * A statement command whose outcome is unknown, kept in `sessionStorage` so
 * that a reload cannot turn "maybe done" back into a fresh form with a fresh
 * key — `lib/unresolved-dispute.ts`'s rules, for the statement commands.
 *
 * ## Why a fresh key is not safe here
 *
 * A draft sent under key K can commit unseen; the same lines sent again under
 * a new key are a **second statement** — a second claim for the same work.
 * Only the original key with the original body is answered by the service's
 * stored response instead of being executed again. A submit or a decision
 * repeated under a new key is refused by the state it left behind, but its
 * outcome is just as unknown until the page is read again, so it is held the
 * same way and no fresh form is drawn over it.
 *
 * ## What is kept
 *
 * Per scope — a contract's draft, or one statement's commands — the command,
 * the submission id, a draft's lines exactly as they were sent (the service
 * computes every amount from them, so they are what makes the retry the same
 * request), the original correlation id, when it was saved, and its replay
 * stamp (`server/statement-replay.ts`, a signed deadline, not a credential),
 * with the two one-way login tags (`submissionBinding`). No token, no session
 * value, no CSRF value.
 *
 * ## One unresolved command per scope, never replaced
 *
 * A statement's approve and reject forms share its slot (PR 332 review 1): a
 * new submission never **replaces** another submission's record — saving it is
 * refused (`HELD`) and the form is not sent — and a record is cleared only by
 * the submission it belongs to (`clearUnresolvedStatement` takes its id), on a
 * definite outcome of that submission. Otherwise an approval whose answer was
 * lost could be overwritten by a rejection, whose `409 STEP_DECIDED` would
 * then erase the approval's key and its warning. Every change is announced to
 * the page's other forms (`subscribeUnresolvedStatements`), which stay
 * view-only while another command holds the slot.
 *
 * ## Never silently gone
 *
 * An entry older than the session's lifetime, and every entry at logout, is
 * **reduced** to a marker — no lines, no login tag, no stamp — shown view-only
 * as "the outcome is unknown" until the person acknowledges it. A confirmed
 * answer (the action redirects) drops it; otherwise only the person does, with
 * the labelled action the uncertainty view offers once the same request has
 * been tried again or can no longer be. Another person's page drops every
 * entry of anyone else (`purgeForeignUnresolvedStatements`).
 */

const KEY_PREFIX = 'rasta.unresolved-statement.';
const VERSION = 1;

const SUBMISSION_ID = /^sub_[A-Za-z0-9_-]{8,128}$/;
const MAX_TAG_LENGTH = 128;
const MAX_STAMP_LENGTH = 4096;
const AMOUNT = /^[1-9][0-9]{0,18}$/;

/**
 * Until when the server will let the same request be sent again: `token` is
 * checked by the action, `until` (milliseconds since the epoch) only decides
 * which controls are drawn.
 */
export interface ReplayStamp {
  readonly token: string;
  readonly until: number;
}

/** A fresh submission id for one statement form, with its signed replay deadline. */
export interface StatementSubmission {
  readonly id: string;
  readonly replay: ReplayStamp;
}

/** A draft's line as it was sent. */
export type SentLine = StatementLineRequest;

export interface UnresolvedStatement {
  readonly command: StatementCommand;
  readonly submissionId: string;
  /** A draft's lines as sent; empty for every other command, and in a marker. */
  readonly lines: readonly SentLine[];
  /** Null while the first send has not been answered. */
  readonly correlationId: string | null;
  /** Milliseconds since the epoch, browser clock. */
  readonly savedAt: number;
  /** Null in a marker, and once the server has said the deadline passed. */
  readonly replay: ReplayStamp | null;
  /** True for the outcome-unknown marker: nothing re-sendable is kept. */
  readonly marker: boolean;
}

/** Where an entry is kept: a contract's draft, or one statement. */
export interface StatementScope {
  readonly contractId: string;
  /** Null for the contract's draft form. */
  readonly statementId: string | null;
}

type Stored = Omit<UnresolvedStatement, 'marker'> & {
  readonly v: typeof VERSION;
  readonly marker: boolean;
  readonly owner: string;
  readonly session?: string;
};

export type RestoredStatement =
  /** Same login, before the replay deadline: the same request may be sent again. */
  | { readonly kind: 'RETRYABLE'; readonly entry: UnresolvedStatement }
  /** Another login, past the replay deadline, or a marker: shown, never re-sent. */
  | { readonly kind: 'VIEW_ONLY'; readonly entry: UnresolvedStatement };

let accountClosing = false;

/** Same-tab listeners: the forms of a page, told when a slot changes (`sessionStorage` is per tab). */
const listeners = new Set<() => void>();

/** Called on every save and clear; returns the unsubscribe. */
export function subscribeUnresolvedStatements(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function changed(): void {
  for (const listener of [...listeners]) listener();
}

export function markStatementsClosing(): void {
  accountClosing = true;
}

export function markStatementsOpen(): void {
  accountClosing = false;
}

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

function scopeOf(scope: StatementScope): string {
  return `${scope.contractId}.${scope.statementId ?? 'draft'}`;
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

function linesOf(value: unknown): SentLine[] | null {
  if (!Array.isArray(value) || value.length > MAX_STATEMENT_LINES) return null;
  const lines: SentLine[] = [];
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) return null;
    const line = raw as Record<string, unknown>;
    if (
      typeof line.description !== 'string' ||
      line.description.length < 1 ||
      line.description.length > LINE_DESCRIPTION_MAX ||
      typeof line.amountMinor !== 'string' ||
      !AMOUNT.test(line.amountMinor) ||
      !(line.milestoneId === undefined || tag(line.milestoneId))
    ) {
      return null;
    }
    lines.push({
      description: line.description,
      amountMinor: line.amountMinor,
      ...(typeof line.milestoneId === 'string' ? { milestoneId: line.milestoneId } : {}),
    });
  }
  return lines;
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
  if (
    entry.v !== VERSION ||
    !isStatementCommand(entry.command) ||
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
    command: entry.command,
    submissionId: entry.submissionId,
    correlationId: entry.correlationId,
    savedAt: entry.savedAt,
    owner: entry.owner,
  } as const;
  if (entry.marker === true) return { ...common, marker: true, replay: null, lines: [] };

  const replay = replayOf(entry.replay);
  const lines = linesOf(entry.lines);
  if (entry.marker !== false || !tag(entry.session) || replay === undefined || lines === null) {
    return null;
  }
  // A draft carries the lines it sent; nothing else carries any.
  if ((entry.command === 'DRAFT') !== lines.length > 0) return null;
  return { ...common, marker: false, session: entry.session, replay, lines };
}

/** What a marker keeps: nothing of the lines, the login or the stamp. */
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

/** The quarantine of this kind (`lib/unresolved-tenancy.ts`, `app/UnresolvedQuarantine.tsx`). */
/** The one slot per scope, fenced to its submission (`lib/unresolved-tenancy.ts`). */
const slot = fencedSlot(KEY_PREFIX, parseEntry, { closing: () => accountClosing, changed });

export const statementQuarantine = slot.quarantine;

/**
 * Logout: every entry reduced to a marker; a record that does not read, and one
 * from before entries were kept per organization, are left as they are.
 */
export function purgeAllUnresolvedStatements(): void {
  markStatementsClosing();
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
  changed();
}

/**
 * A page for this person: entries of anyone else are reduced to content-free
 * markers; theirs stay, for every organization, and nothing that cannot be
 * attributed is touched (`lib/unresolved-tenancy.ts`).
 */
export function purgeForeignUnresolvedStatements(tags: AccountTags): void {
  try {
    const store = storage();
    if (!store) return;
    purgeForeign(store, KEY_PREFIX, tags, parseEntry);
  } catch {
    // See above.
  }
}

/**
 * `SAVED`: stored. `HELD`: another submission's record holds this scope — it is
 * left exactly as it was, and this one must not be sent. `UNAVAILABLE`: storage
 * refused it, or a logout has started.
 */
export type SaveOutcome = 'SAVED' | 'HELD' | 'UNAVAILABLE';

/**
 * What is stored for `entry`, or null to keep a marker as it is: a marker is
 * never turned back into something that can be re-sent. When the slot already
 * keeps this submission, its first command, lines and time stay, and a withdrawn
 * replay stays withdrawn.
 */
function recordOf(
  entry: Omit<UnresolvedStatement, 'savedAt' | 'marker'>,
  earlier: Stored | null,
  binding: Binding,
  now: number,
): string | null {
  if (earlier?.marker) return null;
  return JSON.stringify({
    v: VERSION,
    marker: false,
    command: earlier ? earlier.command : entry.command,
    submissionId: entry.submissionId,
    // The lines is the first send's, whatever a later answer carries.
    lines: earlier ? earlier.lines : entry.lines,
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
export function saveUnresolvedStatement(
  scope: StatementScope,
  entry: Omit<UnresolvedStatement, 'savedAt' | 'marker'>,
  binding: Binding,
  now: number = Date.now(),
): SaveOutcome {
  return slot.start(binding, scopeOf(scope), entry.submissionId, (earlier) =>
    recordOf(entry, earlier, binding, now),
  );
}

/**
 * An answer to `entry.submissionId` still in doubt: its record is updated
 * while the slot holds it; otherwise the slot is left as it is and the answer
 * is kept aside (`SET_ASIDE`; `lib/unresolved-tenancy.ts`).
 */
export function answerUnresolvedStatement(
  scope: StatementScope,
  entry: Omit<UnresolvedStatement, 'savedAt' | 'marker'>,
  binding: Binding,
  now: number = Date.now(),
): AnswerOutcome {
  return slot.answer(
    binding,
    scopeOf(scope),
    entry.submissionId,
    (earlier) => recordOf(entry, earlier, binding, now),
    now,
  );
}

/** A definite answer to `submissionId`, from the login it was sent under: its record, and only that, goes. */
export function settleUnresolvedStatement(
  scope: StatementScope,
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
export function clearUnresolvedStatement(
  scope: StatementScope,
  submissionId: string,
  binding: Binding,
): void {
  slot.release(binding, scopeOf(scope), submissionId);
}

/**
 * The unresolved statement command in this scope, if this person has one.
 * Unreadable, or not this person's: read as none and left as
 * it is (quarantined). Older than the
 * session's lifetime: reduced to the marker, and read as that — never as none.
 */
export function restoreUnresolvedStatement(
  scope: StatementScope,
  binding: Binding,
  maxAgeSeconds: number,
  now: number = Date.now(),
): RestoredStatement | null {
  try {
    const store = storage();
    const found = store ? locate(store, KEY_PREFIX, binding, scopeOf(scope)) : null;
    if (!store || found === null) return null;

    const entry = parse(found.raw);
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
          lines: [],
          replay: null,
          marker: true,
        },
      };
    }
    const restored: UnresolvedStatement = {
      command,
      submissionId,
      lines: entry.lines,
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
