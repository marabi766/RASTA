import { screen, waitFor } from '@testing-library/react';
import { OrganizationSwitcher } from './org-switcher';
import { membershipOptions } from '@/lib/api/adapters/organization';
import {
  expectNoAxeViolations,
  makeHarness,
  renderWithSession,
  respondError,
  respondJson,
  TEST_CLAIMS,
} from '@/test/harness';

/**
 * Tenant selection.
 *
 * The invariant under test is the one that keeps the switcher and the gateway
 * in agreement: options come from the token's signed membership claim, and the
 * directory can only supply names. An organization the directory returns but
 * the token does not name is visible, not actable.
 */

function organization(id: string, name: string) {
  return {
    id,
    externalCode: null,
    name,
    shortName: null,
    type: 'DEHYARI',
    status: 'ACTIVE',
    parentId: null,
    path: null,
    depth: 0,
    metadata: {},
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

const DIRECTORY = {
  items: [
    organization('org_one', 'دهیاری الف'),
    organization('org_two', 'دهیاری ب'),
    // Visible through the hierarchy, but not a membership.
    organization('org_outside', 'اتحادیهٔ استان'),
  ],
  nextCursor: null,
  hasMore: false,
};

describe('membership intersection', () => {
  it('keeps only the token memberships and takes names from the directory', () => {
    const options = membershipOptions(['org_one', 'org_two'], DIRECTORY.items);

    expect(options.map((option) => option.organizationId)).toEqual(['org_one', 'org_two']);
    expect(options.map((option) => option.name)).toEqual(['دهیاری الف', 'دهیاری ب']);
  });

  it('never lets the directory add an option the token does not back', () => {
    const options = membershipOptions(['org_one'], DIRECTORY.items);
    expect(options).toHaveLength(1);
    expect(options.map((option) => option.organizationId)).not.toContain('org_outside');
  });

  it('keeps a membership whose organization row is unreadable', () => {
    // The token says the user belongs there. Dropping it would be the frontend
    // overruling a signed claim.
    const options = membershipOptions(['org_hidden'], DIRECTORY.items);
    expect(options).toEqual([
      { organizationId: 'org_hidden', name: null, type: null, status: null },
    ]);
  });
});

describe('the switcher', () => {
  it('names every membership once the directory answers', async () => {
    const { fetchMock, session } = makeHarness();
    fetchMock.mockImplementation(respondJson(DIRECTORY));

    renderWithSession(<OrganizationSwitcher />, session);

    expect(await screen.findByText('دهیاری الف')).toBeInTheDocument();
  });

  it('stays usable when the directory read is refused', async () => {
    // A name lookup is decoration. Losing tenant selection because a 403 came
    // back would be the wrong trade.
    const { fetchMock, session } = makeHarness();
    fetchMock.mockImplementation(respondError(403, 'FORBIDDEN'));

    renderWithSession(<OrganizationSwitcher />, session);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.getByText('سازمان فعال')).toBeInTheDocument();
    expect(screen.getByRole('combobox')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('says so plainly when the token declares no membership', () => {
    const { session } = makeHarness({
      claims: { ...TEST_CLAIMS, organizationIds: [], activeOrganizationId: null },
      organizationId: null,
    });

    renderWithSession(<OrganizationSwitcher />, session);

    expect(screen.getByText(/توکن شما هیچ عضویت سازمانی اعلام نکرده است/)).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });

  it('has no accessibility violations', async () => {
    const { fetchMock, session } = makeHarness();
    fetchMock.mockImplementation(respondJson(DIRECTORY));

    const { container } = renderWithSession(<OrganizationSwitcher />, session);
    await screen.findByText('دهیاری الف');

    await expectNoAxeViolations(container);
  });
});
