import { isClean, runProjectionCommand } from './projection.command';

/**
 * The backfill and reconcile sweep. Reconcile's report is the ADR-060 gate —
 * the guard that reads `org_roles` does not ship while it shows any
 * divergence — so what it counts, and what makes it unclean, is asserted.
 */
/** No write fence anywhere: what every test below but the drain's assumes. */
const noFences = () => ({
  owners: jest.fn(async () => [] as string[]),
  counts: jest.fn(async () => ({
    live: 0,
    due: 0,
    accountMissing: 0,
    overdue: 0,
    expired: 0,
    total: 0,
    at: new Date(),
  })),
  recoverOwed: jest.fn(async () => 0),
});

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
    const report = await runProjectionCommand('backfill', {
      repository,
      projector,
      keycloak,
      fences: noFences(),
    });
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
      fences: noFences(),
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
    const report = await runProjectionCommand('backfill', {
      repository,
      projector,
      keycloak,
      fences: noFences(),
    });
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
        fences: noFences(),
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
        fences: noFences(),
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
        fences: noFences(),
      });
      expect(owned.orphans[0]).toMatchObject({ repaired: false });
      expect(isClean(owned)).toBe(false);

      projector.repairOrphan.mockRejectedValueOnce(new Error('keycloak unreachable'));
      const failed = await runProjectionCommand('backfill', {
        repository: noAccounts,
        projector,
        keycloak,
        fences: noFences(),
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
        fences: noFences(),
      });
      expect(report.orphans).toEqual([
        { userId: 'USR_P2', keycloakId: 'kc-2', enabled: false, grants: false, repaired: false },
      ]);
      expect(isClean(report)).toBe(true);
      // Harmless as it is: backfill does not touch it either.
      await runProjectionCommand('backfill', {
        repository: noAccounts,
        projector,
        keycloak,
        fences: noFences(),
      });
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
        fences: noFences(),
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
        fences: noFences(),
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
        fences: noFences(),
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
    const report = await runProjectionCommand('reconcile', {
      repository,
      projector,
      keycloak,
      fences: noFences(),
    });
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
    const report = await runProjectionCommand('reconcile', {
      repository,
      projector,
      keycloak,
      fences: noFences(),
    });
    expect(report.enabledDivergent).toEqual([
      { userId: 'USR_2', keycloakEnabled: false, platformStatus: 'ACTIVE' },
    ]);
    expect(report.divergent).toEqual([]);
    expect(isClean(report)).toBe(false);
  });

  it('writes the late writes’ owed fresh fences (D-070 D) before it counts, and is unclean while any is still owed', async () => {
    const order: string[] = [];
    const fences = {
      owners: jest.fn(async () => [] as string[]),
      recoverOwed: jest.fn(async () => {
        order.push('recoverOwed');
        return 1;
      }),
      counts: jest.fn(async () => {
        order.push('counts');
        return {
          live: 0,
          due: 0,
          accountMissing: 0,
          overdue: 0,
          expired: 0,
          total: 0,
          at: new Date(),
        };
      }),
    };
    const report = await runProjectionCommand('backfill', {
      repository,
      projector: {
        project: jest.fn(async () => 'projected' as const),
        reconcile: jest.fn(),
        repairOrphan: jest.fn(),
      },
      keycloak,
      fences,
    });
    expect(order).toEqual(['recoverOwed', 'counts']);
    expect(report.fences).toMatchObject({ owed: 1, outstanding: 0 });
    expect(isClean(report)).toBe(false);
  });

  describe('the fence drain (D-069, #402 r2 F3)', () => {
    /**
     * Fence owners on more than one page (the page is 200): two unlinked
     * users — no account, so neither the account pass nor the orphan sweep
     * projects them — a linked user whose fence waits out a retry, and a
     * user whose fence is terminal; the table the fake keeps is what the
     * projections leave.
     */
    function table() {
      const owners = new Map<string, number>();
      for (let index = 0; index < 205; index += 1)
        owners.set(`USR_U${String(index).padStart(3, '0')}`, 1);
      owners.set('USR_RETRY', 1);
      owners.set('USR_TERMINAL', 1);
      const sorted = () => [...owners.keys()].sort();
      return {
        owners,
        fences: {
          owners: jest.fn(async (after: string | null, take: number) =>
            sorted()
              .filter((userId) => after === null || userId > after)
              .slice(0, take),
          ),
          counts: jest.fn(async () => ({
            live: 0,
            due: owners.size - (owners.has('USR_TERMINAL') ? 1 : 0),
            accountMissing: owners.has('USR_TERMINAL') ? 1 : 0,
            overdue: 0,
            expired: 0,
            total: [...owners.values()].reduce((sum, n) => sum + n, 0),
            at: new Date(),
          })),
          recoverOwed: jest.fn(async () => 0),
        },
      };
    }
    const noAccounts = {
      listUserIdsWithAccount: jest.fn(async () => [] as string[]),
      listUsersWithoutAccount: jest.fn(async () => [] as { id: string; username: string }[]),
    };

    it('projects every fence owner, past the first page and whether linked or not, and is clean only once COUNT(*) is 0', async () => {
      const { owners, fences } = table();
      // Each projection takes the user's due fences over — but the terminal
      // one's account is still missing, so its fence stays.
      const project = jest.fn(async (userId: string) => {
        if (userId === 'USR_TERMINAL') return 'account_missing' as const;
        owners.delete(userId);
        return 'projected' as const;
      });
      const projector = { project, reconcile: jest.fn(), repairOrphan: jest.fn() };
      const report = await runProjectionCommand('backfill', {
        repository: noAccounts,
        projector,
        keycloak,
        fences,
      });
      expect(project).toHaveBeenCalledTimes(207);
      expect(project).toHaveBeenCalledWith('USR_U204', 'command');
      expect(project).toHaveBeenCalledWith('USR_RETRY', 'command');
      expect(report.fences).toEqual({
        drained: 207,
        owed: 0,
        outstanding: 1,
        live: 0,
        due: 0,
        accountMissing: 1,
      });
      expect(isClean(report)).toBe(false);

      // The account restored: the next backfill drains it, and only now is it clean.
      project.mockImplementation(async (userId: string) => {
        owners.delete(userId);
        return 'projected' as const;
      });
      const again = await runProjectionCommand('backfill', {
        repository: noAccounts,
        projector,
        keycloak,
        fences,
      });
      expect(again.fences.outstanding).toBe(0);
      expect(isClean(again)).toBe(true);
    });

    it('decides on the explicit count, not on the owners it walked: rows it could not see keep it unclean', async () => {
      const projector = {
        project: jest.fn(async () => 'projected' as const),
        reconcile: jest.fn(),
        repairOrphan: jest.fn(),
      };
      const fences = {
        owners: jest.fn(async () => [] as string[]),
        counts: jest.fn(async () => ({
          live: 1,
          due: 0,
          accountMissing: 0,
          overdue: 0,
          expired: 0,
          total: 1,
          at: new Date(),
        })),
        recoverOwed: jest.fn(async () => 0),
      };
      const report = await runProjectionCommand('backfill', {
        repository: noAccounts,
        projector,
        keycloak,
        fences,
      });
      expect(report.fences).toMatchObject({ drained: 0, outstanding: 1, live: 1 });
      expect(isClean(report)).toBe(false);
    });

    it('a fence owner that cannot be projected is reported as failed, and the drain goes on', async () => {
      const { owners, fences } = table();
      const project = jest.fn(async (userId: string) => {
        if (userId === 'USR_U000') throw new Error('keycloak unreachable');
        owners.delete(userId);
        return 'projected' as const;
      });
      const report = await runProjectionCommand('backfill', {
        repository: noAccounts,
        projector: { project, reconcile: jest.fn(), repairOrphan: jest.fn() },
        keycloak,
        fences,
      });
      expect(report.failed).toEqual(['USR_U000']);
      expect(report.fences.drained).toBe(207);
      expect(isClean(report)).toBe(false);
    });

    it('reconcile drains nothing, and counts every fence', async () => {
      const { fences } = table();
      const projector = {
        project: jest.fn(),
        reconcile: jest.fn(async () => null),
        repairOrphan: jest.fn(),
      };
      const report = await runProjectionCommand('reconcile', {
        repository: noAccounts,
        projector,
        keycloak,
        fences,
      });
      expect(projector.project).not.toHaveBeenCalled();
      expect(report.fences).toMatchObject({ drained: 0, outstanding: 207 });
      expect(isClean(report)).toBe(false);
    });
  });
});
