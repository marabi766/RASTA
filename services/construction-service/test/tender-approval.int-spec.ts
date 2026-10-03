import { RastaError, runUnscoped, runWithContext, type RequestContext } from '@rasta/nest-common';
import { eventEnvelopeSchema } from '@rasta/contracts';
import type { CriterionInput } from '../src/tender/criteria.dto';
import type { TenderApprovalRequestView } from '../src/tender/tender-approval.dto';
import {
  TEST_ISSUER,
  activePolicy,
  approveAward,
  approveCancellation,
  approvePublication,
  approvedProject,
  asAdmin,
  asApprover,
  awardApproved,
  cleanup,
  context,
  ensureGatePolicy,
  evaluatedTender,
  evaluatingTender,
  grantRequest,
  newOrganizationId,
  newUserId,
  outboxFor,
  publishApproved,
  testEnv,
  untilASessionWaitsOnALock,
  wire,
  type GateKey,
  type Wiring,
} from './helpers';

/**
 * The approval gates of a tender (CON-002 PR 11, Q-84 item 5) against PostgreSQL: the request bound to
 * what the command would execute, who may decide it, the time of check against the time of use, the
 * single use of an approval, and the database's own guards under all of it.
 */

const WHOLE: CriterionInput[] = [
  { code: 'PRICE', label: 'Price', weightBp: 6000, scoringMethod: 'MANUAL_SCORE', maxScore: 100 },
  { code: 'LICENCE', label: 'Licence', weightBp: 4000, scoringMethod: 'PASS_FAIL', maxScore: 1 },
];
const DAY = 24 * 60 * 60 * 1000;
const payloadOf = (row: { payload: unknown }) => eventEnvelopeSchema.parse(row.payload).payload;

