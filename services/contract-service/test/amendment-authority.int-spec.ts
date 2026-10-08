import { runUnscoped } from '@rasta/nest-common';
import { eventEnvelopeSchema, type EventEnvelope } from '@rasta/contracts';
import { ulid } from 'ulid';
import { OrganizationMovedConsumer } from '../src/events/organization-moved.consumer';
import { EventPublisher } from '../src/events/publisher';
import { PolicyReconciliationRepository } from '../src/policy/policy-reconciliation.repository';
import { PolicyReconciliationSweeper } from '../src/policy/policy-reconciliation.sweeper';
import { PolicySuspensionService } from '../src/policy/policy-suspension.service';
import { person, startApi, type ApiHarness } from './api-helpers';
import {
  amendmentRows,
  amendmentSignatures,
  contractRow,
  http,
  idemKey,
  propose,
  reasons,
  signAmendment,
} from './amendment-helpers';
import { asPlatform, cleanup, eventsOf, seedDraft, wire, type Wiring } from './helpers';

/**
 * CON-003 PR 3: the authority an amendment is signed under is the contract signature's own
 * (`SigningAuthority`) — the `contract.signature` policy in force for the employer, asked of the
 * hierarchy at the moment of signing — so every way that authority goes missing refuses the
 * amendment's signature as it refuses the contract's, leaves a durable audit record
 * (`CONTRACT_AUTHORITY_REFUSED`), and a move that raced a signature flags it (D-050), never revokes.
 */
