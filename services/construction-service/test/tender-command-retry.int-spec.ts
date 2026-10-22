import { randomUUID } from 'node:crypto';
import { runUnscoped } from '@rasta/nest-common';
import type { CriterionInput } from '../src/tender/criteria.dto';
import type { TenderApprovalRequestView } from '../src/tender/tender-approval.dto';
import {
  approveAward,
  approvePublication,
  approveCancellation,
  approvedProject,
  asAdmin,
  asApprover,
  asBidder,
  bidContent,
  bidKey,
  cancelApproved,
  cleanup,
  ensureGatePolicy,
  evaluatedTender,
  evaluatingTender,
  grantRequest,
  newOrganizationId,
  newUserId,
  outboxFor,
  publishedForBids,
  qualify,
  testEnv,
  wire,
  type GateKey,
  type Wiring,
} from './helpers';

/**
 * Task 060: every tender command a retry could make do something new is retry-safe, against
 * PostgreSQL.
 *
 * (b) Publishing, cancelling and awarding (behind the approval gate), and inviting, keep their first
 * answer by `Idempotency-Key`: a retry whose first attempt committed but whose answer was lost is
 * that answer — a round rejected since included — and opens no new round, writes no second event and
 * no second audit row. The same key with another body, or from another person, is 409
 * `IDEMPOTENCY_KEY_REUSED`; another organization never meets the key. (The opening's three are in
 * `tender-open.int-spec.ts`.)
 *
 * (a) The rest answer their own repeat without writing, or refuse it by compare-and-set: proven by
 * sending each a second time.
 */

const WHOLE: CriterionInput[] = [
  { code: 'PRICE', label: 'Price', weightBp: 6000, scoringMethod: 'MANUAL_SCORE', maxScore: 100 },
  { code: 'LICENCE', label: 'Licence', weightBp: 4000, scoringMethod: 'PASS_FAIL', maxScore: 1 },
];
const DAY = 24 * 60 * 60 * 1000;

