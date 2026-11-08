/**
 * @jest-environment node
 */

/**
 * FU-253 / FU-254 — the release actions of `/projects`, `/procurement/demands`, `/suppliers` and
 * `/suppliers/[id]` tell the person what happened, like the wallet, assets and drivers (#966).
 *
 * Everything below runs the real action against the real (in-memory) store of unresolved requests
 * and then the real page: the page is handed the redirect the action produced. A held request is
 * put into the store directly (`reserve` + `settle UNRESOLVED`), exactly what a lost answer leaves.
 */

import { isValidElement, type ReactElement } from 'react';
import { feedbackFor } from '@/test/release-query';
import { renderToStaticMarkup } from 'react-dom/server';

import { ReleaseFeedback } from '@/app/ReleaseFeedback';
import { CSRF_FIELD } from '@/lib/form-fields';
import { releaseMessage, type ReleaseSurface } from '@/lib/release-messages';
import { boundQuery } from '@/test/page-context';

Object.assign(process.env, {
  API_GATEWAY_URL: 'http://gateway.test:3000',
  OIDC_ISSUER_URL: 'http://keycloak.test/realms/rasta',
  OIDC_CLIENT_ID: 'rasta-web',
  WEB_PUBLIC_ORIGIN: 'http://localhost:3200',
  WEB_SESSION_SECRET: 'a-secret-that-is-long-enough-to-be-a-key',
  WEB_PROJECT_ROLES: 'ORGANIZATION_ADMIN',
});

const ORG = 'ORG-OWNER';
const SUPPLIER_ID = 'SUP_01J00000000000000000000000';
const mockSession = { current: null as unknown };

jest.mock('@/server/current-session', () => ({
  currentSession: async () => mockSession.current,
  missingSessionReason: async () => 'NO_SESSION',
}));
jest.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));
jest.mock('@/server/demo-mode', () => ({ fetchDemoMode: async () => 'UNKNOWN' }));
jest.mock('@/server/projects', () => ({
  ...jest.requireActual('@/server/projects'),
  fetchProjects: async () => ({ kind: 'FORBIDDEN' }),
  fetchApprovalInbox: async () => ({ kind: 'FORBIDDEN' }),
}));
jest.mock('@/server/demands', () => ({
  ...jest.requireActual('@/server/demands'),
  fetchDemands: async () => ({ kind: 'FORBIDDEN' }),
}));
jest.mock('@/server/suppliers', () => ({
  fetchSuppliers: async () => ({ kind: 'FORBIDDEN' }),
  fetchSupplier: async () => ({ kind: 'FORBIDDEN' }),
}));

