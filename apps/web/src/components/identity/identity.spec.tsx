import { screen } from '@testing-library/react';
import { ProfileView } from './profile-view';
import { UsersView } from './users-view';
import {
  expectNoAxeViolations,
  makeHarness,
  renderWithSession,
  respondError,
  respondJson,
  TEST_CLAIMS,
} from '@/test/harness';

/**
 * Identity screens.
 *
 * The profile is the one place two sources of truth about the same user sit
 * side by side, so it is also the one place they could be quietly merged. They
 * are not: the token's claim decides what may be *selected*, and
 * `identity-service` decides what is *named*.
 */

const CURRENT_USER = {
  id: 'usr_1',
  username: 'dehyari.admin',
  email: 'admin@example.test',
  firstName: 'علی',
  lastName: 'رضایی',
  phone: null,
  status: 'ACTIVE',
  activeOrganizationId: 'org_one',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  effectiveRoles: ['ORGANIZATION_ADMIN', 'FLEET_MANAGER'],
  memberships: [
    {
      id: 'mem_1',
      organizationId: 'org_one',
      organizationName: 'دهیاری الف',
      roles: ['ORGANIZATION_ADMIN'],
      status: 'ACTIVE',
      validFrom: '2026-01-01T00:00:00.000Z',
      validUntil: null,
    },
    {
      id: 'mem_2',
      // A membership the identity service knows about but the token does not
      // yet carry — the case the screen exists to make visible.
      organizationId: 'org_unsynced',
      organizationName: 'دهیاری ج',
      roles: ['OPERATOR'],
      status: 'ACTIVE',
      validFrom: '2026-01-01T00:00:00.000Z',
      validUntil: null,
    },
  ],
};

describe('profile', () => {
  it('shows the acting tenant and the roles the token declares', async () => {
    const { fetchMock, session } = makeHarness();
    fetchMock.mockImplementation(respondJson(CURRENT_USER));

    renderWithSession(<ProfileView />, session);
    await screen.findByText('مشخصات کاربر');

    expect(screen.getAllByText('org_one').length).toBeGreaterThan(0);
    expect(screen.getByText('PROCUREMENT_USER')).toBeInTheDocument();
  });

  it('marks a membership the token does not back as not selectable', async () => {
    const { fetchMock, session } = makeHarness();
    fetchMock.mockImplementation(respondJson(CURRENT_USER));

    renderWithSession(<ProfileView />, session);
    await screen.findByText('عضویت‌های سازمانی');

    // `org_unsynced` is a real membership record, but the gateway validates
    // `X-Organization-Id` against the signed claim — so it cannot be acted as
    // until identity-service syncs it into the token.
    const row = screen.getByRole('row', { name: /org_unsynced/ });
    expect(row).toHaveTextContent('خیر');

    const backed = screen.getByRole('row', { name: /دهیاری الف/ });
    expect(backed).toHaveTextContent('بله');
  });

  it('never puts the token or the raw claims on screen', async () => {
    const { fetchMock, session } = makeHarness();
    fetchMock.mockImplementation(respondJson(CURRENT_USER));

    const { container } = renderWithSession(<ProfileView />, session);
    await screen.findByText('مشخصات کاربر');

    // S-09: a bearer credential must not be screenshot-able during a demo.
    expect(container.textContent).not.toContain('token-test');
    expect(container.textContent).not.toContain(TEST_CLAIMS.subject);
    expect(container.textContent).not.toMatch(/Bearer|eyJ/);
  });

  it('says out loud that hiding a control is not a security boundary', async () => {
    const { fetchMock, session } = makeHarness();
    fetchMock.mockImplementation(respondJson(CURRENT_USER));

    renderWithSession(<ProfileView />, session);

    expect(await screen.findByText(/کنترل امنیتی نیست/)).toBeInTheDocument();
  });

  it('keeps the acting-tenant panel when the identity read fails', async () => {
    const { fetchMock, session } = makeHarness();
    fetchMock.mockImplementation(respondError(503, 'UPSTREAM_UNAVAILABLE'));

    renderWithSession(<ProfileView />, session);

    expect(await screen.findByText('در حال حاضر به‌نام چه کسی عمل می‌کنید')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('cid-gateway');
  });

  it('has no accessibility violations', async () => {
    const { fetchMock, session } = makeHarness();
    fetchMock.mockImplementation(respondJson(CURRENT_USER));

    const { container } = renderWithSession(<ProfileView />, session);
    await screen.findByText('عضویت‌های سازمانی');

    await expectNoAxeViolations(container);
  });
});

describe('organization users', () => {
  const USERS = {
    items: [
      {
        ...CURRENT_USER,
        memberships: undefined,
        effectiveRoles: undefined,
        roles: ['ORGANIZATION_ADMIN'],
      },
    ],
    nextCursor: null,
    hasMore: false,
  };

  it('lists users with their roles in this organization', async () => {
    const { fetchMock, session } = makeHarness();
    fetchMock.mockImplementation(respondJson(USERS));

    renderWithSession(<UsersView />, session);
    await screen.findByRole('table');

    expect(screen.getByText('علی رضایی')).toBeInTheDocument();
    expect(screen.getByText('ORGANIZATION_ADMIN')).toBeInTheDocument();
  });

  it('renders a role refusal as a refusal, not a fault', async () => {
    // The route admits ORGANIZATION_ADMIN and UNION_ADMIN only. Everyone else
    // being refused is the platform working.
    const { fetchMock, session } = makeHarness();
    fetchMock.mockImplementation(respondError(403, 'FORBIDDEN'));

    renderWithSession(<UsersView />, session);

    expect(await screen.findByText('این بخش برای نقش شما باز نیست')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('offers no control that would create a user or change a role', async () => {
    const { fetchMock, session } = makeHarness();
    fetchMock.mockImplementation(respondJson(USERS));

    const { container } = renderWithSession(<UsersView />, session);
    await screen.findByRole('table');

    expect(container.querySelector('form')).toBeNull();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
