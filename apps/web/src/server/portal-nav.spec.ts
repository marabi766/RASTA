/**
 * @jest-environment node
 */
import { portalNavFor } from '@/app/nav';

import type { CurrentUserResult } from './identity';
import {
  canReadInventory,
  canReadProjects,
  canReadSuppliers,
  canReadTenders,
  loadPortalNav,
  tenderDoorsFor,
  tenderSidesFor,
} from './portal-nav';
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

describe('tenderSidesFor / canReadTenders', () => {
  it('offers the owner’s side to whoever may read projects, as the service gates both alike', () => {
    expect(tenderSidesFor(['ORGANIZATION_ADMIN'], DEFAULTS)).toEqual({
      owner: true,
      bidder: false,
    });
    expect(tenderSidesFor(['SYSTEM_ADMIN'], DEFAULTS)).toEqual({ owner: true, bidder: false });
    const settings = { ...DEFAULTS, WEB_PROJECT_READER_ROLES: ['FLEET_MANAGER'] };
    expect(tenderSidesFor(['FLEET_MANAGER'], settings).owner).toBe(true);
    expect(tenderSidesFor(['FLEET_MANAGER'], DEFAULTS).owner).toBe(false);
  });

  it('offers the bidder’s side to CONTRACTOR only', () => {
    expect(tenderSidesFor(['CONTRACTOR'], DEFAULTS)).toEqual({ owner: false, bidder: true });
    for (const role of ['ORGANIZATION_ADMIN', 'FLEET_MANAGER', 'SUPPLIER', 'DRIVER']) {
      expect(tenderSidesFor([role], DEFAULTS).bidder).toBe(false);
    }
  });

  it('refuses the bidder’s side to SYSTEM_ADMIN and AUDITOR whenever present, as the service does', () => {
    expect(tenderSidesFor(['CONTRACTOR', 'SYSTEM_ADMIN'], DEFAULTS).bidder).toBe(false);
    expect(tenderSidesFor(['CONTRACTOR', 'AUDITOR'], DEFAULTS).bidder).toBe(false);
  });

  it('offers neither side to AUDITOR, whatever else the person holds or the settings say', () => {
    for (const roles of [
      ['AUDITOR'],
      ['AUDITOR', 'ORGANIZATION_ADMIN'],
      ['AUDITOR', 'CONTRACTOR'],
    ]) {
      expect(tenderSidesFor(roles, DEFAULTS)).toEqual({ owner: false, bidder: false });
      expect(canReadTenders(roles, DEFAULTS)).toBe(false);
    }
  });

  it('draws the link for an owner, a bidder or both, and for nobody else', () => {
    expect(canReadTenders(['ORGANIZATION_ADMIN'], DEFAULTS)).toBe(true);
    expect(canReadTenders(['CONTRACTOR'], DEFAULTS)).toBe(true);
    expect(canReadTenders(['ORGANIZATION_ADMIN', 'CONTRACTOR'], DEFAULTS)).toBe(true);
    expect(canReadTenders(['DRIVER'], DEFAULTS)).toBe(false);
    expect(canReadTenders([], DEFAULTS)).toBe(false);
  });
});

