import { eventEnvelopeSchema } from '@rasta/contracts';
import {
  activePolicy,
  approvalsOf,
  asAdmin,
  asUser,
  cleanup,
  newOrganizationId,
  outboxFor,
  readyProject,
  testEnv,
  wire,
  type Wiring,
} from './helpers';

/**
 * Execution, progress and completion against PostgreSQL (Q-71, Q-72).
 */

describe('execution, progress and completion', () => {
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

  afterAll(async () => {
    await cleanup(w.prisma, organizations);
    await w.close();
  });

  /** An APPROVED project of `a`, approved by `a`'s own administrator. */
  async function approvedProject(
    a: string,
    wiring: Wiring = w,
  ): Promise<{ id: string; version: number }> {
    await activePolicy(wiring, a, [{ authorityOrganizationId: a }]);
    const project = await readyProject(wiring, a);
    await asAdmin(a, () =>
      wiring.approvals.request(project.id, { expectedVersion: project.version }),
    );
    const [step] = await approvalsOf(wiring, a, project.id);
    await asAdmin(a, () =>
      wiring.approvals.decide(step!.id, { expectedVersion: 1, decision: 'GRANT' }),
    );
    const approved = await asAdmin(a, () => wiring.projects.get(project.id));
    return { id: approved.id, version: approved.version };
  }

  async function startedProject(a: string): Promise<{ id: string; version: number }> {
    const project = await approvedProject(a);
    const started = await asAdmin(a, () =>
      w.execution.start(project.id, { expectedVersion: project.version }),
    );
    return { id: started.id, version: started.version };
  }

  async function report(a: string, projectId: string, progressBasisPoints: number) {
    const draft = await asAdmin(a, () =>
      w.progress.draft(projectId, { progressBasisPoints, assetsUsed: [] }),
    );
    return asAdmin(a, () => w.progress.submit(projectId, draft.id, { expectedVersion: 1 }));
  }

  describe('start', () => {
    it('moves an APPROVED project to IN_PROGRESS with no contract claimed', async () => {
      const a = org();
      const project = await approvedProject(a);
      const started = await asAdmin(a, () =>
        w.execution.start(project.id, { expectedVersion: project.version }),
      );
      expect(started.status).toBe('IN_PROGRESS');

      const row = (await outboxFor(w.prisma, a)).find(
        (candidate) => candidate.eventName === 'PROJECT_STARTED',
      )!;
      expect(eventEnvelopeSchema.parse(row.payload).payload).toMatchObject({
        projectId: project.id,
        contractId: null,
      });
    });

    it('refuses to start anything that is not APPROVED', async () => {
      const a = org();
      const project = await readyProject(w, a);
      await expect(
        asAdmin(a, () => w.execution.start(project.id, { expectedVersion: project.version })),
      ).rejects.toMatchObject({ code: 'BUSINESS_RULE_VIOLATION' });
    });

    it('refuses every start when the deployment requires a contract (Q-71)', async () => {
      const strict = wire(testEnv({ CONSTRUCTION_START_REQUIRES_CONTRACT: 'true' }));
      try {
        const a = org();
        const project = await approvedProject(a, strict);
        await expect(
          asAdmin(a, () =>
            strict.execution.start(project.id, { expectedVersion: project.version }),
          ),
        ).rejects.toThrow(/contract/);
      } finally {
        await strict.close();
      }
    });
  });

  describe('progress reports', () => {
    it('drafts, submits and publishes PROJECT_PROGRESS_UPDATED in basis points', async () => {
      const a = org();
      const project = await startedProject(a);
      const draft = await asAdmin(a, () =>
        w.progress.draft(project.id, {
          progressBasisPoints: 2500,
          materials: 'Gravel delivered',
          obstacles: 'Rain on two days',
          assetsUsed: ['AST_1', 'AST_2'],
        }),
      );
      expect(draft).toMatchObject({
        status: 'DRAFT',
        progressBasisPoints: 2500,
        assetsUsed: ['AST_1', 'AST_2'],
      });

      const submitted = await asAdmin(a, () =>
        w.progress.submit(project.id, draft.id, { expectedVersion: 1 }),
      );
      expect(submitted).toMatchObject({ status: 'SUBMITTED', version: 2 });

      const row = (await outboxFor(w.prisma, a)).find(
        (candidate) => candidate.eventName === 'PROJECT_PROGRESS_UPDATED',
      )!;
      expect(eventEnvelopeSchema.parse(row.payload).payload).toMatchObject({
        reportId: draft.id,
        progressBasisPoints: 2500,
        assetsUsed: ['AST_1', 'AST_2'],
      });
      expect(JSON.stringify(row.payload)).not.toContain('Rain');
    });

    it('discards a draft, and refuses to touch a submitted or discarded report', async () => {
      const a = org();
      const project = await startedProject(a);
      const draft = await asAdmin(a, () =>
        w.progress.draft(project.id, { progressBasisPoints: 100, assetsUsed: [] }),
      );
      const discarded = await asAdmin(a, () =>
        w.progress.discard(project.id, draft.id, { expectedVersion: 1 }),
      );
      expect(discarded.status).toBe('DISCARDED');
      await expect(
        asAdmin(a, () => w.progress.submit(project.id, draft.id, { expectedVersion: 2 })),
      ).rejects.toMatchObject({ code: 'BUSINESS_RULE_VIOLATION' });
    });

    it('refuses progress that goes down, unless configured (Q-72)', async () => {
      const a = org();
      const project = await startedProject(a);
      await report(a, project.id, 5000);
      const lower = await asAdmin(a, () =>
        w.progress.draft(project.id, { progressBasisPoints: 4000, assetsUsed: [] }),
      );
      await expect(
        asAdmin(a, () => w.progress.submit(project.id, lower.id, { expectedVersion: 1 })),
      ).rejects.toThrow(/may not go down/);

      const lenient = wire(testEnv({ CONSTRUCTION_PROGRESS_ALLOW_DECREASE: 'true' }));
      try {
        await expect(
          asAdmin(a, () => lenient.progress.submit(project.id, lower.id, { expectedVersion: 1 })),
        ).resolves.toMatchObject({ status: 'SUBMITTED' });
      } finally {
        await lenient.close();
      }
    });

    it('refuses progress outside IN_PROGRESS', async () => {
      const a = org();
      const project = await approvedProject(a);
      await expect(
        asAdmin(a, () => w.progress.draft(project.id, { progressBasisPoints: 10, assetsUsed: [] })),
      ).rejects.toThrow(/only while it is IN_PROGRESS/);
    });

    it('refuses a stale version and lists reports newest first', async () => {
      const a = org();
      const project = await startedProject(a);
      const first = await report(a, project.id, 1000);
      const draft = await asAdmin(a, () =>
        w.progress.draft(project.id, { progressBasisPoints: 2000, assetsUsed: [] }),
      );
      await expect(
        asAdmin(a, () => w.progress.submit(project.id, draft.id, { expectedVersion: 3 })),
      ).rejects.toMatchObject({ code: 'OPTIMISTIC_LOCK_FAILED' });

      const page = await asAdmin(a, () => w.progress.list(project.id, { limit: 25 }));
      expect(page.items.map((item) => item.id)).toEqual([draft.id, first.id]);
      const submitted = await asAdmin(a, () =>
        w.progress.list(project.id, { limit: 25, status: 'SUBMITTED' }),
      );
      expect(submitted.items.map((item) => item.id)).toEqual([first.id]);
    });
  });

  describe('complete', () => {
    it('completes at 100% when no completion approval is configured', async () => {
      const a = org();
      const project = await startedProject(a);
      await report(a, project.id, 10_000);
      const current = await asAdmin(a, () => w.projects.get(project.id));

      const completed = await asAdmin(a, () =>
        w.execution.complete(project.id, { expectedVersion: current.version }),
      );
      expect(completed.status).toBe('COMPLETED');
      expect((await outboxFor(w.prisma, a)).map((row) => row.eventName)).toContain(
        'PROJECT_COMPLETED',
      );
    });

    it('refuses to complete below 100%, or with no report at all', async () => {
      const a = org();
      const project = await startedProject(a);
      await expect(
        asAdmin(a, () => w.execution.complete(project.id, { expectedVersion: project.version })),
      ).rejects.toThrow(/100%/);
      await report(a, project.id, 9_999);
      const current = await asAdmin(a, () => w.projects.get(project.id));
      await expect(
        asAdmin(a, () => w.execution.complete(project.id, { expectedVersion: current.version })),
      ).rejects.toThrow(/100%/);
    });

    it('opens the configured final approval, and completes only on its last grant', async () => {
      const a = org();
      const engineer = org();
      const project = await startedProject(a);
      await activePolicy(
        w,
        a,
        [{ authorityOrganizationId: engineer, approvalType: 'Final technical approval' }],
        'project.completion',
      );
      await report(a, project.id, 10_000);
      const current = await asAdmin(a, () => w.projects.get(project.id));

      const asked = await asAdmin(a, () =>
        w.execution.complete(project.id, { expectedVersion: current.version }),
      );
      expect(asked.status).toBe('IN_PROGRESS');
      await expect(
        asAdmin(a, () => w.execution.complete(project.id, { expectedVersion: asked.version })),
      ).rejects.toThrow(/already open/);

      const completion = (await approvalsOf(w, a, project.id)).filter(
        (step) => step.workflowKey === 'project.completion',
      );
      expect(completion.map((step) => [step.round, step.status])).toEqual([[2, 'PENDING']]);

      await asUser(engineer, ['ORGANIZATION_ADMIN'], () =>
        w.approvals.decide(completion[0]!.id, { expectedVersion: 1, decision: 'GRANT' }),
      );
      expect((await asAdmin(a, () => w.projects.get(project.id))).status).toBe('COMPLETED');
    });

    it('leaves the project executing when the final approval is rejected', async () => {
      const a = org();
      const project = await startedProject(a);
      await activePolicy(w, a, [{ authorityOrganizationId: a }], 'project.completion');
      await report(a, project.id, 10_000);
      const current = await asAdmin(a, () => w.projects.get(project.id));
      await asAdmin(a, () =>
        w.execution.complete(project.id, { expectedVersion: current.version }),
      );
      const [step] = (await approvalsOf(w, a, project.id)).filter(
        (candidate) => candidate.workflowKey === 'project.completion',
      );

      await asAdmin(a, () =>
        w.approvals.decide(step!.id, {
          expectedVersion: 1,
          decision: 'REJECT',
          reason: 'Drainage is unfinished',
        }),
      );
      const after = await asAdmin(a, () => w.projects.get(project.id));
      expect(after.status).toBe('IN_PROGRESS');
      // A new completion attempt may open a new round.
      const retried = await asAdmin(a, () =>
        w.execution.complete(project.id, { expectedVersion: after.version }),
      );
      expect(retried.status).toBe('IN_PROGRESS');
    });
  });
});