/* eslint-disable @typescript-eslint/no-require-imports */
type Page = (props: {
  params?: Promise<Record<string, string>>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) => Promise<ReactElement>;
const ProjectsPage = (require('./projects/page') as { default: Page }).default;
const DemandsPage = (require('./procurement/demands/page') as { default: Page }).default;
const SuppliersPage = (require('./suppliers/page') as { default: Page }).default;
const SupplierPage = (require('./suppliers/[id]/page') as { default: Page }).default;
const { releaseUnresolvedCreate } =
  require('./projects/actions') as typeof import('./projects/actions');
const { releaseUnresolvedDemand } =
  require('./procurement/demands/demand-actions') as typeof import('./procurement/demands/demand-actions');
const { reconcileSupplierWrite } =
  require('./suppliers/supplier-actions') as typeof import('./suppliers/supplier-actions');
const { SupplierPendingNotices } =
  require('./suppliers/UnresolvedSupplierNotice') as typeof import('./suppliers/UnresolvedSupplierNotice');
const pending =
  require('@/server/unresolved-request') as typeof import('@/server/unresolved-request');
const { memoryUnresolvedStore, UnresolvedStoreUnavailable } =
  require('@/server/unresolved-request-store') as typeof import('@/server/unresolved-request-store');
const { pageContext } = require('@/server/page-context') as typeof import('@/server/page-context');
const { releaseFeedback } =
  require('@/server/release-feedback') as typeof import('@/server/release-feedback');
const { policyOf } =
  require('@/server/unresolved-request-policy') as typeof import('@/server/unresolved-request-policy');
const { PROJECT_CREATE_UNRESOLVED } =
  require('@/server/project-create-replay') as typeof import('@/server/project-create-replay');
const { DEMAND_SUBMIT_UNRESOLVED } =
  require('@/server/demand-replay') as typeof import('@/server/demand-replay');
const { supplierWriteScope, RECONCILED_FIELD, RECONCILED_VALUE } =
  require('@/server/supplier-unresolved') as typeof import('@/server/supplier-unresolved');
const { CONFIRM_DUPLICATE_FIELD, CONFIRM_DUPLICATE_VALUE } =
  require('./projects/form-state') as typeof import('./projects/form-state');
/* eslint-enable @typescript-eslint/no-require-imports */

import type { ReleaseSubject } from '@/server/release-feedback';
import type { UnresolvedScope } from '@/server/unresolved-request';
import type { WebSession } from '@/server/session';

const jwt = (claims: unknown): string =>
  `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;

const SESSION = {
  subject: 'user-1',
  username: 'u',
  organizationId: ORG,
  accessToken: jwt({
    org_id: ORG,
    org_ids: [ORG],
    org_roles: [`${ORG}:ORGANIZATION_ADMIN`, `${ORG}:SUPPLIER`],
  }),
  accessTokenExpiresAt: Math.floor(Date.now() / 1000) + 300,
  refreshToken: 'refresh-token-value',
  csrfToken: 'csrf-token-for-this-session',
  issuedAt: Math.floor(Date.now() / 1000) - 60,
} satisfies WebSession;

/** Every ReleaseFeedback the page puts on screen, with `SupplierPendingNotices` (a component the page mounts) expanded. */
function feedbackOn(node: unknown, out: { surface: string; outcome?: string }[] = []) {
  if (Array.isArray(node)) {
    for (const item of node) feedbackOn(item, out);
  } else if (isValidElement(node)) {
    const element = node as ReactElement<Record<string, unknown>>;
    if (element.type === ReleaseFeedback) {
      out.push(element.props as { surface: string; outcome?: string });
    } else if (element.type === SupplierPendingNotices) {
      feedbackOn(
        (SupplierPendingNotices as unknown as (p: unknown) => ReactElement)(element.props),
        out,
      );
    }
    for (const value of Object.values(element.props)) feedbackOn(value, out);
  } else if (node !== null && typeof node === 'object') {
    for (const value of Object.values(node)) feedbackOn(value, out);
  }
  return out;
}

interface Case {
  readonly name: string;
  readonly surface: ReleaseSurface;
  readonly subject: ReleaseSubject;
  readonly scope: UnresolvedScope;
  readonly back: string;
  readonly consent: readonly [string, string];
  readonly act: (form: FormData) => Promise<unknown>;
  /** `bind`: add this login's context tag, as a URL the portal drew would carry it. */
  readonly page: (query: Record<string, string>, bind?: boolean) => Promise<ReactElement>;
}

const queryOf = (query: Record<string, string>, bind = true) =>
  Promise.resolve(bind ? boundQuery(mockSession.current, query) : query);

const CASES: readonly Case[] = [
  {
    name: 'projects',
    surface: 'project-creation',
    subject: { surface: 'project-creation' },
    scope: PROJECT_CREATE_UNRESOLVED,
    back: '/projects',
    consent: [CONFIRM_DUPLICATE_FIELD, CONFIRM_DUPLICATE_VALUE],
    act: (form) => releaseUnresolvedCreate(form),
    page: (query, bind) => ProjectsPage({ searchParams: queryOf(query, bind) }),
  },
  {
    name: 'demands',
    surface: 'demand-submission',
    subject: { surface: 'demand-submission' },
    scope: DEMAND_SUBMIT_UNRESOLVED,
    back: '/procurement/demands',
    consent: [CONFIRM_DUPLICATE_FIELD, CONFIRM_DUPLICATE_VALUE],
    act: (form) => releaseUnresolvedDemand(form),
    page: (query, bind) => DemandsPage({ searchParams: queryOf(query, bind) }),
  },
  {
    name: 'supplier registration',
    surface: 'supplier-write',
    subject: { surface: 'supplier-write' },
    scope: supplierWriteScope(null),
    back: '/suppliers',
    consent: [RECONCILED_FIELD, RECONCILED_VALUE],
    act: (form) => reconcileSupplierWrite(null, form),
    page: (query, bind) => SuppliersPage({ searchParams: queryOf(query, bind) }),
  },
  {
    name: 'a supplier record',
    surface: 'supplier-record',
    subject: { surface: 'supplier-record', target: SUPPLIER_ID },
    scope: supplierWriteScope(SUPPLIER_ID),
    back: `/suppliers/${SUPPLIER_ID}`,
    consent: [RECONCILED_FIELD, RECONCILED_VALUE],
    act: (form) => reconcileSupplierWrite(SUPPLIER_ID, form),
    page: (query, bind) =>
      SupplierPage({
        params: Promise.resolve({ id: SUPPLIER_ID }),
        searchParams: queryOf(query, bind),
      }),
  },
];

/** A request that was sent and whose answer was lost: reserved, then left unresolved. */
async function lose(scope: UnresolvedScope, settle = true): Promise<void> {
  const needsDeadline = policyOf(scope.purpose)?.deadline === 'REQUIRED';
  const reserved = await pending.reserveUnresolved(SESSION, scope, {
    key: `key-${Math.random().toString(36).slice(2)}`,
    digest: 'd',
    ref: null,
    issuedAt: Date.now(),
    // A purpose whose policy keeps a replay deadline needs one that is still ahead.
    deadline: needsDeadline ? Date.now() + 3_600_000 : null,
    windowMs: needsDeadline ? 3_600_000 : null,
  });
  if (reserved.kind !== 'RESERVED') throw new Error(reserved.kind);
  if (settle) await pending.settleUnresolved(reserved.attempt, 'UNRESOLVED');
}
async function tokenFor(scope: UnresolvedScope): Promise<string> {
  const held = await pending.readUnresolved(SESSION, scope);
  if (held.kind !== 'PENDING') throw new Error(`not held: ${held.kind}`);
  return pending.releaseToken(SESSION, scope, held.request);
}
async function stateOf(scope: UnresolvedScope): Promise<string> {
  return (await pending.readUnresolved(SESSION, scope)).kind;
}

function releaseForm(
  c: Case,
  token: string | null,
  options: { csrf?: string; consent?: boolean } = {},
): FormData {
  const form = new FormData();
  form.set(CSRF_FIELD, options.csrf ?? SESSION.csrfToken);
  if (token !== null) form.set('release', token);
  if (options.consent ?? true) form.set(c.consent[0], c.consent[1]);
  return form;
}
async function landing(c: Case, form: FormData): Promise<URL> {
  const error = await c.act(form).then(
    () => new Error('no redirect'),
    (e: Error) => e,
  );
  expect(error.message).toMatch(/^NEXT_REDIRECT:/);
  const url = new URL(error.message.slice('NEXT_REDIRECT:'.length), 'http://localhost');
  // A redirect that carries an outcome carries the page's context tag too, or the page reads none of it.
  if (url.searchParams.has('release')) {
    expect(url.searchParams.get('ctx')).toBe(pageContext(SESSION));
  }
  return url;
}
/** What the page shows when the browser follows the redirect `url`: the same query, the same login. */
async function shown(c: Case, url: URL) {
  return feedbackOn(await c.page(Object.fromEntries(url.searchParams), false));
}

beforeEach(() => {
  pending.useUnresolvedStore(memoryUnresolvedStore());
  mockSession.current = SESSION;
});
afterEach(() => {
  jest.restoreAllMocks();
  pending.useUnresolvedStore(undefined);
});

describe.each(CASES)('FU-253 release feedback: $name', (c) => {
  const readBack = (url: URL, idle = true) =>
    feedbackFor(SESSION, c.subject, url.searchParams.get('release'), idle);

  it('has no feedback and no unsigned read when there was no release', async () => {
    await lose(c.scope);
    expect(await feedbackOn(await c.page({}))).toEqual([
      { surface: c.surface, outcome: undefined },
    ]);
  });

  it('STALE: a form for another record says so; the hold stays', async () => {
    await lose(c.scope);
    const url = await landing(c, releaseForm(c, 'garbage'));
    expect(url.pathname).toBe(c.back);
    expect(readBack(url)).toBe('STALE');
    expect(await stateOf(c.scope)).toBe('PENDING');
    expect(await shown(c, url)).toEqual([{ surface: c.surface, outcome: 'STALE' }]);
  });

  it('IN_PROGRESS: a send under way says so; the hold stays', async () => {
    await lose(c.scope, false);
    const token = await tokenFor(c.scope);
    const url = await landing(c, releaseForm(c, token));
    expect(readBack(url)).toBe('IN_PROGRESS');
    expect(await stateOf(c.scope)).toBe('PENDING');
    expect(await shown(c, url)).toEqual([{ surface: c.surface, outcome: 'IN_PROGRESS' }]);
  });

  it('UNAVAILABLE: a store that cannot answer says so (nothing is claimed released); the hold stays', async () => {
    const store = memoryUnresolvedStore();
    pending.useUnresolvedStore(store);
    await lose(c.scope);
    const token = await tokenFor(c.scope);
    jest.spyOn(store, 'release').mockRejectedValue(new UnresolvedStoreUnavailable());
    const url = await landing(c, releaseForm(c, token));
    expect(readBack(url)).toBe('UNAVAILABLE');
    jest.restoreAllMocks();
    expect(await stateOf(c.scope)).toBe('PENDING');
    expect(await shown(c, url)).toEqual([{ surface: c.surface, outcome: 'UNAVAILABLE' }]);
  });

  it('GONE: the record was released elsewhere; the stale form says it is gone, not released', async () => {
    await lose(c.scope);
    const token = await tokenFor(c.scope);
    await landing(c, releaseForm(c, token)); // the other tab
    const url = await landing(c, releaseForm(c, token));
    expect(readBack(url)).toBe('GONE');
    expect(await shown(c, url)).toEqual([{ surface: c.surface, outcome: 'GONE' }]);
  });

  it('RELEASED: a real success keeps today’s plain redirect, the hold is gone, nothing is shown', async () => {
    await lose(c.scope);
    const url = await landing(c, releaseForm(c, await tokenFor(c.scope)));
    expect(url.pathname).toBe(c.back);
    expect(url.search).toBe('');
    expect(await stateOf(c.scope)).toBe('NONE');
    expect(await shown(c, url)).toEqual([{ surface: c.surface, outcome: undefined }]);
  });

  it.each([
    ['CSRF_REFUSED', { csrf: 'wrong' }],
    ['CONSENT_MISSING', { consent: false }],
  ] as const)('%s: says so, asks the store nothing, the hold stays', async (outcome, options) => {
    const store = memoryUnresolvedStore();
    pending.useUnresolvedStore(store);
    await lose(c.scope);
    const token = await tokenFor(c.scope);
    const spy = jest.spyOn(store, 'release');
    const url = await landing(c, releaseForm(c, token, options));
    expect(spy).not.toHaveBeenCalled();
    expect(readBack(url)).toBe(outcome);
    expect(await stateOf(c.scope)).toBe('PENDING');
    expect(await shown(c, url)).toEqual([{ surface: c.surface, outcome }]);
  });

  it('an answer it does not know is NOT_DONE, never a success', async () => {
    const store = memoryUnresolvedStore();
    pending.useUnresolvedStore(store);
    await lose(c.scope);
    const token = await tokenFor(c.scope);
    jest.spyOn(store, 'release').mockResolvedValue('SOMETHING_NEW' as never);
    const url = await landing(c, releaseForm(c, token));
    expect(url.searchParams.has('release')).toBe(true);
    expect(readBack(url)).toBe('NOT_DONE');
    expect(await shown(c, url)).toEqual([{ surface: c.surface, outcome: 'NOT_DONE' }]);
  });

  it('every shown outcome renders as its own honest sentence for this surface', () => {
    for (const outcome of ['STALE', 'IN_PROGRESS', 'UNAVAILABLE', 'GONE', 'CSRF_REFUSED']) {
      const markup = renderToStaticMarkup(
        <ReleaseFeedback surface={c.surface} outcome={outcome} />,
      );
      expect(markup).toContain(releaseMessage(outcome, c.surface));
    }
  });

  it.each(['STALE', 'IN_PROGRESS', 'UNAVAILABLE', 'GONE', 'RELEASED', 'CSRF_REFUSED'])(
    'P1: an unsigned ?release=%s from the URL shows nothing',
    async (word) => {
      await lose(c.scope);
      expect(await feedbackOn(await c.page({ release: word }))).toEqual([
        { surface: c.surface, outcome: undefined },
      ]);
    },
  );

  it.each(['GONE', 'RELEASED'])('a newer hold wins over a replayed %s', async (outcome) => {
    const token = releaseFeedback(SESSION, c.subject, outcome);
    await lose(c.scope);
    expect(await feedbackOn(await c.page({ release: token }))).toEqual([
      { surface: c.surface, outcome: undefined },
    ]);
    pending.useUnresolvedStore(memoryUnresolvedStore());
    expect(await feedbackOn(await c.page({ release: token }))).toEqual([
      { surface: c.surface, outcome },
    ]);
  });

  it('shows a refusal while the hold remains (the hold did not go)', async () => {
    await lose(c.scope);
    const token = releaseFeedback(SESSION, c.subject, 'STALE');
    expect(await feedbackOn(await c.page({ release: token }))).toEqual([
      { surface: c.surface, outcome: 'STALE' },
    ]);
  });

  it('accepts no other surface’s or target’s token (L1)', async () => {
    for (const other of CASES.filter((o) => o !== c)) {
      const token = releaseFeedback(SESSION, other.subject, 'STALE');
      expect(await feedbackOn(await c.page({ release: token }))).toEqual([
        { surface: c.surface, outcome: undefined },
      ]);
    }
    // …nor the old route-literal subjects.
    for (const literal of ['/assets', '/drivers', c.back]) {
      const token = releaseFeedback(SESSION, { surface: c.surface, target: literal }, 'STALE');
      expect(await feedbackOn(await c.page({ release: token }))).toEqual([
        { surface: c.surface, outcome: undefined },
      ]);
    }
  });

  it('bounds the token to this login', async () => {
    const token = releaseFeedback({ ...SESSION, csrfToken: 'another-login' }, c.subject, 'STALE');
    expect(await feedbackOn(await c.page({ release: token }))).toEqual([
      { surface: c.surface, outcome: undefined },
    ]);
  });
});
