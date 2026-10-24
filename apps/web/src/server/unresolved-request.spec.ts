/**
 * @jest-environment node
 */
import Redis from 'ioredis';

import type { RedisLike } from './refresh-coordinator';
import type { WebSession } from './session';
import {
  INFLIGHT_LEASE_MS,
  MAX_PENDING_PER_LOGIN,
  memoryUnresolvedStore,
  PENDING_KEY_PREFIX,
  RECORD_RETENTION_AFTER_MS,
  redisUnresolvedStore,
  UnresolvedStoreUnavailable,
  type MemoryUnresolvedStore,
  type StoredRecord,
  type UnresolvedStore,
} from './unresolved-request-store';
import { MAX_CLOCK_SKEW_MS } from './unresolved-request-policy';

/**
 * The retention of an unresolved write request: what it keeps, for whom, and what
 * it never holds. One suite, two stores — this process and a real Redis (where
 * the Lua itself runs). CI sets `WEB_TEST_REDIS_REQUIRED=true` in a job with a
 * Redis service, so there the real run cannot be skipped by accident
 * (`refresh-coordinator.spec.ts` is the model).
 *
 * Time. The store's own clock decides (Redis `TIME` in the scripts; an injected
 * clock in the twin). Tests speak in a *virtual* time `t0 + x`; against Redis,
 * `advance(ms)` ages every stored record by `ms` (the clock of a real Redis
 * cannot be moved) and the store handed to the module translates the stamp's
 * app-clock instants the same way, so one suite reads the same on both.
 */

Object.assign(process.env, {
  API_GATEWAY_URL: 'http://gateway.test:3000',
  OIDC_ISSUER_URL: 'http://keycloak.test/realms/rasta',
  OIDC_CLIENT_ID: 'rasta-web',
  WEB_PUBLIC_ORIGIN: 'http://localhost:3200',
  WEB_SESSION_SECRET: 'a-secret-that-is-long-enough-to-be-a-key',
});

// The purpose table (the real one has `project-create` only) plus the rows the
// cases below need: other purposes that resend, one with no deadline, and one that
// breaks the table's own rule (a resending purpose without a deadline).
jest.mock('./unresolved-request-policy', () => {
  const actual = jest.requireActual('./unresolved-request-policy');
  const resending = { retry: true, deadline: 'REQUIRED' };
  const table = {
    ...actual.purposePolicies(),
    filler: resending,
    racer: resending,
    z: resending,
    other: resending,
    'supplier-write': resending,
    'no-limit': { retry: false, deadline: 'NONE' },
    'bad-resend': { retry: true, deadline: 'NONE' },
  };
  const policyOf = (purpose: string) => {
    const policy = Object.hasOwn(table, purpose) ? table[purpose as keyof typeof table] : undefined;
    if (!policy) return null;
    if (policy.retry && policy.deadline !== 'REQUIRED') return null;
    return policy;
  };
  return { ...actual, purposePolicies: () => table, policyOf };
});

/* eslint-disable @typescript-eslint/no-require-imports */
const {
  mayResend,
  purgeUnresolved,
  readUnresolved,
  releaseToken,
  releaseUnresolved,
  requestDigest,
  reserveUnresolved,
  settleUnresolved,
  useUnresolvedStore,
} = require('./unresolved-request') as typeof import('./unresolved-request');
/* eslint-enable @typescript-eslint/no-require-imports */

const realRedisUrl = process.env.WEB_TEST_REDIS_URL;
if (process.env.WEB_TEST_REDIS_REQUIRED === 'true' && !realRedisUrl) {
  throw new Error('WEB_TEST_REDIS_REQUIRED is set but WEB_TEST_REDIS_URL is not');
}

const MEMORY_T0 = 1_900_000_000_000;
const SECOND = 1_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const SCOPE: { purpose: string; target?: string } = { purpose: 'project-create' };
const NO_LIMIT = { purpose: 'no-limit' };
const WIN = 50 * MINUTE;

/** A login of its own per test, so tests never see each other's records on a shared Redis. */
let counter = 0;
const uniq = `${process.pid}-${Date.now()}`;
function login(overrides: Partial<WebSession> = {}): WebSession {
  counter += 1;
  return {
    subject: `USR_${uniq}_${counter}`,
    username: 'owner',
    organizationId: `ORG_${uniq}_${counter}`,
    accessToken: 'access-token-value',
    accessTokenExpiresAt: 2_000_000_000,
    refreshToken: 'refresh-token-value',
    csrfToken: `csrf-${counter}`,
    issuedAt: 1_900_000_000,
    ...overrides,
  };
}

type Scope = { purpose: string; target?: string };
type ReserveExtra = Partial<Parameters<typeof reserveUnresolved>[2]>;

interface Backend {
  /** What the module under test uses. */
  readonly store: UnresolvedStore;
  /** The virtual instant the test starts at. */
  t0(): number;
  /** The virtual instant now (`t0` plus every advance). */
  now(): number;
  /** Moves the store's clock on by `ms`. */
  advance(ms: number): Promise<void>;
  recordKeys(session: WebSession): Promise<string[]>;
  getRaw(key: string): Promise<string | null>;
  setRaw(key: string, raw: string): Promise<void>;
  members(setKey: string): Promise<string[]>;
  addMember(setKey: string, member: string): Promise<void>;
  setKeys(session: WebSession): Promise<string[]>;
  reset(): Promise<void>;
  close(): Promise<void>;
}

function memoryBackend(): Backend {
  let now = MEMORY_T0;
  const memory: MemoryUnresolvedStore = memoryUnresolvedStore(() => now);
  const orgOf = (s: WebSession) => encodeURIComponent(s.organizationId ?? 'none');
  return {
    store: memory,
    t0: () => MEMORY_T0,
    now: () => now,
    advance: async (ms) => void (now += ms),
    recordKeys: async (s) =>
      [...memory.records.keys()].filter((k) =>
        k.startsWith(`${PENDING_KEY_PREFIX}:org:${orgOf(s)}:pw:`),
      ),
    getRaw: async (key) => memory.records.get(key) ?? null,
    setRaw: async (key, raw) => void memory.records.set(key, raw),
    members: async (setKey) => [...(memory.sets.get(setKey)?.keys() ?? [])],
    addMember: async (setKey, member) => {
      const set = memory.sets.get(setKey) ?? new Map<string, number>();
      set.set(member, now + RECORD_RETENTION_AFTER_MS);
      memory.sets.set(setKey, set);
    },
    setKeys: async (s) =>
      [...memory.sets.keys()].filter((k) =>
        k.startsWith(`${PENDING_KEY_PREFIX}:org:${orgOf(s)}:pwl:`),
      ),
    reset: async () => {
      now = MEMORY_T0;
      memory.records.clear();
      memory.sets.clear();
    },
    close: async () => undefined,
  };
}

const TIME_FIELDS = ['issuedAt', 'createdAt', 'reservedAt'] as const;

