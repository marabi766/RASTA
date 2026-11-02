import {
  SCOPE_COMMANDS,
  hasFields,
  isInventoryCommand,
  parseInventoryForm,
  valuesOfBody,
  type InventoryBody,
  type InventoryCommand,
  type InventoryScope,
} from './inventory-commands';
import {
  NOT_STARTED,
  fencedSlot,
  keysUnder,
  locate,
  ownedHere,
  purgeForeign,
  storedKeyOf,
  type AccountTags,
  type AnswerOutcome,
  type Attempt,
  type Binding,
  type Settlement,
  type StartOutcome,
  type StoredKey,
} from './unresolved-tenancy';

export type { AnswerOutcome };

/**
 * An inventory command whose outcome is unknown, kept in `sessionStorage` so
 * that a reload cannot turn "maybe done" back into a fresh form with a fresh
 * key — `lib/unresolved-return.ts`'s rules, for the operator commands of
 * `/inventory`.
 *
 * ## Why a fresh key is not safe here
 *
 * A receipt or an adjustment sent under key K can commit unseen; the same
 * quantity sent again under a new key moves stock **a second time**, and a
 * warehouse or a shipment created twice is a second warehouse or shipment. Only
 * the original key with the original body is answered by the service's stored
 * response (`INVENTORY_IDEMPOTENCY_TTL_HOURS`) instead of being executed again.
 * A dispatch or a delivery repeated under a new key is refused by the state it
 * left behind, but its outcome is just as unknown until the page is read again,
 * so it is held the same way.
 *
 * ## What is kept
 *
 * Per slot — the warehouse list, one warehouse, one shipment — the command,
 * the submission id, a typed command's body exactly as it was sent (what makes
 * the retry the same request), the original correlation id, when it was saved,
 * and its replay stamp (`server/inventory-replay.ts`, a signed deadline, not a
 * credential), with the two one-way login tags (`submissionBinding`). No token,
 * no session value, no CSRF value.
 *
 * ## One unresolved command per slot, never replaced
 *
 * The receipt, the adjustment and the new-shipment forms of a warehouse share
 * its slot, and a shipment's dispatch and delivery share its own: a new
 * submission never **replaces** another submission's record — saving it is
 * refused (`HELD`) and the form is not sent — a submission already in doubt is
 * never sent again as a first send (`UNRESOLVED`), and a record is cleared only
 * by the submission it belongs to: a definite answer of the very send that
 * wrote it while no other send has written it since, a confirmed outcome of
 * that send, or the person (the shared slot, `lib/unresolved-tenancy.ts`:
 * per person and organization, and fenced to the send's own identity — never
 * reused, not even by a record made again under the same key). Every
 * change is announced to the page's other forms (`subscribeUnresolvedInventory`),
 * which stay view-only while another command holds the slot.
 *
 * ## Never silently gone
 *
 * An entry older than the session's lifetime, and every entry at logout, is
 * **reduced** to a marker — no body, no login tag, no stamp — shown view-only
 * as "the outcome is unknown" until the person acknowledges it. A confirmed
 * answer (the action redirects) drops it; otherwise only the person does.
 * Another person's page reduces every entry of anyone else to a content-free
 * marker, and nothing that cannot be attributed is removed
 * (`purgeForeignUnresolvedInventory`, `lib/unresolved-tenancy.ts`).
 *
 * ## Per tab, not per browser (PR 363 review 3, finding 2)
 *
 * `sessionStorage` is this tab's: the guard above holds within one tab only.
 * A tab duplicated before either copy sent anything has its own copy of the
 * page's submission id K and stamp, and can send another body under K. That
 * cannot commit twice: inventory-service keys each request by organization,
 * endpoint and K, and refuses a different body under a K it holds
 * (`409 IDEMPOTENCY_KEY_REUSED`) — in flight for its claim lease, and once
 * answered for `INVENTORY_IDEMPOTENCY_TTL_HOURS`, which outlasts the stamp's
 * replay deadline. A request the service refused holds nothing: the other
 * tab's body is then the one request under K. Another endpoint or another
 * organization is another key. No cross-tab lock (PM decision, PR 363 round 4).
 */

const KEY_PREFIX = 'rasta.unresolved-inventory.';
const VERSION = 1;

const SUBMISSION_ID = /^sub_[A-Za-z0-9_-]{8,128}$/;
const MAX_TAG_LENGTH = 128;
const MAX_STAMP_LENGTH = 4096;

/**
 * Until when the server will let the same request be sent again: `token` is
 * checked by the action, `until` (milliseconds since the epoch) only decides
 * which controls are drawn.
 */
export interface ReplayStamp {
  readonly token: string;
  readonly until: number;
}

