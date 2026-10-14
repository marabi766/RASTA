/**
 * @jest-environment node
 */
import { portalNavFor } from '@/app/nav';

import type { CurrentUserResult } from './identity';
import { canReadProjects, loadPortalNav } from './portal-nav';
import type { WebSession } from './session';

/**
 * Who is shown the Projects link. It mirrors construction-service's defaults
 * (writers `ORGANIZATION_ADMIN`, readers none; `SYSTEM_ADMIN` always; `AUDITOR`
 * never) and only draws or hides a link — the service still decides access.
 */

const DEFAULTS = { WEB_PROJECT_ROLES: ['ORGANIZATION_ADMIN'], WEB_PROJECT_READER_ROLES: [] };

const hrefs = (items: readonly { href: string }[]): string[] => items.map((item) => item.href);

describe('canReadProjects', () => {
  it('shows the link to the configured writer and to SYSTEM_ADMIN', () => {
    expect(canReadProjects(['ORGANIZATION_ADMIN'], DEFAULTS)).toBe(true);
    expect(canReadProjects(['SYSTEM_ADMIN'], DEFAULTS)).toBe(true);
  });

  it('hides it from every other role under the defaults', () => {
    for (const role of ['FLEET_MANAGER', 'DRIVER', 'CONTRACTOR', 'SUPPLIER']) {
      expect(canReadProjects([role], DEFAULTS)).toBe(false);
    }
    expect(canReadProjects([], DEFAULTS)).toBe(false);
  });

  it('follows the reader setting, as the service does', () => {
    const settings = { ...DEFAULTS, WEB_PROJECT_READER_ROLES: ['FLEET_MANAGER'] };
    expect(canReadProjects(['FLEET_MANAGER'], settings)).toBe(true);
    expect(canReadProjects(['DRIVER'], settings)).toBe(false);
  });

  it('never shows it to AUDITOR, whatever else the person holds or the settings say', () => {
    expect(canReadProjects(['AUDITOR'], DEFAULTS)).toBe(false);
    expect(canReadProjects(['AUDITOR', 'ORGANIZATION_ADMIN'], DEFAULTS)).toBe(false);
    expect(canReadProjects(['AUDITOR', 'SYSTEM_ADMIN'], DEFAULTS)).toBe(false);
    expect(
      canReadProjects(['AUDITOR'], {
        WEB_PROJECT_ROLES: ['AUDITOR'],
        WEB_PROJECT_READER_ROLES: ['AUDITOR'],
      }),
    ).toBe(false);
  });
});

describe('portalNavFor', () => {
  it('puts Projects between the marketplace and the wallet, and only when allowed', () => {
    const shown = hrefs(portalNavFor({ canReadProjects: true }));
    const hidden = hrefs(portalNavFor({ canReadProjects: false }));

    expect(shown).toContain('/projects');
    expect(shown.indexOf('/projects')).toBe(shown.indexOf('/marketplace') + 1);
    expect(shown.indexOf('/wallet')).toBe(shown.indexOf('/projects') + 1);
    expect(hidden).not.toContain('/projects');
    expect(hidden).toEqual(shown.filter((href) => href !== '/projects'));
  });
});

