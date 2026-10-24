import { z } from 'zod';

import type { RedisLike } from './refresh-coordinator';
import {
  MAX_CLOCK_SKEW_MS,
  policyOf,
  purposePolicies,
  type PurposePolicy,
} from './unresolved-request-policy';

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
 *     in flight", "may the same request be sent again", "is the deadline still
 *     ahead", the per-login capacity check, and writing the new state. Nothing
 *     is sent before it returns `RESERVED`.
 *   - `read`: the record and the store's own time, in one step.
 *   - `settle`: fenced by `(id, attemptId)`. A stale attempt changes nothing.
 *   - `release`: compare-and-delete by the record's `id`.
 *   - `purge`: a login's records and its capacity set.
 *
 * ## Time: the store's clock decides (unresolved-request-policy.ts)
 *
 * Lease expiry, a reservation's age, release decisions, index pruning and TTLs
 * all use Redis `TIME` **inside the script**; no call carries a "now" for them,
 * so a replica whose clock is minutes off can neither release a live lease nor
 * keep a dead one. The in-process twin takes an injectable clock (development
 * and test only). The only app-clock instants are the signed stamp's
 * `issuedAt`/`deadline`; they are compared with the store's time as
 * `now + MAX_CLOCK_SKEW_MS ≤ deadline`, on the **fresh** path as well as every
 * retry, so skew shortens the window and never lengthens it. The inequality the
 * replay margin must satisfy, and why, is in `unresolved-request-policy.ts`.
 *
 * ## What a record must be (every script, before it changes anything)
 *
 * Every script decodes the existing record and checks, **before any write**:
 *   - its whole shape: exactly the known fields, no others and none missing;
 *     `state` is `RESERVED`/`UNRESOLVED`; ids are 32 hex, `bind` 64 hex; the
 *     timestamps are non-negative integers; `wasUnresolved` a boolean;
 *   - its binding: organization, login, purpose, target and scope key are the
 *     ones the key was derived from (`bind` covers the subject, login, purpose
 *     and target; `org`/`login`/`purpose`/`target` are stored beside it);
 *   - its purpose's rule (`unresolved-request-policy.ts`): `REQUIRED` means a
 *     finite numeric `deadline`, `NONE` the explicit string `"NONE"`; absence or
 *     `null` is never "no limit".
 * A record that fails is **CORRUPT**: it is returned as such, never rewritten,
 * never deleted, never released into a fresh key, never a reason to send. A
 * read of it is `UNAVAILABLE` ("cannot be checked now"). Purge validates every
 * indexed member before its first deletion and deletes **nothing** if any
 * member is corrupt or foreign: deletion is irreversible, a purge cannot tell
 * which member is at fault, and holds of a finished login are unreachable (their
 * keys name its csrf) and expire by themselves — so the safe answer is to leave
 * the whole index as it is and report "not purged".
 *
 * Rolling compatibility: records written by the first Redis version (`v: 1`)
 * have no `purpose`/`org`/`login`/`target`. They are read as the purpose of the
 * key being looked up — checked through `bind` — and only when they carry a
 * numeric deadline (they were all project creates); one without is CORRUPT.
 * New records are `v: 2`.
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
 * keyed digest, timestamps and the signed replay stamp the form needs.
 *
 * ## Persistence and memory (ADR-007)
 *
 * ADR-007 fixes `maxmemory-policy = noeviction` and says nothing about
 * persistence (it names "no persistence" as a reason Memcached was rejected,
 * not a configured AOF/RDB policy). So the **residual** is stated here: if
 * Redis loses its data (restart without persistence, failover to an empty
 * replica) the hold is lost and the next form is a fresh request. This is not
 * durable recovery. That window is the same one every other Redis state of
 * this portal has (the refresh leases, the rate limits), and it needs an
 * operator to lose the node. When memory is full, `noeviction` makes the write
 * fail: the reserve is refused, the action sends **nothing**, and the person is
 * told to try again — fail closed. An existing record is never evicted.
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

// ---------------------------------------------------------------------------
// The record, and what it must be bound to
// ---------------------------------------------------------------------------

const hex = (length: number) => z.string().regex(new RegExp(`^[0-9a-f]{${length}}$`));
const instant = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

