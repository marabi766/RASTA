import { z } from 'zod';

import type { RedisLike } from './refresh-coordinator';

/**
 * Where unresolved write requests live: the platform's Redis, or — only in
 * development and test, with no `WEB_REDIS_URL` — this process
 * (`unresolved-request.ts` chooses, and documents the whole design).
 *
 * Both stores implement the same small set of **atomic** operations, and one
 * spec runs against both (`unresolved-request.spec.ts`; the Redis half runs
 * wherever `WEB_TEST_REDIS_URL` is given, and is required in CI):
 *
 *   - `reserve`: one step does "is there a record for this scope", "is it
 *     in flight", "may the same request be sent again", the per-login capacity
 *     check, and writing the new state. Nothing is sent before it returns
 *     `RESERVED`.
 *   - `settle`: fenced by `(id, attemptId)`. A stale attempt changes nothing.
 *   - `release`: compare-and-delete by the record's `id`.
 *   - `purge`: a login's records and its capacity set.
 *
 * ## Redis keys (ADR-007: the organization is in the key; `noeviction` stays)
 *
 *   - `<prefix>:org:<organizationId>:pw:<sha256>` — one JSON record per scope.
 *   - `<prefix>:org:<organizationId>:pwl:<sha256>` — a sorted set per login,
 *     member = a record key, score = that record's absolute expiry. Counted and
 *     pruned in the same script that reserves, so two new scopes racing at the
 *     50th place cannot both pass.
 *
 * A record carries no request body, no token and no personal data: a key, a
 * keyed digest, two timestamps and the signed replay stamp the form needs.
 *
 * ## Persistence and memory (ADR-007)
 *
 * ADR-007 fixes `maxmemory-policy = noeviction` and says nothing about
 * persistence (it names "no persistence" as a reason Memcached was rejected,
 * not a configured AOF/RDB policy). So the **residual** is stated here: if
 * Redis loses its data (restart without persistence, failover to an empty
 * replica) the hold is lost and the next form is a fresh request. That window
 * is the same one every other Redis state of this portal has (the refresh
 * leases, the rate limits), and it needs an operator to lose the node. When
 * memory is full, `noeviction` makes the write fail: the reserve is refused,
 * the action sends **nothing**, and the person is told to try again — fail
 * closed. An existing record is never evicted.
 *
 * The scripts name several keys, which is correct on one node (ADR-007: a
 * single node in the MVP). On Redis Cluster the record and the login's set would
 * need a shared hash tag; that is a change to the key format, not to the logic.
 */

export const PENDING_KEY_PREFIX = 'rasta:web:ur';

/** Most pending records one login may hold. A new scope past it is refused before dispatch. */
export const MAX_PENDING_PER_LOGIN = 50;

/**
 * How long an in-flight (`RESERVED`) record is believed. A dispatch is bounded
 * (15 s gateway timeout plus the Redis calls); past this the process that held
 * it is gone or stuck, and it may have sent: the record becomes `UNRESOLVED`.
 */
export const INFLIGHT_LEASE_MS = 60_000;

/** A record outlives its deadline by this much, so the hold is still there to reconcile. */
export const RECORD_RETENTION_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

export class UnresolvedStoreUnavailable extends Error {
  constructor(cause?: unknown) {
    super('The pending-request store cannot be reached or read', { cause });
    this.name = 'UnresolvedStoreUnavailable';
  }
}

export const storedRecordSchema = z.object({
  v: z.literal(1),
  /** The generation of this record: what a release form names. */
  id: z.string().regex(/^[0-9a-f]{32}$/),
  /** Who holds the in-flight lease. */
  attemptId: z.string().regex(/^[0-9a-f]{32}$/),
  key: z.string().min(1).max(200),
  digest: z.string().min(1).max(100),
  issuedAt: z.number().int().nonnegative(),
  /** The signed replay stamp the form is rebuilt from. */
  ref: z.string().max(800).nullable(),
  /** Last instant the key may be sent again; null when the service has no limit. */
  deadline: z.number().int().nonnegative().nullish(),
  state: z.enum(['RESERVED', 'UNRESOLVED']),
  /** True once an attempt ended ambiguously: a refusal of a later retry then proves nothing. */
  wasUnresolved: z.boolean(),
  createdAt: z.number().int().nonnegative(),
  reservedAt: z.number().int().nonnegative(),
  /** The key's own binding, checked on read: a record found under a key it does not belong to is not trusted. */
  bind: z.string().regex(/^[0-9a-f]{64}$/),
});
export type StoredRecord = z.infer<typeof storedRecordSchema>;