function redisBackend(url: string): Backend {
  const redis = new Redis(url, { maxRetriesPerRequest: 1, commandTimeout: 2_000 });
  const real = redisUnresolvedStore(redis as unknown as RedisLike);
  /** Virtual = real + shift; moved on by `advance`. */
  let shift = 0;
  let start = 0;
  const redisNow = async () => {
    const [sec, usec] = await redis.time();
    return Number(sec) * 1000 + Math.floor(Number(usec) / 1000);
  };
  const up = (record: StoredRecord): StoredRecord => {
    const copy = { ...record } as Record<string, unknown>;
    for (const f of TIME_FIELDS)
      if (typeof copy[f] === 'number') copy[f] = (copy[f] as number) + shift;
    if (typeof copy.deadline === 'number') copy.deadline += shift;
    return copy as StoredRecord;
  };
  // The module hands the store stamp instants on the app's (virtual) clock; Redis
  // judges them against its real one, so they go down by the shift, and what comes
  // back goes up by it.
  const store: UnresolvedStore = {
    reserve: async (input) => {
      const fresh = {
        ...input.fresh,
        issuedAt: input.fresh.issuedAt - shift,
        deadline:
          typeof input.fresh.deadline === 'number'
            ? input.fresh.deadline - shift
            : input.fresh.deadline,
      };
      const reply = await real.reserve({ ...input, fresh });
      if (reply.kind === 'CAPACITY') return reply;
      return {
        ...reply,
        record: reply.record ? up(reply.record) : null,
        now: reply.now + shift,
      } as never;
    },
    read: async (binding) => {
      const { record, now } = await real.read(binding);
      return { record: record ? up(record) : null, now: now + shift };
    },
    settle: (...args) => real.settle(...args),
    release: (...args) => real.release(...args),
    purge: (...args) => real.purge(...args),
  };
  const mine = `${PENDING_KEY_PREFIX}:org:ORG_${uniq}_*`;
  return {
    store,
    t0: () => start,
    now: () => start + shift,
    advance: async (ms) => {
      shift += ms;
      for (const key of await redis.keys(`${mine}:pw:*`)) {
        const raw = await redis.get(key);
        if (!raw) continue;
        let rec: Record<string, unknown>;
        try {
          const parsed: unknown = JSON.parse(raw);
          // A record another test made corrupt on purpose is left as it is.
          if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
          rec = parsed as Record<string, unknown>;
        } catch {
          continue;
        }
        for (const f of TIME_FIELDS)
          if (typeof rec[f] === 'number') rec[f] = (rec[f] as number) - ms;
        if (typeof rec.deadline === 'number') rec.deadline -= ms;
        const expireAt = await redis.pexpiretime(key);
        await redis.set(key, JSON.stringify(rec), 'PXAT', expireAt - ms);
      }
      for (const key of await redis.keys(`${mine}:pwl:*`)) {
        const expireAt = await redis.pexpiretime(key);
        const entries = await redis.zrange(key, 0, -1, 'WITHSCORES');
        const args: (string | number)[] = [];
        for (let n = 0; n < entries.length; n += 2)
          args.push(Number(entries[n + 1]) - ms, entries[n]!);
        await redis.del(key);
        if (args.length > 0) await redis.zadd(key, ...(args as [number, string]));
        if (args.length > 0) await redis.pexpireat(key, expireAt - ms);
      }
    },
    recordKeys: async (s) =>
      redis.keys(
        `${PENDING_KEY_PREFIX}:org:${encodeURIComponent(s.organizationId ?? 'none')}:pw:*`,
      ),
    getRaw: (key) => redis.get(key),
    setRaw: async (key, raw) => void (await redis.set(key, raw, 'KEEPTTL')),
    members: (setKey) => redis.zrange(setKey, 0, -1),
    addMember: async (setKey, member) => void (await redis.zadd(setKey, Date.now() + HOUR, member)),
    setKeys: async (s) =>
      redis.keys(
        `${PENDING_KEY_PREFIX}:org:${encodeURIComponent(s.organizationId ?? 'none')}:pwl:*`,
      ),
    reset: async () => {
      shift = 0;
      start = await redisNow();
    },
    close: async () => void (await redis.quit()),
  };
}

const backends: [string, () => Backend][] = [['this process', memoryBackend]];
if (realRedisUrl) backends.push(['a real Redis', () => redisBackend(realRedisUrl)]);

/** What a stored record is changed into, to test a script's refusal. `null` leaves it to a raw string. */
type Corruption = [name: string, make: (rec: Record<string, unknown>) => string];
const json = (mutate: (rec: Record<string, unknown>) => void) => (rec: Record<string, unknown>) => {
  mutate(rec);
  return JSON.stringify(rec);
};
const otherHex = (n: number) => 'e'.repeat(n);
const CORRUPTIONS: Corruption[] = [
  ['a missing deadline', json((r) => delete r.deadline)],
  ['a null deadline on a retry=true purpose', json((r) => (r.deadline = null))],
  ['the NONE marker on a retry=true purpose', json((r) => (r.deadline = 'NONE'))],
  ['a deadline that is a string', json((r) => (r.deadline = '1900000000000'))],
  ['a negative deadline', json((r) => (r.deadline = -1))],
  ['a fractional deadline', json((r) => (r.deadline = 1.5))],
  ['a deadline that is an object', json((r) => (r.deadline = {}))],
  ['an unknown state', json((r) => (r.state = 'BOGUS'))],
  ['a missing state', json((r) => delete r.state)],
  ['a lower-case-only violation in the id', json((r) => (r.id = 'A'.repeat(32)))],
  ['a short attemptId', json((r) => (r.attemptId = 'a'.repeat(31)))],
  ['a missing id', json((r) => delete r.id)],
  ['a missing attemptId', json((r) => delete r.attemptId)],
  ['an extra field', json((r) => (r.surprise = 1))],
  ['a missing key field', json((r) => delete r.key)],
  ['a numeric key', json((r) => (r.key = 7))],
  ['a string issuedAt', json((r) => (r.issuedAt = '1'))],
  ['a negative reservedAt', json((r) => (r.reservedAt = -5))],
  ['a missing createdAt', json((r) => delete r.createdAt)],
  ['a wasUnresolved that is a string', json((r) => (r.wasUnresolved = 'true'))],
  ['a ref that is a number', json((r) => (r.ref = 5))],
  ['a missing ref', json((r) => delete r.ref)],
  ['a bind of another scope (well-shaped)', json((r) => (r.bind = otherHex(64)))],
  ['another organization (well-shaped)', json((r) => (r.org = 'ORG_SOMEONE_ELSE'))],
  ['another login (well-shaped)', json((r) => (r.login = otherHex(64)))],
  ['another purpose (well-shaped)', json((r) => (r.purpose = 'other'))],
  ['another target (well-shaped)', json((r) => (r.target = 'T-other'))],
  ['an unknown version', json((r) => (r.v = 3))],
  ['a purpose that is not in the table', json((r) => (r.purpose = 'not-a-purpose'))],
  ['text that is not JSON', () => '{not json'],
  ['a JSON array', () => '[]'],
  ['a JSON string', () => '"x"'],
  ['null', () => 'null'],
];

