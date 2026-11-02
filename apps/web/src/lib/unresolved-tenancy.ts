/**
 * Whose an unresolved submission is, for every store that keeps one in
 * `sessionStorage` (`lib/unresolved-order.ts`, `-dispute`, `-return`,
 * `-statement`, `-contract-command`, `-bid`, `-tender-command`, `-inventory`) —
 * one rule, here, so the eight cannot drift apart (task 100).
 *
 * ## Per person and organization
 *
 * An entry is stored under a key that names its person and its owner — this
 * person acting for this organization (`submissionBinding`):
 * `<prefix>@<person>.<owner>.<scope>`. So the same person's entries for two
 * organizations never share a key, and:
 *
 * - a page for organization B neither shows nor resolves A's entry — it never
 *   reads A's key;
 * - nothing is removed by a switch: back on A, every entry A left is still
 *   there, with whatever it may still do (a retry under its own key and stamp)
 *   and nothing more;
 * - another person's page reduces every entry that is not its person's to a
 *   content-free marker — the account boundary `AccountBoundary` draws — and a
 *   logout reduces them too: content goes, the unknown outcome stays (below).
 *
 * ## Entries written before this
 *
 * An entry under the old key, `<prefix><scope>`, names an owner tag computed
 * from the login's organization, while the request it remembers acted for the
 * token's — which a switch made elsewhere could already have moved. It cannot
 * say which organization it was sent for, so it is never retagged and never
 * guessed: it is kept for its person (its tag is one of `binding.legacy`), held
 * against a fresh submission in its scope, and only ever shown view-only — the
 * same "the outcome is unknown, check before acting" view a record from an
 * earlier login gets.
 *
 * ## What cannot be attributed: quarantined, never removed (PR 405 review 2, F1)
 *
 * An old entry's owner tag is a one-way digest of a person and the organization
 * it was written under; it holds no person id. Its person recognises it only
 * while their token still lists that organization (`binding.legacy`), so once
 * the membership has ended — or for anyone else — it cannot be told whose it
 * is. It is then **quarantined**, for everybody on this device (this tab's
 * `sessionStorage`), and so is everything else under a store's prefix that is
 * not the page person's own (`ownEntry`): an entry that does not read, a key
 * that does not parse, another person's entry, and the content-free marker an
 * entry is reduced to (`QUARANTINE_MARK`).
 *
 * - **Never removed, never overwritten.** An entry that cannot be attributed
 *   stays exactly as it is. Where an account boundary, a logout or an expiry
 *   must drop content (another person's offer, quantity or text), the entry is
 *   reduced to a marker with nothing in it but the time — the content goes,
 *   the fact that an outcome is unknown stays. A save never writes over one:
 *   a key that holds one is moved aside first, byte for byte (`relocate`).
 * - **Never shown, never sent, never guessed into a tenant.** Its content is
 *   not read for display; nothing re-sends it.
 * - **It holds its kind.** While one is held for the page's person, no fresh
 *   submission of that store's kind is saved — so none is sent — and the form
 *   is replaced by a fixed warning (`app/UnresolvedQuarantine.tsx`).
 * - **Release.** Only by the person's explicit acknowledgement of the duplicate
 *   risk, fenced to the exact records the warning was drawn for (key and a
 *   fingerprint of the bytes, `acknowledge`): it lifts the hold **for that
 *   person**, resends nothing, and removes nothing — another person on the
 *   device is still warned. A record that changed after the warning was drawn
 *   is not covered. The acknowledgement keeps a bounded fingerprint, never a
 *   copy (PR 405 review 3, R2), and its outcome is returned: a write that
 *   failed lifts nothing and says so (`AckOutcome`). The one other release is
 *   the owner service's answer to THAT request, which only an entry that
 *   verifies for its person can receive (its own form, under its own key and
 *   stamp): a retry's refusal, or a list that does not show it, is neither.
 *
 * ## One slot, fenced to its submission (PR 405 review 3, R1)
 *
 * Every store keeps at most one entry per scope, and every write to it goes
 * through `fencedSlot`, so the eight cannot drift apart again. The fence is
 * the whole ownership tuple: the person and the organization (the key and the
 * entry's owner tag), the scope (the key, and the entry where it names one),
 * the submission id, and — for an answer — the login it was sent under.
 *
 * - `start`, before a first send: refused (`HELD`) while the slot holds another
 *   submission's entry, or while a quarantined record holds this kind for the
 *   person. Nothing is written over anything.
 * - `answer`, a later answer still in doubt: updates the slot only while it
 *   holds THAT submission's entry, keeping its first body, its first time and
 *   a withdrawn replay withdrawn. Otherwise — the person set it aside and
 *   another submission took the slot, or it was reduced — the slot is left
 *   exactly as it is and the late answer is **kept aside** as a content-free
 *   quarantined record (`SET_ASIDE`), which holds this kind and draws the
 *   fixed warning. If even that cannot be written (a full quota, a logout in
 *   between), it is kept for this document in memory and holds the same way
 *   until this tab navigates away — never dropped silently.
 * - `settle`, a definite answer, and `release`, the person's own "set it
 *   aside": remove the slot's entry only when it is that submission's — and
 *   only that one key; another organization's entry, an old-format entry of
 *   another submission and every quarantined record stay.
 *
 * ## Which send an answer belongs to: the send's identity (PR 363 reviews 3 and 4)
 *
 * A re-send goes under the same key as the first send, so the submission id
 * cannot tell their answers apart — and an earlier send's answer can arrive
 * **after** a later send left: navigate away while it is out, come back, send
 * the same request again. If the service refused the earlier send and released
 * its key, the later one may commit with its answer lost; the earlier refusal,
 * arriving last, would then have removed the record of a request that did
 * commit, and the next page would offer a fresh key — the same stock moved
 * twice.
 *
 * The same holds when the record went in between: set aside (the person's
 * "set it aside", a middle-click included, which keeps this document alive) or
 * settled, and then made again under the same key — a form drawn from cached
 * props still carries that key and its stamp. A count that starts again at 1
 * for every new record cannot tell the new record's first send from the old
 * one's (PR 363 review 4). So every send has an identity of its own
 * (`Attempt`): 128 random bits, **minted by this slot and nothing else**, kept
 * in the entry it wrote, and returned to the one submit path
 * (`lib/fenced-submission.ts`), which hands it back with that send's answer.
 * No identity is derived from a count, a key or a time, so none is ever
 * reused — not across a re-send, a release, a settle or a new record:
 *
 * - `start` mints the first send's identity, writes it with the entry, reads
 *   the entry back and returns it (`StartOutcome`). Nothing written, or not
 *   read back: nothing is sent.
 * - `advance`, before **every** re-send, mints a new identity, writes it into
 *   the entry and reads it back. Only that field changes: the body, the stamp
 *   (and so the server's replay deadline), the time it was saved — so its
 *   expiry — and every other byte stay the first send's. If it cannot be
 *   written, nothing is sent: the uncertainty stays as it was.
 * - `answer` and `settle` take the identity of the send they answer. Only the
 *   entry that send wrote — the very same identity — may be touched: a late
 *   answer of any other send, an earlier re-send or a send of a record that
 *   has since been set aside or settled and made again, leaves the entry
 *   exactly as it is (`SUPERSEDED` — the entry already says the outcome is
 *   unknown), and a definite answer of any other send removes nothing.
 *   Equality is necessary, not sufficient: which definite answers may settle
 *   at all is the boundary's rule (`lib/fenced-submission.ts`) — the first
 *   send's own refusal, or a confirmed success; never a re-send's refusal, a
 *   session refusal of a re-send or a passed replay deadline.
 * - An entry without an identity — reduced to a marker (logout, expiry), or
 *   written before identities existed (a number, or none) — matches no answer,
 *   so no answer removes or rewrites it. A re-send from an old entry (never
 *   from a marker) first writes a fresh identity into it; only that re-send's
 *   own answers may then touch it.
 * - Once a confirmed success removed an entry, a late answer in doubt of the
 *   same submission, from the same login, is moot — the request is known to
 *   have committed — and is dropped (this document's memory) instead of kept
 *   aside as a warning.
 */