/** A fresh submission id for one inventory form, with its signed replay deadline. */
export interface InventorySubmission {
  readonly id: string;
  readonly replay: ReplayStamp;
}

export interface UnresolvedInventory {
  readonly command: InventoryCommand;
  readonly submissionId: string;
  /** A typed command's body as sent; null for a shipment move, and in a marker. */
  readonly body: InventoryBody | null;
  /** Null while the first send has not been answered. */
  readonly correlationId: string | null;
  /** Milliseconds since the epoch, browser clock. */
  readonly savedAt: number;
  /** Null in a marker, and once the server has said the deadline passed. */
  readonly replay: ReplayStamp | null;
  /** True for the outcome-unknown marker: nothing re-sendable is kept. */
  readonly marker: boolean;
}

type Stored = Omit<UnresolvedInventory, 'marker'> & {
  readonly v: typeof VERSION;
  readonly marker: boolean;
  readonly scope: string;
  readonly owner: string;
  readonly session?: string;
};

export type RestoredInventory =
  /** Same login, before the replay deadline: the same request may be sent again. */
  | { readonly kind: 'RETRYABLE'; readonly entry: UnresolvedInventory }
  /** Another login, past the replay deadline, or a marker: shown, never re-sent. */
  | { readonly kind: 'VIEW_ONLY'; readonly entry: UnresolvedInventory };

let accountClosing = false;

/** Same-tab listeners: the forms of a page, told when a slot changes (`sessionStorage` is per tab). */
const listeners = new Set<() => void>();

