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
  testEnv,
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

  /** D-050: the clock-skew allowance added to a signature's commit deadline (the default, 300 s). */
  const MARGIN_MS = testEnv().CONTRACT_HIERARCHY_CLOCK_SKEW_MARGIN_SECONDS * 1000;

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
      const event = moved(draft.employer, undefined, api.hierarchy.bump(draft.employer));
      await consumer.handle(event);
      const outcome = await sweeper.runOnce();
      expect(outcome.suspended).toBeGreaterThanOrEqual(1);

      const row = await policyRow(policyId);
      expect(row.status).toBe('SUSPENDED');
      expect(row.suspendedBy).toBe('system:contract-service');
      expect(row.suspensionReason).toMatch(/^MOVE_RECHECK: /);
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
        // The sweeper never names a cause (round 9, docs/23 D-051).
        reason: 'MOVE_RECHECK',
        causeEventId: null,
        movedOrganizationId: null,
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
    type Evidence = Awaited<ReturnType<typeof signedUnderUnion>>['evidence'];
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

    it('flags exactly the signatures that recorded a LOWER hierarchy version than the move’s AND whose commit window reaches the move (D-050): one committed well before the move is not flagged', async () => {
      // Each signature is made just before its own move is handled: a move queues a re-check for
      // every union policy, and (round 12) a "within" re-check reviews the window too, so a
      // signature made earlier than another case's move would be reviewed by that move.
      const cases = [
        {
          // Read the tree before the move, within the window: raced.
          make: () => signedUnderUnion(),
          movedAt: (evidence: Evidence) => inWindow(evidence),
          stamp: 'new',
          flagged: true,
        },
        {
          // Read the tree AFTER the move (the version was already stamped): not raced. The move
          // committed before this signature read: its version is the one it recorded.
          make: () =>
            signedUnderUnion((employer) => {
              api.hierarchy.bump(employer);
            }),
          movedAt: (evidence: Evidence) => inWindow(evidence),
          stamp: 'existing',
          flagged: false,
        },
        {
          // Read the old tree, and committed long before the move: its deadline precedes the move's
          // instant (moved_at > hierarchy_commit_deadline), so it cannot have raced it — no review.
          make: () => signedUnderUnion(),
          movedAt: (evidence: Evidence) =>
            new Date(evidence.hierarchyCommitDeadline!.getTime() + MARGIN_MS + 30_000),
          stamp: 'new',
          flagged: false,
        },
        {
          // An event from before versions: nothing to order by, so the window alone decides.
          make: () => signedUnderUnion(),
          movedAt: (evidence: Evidence) => inWindow(evidence),
          stamp: 'none',
          flagged: true,
        },
      ] as const;
      for (const { make, movedAt: movedAtOf, stamp, flagged } of cases) {
        const who = await make();
        const movedAt = movedAtOf(who.evidence);
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
          // The sweeper never names a cause (round 9, docs/23 D-051).
          expect(reviews).toHaveLength(1);
          expect(reviews[0]).toMatchObject({
            side: 'EMPLOYER',
            policyId: who.policyId,
            reason: 'AUTHORITY_CHANGED_DURING_SIGNING',
            detectedBy: 'MOVE_RECHECK',
            causeEventId: null,
            movedAt: null,
            movedVersion: movedVersion === undefined ? null : BigInt(movedVersion),
            recordedVersion: who.evidence.hierarchyVersion,
          });
          expect(events).toHaveLength(1);
          expect(events[0]!.payload).toMatchObject({
            contractId: who.draft.id,
            policyId: who.policyId,
            policyVersion: 1,
            reason: 'AUTHORITY_CHANGED_DURING_SIGNING',
            detectedBy: 'MOVE_RECHECK',
            causeEventId: null,
            movedAt: null,
            movedVersion: movedVersion ?? null,
          });
          expect(JSON.stringify(events[0])).not.toContain(event.eventId);
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
        causeEventId: null,
        detectedBy: 'MOVE_RECHECK',
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

  describe('flagging: the version decides which tree was read, the D-050 window bounds which signatures are looked at', () => {
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
      return { draft, union, policyId, evidence: await evidenceOf(draft.id) };
    }

    it.each([
      ['30 s before the signature’s deadline', -30_000, true],
      ['exactly at the deadline', 0, true],
      // Up to the clock-skew margin past the deadline still reviews: the two hosts' clocks may differ.
      ['10 s after its commit deadline (inside the margin)', 10_000, true],
      ['exactly deadline + margin', MARGIN_MS, true],
      // moved_at > deadline + margin: the signature committed before the move was prepared.
      ['30 s beyond deadline + margin', MARGIN_MS + 30_000, false],
    ])(
      'a signature on the older tree is flagged only if the move is not after its commit deadline plus the skew margin, and one that read the moved tree never is: move stamped %s',
      async (_label, skew, olderFlagged) => {
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

        // The one that read the moved tree first: a move queues a re-check for every union
        // policy and a "within" one reviews the window too (round 12), so the other's move, handled
        // later, is kept out of this assertion.
        for (const [who, version] of [
          [newer, Number(read.hierarchyVersion)],
          [older, api.hierarchy.versionOf(older.draft.employer)],
        ] as const) {
          api.hierarchy.adopt(newOrg(), who.draft.employer);
          const at = new Date(who.evidence.hierarchyCommitDeadline!.getTime() + skew);
          await consumer.handle(moved(who.draft.employer, at, version));
          await sweeper.runOnce();
          // Equal to the move's version: not flagged by its own move.
          if (who === newer) expect(await reviewsOf(newer.draft.id)).toEqual([]);
        }
        expect(movedVersion).toBeGreaterThan(0);
        // Older: its recorded version is below the move's → flagged, if the window reaches it.
        expect(await reviewsOf(older.draft.id)).toHaveLength(olderFlagged ? 1 : 0);
      },
    );

    it('two moves coalesced around ONE signature — A before its commit, B (the higher version) after its deadline — still review it: the window is bounded by the EARLIEST move (round 10)', async () => {
      const who = await signedOnce();
      api.hierarchy.adopt(newOrg(), who.draft.employer);
      const deadline = who.evidence.hierarchyCommitDeadline!.getTime();
      const versionA = api.hierarchy.bump(who.draft.employer);
      const a = moved(who.draft.employer, new Date(deadline - 1), versionA);
      const versionB = api.hierarchy.bump(who.draft.employer);
      // Beyond deadline + margin: on its own, B would exclude the signature.
      const b = moved(who.draft.employer, new Date(deadline + MARGIN_MS + 60_000), versionB);
      await consumer.handle(a);
      await consumer.handle(b);

      const [task] = await tasksOf(who.policyId);
      expect(task).toMatchObject({ movedVersion: BigInt(versionB), generation: 1 });
      expect(task!.earliestMovedAt!.getTime()).toBe(deadline - 1);

      await sweeper.runOnce();
      expect(await reviewsOf(who.draft.id)).toHaveLength(1);
    });

    it('the same two moves in the other order (B first, then A) keep the same earliest instant', async () => {
      const who = await signedOnce();
      api.hierarchy.adopt(newOrg(), who.draft.employer);
      const deadline = who.evidence.hierarchyCommitDeadline!.getTime();
      const versionA = api.hierarchy.bump(who.draft.employer);
      const versionB = api.hierarchy.bump(who.draft.employer);
      await consumer.handle(
        moved(who.draft.employer, new Date(deadline + MARGIN_MS + 60_000), versionB),
      );
      await consumer.handle(moved(who.draft.employer, new Date(deadline - 1), versionA));
      const [task] = await tasksOf(who.policyId);
      expect(task!.earliestMovedAt!.getTime()).toBe(deadline - 1);
      await sweeper.runOnce();
      expect(await reviewsOf(who.draft.id)).toHaveLength(1);
    });

    it('a move with no version orders nothing: every unreviewed signature inside its window is flagged (too many is safe), one that committed before it is not', async () => {
      const inside = await signedOnce();
      api.hierarchy.adopt(newOrg(), inside.draft.employer);
      await consumer.handle(
        moved(
          inside.draft.employer,
          new Date(inside.evidence.hierarchyCommitDeadline!.getTime() - 1),
        ),
      );
      const before = await signedOnce();
      api.hierarchy.adopt(newOrg(), before.draft.employer);
      await consumer.handle(
        moved(
          before.draft.employer,
          new Date(before.evidence.hierarchyCommitDeadline!.getTime() + MARGIN_MS + 60_000),
        ),
      );
      await sweeper.runOnce();
      expect(await reviewsOf(inside.draft.id)).toHaveLength(1);
      expect(await reviewsOf(before.draft.id)).toEqual([]);
    });

    it('out → sign → back before the sweep: the answer is "within", yet the signature committed while authority was absent is reviewed (MOVE_RECHECK), and the policy stays in force (round 12)', async () => {
      const who = await signedOnce();
      const deadline = who.evidence.hierarchyCommitDeadline!.getTime();
      // A takes the employer out (its instant inside the signature's window) …
      api.hierarchy.adopt(newOrg(), who.draft.employer);
      await consumer.handle(
        moved(who.draft.employer, new Date(deadline - 1), api.hierarchy.bump(who.draft.employer)),
      );
      // … B returns it before any sweep: one task now carries both moves.
      api.hierarchy.adopt(who.union, who.draft.employer);
      await consumer.handle(
        moved(who.draft.employer, new Date(deadline + 1), api.hierarchy.bump(who.draft.employer)),
      );
      expect((await tasksOf(who.policyId))[0]).toMatchObject({ generation: 1 });

      const outcome = await sweeper.runOnce();

      expect(outcome.suspended).toBe(0);
      expect((await policyRow(who.policyId)).status).toBe('ACTIVE');
      expect((await tasksOf(who.policyId))[0]!.status).toBe('DONE');
      const reviews = await reviewsOf(who.draft.id);
      expect(reviews).toHaveLength(1);
      expect(reviews[0]).toMatchObject({
        detectedBy: 'MOVE_RECHECK',
        causeEventId: null,
        movedAt: null,
      });
    });

    it('moves back without a signature in the window: no review, whether the signature committed before every move or none was made', async () => {
      // The scenario with no signature first: the other's signature is made after its moves, and a
      // move queues a re-check for every union policy.
      const none = await seedDraft(w, organizations, {}, { signingPolicy: false });
      const noneUnion = newOrg();
      const nonePolicy = await activeUnionPolicy(noneUnion, none.employer);
      api.hierarchy.adopt(newOrg(), none.employer);
      await consumer.handle(moved(none.employer, new Date(), api.hierarchy.bump(none.employer)));
      api.hierarchy.adopt(noneUnion, none.employer);
      await consumer.handle(
        moved(none.employer, new Date(Date.now() + 1), api.hierarchy.bump(none.employer)),
      );
      await sweeper.runOnce();

      // A signature that committed before every move was prepared.
      const early = await signedOnce();
      const at = early.evidence.hierarchyCommitDeadline!.getTime() + MARGIN_MS + 60_000;
      api.hierarchy.adopt(newOrg(), early.draft.employer);
      await consumer.handle(
        moved(early.draft.employer, new Date(at), api.hierarchy.bump(early.draft.employer)),
      );
      api.hierarchy.adopt(early.union, early.draft.employer);
      await consumer.handle(
        moved(early.draft.employer, new Date(at + 1), api.hierarchy.bump(early.draft.employer)),
      );
      await sweeper.runOnce();

      expect(await reviewsOf(early.draft.id)).toEqual([]);
      expect(await reviewsOf(none.id)).toEqual([]);
      expect((await policyRow(early.policyId)).status).toBe('ACTIVE');
      expect((await policyRow(nonePolicy)).status).toBe('ACTIVE');
    });
  });

  describe('a failed lookup cannot push out a newer move’s due time (round 12)', () => {
    async function claimedAfterOneMove() {
      const union = newOrg();
      const draft = await seedDraft(w, organizations, {}, { signingPolicy: false });
      const policyId = await activeUnionPolicy(union, draft.employer);
      api.hierarchy.adopt(newOrg(), draft.employer);
      await consumer.handle(moved(draft.employer, new Date(), api.hierarchy.bump(draft.employer)));
      const queue = api.app.get(PolicyReconciliationRepository);
      const task = (await queue.claimDue(100, 60, ulid())).find((t) => t.policyId === policyId)!;
      return { queue, task, policyId, employer: draft.employer };
    }

    it('claim → a move coalesces → the lookup fails: the lease is released, the due time, attempts and error stay the newer move’s, and the task is claimable at once', async () => {
      const { queue, task, policyId, employer } = await claimedAfterOneMove();
      await consumer.handle(moved(employer, new Date(), api.hierarchy.bump(employer)));
      const before = (await tasksOf(policyId))[0]!;
      expect(before.generation).toBeGreaterThan(task.generation);

      expect(await queue.retryLater(task, 'UPSTREAM_UNAVAILABLE', 900)).toBe('SUPERSEDED');

      const after = (await tasksOf(policyId))[0]!;
      expect(after.leaseToken).toBeNull();
      expect(after.attempts).toBe(before.attempts);
      expect(after.lastErrorCode).toBeNull();
      expect(after.nextAttemptAt.getTime()).toBe(before.nextAttemptAt.getTime());
      expect(after.nextAttemptAt.getTime()).toBeLessThanOrEqual(Date.now());
      const again = (await queue.claimDue(100, 60, ulid())).filter((t) => t.policyId === policyId);
      expect(again).toHaveLength(1);
    });

    it('the claimed generation is still the task’s: the backoff, the attempt and the error code are applied', async () => {
      const { queue, task, policyId } = await claimedAfterOneMove();

      expect(await queue.retryLater(task, 'UPSTREAM_UNAVAILABLE', 900)).toBe('RETRIED');

      const after = (await tasksOf(policyId))[0]!;
      expect(after).toMatchObject({ attempts: 1, lastErrorCode: 'UPSTREAM_UNAVAILABLE' });
      expect(after.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 800_000);
      expect(after.leaseToken).toBeNull();
    });

    it('a lease that is no longer this worker’s changes nothing', async () => {
      const { queue, task, policyId } = await claimedAfterOneMove();
      const before = (await tasksOf(policyId))[0]!;
      expect(await queue.retryLater({ ...task, leaseToken: 'OTHER' }, 'INTERNAL', 900)).toBe(
        'LOST',
      );
      expect((await tasksOf(policyId))[0]).toEqual(before);
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
          reason: 'MOVE_RECHECK',
          earliestMovedAt: task.earliestMovedAt,
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

  describe('a review never names the move that caused it (round 9; the schema still allows a cause, D-051)', () => {
    const reviewsOf = (contractId: string) =>
      runUnscoped('the suite reads the reviews', () =>
        w.prisma.client.signatureAuthorityReview.findMany({ where: { contractId } }),
      );
    const flagged = (employer: string) =>
      eventsOf(api.prisma, employer, 'CONTRACT_SIGNATURE_AUTHORITY_FLAGGED');

    /** A contract the employer signed once under a union's policy. */
    async function signedOnce() {
      const union = newOrg();
      const draft = await seedDraft(w, organizations, {}, { signingPolicy: false });
      const policyId = await activeUnionPolicy(union, draft.employer);
      await sign(draft.id, person(draft.employer, ['ORGANIZATION_ADMIN'])).expect(200);
      return { union, draft, policyId };
    }

    it('a move that coalesces into an open task with a HIGHER version takes over its whole provenance (event, organization, instant, version together), yet a task with two moves names no cause', async () => {
      const { draft, policyId } = await signedOnce();
      api.hierarchy.adopt(newOrg(), draft.employer);
      const firstVersion = api.hierarchy.bump(draft.employer);
      const first = moved(draft.employer, new Date('2026-10-06T10:00:00.000Z'), firstVersion);
      await consumer.handle(first);
      const secondVersion = api.hierarchy.bump(draft.employer);
      const secondAt = new Date('2026-10-06T10:05:00.000Z');
      const second = moved(draft.employer, secondAt, secondVersion);
      await consumer.handle(second);

      // The one open task now says the second move, with the second's version — never a mixture.
      const [task] = await tasksOf(policyId);
      expect(task).toMatchObject({
        status: 'PENDING',
        sourceEventId: second.eventId,
        movedOrganizationId: draft.employer,
        movedVersion: BigInt(secondVersion),
        generation: 1,
      });
      expect(task!.movedAt!.toISOString()).toBe(secondAt.toISOString());
      // …while the window bound is the earliest of the two instants (round 10).
      expect(task!.earliestMovedAt!.toISOString()).toBe('2026-10-06T10:00:00.000Z');

      // Two moves outside the union: which of them took the employer out cannot be said — neither
      // is named.
      await sweeper.runOnce();
      const [review] = await reviewsOf(draft.id);
      expect(review).toMatchObject({
        detectedBy: 'MOVE_RECHECK',
        causeEventId: null,
        movedAt: null,
        movedVersion: BigInt(secondVersion),
      });
      const [event] = await flagged(draft.employer);
      expect(event!.payload).toMatchObject({
        detectedBy: 'MOVE_RECHECK',
        causeEventId: null,
        movedAt: null,
        movedVersion: secondVersion,
      });
      expect(JSON.stringify(event)).not.toContain(first.eventId);
      expect(JSON.stringify(event)).not.toContain(second.eventId);
    });

    it('a move with a LOWER (or no) version coalescing later changes nothing of the task’s provenance', async () => {
      const { draft, policyId } = await signedOnce();
      api.hierarchy.adopt(newOrg(), draft.employer);
      const lowerVersion = api.hierarchy.bump(draft.employer);
      const higherVersion = api.hierarchy.bump(draft.employer);
      // Delivered out of order: the higher first, then the lower, then one that carries no version.
      const higher = moved(draft.employer, new Date('2026-10-06T10:05:00.000Z'), higherVersion);
      await consumer.handle(higher);
      await consumer.handle(
        moved(draft.employer, new Date('2026-10-06T10:00:00.000Z'), lowerVersion),
      );
      await consumer.handle(moved(draft.employer, new Date('2026-10-06T10:09:00.000Z')));

      const [task] = await tasksOf(policyId);
      expect(task).toMatchObject({
        sourceEventId: higher.eventId,
        movedVersion: BigInt(higherVersion),
        generation: 2,
      });
      await sweeper.runOnce();
      // Three moves were on the task: none is provably the cause (round 7).
      expect((await reviewsOf(draft.id))[0]).toMatchObject({
        detectedBy: 'MOVE_RECHECK',
        causeEventId: null,
        movedAt: null,
        movedVersion: BigInt(higherVersion),
      });
      expect((await flagged(draft.employer))[0]!.payload.causeEventId).toBeNull();
    });

    it('an unrelated move that queues an employer already outside the union is not named as the cause: the review and its event carry a closed detectedBy and no event, no instant', async () => {
      const { union, draft, policyId } = await signedOnce();
      // The employer is already outside the union (no move event was seen); then an organization
      // that has nothing to do with it moves, and queues the re-check of every union policy.
      api.hierarchy.adopt(newOrg(), draft.employer);
      const unrelated = newOrg();
      const unrelatedVersion = api.hierarchy.bump(unrelated);
      const event = moved(unrelated, new Date('2026-10-06T11:00:00.000Z'), unrelatedVersion);
      await consumer.handle(event);
      await sweeper.runOnce();

      expect((await policyRow(policyId)).status).toBe('SUSPENDED');
      const [review] = await reviewsOf(draft.id);
      expect(review).toMatchObject({
        detectedBy: 'MOVE_RECHECK',
        causeEventId: null,
        movedAt: null,
        // The basis the signature was compared against stays on record.
        movedVersion: BigInt(unrelatedVersion),
      });
      const [flaggedEvent] = await flagged(draft.employer);
      expect(flaggedEvent!.payload).toMatchObject({
        detectedBy: 'MOVE_RECHECK',
        causeEventId: null,
        movedAt: null,
        movedVersion: unrelatedVersion,
      });
      expect(JSON.stringify(flaggedEvent)).not.toContain(event.eventId);

      // The suspension says the same: no event named, no moved organization.
      const [suspended] = (await policyEventsOf(api.prisma, draft.employer)).filter(
        (e) => e.eventName === 'APPROVAL_POLICY_SUSPENDED',
      );
      expect(suspended!.payload).toMatchObject({
        authorOrganizationId: union,
        reason: 'MOVE_RECHECK',
        causeEventId: null,
        movedOrganizationId: null,
      });
      expect((await policyRow(policyId)).suspensionReason).not.toContain(event.eventId);
    });

    it('moves delivered out of order — employer leaves the union in move A, a later move B of an ancestor arrives first — name no cause: generation 0 is one event handled, not no earlier move (round 9)', async () => {
      const { draft, policyId } = await signedOnce();
      const ancestor = newOrg();
      // A: the employer leaves the union (its version is stamped); B: the ancestor, already
      // outside the union, moves later and stamps the employer's subtree with a higher version.
      api.hierarchy.adopt(newOrg(), draft.employer);
      api.hierarchy.bump(draft.employer);
      const bVersion = api.hierarchy.bump(draft.employer);
      // Only B is delivered (A is on another partition, still in flight): a generation-0 task whose
      // moved organization contains the employer and whose version the employer carries.
      const b = moved(ancestor, new Date('2026-10-06T12:00:00.000Z'), bVersion);
      await consumer.handle(b);
      const [task] = await tasksOf(policyId);
      expect(task).toMatchObject({ generation: 0, movedOrganizationId: ancestor });

      await sweeper.runOnce();

      expect((await policyRow(policyId)).status).toBe('SUSPENDED');
      const [review] = await reviewsOf(draft.id);
      expect(review).toMatchObject({
        detectedBy: 'MOVE_RECHECK',
        causeEventId: null,
        movedAt: null,
      });
      const [event] = await flagged(draft.employer);
      expect(event!.payload).toMatchObject({
        detectedBy: 'MOVE_RECHECK',
        causeEventId: null,
        movedAt: null,
      });
      expect(JSON.stringify(event)).not.toContain(b.eventId);
      const [suspended] = (await policyEventsOf(api.prisma, draft.employer)).filter(
        (e) => e.eventName === 'APPROVAL_POLICY_SUSPENDED',
      );
      expect(suspended!.payload).toMatchObject({
        reason: 'MOVE_RECHECK',
        causeEventId: null,
        movedOrganizationId: null,
      });
    });

    it('the database holds the same rule: a review names an event and an instant exactly when a move is its proven cause', async () => {
      const { draft } = await signedOnce();
      const row = (cause: string, at: string, by: string) =>
        `INSERT INTO signature_authority_review
           (id, organization_id, contract_id, side, policy_id, reason, cause_event_id, moved_at,
            detected_by, flagged_at)
         SELECT 'SAR_x' || substr(md5(random()::text), 1, 8), organization_id, contract_id, side,
                policy_id, 'AUTHORITY_CHANGED_DURING_SIGNING', ${cause}, ${at}, '${by}', now()
           FROM contract_signature WHERE contract_id = '${draft.id}' AND side = 'EMPLOYER'`;
      await expect(
        w.prisma.client.$executeRawUnsafe(row('NULL', 'NULL', 'ORGANIZATION_MOVED')),
      ).rejects.toThrow(/ck_review_detection/);
      await expect(
        w.prisma.client.$executeRawUnsafe(row("'EVT_1'", 'now()', 'MOVE_RECHECK')),
      ).rejects.toThrow(/ck_review_detection/);
      await expect(w.prisma.client.$executeRawUnsafe(row('NULL', 'NULL', 'GUESS'))).rejects.toThrow(
        /ck_review_detection/,
      );
      // Exactly two cases — one of the two alone is neither (round 8).
      for (const [cause, at, by] of [
        ["'EVT_1'", 'NULL', 'ORGANIZATION_MOVED'],
        ['NULL', 'now()', 'ORGANIZATION_MOVED'],
        ["' '", 'now()', 'ORGANIZATION_MOVED'],
        ["'EVT_1'", 'NULL', 'MOVE_RECHECK'],
        ['NULL', 'now()', 'MOVE_RECHECK'],
      ] as const) {
        await expect(w.prisma.client.$executeRawUnsafe(row(cause, at, by))).rejects.toThrow(
          /ck_review_detection/,
        );
      }
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
      // The version is the HIGHEST of the moves that coalesced, in whatever order they arrived
      // (3, 5, 4): the flagging then covers a signature that read between the moves too. And the
      // task carries the event of the move whose version it holds (the second, 5) — never a
      // version with another move's event (round 6).
      expect(tasks[0]!.movedVersion).toBe(5n);
      expect(tasks[0]!.sourceEventId).toBe('EVT_PRT_same_ms_2');
      expect(tasks[0]!.movedAt!.toISOString()).toBe(sameInstant.toISOString());
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
