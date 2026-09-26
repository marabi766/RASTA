import {
  activePolicy,
  approvalsOf,
  asAdmin,
  asSetter,
  asUser,
  cleanup,
  newOrganizationId,
  outboxFor,
  readyProject,
  wire,
  type Wiring,
} from './helpers';

/**
 * Tenant isolation for CON-001 PR 2: policies, approvals, execution and
 * progress. Organization B — an administrator, a policy setter, even a
 * SYSTEM_ADMIN acting for B — can neither read nor change anything of
 * organization A, and every refusal is a 404. The one designed crossing, an
 * authority of another organization deciding the step addressed to it, is
 * proven in `approval-lifecycle.int-spec.ts`; here the authority is A itself,
 * so B has no claim at all.
 */

describe('tenant isolation — policies, approvals, execution and progress', () => {
  let w: Wiring;
  const organizations: string[] = [];
  let a: string;
  let b: string;
  let policyId: string;
  let approvedId: string;
  let pendingProjectId: string;
  let pendingApprovalId: string;
  let reportId: string;
  let outboxBefore: number;

  beforeAll(async () => {
    w = wire();
    a = newOrganizationId();
    b = newOrganizationId();
    organizations.push(a, b);

    policyId = await activePolicy(w, a, [{ authorityOrganizationId: a }]);

    // One project waiting on its first step.
    const pending = await readyProject(w, a);
    await asAdmin(a, () => w.approvals.request(pending.id, { expectedVersion: pending.version }));
    pendingProjectId = pending.id;
    pendingApprovalId = (await approvalsOf(w, a, pending.id))[0]!.id;

    // One project approved, started, with a draft progress report.
    const approved = await readyProject(w, a);
    await asAdmin(a, () => w.approvals.request(approved.id, { expectedVersion: approved.version }));
    const [step] = await approvalsOf(w, a, approved.id);
    await asAdmin(a, () => w.approvals.decide(step!.id, { expectedVersion: 1, decision: 'GRANT' }));
    const current = await asAdmin(a, () => w.projects.get(approved.id));
    await asAdmin(a, () => w.execution.start(approved.id, { expectedVersion: current.version }));
    approvedId = approved.id;
    reportId = (
      await asAdmin(a, () =>
        w.progress.draft(approved.id, { progressBasisPoints: 500, assetsUsed: [] }),
      )
    ).id;

    // B has its own policy, so "B sees nothing of A" is not "B has nothing".
    await activePolicy(w, b, [{ authorityOrganizationId: b }]);
    outboxBefore = (await outboxFor(w.prisma, a)).length;
  });

  afterAll(async () => {
    await cleanup(w.prisma, organizations);
    await w.close();
  });

  afterEach(async () => {
    expect(await outboxFor(w.prisma, a)).toHaveLength(outboxBefore);
    const [step] = await approvalsOf(w, a, pendingProjectId);
    expect(step).toMatchObject({ status: 'PENDING', version: 1 });
    expect((await asSetter(a, () => w.policies.get(policyId))).status).toBe('ACTIVE');
  });

  /**
   * Who tries, and which refusals are acceptable. A caller without the role a
   * command needs is refused at the role check (403 INSUFFICIENT_ROLE) before
   * any row is read, which discloses nothing either. SYSTEM_ADMIN passes every
   * role check, so for it only 404 is acceptable: that is the pure proof that
   * the row itself is out of reach.
   */
  const intruders: [string, <T>(fn: () => T) => T, string[]][] = [
    ['an administrator of B', (fn) => asAdmin(b, fn), ['NOT_FOUND', 'INSUFFICIENT_ROLE']],
    ['a policy setter of B', (fn) => asSetter(b, fn), ['NOT_FOUND', 'INSUFFICIENT_ROLE']],
    ['a SYSTEM_ADMIN acting for B', (fn) => asUser(b, ['SYSTEM_ADMIN'], fn), ['NOT_FOUND']],
  ];

  describe.each(intruders)('%s', (_who, as, acceptable) => {
    it.each<[string, () => Promise<unknown>]>([
      [
        'POST /v1/projects/{id}/approvals',
        () => w.approvals.request(pendingProjectId, { expectedVersion: 1 }),
      ],
      ['GET /v1/projects/{id}/approvals', () => w.approvals.listForProject(pendingProjectId, {})],
      ['GET /v1/approvals/{id}', () => w.approvals.get(pendingApprovalId)],
      [
        'POST /v1/approvals/{id}/decision',
        () => w.approvals.decide(pendingApprovalId, { expectedVersion: 1, decision: 'GRANT' }),
      ],
      ['POST /v1/projects/{id}/start', () => w.execution.start(approvedId, { expectedVersion: 1 })],
      [
        'POST /v1/projects/{id}/complete',
        () => w.execution.complete(approvedId, { expectedVersion: 1 }),
      ],
      [
        'POST /v1/projects/{id}/progress',
        () => w.progress.draft(approvedId, { progressBasisPoints: 1, assetsUsed: [] }),
      ],
      ['GET /v1/projects/{id}/progress', () => w.progress.list(approvedId, { limit: 25 })],
      [
        'POST /v1/projects/{id}/progress/{reportId}/submit',
        () => w.progress.submit(approvedId, reportId, { expectedVersion: 1 }),
      ],
      [
        'POST /v1/projects/{id}/progress/{reportId}/discard',
        () => w.progress.discard(approvedId, reportId, { expectedVersion: 1 }),
      ],
    ])('%s never reaches A’s object', async (_route, call) => {
      const error = await as(call).then(
        () => undefined,
        (caught: unknown) => caught as { code?: string },
      );
      expect(acceptable).toContain(error?.code);
    });
  });

  /**
   * Approval policies (Q-70 (7), decided). An administrator or a union of B —
   * B is not above A — reaches nothing of A's policy. A SYSTEM_ADMIN is
   * different on purpose: it is the platform approver for every organization,
   * so it may read and retire any policy; that is asserted, not excluded.
   */
  describe.each<[string, <T>(fn: () => T) => T]>([
    ['an administrator of B', (fn) => asAdmin(b, fn)],
    ['a union administrator of B', (fn) => asSetter(b, fn)],
  ])('%s and A’s approval policy', (_who, as) => {
    it.each<[string, () => Promise<unknown>, string[]]>([
      ['GET /v1/approval-policies/{id}', () => w.policies.get(policyId), ['NOT_FOUND']],
      [
        'POST /v1/approval-policies/{id}/submit',
        () => w.policies.submit(policyId, { expectedVersion: 3 }),
        ['NOT_FOUND'],
      ],
      [
        'POST /v1/approval-policies/{id}/retire',
        () => w.policies.retire(policyId, { expectedVersion: 3 }),
        ['NOT_FOUND'],
      ],
      [
        'POST /v1/approval-policies/{id}/approve',
        () => w.policies.approve(policyId, { expectedVersion: 3 }),
        ['INSUFFICIENT_ROLE'],
      ],
      [
        'POST /v1/approval-policies/{id}/reject',
        () => w.policies.reject(policyId, { expectedVersion: 3, reason: 'Not yours to judge' }),
        ['INSUFFICIENT_ROLE'],
      ],
    ])('%s never reaches it', async (_route, call, acceptable) => {
      const error = await as(call).then(
        () => undefined,
        (caught: unknown) => caught as { code?: string },
      );
      expect(acceptable).toContain(error?.code);
    });
  });

  it('a SYSTEM_ADMIN acting for B may read A’s policy: it is the platform approver (Q-70 (7))', async () => {
    const seen = await asUser(b, ['SYSTEM_ADMIN'], () => w.policies.get(policyId));
    expect(seen).toMatchObject({ id: policyId, organizationId: a });
  });

  describe('lists and inboxes return nothing of A', () => {
    it('GET /v1/approval-policies lists only B’s policies', async () => {
      const page = await asSetter(b, () => w.policies.list({ limit: 200 }));
      expect(page.items.every((item) => item.organizationId === b)).toBe(true);
    });

    it('GET /v1/approvals shows B nothing addressed to A', async () => {
      for (const roles of [['ORGANIZATION_ADMIN'], ['SYSTEM_ADMIN']]) {
        const inbox = await asUser(b, roles, () =>
          w.approvals.inbox({ limit: 200, status: 'PENDING' }),
        );
        expect(inbox.items.map((item) => item.id)).not.toContain(pendingApprovalId);
      }
    });

    it('a policy step naming B as authority is the only way B sees an approval', async () => {
      const inbox = await asAdmin(a, () => w.approvals.inbox({ limit: 200, status: 'PENDING' }));
      expect(inbox.items.map((item) => item.id)).toContain(pendingApprovalId);
    });
  });

  describe('repository reads are scoped', () => {
    it('policy reads under B’s context see nothing of A', async () => {
      // `findPolicy` crosses the guard on purpose (a union reads the policies
      // it wrote for organizations beneath it; the platform approves any), so
      // the service decides visibility — proven by the 404s above. The policy
      // that *governs* is still read under the guard:
      const bActive = await asSetter(b, () =>
        w.prisma.transaction((tx) =>
          w.approvalRepository.findActivePolicy(tx, 'project.execution'),
        ),
      );
      expect(bActive?.organizationId).toBe(b);
      await expect(
        asAdmin(b, () => w.approvalRepository.listForProject(pendingProjectId, {})),
      ).resolves.toEqual([]);
    });

    it('the authority-side writes name the organization, so B’s organization matches nothing of A', async () => {
      const matched = await w.prisma.transaction((tx) =>
        w.approvalRepository.transitionApproval(tx, {
          organizationId: b,
          approvalId: pendingApprovalId,
          from: 'PENDING',
          data: { status: 'GRANTED', decidedAt: new Date(), decidedBy: 'USR_X' },
        }),
      );
      expect(matched).toBe(0);
      const superseded = await w.prisma.transaction((tx) =>
        w.approvalRepository.supersedeOpen(
          tx,
          { organizationId: b, projectId: pendingProjectId },
          new Date(),
        ),
      );
      expect(superseded).toBe(0);
      await expect(
        w.approvalRepository.projectBrief(w.prisma.client, b, pendingProjectId),
      ).resolves.toBeNull();
    });
  });
});
