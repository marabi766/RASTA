import request from 'supertest';
import { runUnscoped } from '@rasta/nest-common';
import { eventEnvelopeSchema, type EventEnvelope } from '@rasta/contracts';
import { ulid } from 'ulid';
import { OrganizationMovedConsumer } from '../src/events/organization-moved.consumer';
import { PolicyReconciliationRepository } from '../src/policy/policy-reconciliation.repository';
import { PolicyReconciliationSweeper } from '../src/policy/policy-reconciliation.sweeper';
import { PolicySuspensionService } from '../src/policy/policy-suspension.service';
import { actor, person, startApi, type ApiHarness } from './api-helpers';
import {
  cleanup,
  eventsOf,
  policyEventsOf,
  seedDraft,
  untilSessionsWaitOnALock,
  wire,
  type Wiring,
} from './helpers';

/**
 * A signing policy a union wrote follows the organization it was written for (Q-70 (7), Q-83;
 * #231 review round 2), over the real `AppModule`, real guards and a real database. Two lines
 * keep it from authorising a signature once the union has lost the employer:
 *
 *   - the move: `ORGANIZATION_MOVED` queues a re-check (database work only), the sweeper asks the
 *     hierarchy and suspends, and a suspended policy authorises nobody;
 *   - the signature itself: the hierarchy is asked **at the moment of signing**, under the policy
 *     slot's lock — a policy approved long ago, with no move event seen yet, still refuses; an
 *     answer that cannot be had refuses too, and nothing is recorded.
 */
