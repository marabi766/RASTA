import { eventEnvelopeSchema, type EventEnvelope } from '@rasta/contracts';
import { RastaError } from '@rasta/nest-common';
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
      await expect(w.moves.handle(event)).resolves.toBeUndefined();

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
      await w.moves.handle(moved(county));

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
      await w.moves.handle(moved(county));

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
      await w.moves.handle(moved(county));

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
      await w.moves.handle(moved(county));

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
      await w.moves.handle(moved(county));

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
      await w.moves.handle(moved(county));
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

      await w.moves.handle(event);
      const first = await row(policyId);
      // The handler cannot tell the main topic from `.retry`: the same event
      // again is the same call.
      await w.moves.handle(event);
      await w.moves.handle(event);

      const again = await row(policyId);
      expect(again).toMatchObject({ status: 'SUSPENDED', version: first!.version });
      expect(again?.suspendedAt).toEqual(first?.suspendedAt);
      expect((await suspensions(county)).length).toBe(1);
    });

    it('a replayed event finds an outage over and suspends then, not never', async () => {
      const { union, county } = tree();
      const policyId = await inForce(union, county);
      w.hierarchy.disown(county);
      const event = moved(county);

      w.hierarchy.unavailable = true;
      await expect(w.moves.handle(event)).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
      expect(await statusOf(policyId)).toBe('ACTIVE');

      w.hierarchy.unavailable = false;
      await w.moves.handle(event);
      expect(await statusOf(policyId)).toBe('SUSPENDED');
    });

    it('a stale event replayed after the organization moved back suspends nothing', async () => {
      const { union, county } = tree();
      const policyId = await inForce(union, county);

      // Moved out and back before the first event was handled.
      w.hierarchy.disown(county);
      const out = moved(county);
      w.hierarchy.adopt(union, county);
      await w.moves.handle(out);

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
      await w.moves.handle(second);
      await w.moves.handle(first);

      expect(await statusOf(policyId)).toBe('SUSPENDED');
      expect((await suspensions(county)).length).toBe(1);
    });

    it('a move back does not revive it; a new version goes through the normal flow (Q-83 A, B)', async () => {
      const { union, county } = tree();
      const suspendedId = await inForce(union, county);
      w.hierarchy.disown(county);
      await w.moves.handle(moved(county));

      w.hierarchy.adopt(union, county);
      await w.moves.handle(moved(county));
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

    it('a policy retired or replaced since it was listed is left alone', async () => {
      const { union, county } = tree();
      const policyId = await inForce(union, county);
      const candidate = {
        id: policyId,
        organizationId: county,
        authorOrganizationId: union,
        workflowKey: 'project.execution' as const,
        policyVersion: 1,
      };
      // The list was read while it was in force; then it was retired.
      jest
        .spyOn(w.approvalRepository, 'listUnionPoliciesToReconfirm')
        .mockResolvedValueOnce([candidate]);
      await asSetter(union, () => w.policies.retire(policyId, { expectedVersion: 3 }));
      w.hierarchy.disown(county);

      await w.moves.handle(moved(county));

      expect(await statusOf(policyId)).toBe('RETIRED');
      expect(await suspensions(county)).toEqual([]);
    });
  });

  describe('fail closed', () => {
    it('suspends what it could confirm, refuses what it could not, and rethrows so the event is retried', async () => {
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

      await expect(w.moves.handle(moved(county))).rejects.toMatchObject({
        code: 'UPSTREAM_TIMEOUT',
      });
      expect(await statusOf(stranded)).toBe('SUSPENDED');
      expect(await statusOf(unconfirmed)).toBe('ACTIVE');
    });

    it('asks once per (union, organization) however many policies name them', async () => {
      const { union, county } = tree();
      await inForce(union, county, 'project.execution');
      await inForce(union, county, 'project.completion');
      w.hierarchy.asked.length = 0;

      await w.moves.handle(moved(county));

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

      await expect(w.moves.handle(other)).resolves.toBe('SKIPPED');
      expect(await statusOf(policyId)).toBe('ACTIVE');
    });

    it('dead-letters an ORGANIZATION_MOVED that names no organization, without retrying', async () => {
      const broken = { ...moved(org()), payload: {} };
      await expect(w.moves.handle(broken)).rejects.toMatchObject({
        name: 'UnprocessableEventError',
        reason: 'VALIDATION_FAILED',
      });
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
      await w.moves.handle(moved(county));

      expect(await statusOf(stranded)).toBe('SUSPENDED');
      expect(await statusOf(untouched)).toBe('ACTIVE');
      expect((await outboxFor(w.prisma, otherCounty)).length).toBe(outboxBefore);
    });

    it('does not let another tenant read or approve the suspended policy', async () => {
      const { union, county } = tree();
      const policyId = await inForce(union, county);
      w.hierarchy.disown(county);
      await w.moves.handle(moved(county));
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
