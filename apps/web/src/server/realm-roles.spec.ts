/**
 * @jest-environment node
 */
import { globalRealmRoles, requestRoles, tokenAuthority } from './realm-roles';
import { tenderDoorsFor, tenderSidesFor } from './portal-nav';

const token = (claims: unknown): string =>
  `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;

const DEFAULTS = { WEB_PROJECT_ROLES: ['ORGANIZATION_ADMIN'], WEB_PROJECT_READER_ROLES: [] };

describe('globalRealmRoles', () => {
  it.each([
    {
      name: 'the global role',
      jwt: token({ realm_access: { roles: ['SYSTEM_ADMIN', 'x'] } }),
      want: ['SYSTEM_ADMIN'],
    },
    {
      name: 'the global role once when repeated',
      jwt: token({ realm_access: { roles: ['SYSTEM_ADMIN', 'SYSTEM_ADMIN'] } }),
      want: ['SYSTEM_ADMIN'],
    },
    {
      name: 'a non-global role only',
      jwt: token({ realm_access: { roles: ['UNION_ADMIN'] } }),
      want: [],
    },
    { name: 'no realm_access', jwt: token({}), want: [] },
    {
      name: 'roles not an array',
      jwt: token({ realm_access: { roles: 'SYSTEM_ADMIN' } }),
      want: [],
    },
    { name: 'a non-object payload', jwt: token('SYSTEM_ADMIN'), want: [] },
    { name: 'non-JSON payload', jwt: 'h.!!!.s', want: [] },
    { name: 'no payload segment', jwt: 'opaque', want: [] },
  ])('reads $name', ({ jwt, want }) => {
    expect(globalRealmRoles(jwt)).toEqual(want);
  });
});

describe('requestRoles', () => {
  it('is the membership roles plus the global realm roles, once each', () => {
    const jwt = token({ realm_access: { roles: ['SYSTEM_ADMIN'] } });
    expect(requestRoles(['CONTRACTOR'], jwt)).toEqual(['CONTRACTOR', 'SYSTEM_ADMIN']);
    expect(requestRoles(['SYSTEM_ADMIN'], jwt)).toEqual(['SYSTEM_ADMIN']);
    expect(requestRoles(['CONTRACTOR'], 'opaque')).toEqual(['CONTRACTOR']);
  });

  it('gives a realm SYSTEM_ADMIN with a CONTRACTOR membership the owner’s door only', () => {
    const roles = requestRoles(
      ['CONTRACTOR'],
      token({ realm_access: { roles: ['SYSTEM_ADMIN'] } }),
    );
    expect(tenderSidesFor(roles, DEFAULTS)).toEqual({ owner: true, bidder: false });
    expect(tenderDoorsFor(roles, DEFAULTS)).toEqual({ own: true, open: false });
  });
});

describe('tokenAuthority — the roles the service will act on, from the token', () => {
  const ORG = 'ORG-DEH-0001';
  const OTHER = 'ORG-DEH-0002';

  it('is the resolved organization’s org_roles plus the global realm roles', () => {
    const jwt = token({
      org_id: ORG,
      org_ids: [ORG, OTHER],
      org_roles: [`${ORG}:ORGANIZATION_ADMIN`, `${OTHER}:UNION_ADMIN`, `${ORG}:ORGANIZATION_ADMIN`],
      realm_access: { roles: ['SYSTEM_ADMIN', 'offline_access'] },
    });
    expect(tokenAuthority(jwt)).toEqual({
      organizationId: ORG,
      roles: ['ORGANIZATION_ADMIN', 'SYSTEM_ADMIN'],
    });
  });

  it('reads pairs as strictly as the guard: malformed, unknown-role and padded values are ignored', () => {
    const jwt = token({
      org_id: ORG,
      org_ids: [ORG],
      org_roles: [
        `${ORG}:FLEET_MANAGER`,
        `${ORG}:ADMIN`,
        `${ORG}: UNION_ADMIN`,
        `A:${ORG}:UNION_ADMIN`,
        42,
      ],
    });
    expect(tokenAuthority(jwt)).toEqual({ organizationId: ORG, roles: ['FLEET_MANAGER'] });
  });

  it.each([
    {
      name: 'an organization the token is not a member of',
      claims: { org_id: ORG, org_ids: [OTHER], org_roles: [`${ORG}:ORGANIZATION_ADMIN`] },
    },
    {
      name: 'a membership granting no role',
      claims: { org_id: ORG, org_ids: [ORG], org_roles: [`${OTHER}:ORGANIZATION_ADMIN`] },
    },
    { name: 'a malformed org_id', claims: { org_id: 'A:B', org_ids: ['A:B'], org_roles: [] } },
  ])('is null for $name — the guard answers TENANT_MISMATCH', ({ claims }) => {
    expect(tokenAuthority(token(claims))).toBeNull();
  });

  it('with no org_id, only the global realm roles remain', () => {
    expect(tokenAuthority(token({ realm_access: { roles: ['SYSTEM_ADMIN'] } }))).toEqual({
      organizationId: null,
      roles: ['SYSTEM_ADMIN'],
    });
  });

  it.each(['opaque', 'h.!!!.s', token('x'), token(['a'])])(
    'is null for an unreadable token %#',
    (jwt) => {
      expect(tokenAuthority(jwt)).toBeNull();
    },
  );

  it('ignores the membership rows entirely: what identity-service reports now is not an input', () => {
    // The function takes only the token: there is no parameter for the rows.
    expect(tokenAuthority.length).toBe(1);
  });
});