describe.each(backends)('an unresolved request held by %s', (_name, make) => {
  const backend = make();
  beforeEach(async () => {
    await backend.reset();
    useUnresolvedStore(backend.store);
  });
  afterAll(async () => {
    useUnresolvedStore(undefined);
    await backend.close();
  });

  const T = () => backend.t0();
  const stamp = (key: string, extra: ReserveExtra = {}) => ({
    key,
    digest: `digest-of-${key}`,
    ref: `stamp-of-${key}`,
    issuedAt: T(),
    deadline: T() + WIN,
    windowMs: WIN,
    ...extra,
  });
  const reserve = (
    session: WebSession,
    key = 'sub_1',
    extra: ReserveExtra = {},
    scope: Scope = SCOPE,
  ) => reserveUnresolved(session, scope, stamp(key, extra));
  const reserveNoLimit = (session: WebSession, key = 'sub_1', extra: ReserveExtra = {}) =>
    reserveUnresolved(session, NO_LIMIT, stamp(key, { deadline: null, windowMs: null, ...extra }));

  async function held(session: WebSession, scope: Scope = SCOPE) {
    const read = await readUnresolved(session, scope);
    return read.kind === 'PENDING' ? read.request : read.kind;
  }

  async function reserved(session: WebSession, key = 'sub_1', extra: ReserveExtra = {}) {
    const out = await reserve(session, key, extra);
    if (out.kind !== 'RESERVED') throw new Error(`expected RESERVED, got ${out.kind}`);
    return out;
  }

  async function onlyRecord(session: WebSession) {
    const keys = await backend.recordKeys(session);
    expect(keys).toHaveLength(1);
    return { key: keys[0]!, raw: (await backend.getRaw(keys[0]!))! };
  }

  describe('reserving before the dispatch', () => {
    it('creates an in-flight record that the page can read at once (no response needed)', async () => {
      const s = login();
      expect(await readUnresolved(s, SCOPE)).toEqual({ kind: 'NONE' });
      await reserved(s);
      expect(await held(s)).toMatchObject({
        key: 'sub_1',
        ref: 'stamp-of-sub_1',
        deadline: T() + WIN,
        inFlight: true,
      });
    });

    it('keeps the record after an ambiguous end — which is all a lost response needs', async () => {
      const s = login();
      const { attempt } = await reserved(s);
      await settleUnresolved(attempt, 'UNRESOLVED');
      await backend.advance(10 * MINUTE);
      expect(await held(s)).toMatchObject({ key: 'sub_1', inFlight: false });
    });

    it('lets exactly one of several concurrent attempts through, even with the same key', async () => {
      const s = login();
      const outcomes = await Promise.all([1, 2, 3, 4, 5].map(() => reserve(s, 'sub_same')));
      expect(outcomes.filter((o) => o.kind === 'RESERVED')).toHaveLength(1);
      for (const o of outcomes.filter((o) => o.kind !== 'RESERVED')) {
        expect(o).toMatchObject({ kind: 'HELD', reason: 'IN_PROGRESS' });
      }
    });

    it('two tabs with K1 and K2: only one is reserved, the other is held', async () => {
      const s = login();
      const [a, b] = await Promise.all([reserve(s, 'K1'), reserve(s, 'K2')]);
      expect([a.kind, b.kind].sort()).toEqual(['HELD', 'RESERVED']);
    });

    it('holds back another key and another body once the first is unresolved', async () => {
      const s = login();
      const { attempt } = await reserved(s);
      await settleUnresolved(attempt, 'UNRESOLVED');
      expect(await reserve(s, 'sub_2')).toMatchObject({ kind: 'HELD', reason: 'OTHER_REQUEST' });
      expect(await reserve(s, 'sub_1', { digest: 'another' })).toMatchObject({
        kind: 'HELD',
        reason: 'CHANGED_BODY',
      });
    });

    it('sends the same key and body again only when the purpose’s row allows it', async () => {
      const s = login();
      const first = await reserveNoLimit(s);
      if (first.kind !== 'RESERVED') throw new Error(first.kind);
      await settleUnresolved(first.attempt, 'UNRESOLVED');
      // `no-limit` is `retry: false`: reconcile only, whatever the caller would like.
      expect(await reserveNoLimit(s)).toMatchObject({ kind: 'HELD', reason: 'RECONCILE_ONLY' });

      const t = login();
      const { attempt } = await reserved(t);
      await settleUnresolved(attempt, 'UNRESOLVED');
      expect(await reserve(t)).toMatchObject({ kind: 'RESERVED', retry: true });
    });

    it('turns an in-flight record the process abandoned into an unresolved one after the lease', async () => {
      const s = login();
      await reserved(s);
      await backend.advance(INFLIGHT_LEASE_MS - 5 * SECOND);
      expect(await reserve(s, 'sub_1')).toMatchObject({ kind: 'HELD', reason: 'IN_PROGRESS' });
      // Past the lease it may have sent: unresolved, so the same request can retry…
      await backend.advance(10 * SECOND);
      expect(await held(s)).toMatchObject({ inFlight: false });
      expect(await reserve(s, 'sub_2')).toMatchObject({ kind: 'HELD', reason: 'OTHER_REQUEST' });
      expect(await reserve(s, 'sub_1')).toMatchObject({ kind: 'RESERVED', retry: true });
    });

    it('refuses a purpose that is not in the table, and one that breaks its rule, before any write', async () => {
      const s = login();
      expect(await reserve(s, 'sub_1', {}, { purpose: 'not-in-the-table' })).toEqual({
        kind: 'UNAVAILABLE',
      });
      expect(await reserve(s, 'sub_1', {}, { purpose: 'bad-resend' })).toEqual({
        kind: 'UNAVAILABLE',
      });
      // The caller's numbers must fit the row: a deadline for a NONE purpose, none for a REQUIRED one.
      expect(await reserve(s, 'sub_1', {}, NO_LIMIT)).toEqual({ kind: 'UNAVAILABLE' });
      expect(await reserve(s, 'sub_1', { deadline: null, windowMs: null })).toEqual({
        kind: 'UNAVAILABLE',
      });
      expect(await reserve(s, 'sub_1', { windowMs: null })).toEqual({ kind: 'UNAVAILABLE' });
      expect(await backend.recordKeys(s)).toEqual([]);
      expect(await held(s, { purpose: 'not-in-the-table' })).toBe('UNAVAILABLE');
    });
  });

  describe('settling after the dispatch, fenced by the attempt', () => {
    it('a confirmed success deletes the record', async () => {
      const s = login();
      const { attempt } = await reserved(s);
      expect(await settleUnresolved(attempt, 'CONFIRMED')).toBe(true);
      expect(await readUnresolved(s, SCOPE)).toEqual({ kind: 'NONE' });
    });

    it.each(['REFUSED', 'NEVER_SENT'] as const)(
      'a %s end deletes a record this attempt created',
      async (outcome) => {
        const s = login();
        const { attempt } = await reserved(s);
        await settleUnresolved(attempt, outcome);
        expect(await readUnresolved(s, SCOPE)).toEqual({ kind: 'NONE' });
      },
    );

    it.each(['REFUSED', 'NEVER_SENT'] as const)(
      'a %s end of a RETRY keeps the earlier unresolved record',
      async (outcome) => {
        const s = login();
        const first = await reserved(s);
        await settleUnresolved(first.attempt, 'UNRESOLVED');
        const retry = await reserved(s, 'sub_1');
        await settleUnresolved(retry.attempt, outcome);
        expect(await held(s)).toMatchObject({ key: 'sub_1', inFlight: false });
        // …and it is still the only request that may go out.
        expect(await reserve(s, 'sub_2')).toMatchObject({ kind: 'HELD' });
      },
    );

    it('a confirmed retry deletes it', async () => {
      const s = login();
      const first = await reserved(s);
      await settleUnresolved(first.attempt, 'UNRESOLVED');
      const retry = await reserved(s, 'sub_1');
      await settleUnresolved(retry.attempt, 'CONFIRMED');
      expect(await readUnresolved(s, SCOPE)).toEqual({ kind: 'NONE' });
    });

    it('a stale attempt changes nothing — not a delete, not an update', async () => {
      const s = login();
      const first = await reserved(s);
      await settleUnresolved(first.attempt, 'UNRESOLVED');
      const retry = await reserved(s, 'sub_1');
      // The first attempt, long over, settles again.
      expect(await settleUnresolved(first.attempt, 'CONFIRMED')).toBe(false);
      expect(await settleUnresolved(first.attempt, 'REFUSED')).toBe(false);
      expect(await settleUnresolved(first.attempt, 'UNRESOLVED')).toBe(false);
      expect(await held(s)).toMatchObject({ key: 'sub_1', inFlight: true });
      await settleUnresolved(retry.attempt, 'CONFIRMED');
    });

    it('K1 confirmed late does not delete the record K2 made after a release', async () => {
      const s = login();
      const k1 = await reserved(s, 'K1');
      await settleUnresolved(k1.attempt, 'UNRESOLVED');
      const request = await held(s);
      if (typeof request === 'string') throw new Error(request);
      expect(await releaseUnresolved(s, SCOPE, releaseToken(s, SCOPE, request))).toBe('RELEASED');
      const k2 = await reserved(s, 'K2');
      expect(await settleUnresolved(k1.attempt, 'CONFIRMED')).toBe(false);
      expect(await held(s)).toMatchObject({ key: 'K2', inFlight: true });
      await settleUnresolved(k2.attempt, 'UNRESOLVED');
      expect(await held(s)).toMatchObject({ key: 'K2' });
    });
  });

  describe('the deadline only shrinks, and is checked on the store’s clock', () => {
    it('is not extended by raising the window: issue at 2 h, lower to 1 h, send, raise to 2 h', async () => {
      const s = login();
      // Stamp issued at minute 0 under a two-hour window (deadline 110 min).
      // Lowered to one hour before the first dispatch: the record's deadline is 60.
      await backend.advance(10 * MINUTE);
      const first = await reserved(s, 'sub_1', {
        issuedAt: T(),
        deadline: Math.min(T() + 110 * MINUTE, T() + HOUR),
        windowMs: HOUR,
      });
      await settleUnresolved(first.attempt, 'UNRESOLVED');
      // Raised back to two hours; at minute 75 the original stamp still says OK.
      await backend.advance(65 * MINUTE);
      const out = await reserve(s, 'sub_1', {
        issuedAt: T(),
        deadline: T() + 110 * MINUTE,
        windowMs: 2 * HOUR,
      });
      expect(out).toMatchObject({ kind: 'EXPIRED' });
      // Not sent, and kept.
      expect(await held(s)).toMatchObject({ key: 'sub_1', deadline: T() + HOUR });
    });

    it('a retry is bounded by the window as configured now, and keeps the shorter value', async () => {
      const s = login();
      const first = await reserved(s, 'sub_1', { deadline: T() + 2 * HOUR, windowMs: 2 * HOUR });
      await settleUnresolved(first.attempt, 'UNRESOLVED');
      // Configuration lowered to 30 minutes: minute 40 is past it.
      await backend.advance(40 * MINUTE);
      expect(await reserve(s, 'sub_1', { windowMs: 30 * MINUTE })).toMatchObject({
        kind: 'EXPIRED',
      });
      expect(await held(s)).toMatchObject({ deadline: T() + 30 * MINUTE });
      // Raised again: the stored, shorter deadline stands.
      expect(await reserve(s, 'sub_1', { windowMs: 2 * HOUR })).toMatchObject({
        kind: 'EXPIRED',
      });
    });

    it('stops one skew budget BEFORE the deadline, on a retry: a skew can only shorten the window', async () => {
      const s = login();
      const first = await reserved(s);
      await settleUnresolved(first.attempt, 'UNRESOLVED');
      const request = (await held(s)) as { deadline: number };
      // 25 s before the deadline is inside the margin; 35 s before it is not.
      await backend.advance(WIN - 35 * SECOND);
      const inside = await reserve(s, 'sub_1');
      expect(inside.kind).toBe('RESERVED');
      if (inside.kind === 'RESERVED') await settleUnresolved(inside.attempt, 'UNRESOLVED');
      await backend.advance(10 * SECOND);
      expect((await reserve(s, 'sub_1')).kind).toBe('EXPIRED');
      const read = await readUnresolved(s, SCOPE);
      if (read.kind !== 'PENDING') throw new Error(read.kind);
      // The page applies the same margin to the store's own time.
      expect(mayResend(read.request, request.deadline - MAX_CLOCK_SKEW_MS)).toBe(true);
      expect(mayResend(read.request, request.deadline - MAX_CLOCK_SKEW_MS + 1)).toBe(false);
      expect(mayResend(read.request, read.now)).toBe(false);
    });

    it('checks the deadline on the FIRST send too, atomically: a stamp that ran out after the action’s check is refused, nothing written', async () => {
      const s = login();
      // Inside the margin (10 s left < 30 s): refused, and nothing is kept — it was never sent.
      const late = await reserve(s, 'sub_1', { deadline: T() + 10 * SECOND });
      expect(late).toEqual({ kind: 'EXPIRED', request: null });
      expect(await backend.recordKeys(s)).toEqual([]);
      expect(await backend.setKeys(s)).toEqual([]);
      expect(await readUnresolved(s, SCOPE)).toEqual({ kind: 'NONE' });
      // Outside it (40 s left): reserved.
      expect((await reserve(s, 'sub_1', { deadline: T() + 40 * SECOND })).kind).toBe('RESERVED');
    });

    it('has no deadline for a purpose whose row says NONE, stored as the explicit marker', async () => {
      const s = login();
      const first = await reserveNoLimit(s);
      if (first.kind !== 'RESERVED') throw new Error(first.kind);
      await settleUnresolved(first.attempt, 'UNRESOLVED');
      await backend.advance(10 * 24 * HOUR);
      const request = await held(s, NO_LIMIT);
      expect(request).toMatchObject({ deadline: null });
      expect(mayResend(request as never, 9e15)).toBe(true);
      const key = (await backend.recordKeys(s))[0]!;
      expect(JSON.parse((await backend.getRaw(key))!)).toMatchObject({ deadline: 'NONE', v: 2 });
    });
  });

  describe('time comes from the store, not from the replica', () => {
    /** Runs `fn` as a replica whose clock is `offset` ms from true time. */
    async function asReplica<T>(offset: number, fn: () => Promise<T>): Promise<T> {
      const real = Date.now;
      jest.spyOn(Date, 'now').mockImplementation(() => real() + offset);
      try {
        return await fn();
      } finally {
        jest.restoreAllMocks();
      }
    }

    it('replicas 61 s ahead and 61 s behind neither release the live lease nor get a second key', async () => {
      const s = login();
      // Replica A dispatches K1 and the dispatch stays blocked (no settle yet).
      const a = await reserved(s, 'K1');
      for (const offset of [61 * SECOND, -61 * SECOND]) {
        await asReplica(offset, async () => {
          const read = await readUnresolved(s, SCOPE);
          if (read.kind !== 'PENDING') throw new Error(read.kind);
          // The read's in-flight flag and the lease age are the store's.
          expect(read.request.inFlight).toBe(true);
          const token = releaseToken(s, SCOPE, read.request);
          expect(await releaseUnresolved(s, SCOPE, token)).toBe('IN_PROGRESS');
          expect(await reserve(s, 'K2')).toMatchObject({ kind: 'HELD', reason: 'IN_PROGRESS' });
          expect(await reserve(s, 'K1')).toMatchObject({ kind: 'HELD', reason: 'IN_PROGRESS' });
        });
      }
      // One record, still K1, still A's.
      const { raw } = await onlyRecord(s);
      expect(JSON.parse(raw)).toMatchObject({
        key: 'K1',
        attemptId: a.attempt.attemptId,
        state: 'RESERVED',
      });

      // A's late, ambiguous settle lands on its own record.
      expect(await settleUnresolved(a.attempt, 'UNRESOLVED')).toBe(true);
      // Then B (ahead) releases it knowingly and K2 goes out; A's even later "confirmed"
      // is fenced and cannot delete K2.
      const k2 = await asReplica(61 * SECOND, async () => {
        const read = await readUnresolved(s, SCOPE);
        if (read.kind !== 'PENDING') throw new Error(read.kind);
        expect(read.request.inFlight).toBe(false);
        expect(await releaseUnresolved(s, SCOPE, releaseToken(s, SCOPE, read.request))).toBe(
          'RELEASED',
        );
        return reserved(s, 'K2');
      });
      expect(await settleUnresolved(a.attempt, 'CONFIRMED')).toBe(false);
      expect(await held(s)).toMatchObject({ key: 'K2', inFlight: true });
      expect(await settleUnresolved(k2.attempt, 'UNRESOLVED')).toBe(true);
    });

    it('a lease that really ran out is released whatever the replica’s clock says', async () => {
      const s = login();
      await reserved(s, 'K1');
      await backend.advance(INFLIGHT_LEASE_MS + 5 * SECOND);
      await asReplica(-61 * SECOND, async () => {
        const read = await readUnresolved(s, SCOPE);
        if (read.kind !== 'PENDING') throw new Error(read.kind);
        expect(read.request.inFlight).toBe(false);
        expect(await releaseUnresolved(s, SCOPE, releaseToken(s, SCOPE, read.request))).toBe(
          'RELEASED',
        );
      });
    });
  });

  describe('a record that is not valid is corrupt: never rewritten, never sent, never free', () => {
    /** An unresolved record and what the page would have drawn for it. */
    async function unresolvedRecord(s: WebSession) {
      const first = await reserved(s);
      await settleUnresolved(first.attempt, 'UNRESOLVED');
      const request = (await held(s)) as { id: string };
      const { key, raw } = await onlyRecord(s);
      return { first, request: request as never, key, raw };
    }

    it.each(CORRUPTIONS)(
      '%s: read is UNAVAILABLE, reserve is refused, release does nothing — bytes unchanged',
      async (_n, corrupt) => {
        const s = login();
        const { request, key, raw } = await unresolvedRecord(s);
        const bytes = corrupt(JSON.parse(raw));
        await backend.setRaw(key, bytes);
        const index = await backend.members((await backend.setKeys(s))[0]!);

        expect(await readUnresolved(s, SCOPE)).toEqual({ kind: 'UNAVAILABLE' });
        // Same key and body (a retry), another key, another body: none is a reason to send.
        expect(await reserve(s, 'sub_1')).toEqual({ kind: 'UNAVAILABLE' });
        expect(await reserve(s, 'sub_2')).toEqual({ kind: 'UNAVAILABLE' });
        expect(await reserve(s, 'sub_1', { digest: 'another' })).toEqual({ kind: 'UNAVAILABLE' });
        // A stale release form (generation, CSRF and the box were all fine) still cannot delete it.
        expect(await releaseUnresolved(s, SCOPE, releaseToken(s, SCOPE, request))).toBe(
          'UNAVAILABLE',
        );
        expect(await backend.getRaw(key)).toBe(bytes);
        expect(await backend.recordKeys(s)).toEqual([key]);
        expect(await backend.members((await backend.setKeys(s))[0]!)).toEqual(index);
      },
    );

    it.each(CORRUPTIONS)(
      '%s: settling an in-flight attempt does not touch it',
      async (_n, corrupt) => {
        const s = login();
        const out = await reserved(s);
        const { key, raw } = await onlyRecord(s);
        const bytes = corrupt(JSON.parse(raw));
        await backend.setRaw(key, bytes);
        for (const outcome of ['CONFIRMED', 'REFUSED', 'NEVER_SENT', 'UNRESOLVED'] as const) {
          expect(await settleUnresolved(out.attempt, outcome)).toBe(false);
          expect(await backend.getRaw(key)).toBe(bytes);
        }
        expect(await backend.members((await backend.setKeys(s))[0]!)).toEqual([key]);
      },
    );

    it('a lease that ran out is not turned UNRESOLVED on a corrupt record either', async () => {
      const s = login();
      await reserved(s);
      const { key, raw } = await onlyRecord(s);
      const bytes = JSON.stringify({ ...JSON.parse(raw), surprise: true });
      await backend.setRaw(key, bytes);
      await backend.advance(INFLIGHT_LEASE_MS + SECOND);
      // (Against Redis the harness itself ages the stored times; compare from here.)
      const aged = await backend.getRaw(key);
      expect(await reserve(s, 'sub_1')).toEqual({ kind: 'UNAVAILABLE' });
      expect(await backend.getRaw(key)).toBe(aged);
      expect(JSON.parse(aged!)).toMatchObject({ state: 'RESERVED', surprise: true });
    });

    it('the reviewer’s scenario: window 110 → 50, dispatched at minute 10, the deadline lost, window raised, retry at minute 75', async () => {
      const s = login();
      // Stamp issued at minute 0 under a 110-minute window; the window is lowered to
      // 50 minutes and the first dispatch is at minute 10: effective deadline 50.
      const t = T();
      await backend.advance(10 * MINUTE);
      const first = await reserved(s, 'sub_1', {
        issuedAt: t,
        deadline: Math.min(t + 110 * MINUTE, t + 50 * MINUTE),
        windowMs: 50 * MINUTE,
      });
      await settleUnresolved(first.attempt, 'UNRESOLVED');
      // The stored record loses its `deadline` field.
      const { key, raw } = await onlyRecord(s);
      const rec = JSON.parse(raw);
      delete rec.deadline;
      const bytes = JSON.stringify(rec);
      await backend.setRaw(key, bytes);
      // The backend key (50 + 20 margin) is gone by minute 70; the window is raised
      // back to 110 and the retry at minute 75 still passes the stamp.
      await backend.advance(65 * MINUTE);
      const aged = await backend.getRaw(key);
      expect(JSON.parse(aged!)).not.toHaveProperty('deadline');
      expect(await readUnresolved(s, SCOPE)).toEqual({ kind: 'UNAVAILABLE' });
      const retry = await reserve(s, 'sub_1', {
        issuedAt: t,
        deadline: t + 110 * MINUTE,
        windowMs: 110 * MINUTE,
      });
      expect(retry).toEqual({ kind: 'UNAVAILABLE' });
      // Nothing was rebuilt, nothing was sent, nothing was written.
      expect(await backend.getRaw(key)).toBe(aged);
    });
  });

  describe('records written by the first Redis version (r4 shape, no purpose)', () => {
    const r4 = (key: string, over: Record<string, unknown> = {}) => ({
      v: 1,
      id: 'c'.repeat(32),
      attemptId: 'd'.repeat(32),
      key: 'sub_1',
      digest: 'digest-of-sub_1',
      issuedAt: T(),
      ref: 'stamp-of-sub_1',
      deadline: T() + WIN,
      state: 'UNRESOLVED',
      wasUnresolved: true,
      createdAt: T(),
      reservedAt: T(),
      bind: key.slice(key.lastIndexOf(':') + 1),
      ...over,
    });
    /** Plants `record` under the key the project-create scope of `s` uses (by reserving, then replacing). */
    async function plant(s: WebSession, make: (key: string) => unknown) {
      const first = await reserved(s);
      await settleUnresolved(first.attempt, 'UNRESOLVED');
      const { key } = await onlyRecord(s);
      // Redis stores real-time values; translate the virtual ones the helper wrote.
      const bytes = JSON.stringify(make(key));
      await backend.setRaw(key, bytes);
      return { key, bytes };
    }

    it('a valid one (numeric deadline) is read, retried and settled like a current one', async () => {
      const s = login();
      const { key } = await plant(s, (k) => r4(k));
      const request = await held(s);
      expect(request).toMatchObject({ key: 'sub_1', id: 'c'.repeat(32), inFlight: false });
      const retry = await reserve(s, 'sub_1');
      expect(retry).toMatchObject({ kind: 'RESERVED', retry: true });
      if (retry.kind !== 'RESERVED') return;
      expect(await settleUnresolved(retry.attempt, 'CONFIRMED')).toBe(true);
      expect(await backend.getRaw(key)).toBeNull();
    });

    it.each([
      ['no deadline', (r: Record<string, unknown>) => delete r.deadline],
      ['a null deadline', (r: Record<string, unknown>) => (r.deadline = null)],
      ['a non-numeric deadline', (r: Record<string, unknown>) => (r.deadline = 'soon')],
      ['a field only the new version has', (r: Record<string, unknown>) => (r.org = 'x')],
    ])('one with %s is UNAVAILABLE — not deleted, not free, not rebuilt', async (_n, break_) => {
      const s = login();
      const { key, bytes } = await plant(s, (k) => {
        const rec: Record<string, unknown> = r4(k);
        break_(rec);
        return rec;
      });
      expect(await readUnresolved(s, SCOPE)).toEqual({ kind: 'UNAVAILABLE' });
      expect(await reserve(s, 'sub_1')).toEqual({ kind: 'UNAVAILABLE' });
      expect(await reserve(s, 'sub_2')).toEqual({ kind: 'UNAVAILABLE' });
      expect(await backend.getRaw(key)).toBe(bytes);
      // A login that cannot be checked still purges nothing it cannot validate.
      expect(await purgeUnresolved(s)).toBe(false);
      expect(await backend.getRaw(key)).toBe(bytes);
    });

    it('an old-shaped record found under a purpose that has no deadline is corrupt', async () => {
      const s = login();
      const first = await reserveNoLimit(s);
      if (first.kind !== 'RESERVED') throw new Error(first.kind);
      await settleUnresolved(first.attempt, 'UNRESOLVED');
      const key = (await backend.recordKeys(s))[0]!;
      const bytes = JSON.stringify(r4(key));
      await backend.setRaw(key, bytes);
      expect(await readUnresolved(s, NO_LIMIT)).toEqual({ kind: 'UNAVAILABLE' });
      expect(await backend.getRaw(key)).toBe(bytes);
    });
  });

  describe('who sees it, and who may act on it', () => {
    it.each([
      ['another person', (s: WebSession) => ({ ...s, subject: `${s.subject}-2` })],
      ['a later login', (s: WebSession) => ({ ...s, csrfToken: 'a-later-login' })],
      ['another organization', (s: WebSession) => ({ ...s, organizationId: 'ORG_OTHER' })],
      ['no organization', (s: WebSession) => ({ ...s, organizationId: null })],
    ])('%s reads nothing, reserves its own, and cannot release it', async (_name, other) => {
      const s = login();
      const mine = await reserved(s);
      await settleUnresolved(mine.attempt, 'UNRESOLVED');
      const o = other(s);
      expect(await readUnresolved(o, SCOPE)).toEqual({ kind: 'NONE' });
      expect(await reserve(o, 'sub_9')).toMatchObject({ kind: 'RESERVED' });
      const request = (await held(s)) as never;
      expect(await releaseUnresolved(o, SCOPE, releaseToken(s, SCOPE, request))).toBe('STALE');
      expect(await held(s)).toMatchObject({ key: 'sub_1' });
    });

    it('is keyed by purpose and by target', async () => {
      const s = login();
      const { attempt } = await reserved(s);
      await settleUnresolved(attempt, 'UNRESOLVED');
      expect(await held(s, { purpose: 'other' })).toBe('NONE');
      expect(await held(s, { purpose: 'project-create', target: 'T1' })).toBe('NONE');
      expect(
        (await reserve(s, 'sub_x', {}, { purpose: 'project-create', target: 'T1' })).kind,
      ).toBe('RESERVED');
      expect(await held(s)).toMatchObject({ key: 'sub_1' });
    });

    it('rejects a malformed purpose rather than guessing a key', async () => {
      const s = login();
      await expect(readUnresolved(s, { purpose: 'Bad Purpose!' })).rejects.toThrow('bad purpose');
    });
  });

  describe('releasing ("send as new")', () => {
    async function unresolved(s: WebSession, key = 'sub_1') {
      const { attempt } = await reserved(s, key);
      await settleUnresolved(attempt, 'UNRESOLVED');
      const request = await held(s);
      if (typeof request === 'string') throw new Error(request);
      return request;
    }

    it('deletes the record it was drawn for', async () => {
      const s = login();
      const request = await unresolved(s);
      expect(await releaseUnresolved(s, SCOPE, releaseToken(s, SCOPE, request))).toBe('RELEASED');
      expect(await readUnresolved(s, SCOPE)).toEqual({ kind: 'NONE' });
      expect(await releaseUnresolved(s, SCOPE, releaseToken(s, SCOPE, request))).toBe('GONE');
    });

    it('refuses a form drawn for an earlier generation of the record', async () => {
      const s = login();
      const old = await unresolved(s, 'K1');
      await releaseUnresolved(s, SCOPE, releaseToken(s, SCOPE, old));
      const current = await unresolved(s, 'K2');
      expect(await releaseUnresolved(s, SCOPE, releaseToken(s, SCOPE, old))).toBe('STALE');
      expect(await held(s)).toMatchObject({ key: 'K2', id: current.id });
    });

    it.each([undefined, null, 'garbage', 42])('refuses the name %j', async (name) => {
      const s = login();
      await unresolved(s);
      expect(await releaseUnresolved(s, SCOPE, name)).toBe('STALE');
      expect(await held(s)).toMatchObject({ key: 'sub_1' });
    });

    it('refuses a name signed for another scope', async () => {
      const s = login();
      const request = await unresolved(s);
      const other = { purpose: 'supplier-write', target: 'SUP_1' };
      expect(await releaseUnresolved(s, SCOPE, releaseToken(s, other, request))).toBe('STALE');
    });

    it('does not release a request being dispatched right now', async () => {
      const s = login();
      await reserved(s);
      const request = (await held(s)) as never;
      expect(await releaseUnresolved(s, SCOPE, releaseToken(s, SCOPE, request))).toBe(
        'IN_PROGRESS',
      );
      expect(await held(s)).toMatchObject({ key: 'sub_1' });
    });
  });

  describe('capacity per login', () => {
    const fill = async (s: WebSession, count: number, extra: ReserveExtra = {}) => {
      for (let n = 0; n < count; n += 1) {
        const out = await reserve(s, `k${n}`, extra, { purpose: 'filler', target: `T${n}` });
        expect(out.kind).toBe('RESERVED');
      }
    };

    it('refuses the 51st scope before anything is dispatched, and never evicts', async () => {
      const s = login();
      await fill(s, MAX_PENDING_PER_LOGIN);
      expect(await reserve(s, 'k-new')).toMatchObject({ kind: 'CAPACITY' });
      expect(await held(s, { purpose: 'filler', target: 'T0' })).toMatchObject({ key: 'k0' });
      // An existing scope is not "new": it is still answered (held), not refused as full.
      expect(await reserve(s, 'k0', {}, { purpose: 'filler', target: 'T0' })).toMatchObject({
        kind: 'HELD',
      });
    });

    it('lets exactly one of the 50th and 51st concurrent reserves through', async () => {
      const s = login();
      await fill(s, MAX_PENDING_PER_LOGIN - 1);
      const outcomes = await Promise.all([
        reserve(s, 'a', {}, { purpose: 'racer', target: 'A' }),
        reserve(s, 'b', {}, { purpose: 'racer', target: 'B' }),
      ]);
      expect(outcomes.map((o) => o.kind).sort()).toEqual(['CAPACITY', 'RESERVED']);
    });

    it('frees a place when a record expires on its own (30 days after its deadline)', async () => {
      const s = login();
      await fill(s, MAX_PENDING_PER_LOGIN);
      const one = await reserve(s, 'z', {}, { purpose: 'z', target: 'z' });
      expect(one.kind).toBe('CAPACITY');
      await backend.advance(WIN + RECORD_RETENTION_AFTER_MS + SECOND);
      const t = backend.now();
      const fresh = await reserve(
        s,
        'z',
        { issuedAt: t, deadline: t + WIN },
        { purpose: 'z', target: 'z' },
      );
      expect(fresh.kind).toBe('RESERVED');
    });

    it('counts per login, not across logins', async () => {
      const a = login();
      const b = login();
      await fill(a, MAX_PENDING_PER_LOGIN);
      expect((await reserve(b, 'x')).kind).toBe('RESERVED');
    });
  });

  describe('logout (purge)', () => {
    it('deletes the login’s records and its capacity, and nobody else’s', async () => {
      const mine = login();
      const theirs = login();
      for (let n = 0; n < MAX_PENDING_PER_LOGIN; n += 1) {
        await reserve(mine, `k${n}`, {}, { purpose: 'filler', target: `T${n}` });
      }
      await reserved(theirs);
      expect(await purgeUnresolved(mine)).toBe(true);
      expect(await held(mine, { purpose: 'filler', target: 'T3' })).toBe('NONE');
      expect((await reserve(mine, 'again')).kind).toBe('RESERVED');
      expect(await held(theirs)).toMatchObject({ key: 'sub_1' });
    });

    /** A login with three scopes (A, B, C); returns each record's key (in order A, B, C). */
    async function threeScopes(s: WebSession) {
      const keys: string[] = [];
      for (const target of ['A', 'B', 'C']) {
        const out = await reserve(s, `k-${target}`, {}, { purpose: 'filler', target });
        if (out.kind !== 'RESERVED') throw new Error(out.kind);
        await settleUnresolved(out.attempt, 'UNRESOLVED');
        keys.push(out.attempt.binding.recordKey);
      }
      expect([...(await backend.recordKeys(s))].sort()).toEqual([...keys].sort());
      const setKey = (await backend.setKeys(s))[0]!;
      return { keys, setKey };
    }
    async function snapshot(keys: string[], setKey: string) {
      const records: Record<string, string | null> = {};
      for (const k of keys) records[k] = await backend.getRaw(k);
      return { records, index: [...(await backend.members(setKey))].sort() };
    }

    it('a corrupt member stops the whole purge: no record and no index entry is touched', async () => {
      const s = login();
      const { keys, setKey } = await threeScopes(s);
      await backend.setRaw(
        keys[1]!,
        JSON.stringify({ ...JSON.parse((await backend.getRaw(keys[1]!))!), state: 'BOGUS' }),
      );
      const before = await snapshot(keys, setKey);
      expect(await purgeUnresolved(s)).toBe(false);
      expect(await snapshot(keys, setKey)).toEqual(before);
      // The valid holds of the others are still there, and still held.
      expect(await held(s, { purpose: 'filler', target: 'A' })).toMatchObject({ key: 'k-A' });
    });

    it('an index entry that points at another login’s (valid) record is not deleted, and stops the purge', async () => {
      const s = login();
      const other = login();
      const { keys, setKey } = await threeScopes(s);
      const foreign = await reserved(other);
      const foreignKey = foreign.attempt.binding.recordKey;
      await backend.addMember(setKey, foreignKey);
      const before = await snapshot([...keys, foreignKey], setKey);
      expect(await purgeUnresolved(s)).toBe(false);
      expect(await snapshot([...keys, foreignKey], setKey)).toEqual(before);
      expect(await held(other)).toMatchObject({ key: 'sub_1' });
    });

    it('a member of the same organization whose record belongs to another login is left alone too', async () => {
      const s = login();
      const sameOrg = login({ organizationId: s.organizationId });
      const { keys, setKey } = await threeScopes(s);
      const foreign = await reserved(sameOrg);
      const foreignKey = foreign.attempt.binding.recordKey;
      await backend.addMember(setKey, foreignKey);
      const before = await snapshot([...keys, foreignKey], setKey);
      expect(await purgeUnresolved(s)).toBe(false);
      expect(await snapshot([...keys, foreignKey], setKey)).toEqual(before);
    });

    it('a member whose record is already gone does not block the purge', async () => {
      const s = login();
      const { setKey } = await threeScopes(s);
      await backend.addMember(
        setKey,
        `${PENDING_KEY_PREFIX}:org:${encodeURIComponent(s.organizationId!)}:pw:${'f'.repeat(64)}`,
      );
      expect(await purgeUnresolved(s)).toBe(true);
      expect(await backend.recordKeys(s)).toEqual([]);
      expect(await backend.setKeys(s)).toEqual([]);
    });

    it('an index entry outside the organization’s record namespace stops the purge', async () => {
      const s = login();
      const { keys, setKey } = await threeScopes(s);
      await backend.addMember(
        setKey,
        `${PENDING_KEY_PREFIX}:org:ORG_ELSEWHERE:pw:${'f'.repeat(64)}`,
      );
      const before = await snapshot(keys, setKey);
      expect(await purgeUnresolved(s)).toBe(false);
      expect(await snapshot(keys, setKey)).toEqual(before);
    });
  });

  it('keeps no request body, no token and no personal data', async () => {
    const s = login();
    await reserve(s, 'sub_1', { ref: 'a-signed-stamp' });
    const { raw } = await onlyRecord(s);
    expect(raw).not.toContain(s.accessToken);
    expect(raw).not.toContain(s.refreshToken);
    expect(raw).not.toContain(s.csrfToken);
    expect(raw).not.toContain(s.subject);
    expect(raw).not.toContain(s.username);
    expect(Object.keys(JSON.parse(raw)).sort()).toEqual([
      'attemptId',
      'bind',
      'createdAt',
      'deadline',
      'digest',
      'id',
      'issuedAt',
      'key',
      'login',
      'org',
      'purpose',
      'ref',
      'reservedAt',
      'state',
      'target',
      'v',
      'wasUnresolved',
    ]);
  });
});

