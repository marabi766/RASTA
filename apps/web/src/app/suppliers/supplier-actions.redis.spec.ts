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
 * The supplier write path against a **real Redis** (where the Lua of the
 * pending-request store runs), for what the in-memory store cannot show: a lost
 * response, two tabs, a stale confirmation and Redis down — for the commands on
 * a supplier and for the registration. CI sets `WEB_TEST_REDIS_REQUIRED=true` in
 * the job that has a Redis service, so the real run cannot be skipped by
 * accident; elsewhere this file is skipped without `WEB_TEST_REDIS_URL`
 * (`server/unresolved-request.spec.ts` is the model).
 */

const realRedisUrl = process.env.WEB_TEST_REDIS_URL;
if (process.env.WEB_TEST_REDIS_REQUIRED === 'true' && !realRedisUrl) {
  throw new Error('WEB_TEST_REDIS_REQUIRED is set but WEB_TEST_REDIS_URL is not');
}

const currentSession = jest.fn();
const registerSupplier = jest.fn();
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
  registerSupplier: (...args: unknown[]) => registerSupplier(...args),
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
const { readUnresolved, releaseToken, useUnresolvedStore } =
  require('@/server/unresolved-request') as typeof import('@/server/unresolved-request');
const { redisUnresolvedStore } =
  require('@/server/unresolved-request-store') as typeof import('@/server/unresolved-request-store');
/* eslint-enable @typescript-eslint/no-require-imports */
type RedisLike = import('@/server/refresh-coordinator').RedisLike;

const SUPPLIER_ID = 'SUP_01J00000000000000000000000';
const EPISODE = 'SSP_01J00000000000000000000001';

/** A login of its own per test, so tests never see each other's records on a shared Redis. */
let n = 0;
function login(): WebSession {
  n += 1;
  return {
    subject: `user-${process.pid}-${Date.now()}-${n}`,
    username: 'operator',
    organizationId: `ORG-REDIS-${process.pid}-${n}`,
    accessToken: 'access-token-value',
    accessTokenExpiresAt: Math.floor(Date.now() / 1000) + 600,
    refreshToken: 'refresh-token-value',
    csrfToken: `csrf-${n}`,
    issuedAt: 1_900_000_000,
  };
}

const describeReal = realRedisUrl ? describe : describe.skip;