import { fingerprintOf } from './record-fingerprint';

/** The tags the page computed for this person, organization and login (`server/submission.ts`). */
export interface Binding {
  readonly person: string;
  readonly owner: string;
  readonly session: string;
  /** Owner tags an entry stored under the old key may carry for this person. */
  readonly legacy: readonly string[];
}

/** What an account boundary needs: who the page is for, whatever organization. */
export type AccountTags = Pick<Binding, 'person' | 'legacy'>;

const TAG = /^[A-Za-z0-9_-]{1,128}$/;

/** Under a store's prefix: a quarantined record that is no entry of anyone's (`quarantine`, `relocate`). */
export const QUARANTINE_MARK = '!q.';
/** Under a store's prefix: what one person acknowledged (`acknowledge`). */
const ACK_MARK = '!ack.';

/**
 * A quarantined record, as the warning was drawn for it: where it is and a
 * bounded fingerprint of what it holds (`lib/record-fingerprint.ts`) — never
 * its content, which nothing shows.
 */
export interface Held {
  readonly key: string;
  readonly fingerprint: string;
}

/** How a store reads one of its entries; null when it does not read. */
export type EntryParser<E extends { readonly owner: string }> = (
  raw: string,
  key: StoredKey,
) => E | null;

/** The key an entry for `scope` is stored under, for this person and organization. */
export function tenantKey(
  prefix: string,
  binding: Pick<Binding, 'person' | 'owner'>,
  scope: string,
) {
  return `${prefix}@${binding.person}.${binding.owner}.${scope}`;
}