describe('requestDigest', () => {
  const s = login();
  it('ignores property order and keeps omitted, null and empty apart', () => {
    const d = (body: unknown) => requestDigest(s, 'p', body);
    expect(d({ a: 1, b: 2 })).toBe(d({ b: 2, a: 1 }));
    expect(d({ a: 1 })).not.toBe(d({ a: 1, b: null }));
    expect(d({ a: null })).not.toBe(d({ a: '' }));
    expect(d({ a: 1 })).not.toBe(requestDigest(s, 'q', { a: 1 }));
    expect(d({ a: 1 })).not.toBe(requestDigest({ ...s, subject: 'other' }, 'p', { a: 1 }));
  });
});

describe('a store that cannot be trusted fails closed', () => {
  const s = login();
  const input = () => ({
    key: 'sub_1',
    digest: 'd',
    ref: 'r',
    issuedAt: MEMORY_T0,
    deadline: MEMORY_T0 + WIN,
    windowMs: WIN,
  });
  const stub = (overrides: Partial<RedisLike>): UnresolvedStore => {
    const redis = {
      get: async () => null,
      set: async () => 'OK',
      exists: async () => 0,
      eval: async () => {
        throw new Error('not expected');
      },
      ...overrides,
    } as RedisLike;
    return redisUnresolvedStore(redis);
  };
  const valid = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      v: 1,
      id: 'a'.repeat(32),
      attemptId: 'b'.repeat(32),
      key: 'sub_1',
      digest: 'd',
      issuedAt: 1,
      ref: null,
      deadline: 2,
      state: 'UNRESOLVED',
      wasUnresolved: true,
      createdAt: 1,
      reservedAt: 1,
      bind: 'c'.repeat(64),
      ...over,
    });

  it.each([
    ['a read error', stub({ eval: async () => Promise.reject(new Error('ECONNREFUSED')) })],
    ['a timeout', stub({ eval: async () => Promise.reject(new Error('Command timed out')) })],
    ['a CORRUPT answer', stub({ eval: async () => ['CORRUPT'] })],
    ['malformed JSON', stub({ eval: async () => ['OK', '{not json', '1'] })],
    ['a record of the wrong shape', stub({ eval: async () => ['OK', '{"v":1,"id":"x"}', '1'] })],
    [
      'a record without a deadline',
      stub({ eval: async () => ['OK', valid({ deadline: undefined }), '1'] }),
    ],
    ['a record that is not this key’s', stub({ eval: async () => ['OK', valid(), '1'] })],
    ['an unreadable time', stub({ eval: async () => ['NONE', '', 'soon'] })],
    ['an unknown answer', stub({ eval: async () => 'what' })],
  ])('reading: %s is UNAVAILABLE, never "no hold"', async (_name, store) => {
    useUnresolvedStore(store);
    expect(await readUnresolved(s, SCOPE)).toEqual({ kind: 'UNAVAILABLE' });
    useUnresolvedStore(undefined);
  });

  it.each([
    ['ECONNREFUSED', () => Promise.reject(new Error('connect ECONNREFUSED'))],
    ['memory full under noeviction', () => Promise.reject(new Error('OOM command not allowed'))],
    ['a corrupt record', async () => ['CORRUPT']],
    ['an invalid request', async () => ['INVALID']],
    ['an unreadable reply', async () => 'what'],
    [
      'a RESERVED answer with a record that is not ours',
      async () => ['RESERVED', valid(), '0', '1'],
    ],
  ])('reserving: %s is UNAVAILABLE and nothing is reserved', async (_name, evalImpl) => {
    useUnresolvedStore(stub({ eval: evalImpl as never }));
    expect(await reserveUnresolved(s, SCOPE, input())).toEqual({ kind: 'UNAVAILABLE' });
    useUnresolvedStore(undefined);
  });

  it('settling reports false and never throws; releasing and purging report unavailable', async () => {
    useUnresolvedStore(stub({ eval: () => Promise.reject(new Error('down')) }));
    const binding = {
      recordKey: 'k',
      setKey: 's',
      org: 'o',
      login: 'l',
      purpose: 'project-create',
      target: '',
      bind: 'b',
    };
    expect(await settleUnresolved({ binding, id: 'i', attemptId: 'a' }, 'CONFIRMED')).toBe(false);
    expect(await purgeUnresolved(s)).toBe(false);
    const request = { id: 'a'.repeat(32), key: 'k', digest: 'd', deadline: null, ref: null };
    expect(
      await releaseUnresolved(s, SCOPE, releaseToken(s, SCOPE, { ...request, inFlight: false })),
    ).toBe('UNAVAILABLE');
    useUnresolvedStore(undefined);
  });

  it('settling a CORRUPT answer is "not taken", not a delete', async () => {
    useUnresolvedStore(stub({ eval: async () => 'CORRUPT' }));
    const binding = {
      recordKey: 'k',
      setKey: 's',
      org: 'o',
      login: 'l',
      purpose: 'project-create',
      target: '',
      bind: 'b',
    };
    expect(await settleUnresolved({ binding, id: 'i', attemptId: 'a' }, 'CONFIRMED')).toBe(false);
    useUnresolvedStore(undefined);
  });

  it('in production with no WEB_REDIS_URL there is no in-process fallback: nothing is held, nothing is sent', async () => {
    // The environment is validated once and cached; production requires the URL
    // at start (`env.ts`), so this is the belt over that braces.
    requestDigest(s, 'p', {});
    const before = process.env.NODE_ENV;
    Object.assign(process.env, { NODE_ENV: 'production' });
    useUnresolvedStore(undefined);
    try {
      expect(await readUnresolved(s, SCOPE)).toEqual({ kind: 'UNAVAILABLE' });
      expect(await reserveUnresolved(s, SCOPE, input())).toEqual({ kind: 'UNAVAILABLE' });
    } finally {
      Object.assign(process.env, { NODE_ENV: before });
    }
  });

  it('outside production and with no URL, a process-local store is used (development, test)', async () => {
    useUnresolvedStore(undefined);
    const mine = login();
    const now = Date.now();
    const out = await reserveUnresolved(mine, SCOPE, {
      ...input(),
      issuedAt: now,
      deadline: now + WIN,
    });
    expect(out.kind).toBe('RESERVED');
    expect((await readUnresolved(mine, SCOPE)).kind).toBe('PENDING');
    useUnresolvedStore(undefined);
  });

  it('is an UnresolvedStoreUnavailable that the store raises', async () => {
    const binding = {
      recordKey: 'k',
      setKey: 's',
      org: 'o',
      login: 'l',
      purpose: 'project-create',
      target: '',
      bind: 'b',
    };
    await expect(
      stub({ eval: () => Promise.reject(new Error('x')) }).read(binding),
    ).rejects.toBeInstanceOf(UnresolvedStoreUnavailable);
  });
});