const commonFields = {
  /** The generation of this record: what a release form names. */
  id: hex(32),
  /** Who holds the in-flight lease. */
  attemptId: hex(32),
  key: z.string().min(1).max(200),
  digest: z.string().min(1).max(100),
  issuedAt: instant,
  /** The signed replay stamp the form is rebuilt from. */
  ref: z.string().max(800).nullable(),
  state: z.enum(['RESERVED', 'UNRESOLVED']),
  /** True once an attempt ended ambiguously: a refusal of a later retry then proves nothing. */
  wasUnresolved: z.boolean(),
  createdAt: instant,
  reservedAt: instant,
  /** The key's own binding: sha256 of login, purpose and target. */
  bind: hex(64),
};

/** Current records. `deadline` is required: a finite instant, or `"NONE"` for a purpose that has none. */
const recordV2 = z.strictObject({
  v: z.literal(2),
  purpose: z.string().regex(/^[a-z0-9-]{1,40}$/),
  target: z.string().max(200),
  org: z.string().min(1).max(300),
  login: hex(64),
  deadline: z.union([instant, z.literal('NONE')]),
  ...commonFields,
});

/** Records of the first Redis version: only project creates existed, and every one had a deadline. */
const recordV1 = z.strictObject({
  v: z.literal(1),
  deadline: instant,
  ...commonFields,
});

export const storedRecordSchema = z.union([recordV2, recordV1]);
export type StoredRecord = z.infer<typeof storedRecordSchema>;

/** What a `reserve` creates: the store stamps `createdAt` and `reservedAt` with its own time. */
export type FreshRecord = Omit<z.infer<typeof recordV2>, 'createdAt' | 'reservedAt'>;

/** Everything a script verifies a record belongs to, and where it lives. */
export interface RecordBinding {
  readonly recordKey: string;
  readonly setKey: string;
  /** The organization as it appears in the keys (URI-encoded). */
  readonly org: string;
  /** sha256 of the login, as in the set key. */
  readonly login: string;
  readonly purpose: string;
  readonly target: string;
  readonly bind: string;
}

/** The last instant of a record, or null for the explicit "no limit". */
export function deadlineOf(record: StoredRecord): number | null {
  return record.deadline === 'NONE' ? null : record.deadline;
}

/**
 * The same checks the scripts make, for the in-process store and for what a
 * script returns: the record, or null when it is malformed or not `binding`'s.
 */
export function validateRecord(value: unknown, binding: RecordBinding): StoredRecord | null {
  const policy = policyOf(binding.purpose);
  if (!policy) return null;
  const parsed = storedRecordSchema.safeParse(value);
  if (!parsed.success) return null;
  const record = parsed.data;
  if (record.bind !== binding.bind) return null;
  if (record.v === 1) return policy.deadline === 'REQUIRED' ? record : null;
  if (
    record.purpose !== binding.purpose ||
    record.target !== binding.target ||
    record.org !== binding.org ||
    record.login !== binding.login
  ) {
    return null;
  }
  const numeric = typeof record.deadline === 'number';
  return numeric === (policy.deadline === 'REQUIRED') ? record : null;
}

/** Where a login's records live; the prefix every member of its set must have. */
export const recordKeyPrefix = (org: string) => `${PENDING_KEY_PREFIX}:org:${org}:pw:`;

export type HeldReason = 'IN_PROGRESS' | 'OTHER_REQUEST' | 'CHANGED_BODY' | 'RECONCILE_ONLY';

export type ReserveReply =
  | {
      readonly kind: 'RESERVED';
      readonly record: StoredRecord;
      readonly retry: boolean;
      readonly now: number;
    }
  | {
      readonly kind: 'HELD';
      readonly reason: HeldReason;
      readonly record: StoredRecord;
      readonly now: number;
    }
  /** Past the deadline (less the skew margin). `record` is null for a fresh request: nothing was written. */
  | { readonly kind: 'EXPIRED'; readonly record: StoredRecord | null; readonly now: number }
  | { readonly kind: 'CAPACITY' };

export interface ReserveInput {
  readonly binding: RecordBinding;
  readonly cap: number;
  readonly leaseMs: number;
  /** `issuedAt + windowMs` bounds a retry (the current configuration); null for a purpose without a deadline. */
  readonly windowMs: number | null;
  readonly key: string;
  readonly digest: string;
  readonly attemptId: string;
  /** What is created when there is no record. */
  readonly fresh: FreshRecord;
}