describe('the approval gates of a tender', () => {
  let w: Wiring;
  let strict: Wiring;
  const organizations: string[] = [];

  const org = (): string => {
    const id = newOrganizationId();
    organizations.push(id);
    return id;
  };

  const sql = (statement: string) =>
    runUnscoped('the suite acts as the runtime role', () =>
      w.prisma.client.$executeRawUnsafe(statement),
    );

  /** A DRAFT tender of a fresh organization, ready to publish. */
  async function draft() {
    const a = org();
    const project = await approvedProject(w, a);
    const tender = await asAdmin(a, () =>
      w.tenders.create(project.id, {
        title: 'Road resurfacing',
        scopeOfWork: 'Two kilometres of the main road',
        procurementNature: 'FORMAL_TENDER',
        visibility: 'PUBLIC',
        bidOpeningAt: new Date(Date.now() + DAY).toISOString(),
        bidClosingAt: new Date(Date.now() + 30 * DAY).toISOString(),
      }),
    );
    const set = await asAdmin(a, () =>
      w.criteria.setCriteria(tender.id, { expectedVersion: tender.version, criteria: WHOLE }),
    );
    return { a, tenderId: tender.id, version: set.version };
  }

  const publish = (a: string, tenderId: string, version: number, userId?: string) =>
    asAdmin(a, () => w.publication.publish(tenderId, { expectedVersion: version }), userId);

  const requested = (answer: { executed: boolean } & Record<string, unknown>) => {
    if (answer.executed) throw new Error('expected a request, the command was executed');
    return answer.request as TenderApprovalRequestView;
  };

  /** Decides a step as a person of its authority; the version is read just before. */
  const decide = async (
    authority: string,
    approvalId: string,
    decision: 'GRANT' | 'REJECT' = 'GRANT',
    userId?: string,
  ) => {
    const fresh = await asApprover(authority, () => w.approvals.get(approvalId));
    return asApprover(
      authority,
      () =>
        w.approvals.decide(approvalId, {
          expectedVersion: fresh.version,
          ...(decision === 'GRANT' ? { decision } : { decision, reason: 'Not on these terms' }),
        }),
      userId,
    );
  };

  const requestRow = (id: string) =>
    runUnscoped('the suite reads a request', () =>
      w.prisma.client.tenderApprovalRequest.findFirstOrThrow({ where: { id } }),
    );

  const stepRows = (tenderId: string, workflowKey: GateKey) =>
    runUnscoped('the suite reads the steps', () =>
      w.prisma.client.approval.findMany({
        where: { tenderId, workflowKey },
        orderBy: [{ round: 'asc' }, { stepOrder: 'asc' }],
      }),
    );

  const logOf = (a: string, tenderId: string) =>
    w.tenderApprovalRepository.log(w.prisma.client, a, tenderId);

  const actionEvents = async (a: string, tenderId: string) =>
    (await outboxFor(w.prisma, a))
      .filter((row) => row.eventName === 'TENDER_APPROVAL_ACTION' && row.aggregateId === tenderId)
      .map((row) => payloadOf(row) as Record<string, unknown>);

  const tenderState = (a: string, tenderId: string) => asAdmin(a, () => w.tenders.get(tenderId));

  const codeOf = async (call: Promise<unknown>) =>
    ((await call.then(
      () => undefined,
      (e: unknown) => e,
    )) ?? {}) as { code?: string; message?: string };

  beforeAll(() => {
    const open = { CONSTRUCTION_TENDER_OPEN_FOUR_EYES: 'false' };
    w = wire(testEnv(open));
    strict = wire(testEnv({ ...open, CONSTRUCTION_COI_RULES: 'AWARDER_NOT_EVALUATOR' }));
  });

  afterAll(async () => {
    await cleanup(w.prisma, organizations);
    await strict.close();
    await w.close();
  });

  // -------------------------------------------------------------------------------------------

  describe('a request bound to what would be executed', () => {
    it('with no policy in force refuses 422 APPROVAL_POLICY_REQUIRED and leaves nothing behind but the refusal, audited', async () => {
      const { a, tenderId, version } = await draft();
      const error = await codeOf(publish(a, tenderId, version));
      expect(error.code).toBe('BUSINESS_RULE_VIOLATION');
      expect(error.message).toContain('APPROVAL_POLICY_REQUIRED');
      expect(await stepRows(tenderId, 'tender.publication')).toHaveLength(0);
      expect((await tenderState(a, tenderId)).status).toBe('DRAFT');
      expect(await logOf(a, tenderId)).toEqual([
        expect.objectContaining({
          action: 'REQUEST',
          outcome: 'REFUSED',
          refusalCode: 'APPROVAL_POLICY_REQUIRED',
        }),
      ]);
      expect(await actionEvents(a, tenderId)).toEqual([
        expect.objectContaining({ outcome: 'REFUSED', refusalCode: 'APPROVAL_POLICY_REQUIRED' }),
      ]);
    });

    it('with a policy in force opens a request bound to the tender and its version, and reuses it', async () => {
      const { a, tenderId, version } = await draft();
      await ensureGatePolicy(w, a, 'tender.publication');

      const first = requested(await publish(a, tenderId, version));
      const again = requested(await publish(a, tenderId, version));

      expect(first).toMatchObject({
        workflowKey: 'tender.publication',
        tenderId,
        tenderVersion: version,
        round: 1,
        status: 'PENDING',
        reasonCode: null,
        consumedAt: null,
        endedAt: null,
      });
      expect(first.steps).toEqual([
        expect.objectContaining({
          stepOrder: 1,
          status: 'PENDING',
          authorityRole: 'ORGANIZATION_ADMIN',
        }),
      ]);
      expect(again.id).toBe(first.id);
      expect(await stepRows(tenderId, 'tender.publication')).toHaveLength(1);
      expect((await tenderState(a, tenderId)).status).toBe('DRAFT');
      // One REQUEST in the log and on the stream, however often the command was asked.
      expect((await logOf(a, tenderId)).filter((r) => r.action === 'REQUEST')).toHaveLength(1);
      expect((await actionEvents(a, tenderId)).filter((e) => e.action === 'REQUEST')).toEqual([
        expect.objectContaining({ requestId: first.id, outcome: 'GRANTED' }),
      ]);
      // The owner reads its requests; nobody's words travel on the event.
      const listed = await asAdmin(a, () =>
        w.tenderApprovals.listForTender(tenderId, { limit: 25 }),
      );
      expect(listed.items.map((r) => r.id)).toEqual([first.id]);
    });

    it('a request that could not succeed is not made: the publication’s own refusals come first', async () => {
      const { a, tenderId, version } = await draft();
      await ensureGatePolicy(w, a, 'tender.publication');
      await runUnscoped('the suite empties the criteria', () =>
        w.prisma.client.$executeRawUnsafe(
          `DELETE FROM "tender_criterion" WHERE "tender_id" = '${tenderId}'`,
        ),
      );
      const error = await codeOf(publish(a, tenderId, version));
      expect(error.message).toContain('CRITERIA_REQUIRED');
      expect(await stepRows(tenderId, 'tender.publication')).toHaveLength(0);
    });

    it('a policy whose steps are all bounded by an amount has no step that applies: refused, closed', async () => {
      const { a, tenderId, version } = await draft();
      await activePolicy(
        w,
        a,
        [{ authorityOrganizationId: a, minAmountMinor: '0', maxAmountMinor: '1000' }],
        'tender.publication',
      );
      const error = await codeOf(publish(a, tenderId, version));
      expect(error.code).toBe('BUSINESS_RULE_VIOLATION');
      expect(error.message).toContain('APPROVAL_POLICY_REQUIRED');
      expect(await stepRows(tenderId, 'tender.publication')).toHaveLength(0);
    });

    it('an award request carries the bid, its rank, the justification, the matrix digest and the standing it was decided on', async () => {
      const { owner, tenderId, bids } = await evaluatedTender(w, organizations, { count: 2 });
      await ensureGatePolicy(w, owner, 'tender.award');
      const answer = await asAdmin(owner, () =>
        w.award.award(tenderId, { bidId: bids[1]!.bidId, justification: 'Best local record' }),
      );
      const request = requested(answer);
      expect(request.workflowKey).toBe('tender.award');
      const row = await requestRow(request.id);
      expect(row).toMatchObject({
        bidId: bids[1]!.bidId,
        bidderOrganizationId: bids[1]!.bidder,
        rank: 2,
        tied: false,
        justification: 'Best local record',
        standingVerdict: 'ELIGIBLE',
        tenderVersion: (await tenderState(owner, tenderId)).version,
      });
      expect(row.matrixDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(row.standingAsOf).toBeInstanceOf(Date);
      // The authority is shown what it decides on — and never the price.
      const seen = await asApprover(owner, () => w.approvals.get(request.steps[0]!.approvalId));
      expect(seen.request?.bid).toMatchObject({
        bidId: bids[1]!.bidId,
        rank: 2,
        justification: 'Best local record',
        standingVerdict: 'ELIGIBLE',
      });
      expect(JSON.stringify(seen)).not.toMatch(/amount|price/i);
      // The authority's list names no bid.
      const inbox = await asApprover(owner, () =>
        w.approvals.inbox({ limit: 50, status: 'PENDING' }),
      );
      expect(
        inbox.items.find((item) => item.id === request.steps[0]!.approvalId)?.request?.bid,
      ).toBeNull();
    });

    it('a cancellation request carries the reason and its closed code', async () => {
      const { a, tenderId, version } = await draft();
      await ensureGatePolicy(w, a, 'tender.cancellation');
      const request = requested(
        await asAdmin(a, () =>
          w.tenders.cancel(tenderId, {
            expectedVersion: version,
            reason: 'Funding was withdrawn',
            reasonCode: 'OWNER_REQUEST',
          }),
        ),
      );
      expect(request.reasonCode).toBe('OWNER_REQUEST');
      const seen = await asApprover(a, () => w.approvals.get(request.steps[0]!.approvalId));
      expect(seen.request?.cancellation).toEqual({
        reason: 'Funding was withdrawn',
        reasonCode: 'OWNER_REQUEST',
      });
      expect(seen.tenderId).toBe(tenderId);
    });
  });

  // -------------------------------------------------------------------------------------------

  describe('who approves comes from the policy', () => {
    it('only the organization and role a step names may decide it; the owner’s own people may not, and others see nothing', async () => {
      const { a, tenderId, version } = await draft();
      const authority = org();
      await activePolicy(w, a, [{ authorityOrganizationId: authority }], 'tender.publication');
      const request = requested(await publish(a, tenderId, version));
      const step = request.steps[0]!;

      // The owner's administrator can see it but is not its authority (403); a stranger learns nothing (404).
      const ownerTry = await codeOf(decide(a, step.approvalId));
      expect(ownerTry.code).toBe('FORBIDDEN');
      const stranger = await codeOf(decide(org(), step.approvalId));
      expect(stranger.code).toBe('NOT_FOUND');
      expect((await stepRows(tenderId, 'tender.publication'))[0]!.status).toBe('PENDING');

      // The named authority decides, and the inbox it reads names the tender.
      const inbox = await asApprover(authority, () =>
        w.approvals.inbox({ limit: 50, status: 'PENDING' }),
      );
      expect(inbox.items.find((i) => i.id === step.approvalId)).toMatchObject({
        tenderId,
        workflowKey: 'tender.publication',
      });
      await decide(authority, step.approvalId);
      const published = await asAdmin(a, () =>
        w.publication.publish(tenderId, { expectedVersion: version }),
      );
      expect(published.executed).toBe(true);
    });

    it('steps are sequential: the second is asked only after the first granted, and the round is approved only after the last', async () => {
      const { a, tenderId, version } = await draft();
      const first = org();
      const second = org();
      await activePolicy(
        w,
        a,
        [{ authorityOrganizationId: first }, { authorityOrganizationId: second }],
        'tender.publication',
      );
      const request = requested(await publish(a, tenderId, version));
      expect(request.steps.map((s) => s.status)).toEqual(['PENDING', 'QUEUED']);

      // The second step cannot be decided before the first.
      expect((await codeOf(decide(second, request.steps[1]!.approvalId))).code).toBe(
        'BUSINESS_RULE_VIOLATION',
      );
      await decide(first, request.steps[0]!.approvalId);
      // Granted, but not by everyone: still no publication.
      expect(requested(await publish(a, tenderId, version)).status).toBe('PENDING');
      await decide(second, request.steps[1]!.approvalId);
      expect((await publish(a, tenderId, version)).executed).toBe(true);
    });

    it('a rejection ends the round: the rest is superseded, nothing is published, and the next call opens a new round', async () => {
      const { a, tenderId, version } = await draft();
      const first = org();
      const second = org();
      await activePolicy(
        w,
        a,
        [{ authorityOrganizationId: first }, { authorityOrganizationId: second }],
        'tender.publication',
      );
      const request = requested(await publish(a, tenderId, version));
      await decide(first, request.steps[0]!.approvalId, 'REJECT');

      expect((await stepRows(tenderId, 'tender.publication')).map((s) => s.status)).toEqual([
        'REJECTED',
        'SUPERSEDED',
      ]);
      expect(await requestRow(request.id)).toMatchObject({
        endedReason: 'REJECTED',
        consumedAt: null,
      });
      expect((await tenderState(a, tenderId)).status).toBe('DRAFT');

      const next = requested(await publish(a, tenderId, version));
      expect(next.id).not.toBe(request.id);
      expect(next).toMatchObject({ round: 2, status: 'PENDING' });
    });
  });

  // -------------------------------------------------------------------------------------------

  describe('separation of duties', () => {
    const asPerson = <T>(
      organizationId: string,
      overrides: Partial<RequestContext>,
      fn: () => T,
    ): T =>
      runWithContext(
        context({
          organizationId,
          organizationIds: [organizationId],
          roles: ['ORGANIZATION_ADMIN'],
          ...overrides,
        }),
        fn,
      );

    const asked = async (requester: Partial<RequestContext>) => {
      const { a, tenderId, version } = await draft();
      await ensureGatePolicy(w, a, 'tender.publication');
      const request = requested(
        await asPerson(a, requester, () =>
          w.publication.publish(tenderId, { expectedVersion: version }),
        ),
      );
      return { a, tenderId, version, request, step: request.steps[0]! };
    };

    const decideAs = (a: string, approvalId: string, person: Partial<RequestContext>) =>
      asPerson(a, person, async () => {
        const fresh = await w.approvals.get(approvalId);
        return w.approvals.decide(approvalId, {
          decision: 'GRANT',
          expectedVersion: fresh.version,
        });
      });

    it('the requester never approves their own request: 403, audited, still pending', async () => {
      const me = { userId: 'USR_ME', subject: 'sub-me', issuer: TEST_ISSUER };
      const { a, tenderId, step } = await asked(me);
      const error = await codeOf(decideAs(a, step.approvalId, me));
      expect(error.code).toBe('FORBIDDEN');
      expect(error.message).toContain('Separation of duties');
      expect((await stepRows(tenderId, 'tender.publication'))[0]!.status).toBe('PENDING');
      expect(await logOf(a, tenderId)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            action: 'GRANT',
            outcome: 'REFUSED',
            refusalCode: 'FORBIDDEN',
            actorUserId: 'USR_ME',
          }),
        ]),
      );
    });

    it('the same person under another user id is one person', async () => {
      const { a, step } = await asked({
        userId: 'USR_ONE',
        subject: 'sub-shared',
        issuer: TEST_ISSUER,
      });
      const error = await codeOf(
        decideAs(a, step.approvalId, {
          userId: 'USR_TWO',
          subject: 'sub-shared',
          issuer: TEST_ISSUER,
        }),
      );
      expect(error.code).toBe('FORBIDDEN');
    });

    it('another issuer cannot be told from the requester: 422 ACTOR_IDENTITY_UNKNOWN, fail closed', async () => {
      const { a, step } = await asked({
        userId: 'USR_ONE',
        subject: 'sub-one',
        issuer: TEST_ISSUER,
      });
      const error = await codeOf(
        decideAs(a, step.approvalId, {
          userId: 'USR_OTHER',
          subject: 'sub-other',
          issuer: 'http://elsewhere.invalid/realms/rasta',
        }),
      );
      expect(error.code).toBe('ACTOR_IDENTITY_UNKNOWN');
    });

    it('an approver with no stable identity is refused the same way', async () => {
      const { a, step } = await asked({
        userId: 'USR_ONE',
        subject: 'sub-one',
        issuer: TEST_ISSUER,
      });
      const error = await codeOf(
        decideAs(a, step.approvalId, {
          userId: 'USR_BARE',
          subject: undefined,
          issuer: undefined,
        } as unknown as Partial<RequestContext>),
      );
      expect(error.code).toBe('ACTOR_IDENTITY_UNKNOWN');
    });

    it('a requester with no stable identity cannot ask at all: nobody could ever approve it', async () => {
      const { a, tenderId, version } = await draft();
      await ensureGatePolicy(w, a, 'tender.publication');
      const error = await codeOf(
        runWithContext(
          context({
            organizationId: a,
            organizationIds: [a],
            roles: ['ORGANIZATION_ADMIN'],
            userId: 'USR_BARE',
            subject: undefined,
            issuer: undefined,
          } as unknown as Partial<RequestContext>),
          () => w.publication.publish(tenderId, { expectedVersion: version }),
        ),
      );
      expect(error.code).toBe('ACTOR_IDENTITY_UNKNOWN');
      expect(await stepRows(tenderId, 'tender.publication')).toHaveLength(0);
    });

    it('a different person approves; the requester may reject their own request (withdraw it)', async () => {
      const me = { userId: 'USR_ME2', subject: 'sub-me2', issuer: TEST_ISSUER };
      const { a, tenderId, step } = await asked(me);
      await decideAs(a, step.approvalId, {
        userId: 'USR_YOU',
        subject: 'sub-you',
        issuer: TEST_ISSUER,
      });
      expect((await stepRows(tenderId, 'tender.publication'))[0]!.status).toBe('GRANTED');

      const second = await asked(me);
      await asPerson(second.a, me, async () => {
        const fresh = await w.approvals.get(second.step.approvalId);
        await w.approvals.decide(second.step.approvalId, {
          decision: 'REJECT',
          reason: 'Withdrawn by its maker',
          expectedVersion: fresh.version,
        });
      });
      expect(await requestRow(second.request.id)).toMatchObject({ endedReason: 'REJECTED' });
    });
  });

  // -------------------------------------------------------------------------------------------

  describe('the conflict rules of an award apply to its approvers', () => {
    const asked = async (on: Wiring = w) => {
      const t = await evaluatedTender(on, organizations, { count: 2 });
      await ensureGatePolicy(on, t.owner, 'tender.award');
      const request = requested(
        await asAdmin(t.owner, () => on.award.award(t.tenderId, { bidId: t.bids[0]!.bidId })),
      );
      return { ...t, request, step: request.steps[0]! };
    };

    it('a member of a bidding organization may neither decide it (403 CONFLICT_OF_INTEREST) nor read it', async () => {
      const t = await asked();
      const approver = newUserId();
      w.memberships.of.set(approver, [t.bids[1]!.bidder]);
      const decision = await codeOf(
        asApprover(
          t.owner,
          async () => {
            const fresh = await w.approvals.get(t.step.approvalId).catch(() => undefined);
            return w.approvals.decide(t.step.approvalId, {
              decision: 'GRANT',
              expectedVersion: fresh?.version ?? 1,
            });
          },
          approver,
        ),
      );
      expect(decision.code).toBe('FORBIDDEN');
      expect(decision.message).toContain('CONFLICT_OF_INTEREST');
      expect(
        (await codeOf(asApprover(t.owner, () => w.approvals.get(t.step.approvalId), approver)))
          .message,
      ).toContain('CONFLICT_OF_INTEREST');
      expect((await stepRows(t.tenderId, 'tender.award'))[0]!.status).toBe('PENDING');
      expect(await logOf(t.owner, t.tenderId)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            action: 'GRANT',
            outcome: 'REFUSED',
            refusalCode: 'CONFLICT_OF_INTEREST',
            actorUserId: approver,
          }),
        ]),
      );
    });

    it('the roles the bid side excludes never approve an award, even when the policy names one', async () => {
      const t = await evaluatedTender(w, organizations, { count: 1 });
      await activePolicy(
        w,
        t.owner,
        [{ authorityOrganizationId: t.owner, authorityRole: 'SYSTEM_ADMIN' }],
        'tender.award',
      );
      const request = requested(
        await asAdmin(t.owner, () => w.award.award(t.tenderId, { bidId: t.bids[0]!.bidId })),
      );
      const stepId = request.steps[0]!.approvalId;
      const error = await codeOf(
        asApprover(
          t.owner,
          async () => w.approvals.decide(stepId, { decision: 'GRANT', expectedVersion: 1 }),
          newUserId(),
          'SYSTEM_ADMIN',
        ),
      );
      expect(error.code).toBe('FORBIDDEN');
      expect((await stepRows(t.tenderId, 'tender.award'))[0]!.status).toBe('PENDING');
    });

    it('with AWARDER_NOT_EVALUATOR on, a person who took part in the evaluation does not approve the award (403)', async () => {
      const t = await asked(strict);
      const error = await codeOf(
        asApprover(
          t.owner,
          async () => {
            const fresh = await strict.approvals.get(t.step.approvalId);
            return strict.approvals.decide(t.step.approvalId, {
              decision: 'GRANT',
              expectedVersion: fresh.version,
            });
          },
          t.evaluator,
        ),
      );
      expect(error.code).toBe('FORBIDDEN');
      expect(error.message).toContain('APPROVER_IS_EVALUATOR');
      // Somebody else decides, and the award goes through.
      await grantRequest(strict, t.request);
      const done = await asAdmin(t.owner, () =>
        strict.award.award(t.tenderId, { bidId: t.bids[0]!.bidId }),
      );
      expect(done.executed).toBe(true);
    });

    it('with it on, an approver the records cannot tell from the evaluators is refused 422 (fail closed)', async () => {
      const t = await asked(strict);
      const error = await codeOf(
        runWithContext(
          context({
            organizationId: t.owner,
            organizationIds: [t.owner],
            roles: ['ORGANIZATION_ADMIN'],
            userId: 'USR_ELSEWHERE',
            subject: 'sub-elsewhere',
            issuer: 'http://elsewhere.invalid/realms/rasta',
          }),
          async () => {
            const fresh = await strict.approvals.get(t.step.approvalId);
            return strict.approvals.decide(t.step.approvalId, {
              decision: 'GRANT',
              expectedVersion: fresh.version,
            });
          },
        ),
      );
      expect(error.code).toBe('ACTOR_IDENTITY_UNKNOWN');
    });
  });

  // -------------------------------------------------------------------------------------------

  describe('time of check, time of use: a stale approval executes nothing', () => {
    it('a tender changed after the approval is 409 APPROVAL_STALE, nothing is published, and the next call asks again', async () => {
      const { a, tenderId, version } = await draft();
      await asAdmin(a, () => approvePublication(w, tenderId, { expectedVersion: version }));
      const approved = await asAdmin(a, () =>
        w.tenderApprovals.listForTender(tenderId, { limit: 5 }),
      );
      expect(approved.items[0]!.status).toBe('APPROVED');

      // The tender changes (its version moves) after the approval was given.
      await asAdmin(a, () =>
        w.tenders.update(tenderId, { expectedVersion: version, title: 'Edited' }),
      );

      const error = await codeOf(publish(a, tenderId, version + 1));
      expect(error.code).toBe('CONFLICT');
      expect(error.message).toContain('APPROVAL_STALE');
      expect((await tenderState(a, tenderId)).status).toBe('DRAFT');
      expect(await requestRow(approved.items[0]!.id)).toMatchObject({
        endedReason: 'STALE',
        consumedAt: null,
      });
      expect((await outboxFor(w.prisma, a)).some((r) => r.eventName === 'TENDER_PUBLISHED')).toBe(
        false,
      );
      expect(await logOf(a, tenderId)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ action: 'STALE', outcome: 'GRANTED' }),
          expect.objectContaining({
            action: 'REQUEST',
            outcome: 'REFUSED',
            refusalCode: 'APPROVAL_STALE',
          }),
        ]),
      );
      // Asked again, a new round is opened on the new version.
      const next = requested(await publish(a, tenderId, version + 1));
      expect(next).toMatchObject({ round: 2, status: 'PENDING', tenderVersion: version + 1 });
    });

    it('an approver who finds the tender changed does not grant: the request ends STALE and the step is not granted', async () => {
      const { a, tenderId, version } = await draft();
      await ensureGatePolicy(w, a, 'tender.publication');
      const request = requested(await publish(a, tenderId, version));
      await asAdmin(a, () =>
        w.tenders.update(tenderId, { expectedVersion: version, title: 'Edited' }),
      );

      const error = await codeOf(decide(a, request.steps[0]!.approvalId));
      expect(error.code).toBe('CONFLICT');
      expect(error.message).toContain('APPROVAL_STALE');
      expect(await requestRow(request.id)).toMatchObject({ endedReason: 'STALE' });
      expect((await stepRows(tenderId, 'tender.publication'))[0]!.status).toBe('SUPERSEDED');
    });

    it('an award approved for one bid is not executed for another: the request ends STALE', async () => {
      const t = await evaluatedTender(w, organizations, { count: 2 });
      await asAdmin(t.owner, () => approveAward(w, t.tenderId, { bidId: t.bids[0]!.bidId }));
      const error = await codeOf(
        asAdmin(t.owner, () =>
          w.award.award(t.tenderId, {
            bidId: t.bids[1]!.bidId,
            justification: 'A different choice',
          }),
        ),
      );
      expect(error.message).toContain('APPROVAL_STALE');
      expect(
        await runUnscoped('the suite counts awards', () =>
          w.prisma.client.tenderAward.count({ where: { tenderId: t.tenderId } }),
        ),
      ).toBe(0);
      // The justification is part of what was approved too.
      await asAdmin(t.owner, () =>
        approveAward(w, t.tenderId, { bidId: t.bids[1]!.bidId, justification: 'First reason' }),
      );
      const other = await codeOf(
        asAdmin(t.owner, () =>
          w.award.award(t.tenderId, { bidId: t.bids[1]!.bidId, justification: 'Another reason' }),
        ),
      );
      expect(other.message).toContain('APPROVAL_STALE');
    });

    it('a cancellation approved for one reason is not executed for another', async () => {
      const { a, tenderId, version } = await draft();
      const body = { expectedVersion: version, reason: 'Funding was withdrawn' };
      await asAdmin(a, () => approveCancellation(w, tenderId, body));
      const error = await codeOf(
        asAdmin(a, () =>
          w.tenders.cancel(tenderId, {
            ...body,
            reason: 'Something else entirely',
            reasonCode: 'OWNER_REQUEST',
          }),
        ),
      );
      expect(error.message).toContain('APPROVAL_STALE');
      expect((await tenderState(a, tenderId)).status).toBe('DRAFT');
    });

    it('a pending request that no longer matches is replaced by a new one, not executed', async () => {
      const { a, owner, tenderId, bids } = await (async () => {
        const t = await evaluatedTender(w, organizations, { count: 2 });
        return { ...t, a: t.owner };
      })();
      await ensureGatePolicy(w, a, 'tender.award');
      const first = requested(
        await asAdmin(a, () => w.award.award(tenderId, { bidId: bids[0]!.bidId })),
      );
      const second = requested(
        await asAdmin(owner, () =>
          w.award.award(tenderId, { bidId: bids[1]!.bidId, justification: 'Changed my mind' }),
        ),
      );
      expect(second.id).not.toBe(first.id);
      expect(await requestRow(first.id)).toMatchObject({ endedReason: 'STALE' });
      expect(await requestRow(second.id)).toMatchObject({
        endedReason: null,
        bidId: bids[1]!.bidId,
      });
    });
  });

  // -------------------------------------------------------------------------------------------

  describe('an approval is used once, with its execution, and by nothing else', () => {
    it('is consumed in the transaction that publishes: the request, the log and the event say so', async () => {
      const { a, tenderId, version } = await draft();
      const user = newUserId();
      await asAdmin(a, () => approvePublication(w, tenderId, { expectedVersion: version }));
      const done = await publish(a, tenderId, version, user);
      expect(done.executed).toBe(true);

      const [request] = (
        await asAdmin(a, () => w.tenderApprovals.listForTender(tenderId, { limit: 5 }))
      ).items;
      expect(request).toMatchObject({ status: 'CONSUMED' });
      const row = await requestRow(request!.id);
      expect(row).toMatchObject({ consumedBy: user, endedAt: null });
      expect(row.consumedTxid).not.toBeNull();
      expect(row.consumedAt).toBeInstanceOf(Date);
      expect((await logOf(a, tenderId)).map((r) => `${r.action}:${r.outcome}`)).toEqual([
        'REQUEST:GRANTED',
        'GRANT:GRANTED',
        'EXECUTE:GRANTED',
      ]);
      const published = (await outboxFor(w.prisma, a)).find(
        (r) => r.eventName === 'TENDER_PUBLISHED',
      )!;
      expect(payloadOf(published)).toMatchObject({ approvalRequestId: request!.id });
      expect((await actionEvents(a, tenderId)).map((e) => e.action)).toEqual([
        'REQUEST',
        'GRANT',
        'EXECUTE',
      ]);
    });

    it('cannot be used twice: the second execution is refused, and so is any write to a used request', async () => {
      const { a, tenderId, version } = await draft();
      await asAdmin(a, () => approvePublication(w, tenderId, { expectedVersion: version }));
      await publish(a, tenderId, version);
      expect((await codeOf(publish(a, tenderId, version))).code).toBe('OPTIMISTIC_LOCK_FAILED');
      expect(
        (await outboxFor(w.prisma, a)).filter((r) => r.eventName === 'TENDER_PUBLISHED'),
      ).toHaveLength(1);

      const [request] = (
        await asAdmin(a, () => w.tenderApprovals.listForTender(tenderId, { limit: 5 }))
      ).items;
      await expect(
        sql(
          `UPDATE "tender_approval_request" SET "consumed_by" = 'USR_X' WHERE "id" = '${request!.id}'`,
        ),
      ).rejects.toThrow(/ck_tender_approval_request_final/);
      await expect(
        sql(
          `UPDATE "tender_approval_request" SET "ended_at" = now(), "ended_reason" = 'STALE', "consumed_at" = NULL, "consumed_by" = NULL, "consumed_txid" = NULL WHERE "id" = '${request!.id}'`,
        ),
      ).rejects.toThrow(/ck_tender_approval_request_final/);
      await expect(
        sql(`DELETE FROM "tender_approval_request" WHERE "id" = '${request!.id}'`),
      ).rejects.toThrow(/ck_tender_approval_request_final/);
    });

    it('two executions of one approval at once are one publication, one use and one event', async () => {
      const { a, tenderId, version } = await draft();
      await asAdmin(a, () => approvePublication(w, tenderId, { expectedVersion: version }));
      const results = await Promise.allSettled([
        publish(a, tenderId, version),
        publish(a, tenderId, version),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(
        (results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason,
      ).toMatchObject({
        code: 'OPTIMISTIC_LOCK_FAILED',
      });
      expect(
        (await outboxFor(w.prisma, a)).filter((r) => r.eventName === 'TENDER_PUBLISHED'),
      ).toHaveLength(1);
      expect((await logOf(a, tenderId)).filter((r) => r.action === 'EXECUTE')).toHaveLength(1);
      expect(
        await runUnscoped('the suite counts uses', () =>
          w.prisma.client.tenderApprovalRequest.count({
            where: { tenderId, consumedAt: { not: null } },
          }),
        ),
      ).toBe(1);
    });

    it('the database refuses to use a request that is not approved, and a status change with no approval behind it', async () => {
      const { a, tenderId, version } = await draft();
      await ensureGatePolicy(w, a, 'tender.publication');
      const request = requested(await publish(a, tenderId, version));
      // Pending: no step granted, so it cannot be used.
      await expect(
        sql(
          `UPDATE "tender_approval_request" SET "consumed_at" = now(), "consumed_by" = 'USR_X' WHERE "id" = '${request.id}'`,
        ),
      ).rejects.toThrow(/ck_tender_approval_request_consume/);
      // What the request is about never changes.
      await expect(
        sql(
          `UPDATE "tender_approval_request" SET "tender_version" = 9 WHERE "id" = '${request.id}'`,
        ),
      ).rejects.toThrow(/ck_tender_approval_request_immutable/);
      // A tender does not become CANCELLED (or PUBLISHED, or AWARDED) without a request used in the transaction.
      await expect(
        sql(
          `UPDATE "tender" SET "status" = 'CANCELLED', "status_reason" = 'by hand', "status_reason_code" = 'OWNER_REQUEST' WHERE "id" = '${tenderId}'`,
        ),
      ).rejects.toThrow(/ck_tender_status_approved/);
      expect((await tenderState(a, tenderId)).status).toBe('DRAFT');
    });

    it('the database refuses a request made on a version the tender is not on, and one for a state the command cannot act on', async () => {
      const { a, tenderId, version } = await draft();
      const project = (await tenderState(a, tenderId)).projectId;
      const insert = (over: Record<string, string>) =>
        sql(
          `INSERT INTO "tender_approval_request" ("id", "organization_id", "tender_id", "project_id", "workflow_key", "round", "tender_version", "reason", "reason_code", "requested_by", "requested_at", "requested_correlation_id")
           VALUES ('TAR_X${Math.random().toString(36).slice(2, 8)}', '${a}', '${tenderId}', '${project}', '${over.workflow ?? 'tender.cancellation'}', 1, ${over.version ?? version}, 'r', '${over.code ?? 'OWNER_REQUEST'}', 'USR_X', now(), 'c')`,
        );
      await expect(insert({ version: String(version + 5) })).rejects.toThrow(
        /ck_tender_approval_request_version/,
      );
      await expect(insert({ code: 'NO_QUALIFIED_BID' })).rejects.toThrow(
        /ck_tender_approval_request_state/,
      );
      // A request with no steps does not commit.
      await expect(insert({})).rejects.toThrow(/ck_tender_approval_request_steps/);
    });
  });

  // -------------------------------------------------------------------------------------------

  describe('races', () => {
    it('two approvals of one step at once are one grant and a refusal', async () => {
      const { a, tenderId, version } = await draft();
      await ensureGatePolicy(w, a, 'tender.publication');
      const request = requested(await publish(a, tenderId, version));
      const step = request.steps[0]!;
      const fresh = await asApprover(a, () => w.approvals.get(step.approvalId));

      // Both reach for the tender row while another transaction holds it: they queue, and run one by one.
      let release!: () => void;
      let holding!: () => void;
      const mayRelease = new Promise<void>((resolve) => (release = resolve));
      const held = new Promise<void>((resolve) => (holding = resolve));
      const holder = w.prisma.client.$transaction(async (tx) => {
        await tx.$queryRawUnsafe(`SELECT "id" FROM "tender" WHERE "id" = $1 FOR UPDATE`, tenderId);
        holding();
        await mayRelease;
      });
      await held;
      const grant = () =>
        asApprover(a, () =>
          w.approvals.decide(step.approvalId, {
            decision: 'GRANT',
            expectedVersion: fresh.version,
          }),
        );
      const both = Promise.allSettled([grant(), grant()]);
      await untilASessionWaitsOnALock(w.prisma);
      release();
      await holder;
      const results = await both;

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(
        (results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason,
      ).toMatchObject({
        code: expect.stringMatching(/OPTIMISTIC_LOCK_FAILED|BUSINESS_RULE_VIOLATION/),
      });
      expect((await stepRows(tenderId, 'tender.publication'))[0]!.status).toBe('GRANTED');
      expect(
        (await logOf(a, tenderId)).filter((r) => r.action === 'GRANT' && r.outcome === 'GRANTED'),
      ).toHaveLength(1);
    });

    it('an approval against a change of the tender: whichever commits first, what was changed is never published on the old approval', async () => {
      const { a, tenderId, version } = await draft();
      await ensureGatePolicy(w, a, 'tender.publication');
      const request = requested(await publish(a, tenderId, version));

      let release!: () => void;
      let holding!: () => void;
      const mayRelease = new Promise<void>((resolve) => (release = resolve));
      const held = new Promise<void>((resolve) => (holding = resolve));
      const holder = w.prisma.client.$transaction(async (tx) => {
        await tx.$queryRawUnsafe(`SELECT "id" FROM "tender" WHERE "id" = $1 FOR UPDATE`, tenderId);
        holding();
        await mayRelease;
      });
      await held;
      const both = Promise.allSettled([
        decide(a, request.steps[0]!.approvalId),
        asAdmin(a, () => w.tenders.update(tenderId, { expectedVersion: version, title: 'Edited' })),
      ]);
      await untilASessionWaitsOnALock(w.prisma);
      release();
      await holder;
      const [decision, update] = await both;

      expect(update.status).toBe('fulfilled');
      // Never both: either the change came first (the decision found it stale and did not grant), or the
      // grant came first and the command, on the old approval, finds the version moved.
      const after = await asAdmin(a, () => w.tenders.get(tenderId));
      const error = await codeOf(publish(a, tenderId, after.version));
      if (decision.status === 'rejected') {
        expect((decision as PromiseRejectedResult).reason).toMatchObject({ code: 'CONFLICT' });
      }
      expect(['CONFLICT', undefined]).toContain(error.code);
      const row = await requestRow(request.id);
      if (row.endedReason === null && decision.status === 'fulfilled') {
        // Granted before the change, never ended: the stale check is the command's.
        expect((await asAdmin(a, () => w.tenders.get(tenderId))).status).toBe('DRAFT');
      }
      expect((await tenderState(a, tenderId)).title).toBe('Edited');
      expect(
        (await outboxFor(w.prisma, a)).filter((r) => r.eventName === 'TENDER_PUBLISHED'),
      ).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------------------------

  describe('cancellation', () => {
    it('is gated for every live tender, a DRAFT too: no policy, no cancellation', async () => {
      const { a, tenderId, version } = await draft();
      const error = await codeOf(
        asAdmin(a, () =>
          w.tenders.cancel(tenderId, {
            expectedVersion: version,
            reason: 'Funding was withdrawn',
            reasonCode: 'OWNER_REQUEST',
          }),
        ),
      );
      expect(error.message).toContain('APPROVAL_POLICY_REQUIRED');
      expect((await tenderState(a, tenderId)).status).toBe('DRAFT');
    });

    it('NO_QUALIFIED_BID is for an EVALUATING tender in which no bid was qualified, and only then', async () => {
      const t = await evaluatingTender(w, organizations, 2);
      const version = (await tenderState(t.owner, t.tenderId)).version;
      const refused = async () =>
        codeOf(
          asAdmin(t.owner, () =>
            w.tenders.cancel(t.tenderId, {
              expectedVersion: version,
              reason: 'No bid qualified',
              reasonCode: 'NO_QUALIFIED_BID',
            }),
          ),
        );
      await ensureGatePolicy(w, t.owner, 'tender.cancellation');
      // Opened bids not yet decided: one qualified bid makes the reason untrue.
      await asAdmin(t.owner, () =>
        w.evaluation.qualify(t.tenderId, t.bids[0]!.bidId, { decision: 'QUALIFIED' }),
      );
      expect((await refused()).message).toContain('NO_QUALIFIED_BID');
    });

    it('with every bid disqualified, the owner cancels with NO_QUALIFIED_BID and the event carries the closed code', async () => {
      const t = await evaluatingTender(w, organizations, 2);
      for (const bid of t.bids) {
        await asAdmin(t.owner, () =>
          w.evaluation.qualify(t.tenderId, bid.bidId, {
            decision: 'DISQUALIFIED',
            reasonCode: 'NOT_ELIGIBLE',
            reasonText: 'Licence expired',
          }),
        );
      }
      const version = (await tenderState(t.owner, t.tenderId)).version;
      const body = {
        expectedVersion: version,
        reason: 'No bid qualified',
        reasonCode: 'NO_QUALIFIED_BID' as const,
      };
      await asAdmin(t.owner, () => approveCancellation(w, t.tenderId, body));
      const done = await asAdmin(t.owner, () => w.tenders.cancel(t.tenderId, body));
      expect(done.executed).toBe(true);
      expect((await tenderState(t.owner, t.tenderId)).statusReasonCode).toBe('NO_QUALIFIED_BID');
      const event = (await outboxFor(w.prisma, t.owner)).find(
        (r) => r.eventName === 'TENDER_CANCELLED',
      )!;
      expect(payloadOf(event)).toMatchObject({
        reasonCode: 'NO_QUALIFIED_BID',
        from: 'EVALUATING',
      });
    });
  });

  // -------------------------------------------------------------------------------------------

  // -------------------------------------------------------------------------------------------
  // Review round 1 (#208)

  describe('the database boundary, as the runtime role (finding 1)', () => {
    const ownTenderRow = (a: string, tenderId: string) =>
      runUnscoped('the suite reads a tender', () =>
        w.prisma.client.tender.findFirstOrThrow({ where: { organizationId: a, id: tenderId } }),
      );

    const insertTender = async (a: string, tenderId: string, status: string) => {
      const row = await ownTenderRow(a, tenderId);
      return runUnscoped('the suite inserts a tender as the runtime role', () =>
        w.prisma.client.tender.create({
          data: {
            id: `TND_INS_${status}_${Math.random().toString(36).slice(2, 8)}`,
            organizationId: a,
            projectId: row.projectId,
            title: 'Inserted',
            scopeOfWork: 'Inserted',
            status: status as 'DRAFT',
            statusChangedAt: new Date(),
            statusChangedBy: 'USR_X',
            createdAt: new Date(),
            createdBy: 'USR_X',
            createdCorrelationId: 'c',
            updatedAt: new Date(),
            updatedBy: 'USR_X',
          },
        }),
      );
    };

    it('a tender is inserted only as a DRAFT: PUBLISHED, AWARDED and CANCELLED are refused, DRAFT is accepted', async () => {
      const { a, tenderId } = await draft();
      for (const status of ['PUBLISHED', 'AWARDED', 'CANCELLED']) {
        await expect(insertTender(a, tenderId, status)).rejects.toThrow(/ck_tender_insert_draft/);
      }
      await expect(insertTender(a, tenderId, 'DRAFT')).resolves.toMatchObject({ status: 'DRAFT' });
    });

    it('a request is not inserted already used or ended, so no approval is written ready-made', async () => {
      const { a, tenderId, version } = await draft();
      const project = (await tenderState(a, tenderId)).projectId;
      const insert = (columns: string, values: string) =>
        sql(
          `INSERT INTO "tender_approval_request" ("id", "organization_id", "tender_id", "project_id", "workflow_key", "round", "tender_version", "reason", "reason_code", "requested_by", "requested_at", "requested_correlation_id", ${columns})
           VALUES ('TAR_PRE_${Math.random().toString(36).slice(2, 8)}', '${a}', '${tenderId}', '${project}', 'tender.cancellation', 1, ${version}, 'r', 'OWNER_REQUEST', 'USR_X', now(), 'c', ${values})`,
        );
      await expect(
        insert('"consumed_at", "consumed_by", "consumed_txid"', "now(), 'USR_X', 1"),
      ).rejects.toThrow(/ck_tender_approval_request_new/);
      await expect(insert('"ended_at", "ended_reason"', "now(), 'STALE'")).rejects.toThrow(
        /ck_tender_approval_request_new/,
      );
    });

    it('a step of a tender round is not inserted already decided, nor moved out of turn, nor by its requester, nor re-pointed', async () => {
      const { a, tenderId, version } = await draft();
      const first = org();
      const second = org();
      await activePolicy(
        w,
        a,
        [{ authorityOrganizationId: first }, { authorityOrganizationId: second }],
        'tender.publication',
      );
      const request = requested(await publish(a, tenderId, version, 'USR_REQUESTER'));
      const [one, two] = await stepRows(tenderId, 'tender.publication');

      // Inserted GRANTED: the step is written asked, never decided.
      await expect(
        runUnscoped('the suite inserts a decided step', () =>
          w.prisma.client.approval.create({
            data: {
              id: 'APR_FAKE',
              organizationId: a,
              projectId: one!.projectId,
              tenderId,
              workflowKey: 'tender.publication',
              round: 1,
              stepOrder: 3,
              policyId: one!.policyId,
              policyVersion: one!.policyVersion,
              approvalType: 'Fake',
              authorityOrganizationId: first,
              authorityRole: 'ORGANIZATION_ADMIN',
              authorityLabel: 'Fake',
              status: 'GRANTED',
              requestedAt: new Date(),
              decidedAt: new Date(),
              decidedBy: 'USR_X',
              createdAt: new Date(),
              createdCorrelationId: 'c',
            },
          }),
        ),
      ).rejects.toThrow(/ck_approval_tender_new/);

      // Out of turn: the second step is QUEUED and cannot jump to GRANTED.
      await expect(
        sql(
          `UPDATE "approval" SET "status" = 'GRANTED', "decided_at" = now(), "decided_by" = 'USR_X' WHERE "id" = '${two!.id}'`,
        ),
      ).rejects.toThrow(/ck_approval_tender_transition/);
      // By the person who made the request.
      await expect(
        sql(
          `UPDATE "approval" SET "status" = 'GRANTED', "decided_at" = now(), "decided_by" = 'USR_REQUESTER' WHERE "id" = '${one!.id}'`,
        ),
      ).rejects.toThrow(/ck_approval_tender_grantor/);
      // Re-pointed at an authority of one's own choosing.
      await expect(
        sql(
          `UPDATE "approval" SET "authority_organization_id" = 'ORG_MINE' WHERE "id" = '${one!.id}'`,
        ),
      ).rejects.toThrow(/ck_approval_tender_immutable/);
      expect((await stepRows(tenderId, 'tender.publication')).map((s) => s.status)).toEqual([
        'PENDING',
        'QUEUED',
      ]);
      expect(request.steps).toHaveLength(2);
    });
  });

  describe('the approver as identity-service says they are NOW (finding 2)', () => {
    const asked = async (key: 'publication' | 'award' = 'publication') => {
      if (key === 'publication') {
        const { a, tenderId, version } = await draft();
        await ensureGatePolicy(w, a, 'tender.publication');
        const request = requested(await publish(a, tenderId, version));
        return { owner: a, tenderId, step: request.steps[0]! };
      }
      const t = await evaluatedTender(w, organizations, { count: 2 });
      await ensureGatePolicy(w, t.owner, 'tender.award');
      const request = requested(
        await asAdmin(t.owner, () => w.award.award(t.tenderId, { bidId: t.bids[0]!.bidId })),
      );
      return { owner: t.owner, tenderId: t.tenderId, step: request.steps[0]! };
    };

    const grantAs = (owner: string, stepId: string, userId: string) =>
      asApprover(
        owner,
        async () =>
          w.approvals.decide(stepId, {
            decision: 'GRANT',
            expectedVersion: (await stepRowOf(stepId)).version,
          }),
        userId,
      );

    const stepRowOf = (id: string) =>
      runUnscoped('the suite reads a step', () =>
        w.prisma.client.approval.findFirstOrThrow({ where: { id } }),
      );

    const untouched = async (tenderId: string, key: GateKey) => {
      expect((await stepRows(tenderId, key))[0]!.status).toBe('PENDING');
    };

    it('a role revoked after the token was issued no longer decides: 403, nothing granted', async () => {
      const t = await asked();
      const approver = newUserId();
      w.memberships.rolesOf.set(approver, ['ORGANIZATION_USER']);
      const error = await codeOf(grantAs(t.owner, t.step.approvalId, approver));
      expect(error.code).toBe('FORBIDDEN');
      expect(error.message).toContain('no longer holds the role');
      await untouched(t.tenderId, 'tender.publication');
      expect(await logOf(t.owner, t.tenderId)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ action: 'GRANT', outcome: 'REFUSED', actorUserId: approver }),
        ]),
      );
    });

    it('a membership revoked after the token was issued no longer decides: 403', async () => {
      const t = await asked();
      const approver = newUserId();
      w.memberships.revoked.add(approver);
      const error = await codeOf(grantAs(t.owner, t.step.approvalId, approver));
      expect(error.code).toBe('FORBIDDEN');
      expect(error.message).toContain('not a member');
      await untouched(t.tenderId, 'tender.publication');
    });

    it('a CONTRACTOR role acquired after the token was issued is caught on an award: 403, nothing granted', async () => {
      const t = await asked('award');
      const approver = newUserId();
      // The token says ORGANIZATION_ADMIN; identity-service now says CONTRACTOR as well.
      w.memberships.rolesOf.set(approver, ['ORGANIZATION_ADMIN', 'CONTRACTOR']);
      const error = await codeOf(grantAs(t.owner, t.step.approvalId, approver));
      expect(error.code).toBe('FORBIDDEN');
      expect(error.message).toContain('CONTRACTOR');
      await untouched(t.tenderId, 'tender.award');
    });

    it('identity-service unreachable: 502/504, nothing decided, nothing granted or ended', async () => {
      const t = await asked();
      const approver = newUserId();
      w.memberships.failure = RastaError.upstreamUnavailable('identity-service');
      try {
        const error = await codeOf(grantAs(t.owner, t.step.approvalId, approver));
        expect(error.code).toBe('UPSTREAM_UNAVAILABLE');
      } finally {
        w.memberships.failure = undefined;
      }
      await untouched(t.tenderId, 'tender.publication');
      expect(
        (await logOf(t.owner, t.tenderId)).filter(
          (r) => r.action === 'GRANT' && r.outcome === 'GRANTED',
        ),
      ).toHaveLength(0);
      expect(
        await runUnscoped('the suite reads the request', () =>
          w.prisma.client.tenderApprovalRequest.count({
            where: { tenderId: t.tenderId, endedAt: null },
          }),
        ),
      ).toBe(1);
    });
  });

  describe('the detail of an award approval is read under the rules of deciding it (finding 3)', () => {
    const asked = async (on: Wiring = w) => {
      const t = await evaluatedTender(on, organizations, { count: 2 });
      await ensureGatePolicy(on, t.owner, 'tender.award');
      const request = requested(
        await asAdmin(t.owner, () => on.award.award(t.tenderId, { bidId: t.bids[0]!.bidId })),
      );
      return { ...t, stepId: request.steps[0]!.approvalId };
    };
    const readAs = (
      on: Wiring,
      owner: string,
      stepId: string,
      userId: string,
      role = 'ORGANIZATION_ADMIN',
    ) => asApprover(owner, () => on.approvals.get(stepId), userId, role);
    const refusedReads = async (on: Wiring, owner: string, tenderId: string) =>
      (await on.tenderApprovalRepository.log(on.prisma.client, owner, tenderId)).filter(
        (r) => r.action === 'READ' && r.outcome === 'REFUSED',
      );

    it('a role the bid side excludes — on the token or acquired since — reads no bid: 403, audited', async () => {
      const t = await asked();
      const viaToken = await codeOf(readAs(w, t.owner, t.stepId, newUserId(), 'SYSTEM_ADMIN'));
      expect(viaToken.code).toBe('FORBIDDEN');
      const contractor = newUserId();
      w.memberships.rolesOf.set(contractor, ['ORGANIZATION_ADMIN', 'CONTRACTOR']);
      const viaLive = await codeOf(readAs(w, t.owner, t.stepId, contractor));
      expect(viaLive.code).toBe('FORBIDDEN');
      expect(await refusedReads(w, t.owner, t.tenderId)).toHaveLength(2);
      // Somebody who may is shown it.
      const seen = await readAs(w, t.owner, t.stepId, newUserId());
      expect(seen.request?.bid).toMatchObject({ bidId: t.bids[0]!.bidId });
    });

    it('a membership revoked since the token was issued reads nothing', async () => {
      const t = await asked();
      const gone = newUserId();
      w.memberships.revoked.add(gone);
      expect((await codeOf(readAs(w, t.owner, t.stepId, gone))).code).toBe('FORBIDDEN');
    });

    it('with AWARDER_NOT_EVALUATOR on, an evaluator reads nothing (403) and a person the records cannot tell from them neither (422)', async () => {
      const t = await asked(strict);
      const evaluator = await codeOf(readAs(strict, t.owner, t.stepId, t.evaluator));
      expect(evaluator.code).toBe('FORBIDDEN');
      expect(evaluator.message).toContain('APPROVER_IS_EVALUATOR');
      const unknown = await codeOf(
        runWithContext(
          context({
            organizationId: t.owner,
            organizationIds: [t.owner],
            roles: ['ORGANIZATION_ADMIN'],
            userId: 'USR_ELSEWHERE_R',
            subject: 'sub-elsewhere-r',
            issuer: 'http://elsewhere.invalid/realms/rasta',
          }),
          () => strict.approvals.get(t.stepId),
        ),
      );
      expect(unknown.code).toBe('ACTOR_IDENTITY_UNKNOWN');
      expect(await refusedReads(strict, t.owner, t.tenderId)).toHaveLength(2);
      // Another organization learns nothing at all.
      expect((await codeOf(asApprover(org(), () => strict.approvals.get(t.stepId)))).code).toBe(
        'NOT_FOUND',
      );
    });
  });

  describe('a stale approval is resolved as stale, whichever version the command was sent with (finding 4)', () => {
    const staleRefusal = async (a: string, tenderId: string) => {
      expect(await logOf(a, tenderId)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ action: 'STALE', outcome: 'GRANTED' }),
          expect.objectContaining({
            action: 'REQUEST',
            outcome: 'REFUSED',
            refusalCode: 'APPROVAL_STALE',
          }),
        ]),
      );
      const events = await actionEvents(a, tenderId);
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ action: 'STALE' }),
          expect.objectContaining({
            action: 'REQUEST',
            outcome: 'REFUSED',
            refusalCode: 'APPROVAL_STALE',
          }),
        ]),
      );
    };

    it('publish, sent with the approved version after the tender was edited: 409 APPROVAL_STALE, the request ends, audited and evented', async () => {
      const { a, tenderId, version } = await draft();
      await asAdmin(a, () => approvePublication(w, tenderId, { expectedVersion: version }));
      const approved = (
        await asAdmin(a, () => w.tenderApprovals.listForTender(tenderId, { limit: 5 }))
      ).items[0]!;
      await asAdmin(a, () =>
        w.tenders.update(tenderId, { expectedVersion: version, title: 'Edited' }),
      );

      const error = await codeOf(publish(a, tenderId, version));
      expect(error.code).toBe('CONFLICT');
      expect(error.message).toContain('APPROVAL_STALE');
      expect(await requestRow(approved.id)).toMatchObject({ endedReason: 'STALE' });
      expect((await tenderState(a, tenderId)).status).toBe('DRAFT');
      await staleRefusal(a, tenderId);
    });

    it('a wrong version with no stale request behind it stays a plain optimistic-lock refusal', async () => {
      const { a, tenderId, version } = await draft();
      await ensureGatePolicy(w, a, 'tender.publication');
      requested(await publish(a, tenderId, version));
      const error = await codeOf(publish(a, tenderId, version + 7));
      expect(error.code).toBe('OPTIMISTIC_LOCK_FAILED');
      // The request made on the current version is still alive.
      expect(
        (await asAdmin(a, () => w.tenderApprovals.listForTender(tenderId, { limit: 5 }))).items[0]!
          .status,
      ).toBe('PENDING');
    });

    it('cancel, sent with the approved version after the tender was edited: the same', async () => {
      const { a, tenderId, version } = await draft();
      const body = { expectedVersion: version, reason: 'Funding was withdrawn' };
      await asAdmin(a, () => approveCancellation(w, tenderId, body));
      await asAdmin(a, () =>
        w.tenders.update(tenderId, { expectedVersion: version, title: 'Edited' }),
      );

      const error = await codeOf(
        asAdmin(a, () => w.tenders.cancel(tenderId, { ...body, reasonCode: 'OWNER_REQUEST' })),
      );
      expect(error.code).toBe('CONFLICT');
      expect(error.message).toContain('APPROVAL_STALE');
      expect((await tenderState(a, tenderId)).status).toBe('DRAFT');
      await staleRefusal(a, tenderId);
    });

    it('award, after the tender moved on from the approved version: the same', async () => {
      const t = await evaluatedTender(w, organizations, { count: 2 });
      await asAdmin(t.owner, () => approveAward(w, t.tenderId, { bidId: t.bids[0]!.bidId }));
      await sql(`UPDATE "tender" SET "version" = "version" + 1 WHERE "id" = '${t.tenderId}'`);

      const error = await codeOf(
        asAdmin(t.owner, () => w.award.award(t.tenderId, { bidId: t.bids[0]!.bidId })),
      );
      expect(error.code).toBe('CONFLICT');
      expect(error.message).toContain('APPROVAL_STALE');
      expect(
        await runUnscoped('the suite counts awards', () =>
          w.prisma.client.tenderAward.count({ where: { tenderId: t.tenderId } }),
        ),
      ).toBe(0);
      // The request ends and says so (log, event); the refusal itself is audited as every refusal of an award
      // is (PR 10): a REFUSED row in the bid access log with its closed code, and BID_ACCESSED.
      expect(await logOf(t.owner, t.tenderId)).toEqual(
        expect.arrayContaining([expect.objectContaining({ action: 'STALE', outcome: 'GRANTED' })]),
      );
      expect((await actionEvents(t.owner, t.tenderId)).map((e) => e.action)).toContain('STALE');
      const access = await runUnscoped('the suite reads the access log', () =>
        w.prisma.client.bidAccessLog.findMany({
          where: { tenderId: t.tenderId, purpose: 'AWARD_TENDER', outcome: 'REFUSED' },
        }),
      );
      expect(access.map((r) => r.refusalCode)).toEqual(['APPROVAL_STALE']);
    });
  });

  it('awards through the gate: asked, approved by others, executed, and the approval used', async () => {
    const t = await evaluatedTender(w, organizations, { count: 2 });
    const view = await asAdmin(t.owner, () =>
      awardApproved(w, t.tenderId, { bidId: t.bids[0]!.bidId }),
    );
    expect(view).toMatchObject({ status: 'AWARDED', bidId: t.bids[0]!.bidId });
    const [request] = (
      await asAdmin(t.owner, () => w.tenderApprovals.listForTender(t.tenderId, { limit: 5 }))
    ).items;
    expect(request).toMatchObject({ workflowKey: 'tender.award', status: 'CONSUMED' });
    const awarded = (await outboxFor(w.prisma, t.owner)).find(
      (r) => r.eventName === 'TENDER_AWARDED',
    )!;
    expect(payloadOf(awarded)).toMatchObject({ approvalRequestId: request!.id });
    // A direct award row with no approval behind it is not accepted either.
    await expect(
      sql(
        `UPDATE "tender_approval_request" SET "consumed_at" = NULL WHERE "id" = '${request!.id}'`,
      ),
    ).rejects.toThrow(/ck_tender_approval_request_final/);
  });

  it('publishes through the gate with the real helper, end to end', async () => {
    const { a, tenderId, version } = await draft();
    const view = await asAdmin(a, () => publishApproved(w, tenderId, { expectedVersion: version }));
    expect(view.status).toBe('PUBLISHED');
  });
});
