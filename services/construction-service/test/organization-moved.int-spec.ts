import { eventEnvelopeSchema, type EventEnvelope } from '@rasta/contracts';
import { RastaError, runUnscoped } from '@rasta/nest-common';
import { ulid } from 'ulid';
import type { CreatePolicyDto } from '../src/approval/dto';
import type { WorkflowKey } from '../src/approval/approval.state-machine';
import { SYSTEM_ACTOR } from '../src/approval/policy-suspension.service';
import {
  approvalsOf,
  asAdmin,
  asPlatform,
  asSetter,
  cleanup,
  newOrganizationId,
  outboxFor,
  readyProject,
  wire,
  type Wiring,
} from './helpers';

/**
 * Q-83 (provisional, the owner's call): an approval policy a union wrote stops
 * governing an organization that left the union's subtree — suspended by the
 * ORGANIZATION_MOVED consumer in the event's own transaction, on every
 * delivery, by asking organization-service (here `FakeHierarchy`) what is true
 * now. Against PostgreSQL.
 */

describe('approval policies follow an ORGANIZATION_MOVED (Q-83)', () => {
  let w: Wiring;
  const organizations: string[] = [];

  const org = (): string => {
    const id = newOrganizationId();
    organizations.push(id);
    return id;
  };

  /** A union with a county beneath it. */
  function tree(): { union: string; county: string } {
    const union = org();
    const county = org();
    w.hierarchy.adopt(union, county);
    return { union, county };
  }

  const policyFor = (organizationId: string, workflowKey: WorkflowKey): CreatePolicyDto => ({
    organizationId,
    workflowKey,
    label: 'Execution approval',
    rationale: 'Written by the Q-83 suite',
    isSample: true,
    steps: [
      {
        approvalType: 'Council approval',
        authorityOrganizationId: organizationId,
        authorityRole: 'ORGANIZATION_ADMIN',
        authorityLabel: 'Council',
      },
    ],
  });

  /** `author` writes and submits, a different platform administrator approves. */
  async function inForce(
    author: string,
    organizationId: string,
    workflowKey: WorkflowKey = 'project.execution',
  ): Promise<string> {
    const policy = await asSetter(author, () =>
      w.policies.create(policyFor(organizationId, workflowKey)),
    );
    await asSetter(author, () => w.policies.submit(policy.id, { expectedVersion: 1 }));
    await asPlatform(() => w.policies.approve(policy.id, { expectedVersion: 2 }));
    return policy.id;
  }

  /** The platform administrator's own policy for an organization. */
  async function platformPolicy(organizationId: string): Promise<string> {
    const policy = await asPlatform(() =>
      w.policies.create(policyFor(organizationId, 'project.execution')),
    );
    await asPlatform(() => w.policies.submit(policy.id, { expectedVersion: 1 }));
    await asPlatform(() => w.policies.approve(policy.id, { expectedVersion: 2 }));
    return policy.id;
  }

  const row = (policyId: string) => w.approvalRepository.findPolicy(w.prisma.client, policyId);
  const statusOf = async (policyId: string) => (await row(policyId))?.status;

  /** An ORGANIZATION_MOVED envelope, as organization-service publishes it. */
  function moved(organizationId: string, eventId = ulid()): EventEnvelope {
    return eventEnvelopeSchema.parse({
      eventId,
      eventName: 'ORGANIZATION_MOVED',
      occurredAt: new Date().toISOString(),
      producer: 'organization-service',
      aggregateType: 'Organization',
      aggregateId: organizationId,
      tenantId: organizationId,
      correlationId: ulid(),
      payload: {
        organizationId,
        previousParentId: null,
        newParentId: null,
        previousPath: null,
        newPath: null,
        affectedCount: 1,
        reason: 'reorganisation',
      },
    }) as EventEnvelope;
  }

  const suspensions = async (organizationId: string) =>
    (await outboxFor(w.prisma, organizationId)).filter(
      (event) => event.eventName === 'APPROVAL_POLICY_SUSPENDED',
    );

  /**
   * The consumer's handler, then one sweep: what a delivery and the sweeper's
   * next tick do together. The handler alone only queues (see `queue` below).
   */
  const settle = async (event: EventEnvelope) => {
    const outcome = await w.moves.handle(event);
    await w.sweeper.runOnce();
    return outcome;
  };

  /** The tasks of a policy, oldest first. */
  const tasksOf = (policyId: string) =>
    runUnscoped('the suite reads the queue of the policies it wrote', () =>
      w.prisma.client.policyReconciliationTask.findMany({
        where: { policyId },
        orderBy: { createdAt: 'asc' },
      }),
    );

  /** Makes every open task of this suite's organizations due now, and lets its lease lapse. */
  const makeDue = () =>
    runUnscoped('the suite moves the retry time of its own tasks', () =>
      w.prisma.client.policyReconciliationTask.updateMany({
        where: { organizationId: { in: organizations }, status: 'PENDING' },
        data: { nextAttemptAt: new Date(0), leaseUntil: null, leaseToken: null },
      }),
    );

  beforeAll(() => {
    w = wire();
  });

  afterEach(() => {
    w.hierarchy.unavailable = false;
    w.hierarchy.timedOut = false;
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await cleanup(w.prisma, organizations);
    await w.close();
  });

  describe('what a move suspends', () => {
    it('suspends a union’s policy for an organization that left its subtree, and records who, when and why', async () => {
      const { union, county } = tree();
      const policyId = await inForce(union, county);
      w.hierarchy.disown(county);

      const event = moved(county);
      await expect(settle(event)).resolves.toBeUndefined();

      const suspended = await row(policyId);
      expect(suspended).toMatchObject({
        status: 'SUSPENDED',
        suspendedBy: SYSTEM_ACTOR,
        authorOrganizationId: union,
        organizationId: county,
      });
      expect(suspended?.suspendedAt).toBeInstanceOf(Date);
      expect(suspended?.suspensionReason).toContain(event.eventId);
      // The platform approval it once had is still on the record.
      expect(suspended?.activatedAt).toBeInstanceOf(Date);

      // The announcement is the audit record: one event, in the same stream as
      // the policy's other versions, in the tenant the policy belongs to.
      const [announced] = await suspensions(county);
      const { payload } = eventEnvelopeSchema.parse(announced!.payload);
      expect(payload).toMatchObject({
        policyId,
        organizationId: county,
        authorOrganizationId: union,
        workflowKey: 'project.execution',
        reason: 'ORGANIZATION_MOVED',
        causeEventId: event.eventId,
        movedOrganizationId: county,
        suspendedBy: SYSTEM_ACTOR,
      });
      expect(await suspensions(union)).toEqual([]);
    });

    it('a suspended policy never governs: no round opens on it, and the slot is free for a replacement', async () => {
      const { union, county } = tree();
      await inForce(union, county);
      const project = await readyProject(w, county);
      w.hierarchy.disown(county);
      await settle(moved(county));

      await expect(
        w.approvals.confirmGoverningPolicy(county, 'project.execution'),
      ).resolves.toBeNull();
      await expect(
        asAdmin(county, () =>
          w.approvals.request(project.id, { expectedVersion: project.version }),
        ),
      ).rejects.toMatchObject({ code: 'BUSINESS_RULE_VIOLATION' });
    });

    it('suspends every workflow of the organization, and only what its union no longer governs', async () => {
      const { union, county } = tree();
      const execution = await inForce(union, county, 'project.execution');
      const completion = await inForce(union, county, 'project.completion');
      const staying = org();
      w.hierarchy.adopt(union, staying);
      const other = await inForce(union, staying);

      w.hierarchy.disown(county);
      await settle(moved(county));

      expect(await statusOf(execution)).toBe('SUSPENDED');
      expect(await statusOf(completion)).toBe('SUSPENDED');
      expect(await statusOf(other)).toBe('ACTIVE');
    });

    it('suspends the policies of an organization beneath the one that moved', async () => {
      const { union, county } = tree();
      const village = org();
      w.hierarchy.adopt(county, village);
      const policyId = await inForce(union, village);

      // The county moved away, taking the village with it.
      w.hierarchy.disown(county);
      await settle(moved(county));

      expect(await statusOf(policyId)).toBe('SUSPENDED');
      expect((await suspensions(village)).length).toBe(1);
      expect(await suspensions(county)).toEqual([]);
    });

    it('keeps a policy whose union still governs the organization after a move within it', async () => {
      const root = org();
      const union = org();
      const county = org();
      w.hierarchy.adopt(root, union);
      w.hierarchy.adopt(union, county);
      const byUnion = await inForce(union, county, 'project.execution');
      const byRoot = await inForce(root, county, 'project.completion');

      // The county moves up, directly under the root: the root still governs
      // it, the union no longer does.
      w.hierarchy.adopt(root, county);
      await settle(moved(county));

      expect(await statusOf(byRoot)).toBe('ACTIVE');
      expect(await statusOf(byUnion)).toBe('SUSPENDED');
      expect((await suspensions(county)).length).toBe(1);
    });

    it('never suspends a policy the platform administrator wrote, or a union’s own', async () => {
      const union = org();
      const own = await inForce(union, union);
      const county = org();
      const platform = await platformPolicy(county);

      // Neither depends on the hierarchy: nobody governs `county`, and the union
      // is known to nobody as anything but itself.
      await settle(moved(county));

      expect(await statusOf(own)).toBe('ACTIVE');
      expect(await statusOf(platform)).toBe('ACTIVE');
    });
  });

  describe('rounds already open', () => {
    it('keep the steps they copied and can still be decided', async () => {
      const { union, county } = tree();
      const policyId = await inForce(union, county);
      const project = await readyProject(w, county);
      await asAdmin(county, () =>
        w.approvals.request(project.id, { expectedVersion: project.version }),
      );
      const [before] = await approvalsOf(w, county, project.id);

      w.hierarchy.disown(county);
      await settle(moved(county));
      expect(await statusOf(policyId)).toBe('SUSPENDED');

      // The snapshot names the suspended policy, unchanged, and still decides.
      const [after] = await approvalsOf(w, county, project.id);
      expect(after).toMatchObject({
        id: before!.id,
        policyId,
        status: 'PENDING',
        authorityOrganizationId: county,
      });
      await expect(
        asAdmin(county, () =>
          w.approvals.decide(before!.id, { expectedVersion: before!.version, decision: 'GRANT' }),
        ),
      ).resolves.toMatchObject({ status: 'GRANTED' });
    });
  });

  describe('idempotency and ordering: every delivery asks the truth again', () => {
    it('a redelivery, and a replay from `.retry`, suspend nothing more and announce nothing more', async () => {
      const { union, county } = tree();
      const policyId = await inForce(union, county);
      w.hierarchy.disown(county);
      const event = moved(county);

      await settle(event);
      const first = await row(policyId);
      // The handler cannot tell the main topic from `.retry`: the same event
      // again is the same call.
      await settle(event);
      await settle(event);

      const again = await row(policyId);
      expect(again).toMatchObject({ status: 'SUSPENDED', version: first!.version });
      expect(again?.suspendedAt).toEqual(first?.suspendedAt);
      expect((await suspensions(county)).length).toBe(1);
    });

    it('an outage leaves the policy untouched and the task queued; it is suspended when the answer comes, with no second move', async () => {
      const { union, county } = tree();
      const policyId = await inForce(union, county);
      w.hierarchy.disown(county);
      const event = moved(county);

      w.hierarchy.unavailable = true;
      await settle(event); // the handler queues; the sweep cannot ask, and does not throw
      expect(await statusOf(policyId)).toBe('ACTIVE');
      const [task] = await tasksOf(policyId);
      expect(task).toMatchObject({
        status: 'PENDING',
        attempts: 1,
        lastErrorCode: 'UPSTREAM_UNAVAILABLE',
        leaseToken: null,
      });
      // Backed off: not due again yet, so a sweep right now does nothing.
      expect(await w.sweeper.runOnce()).toMatchObject({ claimed: 0 });

      w.hierarchy.unavailable = false;
      await makeDue();
      await w.sweeper.runOnce();
      expect(await statusOf(policyId)).toBe('SUSPENDED');
      expect((await tasksOf(policyId))[0]).toMatchObject({ status: 'DONE', lastErrorCode: null });
    });

    it('a stale event replayed after the organization moved back suspends nothing', async () => {
      const { union, county } = tree();
      const policyId = await inForce(union, county);

      // Moved out and back before the first event was handled.
      w.hierarchy.disown(county);
      const out = moved(county);
      w.hierarchy.adopt(union, county);
      await settle(out);

      expect(await statusOf(policyId)).toBe('ACTIVE');
      expect(await suspensions(county)).toEqual([]);
    });

    it('two moves in a row converge on where the organization is now, in either order', async () => {
      const { union, county } = tree();
      const other = org();
      const policyId = await inForce(union, county);
      const first = moved(county);
      const second = moved(county);

      // Out of the union, then under another organization — still not the union's.
      w.hierarchy.disown(county);
      w.hierarchy.adopt(other, county);
      await settle(second);
      await settle(first);

      expect(await statusOf(policyId)).toBe('SUSPENDED');
      expect((await suspensions(county)).length).toBe(1);
    });

    it('a move back does not revive it; a new version goes through the normal flow (Q-83 A, B)', async () => {
      const { union, county } = tree();
      const suspendedId = await inForce(union, county);
      w.hierarchy.disown(county);
      await settle(moved(county));

      w.hierarchy.adopt(union, county);
      await settle(moved(county));
      expect(await statusOf(suspendedId)).toBe('SUSPENDED');
      await expect(
        w.approvals.confirmGoverningPolicy(county, 'project.execution'),
      ).resolves.toBeNull();

      // Nobody reactivates it: approve refuses, and the way forward is a new version.
      await expect(
        asPlatform(() => w.policies.approve(suspendedId, { expectedVersion: 4 })),
      ).rejects.toMatchObject({ code: 'BUSINESS_RULE_VIOLATION' });
      const replacement = await inForce(union, county);
      expect(replacement).not.toBe(suspendedId);
      await expect(w.approvals.confirmGoverningPolicy(county, 'project.execution')).resolves.toBe(
        replacement,
      );
      expect(await statusOf(suspendedId)).toBe('SUSPENDED');
    });

    it('a policy retired or replaced after it was queued is left alone, and its task is done', async () => {
      const { union, county } = tree();
      const policyId = await inForce(union, county);
      w.hierarchy.disown(county);
      await w.moves.handle(moved(county)); // queued while in force
      await asSetter(union, () => w.policies.retire(policyId, { expectedVersion: 3 }));

      await w.sweeper.runOnce();

      expect(await statusOf(policyId)).toBe('RETIRED');
      expect(await suspensions(county)).toEqual([]);
      expect((await tasksOf(policyId))[0]).toMatchObject({ status: 'DONE' });
    });
  });

  describe('fail closed', () => {
    it('suspends what it could confirm, leaves what it could not, and retries the latter later', async () => {
      const { union, county } = tree();
      const stranded = await inForce(union, county);
      const unknown = org();
      w.hierarchy.adopt(union, unknown);
      const unconfirmed = await inForce(union, unknown);
      w.hierarchy.disown(county);

      const answer = w.hierarchy.isWithin.bind(w.hierarchy);
      jest.spyOn(w.hierarchy, 'isWithin').mockImplementation(async (scope, organizationId) => {
        if (organizationId === unknown) throw RastaError.upstreamTimeout('organization-service', 1);
        return answer(scope, organizationId);
      });

      await settle(moved(county));

      expect(await statusOf(stranded)).toBe('SUSPENDED');
      expect(await statusOf(unconfirmed)).toBe('ACTIVE');
      expect((await tasksOf(stranded))[0]).toMatchObject({ status: 'DONE' });
      expect((await tasksOf(unconfirmed))[0]).toMatchObject({
        status: 'PENDING',
        attempts: 1,
        lastErrorCode: 'UPSTREAM_TIMEOUT',
      });
    });

    it('asks once per (union, organization) in a sweep however many policies name them', async () => {
      const { union, county } = tree();
      await inForce(union, county, 'project.execution');
      await inForce(union, county, 'project.completion');
      await w.moves.handle(moved(county));
      w.hierarchy.asked.length = 0;

      await w.sweeper.runOnce();

      expect(w.hierarchy.asked.filter(([scope, id]) => scope === union && id === county)).toEqual([
        [union, county],
      ]);
    });
  });

  describe('what the consumer ignores', () => {
    it('skips every other organization event', async () => {
      const { union, county } = tree();
      const policyId = await inForce(union, county);
      w.hierarchy.disown(county);
      const other = { ...moved(county), eventName: 'ORGANIZATION_UPDATED' };

      await expect(settle(other)).resolves.toBe('SKIPPED');
      expect(await statusOf(policyId)).toBe('ACTIVE');
    });

    it('dead-letters an ORGANIZATION_MOVED that names no organization, without retrying', async () => {
      const broken = { ...moved(org()), payload: {} };
      await expect(settle(broken)).rejects.toMatchObject({
        name: 'UnprocessableEventError',
        reason: 'VALIDATION_FAILED',
      });
    });
  });

  describe('approval racing a move', () => {
    /** A policy a union wrote and submitted, waiting for the platform (version 2). */
    async function pendingPolicy(union: string, county: string): Promise<string> {
      const policy = await asSetter(union, () =>
        w.policies.create(policyFor(county, 'project.execution')),
      );
      await asSetter(union, () => w.policies.submit(policy.id, { expectedVersion: 1 }));
      return policy.id;
    }

    const activations = async (organizationId: string) =>
      (await outboxFor(w.prisma, organizationId)).filter(
        (event) => event.eventName === 'APPROVAL_POLICY_ACTIVATED',
      );

    it('suspends a policy still waiting for the platform, and approval then refuses it', async () => {
      const { union, county } = tree();
      const policyId = await pendingPolicy(union, county);
      w.hierarchy.disown(county);

      await settle(moved(county));

      expect(await row(policyId)).toMatchObject({
        status: 'SUSPENDED',
        suspendedBy: SYSTEM_ACTOR,
        activatedAt: null,
      });
      const [announced] = await suspensions(county);
      expect(eventEnvelopeSchema.parse(announced!.payload).payload).toMatchObject({
        policyId,
        fromStatus: 'PENDING_PLATFORM_APPROVAL',
      });
      // Approval asks the hierarchy first and refuses; the interleaving where
      // it asked before the move is the next test.
      await expect(
        asPlatform(() => w.policies.approve(policyId, { expectedVersion: 2 })),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(await activations(county)).toEqual([]);
    });

    it('leaves a DRAFT alone: it becomes ACTIVE only through submit and approve, which ask again', async () => {
      const { union, county } = tree();
      const draft = await asSetter(union, () =>
        w.policies.create(policyFor(county, 'project.execution')),
      );
      w.hierarchy.disown(county);

      await settle(moved(county));

      expect(await statusOf(draft.id)).toBe('DRAFT');
      await expect(
        asSetter(union, () => w.policies.submit(draft.id, { expectedVersion: 1 })),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });

    it('approval that confirmed the union before the move cannot activate the policy after it', async () => {
      const { union, county } = tree();
      const policyId = await pendingPolicy(union, county);

      // Hold approval between its hierarchy answer and its transaction.
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let reached!: () => void;
      const atGate = new Promise<void>((resolve) => (reached = resolve));
      let armed = true;
      const answer = w.hierarchy.isWithin.bind(w.hierarchy);
      jest.spyOn(w.hierarchy, 'isWithin').mockImplementation(async (scope, organizationId) => {
        const within = await answer(scope, organizationId);
        if (armed && scope === union && organizationId === county) {
          armed = false;
          reached();
          await gate;
        }
        return within;
      });

      const approving = asPlatform(() => w.policies.approve(policyId, { expectedVersion: 2 }));
      await atGate; // approval has been told "within"; its transaction has not begun

      w.hierarchy.disown(county);
      await settle(moved(county)); // the move's handler runs first
      release();

      await expect(approving).rejects.toMatchObject({ code: 'BUSINESS_RULE_VIOLATION' });
      expect(await statusOf(policyId)).toBe('SUSPENDED');
      expect(await activations(county)).toEqual([]);
      await expect(
        w.approvals.confirmGoverningPolicy(county, 'project.execution'),
      ).resolves.toBeNull();
    });

    it('approval that commits first is suspended by the sweeper, whatever the task was queued for', async () => {
      const { union, county } = tree();
      const policyId = await pendingPolicy(union, county);
      // Queued while the policy was pending; approval then committed it, and
      // only then did the answer come back "outside".
      await w.moves.handle(moved(county));
      await asPlatform(() => w.policies.approve(policyId, { expectedVersion: 2 }));
      expect(await statusOf(policyId)).toBe('ACTIVE');
      w.hierarchy.disown(county);

      await w.sweeper.runOnce();

      expect(await statusOf(policyId)).toBe('SUSPENDED');
      const [announced] = await suspensions(county);
      expect(eventEnvelopeSchema.parse(announced!.payload).payload).toMatchObject({
        fromStatus: 'ACTIVE',
      });
    });
  });

  describe('the durable queue (D-041)', () => {
    /** `count` organizations under `union`, each with a union-written policy in force. */
    async function manyStranded(count: number): Promise<{ union: string; policies: string[] }> {
      const union = org();
      const policies: string[] = [];
      for (let index = 0; index < count; index += 1) {
        const child = org();
        w.hierarchy.adopt(union, child);
        policies.push(await inForce(union, child));
        w.hierarchy.disown(child);
      }
      return { union, policies };
    }

    it('the handler only queues: no hierarchy lookup, a task per stranded policy, nothing suspended', async () => {
      const { union, county } = tree();
      const policyId = await inForce(union, county);
      w.hierarchy.disown(county);
      w.hierarchy.asked.length = 0;

      await w.moves.handle(moved(county));

      expect(w.hierarchy.asked).toEqual([]);
      expect(await statusOf(policyId)).toBe('ACTIVE');
      const [task] = await tasksOf(policyId);
      expect(task).toMatchObject({
        organizationId: county,
        unionId: union,
        movedOrganizationId: county,
        status: 'PENDING',
        attempts: 0,
      });
    });

    it('more policies than a sweep takes all end SUSPENDED once the sweeper has drained, with no second move', async () => {
      const { policies } = await manyStranded(5);
      await w.moves.handle(moved(org()));
      const small = w.sweeperWith({ batchSize: 2 });

      const sweeps = [];
      // Bounded batches, then nothing due; other suites' leftovers may add tasks.
      for (let guard = 0; guard < 50; guard += 1) {
        const outcome = await small.runOnce();
        sweeps.push(outcome);
        if (outcome.claimed === 0) break;
        expect(outcome.claimed).toBeLessThanOrEqual(2);
      }

      expect(sweeps.length).toBeGreaterThan(1);
      for (const policyId of policies) expect(await statusOf(policyId)).toBe('SUSPENDED');
    });

    it('a replay, a `.retry` delivery and a second move coalesce into one open task', async () => {
      const { union, county } = tree();
      const policyId = await inForce(union, county);
      w.hierarchy.disown(county);
      const event = moved(county);

      await w.moves.handle(event);
      await w.moves.handle(event); // redelivery, or `.retry`: the same call
      await w.moves.handle(moved(county)); // another move before the sweep

      const tasks = await tasksOf(policyId);
      expect(tasks.filter((task) => task.status === 'PENDING').length).toBe(1);
      expect(tasks.length).toBe(1);
      expect(tasks[0]?.sourceEventId).toBe(event.eventId);
      await w.sweeper.runOnce();
      expect(await statusOf(policyId)).toBe('SUSPENDED');
      expect((await suspensions(county)).length).toBe(1);
    });

    it('a replay after the task is done queues a fresh look', async () => {
      const { union, county } = tree();
      const policyId = await inForce(union, county);
      await settle(moved(county)); // within: DONE, nothing changed
      expect((await tasksOf(policyId))[0]).toMatchObject({ status: 'DONE' });

      w.hierarchy.disown(county);
      await settle(moved(county));

      expect((await tasksOf(policyId)).length).toBe(2);
      expect(await statusOf(policyId)).toBe('SUSPENDED');
    });

    it('two sweepers running together never suspend a policy twice', async () => {
      const { policies } = await manyStranded(6);
      await w.moves.handle(moved(org()));

      const [a, b] = [w.sweeperWith({ batchSize: 3 }), w.sweeperWith({ batchSize: 3 })];
      for (let round = 0; round < 6; round += 1) await Promise.all([a.runOnce(), b.runOnce()]);

      for (const policyId of policies) {
        expect(await statusOf(policyId)).toBe('SUSPENDED');
        const [task] = await tasksOf(policyId);
        expect((await suspensions(task!.organizationId)).length).toBe(1);
      }
    });

    it('a sweeper whose lease was taken back cannot finish the new holder’s task', async () => {
      const { union, county } = tree();
      const policyId = await inForce(union, county);
      w.hierarchy.disown(county);
      await w.moves.handle(moved(county));

      const first = await w.reconciliations.claimDue(500, 120, 'TOKEN_A');
      const mine = first.find((task) => task.policyId === policyId)!;
      await makeDue(); // the lease lapses ...
      const second = await w.reconciliations.claimDue(500, 120, 'TOKEN_B'); // ... and another takes it
      expect(second.map((task) => task.id)).toContain(mine.id);

      expect(await w.reconciliations.markDone(mine)).toBe(0);
      expect(await w.reconciliations.retryLater(mine, 'INTERNAL', 1)).toBe(0);
      expect((await tasksOf(policyId))[0]).toMatchObject({
        status: 'PENDING',
        leaseToken: 'TOKEN_B',
      });
    });

    it('a round opened on a stranded policy suspends it, and is still refused', async () => {
      const { union, county } = tree();
      const policyId = await inForce(union, county);
      const project = await readyProject(w, county);
      w.hierarchy.disown(county); // no move event has been handled yet

      await expect(
        asAdmin(county, () =>
          w.approvals.request(project.id, { expectedVersion: project.version }),
        ),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });

      expect(await row(policyId)).toMatchObject({ status: 'SUSPENDED', suspendedBy: SYSTEM_ACTOR });
      const [announced] = await suspensions(county);
      expect(eventEnvelopeSchema.parse(announced!.payload).payload).toMatchObject({
        policyId,
        reason: 'ROUND_OPENING_RECHECK',
        causeEventId: null,
        movedOrganizationId: null,
      });
    });

    it('a task for one tenant never touches another tenant’s policy', async () => {
      const { union, county } = tree();
      const stranded = await inForce(union, county);
      const otherUnion = org();
      const otherCounty = org();
      w.hierarchy.adopt(otherUnion, otherCounty);
      const kept = await inForce(otherUnion, otherCounty);
      const keptBefore = await row(kept);
      w.hierarchy.disown(county);

      await settle(moved(county));

      expect(await statusOf(stranded)).toBe('SUSPENDED');
      expect(await row(kept)).toMatchObject({ status: 'ACTIVE', version: keptBefore!.version });
      // Each task names the tenant of its own policy, not the moved organization's.
      expect((await tasksOf(stranded))[0]).toMatchObject({ organizationId: county });
      expect((await tasksOf(kept))[0]).toMatchObject({
        organizationId: otherCounty,
        status: 'DONE',
      });
      expect(await suspensions(otherCounty)).toEqual([]);
    });

    it('reports the backlog and how long the oldest due task has waited', async () => {
      const { union, county } = tree();
      await inForce(union, county);
      w.hierarchy.disown(county);
      await w.moves.handle(moved(county));
      await makeDue();

      const backlog = await w.reconciliations.backlog();
      expect(backlog.open).toBeGreaterThanOrEqual(1);
      expect(backlog.due).toBeGreaterThanOrEqual(1);
      expect(backlog.oldestDueAgeSeconds).toBeGreaterThan(0);
      await w.sweeper.runOnce();
    });
  });

  describe('tenant isolation', () => {
    it('touches only the policies whose union lost them, in the tenant each names', async () => {
      const { union, county } = tree();
      const stranded = await inForce(union, county);

      const otherUnion = org();
      const otherCounty = org();
      w.hierarchy.adopt(otherUnion, otherCounty);
      const untouched = await inForce(otherUnion, otherCounty);
      const outboxBefore = (await outboxFor(w.prisma, otherCounty)).length;

      w.hierarchy.disown(county);
      await settle(moved(county));

      expect(await statusOf(stranded)).toBe('SUSPENDED');
      expect(await statusOf(untouched)).toBe('ACTIVE');
      expect((await outboxFor(w.prisma, otherCounty)).length).toBe(outboxBefore);
    });

    it('does not let another tenant read or approve the suspended policy', async () => {
      const { union, county } = tree();
      const policyId = await inForce(union, county);
      w.hierarchy.disown(county);
      await settle(moved(county));
      const stranger = org();

      await expect(asSetter(stranger, () => w.policies.get(policyId))).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
      await expect(asSetter(stranger, () => w.policies.list({ limit: 50 }))).resolves.toMatchObject(
        { items: [] },
      );
      // The county and the union still read it, as SUSPENDED, with who and why.
      await expect(asSetter(union, () => w.policies.get(policyId))).resolves.toMatchObject({
        status: 'SUSPENDED',
        suspendedBy: SYSTEM_ACTOR,
      });
    });
  });
});
