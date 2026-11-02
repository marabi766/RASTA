import { render } from '@testing-library/react';

import { ROLE_LABELS, USER_STATUS_LABELS } from '@/lib/organization-fields';
import type { CurrentUser } from '@/server/identity';

/**
 * The home page (`/`): who you are, which organisation, what it granted you.
 *
 * The class this file guards: a closed backend vocabulary (role, user status)
 * is never drawn as its raw code in the Persian page — the demo run of
 * 2026-10-24 showed ORGANIZATION_ADMIN / FLEET_MANAGER / PROCUREMENT_USER under
 * «دسترسی شما در این سازمان». The organisation shows by its Persian name, with
 * the code only as secondary text.
 */

let user: CurrentUser;

jest.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));
jest.mock('@/server/current-session', () => ({
  currentSession: async () => ({
    subject: 'USR_1',
    username: 'u',
    organizationId: 'ORG-DEH-0001',
    accessToken: jest
      .requireActual<typeof import('@/test/session-token')>('@/test/session-token')
      .actingAccessToken('ORG-DEH-0001'),
    accessTokenExpiresAt: 2_000_000_000,
    refreshToken: 'r',
    csrfToken: 'csrf',
    issuedAt: 1_900_000_000,
  }),
}));
jest.mock('@/server/identity', () => ({
  ...jest.requireActual('@/server/identity'),
  fetchCurrentUser: async () => ({ kind: 'USER', user }),
}));
jest.mock('@/app/PortalSidebar', () => ({ PortalSidebar: () => null }));

const RAW_CODE = /[A-Z_]{3,}/;

function makeUser(overrides: Partial<CurrentUser> = {}): CurrentUser {
  return {
    id: 'USR_1',
    username: 'dehyari.admin',
    firstName: 'علی',
    lastName: 'رضایی',
    status: 'ACTIVE',
    activeOrganizationId: 'ORG-DEH-0001',
    memberships: [
      {
        organizationId: 'ORG-DEH-0001',
        organizationName: 'دهیاری نمونه یک',
        roles: Object.keys(ROLE_LABELS),
        status: 'ACTIVE',
      },
    ],
    effectiveRoles: Object.keys(ROLE_LABELS),
    ...overrides,
  } as CurrentUser;
}

async function renderHome() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { default: HomePage } = require('./page') as typeof import('./page');
  return render(await HomePage());
}

describe('the roles list', () => {
  it('names every known role in Persian and shows no raw code', async () => {
    user = makeUser();
    const { container } = await renderHome();
    const roles = container.querySelector('#roles, [aria-labelledby="roles"]') as HTMLElement;
    expect(roles).not.toBeNull();

    for (const label of Object.values(ROLE_LABELS)) {
      expect(roles.textContent).toContain(label);
    }
    expect(roles.textContent).not.toMatch(RAW_CODE);
  });

  it('shows a role this portal has no name for as sent, and only that one', async () => {
    user = makeUser({
      memberships: [
        {
          organizationId: 'ORG-DEH-0001',
          organizationName: 'دهیاری نمونه یک',
          roles: ['FLEET_MANAGER', 'BRAND_NEW_ROLE'],
          status: 'ACTIVE',
        },
      ],
    });
    const { container } = await renderHome();
    const roles = container.querySelector('#roles, [aria-labelledby="roles"]') as HTMLElement;
    expect(roles.textContent).toContain(ROLE_LABELS.FLEET_MANAGER);
    expect(roles.textContent).not.toContain('FLEET_MANAGER');
    expect(roles.textContent).toContain('BRAND_NEW_ROLE');
  });
});

describe('the account status', () => {
  it.each(Object.keys(USER_STATUS_LABELS))('says %s in Persian', async (status) => {
    user = makeUser({ status });
    const { container } = await renderHome();
    const badge = container.querySelector(`[data-status="${status}"]`)!;
    expect(badge.textContent).toBe(USER_STATUS_LABELS[status]);
    expect(badge.textContent).not.toMatch(RAW_CODE);
  });
});

describe('the organisation', () => {
  it('shows the Persian name in the header and the card, the code as secondary text', async () => {
    user = makeUser();
    const { container } = await renderHome();
    const header = container.querySelector('header')!;
    expect(header.textContent).toContain('دهیاری نمونه یک');
    expect(header.textContent).not.toContain('ORG-DEH-0001');

    const card = container.querySelector('main, body')!.textContent ?? '';
    expect(card).toContain('دهیاری نمونه یک');
    expect(card).toContain('ORG-DEH-0001'); // secondary «کد …»
  });

  it('falls back to the code when no name has replicated yet', async () => {
    user = makeUser({
      memberships: [
        { organizationId: 'ORG-DEH-0001', organizationName: null, roles: [], status: 'ACTIVE' },
      ],
    });
    const { container } = await renderHome();
    expect(container.querySelector('header')!.textContent).toContain('ORG-DEH-0001');
  });
});

describe('the organization the token acts for, not identity’s active one (task 100)', () => {
  it('names, codes and lists the roles of the acting membership after a switch elsewhere', async () => {
    // identity already moved to B; the token — what every request acts for — is still A.
    user = makeUser({
      activeOrganizationId: 'ORG-DEH-0002',
      memberships: [
        {
          organizationId: 'ORG-DEH-0001',
          organizationName: 'دهیاری نمونه یک',
          roles: ['FLEET_MANAGER'],
          status: 'ACTIVE',
        },
        {
          organizationId: 'ORG-DEH-0002',
          organizationName: 'دهیاری نمونه دو',
          roles: ['ORGANIZATION_ADMIN'],
          status: 'ACTIVE',
        },
      ],
      effectiveRoles: ['ORGANIZATION_ADMIN'],
    });
    const { container } = await renderHome();
    const text = container.textContent ?? '';
    expect(container.querySelector('header')!.textContent).toContain('دهیاری نمونه یک');
    expect(text).toContain('ORG-DEH-0001');
    expect(text).not.toContain('دهیاری نمونه دو');
    expect(text).not.toContain('ORG-DEH-0002');
    const roles = container.querySelector('#roles, [aria-labelledby="roles"]') as HTMLElement;
    expect(roles.textContent).toContain(ROLE_LABELS.FLEET_MANAGER);
    expect(roles.textContent).not.toContain(ROLE_LABELS.ORGANIZATION_ADMIN);
  });
});

describe('the page', () => {
  it('no longer claims the operational screens are on their way', async () => {
    user = makeUser();
    const { container } = await renderHome();
    expect(container.textContent).not.toContain('در راه‌اند');
    expect(container.textContent).not.toContain('در ناوبری نمی‌نشینند');
  });
});