describe('a signing policy follows an organization move', () => {
  let api: ApiHarness;
  let w: Wiring;
  const organizations: string[] = [];

  const http = () => request(api.app.getHttpServer());
  const key = (): string => `moved-${ulid()}`;
  const platform = (): string => person('ORG-ITEST-PLATFORM', ['SYSTEM_ADMIN']);
  const newOrg = (): string => {
    const id = `ORG_${ulid()}`;
    organizations.push(id);
    return id;
  };

  const sign = (id: string, token: string) =>
    http()
      .post(`/v1/contracts/${id}/sign`)
      .set('authorization', `Bearer ${token}`)
      .set('idempotency-key', key())
      .send({});
  const command = (token: string, id: string, verb: string, payload: object) =>
    http()
      .post(`/v1/approval-policies/${id}/${verb}`)
      .set('authorization', `Bearer ${token}`)
      .send(payload);
  const reasons = (body: { details?: { path: string; code: string }[] }) =>
    body.details?.map((detail) => `${detail.path}:${detail.code}`);

  /** A policy written by `unionOrg` for `employer`, submitted and approved: ACTIVE. */
  async function activeUnionPolicy(unionOrg: string, employer: string): Promise<string> {
    api.hierarchy.adopt(unionOrg, employer);
    const unionAdmin = person(unionOrg, ['UNION_ADMIN']);
    const written = await http()
      .post('/v1/approval-policies')
      .set('authorization', `Bearer ${unionAdmin}`)
      .set('idempotency-key', key())
      .send({
        organizationId: employer,
        workflowKey: 'contract.signature',
        label: 'Who signs for the employer',
        rationale: 'Decided by the union for the integration suite',
        isSample: true,
        steps: [
          {
            authorityOrganizationId: employer,
            authorityRole: 'ORGANIZATION_ADMIN',
            authorityLabel: 'Signer',
          },
        ],
      })
      .expect(201);
    await command(unionAdmin, written.body.id, 'submit', { expectedVersion: 1 }).expect(200);
    await command(platform(), written.body.id, 'approve', { expectedVersion: 2 }).expect(200);
    return written.body.id as string;
  }

  /** A policy the platform administrator wrote for `employer` (its own organization), approved by another. */
  async function activePlatformPolicy(employer: string): Promise<string> {
    const author = actor(employer, ['SYSTEM_ADMIN']);
    const written = await http()
      .post('/v1/approval-policies')
      .set('authorization', `Bearer ${author}`)
      .set('idempotency-key', key())
      .send({
        organizationId: employer,
        workflowKey: 'contract.signature',
        label: 'Who signs for the employer',
        rationale: 'Written by the platform for the integration suite',
        isSample: true,
        steps: [
          {
            authorityOrganizationId: employer,
            authorityRole: 'ORGANIZATION_ADMIN',
            authorityLabel: 'Signer',
          },
        ],
      })
      .expect(201);
    await command(author, written.body.id, 'submit', { expectedVersion: 1 }).expect(200);
    await command(platform(), written.body.id, 'approve', { expectedVersion: 2 }).expect(200);
    return written.body.id as string;
  }

  const policyRow = (policyId: string) =>
    runUnscoped('the suite reads the policy', () =>
      w.prisma.client.approvalPolicy.findFirstOrThrow({ where: { id: policyId } }),
    );
  const tasksOf = (policyId: string) =>
    runUnscoped('the suite reads the queue', () =>
      w.prisma.client.policyReconciliationTask.findMany({
        where: { policyId },
        orderBy: { createdAt: 'asc' },
      }),
    );
  const signaturesOf = (contractId: string) =>
    runUnscoped('the suite reads the signatures', () =>
      w.prisma.client.contractSignature.findMany({ where: { contractId } }),
    );

  const moved = (organizationId: string): EventEnvelope =>
    eventEnvelopeSchema.parse({
      eventId: ulid(),
      eventName: 'ORGANIZATION_MOVED',
      occurredAt: new Date().toISOString(),
      producer: 'organization-service',
      aggregateType: 'Organization',
      aggregateId: organizationId,
      correlationId: ulid(),
      payload: { organizationId, fromParentId: 'ORG_OLD', toParentId: 'ORG_NEW' },
    }) as EventEnvelope;

  let consumer: OrganizationMovedConsumer;
  let sweeper: PolicyReconciliationSweeper;
  const silent = { info: () => undefined, warn: () => undefined, debug: () => undefined };

  beforeAll(async () => {
    api = await startApi();
    api.hierarchy.everyoneIsMine = false;
    w = wire();
    const suspension = api.app.get(PolicySuspensionService);
    consumer = new OrganizationMovedConsumer(
      () => {
        throw new Error('these suites drive handle(); nothing subscribes');
      },
      suspension,
      silent,
    );
    sweeper = new PolicyReconciliationSweeper(
      api.app.get(PolicyReconciliationRepository),
      suspension,
      api.hierarchy,
      {
        intervalMs: 60_000,
        batchSize: 100,
        leaseSeconds: 60,
        backoffSeconds: 1,
        backoffMaxSeconds: 5,
      },
    );
  });

  afterAll(async () => {
    await cleanup(organizations);
    await w.close();
    await api.close();
  });

  beforeEach(() => {
    api.hierarchy.unavailable = false;
    api.hierarchy.timedOut = false;
    api.hierarchy.asked.length = 0;
  });

  describe('the handler only queues; the sweeper asks and suspends', () => {
    it('queues one task per union-written policy, none for a platform-written one, and a replay coalesces into the open task', async () => {
      const union = newOrg();
      const draft = await seedDraft(w, organizations, {}, { signingPolicy: false });
      const unionPolicy = await activeUnionPolicy(union, draft.employer);
      const otherEmployer = newOrg();
      const platformPolicy = await activePlatformPolicy(otherEmployer);

      const event = moved(draft.employer);
      api.hierarchy.asked.length = 0;
      await consumer.handle(event);
      // The handler made no call to organization-service.
      expect(api.hierarchy.asked).toEqual([]);

      const tasks = await tasksOf(unionPolicy);
      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toMatchObject({
        organizationId: draft.employer,
        unionId: union,
        sourceEventId: event.eventId,
        movedOrganizationId: draft.employer,
        status: 'PENDING',
        attempts: 0,
      });
      expect(await tasksOf(platformPolicy)).toEqual([]);

      // A replay of the same event, and a second move, coalesce into the open task: one task, its
      // generation bumped so a sweeper that already asked cannot finish it on a stale answer.
      await consumer.handle(event);
      await consumer.handle(moved(draft.employer));
      const after = await tasksOf(unionPolicy);
      expect(after).toHaveLength(1);
      expect(after[0]!.generation).toBeGreaterThanOrEqual(1);
    });

    it('a union that lost the organization: the policy is SUSPENDED by the system, once, with its event — and then nobody may sign', async () => {
      const union = newOrg();
      const draft = await seedDraft(w, organizations, {}, { signingPolicy: false });
      const policyId = await activeUnionPolicy(union, draft.employer);

      // The employer moves to another union. The event says only that something moved.
      api.hierarchy.adopt(newOrg(), draft.employer);
      const event = moved(draft.employer);
      await consumer.handle(event);
      const outcome = await sweeper.runOnce();
      expect(outcome.suspended).toBeGreaterThanOrEqual(1);

      const row = await policyRow(policyId);
      expect(row.status).toBe('SUSPENDED');
      expect(row.suspendedBy).toBe('system:contract-service');
      expect(row.suspensionReason).toMatch(/^ORGANIZATION_MOVED: /);
      expect(row.suspendedAt).toBeInstanceOf(Date);
      expect((await tasksOf(policyId))[0]!.status).toBe('DONE');

      const suspended = (await policyEventsOf(api.prisma, draft.employer)).filter(
        (e) => e.eventName === 'APPROVAL_POLICY_SUSPENDED',
      );
      expect(suspended).toHaveLength(1);
      expect(suspended[0]!.payload).toMatchObject({
        policyId,
        organizationId: draft.employer,
        authorOrganizationId: union,
        fromStatus: 'ACTIVE',
        reason: 'ORGANIZATION_MOVED',
        causeEventId: event.eventId,
        movedOrganizationId: draft.employer,
        suspendedBy: 'system:contract-service',
      });

      // A sweep again changes nothing and publishes nothing more.
      await consumer.handle(event);
      await sweeper.runOnce();
      expect(
        (await policyEventsOf(api.prisma, draft.employer)).filter(
          (e) => e.eventName === 'APPROVAL_POLICY_SUSPENDED',
        ),
      ).toHaveLength(1);

      // It authorises nobody: no policy in force, as if it had never been approved.
      const refused = await sign(draft.id, person(draft.employer, ['ORGANIZATION_ADMIN'])).expect(
        422,
      );
      expect(reasons(refused.body)).toEqual(['signature:SIGNATURE_POLICY_REQUIRED']);
      expect(await signaturesOf(draft.id)).toEqual([]);

      // Never revived: it can be neither approved (the hierarchy no longer lets the union govern it,
      // and the lifecycle has no way out of SUSPENDED) nor retired.
      const approve = await command(platform(), policyId, 'approve', {
        expectedVersion: row.version,
      });
      expect([403, 422]).toContain(approve.status);
      await command(platform(), policyId, 'retire', { expectedVersion: row.version }).expect(422);
      expect((await policyRow(policyId)).status).toBe('SUSPENDED');
    });

    it('a union that still governs: DONE with nothing changed; a move that cannot be confirmed leaves the policy as it is and is retried', async () => {
      const union = newOrg();
      const draft = await seedDraft(w, organizations, {}, { signingPolicy: false });
      const policyId = await activeUnionPolicy(union, draft.employer);

      await consumer.handle(moved(draft.employer));
      api.hierarchy.unavailable = true;
      const failed = await sweeper.runOnce();
      expect(failed.retried).toBeGreaterThanOrEqual(1);
      expect((await policyRow(policyId)).status).toBe('ACTIVE');
      const waiting = (await tasksOf(policyId))[0]!;
      expect(waiting).toMatchObject({ status: 'PENDING', attempts: 1 });
      expect(waiting.lastErrorCode).toBe('UPSTREAM_UNAVAILABLE');

      api.hierarchy.unavailable = false;
      await w.prisma.client.$executeRawUnsafe(
        `UPDATE policy_reconciliation_task SET next_attempt_at = now() WHERE policy_id = $1`,
        policyId,
      );
      const confirmed = await sweeper.runOnce();
      expect(confirmed.confirmed).toBeGreaterThanOrEqual(1);
      expect((await policyRow(policyId)).status).toBe('ACTIVE');
      expect((await tasksOf(policyId))[0]!.status).toBe('DONE');
      expect(
        (await policyEventsOf(api.prisma, draft.employer)).map((e) => e.eventName),
      ).not.toContain('APPROVAL_POLICY_SUSPENDED');
    });

    it('a policy still PENDING_PLATFORM_APPROVAL is suspended too, and approval then refuses it', async () => {
      const union = newOrg();
      const employer = newOrg();
      api.hierarchy.adopt(union, employer);
      const unionAdmin = person(union, ['UNION_ADMIN']);
      const written = await http()
        .post('/v1/approval-policies')
        .set('authorization', `Bearer ${unionAdmin}`)
        .set('idempotency-key', key())
        .send({
          organizationId: employer,
          workflowKey: 'contract.signature',
          label: 'Who signs for the employer',
          rationale: 'Decided by the union for the integration suite',
          isSample: true,
          steps: [
            {
              authorityOrganizationId: employer,
              authorityRole: 'ORGANIZATION_ADMIN',
              authorityLabel: 'Signer',
            },
          ],
        })
        .expect(201);
      await command(unionAdmin, written.body.id, 'submit', { expectedVersion: 1 }).expect(200);

      api.hierarchy.adopt(newOrg(), employer);
      await consumer.handle(moved(employer));
      await sweeper.runOnce();

      const row = await policyRow(written.body.id);
      expect(row.status).toBe('SUSPENDED');
      expect(row.activatedAt).toBeNull();
      // Approval re-checks the hierarchy first; whichever refuses, it never activates.
      const refused = await command(platform(), written.body.id, 'approve', {
        expectedVersion: row.version,
      });
      expect([403, 422]).toContain(refused.status);
      expect((await policyRow(written.body.id)).status).toBe('SUSPENDED');
    });
  });

  describe('the signature asks the hierarchy at the moment of signing', () => {
    it('a policy whose union has lost the employer refuses the signature although no move was seen: 403, nothing recorded, and the policy is suspended', async () => {
      const union = newOrg();
      const draft = await seedDraft(w, organizations, {}, { signingPolicy: false });
      const policyId = await activeUnionPolicy(union, draft.employer);
      // The hierarchy changed; no ORGANIZATION_MOVED has reached this service yet.
      api.hierarchy.adopt(newOrg(), draft.employer);

      const refused = await sign(draft.id, person(draft.employer, ['ORGANIZATION_ADMIN'])).expect(
        403,
      );
      expect(refused.body.code).toBe('FORBIDDEN');
      expect(reasons(refused.body)).toEqual(['signature:POLICY_AUTHOR_NOT_GOVERNING']);
      // It names no hierarchy: not the union, not the organization it asked about.
      expect(JSON.stringify(refused.body)).not.toContain(union);
      expect(await signaturesOf(draft.id)).toEqual([]);
      expect((await eventsOf(api.prisma, draft.employer)).map((e) => e.eventName)).not.toContain(
        'CONTRACT_SIGNATURE_RECORDED',
      );

      const row = await policyRow(policyId);
      expect(row.status).toBe('SUSPENDED');
      expect(row.suspensionReason).toMatch(/^SIGNING_RECHECK: /);
      const suspended = (await policyEventsOf(api.prisma, draft.employer)).filter(
        (e) => e.eventName === 'APPROVAL_POLICY_SUSPENDED',
      );
      expect(suspended).toHaveLength(1);
      expect(suspended[0]!.payload).toMatchObject({
        reason: 'SIGNING_RECHECK',
        causeEventId: null,
        movedOrganizationId: null,
      });

      // And now there is no policy in force at all.
      const again = await sign(draft.id, person(draft.employer, ['ORGANIZATION_ADMIN'])).expect(
        422,
      );
      expect(reasons(again.body)).toEqual(['signature:SIGNATURE_POLICY_REQUIRED']);
    });

    it('an answer that cannot be had refuses closed — 503, or 504 when too slow — records nothing and leaves the policy in force', async () => {
      const union = newOrg();
      const draft = await seedDraft(w, organizations, {}, { signingPolicy: false });
      const policyId = await activeUnionPolicy(union, draft.employer);

      api.hierarchy.unavailable = true;
      const down = await sign(draft.id, person(draft.employer, ['ORGANIZATION_ADMIN'])).expect(503);
      expect(down.body.code).toBe('UPSTREAM_UNAVAILABLE');
      api.hierarchy.unavailable = false;
      api.hierarchy.timedOut = true;
      const slow = await sign(draft.id, person(draft.employer, ['ORGANIZATION_ADMIN'])).expect(504);
      expect(slow.body.code).toBe('UPSTREAM_TIMEOUT');
      api.hierarchy.timedOut = false;

      expect(await signaturesOf(draft.id)).toEqual([]);
      expect((await policyRow(policyId)).status).toBe('ACTIVE');

      // Once it can be had, the same policy signs.
      const ok = await sign(draft.id, person(draft.employer, ['ORGANIZATION_ADMIN'])).expect(200);
      expect(ok.body.employerSignedAt).toEqual(expect.any(String));
      expect(await signaturesOf(draft.id)).toHaveLength(1);
    });

    it('a union that still governs signs, asked for the writing union and the employer; a platform-written policy needs no hierarchy', async () => {
      const union = newOrg();
      const draft = await seedDraft(w, organizations, {}, { signingPolicy: false });
      await activeUnionPolicy(union, draft.employer);
      api.hierarchy.asked.length = 0;
      await sign(draft.id, person(draft.employer, ['ORGANIZATION_ADMIN'])).expect(200);
      expect(api.hierarchy.asked).toContainEqual([union, draft.employer]);

      const other = await seedDraft(w, organizations, {}, { signingPolicy: false });
      await activePlatformPolicy(other.employer);
      api.hierarchy.asked.length = 0;
      await sign(other.id, person(other.employer, ['ORGANIZATION_ADMIN'])).expect(200);
      expect(api.hierarchy.asked).toEqual([]);
    });

    it('is asked under the policy slot’s lock: a retirement queued behind the signature waits for it, so the answer and the signature are one decision', async () => {
      const union = newOrg();
      const draft = await seedDraft(w, organizations, {}, { signingPolicy: false });
      const policyId = await activeUnionPolicy(union, draft.employer);

      const original = api.hierarchy.isWithin.bind(api.hierarchy);
      let retired: Promise<request.Response> | undefined;
      api.hierarchy.isWithin = async (scope: string, organizationId: string) => {
        // The signature is asking; the author tries to retire the policy meanwhile.
        retired = Promise.resolve(
          command(person(union, ['UNION_ADMIN']), policyId, 'retire', {
            expectedVersion: 3,
          }).then((res) => res),
        );
        await untilSessionsWaitOnALock(api.prisma, 1);
        return original(scope, organizationId);
      };
      try {
        const signed = await sign(draft.id, person(draft.employer, ['ORGANIZATION_ADMIN']));
        expect(signed.status).toBe(200);
      } finally {
        api.hierarchy.isWithin = original;
      }
      // The signature recorded the policy it rested on; the retirement then took effect.
      expect((await signaturesOf(draft.id))[0]).toMatchObject({ policyId, policyVersion: 1 });
      expect((await retired!).status).toBe(200);
      expect((await policyRow(policyId)).status).toBe('RETIRED');
    });
  });
});