/** The key an entry for `scope` was stored under before entries were kept per organization. */
export function legacyKey(prefix: string, scope: string): string {
  return `${prefix}${scope}`;
}

export type StoredKey =
  | {
      readonly kind: 'TENANT';
      readonly person: string;
      readonly owner: string;
      readonly scope: string;
    }
  | { readonly kind: 'LEGACY'; readonly scope: string };

/** What a key under `prefix` names; null when it is not one of this store's keys or does not parse. */
export function storedKeyOf(prefix: string, key: string): StoredKey | null {
  if (!key.startsWith(prefix)) return null;
  const rest = key.slice(prefix.length);
  // A quarantine marker or an acknowledgement: no entry of anyone's.
  if (rest.startsWith('!')) return null;
  if (!rest.startsWith('@')) return rest.length > 0 ? { kind: 'LEGACY', scope: rest } : null;
  const [person, owner, ...scope] = rest.slice(1).split('.');
  if (!person || !owner || !TAG.test(person) || !TAG.test(owner) || scope.length === 0) return null;
  const joined = scope.join('.');
  return joined.length > 0 ? { kind: 'TENANT', person, owner, scope: joined } : null;
}

/**
 * Whether an entry whose content names `entryOwner`, under `key`, is this
 * person's own: under a key of theirs (any organization), or an old-format
 * entry carrying one of their old tags. Anything else — another person's,
 * unreadable, a key that disagrees with its content — is quarantined for them
 * (see above), never removed.
 */
export function keptFor(tags: AccountTags, key: StoredKey, entryOwner: string): boolean {
  if (key.kind === 'LEGACY') return tags.legacy.includes(entryOwner);
  return key.person === tags.person && key.owner === entryOwner;
}

/** Every key under `prefix`, in the order storage lists them. */
export function keysUnder(store: Storage, prefix: string): string[] {
  const keys: string[] = [];
  for (let index = 0; index < store.length; index += 1) {
    const key = store.key(index);
    if (key !== null && key.startsWith(prefix)) keys.push(key);
  }
  return keys;
}

/** The person's own entry, readable and under a key that agrees with it (`keptFor`). */
export function ownEntry<E extends { readonly owner: string }>(
  prefix: string,
  key: string,
  raw: string | null,
  tags: AccountTags,
  parse: EntryParser<E>,
): boolean {
  const located = storedKeyOf(prefix, key);
  const entry = located === null || raw === null ? null : parse(raw, located);
  return located !== null && entry !== null && keptFor(tags, located, entry.owner);
}

let sequence = 0;

/** A key no record has used: the time, a counter and a random part. */
function freshQuarantineKey(store: Storage, prefix: string, now: number): string {
  for (;;) {
    sequence += 1;
    const random = Math.floor(Math.random() * 2 ** 32).toString(36);
    const key = `${prefix}${QUARANTINE_MARK}${now.toString(36)}.${sequence.toString(36)}.${random}`;
    if (store.getItem(key) === null) return key;
  }
}

/**
 * The content-free record of an unknown outcome: the time and a generation of
 * its own, so no two such records are ever the same bytes — an acknowledgement
 * of one never covers a later one.
 */
function quarantineMarker(now: number): string {
  const generation = `${sequence.toString(36)}.${Math.floor(Math.random() * 2 ** 32).toString(36)}`;
  return JSON.stringify({ v: 1, quarantined: true, at: now, g: generation });
}

/**
 * Drops the content of the entry under `key` and keeps the fact that an
 * outcome is unknown: a marker with nothing in it but the time, under a key
 * that names nobody and no scope. For an entry whose content may not outlive
 * the moment (another person's, at an account boundary; anything at a logout;
 * an expired one).
 */
export function reduceToQuarantine(
  store: Storage,
  prefix: string,
  key: string,
  now: number = Date.now(),
): void {
  store.setItem(freshQuarantineKey(store, prefix, now), quarantineMarker(now));
  store.removeItem(key);
}

/**
 * Moves the record under `key` aside, byte for byte, so the key can take a new
 * entry without writing over it; acknowledgements of it follow it. If a write
 * fails part way the record stays where it was (and may be held twice) — a
 * hold is never lifted by a failure.
 */