/** Called on every save and clear; returns the unsubscribe. */
export function subscribeUnresolvedInventory(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function changed(): void {
  for (const listener of [...listeners]) listener();
}

export function markInventoryClosing(): void {
  accountClosing = true;
}

export function markInventoryOpen(): void {
  accountClosing = false;
}

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

function scopeOf(scope: InventoryScope): string {
  switch (scope.kind) {
    case 'WAREHOUSES':
      return 'warehouses';
    case 'WAREHOUSE':
      return `warehouse.${scope.warehouseId}`;
    case 'SHIPMENT':
      return `shipment.${scope.shipmentId}`;
  }
}

/** Which commands a slot holds (`SCOPE_COMMANDS`). */
function belongs(scope: string, command: InventoryCommand): boolean {
  const kind: InventoryScope['kind'] = scope.startsWith('warehouse.')
    ? 'WAREHOUSE'
    : scope.startsWith('shipment.')
      ? 'SHIPMENT'
      : 'WAREHOUSES';
  return SCOPE_COMMANDS[kind].includes(command);
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

/**
 * A kept body, read the way the form reads what it sends: the same parser, on
 * the values the body spells, so a stored body that the action would refuse is
 * dropped as unreadable rather than re-sent. A shipment move keeps none.
 */
function bodyOf(command: InventoryCommand, value: unknown): InventoryBody | null | undefined {
  if (!hasFields(command)) return value === null ? null : undefined;
  if (typeof value !== 'object' || value === null) return undefined;
  try {
    const parsed = parseInventoryForm(command, valuesOfBody(command, value as InventoryBody));
    return parsed.ok ? parsed.body : undefined;
  } catch {
    return undefined;
  }
}

/** Whether a body, spelled as the retry spells it and read again, is the same body. */
function roundTrips(command: InventoryCommand, body: InventoryBody | null): boolean {
  if (!hasFields(command)) return body === null;
  if (body === null) return false;
  const again = bodyOf(command, JSON.parse(JSON.stringify(body)));
  return again !== undefined && JSON.stringify(again) === JSON.stringify(body);
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
    !isInventoryCommand(entry.command) ||
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
  const body = bodyOf(entry.command, entry.body);
  // The command is known to have been sent but its record cannot be read back
  // as something re-sendable: that is "outcome unknown", never "nothing sent" —
  // it is held as a marker, not dropped, so no fresh key is offered over it.
  if (entry.marker !== false || !tag(entry.session) || replay === undefined || body === undefined) {
    return { ...common, marker: true, replay: null, body: null };
  }
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

/** The one slot per scope, fenced to its submission and its send (`lib/unresolved-tenancy.ts`). */
const slot = fencedSlot(KEY_PREFIX, parseEntry, { closing: () => accountClosing, changed });

/** The quarantine of this kind (`lib/unresolved-tenancy.ts`, `app/UnresolvedQuarantine.tsx`). */
export const inventoryQuarantine = slot.quarantine;

/**
 * Logout: every entry reduced to a marker; a record that does not read, and one
 * from before entries were kept per organization, are left as they are.
 */
export function purgeAllUnresolvedInventory(): void {
  markInventoryClosing();
  try {
    const store = storage();
    if (!store) return;
    for (const key of keysUnder(store, KEY_PREFIX)) {
      // Whose an old-format entry is cannot be told here; it is never written over.
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
export function purgeForeignUnresolvedInventory(tags: AccountTags): void {
  try {
    const store = storage();
    if (!store) return;
    purgeForeign(store, KEY_PREFIX, tags, parseEntry);
  } catch {
    // See above.
  }
}

/** What a save before the first send says (`StartOutcome`, `lib/unresolved-tenancy.ts`). */
export type SaveOutcome = StartOutcome;

/**
 * What is stored for `entry`, or null to keep a marker as it is: a marker is
 * never turned back into something that can be re-sent. When the slot already
 * keeps this submission, its first command, body and time stay, and a withdrawn
 * replay stays withdrawn.
 */
function recordOf(
  scope: InventoryScope,
  entry: Omit<UnresolvedInventory, 'savedAt' | 'marker'>,
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

/**
 * Before the first send (`StartOutcome`, `lib/unresolved-tenancy.ts`):
 * `UNRESOLVED` when the slot already keeps this very submission — a form drawn
 * again over it is not a first send. A body that would not be read back as
 * itself cannot be retried as the same request: it is not sent at all.
 */
export function saveUnresolvedInventory(
  scope: InventoryScope,
  entry: Omit<UnresolvedInventory, 'savedAt' | 'marker'>,
  binding: Binding,
  now: number = Date.now(),
): SaveOutcome {
  if (!belongs(scopeOf(scope), entry.command)) return NOT_STARTED.UNAVAILABLE;
  return slot.start(binding, scopeOf(scope), entry.submissionId, () =>
    roundTrips(entry.command, entry.body) ? recordOf(scope, entry, null, binding, now) : null,
  );
}

/**
 * An answer to send `attempt` of `entry.submissionId` still in doubt: its
 * record is updated while the slot holds it at that very send; a later send's
 * record is left as it is (`SUPERSEDED`); otherwise the answer is kept aside
 * (`SET_ASIDE`; `lib/unresolved-tenancy.ts`).
 */
export function answerUnresolvedInventory(
  scope: InventoryScope,
  entry: Omit<UnresolvedInventory, 'savedAt' | 'marker'>,
  binding: Binding,
  attempt: Attempt | null,
  now: number = Date.now(),
): AnswerOutcome {
  return slot.answer(
    binding,
    scopeOf(scope),
    entry.submissionId,
    attempt,
    (earlier) => recordOf(scope, entry, earlier, binding, now),
    now,
  );
}

/** Before a re-send of `submissionId`: a new send identity, recorded — or null, and nothing is sent. */
export function advanceUnresolvedInventory(
  scope: InventoryScope,
  submissionId: string,
  binding: Binding,
): Attempt | null {
  return slot.advance(binding, scopeOf(scope), submissionId);
}

/**
 * A definite answer to send `attempt` of `submissionId`, from the login it was
 * sent under: its record, and only that, goes — only while no later send of it
 * has started.
 */
export function settleUnresolvedInventory(
  scope: InventoryScope,
  submissionId: string,
  binding: Binding,
  attempt: Attempt,
  settlement: Settlement,
): void {
  slot.settle(binding, scopeOf(scope), submissionId, attempt, settlement);
}

/**
 * The person sets aside the record of `submissionId` — and only that one: a
 * record another submission holds stays, and so does every other
 * organization's. A record that cannot be attributed is never removed
 * (quarantined).
 */
export function clearUnresolvedInventory(
  scope: InventoryScope,
  submissionId: string,
  binding: Binding,
): void {
  slot.release(binding, scopeOf(scope), submissionId);
}

/**
 * The unresolved inventory command in this slot, if this person has one.
 * Unreadable, or not this person's: read as none and left as it is
 * (quarantined). Older than the session's lifetime: reduced to the marker, and
 * read as that — never as none.
 */
export function restoreUnresolvedInventory(
  scope: InventoryScope,
  binding: Binding,
  maxAgeSeconds: number,
  now: number = Date.now(),
): RestoredInventory | null {
  try {
    const store = storage();
    const found = store ? locate(store, KEY_PREFIX, binding, scopeOf(scope)) : null;
    if (!store || found === null) return null;

    const entry = parse(found.raw, scopeOf(scope));
    // Not this person's, or does not read: none here, and left as it is (quarantined).
    if (!entry || !ownedHere(binding, found.legacy, entry.owner)) return null;
    const { command, submissionId, correlationId, savedAt } = entry;
    if (entry.marker || now - savedAt > maxAgeSeconds * 1000) {
      if (!entry.marker && !found.legacy) store.setItem(found.key, markerOf(entry));
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
    const restored: UnresolvedInventory = {
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
