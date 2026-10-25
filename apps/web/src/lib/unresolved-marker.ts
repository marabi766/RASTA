/**
 * A command whose outcome is unknown, remembered in `sessionStorage` as a
 * **marker only** — that it was sent, never what it said — for the commands
 * whose service makes a second send under a fresh key harmless: a bid
 * (`lib/unresolved-bid.ts`; one bid per organization, a replacement and a
 * withdrawal bound to a revision) and the owner's tender commands
 * (`lib/unresolved-tender-command.ts`; each bound to a version, or idempotent
 * in the service itself).
 *
 * A record holds the command, the submission id, the original correlation id,
 * when it was saved and the owner's one-way tag (`submissionBinding`) — no
 * content, no token, no session value. It is never re-sent after a reload;
 * within the page that sent it, the form keeps what it sent in memory.
 *
 * One record per scope, never replaced: saving another submission's record
 * over it is refused (`HELD`), and a record is cleared only by the submission
 * it belongs to. Records are kept per person and organization
 * (`lib/unresolved-tenancy.ts`): a page for another organization of the same
 * person neither shows nor clears them, a page for another person reduces
 * every entry of anyone else to a content-free marker, and a logout writes
 * nothing more and leaves the markers. Nothing that cannot be attributed — a
 * record from an organization this person's token no longer lists, one that
 * does not read — is removed: it holds every fresh command of its kind on this
 * device until the person acknowledges the duplicate risk (`quarantine`; PR
 * 405 review 2, F1).
 */

import {
  freeOwnKey,
  locate,
  mayStartFresh,
  ownedHere,
  purgeForeign,
  quarantineOf,
  tenantKey,
  type AccountTags,
  type Binding,
  type QuarantineSource,
} from './unresolved-tenancy';

const VERSION = 1;
const SUBMISSION_ID = /^sub_[A-Za-z0-9_-]{8,128}$/;
const MAX_TAG_LENGTH = 128;

export interface UnresolvedMarker<C extends string> {
  readonly command: C;
  readonly submissionId: string;
  /** Null while the first send has not been answered. */
  readonly correlationId: string | null;
  /** Milliseconds since the epoch, browser clock. */
  readonly savedAt: number;
}

/**
 * `SAVED`: stored. `HELD`: another submission's record holds this scope, or a
 * quarantined record holds this kind for this person — it is left exactly as
 * it was, and this one must not be sent. `UNAVAILABLE`: storage refused it, or
 * a logout has started.
 */
export type SaveOutcome = 'SAVED' | 'HELD' | 'UNAVAILABLE';

export interface MarkerStore<C extends string> {
  subscribe(listener: () => void): () => void;
  markOpen(): void;
  purgeAll(): void;
  purgeForeign(tags: AccountTags): void;
  save(
    scope: string,
    entry: Omit<UnresolvedMarker<C>, 'savedAt'>,
    binding: Binding,
    now?: number,
  ): SaveOutcome;
  clear(scope: string, submissionId: string, binding: Binding): void;
  restore(scope: string, binding: Binding): UnresolvedMarker<C> | null;
  /** What holds a fresh command of this kind (`lib/unresolved-tenancy.ts`). */
  readonly quarantine: QuarantineSource;
}

type Stored<C extends string> = UnresolvedMarker<C> & {
  readonly v: number;
  readonly owner: string;
};

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

