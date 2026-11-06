/**
 * @jest-environment node
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import type { WebSession } from './session';
import {
  NoActingOrganization,
  UnresolvedSessionOrganization,
  actingOrganizationId,
  actingOrganizationLabel,
  actingScope,
  credentialHeaders,
  organizationLost,
  personalCredential,
  pinnedOrganizationFor,
  sessionAuthority,
  sessionOrganization,
  sessionRoles,
  sessionWriteRoles,
  tenantCredential,
} from './session-organization';
import { actingAccessToken } from '@/test/session-token';

/**
 * One organization per session (task 118, audit F2): the one it was pinned to
 * at sign-in, acted for only while its token grants it a role, sent with every
 * gateway call, and never moved to the token's active organization.
 */

const jwt = (claims: unknown): string =>
  `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;

function session(org: string | null, overrides: Partial<WebSession> = {}): WebSession {
  return {
    subject: 'USR_1',
    username: 'u',
    organizationId: org,
    accessToken: actingAccessToken(org),
    accessTokenExpiresAt: 2_000_000_000,
    refreshToken: 'r',
    csrfToken: 'c',
    issuedAt: 1_900_000_000,
    ...overrides,
  };
}

/** A token whose active organization is B, still granting A `rolesInA` (none: not a member). */
const activeInB = (rolesInA: string[] | null, rolesInB: string[] = ['OPERATOR']) =>
  jwt({
    org_id: 'ORG_B',
    org_ids: rolesInA === null ? ['ORG_B'] : ['ORG_A', 'ORG_B'],
    org_roles: [
      ...(rolesInA ?? []).map((role) => `ORG_A:${role}`),
      ...rolesInB.map((role) => `ORG_B:${role}`),
    ],
  });

describe('what a sign-in pins', () => {
  it('the access token’s active organization, as it names it', () => {
    expect(pinnedOrganizationFor(actingAccessToken('ORG_A'))).toBe('ORG_A');
    // Even one it grants nothing in: such a session is recovered, never acted for.
    expect(pinnedOrganizationFor(jwt({ org_id: 'ORG_A', org_ids: [], org_roles: [] }))).toBe(
      'ORG_A',
    );
  });

  it.each([
    ['a platform-wide token with no org_id', jwt({ realm_access: { roles: ['SYSTEM_ADMIN'] } })],
    ['an unreadable token', 'opaque'],
    ['an id the guard would refuse', jwt({ org_id: 'ORG_A:X' })],
    ['a non-string org_id', jwt({ org_id: 7 })],
  ])('none for %s', (_name, token) => {
    expect(pinnedOrganizationFor(token)).toBeNull();
  });
});

describe('the one answer every consumer reads', () => {
  it('is the pinned organization while the token grants it a role', () => {
    expect(sessionOrganization(session('ORG_A'))).toBe('ORG_A');
    expect(actingOrganizationId(session('ORG_A'))).toBe('ORG_A');
    expect(actingOrganizationLabel(session('ORG_A'))).toBe('ORG_A');
    expect(actingScope(session('ORG_A'))).toBe('organization:ORG_A');
  });

  it('stays the pinned organization after the account was switched to B elsewhere (audit F2)', () => {
    const switched = session('ORG_A', { accessToken: activeInB(['FLEET_MANAGER']) });
    expect(sessionOrganization(switched)).toBe('ORG_A');
    expect(actingOrganizationLabel(switched)).toBe('ORG_A');
    expect(organizationLost(switched)).toBe(false);
  });

  it('is none for a session pinned to none, labelled as such', () => {
    expect(actingOrganizationId(session(null))).toBeNull();
    expect(actingOrganizationLabel(session(null))).toBe('بدون سازمان فعال');
    // Its token may be active in B since: still none, never B.
    expect(sessionOrganization(session(null, { accessToken: actingAccessToken('ORG_B') }))).toBe(
      null,
    );
  });

  it.each([
    ['the membership in A was removed', session('ORG_A', { accessToken: activeInB(null) })],
    ['every role in A was removed', session('ORG_A', { accessToken: activeInB([]) })],
    ['the token names none', session('ORG_A', { accessToken: actingAccessToken(null) })],
    ['the token does not resolve', session('ORG_A', { accessToken: 'opaque' })],
    [
      'A is held only with a role the portal does not know',
      session('ORG_A', { accessToken: activeInB(['NOT_A_ROLE']) }),
    ],
  ])('cannot act when %s: refused, never moved to B', (_name, value) => {
    expect(sessionOrganization(value)).toBeUndefined();
    expect(() => actingOrganizationId(value)).toThrow(UnresolvedSessionOrganization);
    expect(() => actingOrganizationLabel(value)).toThrow(UnresolvedSessionOrganization);
    expect(() => actingScope(value)).toThrow(UnresolvedSessionOrganization);
    expect(sessionAuthority(value)).toBeNull();
    expect(() => tenantCredential(value)).toThrow(UnresolvedSessionOrganization);
    expect(() => personalCredential(value)).toThrow(UnresolvedSessionOrganization);
  });

  it('says the organization was lost only for a pinned one the token no longer grants', () => {
    expect(organizationLost(session('ORG_A', { accessToken: activeInB(null) }))).toBe(true);
    expect(organizationLost(session('ORG_A'))).toBe(false);
    expect(organizationLost(session(null))).toBe(false);
  });

  it('a session pinned to none whose token’s own organization grants nothing cannot act either', () => {
    const value = session(null, { accessToken: jwt({ org_id: 'ORG_B', org_ids: ['ORG_B'] }) });
    expect(sessionOrganization(value)).toBeUndefined();
    expect(organizationLost(value)).toBe(false);
  });
});

describe('what is drawn follows the pinned organization, not the token’s active one (addendum C)', () => {
  it('the roles are A’s, from the token’s tenant-bound claim for A', () => {
    const switched = session('ORG_A', {
      accessToken: activeInB(['FLEET_MANAGER'], ['ORGANIZATION_ADMIN']),
    });
    expect(sessionAuthority(switched)).toEqual({
      organizationId: 'ORG_A',
      roles: ['FLEET_MANAGER'],
    });
    expect(sessionRoles(switched)).toEqual(['FLEET_MANAGER']);
    expect(sessionWriteRoles(switched)).toEqual(['FLEET_MANAGER']);
  });

  it('a session pinned to none: global roles only, and no write form', () => {
    const none = session(null, {
      accessToken: jwt({ realm_access: { roles: ['SYSTEM_ADMIN'] } }),
    });
    expect(sessionRoles(none)).toEqual(['SYSTEM_ADMIN']);
    expect(sessionWriteRoles(none)).toBeNull();
  });
});

describe('what a gateway call is sent with', () => {
  it('a tenant call names the pinned organization beside the bearer', () => {
    const switched = session('ORG_A', { accessToken: activeInB(['OPERATOR']) });
    expect(credentialHeaders(tenantCredential(switched))).toEqual({
      authorization: `Bearer ${activeInB(['OPERATOR'])}`,
      'x-organization-id': 'ORG_A',
    });
  });

  it('a session pinned to none sends no tenant call at all — never a header-less one', () => {
    expect(() => tenantCredential(session(null))).toThrow(NoActingOrganization);
  });

  it('the person’s own record: the pinned organization when there is one, no header otherwise', () => {
    expect(credentialHeaders(personalCredential(session('ORG_A')))).toEqual({
      authorization: `Bearer ${actingAccessToken('ORG_A')}`,
      'x-organization-id': 'ORG_A',
    });
    expect(credentialHeaders(personalCredential(session(null)))).toEqual({
      authorization: `Bearer ${actingAccessToken(null)}`,
    });
  });

  it('refuses a credential this module did not mint', () => {
    expect(() => credentialHeaders({ accessToken: 't', organizationId: 'ORG_A' })).toThrow(
      /credential from session-organization/,
    );
    const minted = tenantCredential(session('ORG_A'));
    expect(() => credentialHeaders({ ...minted })).toThrow(/credential from session-organization/);
    expect(Object.isFrozen(minted)).toBe(true);
  });
});

/**
 * The class, closed mechanically: outside the session boundary no source file
 * reads a session's stored `organizationId` — every page label, filter,
 * profile read, form binding and remembered-submission tag goes through
 * `actingOrganizationId` (PR 405 review 1 listed 31 page reads, `viewOf` and
 * `submissionBinding`).
 */
describe('nothing outside the boundary reads the stored copy', () => {
  const SRC = join(__dirname, '..');
  /** Where the copy is written and checked — and nowhere else. */
  const BOUNDARY = new Set([
    'server/session-organization.ts',
    'server/session-refresh.ts',
    'server/session.ts',
    'app/auth/callback/route.ts',
  ]);
  /** A session's field read by name: `session.organizationId`, `gated.session?.organizationId`, `{ organizationId } = session`. */
  const READS = [
    /\b\w*[sS]ession\??\.organizationId\b/,
    /\{[^}]*\borganizationId\b[^}]*\}\s*=\s*\w*[sS]ession\b/,
  ];

  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return name === 'test' ? [] : sources(path);
      return /\.(ts|tsx)$/.test(name) && !/\.spec\.tsx?$/.test(name) ? [path] : [];
    });
  }

  it('finds no read in any page, component, action or server module', () => {
    const offenders = sources(SRC)
      .map((path) => ({ file: relative(SRC, path), text: readFileSync(path, 'utf8') }))
      .filter(({ file }) => !BOUNDARY.has(file))
      .filter(({ text }) => READS.some((pattern) => pattern.test(text)))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  it('the guard itself sees a read when there is one', () => {
    expect(READS.some((pattern) => pattern.test('label(session.organizationId)'))).toBe(true);
    expect(READS.some((pattern) => pattern.test('gated.session?.organizationId'))).toBe(true);
    expect(READS.some((pattern) => pattern.test('const { organizationId } = session'))).toBe(true);
    expect(READS.some((pattern) => pattern.test('contract.organizationId'))).toBe(false);
  });

  /**
   * Every gateway call names the session's organization (task 118): the
   * credential is the only way to send a bearer, and every call site mints it
   * from the session — `personalCredential` only for the person's own record.
   */
  it('every callGateway call passes a credential minted from the session', () => {
    const CALL = /callGateway(?:<[^>]*>)?\(\{([\s\S]*?)\}\)/g;
    const calls = sources(SRC)
      .filter((path) => !path.endsWith('server/gateway.ts'))
      .flatMap((path) =>
        [...readFileSync(path, 'utf8').matchAll(CALL)].map((match) => ({
          file: relative(SRC, path),
          body: match[1]!,
        })),
      );
    expect(calls.length).toBeGreaterThanOrEqual(24);
    const offenders = calls.filter(
      ({ body }) =>
        !/\bcredential: (tenantCredential|personalCredential)\(session\),/.test(body) ||
        /\baccessToken\b/.test(body),
    );
    expect(offenders).toEqual([]);
    const personal = calls.filter(({ body }) => body.includes('personalCredential('));
    expect(
      personal.map(({ file, body }) => ({ file, me: body.includes("'/v1/users/me'") })),
    ).toEqual([{ file: 'server/identity.ts', me: true }]);
  });

  it('no source but the boundary names the header, mints a credential or reads authority from a bare token', () => {
    // Code, not prose: comments may say what the header is for.
    const code = (text: string) =>
      text
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .map((line) => line.replace(/(^|\s)\/\/.*$/, ''))
        .join('\n');
    const offenders = sources(SRC)
      .map((path) => ({ file: relative(SRC, path), text: code(readFileSync(path, 'utf8')) }))
      .filter(({ file }) => file !== 'server/session-organization.ts')
      .filter(
        ({ file, text }) =>
          /x-organization-id/i.test(text) ||
          (file !== 'server/realm-roles.ts' &&
            /\btoken(Authority|ActiveOrganization)\(/.test(text)),
      )
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  it('the guards see a header-less call and a hand-built header when there is one', () => {
    const CALL = /callGateway(?:<[^>]*>)?\(\{([\s\S]*?)\}\)/g;
    const body = [
      ...'callGateway<unknown>({ baseUrl, path, accessToken: session.accessToken, })'.matchAll(
        CALL,
      ),
    ][0]![1]!;
    expect(/\bcredential: (tenantCredential|personalCredential)\(session\),/.test(body)).toBe(
      false,
    );
    expect(/x-organization-id/i.test("headers: { 'X-Organization-Id': org }")).toBe(true);
  });

  it('the 33 pages read the organization through the helper', () => {
    const pages = sources(join(SRC, 'app')).filter((path) => path.endsWith('page.tsx'));
    const shells = pages.filter((path) => readFileSync(path, 'utf8').includes('<AppShell'));
    expect(shells).toHaveLength(33);
    for (const path of shells) {
      const text = readFileSync(path, 'utf8');
      expect({ path, scoped: /<AppShell\s+key=\{actingScope\(session\)\}/.test(text) }).toEqual({
        path,
        scoped: true,
      });
      expect({ path, labelled: /actingOrganization(Label|Id)\(session\)/.test(text) }).toEqual({
        path,
        labelled: true,
      });
    }
  });
});