describe('the authority an amendment is signed under', () => {
  let api: ApiHarness;
  let w: Wiring;
  const organizations: string[] = [];

  const key = (): string => idemKey('authority');
  const platform = (): string => person('ORG-ITEST-PLATFORM', ['SYSTEM_ADMIN']);
  const newOrg = (): string => {
    const id = `ORG_${ulid()}`;
    organizations.push(id);
    return id;
  };
  const refusals = (employer: string) =>
    eventsOf(api.prisma, employer, 'CONTRACT_AUTHORITY_REFUSED');
  const policyRow = (policyId: string) =>
    runUnscoped('the suite reads the policy', () =>
      w.prisma.client.approvalPolicy.findFirstOrThrow({ where: { id: policyId } }),
    );
  const command = (token: string, id: string, verb: string, payload: object) =>
    http(api)
      .post(`/v1/approval-policies/${id}/${verb}`)
      .set('authorization', `Bearer ${token}`)
      .send(payload);

  /** A policy `unionOrg` wrote for `employer`, submitted and approved: ACTIVE. */
  async function activeUnionPolicy(unionOrg: string, employer: string): Promise<string> {
    api.hierarchy.adopt(unionOrg, employer);
    const unionAdmin = person(unionOrg, ['UNION_ADMIN']);
    const written = await http(api)
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

  /** A contract SIGNED under a union's policy, with one amendment proposed and nobody having signed it. */
  async function signedUnderUnion() {
    const union = newOrg();
    const draft = await seedDraft(w, organizations, {}, { signingPolicy: false });
    const policyId = await activeUnionPolicy(union, draft.employer);
    const employerToken = person(draft.employer, ['ORGANIZATION_ADMIN']);
    const contractorToken = person(draft.contractor, ['CONTRACTOR']);
    for (const token of [employerToken, contractorToken]) {
      await http(api)
        .post(`/v1/contracts/${draft.id}/sign`)
        .set('authorization', `Bearer ${token}`)
        .set('idempotency-key', key())
        .send({})
        .expect(200);
    }
    const amendment = (await propose(api, draft.id, employerToken).expect(201)).body;
    return { ...draft, union, policyId, employerToken, contractorToken, amendmentId: amendment.id };
  }

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
  });

  describe('a refused signature leaves a durable audit record, committed though the request fails', () => {
    it('no policy in force: 422 SIGNATURE_POLICY_REQUIRED, recorded once; the contractor’s own side is not the employer’s policy and still signs', async () => {
      const c = await signedUnderUnion();
      await asPlatform(() => w.policies.retire(c.policyId, { expectedVersion: 3 }));

      const res = await signAmendment(api, c.id, c.amendmentId, c.employerToken).expect(422);
      expect(res.body.code).toBe('BUSINESS_RULE_VIOLATION');
      expect(reasons(res.body)).toEqual(['amendment:SIGNATURE_POLICY_REQUIRED']);
      expect(await amendmentSignatures(w, c.amendmentId)).toEqual([]);

      const recorded = await refusals(c.employer);
      expect(recorded).toHaveLength(1);
      expect(recorded[0]!.payload).toMatchObject({
        contractId: c.id,
        action: 'SIGN_AMENDMENT',
        side: 'EMPLOYER',
        subjectId: c.amendmentId,
        reason: 'SIGNATURE_POLICY_REQUIRED',
        policyId: null,
      });
      expect(recorded[0]!.payload.refusedBy).toEqual(expect.any(String));

      const contractor = await signAmendment(api, c.id, c.amendmentId, c.contractorToken).expect(
        200,
      );
      expect(contractor.body.status).toBe('PROPOSED');
      // The employer cannot complete it, so it never becomes effective and the price stands.
      expect((await contractRow(w, c.id)).amendmentsTotalMinor).toBe(0n);
    });

    it('a union that lost the employer: 403 POLICY_AUTHOR_NOT_GOVERNING, the policy SUSPENDED, both recorded — and then nobody may sign for want of a policy', async () => {
      const c = await signedUnderUnion();
      api.hierarchy.adopt(newOrg(), c.employer);

      const res = await signAmendment(api, c.id, c.amendmentId, c.employerToken).expect(403);
      expect(res.body.code).toBe('FORBIDDEN');
      expect(reasons(res.body)).toEqual(['amendment:POLICY_AUTHOR_NOT_GOVERNING']);
      expect(await amendmentSignatures(w, c.amendmentId)).toEqual([]);
      expect((await policyRow(c.policyId)).status).toBe('SUSPENDED');
      const recorded = await refusals(c.employer);
      expect(recorded).toHaveLength(1);
      expect(recorded[0]!.payload).toMatchObject({
        reason: 'POLICY_AUTHOR_NOT_GOVERNING',
        policyId: c.policyId,
        side: 'EMPLOYER',
      });

      await signAmendment(api, c.id, c.amendmentId, c.employerToken).expect(422);
      expect((await refusals(c.employer)).map((e) => e.payload.reason)).toEqual([
        'POLICY_AUTHOR_NOT_GOVERNING',
        'SIGNATURE_POLICY_REQUIRED',
      ]);
    });

    it('a refusal that cannot be recorded is a retryable 503, not the normal refusal: nothing is signed, the key is released, and the repeated request leaves its trace', async () => {
      const c = await signedUnderUnion();
      await asPlatform(() => w.policies.retire(c.policyId, { expectedVersion: 3 }));
      const retryKey = key();
      const attempt = () => signAmendment(api, c.id, c.amendmentId, c.employerToken, {}, retryKey);

      const publisher = api.app.get(EventPublisher);
      const original = publisher.enqueue.bind(publisher);
      const failing = jest
        .spyOn(publisher, 'enqueue')
        .mockImplementation(async (...args: Parameters<typeof original>) => {
          if (args[1].eventName === 'CONTRACT_AUTHORITY_REFUSED') throw new Error('outbox down');
          return original(...args);
        });
      try {
        const down = await attempt().expect(503);
        expect(down.body.code).toBe('UPSTREAM_UNAVAILABLE');
        expect(down.headers['retry-after']).toBe('1');
        expect(JSON.stringify(down.body)).not.toContain('outbox');
      } finally {
        failing.mockRestore();
      }
      expect(await amendmentSignatures(w, c.amendmentId)).toEqual([]);
      expect(await refusals(c.employer)).toEqual([]);

      await attempt().expect(422);
      expect(await refusals(c.employer)).toHaveLength(1);
    });

    it('a party’s refusal before the transaction (not the employer; a role not named) is recorded the same way, and its failure is the same 503', async () => {
      const c = await signedUnderUnion();
      const publisher = api.app.get(EventPublisher);
      const original = publisher.enqueue.bind(publisher);
      const failing = jest
        .spyOn(publisher, 'enqueue')
        .mockImplementation(async (...args: Parameters<typeof original>) => {
          if (args[1].eventName === 'CONTRACT_AUTHORITY_REFUSED') throw new Error('outbox down');
          return original(...args);
        });
      try {
        await propose(api, c.id, c.contractorToken).expect(503);
      } finally {
        failing.mockRestore();
      }
      expect(await refusals(c.employer)).toEqual([]);
      await propose(api, c.id, c.contractorToken).expect(403);
      expect((await refusals(c.employer)).map((e) => e.payload.reason)).toEqual(['NOT_EMPLOYER']);
      expect(await amendmentRows(w, c.id)).toHaveLength(1);
    });

    it('records no refusal for a signature that cannot be confirmed (the hierarchy is down: 503, too slow: 504), and leaves the policy in force', async () => {
      const c = await signedUnderUnion();
      api.hierarchy.unavailable = true;
      await signAmendment(api, c.id, c.amendmentId, c.employerToken).expect(503);
      api.hierarchy.unavailable = false;
      api.hierarchy.timedOut = true;
      await signAmendment(api, c.id, c.amendmentId, c.employerToken).expect(504);
      api.hierarchy.timedOut = false;
      expect(await refusals(c.employer)).toEqual([]);
      expect(await amendmentSignatures(w, c.amendmentId)).toEqual([]);
      expect((await policyRow(c.policyId)).status).toBe('ACTIVE');
      // Asked again, with the hierarchy back, it signs.
      await signAmendment(api, c.id, c.amendmentId, c.employerToken).expect(200);
    });

    it('records no refusal for a failure that is not a want of authority: a stale version, a bigint overflow, a person who signed the other side', async () => {
      const c = await signedUnderUnion();
      await signAmendment(api, c.id, c.amendmentId, c.employerToken, { expectedVersion: 9 }).expect(
        409,
      );
      expect(await refusals(c.employer)).toEqual([]);
    });
  });

  describe('a signature a move may have raced is flagged, never revoked (D-050)', () => {
    const reviewsOf = (amendmentId: string) =>
      runUnscoped('the suite reads the reviews', () =>
        w.prisma.client.amendmentSignatureReview.findMany({ where: { amendmentId } }),
      );
    const flaggedEvents = (employer: string) =>
      eventsOf(api.prisma, employer, 'CONTRACT_AMENDMENT_SIGNATURE_AUTHORITY_FLAGGED');
    const evidenceOf = (amendmentId: string) =>
      runUnscoped('the suite reads the evidence', () =>
        w.prisma.client.amendmentSignature.findFirstOrThrow({
          where: { amendmentId, side: 'EMPLOYER' },
        }),
      );

    it('flags exactly the amendment signatures that recorded a LOWER hierarchy version than the move’s and could still have committed after it', async () => {
      const raced = await signedUnderUnion();
      await signAmendment(api, raced.id, raced.amendmentId, raced.employerToken).expect(200);
      const evidence = await evidenceOf(raced.amendmentId);
      expect(evidence.hierarchyVersion).toBe(BigInt(api.hierarchy.versionOf(raced.employer)));

      // The employer left the union: a move stamps a higher version, and its event carries it.
      api.hierarchy.adopt(newOrg(), raced.employer);
      const movedVersion = api.hierarchy.bump(raced.employer);
      const movedAt = new Date(evidence.hierarchyCommitDeadline!.getTime() - 1);
      const event = moved(raced.employer, movedAt, movedVersion);
      await consumer.handle(event);
      await sweeper.runOnce();

      expect((await policyRow(raced.policyId)).status).toBe('SUSPENDED');
      const reviews = await reviewsOf(raced.amendmentId);
      expect(reviews).toHaveLength(1);
      expect(reviews[0]).toMatchObject({
        side: 'EMPLOYER',
        policyId: raced.policyId,
        reason: 'AUTHORITY_CHANGED_DURING_SIGNING',
        // The sweeper never names a cause (#231 r9, D-051), even for a move that carries the
        // version the employer carries.
        detectedBy: 'MOVE_RECHECK',
        causeEventId: null,
        movedAt: null,
        movedVersion: BigInt(movedVersion),
        recordedVersion: evidence.hierarchyVersion,
      });
      const events = await flaggedEvents(raced.employer);
      expect(events).toHaveLength(1);
      expect(events[0]!.payload).toMatchObject({
        contractId: raced.id,
        amendmentId: raced.amendmentId,
        policyId: raced.policyId,
        policyVersion: 1,
        reason: 'AUTHORITY_CHANGED_DURING_SIGNING',
        detectedBy: 'MOVE_RECHECK',
        causeEventId: null,
        movedAt: null,
        movedVersion,
      });
      expect(JSON.stringify(events[0]!.payload)).not.toContain(event.eventId);
      // The contract's own signature (made under the same policy, before the move's window) is
      // judged by its own evidence and is not confused with the amendment's.
      expect(
        await eventsOf(api.prisma, raced.employer, 'CONTRACT_SIGNATURE_AUTHORITY_FLAGGED'),
      ).not.toEqual(events);

      // A redelivery flags nothing more.
      await consumer.handle(event);
      await sweeper.runOnce();
      expect(await reviewsOf(raced.amendmentId)).toHaveLength(1);
      expect(await flaggedEvents(raced.employer)).toHaveLength(1);

      // Never revokes: the signature stands, and the contractor's signature still completes it.
      expect(await amendmentSignatures(w, raced.amendmentId)).toHaveLength(1);
      const done = await signAmendment(
        api,
        raced.id,
        raced.amendmentId,
        raced.contractorToken,
      ).expect(200);
      expect(done.body).toMatchObject({ status: 'EFFECTIVE', authorityReviewRequired: true });
      expect((await contractRow(w, raced.id)).amendmentsTotalMinor).toBe(250_000_000n);
      // A party sees the flag in the read API; it shows no review row, only that one exists.
      const read = await http(api)
        .get(`/v1/contracts/${raced.id}/amendments/${raced.amendmentId}`)
        .set('authorization', `Bearer ${raced.contractorToken}`)
        .expect(200);
      expect(read.body.authorityReviewRequired).toBe(true);
    });

    it('a move that is not shown to be the cause (no version) still flags the raced signature, but names no event or instant (#231 round 6)', async () => {
      const raced = await signedUnderUnion();
      await signAmendment(api, raced.id, raced.amendmentId, raced.employerToken).expect(200);
      const evidence = await evidenceOf(raced.amendmentId);

      api.hierarchy.adopt(newOrg(), raced.employer);
      const event = moved(raced.employer);
      await consumer.handle(event);
      await sweeper.runOnce();

      const reviews = await reviewsOf(raced.amendmentId);
      expect(reviews).toHaveLength(1);
      expect(reviews[0]).toMatchObject({
        detectedBy: 'MOVE_RECHECK',
        causeEventId: null,
        movedAt: null,
        movedVersion: null,
        recordedVersion: evidence.hierarchyVersion,
      });
      const events = await flaggedEvents(raced.employer);
      expect(events).toHaveLength(1);
      expect(events[0]!.payload).toMatchObject({
        amendmentId: raced.amendmentId,
        detectedBy: 'MOVE_RECHECK',
        causeEventId: null,
        movedAt: null,
      });
      expect(JSON.stringify(events[0]!.payload)).not.toContain(event.eventId);
    });

    it('a signature committed well before the move is not flagged even on an older tree; the same signature inside the window is (D-050 bound)', async () => {
      const before = await signedUnderUnion();
      await signAmendment(api, before.id, before.amendmentId, before.employerToken).expect(200);
      const beforeEvidence = await evidenceOf(before.amendmentId);
      const inside = await signedUnderUnion();
      await signAmendment(api, inside.id, inside.amendmentId, inside.employerToken).expect(200);
      const insideEvidence = await evidenceOf(inside.amendmentId);

      for (const [c, at] of [
        [before, new Date(beforeEvidence.hierarchyCommitDeadline!.getTime() + 30_000)],
        [inside, new Date(insideEvidence.hierarchyCommitDeadline!.getTime() - 1)],
      ] as const) {
        api.hierarchy.adopt(newOrg(), c.employer);
        await consumer.handle(moved(c.employer, at, api.hierarchy.bump(c.employer)));
      }
      await sweeper.runOnce();

      expect(await reviewsOf(before.amendmentId)).toEqual([]);
      expect(await flaggedEvents(before.employer)).toEqual([]);
      expect(await reviewsOf(inside.amendmentId)).toHaveLength(1);
      expect((await reviewsOf(inside.amendmentId))[0]).toMatchObject({
        detectedBy: 'MOVE_RECHECK',
        causeEventId: null,
        movedAt: null,
      });
    });

    it('a signature that read the tree after the move recorded its version: not raced, not flagged', async () => {
      const union = newOrg();
      const draft = await seedDraft(w, organizations, {}, { signingPolicy: false });
      const policyId = await activeUnionPolicy(union, draft.employer);
      const employerToken = person(draft.employer, ['ORGANIZATION_ADMIN']);
      const contractorToken = person(draft.contractor, ['CONTRACTOR']);
      for (const token of [employerToken, contractorToken]) {
        await http(api)
          .post(`/v1/contracts/${draft.id}/sign`)
          .set('authorization', `Bearer ${token}`)
          .set('idempotency-key', key())
          .send({})
          .expect(200);
      }
      const amendmentId = (await propose(api, draft.id, employerToken).expect(201)).body.id;
      // The move committed first: the signature's answer already carries its version.
      const movedVersion = api.hierarchy.bump(draft.employer);
      await signAmendment(api, draft.id, amendmentId, employerToken).expect(200);
      const evidence = await evidenceOf(amendmentId);
      expect(evidence.hierarchyVersion).toBe(BigInt(movedVersion));

      api.hierarchy.adopt(newOrg(), draft.employer);
      await consumer.handle(
        moved(
          draft.employer,
          new Date(evidence.hierarchyCommitDeadline!.getTime() - 1),
          movedVersion,
        ),
      );
      await sweeper.runOnce();
      expect((await policyRow(policyId)).status).toBe('SUSPENDED');
      expect(await reviewsOf(amendmentId)).toEqual([]);
      expect(await flaggedEvents(draft.employer)).toEqual([]);
    });

    it('the database holds the exact two-case rule: an event AND an instant with ORGANIZATION_MOVED, neither with MOVE_RECHECK (#235 round 2)', async () => {
      const c = await signedUnderUnion();
      await signAmendment(api, c.id, c.amendmentId, c.employerToken).expect(200);
      const row = (cause: string, at: string, by: string) =>
        `INSERT INTO amendment_signature_review
           (id, organization_id, contract_id, amendment_id, side, policy_id, reason, cause_event_id,
            moved_at, detected_by, flagged_at)
         SELECT 'ASR_x' || substr(md5(random()::text), 1, 8), organization_id, contract_id,
                amendment_id, side, '${c.policyId}', 'AUTHORITY_CHANGED_DURING_SIGNING', ${cause},
                ${at}, '${by}', now()
           FROM amendment_signature WHERE amendment_id = '${c.amendmentId}' AND side = 'EMPLOYER'`;
      for (const [what, cause, at, by] of [
        ['ORGANIZATION_MOVED naming neither', 'NULL', 'NULL', 'ORGANIZATION_MOVED'],
        ['ORGANIZATION_MOVED without its instant', "'EVT_1'", 'NULL', 'ORGANIZATION_MOVED'],
        ['ORGANIZATION_MOVED without its event', 'NULL', 'now()', 'ORGANIZATION_MOVED'],
        ['ORGANIZATION_MOVED with a blank event', "' '", 'now()', 'ORGANIZATION_MOVED'],
        ['MOVE_RECHECK naming an event only', "'EVT_1'", 'NULL', 'MOVE_RECHECK'],
        ['MOVE_RECHECK naming an instant only', 'NULL', 'now()', 'MOVE_RECHECK'],
        ['MOVE_RECHECK naming both', "'EVT_1'", 'now()', 'MOVE_RECHECK'],
        ['a detectedBy outside the pair', 'NULL', 'NULL', 'GUESS'],
      ] as const) {
        const refusedBy = await w.prisma.client.$executeRawUnsafe(row(cause, at, by)).then(
          () => 'accepted',
          (error: Error) =>
            /ck_amendment_review_reason/.test(error.message) ? 'ck' : error.message,
        );
        expect({ what, refusedBy }).toEqual({ what, refusedBy: 'ck' });
      }
      expect(await reviewsOf(c.amendmentId)).toEqual([]);
    });

    it('a review is append-only: the database refuses to change or remove it', async () => {
      const c = await signedUnderUnion();
      await signAmendment(api, c.id, c.amendmentId, c.employerToken).expect(200);
      const evidence = await evidenceOf(c.amendmentId);
      api.hierarchy.adopt(newOrg(), c.employer);
      const movedVersion = api.hierarchy.bump(c.employer);
      await consumer.handle(
        moved(c.employer, new Date(evidence.hierarchyCommitDeadline!.getTime() - 1), movedVersion),
      );
      await sweeper.runOnce();
      const [review] = await reviewsOf(c.amendmentId);
      expect(review).toBeDefined();
      await expect(
        w.prisma.client.$executeRawUnsafe(
          `UPDATE amendment_signature_review SET reason = 'X' WHERE id = '${review!.id}'`,
        ),
      ).rejects.toThrow(/ck_amendment_review_immutable/);
      await expect(
        w.prisma.client.$executeRawUnsafe(
          `DELETE FROM amendment_signature_review WHERE id = '${review!.id}'`,
        ),
      ).rejects.toThrow(/ck_amendment_review_immutable/);
    });
  });

  describe('the employer’s hierarchy is asked at the moment of signing', () => {
    it('a signature under a union policy asks for the writing union and the employer; the contractor’s side asks nothing', async () => {
      const c = await signedUnderUnion();
      api.hierarchy.asked.length = 0;
      await signAmendment(api, c.id, c.amendmentId, c.contractorToken).expect(200);
      expect(api.hierarchy.asked).toEqual([]);
      await signAmendment(api, c.id, c.amendmentId, c.employerToken).expect(200);
      expect(api.hierarchy.asked).toEqual([[c.union, c.employer]]);
    });
  });
});
