import {
  activePolicy,
  approvalsOf,
  asAdmin,
  asSetter,
  cleanup,
  newOrganizationId,
  readyProject,
  wire,
  type Wiring,
} from './helpers';

/**
 * The edges of CON-001 PR 2 against PostgreSQL: stale versions, paging,
 * unknown ids, and the compare-and-set guards behind the project lock.
 *
 * The project row lock serialises every command of one project, so a lost
 * compare-and-set cannot be provoked by racing two real requests: the second
 * one fails the version check first. Those guards are defence in depth, and
 * here a repository spy reports the lost write (0 rows) so the mapping to 409
 * — and that nothing of the transaction survives — is still proven.
 */

const UNIQUE_VIOLATION = Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });

describe('approvals, execution and progress — edges', () => {
  let w: Wiring;
  const organizations: string[] = [];

  const org = (): string => {
    const id = newOrganizationId();
    organizations.push(id);
    return id;
  };

  beforeAll(() => {
    w = wire();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await cleanup(w.prisma, organizations);
    await w.close();
  });

  async function pending(a: string): Promise<{ projectId: string; approvalId: string }> {
    const project = await readyProject(w, a);
    await asAdmin(a, () => w.approvals.request(project.id, { expectedVersion: project.version }));
    const [step] = await approvalsOf(w, a, project.id);
    return { projectId: project.id, approvalId: step!.id };
  }

  async function started(a: string): Promise<{ id: string; version: number }> {
    const { projectId, approvalId } = await pending(a);
    await asAdmin(a, () =>
      w.approvals.decide(approvalId, { expectedVersion: 1, decision: 'GRANT' }),
    );
    const approved = await asAdmin(a, () => w.projects.get(projectId));
    const running = await asAdmin(a, () =>
      w.execution.start(projectId, { expectedVersion: approved.version }),
    );
    return { id: running.id, version: running.version };
  }

  describe('stale versions are refused with OPTIMISTIC_LOCK_FAILED', () => {
    it('on request, start, complete and discard', async () => {
      const a = org();
      await activePolicy(w, a, [{ authorityOrganizationId: a }]);

      const ready = await readyProject(w, a);
      await expect(
        asAdmin(a, () => w.approvals.request(ready.id, { expectedVersion: ready.version + 1 })),
      ).rejects.toMatchObject({ code: 'OPTIMISTIC_LOCK_FAILED' });

      const running = await started(a);
      await expect(
        asAdmin(a, () => w.execution.start(running.id, { expectedVersion: running.version + 1 })),
      ).rejects.toMatchObject({ code: 'OPTIMISTIC_LOCK_FAILED' });
      await expect(
        asAdmin(a, () =>
          w.execution.complete(running.id, { expectedVersion: running.version + 1 }),
        ),
      ).rejects.toMatchObject({ code: 'OPTIMISTIC_LOCK_FAILED' });

      const draft = await asAdmin(a, () =>
        w.progress.draft(running.id, { progressBasisPoints: 100, assetsUsed: [] }),
      );
      await expect(
        asAdmin(a, () => w.progress.discard(running.id, draft.id, { expectedVersion: 2 })),
      ).rejects.toMatchObject({ code: 'OPTIMISTIC_LOCK_FAILED' });
    });
  });

  describe('unknown ids are 404', () => {
    it('for an approval and a progress report', async () => {
      const a = org();
      await activePolicy(w, a, [{ authorityOrganizationId: a }]);
      const running = await started(a);

      await expect(asAdmin(a, () => w.approvals.get('APR_UNKNOWN'))).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
      await expect(
        asAdmin(a, () =>
          w.approvals.decide('APR_UNKNOWN', { expectedVersion: 1, decision: 'GRANT' }),
        ),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(
        asAdmin(a, () => w.progress.submit(running.id, 'PRG_UNKNOWN', { expectedVersion: 1 })),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
  });

  describe('paging and filters', () => {
    it('pages the inbox, the policies and the progress reports by cursor', async () => {
      const a = org();
      const first = await asSetter(a, () =>
        w.policies.create({
          workflowKey: 'project.execution',
          label: 'Retired draft',
          rationale: 'Only here to be paged',
          isSample: true,
          steps: [
            {
              approvalType: 'Council approval',
              authorityOrganizationId: a,
              authorityRole: 'ORGANIZATION_ADMIN',
              authorityLabel: 'Council',
            },
          ],
        }),
      );
      const second = await activePolicy(w, a, [{ authorityOrganizationId: a }]);

      const policies = await asSetter(a, () => w.policies.list({ limit: 1 }));
      expect(policies).toMatchObject({ hasMore: true });
      expect(policies.items).toHaveLength(1);
      const rest = await asSetter(a, () =>
        w.policies.list({ limit: 1, cursor: policies.nextCursor! }),
      );
      expect([...policies.items, ...rest.items].map((item) => item.id).sort()).toEqual(
        [first.id, second].sort(),
      );

      const one = await pending(a);
      const two = await pending(a);
      const page = await asAdmin(a, () => w.approvals.inbox({ limit: 1, status: 'PENDING' }));
      expect(page).toMatchObject({ hasMore: true });
      const next = await asAdmin(a, () =>
        w.approvals.inbox({ limit: 1, status: 'PENDING', cursor: page.nextCursor! }),
      );
      expect(next).toMatchObject({ hasMore: false, nextCursor: null });
      expect([...page.items, ...next.items].map((item) => item.id).sort()).toEqual(
        [one.approvalId, two.approvalId].sort(),
      );

      const running = await started(a);
      for (const progressBasisPoints of [100, 200, 300]) {
        await asAdmin(a, () =>
          w.progress.draft(running.id, { progressBasisPoints, assetsUsed: [] }),
        );
      }
      const reports = await asAdmin(a, () => w.progress.list(running.id, { limit: 2 }));
      expect(reports).toMatchObject({ hasMore: true });
      const last = await asAdmin(a, () =>
        w.progress.list(running.id, { limit: 2, cursor: reports.nextCursor! }),
      );
      expect(last.items.map((item) => item.progressBasisPoints)).toEqual([100]);
    });

    it('filters a project’s approvals by workflow and round', async () => {
      const a = org();
      await activePolicy(w, a, [{ authorityOrganizationId: a }]);
      const { projectId } = await pending(a);
      const execution = await asAdmin(a, () =>
        w.approvals.listForProject(projectId, { workflowKey: 'project.execution', round: 1 }),
      );
      expect(execution).toHaveLength(1);
      const completion = await asAdmin(a, () =>
        w.approvals.listForProject(projectId, { workflowKey: 'project.completion' }),
      );
      expect(completion).toEqual([]);
    });
  });

  describe('a decision on a project that moved on is refused', () => {
    it('when the locked project is no longer in the state the workflow expects', async () => {
      const a = org();
      await activePolicy(w, a, [{ authorityOrganizationId: a }]);
      const { approvalId } = await pending(a);

      const lockProject = w.repository.lockProject.bind(w.repository);
      jest.spyOn(w.repository, 'lockProject').mockImplementationOnce(async (...args) => {
        const row = await lockProject(...args);
        return row && { ...row, status: 'CANCELLED' };
      });
      await expect(
        asAdmin(a, () => w.approvals.decide(approvalId, { expectedVersion: 1, decision: 'GRANT' })),
      ).rejects.toThrow(/can no longer be decided/);

      jest.spyOn(w.repository, 'lockProject').mockResolvedValueOnce(null);
      await expect(
        asAdmin(a, () => w.approvals.decide(approvalId, { expectedVersion: 1, decision: 'GRANT' })),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });

      const [step] = await approvalsOf(
        w,
        a,
        (await w.approvalRepository.findApproval(w.prisma.client, approvalId))!.projectId,
      );
      expect(step).toMatchObject({ status: 'PENDING', version: 1 });
    });
  });

  describe('a lost compare-and-set is a 409 and rolls the command back', () => {
    it('on request, when the project write matches nothing', async () => {
      const a = org();
      await activePolicy(w, a, [{ authorityOrganizationId: a }]);
      const ready = await readyProject(w, a);
      jest.spyOn(w.repository, 'updateProjectContent').mockResolvedValueOnce(0);
      await expect(
        asAdmin(a, () => w.approvals.request(ready.id, { expectedVersion: ready.version })),
      ).rejects.toMatchObject({ code: 'OPTIMISTIC_LOCK_FAILED' });
      expect(await approvalsOf(w, a, ready.id)).toEqual([]);
      expect((await asAdmin(a, () => w.projects.get(ready.id))).status).toBe('DRAFT');
    });

    it('on decide, when the approval write matches nothing', async () => {
      const a = org();
      await activePolicy(w, a, [{ authorityOrganizationId: a }]);
      const { projectId, approvalId } = await pending(a);
      jest.spyOn(w.approvalRepository, 'transitionApproval').mockResolvedValueOnce(0);
      await expect(
        asAdmin(a, () => w.approvals.decide(approvalId, { expectedVersion: 1, decision: 'GRANT' })),
      ).rejects.toMatchObject({ code: 'OPTIMISTIC_LOCK_FAILED' });
      expect((await asAdmin(a, () => w.projects.get(projectId))).status).toBe('PENDING_APPROVAL');
    });

    it('on start and complete, when the project transition matches nothing', async () => {
      const a = org();
      await activePolicy(w, a, [{ authorityOrganizationId: a }]);
      const { projectId, approvalId } = await pending(a);
      await asAdmin(a, () =>
        w.approvals.decide(approvalId, { expectedVersion: 1, decision: 'GRANT' }),
      );
      const approved = await asAdmin(a, () => w.projects.get(projectId));

      jest.spyOn(w.repository, 'transitionProject').mockResolvedValueOnce(0);
      await expect(
        asAdmin(a, () => w.execution.start(projectId, { expectedVersion: approved.version })),
      ).rejects.toMatchObject({ code: 'OPTIMISTIC_LOCK_FAILED' });

      const running = await asAdmin(a, () =>
        w.execution.start(projectId, { expectedVersion: approved.version }),
      );
      const draft = await asAdmin(a, () =>
        w.progress.draft(projectId, { progressBasisPoints: 10_000, assetsUsed: [] }),
      );
      await asAdmin(a, () => w.progress.submit(projectId, draft.id, { expectedVersion: 1 }));

      jest.spyOn(w.repository, 'transitionProject').mockResolvedValueOnce(0);
      await expect(
        asAdmin(a, () => w.execution.complete(projectId, { expectedVersion: running.version })),
      ).rejects.toMatchObject({ code: 'OPTIMISTIC_LOCK_FAILED' });
      expect((await asAdmin(a, () => w.projects.get(projectId))).status).toBe('IN_PROGRESS');
    });

    it('on completion with a final approval, when the round write matches nothing', async () => {
      const a = org();
      await activePolicy(w, a, [{ authorityOrganizationId: a }]);
      await activePolicy(w, a, [{ authorityOrganizationId: a }], 'project.completion');
      const running = await started(a);
      const draft = await asAdmin(a, () =>
        w.progress.draft(running.id, { progressBasisPoints: 10_000, assetsUsed: [] }),
      );
      await asAdmin(a, () => w.progress.submit(running.id, draft.id, { expectedVersion: 1 }));

      jest.spyOn(w.repository, 'updateProjectContent').mockResolvedValueOnce(0);
      await expect(
        asAdmin(a, () => w.execution.complete(running.id, { expectedVersion: running.version })),
      ).rejects.toMatchObject({ code: 'OPTIMISTIC_LOCK_FAILED' });
      const completion = (await approvalsOf(w, a, running.id)).filter(
        (step) => step.workflowKey === 'project.completion',
      );
      expect(completion).toEqual([]);
    });

    it('on policy activation and retirement', async () => {
      const a = org();
      const current = await activePolicy(w, a, [{ authorityOrganizationId: a }]);
      const draft = await asSetter(a, () =>
        w.policies.create({
          workflowKey: 'project.execution',
          label: 'Successor',
          rationale: 'Replaces the current policy',
          isSample: true,
          steps: [
            {
              approvalType: 'Council approval',
              authorityOrganizationId: a,
              authorityRole: 'ORGANIZATION_ADMIN',
              authorityLabel: 'Council',
            },
          ],
        }),
      );

      // Retiring the current policy matches nothing.
      jest.spyOn(w.approvalRepository, 'transitionPolicy').mockResolvedValueOnce(0);
      await expect(
        asSetter(a, () => w.policies.activate(draft.id, { expectedVersion: 1 })),
      ).rejects.toMatchObject({ code: 'OPTIMISTIC_LOCK_FAILED' });

      // Activating the draft itself matches nothing.
      const transitionPolicy = w.approvalRepository.transitionPolicy.bind(w.approvalRepository);
      jest
        .spyOn(w.approvalRepository, 'transitionPolicy')
        .mockImplementationOnce(transitionPolicy)
        .mockResolvedValueOnce(0);
      await expect(
        asSetter(a, () => w.policies.activate(draft.id, { expectedVersion: 1 })),
      ).rejects.toMatchObject({ code: 'OPTIMISTIC_LOCK_FAILED' });

      // A concurrent activation surfaces as the partial unique index.
      jest.spyOn(w.approvalRepository, 'transitionPolicy').mockRejectedValueOnce(UNIQUE_VIOLATION);
      await expect(
        asSetter(a, () => w.policies.activate(draft.id, { expectedVersion: 1 })),
      ).rejects.toMatchObject({ code: 'OPTIMISTIC_LOCK_FAILED' });

      jest.restoreAllMocks();
      jest.spyOn(w.approvalRepository, 'transitionPolicy').mockResolvedValueOnce(0);
      await expect(
        asSetter(a, () => w.policies.retire(current, { expectedVersion: 2 })),
      ).rejects.toMatchObject({ code: 'OPTIMISTIC_LOCK_FAILED' });

      expect((await asSetter(a, () => w.policies.get(current))).status).toBe('ACTIVE');
      expect((await asSetter(a, () => w.policies.get(draft.id))).status).toBe('DRAFT');
    });

    it('on policy creation, when two versions of one workflow collide', async () => {
      const a = org();
      jest.spyOn(w.approvalRepository, 'createPolicy').mockRejectedValueOnce(UNIQUE_VIOLATION);
      await expect(
        asSetter(a, () =>
          w.policies.create({
            workflowKey: 'project.execution',
            label: 'Collides',
            rationale: 'Drew the same version as another',
            isSample: true,
            steps: [
              {
                approvalType: 'Council approval',
                authorityOrganizationId: a,
                authorityRole: 'ORGANIZATION_ADMIN',
                authorityLabel: 'Council',
              },
            ],
          }),
        ),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      expect((await asSetter(a, () => w.policies.list({ limit: 10 }))).items).toEqual([]);
    });
  });
});
