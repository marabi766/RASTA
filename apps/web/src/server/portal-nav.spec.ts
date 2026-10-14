/**
 * @jest-environment node
 */
import { portalNavFor } from '@/app/nav';

import type { CurrentUserResult } from './identity';
import { canReadInventory, canReadProjects, loadPortalNav } from './portal-nav';
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

const INVENTORY_DEFAULTS = {
  WEB_INVENTORY_ROLES: ['ORGANIZATION_ADMIN'],
  WEB_INVENTORY_READER_ROLES: ['ORGANIZATION_ADMIN'],
};

describe('canReadInventory', () => {
  it('shows the link to the configured operator and reader roles', () => {
    expect(canReadInventory(['ORGANIZATION_ADMIN'], INVENTORY_DEFAULTS)).toBe(true);
    const settings = {
      WEB_INVENTORY_ROLES: ['ORGANIZATION_ADMIN'],
      WEB_INVENTORY_READER_ROLES: ['PROCUREMENT_USER'],
    };
    expect(canReadInventory(['PROCUREMENT_USER'], settings)).toBe(true);
    expect(canReadInventory(['DRIVER'], settings)).toBe(false);
  });

  it('hides it from every other role under the defaults', () => {
    for (const role of ['FLEET_MANAGER', 'DRIVER', 'CONTRACTOR', 'SUPPLIER']) {
      expect(canReadInventory([role], INVENTORY_DEFAULTS)).toBe(false);
    }
    expect(canReadInventory([], INVENTORY_DEFAULTS)).toBe(false);
  });

  it('never shows it to AUDITOR or SYSTEM_ADMIN, which the service refuses even beside an admin role', () => {
    expect(canReadInventory(['SYSTEM_ADMIN'], INVENTORY_DEFAULTS)).toBe(false);
    expect(canReadInventory(['AUDITOR'], INVENTORY_DEFAULTS)).toBe(false);
    expect(canReadInventory(['AUDITOR', 'ORGANIZATION_ADMIN'], INVENTORY_DEFAULTS)).toBe(false);
    expect(canReadInventory(['SYSTEM_ADMIN', 'ORGANIZATION_ADMIN'], INVENTORY_DEFAULTS)).toBe(
      false,
    );
  });
});

describe('the Inventory link in the navigation', () => {
  it('sits after Projects and before the wallet, and only when allowed', () => {
    const shown = hrefs(portalNavFor({ canReadProjects: true, canReadInventory: true }));
    const hidden = hrefs(portalNavFor({ canReadProjects: true, canReadInventory: false }));

    expect(shown.indexOf('/inventory')).toBe(shown.indexOf('/projects') + 1);
    expect(shown.indexOf('/wallet')).toBe(shown.indexOf('/inventory') + 1);
    expect(hidden).not.toContain('/inventory');
    expect(hrefs(portalNavFor({ canReadProjects: false }))).not.toContain('/inventory');
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

  it('offers Inventory to the roles inventory-service reads for, never to AUDITOR or SYSTEM_ADMIN', async () => {
    delete process.env.WEB_INVENTORY_ROLES;
    delete process.env.WEB_INVENTORY_READER_ROLES;
    expect(hrefs(await loadPortalNav(SESSION, user(['ORGANIZATION_ADMIN'])))).toContain(
      '/inventory',
    );
    expect(hrefs(await loadPortalNav(SESSION, user(['DRIVER'])))).not.toContain('/inventory');
    expect(hrefs(await loadPortalNav(SESSION, user(['AUDITOR'])))).not.toContain('/inventory');
    expect(hrefs(await loadPortalNav(SESSION, user(['SYSTEM_ADMIN'])))).not.toContain('/inventory');
  });

  describe('Inventory against the realm roles in the access token', () => {
    const sessionWith = (claims: unknown): WebSession =>
      ({
        accessToken: `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`,
      }) as WebSession;
    const REALM_ADMIN = { realm_access: { roles: ['SYSTEM_ADMIN'] } };

    beforeEach(() => {
      delete process.env.WEB_INVENTORY_ROLES;
      delete process.env.WEB_INVENTORY_READER_ROLES;
    });

    it.each([
      {
        name: 'ORGANIZATION_ADMIN membership + realm SYSTEM_ADMIN is refused by the service',
        roles: ['ORGANIZATION_ADMIN'],
        claims: REALM_ADMIN,
        shown: false,
      },
      {
        name: 'ORGANIZATION_ADMIN membership, no realm role',
        roles: ['ORGANIZATION_ADMIN'],
        claims: {},
        shown: true,
      },
      {
        name: 'ORGANIZATION_ADMIN membership + a non-global realm role',
        roles: ['ORGANIZATION_ADMIN'],
        claims: { realm_access: { roles: ['UNION_ADMIN'] } },
        shown: true,
      },
      {
        name: 'ORGANIZATION_ADMIN membership + unreadable claim adds nothing',
        roles: ['ORGANIZATION_ADMIN'],
        claims: 'SYSTEM_ADMIN',
        shown: true,
      },
      {
        name: 'realm SYSTEM_ADMIN alone',
        roles: [],
        claims: REALM_ADMIN,
        shown: false,
      },
      {
        name: 'AUDITOR + ORGANIZATION_ADMIN memberships',
        roles: ['AUDITOR', 'ORGANIZATION_ADMIN'],
        claims: {},
        shown: false,
      },
      {
        name: 'narrow membership + realm SYSTEM_ADMIN',
        roles: ['DRIVER'],
        claims: REALM_ADMIN,
        shown: false,
      },
    ])('$name', async ({ roles, claims, shown }) => {
      const items = hrefs(await loadPortalNav(sessionWith(claims), user(roles)));
      expect(items.includes('/inventory')).toBe(shown);
    });

    it('is not read when identity did not answer', async () => {
      for (const result of [
        { kind: 'UNAVAILABLE', status: 503, correlationId: 'c' },
        { kind: 'MALFORMED', correlationId: 'c' },
      ] as const) {
        expect(hrefs(await loadPortalNav(sessionWith(REALM_ADMIN), result))).not.toContain(
          '/inventory',
        );
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
      expect(items).not.toContain('/inventory');
      expect(items).toContain('/assets');
      expect(items).toContain('/organizations');
    },
  );
});
