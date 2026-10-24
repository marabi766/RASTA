/**
 * @jest-environment node
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import type { WebSession } from './session';
import {
  UnresolvedSessionOrganization,
  actingOrganizationId,
  actingOrganizationLabel,
  actingScope,
  sessionOrganization,
  storedOrganizationFor,
  tokenOrganizationOf,
} from './session-organization';
import { actingAccessToken } from '@/test/session-token';

/**
 * One organization per request (PR 405 review 1, F1): the access token's, read
 * once, by every consumer, and refused when it cannot be told.
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

describe('what a token resolves to — the guard’s reading', () => {
  it('an organization it lists as a membership and holds a role in', () => {
    expect(tokenOrganizationOf(actingAccessToken('ORG_A'))).toEqual({
      kind: 'ORGANIZATION',
      organizationId: 'ORG_A',
    });
  });

  it('none, for a platform-wide token with no org_id', () => {
    expect(tokenOrganizationOf(jwt({ realm_access: { roles: ['SYSTEM_ADMIN'] } }))).toEqual({
      kind: 'NONE',
    });
  });

  it.each([
    ['an unreadable token', 'opaque'],
    ['a payload that is not JSON', 'h.bm90LWpzb24.s'],
    [
      'org_id not among org_ids',
      jwt({ org_id: 'ORG_A', org_ids: ['ORG_B'], org_roles: ['ORG_A:OPERATOR'] }),
    ],
    ['no role in it', jwt({ org_id: 'ORG_A', org_ids: ['ORG_A'], org_roles: [] })],
    [
      'an id the guard would refuse',
      jwt({ org_id: 'ORG_A:X', org_ids: ['ORG_A:X'], org_roles: [] }),
    ],
    ['a non-string org_id', jwt({ org_id: 7, org_ids: [7] })],
    ['a null org_id', jwt({ org_id: null })],
  ])('nothing usable for %s — a readable org_id alone is not enough', (_name, token) => {
    expect(tokenOrganizationOf(token)).toEqual({ kind: 'UNRESOLVED' });
    expect(storedOrganizationFor(token)).toBeNull();
  });
});

describe('the one answer every consumer reads', () => {
  it('is the token’s organization when the stored copy agrees', () => {
    expect(sessionOrganization(session('ORG_A'))).toBe('ORG_A');
    expect(actingOrganizationId(session('ORG_A'))).toBe('ORG_A');
    expect(actingOrganizationLabel(session('ORG_A'))).toBe('ORG_A');
    expect(actingScope(session('ORG_A'))).toBe('organization:ORG_A');
  });

  it('is none for a platform-wide session, labelled as such', () => {
    expect(actingOrganizationId(session(null))).toBeNull();
    expect(actingOrganizationLabel(session(null))).toBe('بدون سازمان فعال');
  });

  it.each([
    ['the copy says A, the token B', session('ORG_A', { accessToken: actingAccessToken('ORG_B') })],
    ['the copy says A, the token none', session('ORG_A', { accessToken: actingAccessToken(null) })],
    ['the copy says none, the token A', session(null, { accessToken: actingAccessToken('ORG_A') })],
    ['the token does not resolve', session('ORG_A', { accessToken: 'opaque' })],
  ])('cannot be told when %s: refused, never guessed', (_name, value) => {
    expect(sessionOrganization(value)).toBeUndefined();
    expect(() => actingOrganizationId(value)).toThrow(UnresolvedSessionOrganization);
    expect(() => actingOrganizationLabel(value)).toThrow(UnresolvedSessionOrganization);
    expect(() => actingScope(value)).toThrow(UnresolvedSessionOrganization);
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

  it('the 30 pages read the organization through the helper', () => {
    const pages = sources(join(SRC, 'app')).filter((path) => path.endsWith('page.tsx'));
    const shells = pages.filter((path) => readFileSync(path, 'utf8').includes('<AppShell'));
    expect(shells).toHaveLength(30);
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