describeReal('the supplier writes against a real Redis', () => {
  let redis: Redis;
  let session: WebSession;
  beforeAll(() => {
    redis = new Redis(realRedisUrl!, { maxRetriesPerRequest: 1, commandTimeout: 2_000 });
  });
  afterAll(async () => {
    useUnresolvedStore(undefined);
    await redis.quit();
  });
  beforeEach(() => {
    session = login();
    currentSession.mockResolvedValue(session);
    useUnresolvedStore(redisUnresolvedStore(redis as unknown as RedisLike));
    for (const send of [registerSupplier, suspendSupplier]) send.mockReset();
    redirect.mockClear();
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
  const suspend = (form = suspendForm()) =>
    actions.submitSuspendSupplier(SUPPLIER_ID, IDLE_SUPPLIER_FORM as never, form);
  const lost = { kind: 'UNKNOWN_OUTCOME', correlationId: 'corr-lost' };
  const created = { kind: 'CREATED', data: { id: SUPPLIER_ID }, correlationId: 'c' };

  const reconcileForm = (token: string) => {
    const form = new FormData();
    form.set(CSRF_FIELD, session.csrfToken);
    form.set(RECONCILED_FIELD, RECONCILED_VALUE);
    form.set(RELEASE_FIELD, token);
    return form;
  };
  const reconciled = async (token: string) => {
    const error = await actions.reconcileSupplierWrite(SUPPLIER_ID, reconcileForm(token)).then(
      () => new Error('expected a redirect'),
      (caught: Error) => caught,
    );
    return new URL(error.message.replace('NEXT_REDIRECT:', ''), 'http://localhost');
  };
  const tokenFor = async () => {
    const held = await readUnresolved(session, supplierWriteScope(SUPPLIER_ID));
    if (held.kind !== 'PENDING') throw new Error(held.kind);
    return releaseToken(session, supplierWriteScope(SUPPLIER_ID), held.request);
  };

  it('a lost response leaves the hold on the server: the next fresh form is not sent', async () => {
    suspendSupplier.mockResolvedValue(lost);
    await suspend(); // the reply never reaches the browser
    suspendSupplier.mockClear();
    expect(((await suspend()) as { kind: string }).kind).toBe('UNCONFIRMED');
    expect(suspendSupplier).not.toHaveBeenCalled();
  });

  it('a stale confirmation for C1 cannot release C2', async () => {
    suspendSupplier.mockResolvedValue(lost);
    await suspend();
    const tokenA = await tokenFor();
    expect((await reconciled(tokenA)).search).toBe('');
    await suspend(); // C2, lost as well
    suspendSupplier.mockClear();

    expect((await reconciled(tokenA)).searchParams.get('release')).toBe('STALE');
    expect(((await suspend()) as { kind: string }).kind).toBe('UNCONFIRMED');
    expect(suspendSupplier).not.toHaveBeenCalled();

    expect((await reconciled(await tokenFor())).search).toBe('');
    suspendSupplier.mockResolvedValue(created);
    await expect(suspend()).rejects.toThrow('NEXT_REDIRECT');
    expect(suspendSupplier).toHaveBeenCalledTimes(1);
  });

  it('two tabs: while one send is in flight the other sends nothing', async () => {
    let finish: (value: unknown) => void = () => undefined;
    suspendSupplier.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    const tabA = suspend();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(suspendSupplier).toHaveBeenCalledTimes(1);
    expect(await suspend()).toEqual({ kind: 'BUSY' });
    expect(suspendSupplier).toHaveBeenCalledTimes(1);
    finish(lost);
    expect(((await tabA) as { kind: string }).kind).toBe('UNCONFIRMED');
  });

  it('a send that never left is not held: the next submit goes through', async () => {
    suspendSupplier.mockResolvedValue({
      kind: 'UNAVAILABLE',
      status: 503,
      correlationId: 'c',
      neverSent: true,
    });
    expect(((await suspend()) as { kind: string }).kind).toBe('FAILED');
    expect(await readUnresolved(session, supplierWriteScope(SUPPLIER_ID))).toEqual({
      kind: 'NONE',
    });
    suspendSupplier.mockResolvedValue(created);
    await expect(suspend()).rejects.toThrow('NEXT_REDIRECT');
  });

  it('the registration has a slot of its own', async () => {
    registerSupplier.mockResolvedValue(lost);
    const form = new FormData();
    form.set('displayName', 'تعمیرگاه البرز');
    form.set('capabilities', 'WORKSHOP_SERVICE');
    form.set(CSRF_FIELD, session.csrfToken);
    form.set(SUBMISSION_FIELD, mintSubmissionId(session));
    await actions.submitRegisterSupplier(IDLE_SUPPLIER_FORM as never, form);
    expect(await readUnresolved(session, supplierWriteScope(null))).toMatchObject({
      kind: 'PENDING',
    });
    expect(await readUnresolved(session, supplierWriteScope(SUPPLIER_ID))).toEqual({
      kind: 'NONE',
    });
  });

  it('with Redis down nothing is sent; once it is back the next submit goes through', async () => {
    const dead = new Redis('redis://127.0.0.1:1', {
      maxRetriesPerRequest: 1,
      commandTimeout: 500,
      retryStrategy: () => null,
    });
    dead.on('error', () => undefined);
    useUnresolvedStore(redisUnresolvedStore(dead as unknown as RedisLike));
    expect(await suspend()).toEqual({ kind: 'NOT_CHECKED' });
    expect(suspendSupplier).not.toHaveBeenCalled();
    dead.disconnect();

    useUnresolvedStore(redisUnresolvedStore(redis as unknown as RedisLike));
    suspendSupplier.mockResolvedValue(created);
    await expect(suspend()).rejects.toThrow('NEXT_REDIRECT');
    expect(suspendSupplier).toHaveBeenCalledTimes(1);
  });
});