/** `DONE` deletes; `UNRESOLVED` marks ambiguous; `REVERT` deletes a fresh record and re-opens one that was unresolved before. */
export type SettleMode = 'DONE' | 'UNRESOLVED' | 'REVERT';
export type SettleReply = 'DELETED' | 'UNRESOLVED' | 'STALE' | 'GONE';
export type ReleaseReply = 'RELEASED' | 'STALE' | 'GONE' | 'IN_PROGRESS';

/** The login whose records `purge` removes. */
export interface PurgeScope {
  readonly setKey: string;
  readonly org: string;
  readonly login: string;
}

export interface UnresolvedStore {
  reserve(input: ReserveInput): Promise<ReserveReply>;
  /**
   * The record (or null when there is none) with the store's time. Throws
   * `UnresolvedStoreUnavailable` when it cannot say — a malformed or foreign
   * record included.
   */
  read(binding: RecordBinding): Promise<{ record: StoredRecord | null; now: number }>;
  settle(
    binding: RecordBinding,
    id: string,
    attemptId: string,
    mode: SettleMode,
  ): Promise<SettleReply>;
  release(binding: RecordBinding, id: string, leaseMs: number): Promise<ReleaseReply>;
  /** Deletes the login's records and set — or nothing, when any member is not valid. Returns whether it did. */
  purge(scope: PurgeScope): Promise<boolean>;
}

function needPolicy(purpose: string): PurposePolicy {
  const policy = policyOf(purpose);
  if (!policy) throw new UnresolvedStoreUnavailable(new Error('purpose not in the policy table'));
  return policy;
}

// ---------------------------------------------------------------------------
// Redis
// ---------------------------------------------------------------------------

/**
 * Shared by every script: the store's time, and the one validation of a record.
 * `validate(rec, c)` mirrors `validateRecord` above (the spec holds both to the
 * same cases). `c` = {org, login, purpose, target, bind, policies}; `purpose`,
 * `target` and `bind` are nil only in purge, where each record names its own.
 */
const LUA_PRELUDE = `
local PREFIX = '${PENDING_KEY_PREFIX}'

local function nowMs()
  local t = redis.call('TIME')
  return tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
end

local function decode(raw)
  local ok, rec = pcall(cjson.decode, raw)
  if not ok or type(rec) ~= 'table' then return nil end
  return rec
end

local function isInt(x)
  return type(x) == 'number' and x >= 0 and x == math.floor(x) and x <= 9007199254740991
end
local function isStr(x, min, max) return type(x) == 'string' and #x >= min and #x <= max end
local function isHex(x, n) return type(x) == 'string' and #x == n and string.find(x, '^[0-9a-f]+$') ~= nil end

local ALLOWED = {
  v = true, id = true, attemptId = true, key = true, digest = true, issuedAt = true, ref = true,
  deadline = true, state = true, wasUnresolved = true, createdAt = true, reservedAt = true,
  bind = true, purpose = true, target = true, org = true, login = true,
}
local LEGACY = { retry = true, deadline = 'REQUIRED' }

local function validate(rec, c)
  if type(rec) ~= 'table' then return false end
  for k, _ in pairs(rec) do if ALLOWED[k] ~= true then return false end end
  local policy
  if rec.v == 1 and c.purpose == nil then policy = LEGACY
  else
    local purpose = c.purpose
    if purpose == nil and rec.v == 2 then purpose = rec.purpose end
    if type(purpose) ~= 'string' then return false end
    policy = c.policies[purpose]
  end
  if type(policy) ~= 'table' then return false end
  if policy.retry == true and policy.deadline ~= 'REQUIRED' then return false end
  if not isHex(rec.id, 32) or not isHex(rec.attemptId, 32) or not isHex(rec.bind, 64) then return false end
  if c.bind ~= nil and rec.bind ~= c.bind then return false end
  if not isStr(rec.key, 1, 200) or not isStr(rec.digest, 1, 100) then return false end
  if not isInt(rec.issuedAt) or not isInt(rec.createdAt) or not isInt(rec.reservedAt) then return false end
  if rec.ref ~= cjson.null and not isStr(rec.ref, 0, 800) then return false end
  if rec.state ~= 'RESERVED' and rec.state ~= 'UNRESOLVED' then return false end
  if type(rec.wasUnresolved) ~= 'boolean' then return false end
  if rec.v == 1 then
    if rec.purpose ~= nil or rec.target ~= nil or rec.org ~= nil or rec.login ~= nil then return false end
    if policy.deadline ~= 'REQUIRED' or not isInt(rec.deadline) then return false end
  elseif rec.v == 2 then
    if not isStr(rec.purpose, 1, 40) or not isStr(rec.target, 0, 200) then return false end
    if rec.org ~= c.org or rec.login ~= c.login then return false end
    if c.purpose ~= nil and rec.purpose ~= c.purpose then return false end
    if c.target ~= nil and rec.target ~= c.target then return false end
    if policy.deadline == 'REQUIRED' then
      if not isInt(rec.deadline) then return false end
    elseif rec.deadline ~= 'NONE' then return false end
  else
    return false
  end
  return true
end

local function context()
  local policies = decode(ARGV[6])
  if policies == nil then return nil end
  return { org = ARGV[1], login = ARGV[2], purpose = ARGV[3], target = ARGV[4], bind = ARGV[5], policies = policies }
end

local function keysMatch(c)
  return KEYS[1] == PREFIX .. ':org:' .. c.org .. ':pw:' .. c.bind
    and KEYS[2] == PREFIX .. ':org:' .. c.org .. ':pwl:' .. c.login
end

local function stamp(now) return string.format('%.0f', now) end
`;