describe('tenderDoorsFor', () => {
  it('asks the door that matches the roles, both for somebody who is both', () => {
    expect(tenderDoorsFor(['ORGANIZATION_ADMIN'], DEFAULTS)).toEqual({ own: true, open: false });
    expect(tenderDoorsFor(['CONTRACTOR'], DEFAULTS)).toEqual({ own: false, open: true });
    expect(tenderDoorsFor(['ORGANIZATION_ADMIN', 'CONTRACTOR'], DEFAULTS)).toEqual({
      own: true,
      open: true,
    });
  });

  it('still asks the owner’s door for anyone else, so the service gives its own refusal', () => {
    expect(tenderDoorsFor(['DRIVER'], DEFAULTS)).toEqual({ own: true, open: false });
    expect(tenderDoorsFor(['AUDITOR'], DEFAULTS)).toEqual({ own: true, open: false });
    expect(tenderDoorsFor([], DEFAULTS)).toEqual({ own: true, open: false });
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

describe('canReadSuppliers', () => {
  it('shows the link to every role in supplier-service’s DIRECTORY_ROLES', () => {
    for (const role of [
      'SYSTEM_ADMIN',
      'UNION_ADMIN',
      'ORGANIZATION_ADMIN',
      'SUPPLIER',
      'WORKSHOP',
      'CONTRACTOR',
      'PROCUREMENT_USER',
      'FLEET_MANAGER',
    ]) {
      expect(canReadSuppliers([role])).toBe(true);
    }
  });

  it('hides it from roles the service does not list, and from nobody holding any role', () => {
    for (const role of ['DRIVER', 'AUDITOR']) {
      expect(canReadSuppliers([role])).toBe(false);
    }
    expect(canReadSuppliers([])).toBe(false);
  });
});

describe('portalNavFor', () => {
  it('puts Suppliers right after Inventory (and Projects, Tenders), and only when allowed', () => {
    const shown = hrefs(portalNavFor({ canReadProjects: true, canReadSuppliers: true }));
    const hidden = hrefs(portalNavFor({ canReadProjects: true, canReadSuppliers: false }));
    const withInventory = hrefs(
      portalNavFor({ canReadProjects: true, canReadInventory: true, canReadSuppliers: true }),
    );

    expect(shown.indexOf('/suppliers')).toBe(shown.indexOf('/projects') + 1);
    expect(shown.indexOf('/wallet')).toBe(shown.indexOf('/suppliers') + 1);
    expect(withInventory.indexOf('/suppliers')).toBe(withInventory.indexOf('/inventory') + 1);
    expect(hidden).not.toContain('/suppliers');
    expect(hrefs(portalNavFor({ canReadProjects: false }))).not.toContain('/suppliers');
  });

  it('puts Inventory right after Projects (and Tenders), and only when allowed', () => {
    const shown = hrefs(portalNavFor({ canReadProjects: true, canReadInventory: true }));
    const hidden = hrefs(portalNavFor({ canReadProjects: true, canReadInventory: false }));
    const withTenders = hrefs(
      portalNavFor({ canReadProjects: true, canReadTenders: true, canReadInventory: true }),
    );

    expect(shown.indexOf('/inventory')).toBe(shown.indexOf('/projects') + 1);
    expect(shown.indexOf('/wallet')).toBe(shown.indexOf('/inventory') + 1);
    expect(withTenders.indexOf('/inventory')).toBe(withTenders.indexOf('/tenders') + 1);
    expect(hidden).not.toContain('/inventory');
    expect(hrefs(portalNavFor({ canReadProjects: false }))).not.toContain('/inventory');
  });

  it('puts Tenders right after Projects, and only when allowed', () => {
    const shown = hrefs(portalNavFor({ canReadProjects: true, canReadTenders: true }));
    const hidden = hrefs(portalNavFor({ canReadProjects: true, canReadTenders: false }));
    const contractor = hrefs(portalNavFor({ canReadProjects: false, canReadTenders: true }));

    expect(shown.indexOf('/tenders')).toBe(shown.indexOf('/projects') + 1);
    expect(shown.indexOf('/wallet')).toBe(shown.indexOf('/tenders') + 1);
    expect(hidden).not.toContain('/tenders');
    expect(contractor).toContain('/tenders');
    expect(contractor).not.toContain('/projects');
    expect(contractor.indexOf('/tenders')).toBe(contractor.indexOf('/marketplace') + 1);
  });

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
  const tokenWith = (realmRoles: string[]): string =>
    `h.${Buffer.from(JSON.stringify({ realm_access: { roles: realmRoles } })).toString('base64url')}.s`;
  const sessionWith = (realmRoles: string[]): WebSession =>
    ({ accessToken: tokenWith(realmRoles) }) as WebSession;
  const SESSION = sessionWith([]);

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

  it('offers the Tenders link to an owner and to a contractor, not to the oversight role', async () => {
    expect(hrefs(await loadPortalNav(SESSION, user(['ORGANIZATION_ADMIN'])))).toContain('/tenders');
    expect(hrefs(await loadPortalNav(SESSION, user(['CONTRACTOR'])))).toContain('/tenders');
    expect(hrefs(await loadPortalNav(SESSION, user(['AUDITOR'])))).not.toContain('/tenders');
    expect(hrefs(await loadPortalNav(SESSION, user(['DRIVER'])))).not.toContain('/tenders');
  });

  // The service acts on membership roles plus the global realm roles, so a realm
  // SYSTEM_ADMIN is an owner and never a bidder, whatever the membership holds.
  it.each([
    {
      name: 'SYSTEM_ADMIN realm + CONTRACTOR membership',
      realm: ['SYSTEM_ADMIN'],
      member: ['CONTRACTOR'],
      links: ['/tenders', '/projects'],
    },
    {
      name: 'SYSTEM_ADMIN realm + no membership roles',
      realm: ['SYSTEM_ADMIN'],
      member: [],
      links: ['/tenders', '/projects'],
    },
    { name: 'CONTRACTOR membership alone', realm: [], member: ['CONTRACTOR'], links: ['/tenders'] },
    {
      name: 'a non-global realm role is ignored',
      realm: ['UNION_ADMIN'],
      member: ['CONTRACTOR'],
      links: ['/tenders'],
    },
    {
      name: 'AUDITOR membership beats a realm SYSTEM_ADMIN',
      realm: ['SYSTEM_ADMIN'],
      member: ['AUDITOR'],
      links: [],
    },
  ])('draws the right links for $name', async ({ realm, member, links }) => {
    const items = hrefs(await loadPortalNav(sessionWith(realm), user(member)));
    for (const link of ['/tenders', '/projects']) {
      expect(items.includes(link)).toBe(links.includes(link));
    }
  });

  it('offers the Suppliers link to every role the service lists, not to the oversight role', async () => {
    expect(hrefs(await loadPortalNav(SESSION, user(['ORGANIZATION_ADMIN'])))).toContain(
      '/suppliers',
    );
    expect(hrefs(await loadPortalNav(SESSION, user(['PROCUREMENT_USER'])))).toContain('/suppliers');
    expect(hrefs(await loadPortalNav(SESSION, user(['CONTRACTOR'])))).toContain('/suppliers');
    expect(hrefs(await loadPortalNav(SESSION, user(['AUDITOR'])))).not.toContain('/suppliers');
    expect(hrefs(await loadPortalNav(SESSION, user(['DRIVER'])))).not.toContain('/suppliers');
  });

  it('keeps the settlements link for the roles that read settlements, next to Projects', async () => {
    const admin = hrefs(await loadPortalNav(SESSION, user(['ORGANIZATION_ADMIN'])));
    expect(admin).toContain('/settlements');
    expect(admin).toContain('/projects');
    expect(admin.indexOf('/settlements')).toBe(admin.indexOf('/wallet') + 1);
    expect(hrefs(await loadPortalNav(SESSION, user(['DRIVER'])))).not.toContain('/settlements');
  });

  describe('Inventory', () => {
    const REALM_ADMIN = ['SYSTEM_ADMIN'];

    beforeEach(() => {
      delete process.env.WEB_INVENTORY_ROLES;
      delete process.env.WEB_INVENTORY_READER_ROLES;
    });

    it.each([
      {
        name: 'ORGANIZATION_ADMIN membership',
        realm: [],
        roles: ['ORGANIZATION_ADMIN'],
        shown: true,
      },
      { name: 'DRIVER membership', realm: [], roles: ['DRIVER'], shown: false },
      { name: 'AUDITOR membership', realm: [], roles: ['AUDITOR'], shown: false },
      { name: 'SYSTEM_ADMIN membership', realm: [], roles: ['SYSTEM_ADMIN'], shown: false },
      {
        name: 'ORGANIZATION_ADMIN membership + realm SYSTEM_ADMIN, which the service refuses',
        realm: REALM_ADMIN,
        roles: ['ORGANIZATION_ADMIN'],
        shown: false,
      },
      {
        name: 'ORGANIZATION_ADMIN membership + a non-global realm role',
        realm: ['UNION_ADMIN'],
        roles: ['ORGANIZATION_ADMIN'],
        shown: true,
      },
      { name: 'realm SYSTEM_ADMIN alone', realm: REALM_ADMIN, roles: [], shown: false },
    ])('$name', async ({ realm, roles, shown }) => {
      const items = hrefs(await loadPortalNav(sessionWith(realm), user(roles)));
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

  describe('a realm SYSTEM_ADMIN in the access token', () => {
    const sessionWithClaims = (claims: unknown): WebSession =>
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
      const items = hrefs(await loadPortalNav(sessionWithClaims(claims), user(roles)));
      expect(items.includes('/projects')).toBe(projects);
      expect(items.includes('/settlements')).toBe(settlements);
    });

    it('is not read when identity did not answer', async () => {
      for (const result of [
        { kind: 'UNAVAILABLE', status: 503, correlationId: 'c' },
        { kind: 'MALFORMED', correlationId: 'c' },
      ] as const) {
        const items = hrefs(await loadPortalNav(sessionWithClaims(REALM_ADMIN), result));
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
      expect(items).not.toContain('/tenders');
      expect(items).not.toContain('/settlements');
      expect(items).not.toContain('/inventory');
      expect(items).not.toContain('/suppliers');
      expect(items).toContain('/assets');
      expect(items).toContain('/organizations');
    },
  );
});
