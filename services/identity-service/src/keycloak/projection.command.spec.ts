import { isClean, runProjectionCommand } from './projection.command';

/**
 * The backfill and reconcile sweep. Reconcile's report is the ADR-060 gate —
 * the guard that reads `org_roles` does not ship while it shows any
 * divergence — so what it counts, and what makes it unclean, is asserted.
 */
describe('runProjectionCommand', () => {
  const pages = [['USR_1', 'USR_2'], ['USR_3'], []];
  const repository = {
    listUserIdsWithAccount: jest.fn(async (after: string | null) => {
      const index = after === null ? 0 : after === 'USR_2' ? 1 : 2;
      return pages[index]!;
    }),
    listUsersWithoutAccount: jest.fn(async () => [] as { id: string; username: string }[]),
  };
  const keycloak = { findAccountByUsername: jest.fn(async () => null) };

  it('walks every page of accounts', async () => {
    const project = jest.fn(async (_userId: string) => 'projected' as const);
    const projector = { project, reconcile: jest.fn(), repairOrphan: jest.fn() };
    const report = await runProjectionCommand('backfill', { repository, projector, keycloak });
    expect(project.mock.calls.map(([userId]) => userId)).toEqual(['USR_1', 'USR_2', 'USR_3']);
    expect(report).toMatchObject({ accounts: 3, projected: 3, failed: [] });
    expect(isClean(report)).toBe(true);
  });

  it('reconcile writes nothing and reports each divergent account by id', async () => {
    const projector = {
      project: jest.fn(),
      reconcile: jest.fn(async (userId: string) => ({
        userId,
        divergent: userId === 'USR_2' ? (['organization_roles'] as const) : ([] as const),
        activationPending: false,
      })),
      repairOrphan: jest.fn(),
    };
    const report = await runProjectionCommand('reconcile', {
      repository,
      projector: projector as never,
      keycloak,
    });
    expect(projector.project).not.toHaveBeenCalled();
    expect(report.divergent).toEqual([{ userId: 'USR_2', attributes: ['organization_roles'] }]);
    expect(isClean(report)).toBe(false);
  });

  it('keeps going past an account it cannot reach, and is not clean', async () => {
    const projector = {
      project: jest.fn(async (userId: string) => {
        if (userId === 'USR_1') throw new Error('keycloak unreachable');
        return 'projected' as const;
      }),
      reconcile: jest.fn(),
      repairOrphan: jest.fn(),
    };
    const report = await runProjectionCommand('backfill', { repository, projector, keycloak });
    expect(report).toMatchObject({ accounts: 3, projected: 2, failed: ['USR_1'] });
    expect(isClean(report)).toBe(false);
  });

  describe('the orphan sweep: an account no user row points at', () => {
    const noAccounts = {
      listUserIdsWithAccount: jest.fn(async () => [] as string[]),
      listUsersWithoutAccount: jest.fn(async (after: string | null) =>
        after === null
          ? [
              { id: 'USR_P1', username: 'pending-one' },
              { id: 'USR_P2', username: 'pending-two' },
              { id: 'USR_P3', username: 'pending-three' },
            ]
          : [],
      ),
    };
    const projector = {
      project: jest.fn(),
      reconcile: jest.fn(),
      repairOrphan: jest.fn(async () => 'repaired' as const),
    };
    beforeEach(() => projector.repairOrphan.mockClear());
    const grants = (organizations: string[]) => ({
      rasta_user_id: [] as string[],
      organization_ids: organizations,
      organization_roles: organizations.map((organization) => `${organization}:DRIVER`),
      active_organization_id: organizations.slice(0, 1),
    });
    const account = (id: string, userId: string, enabled: boolean, organizations: string[]) => ({
      id,
      enabled,
      attributes: { ...grants(organizations), rasta_user_id: [userId] },
      activation: null,
    });

    it('reconcile reports an enabled one with grants, by ids only, writes nothing, and is not clean', async () => {
      const keycloak = {
        findAccountByUsername: jest.fn(async (username: string) =>
          username === 'pending-one' ? account('kc-1', 'USR_P1', true, ['ORG_A']) : null,
        ),
      };
      const report = await runProjectionCommand('reconcile', {
        repository: noAccounts,
        projector,
        keycloak,
      });
      expect(report.orphans).toEqual([
        { userId: 'USR_P1', keycloakId: 'kc-1', enabled: true, grants: true, repaired: false },
      ]);
      expect(projector.repairOrphan).not.toHaveBeenCalled();
      expect(JSON.stringify(report)).not.toContain('pending-one');
      expect(isClean(report)).toBe(false);
    });

    it('backfill repairs it — under the request lock, by the projector — and is clean', async () => {
      const keycloak = {
        findAccountByUsername: jest.fn(async (username: string) =>
          username === 'pending-one' ? account('kc-1', 'USR_P1', true, ['ORG_A']) : null,
        ),
      };
      const report = await runProjectionCommand('backfill', {
        repository: noAccounts,
        projector,
        keycloak,
      });
      expect(projector.repairOrphan).toHaveBeenCalledWith('USR_P1', 'pending-one');
      expect(report.orphans).toEqual([
        expect.objectContaining({ userId: 'USR_P1', repaired: true }),
      ]);
      expect(isClean(report)).toBe(true);
    });

    it('backfill is not clean when the repair finds the account owned by now, or fails', async () => {
      const keycloak = {
        findAccountByUsername: jest.fn(async (username: string) =>
          username === 'pending-one' ? account('kc-1', 'USR_P1', true, ['ORG_A']) : null,
        ),
      };
      projector.repairOrphan.mockResolvedValueOnce('owned' as never);
      const owned = await runProjectionCommand('backfill', {
        repository: noAccounts,
        projector,
        keycloak,
      });
      expect(owned.orphans[0]).toMatchObject({ repaired: false });
      expect(isClean(owned)).toBe(false);

      projector.repairOrphan.mockRejectedValueOnce(new Error('keycloak unreachable'));
      const failed = await runProjectionCommand('backfill', {
        repository: noAccounts,
        projector,
        keycloak,
      });
      expect(failed.failed).toEqual(['USR_P1']);
      expect(isClean(failed)).toBe(false);
    });

    it('reports a compensated one — disabled, no grants — and stays clean', async () => {
      const keycloak = {
        findAccountByUsername: jest.fn(async (username: string) =>
          username === 'pending-two' ? account('kc-2', 'USR_P2', false, []) : null,
        ),
      };
      const report = await runProjectionCommand('reconcile', {
        repository: noAccounts,
        projector,
        keycloak,
      });
      expect(report.orphans).toEqual([
        { userId: 'USR_P2', keycloakId: 'kc-2', enabled: false, grants: false, repaired: false },
      ]);
      expect(isClean(report)).toBe(true);
      // Harmless as it is: backfill does not touch it either.
      await runProjectionCommand('backfill', { repository: noAccounts, projector, keycloak });
      expect(projector.repairOrphan).not.toHaveBeenCalled();
    });

    it('is not clean for a disabled account that still carries a grant', async () => {
      const keycloak = {
        findAccountByUsername: jest.fn(async () => account('kc-3', 'USR_P3', false, ['ORG_A'])),
      };
      const report = await runProjectionCommand('reconcile', {
        repository: noAccounts,
        projector,
        keycloak,
      });
      expect(report.orphans).toContainEqual(
        expect.objectContaining({ userId: 'USR_P3', grants: true }),
      );
      expect(isClean(report)).toBe(false);
    });

    it('ignores an account under the username that names somebody else, or nobody', async () => {
      const keycloak = {
        findAccountByUsername: jest.fn(async (username: string) =>
          username === 'pending-one'
            ? account('kc-x', 'USR_SOMEONE_ELSE', true, ['ORG_A'])
            : { id: 'kc-y', enabled: true, attributes: grants(['ORG_A']), activation: null },
        ),
      };
      const report = await runProjectionCommand('reconcile', {
        repository: noAccounts,
        projector,
        keycloak,
      });
      expect(report.orphans).toEqual([]);
    });

    it('counts a user it could not look up as failed, and keeps going', async () => {
      const keycloak = {
        findAccountByUsername: jest.fn(async (username: string) => {
          if (username === 'pending-one') throw new Error('keycloak unreachable');
          return username === 'pending-three' ? account('kc-3', 'USR_P3', true, []) : null;
        }),
      };
      const report = await runProjectionCommand('reconcile', {
        repository: noAccounts,
        projector,
        keycloak,
      });
      expect(report.failed).toEqual(['USR_P1']);
      expect(report.orphans.map((orphan) => orphan.userId)).toEqual(['USR_P3']);
      expect(isClean(report)).toBe(false);
    });
  });

  it('reconcile reports an approval whose account is not enabled yet, and is not clean', async () => {
    const projector = {
      project: jest.fn(),
      reconcile: jest.fn(async (userId: string) => ({
        userId,
        divergent: [] as never[],
        activationPending: userId === 'USR_3',
        enabledDivergent: null,
      })),
      repairOrphan: jest.fn(),
    };
    const keycloak = { findAccountByUsername: jest.fn(async () => null) };
    const report = await runProjectionCommand('reconcile', { repository, projector, keycloak });
    expect(report.activationPending).toEqual(['USR_3']);
    expect(report.divergent).toEqual([]);
    expect(isClean(report)).toBe(false);
  });

  it('reconcile reports an account whose enabled state disagrees with the platform status, by id, and is not clean (#219 r4)', async () => {
    const projector = {
      project: jest.fn(),
      reconcile: jest.fn(async (userId: string) => ({
        userId,
        divergent: [] as never[],
        activationPending: false,
        enabledDivergent:
          userId === 'USR_2' ? { keycloakEnabled: false, platformStatus: 'ACTIVE' } : null,
      })),
      repairOrphan: jest.fn(),
    };
    const keycloak = { findAccountByUsername: jest.fn(async () => null) };
    const report = await runProjectionCommand('reconcile', { repository, projector, keycloak });
    expect(report.enabledDivergent).toEqual([
      { userId: 'USR_2', keycloakEnabled: false, platformStatus: 'ACTIVE' },
    ]);
    expect(report.divergent).toEqual([]);
    expect(isClean(report)).toBe(false);
  });
});
