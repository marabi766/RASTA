/** @jest-environment node */
import { Children, isValidElement, type ReactNode } from 'react';
import { assetRegistrationRequest, driverCreationRequest } from '@/server/create-request';
import { useUnresolvedStore as setUnresolvedStore } from '@/server/unresolved-request';
import {
  memoryUnresolvedStore,
  UnresolvedStoreUnavailable,
} from '@/server/unresolved-request-store';
import { mintSubmissionId, SUBMISSION_FIELD } from '@/server/submission';
import { actingAccessToken } from '@/test/session-token';
import { EMPTY_REGISTER_ASSET_FORM } from '@/lib/asset-form-fields';
import { EMPTY_CREATE_DRIVER_FORM } from '@/lib/driver-fields';
import type { WebSession } from '@/server/session';
import AssetsPage from './assets/page';
import DriversPage from './drivers/page';
import { submitRegisterAsset, releaseUnresolvedAssetRegistration } from './assets/actions';
import { submitCreateDriver, releaseUnresolvedDriverCreation } from './drivers/actions';

Object.assign(process.env, {
  API_GATEWAY_URL: 'http://gateway.test:3000',
  OIDC_ISSUER_URL: 'http://keycloak.test/realms/rasta',
  OIDC_CLIENT_ID: 'rasta-web',
  WEB_PUBLIC_ORIGIN: 'http://localhost:3200',
  WEB_SESSION_SECRET: 'a-secret-that-is-long-enough-to-be-a-key',
});

const session = {
  subject: 'USER_1',
  username: 'manager',
  organizationId: 'ORG_1',
  accessToken: actingAccessToken('ORG_1', ['FLEET_MANAGER', 'ASSET_MANAGER']),
  accessTokenExpiresAt: 2_000_000_000,
  refreshToken: 'unused',
  csrfToken: 'csrf',
  issuedAt: 1,
} satisfies WebSession;
const currentSession = jest.fn();
const asset = jest.fn();
const driver = jest.fn();
jest.mock('@/server/current-session', () => ({ currentSession: () => currentSession() }));
jest.mock('next/navigation', () => ({
  redirect: () => {
    throw new Error('REDIRECT');
  },
}));
jest.mock('@/server/asset-commands', () => ({
  ...jest.requireActual('@/server/asset-commands'),
  registerAsset: (...args: unknown[]) => asset(...args),
}));
jest.mock('@/server/assets', () => ({ fetchAssets: async () => ({ kind: 'FORBIDDEN' }) }));
jest.mock('@/server/drivers', () => ({
  ...jest.requireActual('@/server/drivers'),
  createDriver: (...args: unknown[]) => driver(...args),
  fetchDrivers: async () => ({ kind: 'FORBIDDEN' }),
}));
jest.mock('@/server/driver-roster', () => ({
  loadDriverRoster: async () => ({
    kind: 'LISTED',
    candidates: [],
    names: {},
  }),
}));

function form(fields: Record<string, string>, key = mintSubmissionId(session)): FormData {
  const data = new FormData();
  Object.entries(fields).forEach(([k, v]) => data.set(k, v));
  data.set('csrf', session.csrfToken);
  data.set(SUBMISSION_FIELD, key);
  return data;
}
function initialStates(node: ReactNode): unknown[] {
  return Children.toArray(node).flatMap((child) => {
    if (
      !isValidElement<{ initialState?: unknown; children?: ReactNode; registerForm?: ReactNode }>(
        child,
      )
    )
      return [];
    return child.props.initialState
      ? [child.props.initialState]
      : [...initialStates(child.props.children), ...initialStates(child.props.registerForm)];
  });
}