export type HeldReason = 'IN_PROGRESS' | 'OTHER_REQUEST' | 'CHANGED_BODY' | 'RECONCILE_ONLY';

export type ReserveReply =
  | { readonly kind: 'RESERVED'; readonly record: StoredRecord; readonly retry: boolean }
  | { readonly kind: 'HELD'; readonly reason: HeldReason; readonly record: StoredRecord }
  | { readonly kind: 'EXPIRED'; readonly record: StoredRecord }
  | { readonly kind: 'CAPACITY' };

export interface ReserveInput {
  readonly recordKey: string;
  readonly setKey: string;
  readonly now: number;
  readonly cap: number;
  readonly leaseMs: number;
  /** May an unresolved record with this very key and body be sent again? */
  readonly retry: boolean;
  /** `issuedAt + windowMs` bounds a retry (the current configuration); null = no bound. */
  readonly windowMs: number | null;
  readonly key: string;
  readonly digest: string;
  readonly attemptId: string;
  /** What is created when there is no record. */
  readonly fresh: StoredRecord;
  /** Its absolute expiry (ms). */
  readonly expireAt: number;
}

/** `DONE` deletes; `UNRESOLVED` marks ambiguous; `REVERT` deletes a fresh record and re-opens one that was unresolved before. */
export type SettleMode = 'DONE' | 'UNRESOLVED' | 'REVERT';
export type SettleReply = 'DELETED' | 'UNRESOLVED' | 'STALE' | 'GONE';
export type ReleaseReply = 'RELEASED' | 'STALE' | 'GONE' | 'IN_PROGRESS';