/**
 * KEYS: record, login set. ARGV: org, login, purpose, target, bind, policies JSON,
 * cap, lease, key, digest, attemptId, fresh record JSON, windowMs (-1 = none),
 * retention, skew. No clock comes in: `TIME` is read here.
 * Returns {kind, ...}; every kind but CAPACITY ends with the store's time.
 */
export const RESERVE_SCRIPT = `${LUA_PRELUDE}
local c = context()
if c == nil or not keysMatch(c) then return {'INVALID'} end
local policy = c.policies[c.purpose]
if type(policy) ~= 'table' or (policy.retry == true and policy.deadline ~= 'REQUIRED') then return {'INVALID'} end
local retry = policy.retry == true
local cap, lease = tonumber(ARGV[7]), tonumber(ARGV[8])
local key, digest, attempt = ARGV[9], ARGV[10], ARGV[11]
local windowMs, retention, skew = tonumber(ARGV[13]), tonumber(ARGV[14]), tonumber(ARGV[15])
local now = nowMs()

local raw = redis.call('GET', KEYS[1])
if not raw then
  local fresh = decode(ARGV[12])
  if fresh == nil then return {'INVALID'} end
  fresh.createdAt = now
  fresh.reservedAt = now
  if not validate(fresh, c) or fresh.state ~= 'RESERVED' or fresh.wasUnresolved ~= false
    or fresh.attemptId ~= attempt or fresh.key ~= key or fresh.digest ~= digest then
    return {'INVALID'}
  end
  if policy.deadline == 'REQUIRED' and now + skew > fresh.deadline then
    return {'EXPIRED', '', stamp(now)}
  end
  redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now)
  if redis.call('ZCARD', KEYS[2]) >= cap then return {'CAPACITY'} end
  local base = now
  if policy.deadline == 'REQUIRED' then base = fresh.deadline end
  local expireAt = base + retention
  local json = cjson.encode(fresh)
  redis.call('SET', KEYS[1], json, 'PXAT', expireAt)
  redis.call('ZADD', KEYS[2], expireAt, KEYS[1])
  local top = redis.call('ZRANGE', KEYS[2], -1, -1, 'WITHSCORES')
  redis.call('PEXPIREAT', KEYS[2], top[2])
  return {'RESERVED', json, '0', stamp(now)}
end

-- An existing record is validated BEFORE anything is changed; a bad one is
-- never rewritten and never a reason to send.
local rec = decode(raw)
if rec == nil or not validate(rec, c) then return {'CORRUPT'} end
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
  return {'HELD', 'IN_PROGRESS', raw, stamp(now)}
end

local reason = nil
if rec.key ~= key then reason = 'OTHER_REQUEST'
elseif rec.digest ~= digest then reason = 'CHANGED_BODY'
elseif not retry then reason = 'RECONCILE_ONLY' end
if reason then
  local json = raw
  if dirty then json = save() end
  return {'HELD', reason, json, stamp(now)}
end

-- The deadline is the earlier of the stored one and the current window; the
-- stored one is validated above, never rebuilt. The check is against the
-- store's time, less the skew budget.
if policy.deadline == 'REQUIRED' then
  local d = rec.deadline
  if windowMs >= 0 then
    local bound = rec.issuedAt + windowMs
    if bound < d then d = bound end
  end
  rec.deadline = d
  if now + skew > d then
    return {'EXPIRED', save(), stamp(now)}
  end
end
rec.state = 'RESERVED'
rec.attemptId = attempt
rec.reservedAt = now
return {'RESERVED', save(), '1', stamp(now)}
`;

