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
 * it belongs to. A page for another person drops every entry of anyone else; a
 * logout writes nothing more and leaves the markers.
 */

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
 * `SAVED`: stored. `HELD`: another submission's record holds this scope — it
 * is left exactly as it was, and this one must not be sent. `UNAVAILABLE`:
 * storage refused it, or a logout has started.
 */
export type SaveOutcome = 'SAVED' | 'HELD' | 'UNAVAILABLE';

export interface MarkerStore<C extends string> {
  subscribe(listener: () => void): () => void;
  markOpen(): void;
  purgeAll(): void;
  purgeForeign(owner: string): void;
  save(
    scope: string,
    entry: Omit<UnresolvedMarker<C>, 'savedAt'>,
    owner: string,
    now?: number,
  ): SaveOutcome;
  clear(scope: string, submissionId: string): void;
  restore(scope: string, owner: string): UnresolvedMarker<C> | null;
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
  const keyOf = (scope: string): string => `${keyPrefix}${scope}`;

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

  function ownKeys(store: Storage): string[] {
    const keys: string[] = [];
    for (let index = 0; index < store.length; index += 1) {
      const key = store.key(index);
      if (key !== null && key.startsWith(keyPrefix)) keys.push(key);
    }
    return keys;
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    markOpen() {
      accountClosing = false;
    },

    purgeAll() {
      accountClosing = true;
      try {
        const store = storage();
        if (!store) return;
        for (const key of ownKeys(store)) {
          const raw = store.getItem(key);
          if (raw === null || parse(raw) === null) store.removeItem(key);
        }
      } catch {
        // Unavailable storage holds nothing to purge.
      }
      changed();
    },

    purgeForeign(owner) {
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
    },

    save(scope, entry, owner, now = Date.now()) {
      if (accountClosing) return 'UNAVAILABLE';
      try {
        const store = storage();
        if (!store) return 'UNAVAILABLE';
        const previous = store.getItem(keyOf(scope));
        const parsed = previous === null ? null : parse(previous);
        const earlier = parsed?.owner === owner ? parsed : null;
        if (earlier !== null && earlier.submissionId !== entry.submissionId) return 'HELD';
        const record: Stored<C> = {
          v: VERSION,
          command: entry.command,
          submissionId: entry.submissionId,
          correlationId: entry.correlationId,
          // The entry dates from the first send.
          savedAt: earlier?.savedAt ?? now,
          owner,
        };
        store.setItem(keyOf(scope), JSON.stringify(record));
        changed();
        return 'SAVED';
      } catch {
        return 'UNAVAILABLE';
      }
    },

    clear(scope, submissionId) {
      try {
        const store = storage();
        const raw = store?.getItem(keyOf(scope));
        if (!store || raw === null || raw === undefined) return;
        if (parse(raw)?.submissionId !== submissionId) return;
        store.removeItem(keyOf(scope));
      } catch {
        return;
      }
      changed();
    },

    restore(scope, owner) {
      try {
        const store = storage();
        const raw = store?.getItem(keyOf(scope));
        if (!store || raw === null || raw === undefined) return null;
        const entry = parse(raw);
        if (!entry || entry.owner !== owner) {
          store.removeItem(keyOf(scope));
          return null;
        }
        const { command, submissionId, correlationId, savedAt } = entry;
        return { command, submissionId, correlationId, savedAt };
      } catch {
        return null;
      }
    },
  };
}