describe('loadPortalNav', () => {
  const SESSION = { accessToken: 'opaque' } as WebSession;

  beforeEach(() => {
    Object.assign(process.env, {
      API_GATEWAY_URL: 'http://gateway.test:3000',
      OIDC_ISSUER_URL: 'http://keycloak.test/realms/rasta',
      OIDC_CLIENT_ID: 'rasta-web',
      WEB_PUBLIC_ORIGIN: 'http://localhost:3200',
      WEB_SESSION_SECRET: 'a-secret-that-is-long-enough-to-be-a-key',
    });
    delete process.env.WEB_PROJECT_ROLES;
    delete process.env.WEB_PROJECT_READER_ROLES;
  });

  const user = (effectiveRoles: string[]): CurrentUserResult => ({
    kind: 'USER',
    user: {
      id: 'USR_1',
      username: 'u',
      firstName: '',
      lastName: '',
      status: 'ACTIVE',
      activeOrganizationId: 'ORG_1',
      memberships: [],
      effectiveRoles,
      grantableRoles: [],
    },
  });

  it('builds the navigation from the roles identity reported for the active organization', async () => {
    expect(hrefs(await loadPortalNav(SESSION, user(['ORGANIZATION_ADMIN'])))).toContain(
      '/projects',
    );
    expect(hrefs(await loadPortalNav(SESSION, user(['AUDITOR'])))).not.toContain('/projects');
    expect(hrefs(await loadPortalNav(SESSION, user(['DRIVER'])))).not.toContain('/projects');
  });

  it('keeps the settlements link for the roles that read settlements, next to Projects', async () => {
    const admin = hrefs(await loadPortalNav(SESSION, user(['ORGANIZATION_ADMIN'])));
    expect(admin).toContain('/settlements');
    expect(admin).toContain('/projects');
    expect(admin.indexOf('/settlements')).toBe(admin.indexOf('/wallet') + 1);
    expect(hrefs(await loadPortalNav(SESSION, user(['DRIVER'])))).not.toContain('/settlements');
  });

  describe('a realm SYSTEM_ADMIN in the access token', () => {
    const sessionWith = (claims: unknown): WebSession =>
      ({
        accessToken: `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`,
      }) as WebSession;
    const REALM_ADMIN = { realm_access: { roles: ['SYSTEM_ADMIN'] } };

    it.each([
      {
        name: 'narrow membership + realm admin',
        roles: ['CONTRACTOR'],
        claims: REALM_ADMIN,
        projects: true,
        settlements: true,
      },
      {
        name: 'no membership roles + realm admin',
        roles: [],
        claims: REALM_ADMIN,
        projects: true,
        settlements: true,
      },
      {
        name: 'narrow membership, no realm role',
        roles: ['CONTRACTOR'],
        claims: {},
        projects: false,
        settlements: false,
      },
      {
        name: 'non-global realm role is ignored',
        roles: ['CONTRACTOR'],
        claims: { realm_access: { roles: ['UNION_ADMIN'] } },
        projects: false,
        settlements: false,
      },
      {
        name: 'AUDITOR membership + realm admin is still excluded',
        roles: ['AUDITOR'],
        claims: REALM_ADMIN,
        projects: false,
        settlements: false,
      },
      {
        name: 'unreadable token adds nothing',
        roles: ['CONTRACTOR'],
        claims: 'SYSTEM_ADMIN',
        projects: false,
        settlements: false,
      },
    ])('$name', async ({ roles, claims, projects, settlements }) => {
      const items = hrefs(await loadPortalNav(sessionWith(claims), user(roles)));
      expect(items.includes('/projects')).toBe(projects);
      expect(items.includes('/settlements')).toBe(settlements);
    });

    it('is not read when identity did not answer', async () => {
      for (const result of [
        { kind: 'UNAVAILABLE', status: 503, correlationId: 'c' },
        { kind: 'MALFORMED', correlationId: 'c' },
      ] as const) {
        const items = hrefs(await loadPortalNav(sessionWith(REALM_ADMIN), result));
        expect(items).not.toContain('/projects');
        expect(items).not.toContain('/settlements');
      }
    });
  });

  it.each([
    { kind: 'UNAVAILABLE', status: 503, correlationId: 'c' },
    { kind: 'MALFORMED', correlationId: 'c' },
  ] as const)(
    'hides the gated link, and keeps the rest, when identity is $kind',
    async (result) => {
      const items = hrefs(await loadPortalNav(SESSION, result));
      expect(items).not.toContain('/projects');
      expect(items).not.toContain('/settlements');
      expect(items).toContain('/assets');
      expect(items).toContain('/organizations');
    },
  );
});