/** KEYS: record, login set. ARGV: org, login, purpose, target, bind, policies. Returns {'NONE'|'OK'|'CORRUPT', raw, now}. */
export const READ_SCRIPT = `${LUA_PRELUDE}
local c = context()
if c == nil or not keysMatch(c) then return {'CORRUPT'} end
local now = nowMs()
local raw = redis.call('GET', KEYS[1])
if not raw then return {'NONE', '', stamp(now)} end
local rec = decode(raw)
if rec == nil or not validate(rec, c) then return {'CORRUPT'} end
return {'OK', raw, stamp(now)}
`;

/** KEYS: record, login set. ARGV: org, login, purpose, target, bind, policies, id, attemptId, mode. */
export const SETTLE_SCRIPT = `${LUA_PRELUDE}
local c = context()
if c == nil or not keysMatch(c) then return 'CORRUPT' end
local raw = redis.call('GET', KEYS[1])
if not raw then return 'GONE' end
local rec = decode(raw)
if rec == nil or not validate(rec, c) then return 'CORRUPT' end
if rec.id ~= ARGV[7] or rec.attemptId ~= ARGV[8] or rec.state ~= 'RESERVED' then return 'STALE' end
local mode = ARGV[9]
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

/** KEYS: record, login set. ARGV: org, login, purpose, target, bind, policies, id, lease. */
export const RELEASE_SCRIPT = `${LUA_PRELUDE}
local c = context()
if c == nil or not keysMatch(c) then return 'CORRUPT' end
local raw = redis.call('GET', KEYS[1])
if not raw then return 'GONE' end
local rec = decode(raw)
if rec == nil or not validate(rec, c) then return 'CORRUPT' end
if rec.id ~= ARGV[7] then return 'STALE' end
if rec.state == 'RESERVED' and nowMs() - rec.reservedAt <= tonumber(ARGV[8]) then
  return 'IN_PROGRESS'