export function relocate(
  store: Storage,
  prefix: string,
  key: string,
  now: number = Date.now(),
): void {
  const raw = store.getItem(key);
  if (raw === null) return;
  const fingerprint = fingerprintOf(raw);
  const moved = freshQuarantineKey(store, prefix, now);
  store.setItem(moved, raw);
  for (const ackKey of keysUnder(store, `${prefix}${ACK_MARK}`)) {
    const acks = acknowledgements(store, ackKey);
    const covers = (ack: Held) => ack.key === key && ack.fingerprint === fingerprint;
    if (acks.some(covers)) {
      store.setItem(
        ackKey,
        JSON.stringify(acks.map((ack) => (covers(ack) ? { key: moved, fingerprint } : ack))),
      );
    }
  }
  store.removeItem(key);
}

/**
 * Account boundary, a page for `tags`: another person's readable entry is
 * reduced to a marker (`reduceToQuarantine`) — its offer, quantity or text do
 * not stay for the next person, the fact that its outcome is unknown does.
 * The person's own, for every organization, stay; so does every record that
 * cannot be attributed, untouched — it may be this person's from an
 * organization their token no longer lists. Nothing is removed outright.
 */
export function purgeForeign<E extends { readonly owner: string }>(
  store: Storage,
  prefix: string,
  tags: AccountTags,
  parse: EntryParser<E>,
  now: number = Date.now(),
): void {
  for (const key of keysUnder(store, prefix)) {
    const located = storedKeyOf(prefix, key);
    const raw = store.getItem(key);
    if (located?.kind !== 'TENANT' || located.person === tags.person || raw === null) continue;
    if (parse(raw, located) !== null) reduceToQuarantine(store, prefix, key, now);
  }
}

/** Every record under `prefix` that is not this person's own entry: quarantined for them. */
export function quarantinedFor<E extends { readonly owner: string }>(
  store: Storage,
  prefix: string,
  tags: AccountTags,
  parse: EntryParser<E>,
): Held[] {
  const held: Held[] = [];
  for (const key of keysUnder(store, prefix)) {
    if (key.startsWith(`${prefix}${ACK_MARK}`)) continue;
    const raw = store.getItem(key);
    if (raw !== null && !ownEntry(prefix, key, raw, tags, parse)) {
      held.push({ key, fingerprint: fingerprintOf(raw) });
    }
  }
  return held;
}

const FINGERPRINT = /^[0-9a-z]{1,8}\.[0-9a-f]{64}$/;

