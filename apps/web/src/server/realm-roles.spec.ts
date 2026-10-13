/**
 * @jest-environment node
 */
import { globalRealmRoles, requestRoles } from './realm-roles';
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