describe('tender commands are retry-safe (task 060)', () => {
  let w: Wiring;
  const organizations: string[] = [];

  const org = (): string => {
    const id = newOrganizationId();
    organizations.push(id);
    return id;
  };
  const newKey = () => `retry-${randomUUID()}`;

  /** A DRAFT tender of a fresh organization, ready to publish. */
  async function draft(visibility: 'PUBLIC' | 'RESTRICTED' = 'PUBLIC') {
    const a = org();
    const project = await approvedProject(w, a);
    const tender = await asAdmin(a, () =>
      w.tenders.create(project.id, {
        title: 'Road resurfacing',
        scopeOfWork: 'Two kilometres of the main road',
        procurementNature: 'FORMAL_TENDER',
        visibility,
        bidOpeningAt: new Date(Date.now() + DAY).toISOString(),
        bidClosingAt: new Date(Date.now() + 30 * DAY).toISOString(),
      }),
    );
    const set = await asAdmin(a, () =>
      w.criteria.setCriteria(tender.id, { expectedVersion: tender.version, criteria: WHOLE }),
    );
    return { a, tenderId: tender.id, version: set.version };
  }

  const requested = (answer: { executed: boolean } & Record<string, unknown>) => {
    if (answer.executed) throw new Error('expected a request, the command was executed');
    return answer.request as TenderApprovalRequestView;
  };

  /** Rejects the request's first step as a person of its authority. */
  const reject = async (request: TenderApprovalRequestView) => {
    const step = request.steps[0]!;
    const fresh = await asApprover(step.authorityOrganizationId, () =>
      w.approvals.get(step.approvalId),
    );
    await asApprover(step.authorityOrganizationId, () =>
      w.approvals.decide(step.approvalId, {
        decision: 'REJECT',
        reason: 'Not on these terms',
        expectedVersion: fresh.version,
      }),
    );
  };

  const requestsOf = (tenderId: string, workflowKey: GateKey) =>
    runUnscoped('the suite reads the requests', () =>
      w.prisma.client.tenderApprovalRequest.findMany({ where: { tenderId, workflowKey } }),
    );

  const logOf = (a: string, tenderId: string) =>
    w.tenderApprovalRepository.log(w.prisma.client, a, tenderId);

  const eventsOf = async (owner: string, name: string, tenderId: string) =>
    (await outboxFor(w.prisma, owner)).filter(
      (row) => row.eventName === name && row.aggregateId === tenderId,
    );

  const codeOf = async (call: Promise<unknown>) =>
    ((await call.then(
      () => undefined,
      (e: unknown) => e,
    )) ?? {}) as { code?: string; message?: string };

  beforeAll(() => {
    w = wire(testEnv({ CONSTRUCTION_TENDER_OPEN_FOUR_EYES: 'false' }));
  });

  afterAll(async () => {
    await cleanup(w.prisma, organizations);
    await w.close();
  });

  // -- (b) publish ---------------------------------------------------------------------------

  describe('publishing', () => {
    const publish = (a: string, tenderId: string, version: number, key?: string, user?: string) =>
      asAdmin(a, () => w.publication.publish(tenderId, { expectedVersion: version }, key), user);

    it('a retried request whose round was rejected meanwhile is answered that round again (202): no new round, no second REQUEST', async () => {
      const { a, tenderId, version } = await draft();
      await ensureGatePolicy(w, a, 'tender.publication');
      const key = newKey();
      const user = newUserId();
      const first = await publish(a, tenderId, version, key, user);
      const round = requested(first);
      // The answer is lost; the round is rejected from another browser; the same request is sent again.
      await reject(round);

      expect(await publish(a, tenderId, version, key, user)).toEqual(first);

      expect(await requestsOf(tenderId, 'tender.publication')).toHaveLength(1);
      expect((await logOf(a, tenderId)).filter((row) => row.action === 'REQUEST')).toHaveLength(1);
      expect((await asAdmin(a, () => w.tenders.get(tenderId))).status).toBe('DRAFT');
      // A new request — a new key — is what asks anew.
      const again = requested(await publish(a, tenderId, version, newKey(), user));
      expect(again.id).not.toBe(round.id);
      expect(again.round).toBe(round.round + 1);
    });

    it('a retried publication that was executed is answered the first answer (200): one TENDER_PUBLISHED, one EXECUTE, one key', async () => {
      const { a, tenderId, version } = await draft();
      await asAdmin(a, () => approvePublication(w, tenderId, { expectedVersion: version }));
      const key = newKey();
      const user = newUserId();
      const done = await publish(a, tenderId, version, key, user);
      expect(done.executed).toBe(true);
      const after = await asAdmin(a, () => w.tenders.get(tenderId));

      expect(await publish(a, tenderId, version, key, user)).toEqual(done);

      expect(await asAdmin(a, () => w.tenders.get(tenderId))).toEqual(after);
      expect(await eventsOf(a, 'TENDER_PUBLISHED', tenderId)).toHaveLength(1);
      expect((await logOf(a, tenderId)).filter((row) => row.action === 'EXECUTE')).toHaveLength(1);
      // Without the key the same command is refused by the version, as before: it never publishes twice.
      expect(await codeOf(publish(a, tenderId, version, undefined, user))).toMatchObject({
        code: 'OPTIMISTIC_LOCK_FAILED',
      });
    });

    it('the same key with another body, or from another person, is 409 IDEMPOTENCY_KEY_REUSED, audited; another organization never meets it', async () => {
      const { a, tenderId, version } = await draft();
      await ensureGatePolicy(w, a, 'tender.publication');
      const key = newKey();
      const user = newUserId();
      const first = requested(await publish(a, tenderId, version, key, user));

      expect(await codeOf(publish(a, tenderId, version + 1, key, user))).toMatchObject({
        code: 'IDEMPOTENCY_KEY_REUSED',
      });
      // Another person of the same organization, the same key and body: not the first person's answer.
      expect(await codeOf(publish(a, tenderId, version, key, newUserId()))).toMatchObject({
        code: 'IDEMPOTENCY_KEY_REUSED',
      });
      const refusals = (await logOf(a, tenderId)).filter((row) => row.outcome === 'REFUSED');
      expect(refusals.map((row) => `${row.action}:${row.refusalCode}`)).toEqual([
        'REQUEST:IDEMPOTENCY_KEY_REUSED',
        'REQUEST:IDEMPOTENCY_KEY_REUSED',
      ]);
      expect(await requestsOf(tenderId, 'tender.publication')).toHaveLength(1);

      // Another organization: the tender is a 404 before any key is looked at ...
      const b = await draft();
      expect(await codeOf(publish(b.a, tenderId, version, key, user))).toMatchObject({
        code: 'NOT_FOUND',
      });
      // ... and its own tender under the same key is its own request, answered for itself.
      await ensureGatePolicy(w, b.a, 'tender.publication');
      const theirs = requested(await publish(b.a, b.tenderId, b.version, key, user));
      expect(theirs.id).not.toBe(first.id);
      expect(theirs.tenderId).toBe(b.tenderId);
    });
  });

  // -- (b) cancel ----------------------------------------------------------------------------

  describe('cancelling', () => {
    const body = (version: number) => ({
      expectedVersion: version,
      reason: 'The road is no longer needed',
      reasonCode: 'OWNER_REQUEST' as const,
    });
    const cancel = (a: string, tenderId: string, version: number, key?: string, user?: string) =>
      asAdmin(a, () => w.tenders.cancel(tenderId, body(version), key), user);

    it('a retried request whose round was rejected meanwhile is answered that round again: no new round', async () => {
      const { a, tenderId, version } = await draft();
      await ensureGatePolicy(w, a, 'tender.cancellation');
      const key = newKey();
      const user = newUserId();
      const first = await cancel(a, tenderId, version, key, user);
      await reject(requested(first));

      expect(await cancel(a, tenderId, version, key, user)).toEqual(first);

      expect(await requestsOf(tenderId, 'tender.cancellation')).toHaveLength(1);
      expect((await asAdmin(a, () => w.tenders.get(tenderId))).status).toBe('DRAFT');
    });

    it('a retried cancellation that was executed is the first answer: one TENDER_CANCELLED', async () => {
      const { a, tenderId, version } = await draft();
      await asAdmin(a, () => approveCancellation(w, tenderId, body(version)));
      const key = newKey();
      const user = newUserId();
      const done = await cancel(a, tenderId, version, key, user);
      expect(done).toMatchObject({ executed: true, result: { status: 'CANCELLED' } });

      expect(await cancel(a, tenderId, version, key, user)).toEqual(done);

      expect(await eventsOf(a, 'TENDER_CANCELLED', tenderId)).toHaveLength(1);
      expect((await logOf(a, tenderId)).filter((row) => row.action === 'EXECUTE')).toHaveLength(1);
    });
  });

  // -- (b) award -----------------------------------------------------------------------------

  describe('awarding', () => {
    const award = (
      owner: string,
      tenderId: string,
      bidId: string,
      key?: string,
      user?: string,
      justification?: string,
    ) =>
      asAdmin(
        owner,
        () => w.award.award(tenderId, { bidId, ...(justification ? { justification } : {}) }, key),
        user,
      );

    it('a retried request whose round was rejected meanwhile is answered that round again: no new round', async () => {
      const { owner, tenderId, bids } = await evaluatedTender(w, organizations, { count: 2 });
      await ensureGatePolicy(w, owner, 'tender.award');
      const key = newKey();
      const user = newUserId();
      const first = await award(owner, tenderId, bids[0]!.bidId, key, user);
      await reject(requested(first));

      expect(await award(owner, tenderId, bids[0]!.bidId, key, user)).toEqual(first);

      expect(await requestsOf(tenderId, 'tender.award')).toHaveLength(1);
      // Another bid under the same key is another request.
      expect(
        await codeOf(award(owner, tenderId, bids[1]!.bidId, key, user, 'Best local record')),
      ).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
      expect(await requestsOf(tenderId, 'tender.award')).toHaveLength(1);
    });

    it('a retried award that was executed is the first answer: one award, one TENDER_AWARDED, one standing check', async () => {
      const { owner, tenderId, bids } = await evaluatedTender(w, organizations, { count: 2 });
      await asAdmin(owner, () => approveAward(w, tenderId, { bidId: bids[0]!.bidId }));
      const key = newKey();
      const user = newUserId();
      const done = await award(owner, tenderId, bids[0]!.bidId, key, user);
      expect(done).toMatchObject({ executed: true, result: { alreadyAwarded: false } });

      expect(await award(owner, tenderId, bids[0]!.bidId, key, user)).toEqual(done);

      expect(await eventsOf(owner, 'TENDER_AWARDED', tenderId)).toHaveLength(1);
      const checks = await runUnscoped('the suite counts the standing checks', () =>
        w.prisma.client.tenderAwardStandingCheck.count({ where: { tenderId } }),
      );
      expect(checks).toBe(1);
    });
  });

  // -- (b) invitations -----------------------------------------------------------------------

  describe('inviting', () => {
    it('a retried invitation is the first answer, not 409 ALREADY_EXISTS: one invitation, one TENDER_BIDDER_INVITED', async () => {
      const { a, tenderId } = await draft('RESTRICTED');
      const key = newKey();
      const user = newUserId();
      const invite = (organizationId: string, k?: string, u = user) =>
        asAdmin(a, () => w.publication.invite(tenderId, { organizationId }, k), u);
      const first = await invite('ORG_BIDDER_1', key);

      expect(await invite('ORG_BIDDER_1', key)).toEqual(first);

      expect(await eventsOf(a, 'TENDER_BIDDER_INVITED', tenderId)).toHaveLength(1);
      // Without the key it is a second request, refused as before.
      expect(await codeOf(invite('ORG_BIDDER_1'))).toMatchObject({ code: 'ALREADY_EXISTS' });
      // Another organization invited under the same key, or another person's request: refused.
      expect(await codeOf(invite('ORG_BIDDER_2', key))).toMatchObject({
        code: 'IDEMPOTENCY_KEY_REUSED',
      });
      expect(await codeOf(invite('ORG_BIDDER_1', key, newUserId()))).toMatchObject({
        code: 'IDEMPOTENCY_KEY_REUSED',
      });
      expect(await eventsOf(a, 'TENDER_BIDDER_INVITED', tenderId)).toHaveLength(1);
    });
  });

  // -- (b) after the tender moved on ---------------------------------------------------------

  describe('a retry after the tender moved on is the first answer (PR-350 r1 F2): the state is judged after the replay', () => {
    const publish = (a: string, tenderId: string, version: number, key?: string, user?: string) =>
      asAdmin(a, () => w.publication.publish(tenderId, { expectedVersion: version }, key), user);
    const cancelBody = (version: number) => ({
      expectedVersion: version,
      reason: 'The road is no longer needed',
      reasonCode: 'OWNER_REQUEST' as const,
    });
    const cancel = (a: string, tenderId: string, version: number, key?: string, user?: string) =>
      asAdmin(a, () => w.tenders.cancel(tenderId, cancelBody(version), key), user);
    const cancelNow = async (a: string, tenderId: string) => {
      const { version } = await asAdmin(a, () => w.tenders.get(tenderId));
      await asAdmin(a, () => cancelApproved(w, tenderId, cancelBody(version)));
      expect((await asAdmin(a, () => w.tenders.get(tenderId))).status).toBe('CANCELLED');
    };
    /** Everything a retry could leave behind: the gate's log (refusals included) and the outbox. */
    const traces = async (a: string, tenderId: string) => ({
      log: await logOf(a, tenderId),
      outbox: (await outboxFor(w.prisma, a)).length,
    });

    it('a publication executed (200), retried after the tender was cancelled: the first answer, no refusal, no event', async () => {
      const { a, tenderId, version } = await draft();
      await asAdmin(a, () => approvePublication(w, tenderId, { expectedVersion: version }));
      const key = newKey();
      const user = newUserId();
      const done = await publish(a, tenderId, version, key, user);
      expect(done.executed).toBe(true);
      await cancelNow(a, tenderId);
      const before = await traces(a, tenderId);

      expect(await publish(a, tenderId, version, key, user)).toEqual(done);

      expect(await traces(a, tenderId)).toEqual(before);
      expect(await eventsOf(a, 'TENDER_PUBLISHED', tenderId)).toHaveLength(1);
    });

    it('a publication asked (202), retried after the round was granted and executed: the first answer, no new round', async () => {
      const { a, tenderId, version } = await draft();
      await ensureGatePolicy(w, a, 'tender.publication');
      const key = newKey();
      const user = newUserId();
      const first = await publish(a, tenderId, version, key, user);
      await grantRequest(w, requested(first));
      expect((await publish(a, tenderId, version, newKey(), user)).executed).toBe(true);
      const before = await traces(a, tenderId);

      expect(await publish(a, tenderId, version, key, user)).toEqual(first);

      expect(await traces(a, tenderId)).toEqual(before);
      expect(await requestsOf(tenderId, 'tender.publication')).toHaveLength(1);
    });

    it('a cancellation asked (202), retried after the round was granted and executed: the first answer', async () => {
      const { a, tenderId, version } = await draft();
      await ensureGatePolicy(w, a, 'tender.cancellation');
      const key = newKey();
      const user = newUserId();
      const first = await cancel(a, tenderId, version, key, user);
      await grantRequest(w, requested(first));
      expect((await cancel(a, tenderId, version, newKey(), user)).executed).toBe(true);
      const before = await traces(a, tenderId);

      expect(await cancel(a, tenderId, version, key, user)).toEqual(first);

      expect(await traces(a, tenderId)).toEqual(before);
      expect(await eventsOf(a, 'TENDER_CANCELLED', tenderId)).toHaveLength(1);
    });

    it('an invitation retried after the tender was cancelled: the first answer (201), one TENDER_BIDDER_INVITED', async () => {
      const { a, tenderId } = await draft('RESTRICTED');
      const key = newKey();
      const user = newUserId();
      const invite = () =>
        asAdmin(
          a,
          () => w.publication.invite(tenderId, { organizationId: 'ORG_BIDDER_1' }, key),
          user,
        );
      const first = await invite();
      await cancelNow(a, tenderId);
      const before = await traces(a, tenderId);

      expect(await invite()).toEqual(first);

      expect(await traces(a, tenderId)).toEqual(before);
      expect(await eventsOf(a, 'TENDER_BIDDER_INVITED', tenderId)).toHaveLength(1);
    });

    it('an award asked (202), retried after the round was granted and the award made: the first answer, no new round', async () => {
      const { owner, tenderId, bids } = await evaluatedTender(w, organizations, { count: 2 });
      await ensureGatePolicy(w, owner, 'tender.award');
      const key = newKey();
      const user = newUserId();
      const award = (k: string) =>
        asAdmin(owner, () => w.award.award(tenderId, { bidId: bids[0]!.bidId }, k), user);
      const first = await award(key);
      await grantRequest(w, requested(first));
      expect((await award(newKey())).executed).toBe(true);
      const before = await traces(owner, tenderId);

      expect(await award(key)).toEqual(first);

      expect(await traces(owner, tenderId)).toEqual(before);
      expect(await requestsOf(tenderId, 'tender.award')).toHaveLength(1);
      expect(await eventsOf(owner, 'TENDER_AWARDED', tenderId)).toHaveLength(1);
    });
  });

  // -- (a) the commands that answer their own repeat, or refuse it ---------------------------

  describe('the rest answer their own repeat without writing, or refuse it by compare-and-set', () => {
    it('a qualification sent twice is one decision: the repeat answers it (`alreadyDecided`) and writes nothing', async () => {
      const { owner, tenderId, bids } = await evaluatingTender(w, organizations, 1);
      const evaluator = newUserId();
      const decide = () =>
        asAdmin(
          owner,
          () => w.evaluation.qualify(tenderId, bids[0]!.bidId, { decision: 'QUALIFIED' }),
          evaluator,
        );
      const first = await decide();
      const outbox = (await outboxFor(w.prisma, owner)).length;

      expect(await decide()).toEqual({ ...first, alreadyDecided: true });

      expect((await outboxFor(w.prisma, owner)).length).toBe(outbox);
      expect(await eventsOf(owner, 'BID_QUALIFIED', tenderId)).toHaveLength(1);
    });

    it('a recusal sent twice is one recusal: the repeat answers it (`alreadyRecused`) and writes nothing', async () => {
      const { owner, tenderId, bids } = await evaluatingTender(w, organizations, 1);
      const evaluator = newUserId();
      const recuse = () =>
        asAdmin(
          owner,
          () => w.evaluation.recuse(tenderId, bids[0]!.bidId, { reasonCode: 'OTHER' }),
          evaluator,
        );
      const first = await recuse();
      const outbox = (await outboxFor(w.prisma, owner)).length;

      expect(await recuse()).toEqual({ ...first, alreadyRecused: true });

      expect((await outboxFor(w.prisma, owner)).length).toBe(outbox);
      expect(await eventsOf(owner, 'BID_EVALUATOR_RECUSED', tenderId)).toHaveLength(1);
    });

    it('a completion sent twice is one completion: the repeat answers it (`alreadyEvaluated`) and writes nothing', async () => {
      const { owner, tenderId, evaluator } = await evaluatedTender(w, organizations, { count: 1 });
      const outbox = (await outboxFor(w.prisma, owner)).length;

      const again = await asAdmin(owner, () => w.evaluation.evaluate(tenderId), evaluator);

      expect(again).toMatchObject({ status: 'EVALUATED', alreadyEvaluated: true });
      expect((await outboxFor(w.prisma, owner)).length).toBe(outbox);
      expect(await eventsOf(owner, 'BIDS_EVALUATED', tenderId)).toHaveLength(1);
    });

    it('a replacement or a withdrawal of a bid sent twice is refused by its revision: one revision, one withdrawal; a withdrawal of a replaced bid withdraws nothing', async () => {
      const owner = org();
      const bidder = org();
      await qualify(w, bidder);
      const { tenderId } = await publishedForBids(w, owner);
      const contractor = newUserId();
      const as = <T>(fn: () => T) => asBidder(bidder, fn, contractor);
      const submitted = await as(() =>
        w.bids.submit(tenderId, { content: bidContent('1000') }, bidKey()),
      );
      const replace = () =>
        as(() =>
          w.bids.revise(tenderId, submitted.bidId, {
            expectedRevision: 1,
            content: bidContent('900'),
          }),
        );
      const replaced = await replace();
      expect(replaced.revision).toBe(2);

      expect(await codeOf(replace())).toMatchObject({ code: 'OPTIMISTIC_LOCK_FAILED' });
      // The withdrawal of the bid as it was before the replacement names a revision that is gone.
      expect(
        await codeOf(as(() => w.bids.withdraw(tenderId, submitted.bidId, { expectedRevision: 1 }))),
      ).toMatchObject({ code: 'OPTIMISTIC_LOCK_FAILED' });
      const withdraw = () =>
        as(() => w.bids.withdraw(tenderId, submitted.bidId, { expectedRevision: 2 }));
      expect(await withdraw()).toMatchObject({ status: 'WITHDRAWN' });
      expect((await codeOf(withdraw())).code).toMatch(
        /^(OPTIMISTIC_LOCK_FAILED|BUSINESS_RULE_VIOLATION)$/,
      );

      // On the owner's stream, as every bid event is.
      expect(await eventsOf(owner, 'BID_REVISED', tenderId)).toHaveLength(1);
      expect(await eventsOf(owner, 'BID_WITHDRAWN', tenderId)).toHaveLength(1);
    });

    it('a change of a draft, and of its criteria, sent twice is refused by the version: one change each', async () => {
      const { a, tenderId, version } = await draft();
      const update = () =>
        asAdmin(a, () =>
          w.tenders.update(tenderId, {
            expectedVersion: version,
            title: 'Road resurfacing, phase 2',
          }),
        );
      const updated = await update();
      expect(await codeOf(update())).toMatchObject({ code: 'OPTIMISTIC_LOCK_FAILED' });
      expect(await eventsOf(a, 'TENDER_UPDATED', tenderId)).toHaveLength(1);

      const criteria = () =>
        asAdmin(a, () =>
          w.criteria.setCriteria(tenderId, { expectedVersion: updated.version, criteria: WHOLE }),
        );
      expect((await criteria()).version).toBe(updated.version + 1);
      expect(await codeOf(criteria())).toMatchObject({ code: 'OPTIMISTIC_LOCK_FAILED' });
    });
  });
});
