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
  };

  it('walks every page of accounts', async () => {
    const project = jest.fn(async (_userId: string) => 'projected' as const);
    const projector = { project, reconcile: jest.fn() };
    const report = await runProjectionCommand('backfill', { repository, projector });
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
      })),
    };
    const report = await runProjectionCommand('reconcile', {
      repository,
      projector: projector as never,
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
    };
    const report = await runProjectionCommand('backfill', { repository, projector });
    expect(report).toMatchObject({ accounts: 3, projected: 2, failed: ['USR_1'] });
    expect(isClean(report)).toBe(false);
  });
});
