import { runUnscoped } from '@rasta/nest-common';
import { policySlotLockKey } from '../src/approval/approval.repository';
import type { WorkflowKey } from '../src/approval/approval.state-machine';
import {
  activePolicy,
  approvalsOf,
  asAdmin,
  asPlatform,
  asSetter,
  cleanup,
  newOrganizationId,
  readyProject,
  wire,
  type Wiring,
} from './helpers';

/**
 * The policy in force is serialised with the rounds opened on it (Codex
 * review of #122, round 2), against PostgreSQL, with deterministic barriers —
 * no sleeps, no timing:
 *
 * - an approval committed between a command's pre-transaction confirmation
 *   and its in-transaction read is caught: 409, and nothing is opened on the
 *   policy that was not confirmed — never COMPLETED without the round a
 *   completion policy now requires, never a round on a replaced P1;
 * - an approval that arrives while a round is being opened waits for the
 *   slot lock (observed in `pg_locks`, on exactly this slot's key) and lands
 *   after the round commits — the two never interleave.
 */
describe('the policy in force is serialised with rounds (policy slot lock)', () => {
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

  /** Written and submitted by the organization's union, awaiting the platform (version 2). */
  async function pendingPolicy(organizationId: string, workflowKey: WorkflowKey): Promise<string> {
    const policy = await asSetter(organizationId, () =>
      w.policies.create({
        organizationId,
        workflowKey,
        label: `Pending ${workflowKey}`,
        rationale: 'Written by the policy slot suite',
        isSample: true,
        steps: [
          {
            approvalType: 'Technical approval',
            authorityOrganizationId: organizationId,
            authorityRole: 'ORGANIZATION_ADMIN',
            authorityLabel: 'Engineer',
          },
        ],
      }),
    );
    await asSetter(organizationId, () => w.policies.submit(policy.id, { expectedVersion: 1 }));
    return policy.id;
  }

  const approve = (policyId: string) =>
    asPlatform(() => w.policies.approve(policyId, { expectedVersion: 2 }));

  /** An IN_PROGRESS project whose latest submitted report says 100%. */
  async function executedProject(a: string): Promise<{ id: string; version: number }> {
    await activePolicy(w, a, [{ authorityOrganizationId: a }]);
    const ready = await readyProject(w, a);
    await asAdmin(a, () => w.approvals.request(ready.id, { expectedVersion: ready.version }));
    const [step] = await approvalsOf(w, a, ready.id);
    await asAdmin(a, () => w.approvals.decide(step!.id, { expectedVersion: 1, decision: 'GRANT' }));
    const approved = await asAdmin(a, () => w.projects.get(ready.id));
    await asAdmin(a, () => w.execution.start(ready.id, { expectedVersion: approved.version }));
    const draft = await asAdmin(a, () =>
      w.progress.draft(ready.id, { progressBasisPoints: 10_000, assetsUsed: [] }),
    );
    await asAdmin(a, () => w.progress.submit(ready.id, draft.id, { expectedVersion: 1 }));
    const current = await asAdmin(a, () => w.projects.get(ready.id));
    return { id: current.id, version: current.version };
  }

  /** Runs `between` after the command's pre-transaction confirmation, before its transaction. */
  function afterConfirmation(between: () => Promise<unknown>): void {
    const original = w.approvals.confirmGoverningPolicy.bind(w.approvals);
    jest
      .spyOn(w.approvals, 'confirmGoverningPolicy')
      .mockImplementationOnce(async (organizationId, workflowKey) => {
        const confirmed = await original(organizationId, workflowKey);
        await between();
        return confirmed;
      });
  }

  /**
   * Pauses the next round-opening transaction right after it has read the
   * policy in force (slot lock held). `reached` resolves there; `release`
   * lets it go on to commit.
   */
  function pauseAfterPolicyRead(): { reached: Promise<void>; release: () => void } {
    const original = w.approvalRepository.findActivePolicy.bind(w.approvalRepository);
    let signal!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((resolve) => (signal = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));
    jest
      .spyOn(w.approvalRepository, 'findActivePolicy')
      .mockImplementationOnce(async (tx, workflowKey) => {
        const policy = await original(tx, workflowKey);
        signal();
        await gate;
        return policy;
      });
    return { reached, release };
  }

  /** Resolves once some backend is waiting for exactly this slot's advisory lock. */
  async function someoneWaitsFor(organizationId: string, workflowKey: WorkflowKey): Promise<void> {
    const key = BigInt.asUintN(64, policySlotLockKey(organizationId, workflowKey));
    const classid = Number(key >> 32n);
    const objid = Number(key & 0xffffffffn);
    for (;;) {
      const [row] = await runUnscoped('observe advisory lock waiters in the test', () =>
        w.prisma.client.$queryRawUnsafe<{ waiting: number }[]>(
          `SELECT count(*)::int AS waiting FROM pg_locks
            WHERE locktype = 'advisory' AND NOT granted
              AND classid = $1::oid AND objid = $2::oid AND objsubid = 1`,
          classid,
          objid,
        ),
      );
      if ((row?.waiting ?? 0) > 0) return;
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  const policyStatus = async (policyId: string) =>
    (await w.approvalRepository.findPolicy(w.prisma.client, policyId))?.status;

  it('derives one stable 64-bit key per (organization, workflow) slot', () => {
    expect(policySlotLockKey('ORG-A', 'project.completion')).toBe(
      policySlotLockKey('ORG-A', 'project.completion'),
    );
    expect(policySlotLockKey('ORG-A', 'project.completion')).not.toBe(
      policySlotLockKey('ORG-A', 'project.execution'),
    );
    expect(policySlotLockKey('ORG-A', 'project.execution')).not.toBe(
      policySlotLockKey('ORG-B', 'project.execution'),
    );
  });

  describe('completion, with no completion policy confirmed', () => {
    it('an activation committed before the transaction reads → 409; never COMPLETED without a round', async () => {
      const a = org();
      const project = await executedProject(a);
      const completion = await pendingPolicy(a, 'project.completion');
      afterConfirmation(() => approve(completion)); // confirmed "none"; now one is in force

      await expect(
        asAdmin(a, () => w.execution.complete(project.id, { expectedVersion: project.version })),
      ).rejects.toMatchObject({ code: 'OPTIMISTIC_LOCK_FAILED' });
      expect(await asAdmin(a, () => w.projects.get(project.id))).toMatchObject({
        status: 'IN_PROGRESS',
        version: project.version,
      });
      const opened = (await approvalsOf(w, a, project.id)).filter(
        (step) => step.workflowKey === 'project.completion',
      );
      expect(opened).toHaveLength(0);

      // The retry sees the policy now in force and opens its round.
      await asAdmin(a, () =>
        w.execution.complete(project.id, { expectedVersion: project.version }),
      );
      const round = (await approvalsOf(w, a, project.id)).filter(
        (step) => step.workflowKey === 'project.completion',
      );
      expect(round).toHaveLength(1);
      expect(round[0]).toMatchObject({ policyId: completion, status: 'PENDING' });
      expect(await asAdmin(a, () => w.projects.get(project.id))).toMatchObject({
        status: 'IN_PROGRESS',
      });
    });

    it('an activation arriving while the round is being opened waits, and lands after it', async () => {
      const a = org();
      const project = await executedProject(a);
      const completion = await pendingPolicy(a, 'project.completion');
      const pause = pauseAfterPolicyRead();

      const completing = asAdmin(a, () =>
        w.execution.complete(project.id, { expectedVersion: project.version }),
      );
      await pause.reached; // read "no policy", slot lock held
      let approved = false;
      const approving = approve(completion).then((view) => {
        approved = true;
        return view;
      });
      await someoneWaitsFor(a, 'project.completion'); // the approval is blocked on this slot
      expect(approved).toBe(false);
      expect(await policyStatus(completion)).toBe('PENDING_PLATFORM_APPROVAL');

      pause.release();
      // Serialised: the completion committed on the policy set it read ("none"),
      // and only then did the policy come into force.
      await expect(completing).resolves.toMatchObject({ status: 'COMPLETED' });
      await expect(approving).resolves.toMatchObject({ status: 'ACTIVE' });

      const completed = await asAdmin(a, () => w.projects.get(project.id));
      const policy = await w.approvalRepository.findPolicy(w.prisma.client, completion);
      expect(new Date(completed.statusChangedAt!).getTime()).toBeLessThanOrEqual(
        policy!.activatedAt!.getTime(),
      );
    });
  });

  describe('execution, with P1 confirmed and P2 replacing it', () => {
    it('P2 approved before the transaction reads → 409; no round is opened on the retired P1', async () => {
      const a = org();
      const p1 = await activePolicy(w, a, [{ authorityOrganizationId: a }]);
      const p2 = await pendingPolicy(a, 'project.execution');
      const project = await readyProject(w, a);
      afterConfirmation(() => approve(p2)); // confirmed P1; now P2 is in force

      await expect(
        asAdmin(a, () => w.approvals.request(project.id, { expectedVersion: project.version })),
      ).rejects.toMatchObject({ code: 'OPTIMISTIC_LOCK_FAILED' });
      expect(await approvalsOf(w, a, project.id)).toHaveLength(0);
      expect(await policyStatus(p1)).toBe('RETIRED');

      await asAdmin(a, () => w.approvals.request(project.id, { expectedVersion: project.version }));
      const round = await approvalsOf(w, a, project.id);
      expect(round.map((step) => step.policyId)).toEqual([p2]);
    });

    it('P2 arriving while a round is opened on P1 waits; the round snapshots P1, then P2 takes over', async () => {
      const a = org();
      const p1 = await activePolicy(w, a, [{ authorityOrganizationId: a }]);
      const p2 = await pendingPolicy(a, 'project.execution');
      const project = await readyProject(w, a);
      const pause = pauseAfterPolicyRead();

      const requesting = asAdmin(a, () =>
        w.approvals.request(project.id, { expectedVersion: project.version }),
      );
      await pause.reached; // read P1, slot lock held
      let approved = false;
      const approving = approve(p2).then((view) => {
        approved = true;
        return view;
      });
      await someoneWaitsFor(a, 'project.execution');
      expect(approved).toBe(false);
      expect(await policyStatus(p1)).toBe('ACTIVE');

      pause.release();
      await expect(requesting).resolves.toMatchObject({ status: 'PENDING_APPROVAL' });
      await expect(approving).resolves.toMatchObject({ status: 'ACTIVE' });

      // The round was opened while P1 was in force, and keeps P1's snapshot.
      const round = await approvalsOf(w, a, project.id);
      expect(round.map((step) => step.policyId)).toEqual([p1]);
      expect(await policyStatus(p1)).toBe('RETIRED');
    });

    it('a retirement arriving while a round is opened waits for it, too', async () => {
      const a = org();
      const p1 = await activePolicy(w, a, [{ authorityOrganizationId: a }]);
      const project = await readyProject(w, a);
      const pause = pauseAfterPolicyRead();

      const requesting = asAdmin(a, () =>
        w.approvals.request(project.id, { expectedVersion: project.version }),
      );
      await pause.reached;
      let retired = false;
      const retiring = asSetter(a, () => w.policies.retire(p1, { expectedVersion: 3 })).then(
        (view) => {
          retired = true;
          return view;
        },
      );
      await someoneWaitsFor(a, 'project.execution');
      expect(retired).toBe(false);

      pause.release();
      await expect(requesting).resolves.toMatchObject({ status: 'PENDING_APPROVAL' });
      await expect(retiring).resolves.toMatchObject({ status: 'RETIRED' });
      expect((await approvalsOf(w, a, project.id)).map((step) => step.policyId)).toEqual([p1]);
    });
  });
});
