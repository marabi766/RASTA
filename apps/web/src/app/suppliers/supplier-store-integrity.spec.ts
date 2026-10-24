/**
 * @jest-environment node
 */
import Redis from 'ioredis';

import { BASELINE_FIELD } from '@/lib/form-fields';
import { CSRF_FIELD } from '@/server/csrf';
import { SUBMISSION_FIELD, mintSubmissionId } from '@/server/submission';
import type { WebSession } from '@/server/session';
import { sealSupplierBaseline } from '@/server/supplier-commands';
import {
  RECONCILED_FIELD,
  RECONCILED_VALUE,
  RELEASE_FIELD,
  supplierWriteScope,
} from '@/server/supplier-unresolved';

import { IDLE_SUPPLIER_FORM } from './supplier-form-state';

/**
 * What the supplier purpose does with the store's r5 guarantees
 * (`server/unresolved-request.spec.ts` holds the store to them with its own
 * purposes; this file holds the REAL `supplier-write` row of the policy table to them):
 *
 *  - the row is `retry: false`, deadline `NONE`, stored as the explicit marker;
 *  - a record that is malformed or does not belong to this slot is never read as
 *    "nothing held": nothing is sent, the bytes are not touched, the person is
 *    told it cannot be checked;
 *  - the store's own clock decides a live lease, so a portal replica 61 s ahead
 *    or behind neither releases it nor sends a second write.
 *
 * Run on the in-process twin always, and on a real Redis (the Lua) when
 * `WEB_TEST_REDIS_URL` is set; CI sets `WEB_TEST_REDIS_REQUIRED=true`.
 */

const realRedisUrl = process.env.WEB_TEST_REDIS_URL;
if (process.env.WEB_TEST_REDIS_REQUIRED === 'true' && !realRedisUrl) {
  throw new Error('WEB_TEST_REDIS_REQUIRED is set but WEB_TEST_REDIS_URL is not');
}

const currentSession = jest.fn();
const suspendSupplier = jest.fn();
const redirect = jest.fn((url: string) => {
  throw new Error(`NEXT_REDIRECT:${url}`);
});

jest.mock('@/server/current-session', () => ({
  currentSession: () => currentSession(),
  missingSessionReason: async () => 'NO_SESSION',
}));
jest.mock('next/navigation', () => ({ redirect: (url: string) => redirect(url) }));
jest.mock('@/server/supplier-commands', () => ({
  ...jest.requireActual('@/server/supplier-commands'),
  suspendSupplier: (...args: unknown[]) => suspendSupplier(...args),
}));

Object.assign(process.env, {
  API_GATEWAY_URL: 'http://gateway.test:3000',
  OIDC_ISSUER_URL: 'http://keycloak.test/realms/rasta',
  OIDC_CLIENT_ID: 'rasta-web',
  WEB_PUBLIC_ORIGIN: 'http://localhost:3200',
  WEB_SESSION_SECRET: 'a-secret-that-is-long-enough-to-be-a-key',
});

/* eslint-disable @typescript-eslint/no-require-imports */
const actions = require('./supplier-actions') as typeof import('./supplier-actions');
const { readUnresolved, releaseToken, reserveUnresolved, useUnresolvedStore } =
  require('@/server/unresolved-request') as typeof import('@/server/unresolved-request');
const { memoryUnresolvedStore, redisUnresolvedStore, recordKeyPrefix } =
  require('@/server/unresolved-request-store') as typeof import('@/server/unresolved-request-store');
const { policyOf, purposePolicies } =
  require('@/server/unresolved-request-policy') as typeof import('@/server/unresolved-request-policy');
/* eslint-enable @typescript-eslint/no-require-imports */
type RedisLike = import('@/server/refresh-coordinator').RedisLike;

const SUPPLIER_ID = 'SUP_01J00000000000000000000000';
const EPISODE = 'SSP_01J00000000000000000000001';
const lost = { kind: 'UNKNOWN_OUTCOME', correlationId: 'corr-lost' };