end
redis.call('DEL', KEYS[1])
redis.call('ZREM', KEYS[2], KEYS[1])
return 'RELEASED'
`;

/**
 * KEYS: login set. ARGV: org, login, policies JSON. Validates EVERY indexed
 * member first; deletes the records and the set only when all are this login's
 * and well-formed (a member whose record is already gone is fine). Otherwise
 * deletes nothing: {'CORRUPT', n}.
 */
export const PURGE_SCRIPT = `${LUA_PRELUDE}
local c = { org = ARGV[1], login = ARGV[2], policies = decode(ARGV[3]) }
if c.policies == nil then return {'CORRUPT', 0} end
if KEYS[1] ~= PREFIX .. ':org:' .. c.org .. ':pwl:' .. c.login then return {'CORRUPT', 0} end
local prefix = PREFIX .. ':org:' .. c.org .. ':pw:'
local members = redis.call('ZRANGE', KEYS[1], 0, -1)
for _, member in ipairs(members) do
  if string.sub(member, 1, #prefix) ~= prefix then return {'CORRUPT', #members} end
  local raw = redis.call('GET', member)
  if raw then
    local rec = decode(raw)
    if rec == nil or not validate(rec, c) or member ~= prefix .. rec.bind then
      return {'CORRUPT', #members}
    end
  end
end
for _, member in ipairs(members) do redis.call('DEL', member) end
redis.call('DEL', KEYS[1])
return {'PURGED', #members}
`;

function parseRecord(json: unknown, binding: RecordBinding): StoredRecord {
  try {
    if (typeof json !== 'string') throw new Error('not a string');
    const record = validateRecord(JSON.parse(json), binding);
    if (!record) throw new Error('malformed or foreign record');
    return record;
  } catch (error) {
    throw new UnresolvedStoreUnavailable(error);
  }
}

function serverTime(value: unknown): number {
  const now = Number(value);
  if (typeof value !== 'string' || !Number.isSafeInteger(now) || now < 0) {
    throw new UnresolvedStoreUnavailable(new Error('unreadable store time'));
  }
  return now;
}

/** The ARGV every scoped script starts with: org, login, purpose, target, bind, policies. */
const scopeArgs = (binding: RecordBinding): string[] => [
  binding.org,
  binding.login,
  binding.purpose,
  binding.target,
  binding.bind,
  JSON.stringify(purposePolicies()),
];

export function redisUnresolvedStore(redis: RedisLike): UnresolvedStore {
  const run = async (script: string, keys: string[], ...args: (string | number)[]) => {
    try {
      return await redis.eval(script, keys.length, ...keys, ...args.map(String));
    } catch (error) {
      throw new UnresolvedStoreUnavailable(error);
    }
  };
  const keysOf = (binding: RecordBinding) => [binding.recordKey, binding.setKey];

  return {
    async reserve(input) {
      const { binding } = input;
      needPolicy(binding.purpose);
      const reply = await run(
        RESERVE_SCRIPT,
        keysOf(binding),
        ...scopeArgs(binding),
        input.cap,
        input.leaseMs,
        input.key,
        input.digest,
        input.attemptId,
        JSON.stringify(input.fresh),
        input.windowMs ?? -1,
        RECORD_RETENTION_AFTER_MS,
        MAX_CLOCK_SKEW_MS,
      );
      if (!Array.isArray(reply) || typeof reply[0] !== 'string') {
        throw new UnresolvedStoreUnavailable(new Error('unreadable reserve reply'));
      }
      switch (reply[0]) {
        case 'CAPACITY':
          return { kind: 'CAPACITY' };
        case 'RESERVED':
          return {
            kind: 'RESERVED',
            record: parseRecord(reply[1], binding),
            retry: reply[2] === '1',
            now: serverTime(reply[3]),
          };
        case 'EXPIRED':
          return {
            kind: 'EXPIRED',
            // A fresh request past its deadline writes nothing.
            record: reply[1] === '' ? null : parseRecord(reply[1], binding),
            now: serverTime(reply[2]),
          };
        case 'HELD':
          if (
            reply[1] !== 'IN_PROGRESS' &&
            reply[1] !== 'OTHER_REQUEST' &&
            reply[1] !== 'CHANGED_BODY' &&
            reply[1] !== 'RECONCILE_ONLY'
          ) {
            throw new UnresolvedStoreUnavailable(new Error('unknown held reason'));
          }
          return {
            kind: 'HELD',
            reason: reply[1],
            record: parseRecord(reply[2], binding),
            now: serverTime(reply[3]),
          };
        default:
          // CORRUPT, INVALID or anything unknown: never a reason to send.
          throw new UnresolvedStoreUnavailable(new Error(`reserve answered ${reply[0]}`));
      }
    },

    async read(binding) {
      needPolicy(binding.purpose);
      const reply = await run(READ_SCRIPT, keysOf(binding), ...scopeArgs(binding));
      if (!Array.isArray(reply)) {
        throw new UnresolvedStoreUnavailable(new Error('unreadable read reply'));
      }
      if (reply[0] === 'NONE') return { record: null, now: serverTime(reply[2]) };
      if (reply[0] === 'OK') {
        return { record: parseRecord(reply[1], binding), now: serverTime(reply[2]) };
      }
      throw new UnresolvedStoreUnavailable(new Error(`read answered ${String(reply[0])}`));
    },

    async settle(binding, id, attemptId, mode) {
      needPolicy(binding.purpose);
      const reply = await run(
        SETTLE_SCRIPT,
        keysOf(binding),
        ...scopeArgs(binding),
        id,
        attemptId,
        mode,
      );
      if (reply === 'DELETED' || reply === 'UNRESOLVED' || reply === 'STALE' || reply === 'GONE') {
        return reply;
      }
      throw new UnresolvedStoreUnavailable(new Error(`settle answered ${String(reply)}`));
    },

    async release(binding, id, leaseMs) {
      needPolicy(binding.purpose);
      const reply = await run(RELEASE_SCRIPT, keysOf(binding), ...scopeArgs(binding), id, leaseMs);
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

    async purge(scope) {
      const reply = await run(
        PURGE_SCRIPT,
        [scope.setKey],
        scope.org,
        scope.login,
        JSON.stringify(purposePolicies()),
      );
      if (Array.isArray(reply) && reply[0] === 'PURGED') return true;
      if (Array.isArray(reply) && reply[0] === 'CORRUPT') return false;
      throw new UnresolvedStoreUnavailable(new Error('unreadable purge reply'));
    },
  };
}

// ---------------------------------------------------------------------------
// This process (development and test only)
// ---------------------------------------------------------------------------

/** What the in-process twin exposes beyond the store: the stored bytes, for tests that tamper with them. */
export interface MemoryUnresolvedStore extends UnresolvedStore {
  /** The stored JSON of every record, by key. */
  readonly records: Map<string, string>;
  /** The index sets (member → absolute expiry), by set key. */
  readonly sets: Map<string, Map<string, number>>;
}

/**
 * The same operations over two maps of **strings** (so a test can corrupt a
 * record exactly as it could in Redis), validated by the same rules. Used only
 * when `WEB_REDIS_URL` is unset and `NODE_ENV` is not `production` — one process,
 * no other replica to agree with. `clock` is its time source (injectable; the
 * shared spec holds it to the Redis behaviour, where the server's `TIME` is used).
 */
export function memoryUnresolvedStore(clock: () => number = Date.now): MemoryUnresolvedStore {
  const records = new Map<string, string>();
  const expiries = new Map<string, number>();
  const sets = new Map<string, Map<string, number>>();

  const prune = (now: number) => {
    for (const [key, expireAt] of expiries) {
      if (expireAt <= now) {
        records.delete(key);
        expiries.delete(key);
      }
    }
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

  const load = (binding: RecordBinding): StoredRecord | null | 'CORRUPT' => {
    const raw = records.get(binding.recordKey);
    if (raw === undefined) return null;
    try {
      return validateRecord(JSON.parse(raw), binding) ?? 'CORRUPT';
    } catch {
      return 'CORRUPT';
    }
  };
  const keysMatch = (b: RecordBinding) =>
    b.recordKey === `${recordKeyPrefix(b.org)}${b.bind}` &&
    b.setKey === `${PENDING_KEY_PREFIX}:org:${b.org}:pwl:${b.login}`;
  const save = (binding: RecordBinding, record: StoredRecord) => {
    const json = JSON.stringify(record);
    records.set(binding.recordKey, json);
    return json;
  };

  return {
    records,
    sets,

    async reserve(input) {
      const { binding } = input;
      const policy = needPolicy(binding.purpose);
      if (!keysMatch(binding)) throw new UnresolvedStoreUnavailable(new Error('keys'));
      const now = clock();
      prune(now);
      const existing = load(binding);

      if (existing === null) {
        const fresh = validateRecord({ ...input.fresh, createdAt: now, reservedAt: now }, binding);
        if (
          !fresh ||
          fresh.state !== 'RESERVED' ||
          fresh.wasUnresolved ||
          fresh.attemptId !== input.attemptId ||
          fresh.key !== input.key ||
          fresh.digest !== input.digest
        ) {
          throw new UnresolvedStoreUnavailable(new Error('invalid fresh record'));
        }
        if (
          policy.deadline === 'REQUIRED' &&
          now + MAX_CLOCK_SKEW_MS > (fresh.deadline as number)
        ) {
          return { kind: 'EXPIRED', record: null, now };
        }
        const set = setOf(binding.setKey);
        if (set.size >= input.cap) return { kind: 'CAPACITY' };
        const expireAt =
          (policy.deadline === 'REQUIRED' ? (fresh.deadline as number) : now) +
          RECORD_RETENTION_AFTER_MS;
        save(binding, fresh);
        expiries.set(binding.recordKey, expireAt);
        set.set(binding.recordKey, expireAt);
        return { kind: 'RESERVED', record: { ...fresh }, retry: false, now };
      }
      if (existing === 'CORRUPT') throw new UnresolvedStoreUnavailable(new Error('CORRUPT'));

      const rec: StoredRecord = { ...existing };
      let dirty = false;
      if (rec.state === 'RESERVED' && now - rec.reservedAt > input.leaseMs) {
        rec.state = 'UNRESOLVED';
        rec.wasUnresolved = true;
        dirty = true;
      }
      if (rec.state === 'RESERVED') {
        return { kind: 'HELD', reason: 'IN_PROGRESS', record: { ...rec }, now };
      }

      const reason: HeldReason | null =
        rec.key !== input.key
          ? 'OTHER_REQUEST'
          : rec.digest !== input.digest
            ? 'CHANGED_BODY'
            : !policy.retry
              ? 'RECONCILE_ONLY'
              : null;
      if (reason) {
        if (dirty) save(binding, rec);
        return { kind: 'HELD', reason, record: { ...rec }, now };
      }

      if (policy.deadline === 'REQUIRED') {
        let deadline = rec.deadline as number;
        if (input.windowMs !== null) deadline = Math.min(deadline, rec.issuedAt + input.windowMs);
        rec.deadline = deadline;
        if (now + MAX_CLOCK_SKEW_MS > deadline) {
          save(binding, rec);
          return { kind: 'EXPIRED', record: { ...rec }, now };
        }
      }
      rec.state = 'RESERVED';
      rec.attemptId = input.attemptId;
      rec.reservedAt = now;
      save(binding, rec);
      return { kind: 'RESERVED', record: { ...rec }, retry: true, now };
    },

    async read(binding) {
      needPolicy(binding.purpose);
      if (!keysMatch(binding)) throw new UnresolvedStoreUnavailable(new Error('keys'));
      const now = clock();
      prune(now);
      const existing = load(binding);
      if (existing === 'CORRUPT') throw new UnresolvedStoreUnavailable(new Error('CORRUPT'));
      return { record: existing ? { ...existing } : null, now };
    },

    async settle(binding, id, attemptId, mode) {
      needPolicy(binding.purpose);
      if (!keysMatch(binding)) throw new UnresolvedStoreUnavailable(new Error('keys'));
      const existing = load(binding);
      if (existing === null) return 'GONE';
      if (existing === 'CORRUPT') throw new UnresolvedStoreUnavailable(new Error('CORRUPT'));
      const rec: StoredRecord = { ...existing };
      if (rec.id !== id || rec.attemptId !== attemptId || rec.state !== 'RESERVED') return 'STALE';
      if (mode === 'DONE' || (mode === 'REVERT' && !rec.wasUnresolved)) {
        records.delete(binding.recordKey);
        expiries.delete(binding.recordKey);
        sets.get(binding.setKey)?.delete(binding.recordKey);
        return 'DELETED';
      }
      rec.state = 'UNRESOLVED';
      rec.wasUnresolved = true;
      save(binding, rec);
      return 'UNRESOLVED';
    },

    async release(binding, id, leaseMs) {
      needPolicy(binding.purpose);
      if (!keysMatch(binding)) throw new UnresolvedStoreUnavailable(new Error('keys'));
      const existing = load(binding);
      if (existing === null) return 'GONE';
      if (existing === 'CORRUPT') throw new UnresolvedStoreUnavailable(new Error('CORRUPT'));
      if (existing.id !== id) return 'STALE';
      if (existing.state === 'RESERVED' && clock() - existing.reservedAt <= leaseMs) {
        return 'IN_PROGRESS';
      }
      records.delete(binding.recordKey);
      expiries.delete(binding.recordKey);
      sets.get(binding.setKey)?.delete(binding.recordKey);
      return 'RELEASED';
    },

    async purge(scope) {
      if (scope.setKey !== `${PENDING_KEY_PREFIX}:org:${scope.org}:pwl:${scope.login}`) {
        return false;
      }
      const prefix = recordKeyPrefix(scope.org);
      const members = [...(sets.get(scope.setKey)?.keys() ?? [])];
      for (const member of members) {
        const raw = records.get(member);
        if (!member.startsWith(prefix)) return false;
        if (raw === undefined) continue;
        let valid = false;
        try {
          const parsed = storedRecordSchema.safeParse(JSON.parse(raw));
          if (parsed.success) {
            const rec = parsed.data;
            const policy: PurposePolicy | null =
              rec.v === 2 ? policyOf(rec.purpose) : { retry: true, deadline: 'REQUIRED' };
            valid =
              policy !== null &&
              member === `${prefix}${rec.bind}` &&
              (rec.v === 1 ||
                (rec.org === scope.org &&
                  rec.login === scope.login &&
                  (typeof rec.deadline === 'number') === (policy.deadline === 'REQUIRED')));
          }
        } catch {
          valid = false;
        }
        if (!valid) return false;
      }
      for (const member of members) {
        records.delete(member);
        expiries.delete(member);
      }
      sets.delete(scope.setKey);
      return true;
    },
  };
}