function acknowledgements(store: Storage, ackKey: string): Held[] {
  try {
    const value: unknown = JSON.parse(store.getItem(ackKey) ?? '[]');
    if (!Array.isArray(value)) return [];
    return value.filter(
      (item): item is Held =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as Held).key === 'string' &&
        typeof (item as Held).fingerprint === 'string' &&
        FINGERPRINT.test((item as Held).fingerprint),
    );
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// What could not be written: held in memory for this document

/**
 * A late answer that could not be kept aside in storage (quota, a logout in
 * between, storage gone): its kind is held for this document — every person
 * on it — with the same fixed warning, until each acknowledges it. Nothing of
 * it is kept but the fact; it does not outlive the document, which is the
 * most that can be promised when storage refuses.
 */
const MEMORY_MARK = 'memory:';
const unrecorded = new Map<string, string[]>();
const memoryAcks = new Map<string, Set<string>>();
const watchers = new Map<string, Set<() => void>>();
let memorySequence = 0;

function notify(prefix: string): void {
  for (const listener of [...(watchers.get(prefix) ?? [])]) listener();
}

function keepInMemory(prefix: string): void {
  memorySequence += 1;
  unrecorded.set(prefix, [...(unrecorded.get(prefix) ?? []), `${MEMORY_MARK}${memorySequence}`]);
}

function memoryHeldFor(prefix: string, person: string): Held[] {
  const acked = memoryAcks.get(`${prefix} ${person}`) ?? new Set<string>();
  return (unrecorded.get(prefix) ?? [])
    .filter((key) => !acked.has(key))
    .map((key) => ({ key, fingerprint: key }));
}

/**
 * Submissions a confirmed success removed in this document: key, id and login
 * (`fencedSlot` `settle`). A late answer in doubt of one is moot (`answer`).
 */
const confirmed = new Set<string>();

function confirmedId(key: string, submissionId: string, binding: Binding): string {
  return `${key}\n${submissionId}\n${binding.session}`;
}

/** A new document's memory, for specs: nothing unrecorded, acknowledged or confirmed. */
export function resetUnrecordedOutcomes(): void {
  unrecorded.clear();
  memoryAcks.clear();
  confirmed.clear();
}

/**
 * The quarantined records this person has not acknowledged — in storage and
 * in this document's memory: what holds their next submission of this kind.
 */
export function heldFor<E extends { readonly owner: string }>(
  store: Storage,
  prefix: string,
  tags: AccountTags,
  parse: EntryParser<E>,
): Held[] {
  const acks = acknowledgements(store, `${prefix}${ACK_MARK}${tags.person}`);
  const stored = quarantinedFor(store, prefix, tags, parse).filter(
    (record) =>
      !acks.some((ack) => ack.key === record.key && ack.fingerprint === record.fingerprint),
  );
  return [...stored, ...memoryHeldFor(prefix, tags.person)];
}

/**
 * `ACKNOWLEDGED`: every record of the fence is covered. `CHANGED`: some of
 * them changed or went after the warning was drawn and are not covered (the
 * rest are). `FAILED`: the acknowledgement could not be written — nothing new
 * is covered and the hold stays; the person is told so.
 */
export type AckOutcome = 'ACKNOWLEDGED' | 'CHANGED' | 'FAILED';

/**
 * This person accepts the duplicate risk for exactly `fence` — the records the
 * warning was drawn for. Only those still there with the same bytes (the same
 * fingerprint, checked in this same turn) are covered; nothing is removed or
 * sent, and nobody else's hold is lifted. What is written is bounded — a key
 * and a fingerprint per record — and read back before success is reported.
 */
export function acknowledge(
  store: Storage,
  prefix: string,
  person: string,
  fence: readonly Held[],
): AckOutcome {
  if (!TAG.test(person)) return 'FAILED';
  const ackKey = `${prefix}${ACK_MARK}${person}`;
  const still = (record: Held) => {
    const raw = store.getItem(record.key);
    return raw !== null && fingerprintOf(raw) === record.fingerprint;
  };
  const inStore = fence.filter((record) => !record.key.startsWith(MEMORY_MARK));
  const kept = acknowledgements(store, ackKey).filter(still);
  const covered = inStore.filter(
    (record) =>
      record.key.startsWith(prefix) &&
      !record.key.startsWith(`${prefix}${ACK_MARK}`) &&
      still(record),
  );
  const added = covered.filter(
    (record) =>
      !kept.some((ack) => ack.key === record.key && ack.fingerprint === record.fingerprint),
  );
  const text = JSON.stringify([
    ...kept,
    ...added.map(({ key, fingerprint }) => ({ key, fingerprint })),
  ]);
  // Nothing new and nothing pruned: no write, so a full storage cannot fail it.
  if (store.getItem(ackKey) !== text && (added.length > 0 || store.getItem(ackKey) !== null)) {
    try {
      store.setItem(ackKey, text);
    } catch {
      return 'FAILED';
    }
    if (store.getItem(ackKey) !== text) return 'FAILED';
  }
  return acknowledgeInMemory(prefix, person, fence) && covered.length === inStore.length
    ? 'ACKNOWLEDGED'
    : 'CHANGED';
}

/** The memory part of a fence: covered when still unrecorded here. False when one of them is not. */
function acknowledgeInMemory(prefix: string, person: string, fence: readonly Held[]): boolean {
  const pending = unrecorded.get(prefix) ?? [];
  const id = `${prefix} ${person}`;
  const acked = memoryAcks.get(id) ?? new Set<string>();
  let all = true;
  for (const record of fence) {
    if (!record.key.startsWith(MEMORY_MARK)) continue;
    if (pending.includes(record.key) && record.fingerprint === record.key) acked.add(record.key);
    else all = false;
  }
  memoryAcks.set(id, acked);
  return all;
}

/**
 * Frees this page's own key for a new entry: a record there that is not this
 * person's readable entry (`ownEntry`) is moved aside first, never written over.
 */
export function freeOwnKey<E extends { readonly owner: string }>(
  store: Storage,
  prefix: string,
  key: string,
  tags: AccountTags,
  parse: EntryParser<E>,
): void {
  const raw = store.getItem(key);
  if (raw !== null && !ownEntry(prefix, key, raw, tags, parse)) relocate(store, prefix, key);
}

/** What a form of one kind needs to know and do about quarantined records (`app/UnresolvedQuarantine.tsx`). */
export interface QuarantineSource {
  held(tags: AccountTags): readonly Held[];
  acknowledge(person: string, fence: readonly Held[]): AckOutcome;
  /** Told when a record of this kind is newly held (a late answer kept aside); returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
}

function sessionStore(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

/** The quarantine of the store under `prefix`, read from this tab's `sessionStorage` and this document's memory. */
export function quarantineOf<E extends { readonly owner: string }>(
  prefix: string,
  parse: EntryParser<E>,
): QuarantineSource {
  return {
    held(tags) {
      try {
        const store = sessionStore();
        return store ? heldFor(store, prefix, tags, parse) : memoryHeldFor(prefix, tags.person);
      } catch {
        return memoryHeldFor(prefix, tags.person);
      }
    },
    acknowledge(person, fence) {
      try {
        const store = sessionStore();
        if (store) return acknowledge(store, prefix, person, fence);
        // No storage at all: only what this document holds in memory can be covered.
        const onlyMemory = fence.every((record) => record.key.startsWith(MEMORY_MARK));
        return onlyMemory && TAG.test(person) && acknowledgeInMemory(prefix, person, fence)
          ? 'ACKNOWLEDGED'
          : 'FAILED';
      } catch {
        // Unavailable storage: nothing acknowledged, the hold stays — and the person is told.
        return 'FAILED';
      }
    },
    subscribe(listener) {
      const set = watchers.get(prefix) ?? new Set<() => void>();
      set.add(listener);
      watchers.set(prefix, set);
      return () => {
        set.delete(listener);
      };
    },
  };
}

/**
 * Where this page's entry for `scope` is: under this organization's key, or —
 * when there is none — under the old key, which is then `legacy` and may only
 * be shown. Null when neither holds anything.
 */
export function locate(
  store: Storage,
  prefix: string,
  binding: Binding,
  scope: string,
): { readonly key: string; readonly raw: string; readonly legacy: boolean } | null {
  const own = tenantKey(prefix, binding, scope);
  const raw = store.getItem(own);
  if (raw !== null) return { key: own, raw, legacy: false };
  const old = legacyKey(prefix, scope);
  const legacyRaw = store.getItem(old);
  return legacyRaw === null ? null : { key: old, raw: legacyRaw, legacy: true };
}

/**
 * Whether a fresh submission of this store's kind may be saved for `tags`:
 * nothing quarantined is held for them (`heldFor`). The save of an entry this
 * page already keeps — a late answer of the same submission — does not ask.
 */
export function mayStartFresh<E extends { readonly owner: string }>(
  store: Storage,
  prefix: string,
  tags: AccountTags,
  parse: EntryParser<E>,
): boolean {
  return heldFor(store, prefix, tags, parse).length === 0;
}

/** Whether a located entry naming `entryOwner` is this page's to show. */
export function ownedHere(binding: Binding, legacy: boolean, entryOwner: string): boolean {
  return legacy ? binding.legacy.includes(entryOwner) : entryOwner === binding.owner;
}

// ---------------------------------------------------------------------------
// The fenced slot: every store's save, answer, settle and release (R1)

/**
 * The identity of one send of a submission: 128 random bits as 32 lowercase
 * hex digits, minted by the slot (`start`, `advance`) and by nothing else.
 */
export type Attempt = string & { readonly __attempt: 'Attempt' };

/** Where an entry's send identity is kept; written by the slot only. */
const ATTEMPT_FIELD = 'attempt';
const ATTEMPT_TEXT = /^[0-9a-f]{32}$/;

/**
 * A send identity no send has had: 128 bits from the platform's
 * cryptographic generator. Throws when there is none — then nothing is
 * written and nothing is sent (`start`, `advance` answer `UNAVAILABLE`/null).
 */
function mintAttempt(): Attempt {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  const text = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  if (!ATTEMPT_TEXT.test(text)) throw new Error('no send identity');
  return text as Attempt;
}

/** The send identity an entry's text carries, or null (a marker, an entry written before identities). */
function attemptOf(raw: string): Attempt | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null) return null;
    const attempt = (value as Record<string, unknown>)[ATTEMPT_FIELD];
    return typeof attempt === 'string' && ATTEMPT_TEXT.test(attempt) ? (attempt as Attempt) : null;
  } catch {
    return null;
  }
}