const cases: {
  name: string;
  request: typeof assetRegistrationRequest | typeof driverCreationRequest;
  dispatch: jest.Mock;
  page: typeof AssetsPage;
  valid: Record<string, string>;
  edit: Record<string, string>;
  submit: (
    data: FormData,
  ) => ReturnType<typeof submitRegisterAsset> | ReturnType<typeof submitCreateDriver>;
  release: typeof releaseUnresolvedAssetRegistration;
}[] = [
  {
    name: 'asset',
    release: releaseUnresolvedAssetRegistration,
    request: assetRegistrationRequest,
    dispatch: asset,
    page: AssetsPage,
    valid: { name: 'لودر', type: 'LOADER', addressLine: 'الف\r\nب' },
    edit: { name: 'ماشین تازه', type: 'LOADER' },
    submit: (data: FormData) => submitRegisterAsset({ kind: 'IDLE' }, data),
  },
  {
    name: 'driver',
    release: releaseUnresolvedDriverCreation,
    request: driverCreationRequest,
    dispatch: driver,
    page: DriversPage,
    valid: { userId: 'USR_01J00000000000000000000000', notes: 'الف\r\nب' },
    edit: { userId: 'USR_01J00000000000000000000000', employeeNo: 'changed' },
    submit: (data: FormData) => submitCreateDriver({ kind: 'IDLE' }, data),
  },
];
beforeEach(() => {
  setUnresolvedStore(memoryUnresolvedStore());
  currentSession.mockResolvedValue(session);
  asset.mockReset();
  driver.mockReset();
});
describe.each(cases)('FU-190 $name reload reservation', (c) => {
  it.each(['UNKNOWN_OUTCOME', 'IN_PROGRESS', 'UNAVAILABLE'])(
    'restores key, values and resume state after %s',
    async (kind) => {
      c.dispatch.mockResolvedValue({ kind, status: 503, correlationId: 'lost' });
      const data = form(c.valid);
      const submissionId = data.get(SUBMISSION_FIELD);
      const first = await c.submit(data);
      expect(first).toMatchObject({ kind: 'UNCONFIRMED', submissionId });
      const held = await c.request.restore(session);
      expect(held).toMatchObject({ kind: 'HELD', submissionId });
      if (held.kind !== 'HELD') throw new Error('missing hold');
      if (first.kind !== 'UNCONFIRMED') throw new Error('missing unknown outcome');
      expect(held.values).toEqual(first.values);
      expect(JSON.stringify(held.values)).not.toContain('\\r');
      for (const key of [String(submissionId), mintSubmissionId(session)])
        expect(await c.submit(form(c.edit, key))).toMatchObject({
          ...held,
          releaseToken: expect.any(String),
        });
      expect(c.dispatch).toHaveBeenCalledTimes(1);
      expect(initialStates(await c.page({ searchParams: Promise.resolve({}) }))).toContainEqual(
        expect.objectContaining({ ...held, releaseToken: expect.any(String) }),
      );
    },
  );
  it.each([false, true])('reserves once for racing tabs (reverse bodies: %s)', async (reverse) => {
    const store = memoryUnresolvedStore();
    setUnresolvedStore(store);
    const read = store.read.bind(store);
    let reads = 0;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    jest.spyOn(store, 'read').mockImplementation(async (...args) => {
      const result = await read(...args);
      if (++reads <= 2) {
        if (reads === 2) release();
        await ready;
      }
      return result;
    });
    c.dispatch.mockResolvedValue({ kind: 'UNKNOWN_OUTCOME', correlationId: 'lost' });
    const bodies = reverse ? [c.edit, c.valid] : [c.valid, c.edit];
    const key = mintSubmissionId(session);
    const answers = await Promise.all(bodies.map((body) => c.submit(form(body, key))));
    expect(answers.map((a) => a.kind).sort()).toEqual(['HELD', 'UNCONFIRMED']);
    expect(c.dispatch).toHaveBeenCalledTimes(1);
  });
  it('holds in-flight sends, aged leases and exceptions; isolates tenant, actor and login', async () => {
    let now = Date.now();
    setUnresolvedStore(memoryUnresolvedStore(() => now));
    let start!: () => void;
    let fail!: (error: Error) => void;
    const started = new Promise<void>((resolve) => {
      start = resolve;
    });
    c.dispatch.mockImplementation(() => {
      start();
      return new Promise((_, reject) => {
        fail = reject;
      });
    });
    const sending = c.submit(form(c.valid));
    await started;
    expect((await c.submit(form(c.edit))).kind).toBe('HELD');
    fail(new Error('lost'));
    await expect(sending).rejects.toThrow('lost');
    now += 2 * 86400000;
    expect((await c.submit(form(c.valid))).kind).toBe('HELD');
    for (const other of [
      { ...session, subject: 'other' },
      { ...session, csrfToken: 'other-login' },
      { ...session, organizationId: 'ORG_2', accessToken: actingAccessToken('ORG_2') },
    ])
      expect((await c.request.restore(other)).kind).toBe('IDLE');
    expect(c.dispatch).toHaveBeenCalledTimes(1);
  });
  it('fails closed for unreadable/corrupt stores and failed reservations', async () => {
    for (const method of ['read', 'reserve'] as const) {
      const store = memoryUnresolvedStore();
      setUnresolvedStore(store);
      jest.spyOn(store, method).mockRejectedValue(new UnresolvedStoreUnavailable());
      expect(await c.submit(form(c.valid))).toMatchObject({
        kind: 'NOT_CHECKED',
        reason: 'STORE_UNAVAILABLE',
      });
    }
    expect(c.dispatch).not.toHaveBeenCalled();
    const store = memoryUnresolvedStore();
    setUnresolvedStore(store);
    c.dispatch.mockResolvedValue({ kind: 'UNKNOWN_OUTCOME', correlationId: 'lost' });
    await c.submit(form(c.valid));
    for (const [key, raw] of store.records)
      store.records.set(key, JSON.stringify({ ...JSON.parse(raw), ref: 'corrupt' }));
    expect(await c.submit(form(c.edit))).toMatchObject({
      kind: 'NOT_CHECKED',
      reason: 'SNAPSHOT_UNREADABLE',
    });
    for (const [key, raw] of store.records)
      store.records.set(key, JSON.stringify({ ...JSON.parse(raw), state: 'BROKEN' }));
    expect(await c.request.restore(session)).toMatchObject({
      kind: 'NOT_CHECKED',
      reason: 'CORRUPT_RECORD',
    });
    expect(c.dispatch).toHaveBeenCalledTimes(1);
  });
  it.each(['UNRESOLVED', 'AGED', 'LOST_CONFIRMATION', 'FORMER', 'CORRUPT'])(
    'F1: offers a signed exit for %s without replaying',
    async (cause) => {
      let now = Date.now();
      const store = memoryUnresolvedStore(() => now);
      setUnresolvedStore(store);
      if (cause === 'AGED' || cause === 'LOST_CONFIRMATION')
        jest.spyOn(store, 'settle').mockRejectedValueOnce(new UnresolvedStoreUnavailable());
      c.dispatch.mockResolvedValue({
        kind: cause === 'LOST_CONFIRMATION' ? 'CREATED' : 'UNKNOWN_OUTCOME',
        data: { id: 'ID_1' },
        correlationId: 'lost',
      });
      await c.submit(form(c.valid)).catch((error) => {
        if (!String(error).includes('REDIRECT')) throw error;
      });
      if (cause === 'AGED' || cause === 'LOST_CONFIRMATION') now += 3600000;
      if (cause === 'CORRUPT')
        for (const [key, raw] of store.records)
          store.records.set(key, JSON.stringify({ ...JSON.parse(raw), ref: 'corrupt' }));
      const acting =
        cause === 'FORMER'
          ? {
              ...session,
              organizationId: 'ORG_2',
              accessToken: actingAccessToken('ORG_2'),
              formerOrganizationId: session.organizationId,
            }
          : session;
      currentSession.mockResolvedValue(acting);
      const held = await c.request.restore(acting);
      if (cause === 'FORMER') expect(held).toMatchObject({ reason: 'FORMER_COPY' });
      expect(held.kind).toBe(cause === 'FORMER' || cause === 'CORRUPT' ? 'NOT_CHECKED' : 'HELD');
      if (!('releaseToken' in held) || !held.releaseToken)
        throw new Error('missing reconciliation exit');
      const data = form({ release: held.releaseToken });
      await expect(c.release(data)).rejects.toThrow('REDIRECT');
      expect((await c.request.restore(acting)).kind).toBe(held.kind);
      data.set('confirmDuplicate', 'yes');
      data.set('csrf', 'wrong');
      await expect(c.release(data)).rejects.toThrow('REDIRECT');
      expect((await c.request.restore(acting)).kind).toBe(held.kind);
      data.set('csrf', session.csrfToken);
      await expect(c.release(data)).rejects.toThrow('REDIRECT');
      if (cause === 'AGED' || cause === 'LOST_CONFIRMATION') {
        expect((await c.request.restore(acting)).kind).toBe('HELD');
        await expect(c.release(data)).rejects.toThrow('REDIRECT');
      }
      const fresh = await c.request.restore(acting);
      expect(fresh.kind).toBe('IDLE');
      expect(fresh.submissionId).not.toBe(held.submissionId);
      // A late release must never delete a newer generation.
      currentSession.mockResolvedValue(session);
      c.dispatch.mockResolvedValue({ kind: 'UNKNOWN_OUTCOME', correlationId: 'second' });
      await c.submit(form(c.valid));
      await expect(c.release(data)).rejects.toThrow('REDIRECT');
      expect((await c.request.restore(session)).kind).toBe('HELD');
      expect(c.dispatch).toHaveBeenCalledTimes(2);
    },
  );
  it('keeps the reconciliation notice when write permissions are lost', async () => {
    c.dispatch.mockResolvedValue({ kind: 'UNKNOWN_OUTCOME', correlationId: 'lost' });
    await c.submit(form(c.valid));
    const held = await c.request.restore(session);
    if (!('releaseToken' in held)) throw new Error('missing exit');
    currentSession.mockResolvedValue({
      ...session,
      accessToken: actingAccessToken(session.organizationId, ['OPERATOR']),
    });
    const page = await c.page({ searchParams: Promise.resolve({}) });
    expect(initialStates(page)).toEqual([]);
    expect(JSON.stringify(page)).toContain('"releaseToken":');
  });
  it('retains a fresh active lease when reconciliation is requested', async () => {
    let start!: () => void;
    let finish!: (result: unknown) => void;
    const started = new Promise<void>((resolve) => {
      start = resolve;
    });
    c.dispatch.mockImplementation(() => {
      start();
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const sending = c.submit(form(c.valid));
    await started;
    const held = await c.request.restore(session);
    if (!('releaseToken' in held) || !held.releaseToken) throw new Error('missing exit');
    await expect(
      c.release(form({ release: held.releaseToken, confirmDuplicate: 'yes' })),
    ).rejects.toThrow('REDIRECT');
    expect((await c.request.restore(session)).kind).toBe('HELD');
    finish({ kind: 'UNKNOWN_OUTCOME', correlationId: 'lost' });
    await sending;
    expect(c.dispatch).toHaveBeenCalledTimes(1);
  });
  it('distinguishes capacity before dispatch', async () => {
    const store = memoryUnresolvedStore();
    setUnresolvedStore(store);
    jest.spyOn(store, 'reserve').mockResolvedValue({ kind: 'CAPACITY' });
    expect(await c.submit(form(c.valid))).toMatchObject({
      kind: 'NOT_CHECKED',
      reason: 'CAPACITY',
    });
    expect(c.dispatch).not.toHaveBeenCalled();
  });
  it('releases proven refusals and keeps snapshots bounded', async () => {
    c.dispatch.mockResolvedValue({
      kind: 'UNAVAILABLE',
      status: 429,
      code: 'RATE_LIMIT_EXCEEDED',
      correlationId: 'refused',
    });
    await c.submit(form(c.valid));
    expect((await c.request.restore(session)).kind).toBe('IDLE');
    const values =
      'name' in c.valid
        ? assetRegistrationRequest.values({ ...EMPTY_REGISTER_ASSET_FORM, ...c.valid })
        : driverCreationRequest.values({ ...EMPTY_CREATE_DRIVER_FORM, ...c.valid });
    const huge = Object.fromEntries(Object.keys(values).map((field) => [field, 'x'.repeat(20000)]));
    const dispatch = jest.fn();
    // Same shared helper, refusing before the dispatch if the encrypted snapshot cannot be stored.
    expect(
      await c.request.send(
        session,
        mintSubmissionId(session),
        huge as typeof EMPTY_REGISTER_ASSET_FORM & typeof EMPTY_CREATE_DRIVER_FORM,
        {},
        dispatch,
      ),
    ).toEqual({ kind: 'NOT_CHECKED', reason: 'SNAPSHOT_TOO_LARGE' });
    expect(dispatch).not.toHaveBeenCalled();
  });
});