if (realRedisUrl) {
  describe('against a real Redis only', () => {
    let redis: Redis;
    beforeAll(() => {
      redis = new Redis(realRedisUrl, { maxRetriesPerRequest: 1, commandTimeout: 2_000 });
    });
    afterAll(async () => {
      useUnresolvedStore(undefined);
      await redis.quit();
    });
    beforeEach(() => useUnresolvedStore(redisUnresolvedStore(redis as unknown as RedisLike)));
    const redisNow = async () => {
      const [sec, usec] = await redis.time();
      return Number(sec) * 1000 + Math.floor(Number(usec) / 1000);
    };
    const stamp = (now: number, extra = {}) => ({
      key: 'sub_1',
      digest: 'digest-of-sub_1',
      ref: 'stamp',
      issuedAt: now,
      deadline: now + WIN,
      windowMs: WIN,
      ...extra,
    });

    it('expires the record, and the login’s set, 30 days after the deadline (absolute, PEXPIREAT)', async () => {
      const s = login();
      const now = await redisNow();
      const deadline = now + WIN;
      const out = await reserveUnresolved(s, SCOPE, stamp(now, { deadline }));
      expect(out.kind).toBe('RESERVED');
      const [recordKey] = await redis.keys(`${PENDING_KEY_PREFIX}:org:${s.organizationId}:pw:*`);
      const [setKey] = await redis.keys(`${PENDING_KEY_PREFIX}:org:${s.organizationId}:pwl:*`);
      const expireAt = deadline + RECORD_RETENTION_AFTER_MS;
      expect(await redis.pexpiretime(recordKey!)).toBe(expireAt);
      expect(await redis.pexpiretime(setKey!)).toBe(expireAt);
      expect(await redis.zscore(setKey!, recordKey!)).toBe(String(expireAt));
    });

    it('expires a record without a deadline 30 days after its creation — by Redis TIME', async () => {
      const s = login();
      const before = await redisNow();
      await reserveUnresolved(s, NO_LIMIT, stamp(before, { deadline: null, windowMs: null }));
      const after = await redisNow();
      const [recordKey] = await redis.keys(`${PENDING_KEY_PREFIX}:org:${s.organizationId}:pw:*`);
      const expireAt = await redis.pexpiretime(recordKey!);
      expect(expireAt).toBeGreaterThanOrEqual(before + RECORD_RETENTION_AFTER_MS);
      expect(expireAt).toBeLessThanOrEqual(after + RECORD_RETENTION_AFTER_MS);
      // createdAt and reservedAt are the store's time as well, not the caller's.
      const rec = JSON.parse((await redis.get(recordKey!))!);
      expect(rec.createdAt).toBeGreaterThanOrEqual(before);
      expect(rec.createdAt).toBeLessThanOrEqual(after);
      expect(rec.reservedAt).toBe(rec.createdAt);
    });

    it('every script that judges time reads the store’s own TIME', () => {
      const { RESERVE_SCRIPT, READ_SCRIPT, SETTLE_SCRIPT, RELEASE_SCRIPT } =
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require('./unresolved-request-store') as typeof import('./unresolved-request-store');
      for (const script of [RESERVE_SCRIPT, READ_SCRIPT, SETTLE_SCRIPT, RELEASE_SCRIPT]) {
        expect(script).toContain("redis.call('TIME')");
      }
    });

    it('names the organization in every key (ADR-007)', async () => {
      const s = login();
      await reserveUnresolved(s, SCOPE, stamp(await redisNow()));
      const keys = await redis.keys(`${PENDING_KEY_PREFIX}:*${s.organizationId}*`);
      expect(keys).toHaveLength(2);
      for (const key of keys) {
        expect(key).toMatch(
          new RegExp(`^${PENDING_KEY_PREFIX}:org:${s.organizationId}:pwl?:[0-9a-f]{64}$`),
        );
      }
    });

    it('purge leaves no key behind', async () => {
      const s = login();
      await reserveUnresolved(s, SCOPE, stamp(await redisNow()));
      expect(await purgeUnresolved(s)).toBe(true);
      expect(await redis.keys(`${PENDING_KEY_PREFIX}:*${s.organizationId}*`)).toEqual([]);
    });

    it('with Redis down nothing is reserved, and once it is back the next submit goes through', async () => {
      const s = login();
      const dead = new Redis('redis://127.0.0.1:1', {
        maxRetriesPerRequest: 1,
        commandTimeout: 500,
        retryStrategy: () => null,
      });
      dead.on('error', () => undefined);
      useUnresolvedStore(redisUnresolvedStore(dead as unknown as RedisLike));
      const now = await redisNow();
      expect(await reserveUnresolved(s, SCOPE, stamp(now))).toEqual({ kind: 'UNAVAILABLE' });
      expect(await readUnresolved(s, SCOPE)).toEqual({ kind: 'UNAVAILABLE' });
      dead.disconnect();

      useUnresolvedStore(redisUnresolvedStore(redis as unknown as RedisLike));
      expect(await readUnresolved(s, SCOPE)).toEqual({ kind: 'NONE' });
      expect((await reserveUnresolved(s, SCOPE, stamp(now))).kind).toBe('RESERVED');
    });
  });
}
