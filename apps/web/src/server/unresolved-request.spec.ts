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
  type UnresolvedStore,
} from './unresolved-request-store';

/**
 * The retention of an unresolved write request: what it keeps, for whom, and what
 * it never holds. One suite, two stores — this process and a real Redis (where
 * the Lua itself runs). CI sets `WEB_TEST_REDIS_REQUIRED=true` in a job with a
 * Redis service, so there the real run cannot be skipped by accident
 * (`refresh-coordinator.spec.ts` is the model).
 */

Object.assign(process.env, {
  API_GATEWAY_URL: 'http://gateway.test:3000',
  OIDC_ISSUER_URL: 'http://keycloak.test/realms/rasta',
  OIDC_CLIENT_ID: 'rasta-web',
  WEB_PUBLIC_ORIGIN: 'http://localhost:3200',
  WEB_SESSION_SECRET: 'a-secret-that-is-long-enough-to-be-a-key',
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

const T0 = 1_900_000_000_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const SCOPE: { purpose: string; target?: string } = { purpose: 'project-create' };
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

function input(key = 'sub_1', extra: Partial<Parameters<typeof reserveUnresolved>[2]> = {}) {
  return {
    key,
    digest: `digest-of-${key}`,
    ref: `stamp-of-${key}`,
    issuedAt: T0,
    deadline: T0 + WIN,
    windowMs: WIN,
    retry: true,
    ...extra,
  };
}

interface Backend {
  readonly store: UnresolvedStore;
  /** The raw JSON of the record (or null), for what is stored. */
  raw(session: WebSession, scope?: { purpose: string; target?: string }): Promise<string | null>;
  close(): Promise<void>;
}

function memoryBackend(): Backend {
  const store = memoryUnresolvedStore();
  return { store, raw: async () => null, close: async () => undefined };
}

function redisBackend(url: string): Backend {
  const redis = new Redis(url, { maxRetriesPerRequest: 1, commandTimeout: 2_000 });
  return {
    store: redisUnresolvedStore(redis as unknown as RedisLike),
    raw: async (session, scope = SCOPE) => {
      const keys = await redis.keys(`${PENDING_KEY_PREFIX}:org:${session.organizationId}:pw:*`);
      void scope;
      return keys.length === 0 ? null : redis.get(keys[0]!);
    },
    close: async () => void (await redis.quit()),
  };
}

const backends: [string, () => Backend][] = [['this process', memoryBackend]];
if (realRedisUrl) backends.push(['a real Redis', () => redisBackend(realRedisUrl)]);

describe.each(backends)('an unresolved request held by %s', (_name, make) => {
  const backend = make();
  beforeEach(() => useUnresolvedStore(backend.store));
  afterAll(async () => {
    useUnresolvedStore(undefined);
    await backend.close();
  });

  const reserve = (
    session: WebSession,
    key = 'sub_1',
    now = T0,
    extra: Partial<Parameters<typeof reserveUnresolved>[2]> = {},
    scope: { purpose: string; target?: string } = SCOPE,
  ) => reserveUnresolved(session, scope, input(key, extra), now);

  async function held(session: WebSession, now = T0, scope: typeof SCOPE = SCOPE) {
    const read = await readUnresolved(session, scope, now);
    return read.kind === 'PENDING' ? read.request : read.kind;
  }

  async function reserved(session: WebSession, key = 'sub_1', now = T0, extra = {}) {
    const out = await reserve(session, key, now, extra);
    if (out.kind !== 'RESERVED') throw new Error(`expected RESERVED, got ${out.kind}`);
    return out;
  }

  describe('reserving before the dispatch', () => {
    it('creates an in-flight record that the page can read at once (no response needed)', async () => {
      const s = login();
      expect(await readUnresolved(s, SCOPE, T0)).toEqual({ kind: 'NONE' });
      await reserved(s);
      expect(await held(s)).toMatchObject({
        key: 'sub_1',
        ref: 'stamp-of-sub_1',
        deadline: T0 + WIN,
        inFlight: true,
      });
    });

    it('keeps the record after an ambiguous end — which is all a lost response needs', async () => {
      const s = login();
      const { attempt } = await reserved(s);
      await settleUnresolved(attempt, 'UNRESOLVED');
      expect(await held(s, T0 + HOUR)).toMatchObject({ key: 'sub_1', inFlight: false });
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
      expect(await reserve(s, 'sub_1', T0, { digest: 'another' })).toMatchObject({
        kind: 'HELD',
        reason: 'CHANGED_BODY',
      });
    });

    it('sends the same key and body again only when the purpose allows it', async () => {
      const s = login();
      const { attempt } = await reserved(s);
      await settleUnresolved(attempt, 'UNRESOLVED');
      expect(await reserve(s, 'sub_1', T0, { retry: false })).toMatchObject({
        kind: 'HELD',
        reason: 'RECONCILE_ONLY',
      });
      expect(await reserve(s, 'sub_1', T0 + 1)).toMatchObject({ kind: 'RESERVED', retry: true });
    });

    it('turns an in-flight record the process abandoned into an unresolved one after the lease', async () => {
      const s = login();
      await reserved(s);
      expect(await reserve(s, 'sub_1', T0 + INFLIGHT_LEASE_MS - 1)).toMatchObject({
        kind: 'HELD',
        reason: 'IN_PROGRESS',
      });
      // Past the lease it may have sent: unresolved, so the same request can retry…
      const later = T0 + INFLIGHT_LEASE_MS + 1;
      expect(await held(s, later)).toMatchObject({ inFlight: false });
      expect(await reserve(s, 'sub_2', later)).toMatchObject({
        kind: 'HELD',
        reason: 'OTHER_REQUEST',
      });
      expect(await reserve(s, 'sub_1', later)).toMatchObject({ kind: 'RESERVED', retry: true });
    });
  });

  describe('settling after the dispatch, fenced by the attempt', () => {
    it('a confirmed success deletes the record', async () => {
      const s = login();
      const { attempt } = await reserved(s);
      expect(await settleUnresolved(attempt, 'CONFIRMED')).toBe(true);
      expect(await readUnresolved(s, SCOPE, T0)).toEqual({ kind: 'NONE' });
    });

    it.each(['REFUSED', 'NEVER_SENT'] as const)(
      'a %s end deletes a record this attempt created',
      async (outcome) => {
        const s = login();
        const { attempt } = await reserved(s);
        await settleUnresolved(attempt, outcome);
        expect(await readUnresolved(s, SCOPE, T0)).toEqual({ kind: 'NONE' });
      },
    );

    it.each(['REFUSED', 'NEVER_SENT'] as const)(
      'a %s end of a RETRY keeps the earlier unresolved record',
      async (outcome) => {
        const s = login();
        const first = await reserved(s);
        await settleUnresolved(first.attempt, 'UNRESOLVED');
        const retry = await reserved(s, 'sub_1', T0 + 1);
        await settleUnresolved(retry.attempt, outcome);
        expect(await held(s)).toMatchObject({ key: 'sub_1', inFlight: false });
        // …and it is still the only request that may go out.
        expect(await reserve(s, 'sub_2', T0 + 2)).toMatchObject({ kind: 'HELD' });
      },
    );

    it('a confirmed retry deletes it', async () => {
      const s = login();
      const first = await reserved(s);
      await settleUnresolved(first.attempt, 'UNRESOLVED');
      const retry = await reserved(s, 'sub_1', T0 + 1);
      await settleUnresolved(retry.attempt, 'CONFIRMED');
      expect(await readUnresolved(s, SCOPE, T0)).toEqual({ kind: 'NONE' });
    });

    it('a stale attempt changes nothing — not a delete, not an update', async () => {
      const s = login();
      const first = await reserved(s);
      await settleUnresolved(first.attempt, 'UNRESOLVED');
      const retry = await reserved(s, 'sub_1', T0 + 1);
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
      expect(await releaseUnresolved(s, SCOPE, releaseToken(s, SCOPE, request, T0), T0)).toBe(
        'RELEASED',
      );
      const k2 = await reserved(s, 'K2');
      expect(await settleUnresolved(k1.attempt, 'CONFIRMED')).toBe(false);
      expect(await held(s)).toMatchObject({ key: 'K2', inFlight: true });
      await settleUnresolved(k2.attempt, 'UNRESOLVED');
      expect(await held(s)).toMatchObject({ key: 'K2' });
    });
  });

  describe('the deadline only shrinks', () => {
    it('is not extended by raising the window: issue at 2 h, lower to 1 h, send, raise to 2 h', async () => {
      const s = login();
      // Stamp issued at minute 0 under a two-hour window (deadline 110 min).
      // Lowered to one hour before the first dispatch: the record's deadline is 60.
      const first = await reserved(s, 'sub_1', T0 + 10 * MINUTE, {
        issuedAt: T0,
        deadline: Math.min(T0 + 110 * MINUTE, T0 + HOUR),
        windowMs: HOUR,
      });
      await settleUnresolved(first.attempt, 'UNRESOLVED');
      // Raised back to two hours; at minute 75 the original stamp still says OK.
      const out = await reserve(s, 'sub_1', T0 + 75 * MINUTE, {
        issuedAt: T0,
        deadline: T0 + 110 * MINUTE,
        windowMs: 2 * HOUR,
      });
      expect(out).toMatchObject({ kind: 'EXPIRED' });
      // Not sent, and kept.
      expect(await held(s, T0 + 75 * MINUTE)).toMatchObject({ key: 'sub_1', deadline: T0 + HOUR });
    });

    it('a retry is bounded by the window as configured now, and keeps the shorter value', async () => {
      const s = login();
      const first = await reserved(s, 'sub_1', T0, { deadline: T0 + 2 * HOUR, windowMs: 2 * HOUR });
      await settleUnresolved(first.attempt, 'UNRESOLVED');
      // Configuration lowered to 30 minutes: minute 40 is past it.
      expect(await reserve(s, 'sub_1', T0 + 40 * MINUTE, { windowMs: 30 * MINUTE })).toMatchObject({
        kind: 'EXPIRED',
      });
      expect(await held(s, T0 + 40 * MINUTE)).toMatchObject({ deadline: T0 + 30 * MINUTE });
      // Raised again: the stored, shorter deadline stands.
      expect(await reserve(s, 'sub_1', T0 + 40 * MINUTE, { windowMs: 2 * HOUR })).toMatchObject({
        kind: 'EXPIRED',
      });
    });

    it('sends just inside the deadline and not a millisecond after', async () => {
      const s = login();
      const first = await reserved(s);
      await settleUnresolved(first.attempt, 'UNRESOLVED');
      const last = (await held(s)) as { deadline: number };
      const edge = await reserve(s, 'sub_1', last.deadline);
      expect(edge.kind).toBe('RESERVED');
      if (edge.kind === 'RESERVED') await settleUnresolved(edge.attempt, 'UNRESOLVED');
      expect((await reserve(s, 'sub_1', last.deadline + 1)).kind).toBe('EXPIRED');
      expect(mayResend(last as never, last.deadline + 1)).toBe(false);
      expect(mayResend(last as never, last.deadline)).toBe(true);
    });

    it('has no deadline for a purpose without one', async () => {
      const s = login();
      const first = await reserved(s, 'sub_1', T0, { deadline: null, windowMs: null });
      await settleUnresolved(first.attempt, 'UNRESOLVED');
      const request = await held(s, T0 + 10 * 24 * HOUR);
      expect(request).toMatchObject({ deadline: null });
      expect(mayResend(request as never, 9e15)).toBe(true);
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
      expect(await readUnresolved(o, SCOPE, T0)).toEqual({ kind: 'NONE' });
      expect(await reserve(o, 'sub_9')).toMatchObject({ kind: 'RESERVED' });
      const request = (await held(s)) as never;
      expect(await releaseUnresolved(o, SCOPE, releaseToken(s, SCOPE, request, T0), T0)).toBe(
        'STALE',
      );
      expect(await held(s)).toMatchObject({ key: 'sub_1' });
    });

    it('is keyed by purpose and by target', async () => {
      const s = login();
      const { attempt } = await reserved(s);
      await settleUnresolved(attempt, 'UNRESOLVED');
      expect(await held(s, T0, { purpose: 'other' })).toBe('NONE');
      expect(await held(s, T0, { purpose: 'project-create', target: 'T1' })).toBe('NONE');
      expect(
        (await reserve(s, 'sub_x', T0, {}, { purpose: 'project-create', target: 'T1' })).kind,
      ).toBe('RESERVED');
      expect(await held(s)).toMatchObject({ key: 'sub_1' });
    });

    it('rejects a malformed purpose rather than guessing a key', async () => {
      const s = login();
      await expect(readUnresolved(s, { purpose: 'Bad Purpose!' }, T0)).rejects.toThrow(
        'bad purpose',
      );
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
      expect(await releaseUnresolved(s, SCOPE, releaseToken(s, SCOPE, request, T0), T0)).toBe(
        'RELEASED',
      );
      expect(await readUnresolved(s, SCOPE, T0)).toEqual({ kind: 'NONE' });
      expect(await releaseUnresolved(s, SCOPE, releaseToken(s, SCOPE, request, T0), T0)).toBe(
        'GONE',
      );
    });

    it('refuses a form drawn for an earlier generation of the record', async () => {
      const s = login();
      const old = await unresolved(s, 'K1');
      await releaseUnresolved(s, SCOPE, releaseToken(s, SCOPE, old, T0), T0);
      const current = await unresolved(s, 'K2');
      expect(await releaseUnresolved(s, SCOPE, releaseToken(s, SCOPE, old, T0), T0)).toBe('STALE');
      expect(await held(s)).toMatchObject({ key: 'K2', id: current.id });
    });

    it.each([undefined, null, 'garbage', 42])('refuses the name %j', async (name) => {
      const s = login();
      await unresolved(s);
      expect(await releaseUnresolved(s, SCOPE, name, T0)).toBe('STALE');
      expect(await held(s)).toMatchObject({ key: 'sub_1' });
    });

    it('refuses a name signed for another scope', async () => {
      const s = login();
      const request = await unresolved(s);
      const other = { purpose: 'supplier-write', target: 'SUP_1' };
      expect(await releaseUnresolved(s, SCOPE, releaseToken(s, other, request, T0), T0)).toBe(
        'STALE',
      );
    });

    it('does not release a request being dispatched right now', async () => {
      const s = login();
      await reserved(s);
      const request = (await held(s)) as never;
      expect(await releaseUnresolved(s, SCOPE, releaseToken(s, SCOPE, request, T0), T0)).toBe(
        'IN_PROGRESS',
      );
      expect(await held(s)).toMatchObject({ key: 'sub_1' });
    });
  });

  describe('capacity per login', () => {
    const fill = async (s: WebSession, count: number, now = T0, extra = {}) => {
      for (let n = 0; n < count; n += 1) {
        const out = await reserve(s, `k${n}`, now, extra, { purpose: 'filler', target: `T${n}` });
        expect(out.kind).toBe('RESERVED');
      }
    };

    it('refuses the 51st scope before anything is dispatched, and never evicts', async () => {
      const s = login();
      await fill(s, MAX_PENDING_PER_LOGIN);
      expect(await reserve(s, 'k-new')).toMatchObject({ kind: 'CAPACITY' });
      expect(await held(s, T0, { purpose: 'filler', target: 'T0' })).toMatchObject({ key: 'k0' });
      // An existing scope is not "new": it is still answered (held), not refused as full.
      expect(await reserve(s, 'k0', T0, {}, { purpose: 'filler', target: 'T0' })).toMatchObject({
        kind: 'HELD',
      });
    });

    it('lets exactly one of the 50th and 51st concurrent reserves through', async () => {
      const s = login();
      await fill(s, MAX_PENDING_PER_LOGIN - 1);
      const outcomes = await Promise.all([
        reserve(s, 'a', T0, {}, { purpose: 'racer', target: 'A' }),
        reserve(s, 'b', T0, {}, { purpose: 'racer', target: 'B' }),
      ]);
      expect(outcomes.map((o) => o.kind).sort()).toEqual(['CAPACITY', 'RESERVED']);
    });

    it('frees a place when a record is released or confirmed, and when one expires', async () => {
      const s = login();
      await fill(s, MAX_PENDING_PER_LOGIN);
      const one = await reserve(s, 'z', T0, {}, { purpose: 'z', target: 'z' });
      expect(one.kind).toBe('CAPACITY');
      // A record with a short deadline expires on its own (30 days after it).
      const t = T0 + WIN + RECORD_RETENTION_AFTER_MS + 1;
      const fresh = await reserve(
        s,
        'z',
        t,
        { issuedAt: t, deadline: t + WIN },
        {
          purpose: 'z',
          target: 'z',
        },
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

  describe('logout', () => {
    it('deletes the login’s records and its capacity, and nobody else’s', async () => {
      const mine = login();
      const theirs = login();
      for (let n = 0; n < MAX_PENDING_PER_LOGIN; n += 1) {
        await reserve(mine, `k${n}`, T0, {}, { purpose: 'filler', target: `T${n}` });
      }
      await reserved(theirs);
      expect(await purgeUnresolved(mine)).toBe(true);
      expect(await held(mine, T0, { purpose: 'filler', target: 'T3' })).toBe('NONE');
      expect((await reserve(mine, 'again')).kind).toBe('RESERVED');
      expect(await held(theirs)).toMatchObject({ key: 'sub_1' });
    });
  });

  it('keeps no request body, no token and no personal data', async () => {
    const s = login();
    await reserve(s, 'sub_1', T0, { ref: 'a-signed-stamp' });
    const raw = await backend.raw(s);
    if (raw !== null) {
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
        'ref',
        'reservedAt',
        'state',
        'v',
        'wasUnresolved',
      ]);
    }
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

  it.each([
    ['a read error', stub({ get: async () => Promise.reject(new Error('ECONNREFUSED')) })],
    ['a timeout', stub({ get: async () => Promise.reject(new Error('Command timed out')) })],
    ['malformed JSON', stub({ get: async () => '{not json' })],
    ['a record of the wrong shape', stub({ get: async () => JSON.stringify({ v: 1, id: 'x' }) })],
    [
      'a record that is not this key’s',
      stub({
        get: async () =>
          JSON.stringify({
            v: 1,
            id: 'a'.repeat(32),
            attemptId: 'b'.repeat(32),
            key: 'sub_1',
            digest: 'd',
            issuedAt: 1,
            ref: null,
            deadline: null,
            state: 'UNRESOLVED',
            wasUnresolved: true,
            createdAt: 1,
            reservedAt: 1,
            bind: 'c'.repeat(64),
          }),
      }),
    ],
  ])('reading: %s is UNAVAILABLE, never "no hold"', async (_name, store) => {
    useUnresolvedStore(store);
    expect(await readUnresolved(s, SCOPE, T0)).toEqual({ kind: 'UNAVAILABLE' });
    useUnresolvedStore(undefined);
  });

  it.each([
    ['ECONNREFUSED', () => Promise.reject(new Error('connect ECONNREFUSED'))],
    ['memory full under noeviction', () => Promise.reject(new Error('OOM command not allowed'))],
    ['a corrupt record', async () => ['CORRUPT']],
    ['an unreadable reply', async () => 'what'],
  ])('reserving: %s is UNAVAILABLE and nothing is reserved', async (_name, evalImpl) => {
    useUnresolvedStore(stub({ eval: evalImpl as never }));
    expect(await reserveUnresolved(s, SCOPE, input(), T0)).toEqual({ kind: 'UNAVAILABLE' });
    useUnresolvedStore(undefined);
  });

  it('settling reports false and never throws; releasing and purging report unavailable', async () => {
    useUnresolvedStore(stub({ eval: () => Promise.reject(new Error('down')) }));
    expect(
      await settleUnresolved({ recordKey: 'k', setKey: 's', id: 'i', attemptId: 'a' }, 'CONFIRMED'),
    ).toBe(false);
    expect(await purgeUnresolved(s)).toBe(false);
    const request = { id: 'a'.repeat(32), key: 'k', digest: 'd', deadline: null, ref: null };
    expect(
      await releaseUnresolved(
        s,
        SCOPE,
        releaseToken(s, SCOPE, { ...request, inFlight: false }, T0),
        T0,
      ),
    ).toBe('UNAVAILABLE');
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
      expect(await readUnresolved(s, SCOPE, T0)).toEqual({ kind: 'UNAVAILABLE' });
      expect(await reserveUnresolved(s, SCOPE, input(), T0)).toEqual({ kind: 'UNAVAILABLE' });
    } finally {
      Object.assign(process.env, { NODE_ENV: before });
    }
  });

  it('outside production and with no URL, a process-local store is used (development, test)', async () => {
    useUnresolvedStore(undefined);
    const mine = login();
    expect((await reserveUnresolved(mine, SCOPE, input(), T0)).kind).toBe('RESERVED');
    expect((await readUnresolved(mine, SCOPE, T0)).kind).toBe('PENDING');
    useUnresolvedStore(undefined);
  });

  it('is an UnresolvedStoreUnavailable that the store raises', async () => {
    await expect(
      stub({ get: () => Promise.reject(new Error('x')) }).read('k', T0),
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

    it('expires the record, and the login’s set, 30 days after the deadline (absolute, PEXPIREAT)', async () => {
      const s = login();
      const now = Date.now();
      const deadline = now + WIN;
      const out = await reserveUnresolved(
        s,
        SCOPE,
        input('sub_1', { issuedAt: now, deadline }),
        now,
      );
      expect(out.kind).toBe('RESERVED');
      const [recordKey] = await redis.keys(`${PENDING_KEY_PREFIX}:org:${s.organizationId}:pw:*`);
      const [setKey] = await redis.keys(`${PENDING_KEY_PREFIX}:org:${s.organizationId}:pwl:*`);
      const expireAt = deadline + RECORD_RETENTION_AFTER_MS;
      expect(await redis.pexpiretime(recordKey!)).toBe(expireAt);
      expect(await redis.pexpiretime(setKey!)).toBe(expireAt);
      expect(await redis.zscore(setKey!, recordKey!)).toBe(String(expireAt));
    });

    it('expires a record without a deadline 30 days after its creation', async () => {
      const s = login();
      const now = Date.now();
      await reserveUnresolved(s, SCOPE, input('sub_1', { deadline: null, windowMs: null }), now);
      const [recordKey] = await redis.keys(`${PENDING_KEY_PREFIX}:org:${s.organizationId}:pw:*`);
      expect(await redis.pexpiretime(recordKey!)).toBe(now + RECORD_RETENTION_AFTER_MS);
    });

    it('names the organization in every key (ADR-007)', async () => {
      const s = login();
      await reserveUnresolved(s, SCOPE, input(), Date.now());
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
      await reserveUnresolved(s, SCOPE, input(), Date.now());
      await purgeUnresolved(s);
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
      expect(await reserveUnresolved(s, SCOPE, input(), T0)).toEqual({ kind: 'UNAVAILABLE' });
      expect(await readUnresolved(s, SCOPE, T0)).toEqual({ kind: 'UNAVAILABLE' });
      dead.disconnect();

      useUnresolvedStore(redisUnresolvedStore(redis as unknown as RedisLike));
      expect(await readUnresolved(s, SCOPE, T0)).toEqual({ kind: 'NONE' });
      expect((await reserveUnresolved(s, SCOPE, input(), T0)).kind).toBe('RESERVED');
    });
  });
}