/** `text` with its send identity set to `attempt` — every other field as it was; null when it is not an object. */
function withAttempt(text: string, attempt: Attempt): string | null {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    return JSON.stringify({ ...(value as Record<string, unknown>), [ATTEMPT_FIELD]: attempt });
  } catch {
    return null;
  }
}

/** How a definite answer ends a submission: refused (nothing done) or confirmed (done). */
export type Settlement = 'REFUSED' | 'CONFIRMED';

/** What the slot reads of a store's entry: whose, which submission, which login. */
export interface SlotEntry {
  readonly owner: string;
  readonly submissionId: string;
  /** The login it was sent under; absent in a content-free marker. */
  readonly session?: string;
}

/**
 * `SAVED`: stored, under the first send's identity (`attempt`) — the one its
 * answers must carry. `HELD`: another submission's entry holds this slot, or a
 * quarantined record holds this kind for this person — nothing was written and
 * this submission must not be sent. `UNRESOLVED`: the slot already keeps this
 * very submission, its outcome unknown — it is not a first send, whatever the
 * form that asks believes (a form drawn again blank under its key; PR 405
 * review 4, R4): nothing was written, nothing may be sent under that key but
 * its kept body, and a definite answer to such a send proves nothing about
 * the first. `UNAVAILABLE`: storage refused it, or a logout has started.
 */