let n = 0;
function login(): WebSession {
  n += 1;
  return {
    subject: `user-${process.pid}-${Date.now()}-${n}`,
    username: 'operator',
    organizationId: `ORG-INTEG-${process.pid}-${n}`,
    accessToken: 'access-token-value',
    accessTokenExpiresAt: Math.floor(Date.now() / 1000) + 600,
    refreshToken: 'refresh-token-value',
    csrfToken: `csrf-${n}`,
    issuedAt: 1_900_000_000,
  };
}

describe('the supplier-write row of the purpose table', () => {
  it('never resends and has no deadline, and breaks no rule of the table', () => {
    expect(purposePolicies()['supplier-write']).toEqual({ retry: false, deadline: 'NONE' });
    expect(policyOf('supplier-write')).toEqual({ retry: false, deadline: 'NONE' });
    expect(policyOf('supplier-writes')).toBeNull();
  });
});

let redis: Redis | null = null;
const rawOf = {
  async keys(org: string, mem: ReturnType<typeof memoryUnresolvedStore> | null) {
    if (mem) return [...mem.records.keys()].filter((k) => k.startsWith(recordKeyPrefix(org)));
    return redis!.keys(`${recordKeyPrefix(org)}*`);
  },
  async get(key: string, mem: ReturnType<typeof memoryUnresolvedStore> | null) {
    return mem ? (mem.records.get(key) ?? null) : redis!.get(key);
  },
  async set(key: string, value: string, mem: ReturnType<typeof memoryUnresolvedStore> | null) {
    if (mem) mem.records.set(key, value);
    else await redis!.set(key, value, 'KEEPTTL');
  },
};

const BACKENDS: readonly [string, boolean][] = [
  ['in-process', false],
  ['real Redis', true],
];

