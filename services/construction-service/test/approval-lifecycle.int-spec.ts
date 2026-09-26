import { eventEnvelopeSchema } from '@rasta/contracts';
import {
  PROJECT,
  activePolicy,
  approvalsOf,
  asAdmin,
  asSetter,
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
 * Configurable approvals against PostgreSQL (ADR-023, ADR-063, Q-70).
 *
 * The rule every case here serves: **the platform never approves.** A project
 * reaches APPROVED only in the transaction of the last grant a named authority
 * made; no policy, no applicable step and every refusal leave it where it was.
 */

describe('approval policies and rounds', () => {
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

  describe('policies are versioned data', () => {
    it('creates a DRAFT version, activates it, and retires the previous version together', async () => {
      const a = org();
      const first = await activePolicy(w, a, [{ authorityOrganizationId: a }]);
      const second = await asSetter(a, () =>
        w.policies.create({
          workflowKey: 'project.execution',
          label: 'Second version',
          rationale: 'A replacement written by the suite',
          isSample: false,
          steps: [
            {
              approvalType: 'Council',
              authorityOrganizationId: a,
              authorityRole: 'ORGANIZATION_ADMIN',
              authorityLabel: 'Council',
            },
          ],
        }),
      );
      expect(second).toMatchObject({ status: 'DRAFT', policyVersion: 2, version: 1 });

      const activated = await asSetter(a, () =>
        w.policies.activate(second.id, { expectedVersion: 1 }),
      );
      expect(activated).toMatchObject({ status: 'ACTIVE', version: 2 });
      const retired = await asSetter(a, () => w.policies.get(first));
      expect(retired.status).toBe('RETIRED');

      const events = (await outboxFor(w.prisma, a)).filter((row) =>
        row.eventName.startsWith('APPROVAL_POLICY_'),
      );
      const activation = eventEnvelopeSchema.parse(events[events.length - 1]!.payload);
      expect(activation.payload).toMatchObject({ policyId: second.id, retiredPolicyId: first });
      expect(events.every((row) => row.partitionKey === `${a}/project.execution`)).toBe(true);
    });

    it('lets only the configured setter roles write policies', async () => {
      const a = org();
      await expect(
        asAdmin(a, () =>
          w.policies.create({
            workflowKey: 'project.execution',
            label: 'Not allowed',
            rationale: 'An administrator is not a setter',
            isSample: false,
            steps: [
              {
                approvalType: 'X approval',
                authorityOrganizationId: a,
                authorityRole: 'ORGANIZATION_ADMIN',
                authorityLabel: 'Anyone',
              },
            ],
          }),
        ),
      ).rejects.toMatchObject({ code: 'INSUFFICIENT_ROLE' });
    });

    it('retires a policy with no replacement, after which requests are refused', async () => {
      const a = org();
      const policyId = await activePolicy(w, a, [{ authorityOrganizationId: a }]);
      await asSetter(a, () => w.policies.retire(policyId, { expectedVersion: 2 }));
      const project = await readyProject(w, a);

      await expect(
        asAdmin(a, () => w.approvals.request(project.id, { expectedVersion: project.version })),
      ).rejects.toMatchObject({ code: 'BUSINESS_RULE_VIOLATION' });
    });

    it('refuses a stale version and an illegal policy transition', async () => {
      const a = org();
      const policyId = await activePolicy(w, a, [{ authorityOrganizationId: a }]);
      await expect(
        asSetter(a, () => w.policies.activate(policyId, { expectedVersion: 2 })),
      ).rejects.toMatchObject({
        code: 'BUSINESS_RULE_VIOLATION',
      });
      await expect(
        asSetter(a, () => w.policies.retire(policyId, { expectedVersion: 1 })),
      ).rejects.toMatchObject({
        code: 'OPTIMISTIC_LOCK_FAILED',
      });
    });

    it('lists policies by workflow and status', async () => {
      const a = org();
      await activePolicy(w, a, [{ authorityOrganizationId: a }]);
      await activePolicy(w, a, [{ authorityOrganizationId: a }], 'project.completion');
      const page = await asSetter(a, () =>
        w.policies.list({ limit: 25, workflowKey: 'project.completion' }),
      );
      expect(page.items.map((item) => item.workflowKey)).toEqual(['project.completion']);
      const active = await asSetter(a, () => w.policies.list({ limit: 1, status: 'ACTIVE' }));
      expect(active.hasMore).toBe(true);
    });
  });

  describe('the platform never approves by default', () => {
    it('refuses a request when the organization has no active policy', async () => {
      const a = org();
      const project = await readyProject(w, a);

      await expect(
        asAdmin(a, () => w.approvals.request(project.id, { expectedVersion: project.version })),
      ).rejects.toThrow(/never approves by default/);
      expect((await asAdmin(a, () => w.projects.get(project.id))).status).toBe('DRAFT');
    });

    it('refuses a request when no step applies to the estimate', async () => {
      const a = org();
      await activePolicy(w, a, [{ authorityOrganizationId: a, minAmountMinor: '5000000' }]);
      const project = await readyProject(w, a, '1000');

      await expect(
        asAdmin(a, () => w.approvals.request(project.id, { expectedVersion: project.version })),
      ).rejects.toThrow(/no step for this project's estimate/);
    });

    it('refuses a request without a submitted need or without an estimate (Q-68)', async () => {
      const a = org();
      await activePolicy(w, a, [{ authorityOrganizationId: a }]);
      const noNeed = await asAdmin(a, () =>
        w.projects.create({ ...PROJECT, estimatedCostMinor: '100' }),
      );
      await expect(
        asAdmin(a, () => w.approvals.request(noNeed.id, { expectedVersion: 1 })),
      ).rejects.toThrow(/submitted need/);

      const noEstimate = await asAdmin(a, () => w.projects.create(PROJECT));
      await expect(
        asAdmin(a, () => w.approvals.request(noEstimate.id, { expectedVersion: 1 })),
      ).rejects.toThrow(/estimate/);
    });

    it('honours the preconditions as configuration', async () => {
      const relaxed = wire(
        testEnv({
          CONSTRUCTION_APPROVAL_MIN_SUBMITTED_NEEDS: '0',
          CONSTRUCTION_APPROVAL_REQUIRES_ESTIMATE: 'false',
        }),
      );
      try {
        const a = org();
        await activePolicy(relaxed, a, [{ authorityOrganizationId: a }]);
        const bare = await asAdmin(a, () => relaxed.projects.create(PROJECT));
        const requested = await asAdmin(a, () =>
          relaxed.approvals.request(bare.id, { expectedVersion: 1 }),
        );
        expect(requested.status).toBe('PENDING_APPROVAL');
      } finally {
        await relaxed.close();
      }
    });
  });

  describe('a round', () => {
    it('asks steps in order, and only the last grant approves the project', async () => {
      const a = org();
      const council = org();
      await activePolicy(w, a, [
        { authorityOrganizationId: council, approvalType: 'Council approval' },
        {
          authorityOrganizationId: a,
          authorityRole: 'ORGANIZATION_ADMIN',
          approvalType: 'Own approval',
        },
      ]);
      const project = await readyProject(w, a);

      const requested = await asAdmin(a, () =>
        w.approvals.request(project.id, { expectedVersion: project.version }),
      );
      expect(requested).toMatchObject({ status: 'PENDING_APPROVAL' });

      let steps = await approvalsOf(w, a, project.id);
      expect(steps.map((step) => [step.stepOrder, step.status])).toEqual([
        [1, 'PENDING'],
        [2, 'QUEUED'],
      ]);

      const firstGrant = await asUser(council, ['ORGANIZATION_ADMIN'], () =>
        w.approvals.decide(steps[0]!.id, {
          expectedVersion: 1,
          decision: 'GRANT',
          decisionNumber: '1405-77',
          conditions: 'Work only in daylight',
        }),
      );
      expect(firstGrant).toMatchObject({
        status: 'GRANTED',
        decisionNumber: '1405-77',
        conditions: 'Work only in daylight',
      });
      expect((await asAdmin(a, () => w.projects.get(project.id))).status).toBe('PENDING_APPROVAL');

      steps = await approvalsOf(w, a, project.id);
      expect(steps[1]!.status).toBe('PENDING');
      await asAdmin(a, () =>
        w.approvals.decide(steps[1]!.id, { expectedVersion: 2, decision: 'GRANT' }),
      );

      const approved = await asAdmin(a, () => w.projects.get(project.id));
      expect(approved.status).toBe('APPROVED');

      const names = (await outboxFor(w.prisma, a))
        .map((row) => row.eventName)
        .filter((name) => /APPROVAL_(REQUESTED|GRANTED)|STATUS/.test(name));
      expect(names).toEqual([
        'PROJECT_STATUS_CHANGED',
        'APPROVAL_REQUESTED',
        'APPROVAL_GRANTED',
        'APPROVAL_REQUESTED',
        'APPROVAL_GRANTED',
        'PROJECT_STATUS_CHANGED',
      ]);
    });

    it('applies only the steps whose range contains the estimate', async () => {
      const a = org();
      await activePolicy(w, a, [
        { authorityOrganizationId: a, approvalType: 'Everyone' },
        { authorityOrganizationId: a, approvalType: 'Small', maxAmountMinor: '1000' },
        { authorityOrganizationId: a, approvalType: 'Large', minAmountMinor: '1000' },
      ]);
      const project = await readyProject(w, a, '1000');
      await asAdmin(a, () => w.approvals.request(project.id, { expectedVersion: project.version }));

      const steps = await approvalsOf(w, a, project.id);
      expect(steps.map((step) => step.approvalType)).toEqual(['Everyone', 'Large']);
    });

    it('ends the round on a rejection and sends the project back for changes', async () => {
      const a = org();
      await activePolicy(w, a, [{ authorityOrganizationId: a }, { authorityOrganizationId: a }]);
      const project = await readyProject(w, a);
      await asAdmin(a, () => w.approvals.request(project.id, { expectedVersion: project.version }));
      const [first] = await approvalsOf(w, a, project.id);

      const rejected = await asAdmin(a, () =>
        w.approvals.decide(first!.id, {
          expectedVersion: 1,
          decision: 'REJECT',
          reason: 'The estimate is not itemised',
        }),
      );
      expect(rejected).toMatchObject({
        status: 'REJECTED',
        reason: 'The estimate is not itemised',
      });

      const steps = await approvalsOf(w, a, project.id);
      expect(steps.map((step) => step.status)).toEqual(['REJECTED', 'SUPERSEDED']);
      const after = await asAdmin(a, () => w.projects.get(project.id));
      expect(after).toMatchObject({
        status: 'CHANGES_REQUESTED',
        statusReason: 'The estimate is not itemised',
      });
    });

    it('opens a fresh round on resubmission, against the policy in force then', async () => {
      const a = org();
      await activePolicy(w, a, [{ authorityOrganizationId: a, approvalType: 'Old step' }]);
      const project = await readyProject(w, a);
      await asAdmin(a, () => w.approvals.request(project.id, { expectedVersion: project.version }));
      const [first] = await approvalsOf(w, a, project.id);
      await asAdmin(a, () =>
        w.approvals.decide(first!.id, {
          expectedVersion: 1,
          decision: 'REJECT',
          reason: 'Please add the drainage',
        }),
      );

      await activePolicy(w, a, [{ authorityOrganizationId: a, approvalType: 'New step' }]);
      const current = await asAdmin(a, () => w.projects.get(project.id));
      await asAdmin(a, () => w.approvals.request(project.id, { expectedVersion: current.version }));

      const round2 = await asAdmin(a, () => w.approvals.listForProject(project.id, { round: 2 }));
      expect(round2.map((step) => [step.approvalType, step.status, step.policyVersion])).toEqual([
        ['New step', 'PENDING', 2],
      ]);
      const round1 = await asAdmin(a, () => w.approvals.listForProject(project.id, { round: 1 }));
      expect(round1.map((step) => step.approvalType)).toEqual(['Old step']);
    });

    it('keeps an open round on the steps it copied when the policy changes mid-round', async () => {
      const a = org();
      await activePolicy(w, a, [{ authorityOrganizationId: a, approvalType: 'Snapshotted' }]);
      const project = await readyProject(w, a);
      await asAdmin(a, () => w.approvals.request(project.id, { expectedVersion: project.version }));
      await activePolicy(w, a, [{ authorityOrganizationId: a, approvalType: 'Later policy' }]);

      const [step] = await approvalsOf(w, a, project.id);
      expect(step).toMatchObject({
        approvalType: 'Snapshotted',
        status: 'PENDING',
        policyVersion: 1,
      });
    });

    it('supersedes the open round when the project is cancelled', async () => {
      const a = org();
      await activePolicy(w, a, [{ authorityOrganizationId: a }, { authorityOrganizationId: a }]);
      const project = await readyProject(w, a);
      const pending = await asAdmin(a, () =>
        w.approvals.request(project.id, { expectedVersion: project.version }),
      );
      await asAdmin(a, () =>
        w.projects.cancel(project.id, {
          expectedVersion: pending.version,
          reason: 'Funding was withdrawn',
        }),
      );

      const steps = await approvalsOf(w, a, project.id);
      expect(steps.map((step) => step.status)).toEqual(['SUPERSEDED', 'SUPERSEDED']);
      await expect(
        asAdmin(a, () =>
          w.approvals.decide(steps[0]!.id, { expectedVersion: 2, decision: 'GRANT' }),
        ),
      ).rejects.toMatchObject({ code: 'BUSINESS_RULE_VIOLATION' });
    });
  });

  describe('only the named authority decides', () => {
    async function pendingStep(
      authorityOrganizationId: string,
      authorityRole = 'ORGANIZATION_ADMIN',
    ) {
      const a = org();
      await activePolicy(w, a, [{ authorityOrganizationId, authorityRole }]);
      const project = await readyProject(w, a);
      await asAdmin(a, () => w.approvals.request(project.id, { expectedVersion: project.version }));
      const [step] = await approvalsOf(w, a, project.id);
      return { projectOrg: a, projectId: project.id, step: step! };
    }

    it('refuses the project’s own administrator with 403 when another organization is the authority', async () => {
      const council = org();
      const { projectOrg, step } = await pendingStep(council);
      await expect(
        asAdmin(projectOrg, () =>
          w.approvals.decide(step.id, { expectedVersion: 1, decision: 'GRANT' }),
        ),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });

    it('answers 404 to a stranger, and to the right organization with the wrong role', async () => {
      const council = org();
      const { step } = await pendingStep(council, 'ORGANIZATION_ADMIN');
      await expect(
        asAdmin(org(), () =>
          w.approvals.decide(step.id, { expectedVersion: 1, decision: 'GRANT' }),
        ),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(
        asUser(council, ['FLEET_MANAGER'], () =>
          w.approvals.decide(step.id, { expectedVersion: 1, decision: 'GRANT' }),
        ),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('gives SYSTEM_ADMIN no decision the policy did not name', async () => {
      const council = org();
      const { step } = await pendingStep(council, 'ORGANIZATION_ADMIN');
      // It may see the step in its own organization, so it is told why (403),
      // but it cannot decide it.
      await expect(
        asUser(council, ['SYSTEM_ADMIN'], () => w.approvals.get(step.id)),
      ).resolves.toMatchObject({ id: step.id });
      await expect(
        asUser(council, ['SYSTEM_ADMIN'], () =>
          w.approvals.decide(step.id, { expectedVersion: 1, decision: 'GRANT' }),
        ),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      // A SYSTEM_ADMIN of an organization the step does not name learns nothing.
      await expect(
        asUser(org(), ['SYSTEM_ADMIN'], () =>
          w.approvals.decide(step.id, { expectedVersion: 1, decision: 'GRANT' }),
        ),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('refuses a stale version and a second decision', async () => {
      const council = org();
      const { step } = await pendingStep(council);
      await expect(
        asUser(council, ['ORGANIZATION_ADMIN'], () =>
          w.approvals.decide(step.id, { expectedVersion: 2, decision: 'GRANT' }),
        ),
      ).rejects.toMatchObject({ code: 'OPTIMISTIC_LOCK_FAILED' });
      await asUser(council, ['ORGANIZATION_ADMIN'], () =>
        w.approvals.decide(step.id, { expectedVersion: 1, decision: 'GRANT' }),
      );
      await expect(
        asUser(council, ['ORGANIZATION_ADMIN'], () =>
          w.approvals.decide(step.id, {
            expectedVersion: 2,
            decision: 'REJECT',
            reason: 'Changed my mind',
          }),
        ),
      ).rejects.toMatchObject({ code: 'BUSINESS_RULE_VIOLATION' });
    });

    it('lets exactly one of two concurrent decisions win', async () => {
      const council = org();
      const { step } = await pendingStep(council);
      const results = await Promise.allSettled([
        asUser(council, ['ORGANIZATION_ADMIN'], () =>
          w.approvals.decide(step.id, { expectedVersion: 1, decision: 'GRANT' }),
        ),
        asUser(council, ['ORGANIZATION_ADMIN'], () =>
          w.approvals.decide(step.id, {
            expectedVersion: 1,
            decision: 'REJECT',
            reason: 'A concurrent refusal',
          }),
        ),
      ]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    });

    it('shows the authority its inbox, and the approval with the project summary it needs', async () => {
      const council = org();
      const { projectId, step } = await pendingStep(council);
      const inbox = await asUser(council, ['ORGANIZATION_ADMIN'], () =>
        w.approvals.inbox({ limit: 25, status: 'PENDING' }),
      );
      expect(inbox.items.map((item) => item.id)).toEqual([step.id]);
      expect(inbox.items[0]).toMatchObject({
        projectId,
        project: { title: PROJECT.title, estimatedCostMinor: '1000000' },
      });

      const other = await asUser(council, ['FLEET_MANAGER'], () =>
        w.approvals.inbox({ limit: 25, status: 'PENDING' }),
      );
      expect(other.items).toEqual([]);

      await expect(
        asUser(council, ['ORGANIZATION_ADMIN'], () => w.approvals.get(step.id)),
      ).resolves.toMatchObject({ id: step.id });
      await expect(asAdmin(org(), () => w.approvals.get(step.id))).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });
  });
});