export type StartOutcome =
  | { readonly outcome: 'SAVED'; readonly attempt: Attempt }
  | { readonly outcome: 'HELD' | 'UNRESOLVED' | 'UNAVAILABLE' };

/** The outcomes of a start that wrote nothing — and so must send nothing. */
export const NOT_STARTED = {
  HELD: { outcome: 'HELD' },
  UNRESOLVED: { outcome: 'UNRESOLVED' },
  UNAVAILABLE: { outcome: 'UNAVAILABLE' },
} as const satisfies Record<string, StartOutcome>;

/**
 * `SAVED`: the slot's entry of this submission is updated. `SUPERSEDED`: the
 * slot keeps this submission's entry from a later send (or a marker of it), or
 * this login saw it confirmed — it is left exactly as it is, nothing is set
 * aside: the entry already says the outcome is unknown. `SET_ASIDE`: the
 * slot no longer holds it — it was left exactly as it is, and the answer is
 * kept aside as a content-free quarantined record. `UNAVAILABLE`: neither
 * could be written; this submission's earlier entry, if the slot still holds
 * it, stays as it was, and otherwise the outcome is held in memory.
 */
export type AnswerOutcome = 'SAVED' | 'SUPERSEDED' | 'SET_ASIDE' | 'UNAVAILABLE';

export interface FencedSlot<E extends SlotEntry> {
  /**
   * Before the first send of `submissionId`; `compose` returns the text to
   * store (null: nothing storable — then nothing is sent).
   */
  start(
    binding: Binding,
    scope: string,
    submissionId: string,
    compose: () => string | null,
  ): StartOutcome;
  /**
   * An answer to `submissionId` that is still in doubt: `compose` gets its entry
   * and returns the text to store, or null to keep it as it is (a marker is
   * never made re-sendable).
   */
  answer(
    binding: Binding,
    scope: string,
    submissionId: string,
    /** The send it answers; null — a send nothing remembered — matches no entry. */
    attempt: Attempt | null,
    compose: (earlier: E) => string | null,
    now?: number,
  ): AnswerOutcome;
  /**
   * Before a re-send of `submissionId`: a new send identity, written into its
   * entry and read back — or null, and then nothing may be sent.
   */
  advance(binding: Binding, scope: string, submissionId: string): Attempt | null;
  /**
   * A definite answer to send `attempt` of `submissionId`, from the login it was
   * sent under: the entry that send wrote, and only that, goes — only while no
   * other send (a re-send, or a new record under the same key) has written it
   * since.
   */
  settle(
    binding: Binding,
    scope: string,
    submissionId: string,
    attempt: Attempt,
    settlement: Settlement,
  ): void;
  /** The person sets aside the entry they were shown — `submissionId`'s, and only that. */
  release(binding: Binding, scope: string, submissionId: string): void;
  readonly quarantine: QuarantineSource;
}

/** Whether `entry` was sent under this page's login; a marker keeps no login and is anyone's of its person. */
function sameLogin(entry: SlotEntry, binding: Binding): boolean {
  return entry.session === undefined || entry.session === binding.session;
}

/**
 * The one slot primitive every store writes through (`lib/unresolved-*.ts`).
 * `closing` says a logout has started (nothing is written from then on);
 * `changed` is told after every write.
 */