/** A store of markers under `keyPrefix`, for commands `isCommand` admits. */
export function markerStore<C extends string>(
  keyPrefix: string,
  isCommand: (value: unknown) => value is C,
): MarkerStore<C> {
  let accountClosing = false;
  const listeners = new Set<() => void>();
  const changed = (): void => {
    for (const listener of [...listeners]) listener();
  };

  function parse(raw: string): Stored<C> | null {
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
    if (typeof value !== 'object' || value === null) return null;
    const entry = value as Record<string, unknown>;
    const keys = Object.keys(entry).sort().join(',');
    if (
      keys !== 'command,correlationId,owner,savedAt,submissionId,v' ||
      entry.v !== VERSION ||
      !isCommand(entry.command) ||
      !tag(entry.submissionId) ||
      !SUBMISSION_ID.test(entry.submissionId) ||
      !(entry.correlationId === null || tag(entry.correlationId)) ||
      !tag(entry.owner) ||
      typeof entry.savedAt !== 'number' ||
      !Number.isFinite(entry.savedAt)
    ) {
      return null;
    }
    return {
      v: VERSION,
      command: entry.command,
      submissionId: entry.submissionId,
      correlationId: entry.correlationId,
      savedAt: entry.savedAt,
      owner: entry.owner,
    };
  }

  const parseEntry = (raw: string): Stored<C> | null => parse(raw);

  return {
    quarantine: quarantineOf(keyPrefix, parseEntry),

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    markOpen() {
      accountClosing = false;
    },

    // Markers hold nothing of what was sent: a logout only stops more being
    // written, and leaves every record — readable or not — where it is.
    purgeAll() {
      accountClosing = true;
      changed();
    },

    purgeForeign(tags) {
      try {
        const store = storage();
        if (!store) return;
        purgeForeign(store, keyPrefix, tags, parseEntry);
      } catch {
        // See above.
      }
    },

    save(scope, entry, binding, now = Date.now()) {
      if (accountClosing) return 'UNAVAILABLE';
      try {
        const store = storage();
        if (!store) return 'UNAVAILABLE';
        const found = locate(store, keyPrefix, binding, scope);
        const parsed = found === null ? null : parse(found.raw);
        const earlier =
          found !== null && parsed !== null && ownedHere(binding, found.legacy, parsed.owner)
            ? parsed
            : null;
        // A record from before records were kept per organization holds its
        // scope like any other — it may be another organization's, so it is
        // never taken over, even by the same submission.
        if (earlier !== null && (found?.legacy || earlier.submissionId !== entry.submissionId)) {
          return 'HELD';
        }
        // A fresh command waits while a quarantined record holds this kind for this person.
        if (earlier === null && !mayStartFresh(store, keyPrefix, binding, parseEntry))
          return 'HELD';
        const key = tenantKey(keyPrefix, binding, scope);
        // Never written over: whatever else the key holds is moved aside first.
        freeOwnKey(store, keyPrefix, key, binding, parseEntry);
        const record: Stored<C> = {
          v: VERSION,
          command: entry.command,
          submissionId: entry.submissionId,
          correlationId: entry.correlationId,
          // The entry dates from the first send.
          savedAt: earlier?.savedAt ?? now,
          owner: binding.owner,
        };
        store.setItem(key, JSON.stringify(record));
        changed();
        return 'SAVED';
      } catch {
        return 'UNAVAILABLE';
      }
    },

    clear(scope, submissionId, binding) {
      try {
        const store = storage();
        const found = store ? locate(store, keyPrefix, binding, scope) : null;
        if (!store || found === null) return;
        const entry = parse(found.raw);
        // Only this person's own record: anything that cannot be attributed stays (quarantined).
        if (
          entry?.submissionId !== submissionId ||
          !ownedHere(binding, found.legacy, entry.owner)
        ) {
          return;
        }
        store.removeItem(found.key);
      } catch {
        return;
      }
      changed();
    },

    restore(scope, binding) {
      try {
        const store = storage();
        const found = store ? locate(store, keyPrefix, binding, scope) : null;
        if (!store || found === null) return null;
        const entry = parse(found.raw);
        // Not this person's, or does not read: none here, and left as it is (quarantined).
        if (!entry || !ownedHere(binding, found.legacy, entry.owner)) return null;
        const { command, submissionId, correlationId, savedAt } = entry;
        return { command, submissionId, correlationId, savedAt };
      } catch {
        return null;
      }
    },
  };
}