describe.each(BACKENDS)('supplier-write holds on %s', (_name, real) => {
  const run = real && !realRedisUrl ? describe.skip : describe;
  run('', () => {
    let session: WebSession;
    let mem: ReturnType<typeof memoryUnresolvedStore> | null = null;

    beforeAll(() => {
      if (real)
        redis = new Redis(realRedisUrl!, { maxRetriesPerRequest: 1, commandTimeout: 2_000 });
    });
    afterAll(async () => {
      useUnresolvedStore(undefined);
      if (real && redis) await redis.quit();
    });
    beforeEach(() => {
      session = login();
      currentSession.mockResolvedValue(session);
      if (real) useUnresolvedStore(redisUnresolvedStore(redis as unknown as RedisLike));
      else {
        mem = memoryUnresolvedStore();
        useUnresolvedStore(mem);
      }
      suspendSupplier.mockReset();
      redirect.mockClear();
      jest.restoreAllMocks();
    });

    const suspendForm = (submission = mintSubmissionId(session)) => {
      const form = new FormData();
      form.set('reason', 'شکایت تکراری مشتریان');
      form.set(CSRF_FIELD, session.csrfToken);
      form.set(SUBMISSION_FIELD, submission);
      form.set(
        BASELINE_FIELD,
        sealSupplierBaseline(session, {
          supplierId: SUPPLIER_ID,
          command: 'SUSPEND',
          qualificationId: null,
          suspensionId: EPISODE,
        }),
      );
      return form;
    };
    const suspend = () =>
      actions.submitSuspendSupplier(SUPPLIER_ID, IDLE_SUPPLIER_FORM as never, suspendForm());
    const scope = () => supplierWriteScope(SUPPLIER_ID);
    const only = async () => {
      const keys = await rawOf.keys(session.organizationId!, mem);
      expect(keys).toHaveLength(1);
      return keys[0]!;
    };

    it('stores the explicit NONE marker, never a missing or numeric deadline', async () => {
      suspendSupplier.mockResolvedValue(lost);
      await suspend();
      const record = JSON.parse((await rawOf.get(await only(), mem))!);
      expect(record).toMatchObject({ v: 2, purpose: 'supplier-write', deadline: 'NONE' });
    });

    it('a caller that asks for a deadline on this purpose is refused (nothing reserved)', async () => {
      const refused = await reserveUnresolved(session, scope(), {
        key: 'sub_1',
        digest: 'd',
        ref: null,
        issuedAt: Date.now(),
        deadline: Date.now() + 3_600_000,
        windowMs: 3_600_000,
      });
      expect(refused.kind).toBe('UNAVAILABLE');
      expect(await rawOf.keys(session.organizationId!, mem)).toEqual([]);
    });

    const edit = (change: (record: Record<string, unknown>) => void) => (json: string) => {
      const record = JSON.parse(json);
      change(record);
      return JSON.stringify(record);
    };
    const MALFORMED: readonly [string, (json: string) => string][] = [
      ['no deadline', edit((r) => delete r.deadline)],
      ['a null deadline', edit((r) => (r.deadline = null))],
      ['a numeric deadline on a NONE purpose', edit((r) => (r.deadline = Date.now() + 1e6))],
      ['an unknown state', edit((r) => (r.state = 'BOGUS'))],
      ['the project-create purpose', edit((r) => (r.purpose = 'project-create'))],
      ['another organization', edit((r) => (r.org = 'ORG-OTHER'))],
      ['another login', edit((r) => (r.login = 'f'.repeat(64)))],
      ['another target', edit((r) => (r.target = 'supplier:SUP_OTHER'))],
      ['an extra field', edit((r) => (r.extra = 1))],
      ['version 3', edit((r) => (r.v = 3))],
      ['not JSON', () => '{not json'],
      ['an array', () => '[]'],
    ];

    it.each(MALFORMED)(
      '%s: nothing is sent, nothing is released, the bytes stay',
      async (_what, mutate) => {
        suspendSupplier.mockResolvedValue(lost);
        await suspend(); // held
        const key = await only();
        const bad = mutate((await rawOf.get(key, mem))!);
        await rawOf.set(key, bad, mem);
        suspendSupplier.mockClear();

        expect(await readUnresolved(session, scope())).toEqual({ kind: 'UNAVAILABLE' });
        expect(await suspend()).toEqual({ kind: 'NOT_CHECKED' });
        expect(suspendSupplier).not.toHaveBeenCalled();

        // A release form drawn before the record went bad frees nothing.
        const form = new FormData();
        form.set(CSRF_FIELD, session.csrfToken);
        form.set(RECONCILED_FIELD, RECONCILED_VALUE);
        form.set(RELEASE_FIELD, releaseToken(session, scope(), { id: 'a'.repeat(32) } as never));
        await actions.reconcileSupplierWrite(SUPPLIER_ID, form).catch(() => undefined);
        expect(await rawOf.get(key, mem)).toBe(bad);
        expect(suspendSupplier).not.toHaveBeenCalled();
      },
    );

    it.each([61_000, -61_000])(
      'a portal replica %i ms off keeps a live send in flight: no second write, no release',
      async (offset) => {
        let finish: (value: unknown) => void = () => undefined;
        suspendSupplier.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
        const tabA = suspend();
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(suspendSupplier).toHaveBeenCalledTimes(1);

        const real_now = Date.now.bind(Date);
        jest.spyOn(Date, 'now').mockImplementation(() => real_now() + offset);
        expect(await suspend()).toEqual({ kind: 'BUSY' });
        expect(suspendSupplier).toHaveBeenCalledTimes(1);

        const held = await readUnresolved(session, scope());
        expect(held).toMatchObject({ kind: 'PENDING', request: { inFlight: true } });
        if (held.kind !== 'PENDING') throw new Error(held.kind);
        const form = new FormData();
        form.set(CSRF_FIELD, session.csrfToken);
        form.set(RECONCILED_FIELD, RECONCILED_VALUE);
        form.set(RELEASE_FIELD, releaseToken(session, scope(), held.request));
        const error = await actions.reconcileSupplierWrite(SUPPLIER_ID, form).then(
          () => new Error('expected a redirect'),
          (caught: Error) => caught,
        );
        expect(
          new URL(error.message.replace('NEXT_REDIRECT:', ''), 'http://x').searchParams.get(
            'release',
          ),
        ).toBe('IN_PROGRESS');
        jest.restoreAllMocks();
        finish(lost);
        expect(((await tabA) as { kind: string }).kind).toBe('UNCONFIRMED');
        expect(suspendSupplier).toHaveBeenCalledTimes(1);
      },
    );
  });
});