export interface UnresolvedStore {
  reserve(input: ReserveInput): Promise<ReserveReply>;
  /** The record, or null when there is none. Throws `UnresolvedStoreUnavailable` when it cannot say. */
  read(recordKey: string, now: number): Promise<StoredRecord | null>;
  settle(
    recordKey: string,
    setKey: string,
    id: string,
    attemptId: string,
    mode: SettleMode,
  ): Promise<SettleReply>;
  release(
    recordKey: string,
    setKey: string,
    id: string,
    now: number,
    leaseMs: number,
  ): Promise<ReleaseReply>;
  purge(setKey: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Redis
// ---------------------------------------------------------------------------

const LUA_PRELUDE = `
local function load(raw)
  local ok, rec = pcall(cjson.decode, raw)
  if not ok or type(rec) ~= 'table' then return nil end
  return rec
end
`;

/**
 * KEYS: record, login set. ARGV: now, cap, lease, retry, key, digest, attemptId,
 * fresh record JSON, expireAt, windowMs (-1 = none).
 * Returns {kind, ...}.
 */
export const RESERVE_SCRIPT = `${LUA_PRELUDE}
local now = tonumber(ARGV[1])
local cap = tonumber(ARGV[2])
local lease = tonumber(ARGV[3])
local retry = ARGV[4] == '1'
local key, digest, attempt = ARGV[5], ARGV[6], ARGV[7]
local fresh = ARGV[8]
local expireAt = tonumber(ARGV[9])
local windowMs = tonumber(ARGV[10])

local raw = redis.call('GET', KEYS[1])
if not raw then
  redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now)
  if redis.call('ZCARD', KEYS[2]) >= cap then return {'CAPACITY'} end
  redis.call('SET', KEYS[1], fresh, 'PXAT', expireAt)
  redis.call('ZADD', KEYS[2], expireAt, KEYS[1])
  local top = redis.call('ZRANGE', KEYS[2], -1, -1, 'WITHSCORES')
  redis.call('PEXPIREAT', KEYS[2], top[2])
  return {'RESERVED', fresh, '0'}
end

local rec = load(raw)
if not rec then return {'CORRUPT'} end
local dirty = false
if rec.state == 'RESERVED' and now - rec.reservedAt > lease then
  rec.state = 'UNRESOLVED'
  rec.wasUnresolved = true
  dirty = true
end
local function save()
  local json = cjson.encode(rec)
  redis.call('SET', KEYS[1], json, 'KEEPTTL')
  return json
end

if rec.state == 'RESERVED' then
  return {'HELD', 'IN_PROGRESS', raw}
end

local reason = nil
if rec.key ~= key then reason = 'OTHER_REQUEST'
elseif rec.digest ~= digest then reason = 'CHANGED_BODY'
elseif not retry then reason = 'RECONCILE_ONLY' end
if reason then
  local json = raw
  if dirty then json = save() end
  return {'HELD', reason, json}
end

local d = rec.deadline
if d == cjson.null then d = nil end
if windowMs >= 0 then
  local bound = rec.issuedAt + windowMs
  if d == nil or bound < d then d = bound end
end
if d == nil then rec.deadline = cjson.null else rec.deadline = d end
if d ~= nil and now > d then
  return {'EXPIRED', save()}
end
rec.state = 'RESERVED'
rec.attemptId = attempt
rec.reservedAt = now
return {'RESERVED', save(), '1'}
`;

/** KEYS: record, login set. ARGV: id, attemptId, mode. */
export const SETTLE_SCRIPT = `${LUA_PRELUDE}
local raw = redis.call('GET', KEYS[1])
if not raw then return 'GONE' end
local rec = load(raw)
if not rec then return 'CORRUPT' end
if rec.id ~= ARGV[1] or rec.attemptId ~= ARGV[2] or rec.state ~= 'RESERVED' then return 'STALE' end
local mode = ARGV[3]
if mode == 'DONE' or (mode == 'REVERT' and not rec.wasUnresolved) then
  redis.call('DEL', KEYS[1])
  redis.call('ZREM', KEYS[2], KEYS[1])
  return 'DELETED'
end
rec.state = 'UNRESOLVED'
rec.wasUnresolved = true
redis.call('SET', KEYS[1], cjson.encode(rec), 'KEEPTTL')
return 'UNRESOLVED'
`;

/** KEYS: record, login set. ARGV: id, now, lease. */
export const RELEASE_SCRIPT = `${LUA_PRELUDE}
local raw = redis.call('GET', KEYS[1])
if not raw then return 'GONE' end
local rec = load(raw)
if not rec then return 'CORRUPT' end
if rec.id ~= ARGV[1] then return 'STALE' end
if rec.state == 'RESERVED' and tonumber(ARGV[2]) - rec.reservedAt <= tonumber(ARGV[3]) then
  return 'IN_PROGRESS'
end
redis.call('DEL', KEYS[1])
redis.call('ZREM', KEYS[2], KEYS[1])
return 'RELEASED'
`;

/** KEYS: login set. Deletes every record the set names, then the set. */
export const PURGE_SCRIPT = `
local members = redis.call('ZRANGE', KEYS[1], 0, -1)
for _, member in ipairs(members) do redis.call('DEL', member) end
redis.call('DEL', KEYS[1])
return #members
`;

function parseRecord(json: unknown): StoredRecord {
  try {
    if (typeof json !== 'string') throw new Error('not a string');
    return storedRecordSchema.parse(JSON.parse(json));
  } catch (error) {
    throw new UnresolvedStoreUnavailable(error);
  }
}

export function redisUnresolvedStore(redis: RedisLike): UnresolvedStore {
  const run = async (script: string, keys: string[], ...args: (string | number)[]) => {
    try {
      return await redis.eval(script, keys.length, ...keys, ...args.map(String));
    } catch (error) {
      throw new UnresolvedStoreUnavailable(error);
    }
  };

  return {
    async reserve(input) {
      const reply = await run(
        RESERVE_SCRIPT,
        [input.recordKey, input.setKey],
        input.now,
        input.cap,
        input.leaseMs,
        input.retry ? '1' : '0',
        input.key,
        input.digest,
        input.attemptId,
        JSON.stringify(input.fresh),
        input.expireAt,
        input.windowMs ?? -1,
      );
      if (!Array.isArray(reply) || typeof reply[0] !== 'string') {
        throw new UnresolvedStoreUnavailable(new Error('unreadable reserve reply'));
      }
      switch (reply[0]) {
        case 'CAPACITY':
          return { kind: 'CAPACITY' };
        case 'RESERVED':
          return { kind: 'RESERVED', record: parseRecord(reply[1]), retry: reply[2] === '1' };
        case 'EXPIRED':
          return { kind: 'EXPIRED', record: parseRecord(reply[1]) };
        case 'HELD':
          return {
            kind: 'HELD',
            reason: reply[1] as HeldReason,
            record: parseRecord(reply[2]),
          };
        default:
          // CORRUPT or anything unknown: never a reason to send.
          throw new UnresolvedStoreUnavailable(new Error(`reserve answered ${reply[0]}`));
      }
    },

    async read(recordKey) {
      let raw: string | null;
      try {
        raw = await redis.get(recordKey);
      } catch (error) {
        throw new UnresolvedStoreUnavailable(error);
      }
      return raw === null ? null : parseRecord(raw);
    },

    async settle(recordKey, setKey, id, attemptId, mode) {
      const reply = await run(SETTLE_SCRIPT, [recordKey, setKey], id, attemptId, mode);
      if (reply === 'DELETED' || reply === 'UNRESOLVED' || reply === 'STALE' || reply === 'GONE') {
        return reply;
      }
      throw new UnresolvedStoreUnavailable(new Error(`settle answered ${String(reply)}`));
    },

    async release(recordKey, setKey, id, now, leaseMs) {
      const reply = await run(RELEASE_SCRIPT, [recordKey, setKey], id, now, leaseMs);
      if (
        reply === 'RELEASED' ||
        reply === 'STALE' ||
        reply === 'GONE' ||
        reply === 'IN_PROGRESS'
      ) {
        return reply;
      }
      throw new UnresolvedStoreUnavailable(new Error(`release answered ${String(reply)}`));
    },

    async purge(setKey) {
      await run(PURGE_SCRIPT, [setKey]);
    },
  };
}

// ---------------------------------------------------------------------------
// This process (development and test only)
// ---------------------------------------------------------------------------

/**
 * The same operations over two maps. Used only when `WEB_REDIS_URL` is unset
 * and `NODE_ENV` is not `production` — one process, no other replica to agree
 * with. The shared spec holds it to the Redis behaviour.
 */
export function memoryUnresolvedStore(): UnresolvedStore {
  const records = new Map<string, { record: StoredRecord; expireAt: number }>();
  const sets = new Map<string, Map<string, number>>();

  const prune = (now: number) => {
    for (const [key, entry] of records) if (entry.expireAt <= now) records.delete(key);
    for (const [name, set] of sets) {
      for (const [member, expiry] of set) if (expiry <= now) set.delete(member);
      if (set.size === 0) sets.delete(name);
    }
  };

  const setOf = (name: string) => {
    let set = sets.get(name);
    if (!set) sets.set(name, (set = new Map()));
    return set;
  };

  return {
    async reserve(input) {
      const { recordKey, now } = input;
      prune(now);
      const entry = records.get(recordKey);
      if (!entry) {
        const set = setOf(input.setKey);
        if (set.size >= input.cap) return { kind: 'CAPACITY' };
        const record = { ...input.fresh };
        records.set(recordKey, { record, expireAt: input.expireAt });
        set.set(recordKey, input.expireAt);
        return { kind: 'RESERVED', record: { ...record }, retry: false };
      }

      const rec = entry.record;
      if (rec.state === 'RESERVED' && now - rec.reservedAt > input.leaseMs) {
        rec.state = 'UNRESOLVED';
        rec.wasUnresolved = true;
      }
      if (rec.state === 'RESERVED')
        return { kind: 'HELD', reason: 'IN_PROGRESS', record: { ...rec } };

      const reason: HeldReason | null =
        rec.key !== input.key
          ? 'OTHER_REQUEST'
          : rec.digest !== input.digest
            ? 'CHANGED_BODY'
            : !input.retry
              ? 'RECONCILE_ONLY'
              : null;
      if (reason) return { kind: 'HELD', reason, record: { ...rec } };

      let deadline: number | null = rec.deadline ?? null;
      if (input.windowMs !== null) {
        const bound = rec.issuedAt + input.windowMs;
        if (deadline === null || bound < deadline) deadline = bound;
      }
      rec.deadline = deadline;
      if (deadline !== null && now > deadline) return { kind: 'EXPIRED', record: { ...rec } };
      rec.state = 'RESERVED';
      rec.attemptId = input.attemptId;
      rec.reservedAt = now;
      return { kind: 'RESERVED', record: { ...rec }, retry: true };
    },

    async read(recordKey, now) {
      prune(now);
      const entry = records.get(recordKey);
      return entry ? { ...entry.record } : null;
    },

    async settle(recordKey, setKey, id, attemptId, mode) {
      const entry = records.get(recordKey);
      if (!entry) return 'GONE';
      const rec = entry.record;
      if (rec.id !== id || rec.attemptId !== attemptId || rec.state !== 'RESERVED') return 'STALE';
      if (mode === 'DONE' || (mode === 'REVERT' && !rec.wasUnresolved)) {
        records.delete(recordKey);
        sets.get(setKey)?.delete(recordKey);
        return 'DELETED';
      }
      rec.state = 'UNRESOLVED';
      rec.wasUnresolved = true;
      return 'UNRESOLVED';
    },

    async release(recordKey, setKey, id, now, leaseMs) {
      const entry = records.get(recordKey);
      if (!entry) return 'GONE';
      const rec = entry.record;
      if (rec.id !== id) return 'STALE';
      if (rec.state === 'RESERVED' && now - rec.reservedAt <= leaseMs) return 'IN_PROGRESS';
      records.delete(recordKey);
      sets.get(setKey)?.delete(recordKey);
      return 'RELEASED';
    },

    async purge(setKey) {
      for (const member of sets.get(setKey)?.keys() ?? []) records.delete(member);
      sets.delete(setKey);
    },
  };
}