export function fencedSlot<E extends SlotEntry>(
  prefix: string,
  parse: EntryParser<E>,
  hooks: { readonly closing: () => boolean; readonly changed?: () => void },
): FencedSlot<E> {
  const changed = () => hooks.changed?.();

  /** The slot's entry, when it is this person's and organization's own (or their old-format one). */
  function occupant(store: Storage, binding: Binding, scope: string) {
    const found = locate(store, prefix, binding, scope);
    const located = found === null ? null : storedKeyOf(prefix, found.key);
    const entry = found === null || located === null ? null : parse(found.raw, located);
    if (found === null || entry === null || !ownedHere(binding, found.legacy, entry.owner)) {
      return null;
    }
    return {
      key: found.key,
      legacy: found.legacy,
      entry,
      raw: found.raw,
      attempt: attemptOf(found.raw),
    };
  }

  /** The slot's entry of `submissionId` from this login — the one an answer may touch. */
  function answerable(store: Storage, binding: Binding, scope: string, submissionId: string) {
    const held = occupant(store, binding, scope);
    return held !== null &&
      !held.legacy &&
      held.entry.submissionId === submissionId &&
      sameLogin(held.entry, binding)
      ? held
      : null;
  }

  /** A late answer for a slot that is no longer its own: kept aside, never over anything. */
  function setAside(store: Storage | null, now: number): AnswerOutcome {
    try {
      if (store === null || hooks.closing()) throw new Error('not written');
      store.setItem(freshQuarantineKey(store, prefix, now), quarantineMarker(now));
      return 'SET_ASIDE';
    } catch {
      keepInMemory(prefix);
      return 'UNAVAILABLE';
    } finally {
      changed();
      notify(prefix);
    }
  }

  return {
    quarantine: quarantineOf(prefix, parse),

    start(binding, scope, submissionId, compose) {
      if (hooks.closing()) return NOT_STARTED.UNAVAILABLE;
      try {
        const store = sessionStore();
        if (!store) return NOT_STARTED.UNAVAILABLE;
        const held = occupant(store, binding, scope);
        // Another submission's entry — even a marker — is never replaced; nor is an
        // old-format entry, which is only ever shown (it may be another organization's).
        if (
          held !== null &&
          (held.legacy ||
            held.entry.submissionId !== submissionId ||
            !sameLogin(held.entry, binding))
        ) {
          return NOT_STARTED.HELD;
        }
        // This very submission is already unresolved here: a re-send, never a first
        // one — its entry is not rewritten, and nothing new goes out under its key.
        if (held !== null) return NOT_STARTED.UNRESOLVED;
        if (!mayStartFresh(store, prefix, binding, parse)) return NOT_STARTED.HELD;
        const composed = compose();
        // A new record is a new incarnation: its own identity, never one an earlier
        // record of the same key had — whatever answer of that one is still out.
        const attempt = mintAttempt();
        const text = composed === null ? null : withAttempt(composed, attempt);
        if (text === null) return NOT_STARTED.UNAVAILABLE;
        const key = tenantKey(prefix, binding, scope);
        // Never written over: whatever else the key holds is moved aside first.
        freeOwnKey(store, prefix, key, binding, parse);
        store.setItem(key, text);
        if (store.getItem(key) !== text) return NOT_STARTED.UNAVAILABLE;
        changed();
        return { outcome: 'SAVED', attempt };
      } catch {
        return NOT_STARTED.UNAVAILABLE;
      }
    },

    answer(binding, scope, submissionId, attempt, compose, now = Date.now()) {
      const store = sessionStore();
      if (store !== null && !hooks.closing()) {
        let own = false;
        try {
          const held = answerable(store, binding, scope, submissionId);
          own = held !== null;
          if (held !== null) {
            // Another send's entry — a re-send, or a record made again under this key
            // since — or one without an identity (a marker): this answer neither
            // rewrites nor recreates anything.
            // A null answer — a send nothing remembered — never matches one either.
            if (held.attempt === null || held.attempt !== attempt) return 'SUPERSEDED';
            const composed = compose(held.entry);
            if (composed !== null) {
              const text = withAttempt(composed, attempt);
              if (text === null) throw new Error('not an entry');
              store.setItem(held.key, text);
            }
            changed();
            return 'SAVED';
          }
          // Gone because a confirmed success removed it: the request is known to have
          // committed, so this answer in doubt is moot — nothing is kept aside.
          if (
            confirmed.has(confirmedId(tenantKey(prefix, binding, scope), submissionId, binding))
          ) {
            return 'SUPERSEDED';
          }
        } catch {
          // Its own entry is still there as it was: still shown, still holding its slot.
          if (own) return 'UNAVAILABLE';
        }
      }
      // Not its slot any more — set aside and replaced, reduced, or unreadable — or
      // nothing can be read: the slot is not touched and the answer is kept aside.
      return setAside(store, now);
    },

    advance(binding, scope, submissionId) {
      if (hooks.closing()) return null;
      try {
        const store = sessionStore();
        const held = store ? answerable(store, binding, scope, submissionId) : null;
        // Whether it may be sent again at all is the form's `admitRetry`, asked first:
        // a reduced marker never is.
        if (!store || held === null) return null;
        const next = mintAttempt();
        const text = withAttempt(held.raw, next);
        if (text === null) return null;
        store.setItem(held.key, text);
        if (store.getItem(held.key) !== text) return null;
        changed();
        return next;
      } catch {
        return null;
      }
    },

    settle(binding, scope, submissionId, attempt, settlement) {
      try {
        const store = sessionStore();
        const held = store ? answerable(store, binding, scope, submissionId) : null;
        // Only the answer of the send that wrote this entry: another send's — an
        // earlier one, or one of a record set aside and made again since — says
        // nothing about it, and it may have committed.
        if (!store || held === null || held.attempt !== attempt) return;
        store.removeItem(held.key);
        if (settlement === 'CONFIRMED') confirmed.add(confirmedId(held.key, submissionId, binding));
      } catch {
        return;
      }
      changed();
    },

    release(binding, scope, submissionId) {
      try {
        const store = sessionStore();
        const held = store ? occupant(store, binding, scope) : null;
        if (!store || held === null || held.entry.submissionId !== submissionId) return;
        store.removeItem(held.key);
      } catch {
        return;
      }
      changed();
    },
  };
}
