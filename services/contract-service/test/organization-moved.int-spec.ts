import request from 'supertest';
import { runUnscoped } from '@rasta/nest-common';
import { eventEnvelopeSchema, type EventEnvelope } from '@rasta/contracts';
import { ulid } from 'ulid';
import { OrganizationMovedConsumer } from '../src/events/organization-moved.consumer';
import { EventPublisher } from '../src/events/publisher';
import { IdempotencyStore } from '../src/shared/idempotency';
import { PolicyReconciliationRepository } from '../src/policy/policy-reconciliation.repository';
import { PolicyReconciliationSweeper } from '../src/policy/policy-reconciliation.sweeper';
import { PolicySuspensionService } from '../src/policy/policy-suspension.service';
import { actor, person, startApi, type ApiHarness } from './api-helpers';
import {
  cleanup,
  eventsOf,
  policyEventsOf,
  seedDraft,
  newAward,
  tenderAwarded,
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

  /** `hierarchyVersion` is what organization-service stamps on the move; omit it for an older event. */
  const moved = (
    organizationId: string,
    occurredAt: Date = new Date(),
    hierarchyVersion?: number,
  ): EventEnvelope =>
    eventEnvelopeSchema.parse({
      eventId: ulid(),
      eventName: 'ORGANIZATION_MOVED',
      occurredAt: occurredAt.toISOString(),
      producer: 'organization-service',
      aggregateType: 'Organization',
      aggregateId: organizationId,
      correlationId: ulid(),
      payload: {
        organizationId,
        fromParentId: 'ORG_OLD',
        toParentId: 'ORG_NEW',
        ...(hierarchyVersion === undefined ? {} : { hierarchyVersion }),
      },
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

  // -- D-050: the read-then-commit window between the two services cannot be closed; it is made
  // visible. A signature records what it rested on; a move that raced it flags it, never revokes.
  describe('a signature a move may have raced is flagged, never revoked (D-050)', () => {
    const evidenceOf = (contractId: string) =>
      runUnscoped('the suite reads the evidence', () =>
        w.prisma.client.contractSignature.findFirstOrThrow({
          where: { contractId, side: 'EMPLOYER' },
        }),
      );
    const reviewsOf = (contractId: string) =>
      runUnscoped('the suite reads the reviews', () =>
        w.prisma.client.signatureAuthorityReview.findMany({ where: { contractId } }),
      );
    const flaggedEventsOf = (employer: string) =>
      eventsOf(api.prisma, employer, 'CONTRACT_SIGNATURE_AUTHORITY_FLAGGED');
    const view = (contractId: string, token: string) =>
      http().get(`/v1/contracts/${contractId}`).set('authorization', `Bearer ${token}`);

    /**
     * A draft whose employer is under a union that has signed it once, as a union's policy allows.
     * `beforeSigning` runs after the policy is in force and before the signature: a move there is
     * one the signature's answer already reflects.
     */
    async function signedUnderUnion(beforeSigning?: (employer: string) => void) {
      const union = newOrg();
      const draft = await seedDraft(w, organizations, {}, { signingPolicy: false });
      const policyId = await activeUnionPolicy(union, draft.employer);
      beforeSigning?.(draft.employer);
      await sign(draft.id, person(draft.employer, ['ORGANIZATION_ADMIN'])).expect(200);
      return { union, draft, policyId, evidence: await evidenceOf(draft.id) };
    }
    /** An instant inside the signature's window: after it began, before its commit deadline. */
    const inWindow = (signature: { hierarchyCommitDeadline: Date | null }) =>
      new Date(signature.hierarchyCommitDeadline!.getTime() - 1);

    it('records on the employer’s signature the hierarchy evidence it rested on; the contractor’s and a platform-written policy’s have none', async () => {
      const { union, draft, evidence } = await signedUnderUnion();
      expect(evidence.hierarchyAuthorOrganizationId).toBe(union);
      expect(evidence.hierarchyAnswer).toBe('WITHIN');
      // The version of the employer's tree the answer came from: what a move is ordered against.
      expect(evidence.hierarchyVersion).toBe(BigInt(api.hierarchy.versionOf(draft.employer)));
      // Asked after the transaction began, and the commit cannot come later than its deadline.
      expect(evidence.hierarchyReadAt!.getTime()).toBeGreaterThanOrEqual(
        evidence.signedAt.getTime(),
      );
      expect(evidence.hierarchyCommitDeadline!.getTime()).toBeGreaterThan(
        evidence.hierarchyReadAt!.getTime(),
      );

      await sign(draft.id, person(draft.contractor, ['CONTRACTOR'])).expect(200);
      const contractor = await runUnscoped('the suite reads the contractor signature', () =>
        w.prisma.client.contractSignature.findFirstOrThrow({
          where: { contractId: draft.id, side: 'CONTRACTOR' },
        }),
      );
      expect(contractor.hierarchyReadAt).toBeNull();
      expect(contractor.hierarchyVersion).toBeNull();

      const other = await seedDraft(w, organizations, {}, { signingPolicy: false });
      await activePlatformPolicy(other.employer);
      await sign(other.id, person(other.employer, ['ORGANIZATION_ADMIN'])).expect(200);
      const platformSigned = await evidenceOf(other.id);
      expect(platformSigned.hierarchyReadAt).toBeNull();
      expect(platformSigned.hierarchyVersion).toBeNull();
    });

    it('flags exactly the signatures that recorded a LOWER hierarchy version than the move’s — by the version alone, whatever instant the move carries (round 5)', async () => {
      // Read the tree before the move, within the window: raced.
      const raced = await signedUnderUnion();
      // Read the tree AFTER the move (the version was already stamped): not raced.
      const answeredAfter = await signedUnderUnion((employer) => {
        api.hierarchy.bump(employer);
      });
      // Read the old tree; the move's event is stamped LONG after this signature's deadline — a
      // skewed clock in organization-service. No timestamp decides: the version does, so it is flagged.
      const committedBefore = await signedUnderUnion();
      // An event from before versions: nothing to order by, so the window alone decides.
      const unversioned = await signedUnderUnion();

      const cases = [
        { who: raced, movedAt: inWindow(raced.evidence), stamp: 'new', flagged: true },
        {
          // The move committed before this signature read: its version is the one it recorded.
          who: answeredAfter,
          movedAt: inWindow(answeredAfter.evidence),
          stamp: 'existing',
          flagged: false,
        },
        {
          who: committedBefore,
          movedAt: new Date(committedBefore.evidence.hierarchyCommitDeadline!.getTime() + 30_000),
          stamp: 'new',
          flagged: true,
        },
        { who: unversioned, movedAt: inWindow(unversioned.evidence), stamp: 'none', flagged: true },
      ] as const;
      for (const { who, movedAt, stamp, flagged } of cases) {
        // The employer left the union: a move stamps a version above every earlier one in its own
        // transaction, and its event carries it.
        api.hierarchy.adopt(newOrg(), who.draft.employer);
        const movedVersion =
          stamp === 'new'
            ? api.hierarchy.bump(who.draft.employer)
            : stamp === 'existing'
              ? api.hierarchy.versionOf(who.draft.employer)
              : undefined;
        const event = moved(who.draft.employer, movedAt, movedVersion);
        await consumer.handle(event);
        await sweeper.runOnce();

        expect((await policyRow(who.policyId)).status).toBe('SUSPENDED');
        const reviews = await reviewsOf(who.draft.id);
        const events = await flaggedEventsOf(who.draft.employer);
        if (flagged) {
          expect(reviews).toHaveLength(1);
          expect(reviews[0]).toMatchObject({
            side: 'EMPLOYER',
            policyId: who.policyId,
            reason: 'AUTHORITY_CHANGED_DURING_SIGNING',
            causeEventId: event.eventId,
            movedVersion: movedVersion === undefined ? null : BigInt(movedVersion),
            recordedVersion: who.evidence.hierarchyVersion,
          });
          expect(reviews[0]!.movedAt.toISOString()).toBe(movedAt.toISOString());
          expect(events).toHaveLength(1);
          expect(events[0]!.payload).toMatchObject({
            contractId: who.draft.id,
            policyId: who.policyId,
            policyVersion: 1,
            reason: 'AUTHORITY_CHANGED_DURING_SIGNING',
            causeEventId: event.eventId,
            movedVersion: movedVersion ?? null,
          });
        } else {
          expect(reviews).toEqual([]);
          expect(events).toEqual([]);
        }
      }
    });

    it('a move whose event is stamped BEFORE the signature’s hierarchy read — yet commits after it — is flagged: a version orders what a timestamp cannot (review round 4, ruling 1)', async () => {
      const union = newOrg();
      const draft = await seedDraft(w, organizations, {}, { signingPolicy: false });
      const policyId = await activeUnionPolicy(union, draft.employer);

      // The signature's read sees the OLD tree (version 1) …
      const before = api.hierarchy.versionOf(draft.employer);
      const eventInstant = new Date();
      await new Promise((resolve) => setTimeout(resolve, 20));
      await sign(draft.id, person(draft.employer, ['ORGANIZATION_ADMIN'])).expect(200);
      const evidence = await evidenceOf(draft.id);
      // … taken AFTER the instant the move's event carries (it was prepared first, committed later).
      expect(evidence.hierarchyReadAt!.getTime()).toBeGreaterThan(eventInstant.getTime());
      expect(evidence.hierarchyVersion).toBe(BigInt(before));

      // The move commits now; organization-service stamped its version in that transaction.
      api.hierarchy.adopt(newOrg(), draft.employer);
      const stamped = api.hierarchy.bump(draft.employer);
      const event = moved(draft.employer, eventInstant, stamped);
      await consumer.handle(event);
      await sweeper.runOnce();

      expect((await policyRow(policyId)).status).toBe('SUSPENDED');
      const reviews = await reviewsOf(draft.id);
      expect(reviews).toHaveLength(1);
      expect(reviews[0]).toMatchObject({
        causeEventId: event.eventId,
        movedVersion: BigInt(stamped),
        recordedVersion: BigInt(before),
      });
    });

    it('never revokes: the signature, the contract and its status stand; a party sees the flag in the read API; the review itself is append-only', async () => {
      const { draft, evidence } = await signedUnderUnion();
      const before = await view(draft.id, person(draft.employer, ['ORGANIZATION_ADMIN'])).expect(
        200,
      );
      expect(before.body).toMatchObject({
        authorityReviewRequired: false,
        authorityReviewReason: null,
      });

      api.hierarchy.adopt(newOrg(), draft.employer);
      await consumer.handle(
        moved(draft.employer, inWindow(evidence), api.hierarchy.bump(draft.employer)),
      );
      await sweeper.runOnce();

      // Both parties see it; the contract is as it was.
      for (const token of [
        person(draft.employer, ['ORGANIZATION_ADMIN']),
        person(draft.contractor, ['CONTRACTOR']),
      ]) {
        const after = await view(draft.id, token).expect(200);
        expect(after.body).toMatchObject({
          status: 'DRAFT',
          employerSignedAt: before.body.employerSignedAt,
          authorityReviewRequired: true,
          authorityReviewReason: 'AUTHORITY_CHANGED_DURING_SIGNING',
        });
      }
      expect(await signaturesOf(draft.id)).toHaveLength(1);
      // The contractor may still sign, and the contract completes: nothing was cancelled.
      const done = await sign(draft.id, person(draft.contractor, ['CONTRACTOR'])).expect(200);
      expect(done.body).toMatchObject({ status: 'SIGNED', authorityReviewRequired: true });

      await expect(
        w.prisma.client.$executeRawUnsafe(
          `UPDATE signature_authority_review SET reason = reason WHERE contract_id = $1`,
          draft.id,
        ),
      ).rejects.toThrow(/ck_review_immutable/);
      await expect(
        w.prisma.client.$executeRawUnsafe(
          `DELETE FROM signature_authority_review WHERE contract_id = $1`,
          draft.id,
        ),
      ).rejects.toThrow(/ck_review_immutable/);
    });

    it('an idempotent replay of a sign answers the CURRENT contract, party-scoped: the review flag and the status are not the stored snapshot’s (review round 4, ruling 3)', async () => {
      const draft = await seedDraft(w, organizations, {}, { signingPolicy: false });
      await activeUnionPolicy(newOrg(), draft.employer);
      const token = person(draft.employer, ['ORGANIZATION_ADMIN']);
      const replayKey = key();
      const signWithKey = (as: string) =>
        http()
          .post(`/v1/contracts/${draft.id}/sign`)
          .set('authorization', `Bearer ${as}`)
          .set('idempotency-key', replayKey)
          .send({});

      const first = await signWithKey(token).expect(200);
      expect(first.body).toMatchObject({ authorityReviewRequired: false, status: 'DRAFT' });
      const evidence = await evidenceOf(draft.id);

      // Afterwards a move flags that signature, and the contractor signs.
      api.hierarchy.adopt(newOrg(), draft.employer);
      await consumer.handle(
        moved(draft.employer, inWindow(evidence), api.hierarchy.bump(draft.employer)),
      );
      await sweeper.runOnce();
      await sign(draft.id, person(draft.contractor, ['CONTRACTOR'])).expect(200);

      // The replay is the recorded outcome (success), with the body as the contract is now.
      const replay = await signWithKey(token).expect(200);
      expect(replay.body).toMatchObject({
        id: draft.id,
        status: 'SIGNED',
        authorityReviewRequired: true,
        authorityReviewReason: 'AUTHORITY_CHANGED_DURING_SIGNING',
      });
      // … and it is exactly what a fresh read answers the same caller.
      const fresh = await view(draft.id, token).expect(200);
      expect(replay.body).toEqual(fresh.body);

      // Idempotency keys are scoped to the organization: another organization's request with the
      // same key is a request of its own, and the contract is not its own (404).
      await signWithKey(person(newOrg(), ['ORGANIZATION_ADMIN'])).expect(404);
    });

    it('a policy a signature attempt already suspended is still reconciled when the move arrives: the raced signature is flagged, once — through the consumer and the sweeper (review round 4, ruling 2)', async () => {
      const { draft, policyId, evidence } = await signedUnderUnion();

      // The employer left the union; before the move's event arrives, a signature attempt on
      // ANOTHER contract of the same employer finds the policy stranded and suspends it.
      api.hierarchy.adopt(newOrg(), draft.employer);
      const award = newAward(draft.employer, { winnerOrganizationId: newOrg() });
      w.awards.serve(award);
      await w.consumer.handle(tenderAwarded(award));
      const second = await runUnscoped('the suite reads back the second contract', () =>
        w.contracts.findByTender(draft.employer, award.tenderId),
      );
      await sign(second!.id, person(draft.employer, ['ORGANIZATION_ADMIN'])).expect(403);
      const suspended = await policyRow(policyId);
      expect(suspended.status).toBe('SUSPENDED');
      expect(suspended.suspensionReason).toMatch(/^SIGNING_RECHECK: /);
      expect(await reviewsOf(draft.id)).toEqual([]);

      // The move's event arrives: the suspended policy is queued like any other …
      const event = moved(draft.employer, inWindow(evidence), api.hierarchy.bump(draft.employer));
      await consumer.handle(event);
      expect(await tasksOf(policyId)).toEqual([expect.objectContaining({ status: 'PENDING' })]);
      // … and the sweeper's reconciliation flags the signature that raced it.
      await sweeper.runOnce();
      expect((await tasksOf(policyId))[0]!.status).toBe('DONE');
      expect(await reviewsOf(draft.id)).toHaveLength(1);
      expect(await flaggedEventsOf(draft.employer)).toHaveLength(1);
      // Still suspended by the first cause, with no second suspension event.
      expect((await policyRow(policyId)).suspensionReason).toMatch(/^SIGNING_RECHECK: /);
      expect(
        (await policyEventsOf(api.prisma, draft.employer)).filter(
          (e) => e.eventName === 'APPROVAL_POLICY_SUSPENDED',
        ),
      ).toHaveLength(1);

      // A redelivery of the same event flags nothing more.
      await consumer.handle(event);
      await sweeper.runOnce();
      expect(await reviewsOf(draft.id)).toHaveLength(1);
      expect(await flaggedEventsOf(draft.employer)).toHaveLength(1);
    });
  });

  describe('a refused signature leaves a durable audit record, committed though the request fails', () => {
    const refusals = (employer: string) =>
      eventsOf(api.prisma, employer, 'CONTRACT_SIGNATURE_REFUSED');

    it('no policy in force, a suspended one, and one whose union lost the employer: each refusal is recorded once, with its closed reason', async () => {
      // No policy at all.
      const none = await seedDraft(w, organizations, {}, { signingPolicy: false });
      await sign(none.id, person(none.employer, ['ORGANIZATION_ADMIN'])).expect(422);
      const noneEvents = await refusals(none.employer);
      expect(noneEvents).toHaveLength(1);
      expect(noneEvents[0]!.payload).toMatchObject({
        contractId: none.id,
        side: 'EMPLOYER',
        reason: 'SIGNATURE_POLICY_REQUIRED',
        policyId: null,
      });
      expect(await signaturesOf(none.id)).toEqual([]);

      // A policy the union no longer governs: refused (403), the policy is suspended, and both are recorded.
      const union = newOrg();
      const stranded = await seedDraft(w, organizations, {}, { signingPolicy: false });
      const policyId = await activeUnionPolicy(union, stranded.employer);
      api.hierarchy.adopt(newOrg(), stranded.employer);
      const user = person(stranded.employer, ['ORGANIZATION_ADMIN']);
      await sign(stranded.id, user).expect(403);
      const strandedEvents = await refusals(stranded.employer);
      expect(strandedEvents).toHaveLength(1);
      expect(strandedEvents[0]!.payload).toMatchObject({
        reason: 'POLICY_AUTHOR_NOT_GOVERNING',
        policyId,
        side: 'EMPLOYER',
      });
      expect(strandedEvents[0]!.payload.refusedBy).toEqual(expect.any(String));
      expect((await policyRow(policyId)).status).toBe('SUSPENDED');

      // The policy is now suspended: the next attempt is refused for want of a policy, and recorded too.
      await sign(stranded.id, user).expect(422);
      expect((await refusals(stranded.employer)).map((e) => e.payload.reason)).toEqual([
        'POLICY_AUTHOR_NOT_GOVERNING',
        'SIGNATURE_POLICY_REQUIRED',
      ]);
    });

    it('a refusal that cannot be recorded is a retryable 503, not the normal refusal: nothing is signed, the key is released, and the repeated request leaves its trace (review round 4, ruling 4)', async () => {
      const draft = await seedDraft(w, organizations, {}, { signingPolicy: false });
      const user = person(draft.employer, ['ORGANIZATION_ADMIN']);
      const retryKey = key();
      const attempt = () =>
        http()
          .post(`/v1/contracts/${draft.id}/sign`)
          .set('authorization', `Bearer ${user}`)
          .set('idempotency-key', retryKey)
          .send({});

      const publisher = api.app.get(EventPublisher);
      const original = publisher.enqueue.bind(publisher);
      const failing = jest
        .spyOn(publisher, 'enqueue')
        .mockImplementation(async (...args: Parameters<typeof original>) => {
          if (args[1].eventName === 'CONTRACT_SIGNATURE_REFUSED') throw new Error('outbox down');
          return original(...args);
        });
      try {
        const down = await attempt().expect(503);
        expect(down.body.code).toBe('UPSTREAM_UNAVAILABLE');
        expect(down.headers['retry-after']).toBe('1');
        // Nothing of the cause reaches the caller.
        expect(JSON.stringify(down.body)).not.toContain('outbox');
      } finally {
        failing.mockRestore();
      }
      expect(await signaturesOf(draft.id)).toEqual([]);
      expect(await refusals(draft.employer)).toEqual([]);

      // The key was released: the same request now gets the normal refusal, and it is recorded.
      await attempt().expect(422);
      expect(await refusals(draft.employer)).toHaveLength(1);
    });

    it('records no refusal for a signature that fails for another reason, or one that cannot be confirmed', async () => {
      const draft = await seedDraft(w, organizations, {}, { signingPolicy: false });
      await activeUnionPolicy(newOrg(), draft.employer);
      api.hierarchy.unavailable = true;
      await sign(draft.id, person(draft.employer, ['ORGANIZATION_ADMIN'])).expect(503);
      api.hierarchy.unavailable = false;
      // A person the policy does not name: 403, a role refusal — not a want of authority in force.
      await sign(draft.id, person(draft.employer, ['CONTRACTOR'])).expect(403);
      expect(await refusals(draft.employer)).toEqual([]);
    });
  });

  describe('flagging is decided by the version alone: skewed clocks change nothing (round 5, ruling 1)', () => {
    const reviewsOf = (contractId: string) =>
      runUnscoped('the suite reads the reviews', () =>
        w.prisma.client.signatureAuthorityReview.findMany({ where: { contractId } }),
      );
    const evidenceOf = (contractId: string) =>
      runUnscoped('the suite reads the evidence', () =>
        w.prisma.client.contractSignature.findFirstOrThrow({
          where: { contractId, side: 'EMPLOYER' },
        }),
      );

    /** A contract signed once by the employer under a union's policy. */
    async function signedOnce() {
      const union = newOrg();
      const draft = await seedDraft(w, organizations, {}, { signingPolicy: false });
      const policyId = await activeUnionPolicy(union, draft.employer);
      await sign(draft.id, person(draft.employer, ['ORGANIZATION_ADMIN'])).expect(200);
      return { draft, policyId, evidence: await evidenceOf(draft.id) };
    }

    it.each([
      ['30 s before the signature', -30_000],
      ['30 s after its commit deadline', 30_000],
      ['exactly at the deadline', 0],
    ])(
      'a signature on the older tree is flagged, and one that read the moved tree is not, with the move stamped %s',
      async (_label, skew) => {
        const older = await signedOnce();
        const newer = await signedOnce();
        // The newer read the tree after the move stamped its version.
        const movedVersion = api.hierarchy.bump(newer.draft.employer);
        api.hierarchy.bump(older.draft.employer, newer.draft.employer);
        await sign(newer.draft.id, person(newer.draft.contractor, ['CONTRACTOR'])).expect(200);
        const read = await evidenceOf(newer.draft.id);
        expect(Number(read.hierarchyVersion)).toBeLessThan(
          api.hierarchy.versionOf(newer.draft.employer),
        );

        for (const [who, version] of [
          [older, api.hierarchy.versionOf(older.draft.employer)],
          [newer, Number(read.hierarchyVersion)],
        ] as const) {
          api.hierarchy.adopt(newOrg(), who.draft.employer);
          const at = new Date(who.evidence.hierarchyCommitDeadline!.getTime() + skew);
          await consumer.handle(moved(who.draft.employer, at, version));
          await sweeper.runOnce();
        }
        expect(movedVersion).toBeGreaterThan(0);
        // Older: its recorded version is below the move's → flagged. Newer: equal → not.
        expect(await reviewsOf(older.draft.id)).toHaveLength(1);
        expect(await reviewsOf(newer.draft.id)).toEqual([]);
      },
    );

    it('a move with no version orders nothing: every unreviewed signature under the policy is flagged (too many is safe)', async () => {
      const one = await signedOnce();
      api.hierarchy.adopt(newOrg(), one.draft.employer);
      await consumer.handle(
        moved(
          one.draft.employer,
          new Date(one.evidence.hierarchyCommitDeadline!.getTime() + 60_000),
        ),
      );
      await sweeper.runOnce();
      expect(await reviewsOf(one.draft.id)).toHaveLength(1);
    });
  });

  describe('a suspension in flight cannot finish on a stale answer (round 5, ruling 2)', () => {
    const reviewsOf = (contractId: string) =>
      runUnscoped('the suite reads the reviews', () =>
        w.prisma.client.signatureAuthorityReview.findMany({ where: { contractId } }),
      );

    it('claim → pause → move back → sign → move out → resume: the stale worker writes nothing, the task stays open, and the next sweep flags the intervening signature', async () => {
      const union = newOrg();
      const first = await seedDraft(w, organizations, {}, { signingPolicy: false });
      const policyId = await activeUnionPolicy(union, first.employer);
      const employerToken = person(first.employer, ['ORGANIZATION_ADMIN']);

      // A second contract of the same employer: the one signed while the worker is paused.
      const award = newAward(first.employer, { winnerOrganizationId: newOrg() });
      w.awards.serve(award);
      await w.consumer.handle(tenderAwarded(award));
      const second = (await runUnscoped('the suite reads back the second contract', () =>
        w.contracts.findByTender(first.employer, award.tenderId),
      ))!;

      // 1. The employer leaves the union; the move queues a task …
      api.hierarchy.adopt(newOrg(), first.employer);
      await consumer.handle(moved(first.employer, new Date(), api.hierarchy.bump(first.employer)));
      // 2. … and a sweeper claims it, and is paused after the lookup said "outside".
      const queue = api.app.get(PolicyReconciliationRepository);
      const claimed = (await queue.claimDue(100, 60, ulid())).filter(
        (task) => task.policyId === policyId,
      );
      expect(claimed).toHaveLength(1);
      const task = claimed[0]!;

      // 3. Meanwhile the employer comes back, is signed under, and leaves again.
      api.hierarchy.adopt(union, first.employer);
      await consumer.handle(moved(first.employer, new Date(), api.hierarchy.bump(first.employer)));
      await sign(second.id, employerToken).expect(200);
      const recorded = await runUnscoped('the suite reads the signature', () =>
        w.prisma.client.contractSignature.findFirstOrThrow({
          where: { contractId: second.id, side: 'EMPLOYER' },
        }),
      );
      api.hierarchy.adopt(newOrg(), first.employer);
      const finalVersion = api.hierarchy.bump(first.employer);
      await consumer.handle(moved(first.employer, new Date(), finalVersion));
      expect(Number(recorded.hierarchyVersion)).toBeLessThan(finalVersion);

      // 4. The paused worker resumes with its stale claim: nothing is written, nothing finished.
      const suspension = api.app.get(PolicySuspensionService);
      const result = await suspension.suspend(
        { id: policyId, organizationId: first.employer },
        {
          reason: 'ORGANIZATION_MOVED',
          eventId: task.sourceEventId,
          movedOrganizationId: task.movedOrganizationId,
          movedAt: task.movedAt,
          movedVersion: task.movedVersion,
          correlationId: task.correlationId,
          callerService: 'organization-service',
        },
        queue.ownershipOf(task),
      );
      expect(result).toBe('STALE');
      expect((await policyRow(policyId)).status).toBe('ACTIVE');
      expect(await reviewsOf(second.id)).toEqual([]);
      const open = (await tasksOf(policyId))[0]!;
      expect(open.status).toBe('PENDING');
      expect(open.generation).toBeGreaterThan(task.generation);

      // 5. The task goes back; the next sweep asks afresh, suspends, and flags the signature made
      //    while the worker was away — by the task's CURRENT version, not the claimed one.
      await queue.release(task);
      await sweeper.runOnce();
      expect((await policyRow(policyId)).status).toBe('SUSPENDED');
      expect((await tasksOf(policyId))[0]!.status).toBe('DONE');
      const reviews = await reviewsOf(second.id);
      expect(reviews).toHaveLength(1);
      expect(reviews[0]).toMatchObject({
        movedVersion: BigInt(finalVersion),
        recordedVersion: recorded.hierarchyVersion,
      });
    });

    it('a worker that still holds the current generation suspends, with the version the locked row holds', async () => {
      const union = newOrg();
      const draft = await seedDraft(w, organizations, {}, { signingPolicy: false });
      const policyId = await activeUnionPolicy(union, draft.employer);
      await sign(draft.id, person(draft.employer, ['ORGANIZATION_ADMIN'])).expect(200);
      api.hierarchy.adopt(newOrg(), draft.employer);
      const version = api.hierarchy.bump(draft.employer);
      await consumer.handle(moved(draft.employer, new Date(), version));
      const outcome = await sweeper.runOnce();
      expect(outcome.suspended).toBeGreaterThanOrEqual(1);
      expect((await policyRow(policyId)).status).toBe('SUSPENDED');
      expect((await reviewsOf(draft.id))[0]!.movedVersion).toBe(BigInt(version));
    });
  });

  describe('a failed release cannot mask the audit 503 (round 5, ruling 3)', () => {
    it('answers the original 503, logs the release failure, holds the key until its lease lapses — then the same request is refused normally and recorded', async () => {
      const draft = await seedDraft(w, organizations, {}, { signingPolicy: false });
      const user = person(draft.employer, ['ORGANIZATION_ADMIN']);
      const retryKey = key();
      const attempt = () =>
        http()
          .post(`/v1/contracts/${draft.id}/sign`)
          .set('authorization', `Bearer ${user}`)
          .set('idempotency-key', retryKey)
          .send({});

      const publisher = api.app.get(EventPublisher);
      const original = publisher.enqueue.bind(publisher);
      const store = api.app.get(IdempotencyStore);
      const releasing = jest.spyOn(store, 'release').mockRejectedValue(new Error('db down'));
      const failing = jest
        .spyOn(publisher, 'enqueue')
        .mockImplementation(async (...args: Parameters<typeof original>) => {
          if (args[1].eventName === 'CONTRACT_SIGNATURE_REFUSED') throw new Error('outbox down');
          return original(...args);
        });
      try {
        const down = await attempt().expect(503);
        expect(down.body.code).toBe('UPSTREAM_UNAVAILABLE');
        expect(down.headers['retry-after']).toBe('1');
        // Neither cause reaches the caller.
        expect(JSON.stringify(down.body)).not.toMatch(/outbox|db down/);
        expect(releasing).toHaveBeenCalled();
      } finally {
        failing.mockRestore();
        releasing.mockRestore();
      }
      expect(await signaturesOf(draft.id)).toEqual([]);

      // The claim is still held (release failed): the same key is "in flight" — 409 with Retry-After.
      const held = await attempt().expect(409);
      expect(held.body.code).toBe('CONFLICT');
      expect(held.headers['retry-after']).toBe('1');

      // Its lease lapses: the retry takes the key over, is refused normally, and leaves its trace.
      await w.prisma.client.$executeRawUnsafe(
        `UPDATE idempotency_key SET expires_at = now() - interval '1 second'
          WHERE organization_id = $1 AND key = $2`,
        draft.employer,
        retryKey,
      );
      await attempt().expect(422);
      expect(await eventsOf(api.prisma, draft.employer, 'CONTRACT_SIGNATURE_REFUSED')).toHaveLength(
        1,
      );
    }, 30_000);
  });

  describe('a move in the very millisecond the first task was made is not lost (review round 3)', () => {
    it('advances the generation of the open task by row identity, whatever instants the two moves carry', async () => {
      const draft = await seedDraft(w, organizations, {}, { signingPolicy: false });
      const policyId = await activeUnionPolicy(newOrg(), draft.employer);
      const queue = api.app.get(PolicyReconciliationRepository);
      const row = (id: string) => ({
        id,
        organizationId: draft.employer,
        policyId,
        unionId: 'ORG_U',
        sourceEventId: `EVT_${id}`,
        movedOrganizationId: draft.employer,
        correlationId: 'COR_1',
      });
      // One instant for everything: the task's creation, the move, and the second move's `now()`.
      const sameInstant = new Date('2026-10-06T12:00:00.000Z');

      const first = await api.prisma.transaction((tx) =>
        queue.enqueue(tx, [row('PRT_same_ms_1')], sameInstant, sameInstant, 3),
      );
      const second = await api.prisma.transaction((tx) =>
        queue.enqueue(tx, [row('PRT_same_ms_2')], sameInstant, sameInstant, 5),
      );
      const third = await api.prisma.transaction((tx) =>
        queue.enqueue(tx, [row('PRT_same_ms_3')], sameInstant, sameInstant, 4),
      );

      expect([first, second, third]).toEqual([1, 0, 0]);
      const tasks = await tasksOf(policyId);
      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toMatchObject({ id: 'PRT_same_ms_1', generation: 2, status: 'PENDING' });
      // The first move's event and instant stay: the earlier instant flags more, never fewer.
      expect(tasks[0]!.sourceEventId).toBe('EVT_PRT_same_ms_1');
      expect(tasks[0]!.movedAt!.toISOString()).toBe(sameInstant.toISOString());
      // The version is the HIGHEST of the moves that coalesced, in whatever order they arrived
      // (3, 5, 4): the flagging then covers a signature that read between the moves too.
      expect(tasks[0]!.movedVersion).toBe(5n);
    });

    it('a task from a move without a version takes the version of a later one, and keeps none when none has one', async () => {
      const draft = await seedDraft(w, organizations, {}, { signingPolicy: false });
      const policyId = await activeUnionPolicy(newOrg(), draft.employer);
      const queue = api.app.get(PolicyReconciliationRepository);
      const row = (id: string) => ({
        id,
        organizationId: draft.employer,
        policyId,
        unionId: 'ORG_U',
        sourceEventId: `EVT_${id}`,
        movedOrganizationId: draft.employer,
        correlationId: 'COR_1',
      });
      const instant = new Date('2026-10-06T12:00:00.000Z');
      await api.prisma.transaction((tx) =>
        queue.enqueue(tx, [row('PRT_nv_1')], instant, instant, null),
      );
      expect((await tasksOf(policyId))[0]!.movedVersion).toBeNull();
      await api.prisma.transaction((tx) =>
        queue.enqueue(tx, [row('PRT_nv_2')], instant, instant, 6),
      );
      expect((await tasksOf(policyId))[0]!.movedVersion).toBe(6n);
      await api.prisma.transaction((tx) =>
        queue.enqueue(tx, [row('PRT_nv_3')], instant, instant, null),
      );
      expect((await tasksOf(policyId))[0]!.movedVersion).toBe(6n);
    });
  });
});
