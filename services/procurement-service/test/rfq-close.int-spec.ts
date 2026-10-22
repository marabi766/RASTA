import request from 'supertest';
import { rfqCancelledPayloadSchema, rfqClosedPayloadSchema } from '@rasta/contracts';
import { RfqRepository } from '../src/rfq/rfq.repository';
import { RfqCloseService } from '../src/rfq/rfq-close.service';
import { actor, buyer, client, key } from './api-helpers';
import {
  AFTER_READY,
  HOUR,
  barrier,
  startRfqApi,
  waitForLockWaiter,
  type RfqHarness,
} from './rfq-helpers';

/**
 * Closing an RFQ at its deadline and cancelling it (ADR-070 § 3, plan PR 6): the close only at or
 * after `quotationClosingAt` on the database clock read under the RFQ's lock — by the leased,
 * fenced close sweeper or by the buyer's issuer role, the same command, idempotent, one event; the
 * cancel from any status but AWARDED, with a closed code and a reason that never reaches an event.
 * A supplier and a third organization find nothing to close or cancel (404); another buyer role is
 * 403.
 */
describe('closing and cancelling an RFQ', () => {
  let h: RfqHarness;

  beforeAll(async () => {
    h = await startRfqApi();
  });

  afterAll(async () => {
    await h.close();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /** An RFQ issued at AFTER_READY, its deadline `hours` later. */
  async function issued(hours = 24) {
    const { organizationId, aggregation } = await h.readyAggregation();
    const deadline = new Date(AFTER_READY.getTime() + hours * HOUR);
    const body = h.issueBody(aggregation, { quotationClosingAt: deadline.toISOString() });
    const rfq = (await h.admin(organizationId).issueRfq(aggregation.id, body)).body;
    expect(rfq.status).toBe('PUBLISHED');
    return {
      organizationId,
      aggregation,
      rfq,
      deadline,
      invitees: body.invitedSupplierOrganizationIds,
    };
  }

  const status = async (organizationId: string, id: string) =>
    (await client(h.api, buyer(organizationId)).rfq(id)).body as {
      status: string;
      version: number;
    };

  it('the deadline is half-open: one millisecond before it the close is 422, at it the RFQ closes — one RFQ_CLOSED naming who', async () => {
    const { organizationId, rfq, deadline } = await issued();
    const admin = h.admin(organizationId, 'USR-CLOSER');

    h.clock.set(new Date(deadline.getTime() - 1));
    const early = await admin.closeRfq(rfq.id);
    expect(early.status).toBe(422);
    expect(early.body.details).toEqual([
      { path: 'rfqClose', code: 'QUOTATION_DEADLINE_NOT_REACHED', message: expect.any(String) },
    ]);
    expect(await status(organizationId, rfq.id)).toMatchObject({ status: 'PUBLISHED', version: 1 });

    h.clock.set(deadline);
    const closed = await admin.closeRfq(rfq.id);
    expect(closed.status).toBe(200);
    expect(closed.body).toMatchObject({
      status: 'CLOSED',
      closedAt: deadline.toISOString(),
      version: 2,
    });

    const [event, ...more] = await h.events(organizationId, 'RFQ_CLOSED');
    expect(more).toEqual([]);
    expect(rfqClosedPayloadSchema.parse(event)).toEqual({
      rfqId: rfq.id,
      organizationId,
      aggregationId: rfq.aggregationId,
      rfqVersion: 2,
      quotationClosingAt: deadline.toISOString(),
      trigger: 'MANUAL',
      closedBy: 'USR-CLOSER',
      closedAt: deadline.toISOString(),
    });
  });

  it('is idempotent: a second close — another key, another person — answers the closed RFQ, with no second event', async () => {
    const { organizationId, rfq, deadline } = await issued();
    h.clock.set(new Date(deadline.getTime() + HOUR));
    const first = await h.admin(organizationId).closeRfq(rfq.id);
    const second = await h.admin(organizationId).closeRfq(rfq.id, key());

    expect([first.status, second.status]).toEqual([200, 200]);
    expect(second.body).toEqual(first.body);
    expect(await h.events(organizationId, 'RFQ_CLOSED')).toHaveLength(1);
  });

  it('a person of the buyer without the issuer role is 403; a supplier — invited or not — and a third organization find nothing: 404', async () => {
    const { organizationId, rfq, deadline, invitees } = await issued();
    h.clock.set(deadline);

    const user = await client(h.api, actor(organizationId, ['PROCUREMENT_USER'])).closeRfq(rfq.id);
    const invited = await client(
      h.api,
      actor(invitees[0]!, ['SUPPLIER', 'ORGANIZATION_ADMIN']),
    ).closeRfq(rfq.id);
    const third = await h.admin(h.org()).closeRfq(rfq.id);
    const missing = await h.admin(organizationId).closeRfq('RFQ_01JAAAAAAAAAAAAAAAAAAAAAAA');
    // A supplier holding no buyer role at all: still the 404 of a missing id, never a 403 that
    // would tell it the RFQ is somebody's.
    const supplierOnly = await client(h.api, actor(invitees[1]!, ['SUPPLIER'])).closeRfq(rfq.id);

    expect([
      user.status,
      invited.status,
      third.status,
      missing.status,
      supplierOnly.status,
    ]).toEqual([403, 404, 404, 404, 404]);
    expect(Object.keys(invited.body).sort()).toEqual(Object.keys(missing.body).sort());
    expect(await status(organizationId, rfq.id)).toMatchObject({ status: 'PUBLISHED' });
    expect(await h.events(organizationId, 'RFQ_CLOSED')).toEqual([]);
  });

  describe('the close sweeper (on the database clock itself)', () => {
    /** A timeline whose deadlines the real database clock has already passed. */
    const PAST = new Date('2020-02-01T08:00:00.000Z');

    /** An RFQ issued on the PAST timeline, its deadline an hour after the issue: due now. */
    async function dueRfq() {
      const { organizationId, aggregation } = await h.readyAggregation(undefined, PAST);
      const deadline = new Date(PAST.getTime() + 13 * HOUR);
      const body = h.issueBody(aggregation, { quotationClosingAt: deadline.toISOString() });
      const rfq = (await h.admin(organizationId).issueRfq(aggregation.id, body)).body;
      expect(rfq.status).toBe('PUBLISHED');
      return { organizationId, rfq, deadline };
    }

    it('closes an RFQ past its deadline on its own — no person, in its own tenant — and leaves one not yet due alone', async () => {
      const due = await dueRfq();
      const later = await issued(24);
      h.clock.set(null);

      const outcome = await h.api.rfqSweeper().runOnce();

      expect(outcome.closed).toBeGreaterThanOrEqual(1);
      expect(await status(due.organizationId, due.rfq.id)).toMatchObject({
        status: 'CLOSED',
        version: 2,
      });
      expect(await status(later.organizationId, later.rfq.id)).toMatchObject({
        status: 'PUBLISHED',
      });
      const [event, ...more] = await h.events(due.organizationId, 'RFQ_CLOSED');
      expect(more).toEqual([]);
      expect(event).toMatchObject({ trigger: 'SWEEPER', closedBy: null, rfqVersion: 2 });
      const [row] = await h.api.prisma.client.$queryRaw<
        { closed_by: string | null; sweep_fence: string | null; sweep_attempts: number }[]
      >`SELECT closed_by, sweep_fence, sweep_attempts FROM rfq WHERE id = ${due.rfq.id as string}`;
      // Closed by nobody, and the claim given back.
      expect(row).toEqual({ closed_by: null, sweep_fence: null, sweep_attempts: 0 });

      // Swept again: nothing left to close.
      await h.api.rfqSweeper().runOnce();
      expect(await h.events(due.organizationId, 'RFQ_CLOSED')).toHaveLength(1);
    });

    it('two sweepers at once close it once: one event', async () => {
      const due = await dueRfq();
      h.clock.set(null);

      await Promise.all([h.api.rfqSweeper().runOnce(), h.api.rfqSweeper().runOnce()]);

      expect(await status(due.organizationId, due.rfq.id)).toMatchObject({ status: 'CLOSED' });
      expect(await h.events(due.organizationId, 'RFQ_CLOSED')).toHaveLength(1);
    });

    it('a claimed RFQ not yet past its deadline on the clock read after the lock is given back, not closed', async () => {
      // The claim's own filter never selects one; this is the decision under the lock, judged
      // again whatever claimed it.
      const { organizationId, rfq } = await issued(24);
      await h.api.prisma.client.$executeRaw`
        UPDATE rfq SET sweep_lease_until = clock_timestamp() + interval '1 minute',
               sweep_fence = 'FENCE-EARLY' WHERE id = ${rfq.id as string}`;
      h.clock.set(new Date(new Date(rfq.quotationClosingAt as string).getTime() - 1));

      const result = await h.api
        .get(RfqCloseService)
        .close({ organizationId, rfqId: rfq.id as string, fence: 'FENCE-EARLY' });

      expect(result).toBe('NOT_DUE');
      expect(await status(organizationId, rfq.id)).toMatchObject({
        status: 'PUBLISHED',
        version: 1,
      });
      const [row] = await h.api.prisma.client.$queryRaw<{ sweep_fence: string | null }[]>`
        SELECT sweep_fence FROM rfq WHERE id = ${rfq.id as string}`;
      expect(row).toEqual({ sweep_fence: null });
    });

    it('closed by a person after the claim: the sweep finds nothing to do; a fence that is not the holder’s writes nothing', async () => {
      const due = await dueRfq();
      h.clock.set(null);
      const repository = h.api.get(RfqRepository);
      const claimed = (await repository.claimDue(500, 60, 'FENCE-T184')).filter(
        (rfq) => rfq.id === due.rfq.id,
      );
      expect(claimed).toEqual([
        { id: due.rfq.id, organizationId: due.organizationId, fence: 'FENCE-T184' },
      ]);

      const service = h.api.get(RfqCloseService);
      const target = { organizationId: due.organizationId, rfqId: due.rfq.id as string };
      expect(await service.close({ ...target, fence: 'NOT-THE-HOLDER' })).toBe('NOT_OWNER');
      expect(await status(due.organizationId, due.rfq.id)).toMatchObject({ status: 'PUBLISHED' });

      expect((await h.admin(due.organizationId).closeRfq(due.rfq.id)).status).toBe(200);
      expect(await service.close({ ...target, fence: 'FENCE-T184' })).toBe('NOOP');
      const events = await h.events(due.organizationId, 'RFQ_CLOSED');
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ trigger: 'MANUAL' });
    });

    it('a cancelled RFQ is never swept closed', async () => {
      const due = await dueRfq();
      expect((await h.admin(due.organizationId).cancelRfq(due.rfq.id, 1)).status).toBe(200);
      h.clock.set(null);

      await h.api.rfqSweeper().runOnce();

      expect(await status(due.organizationId, due.rfq.id)).toMatchObject({ status: 'CANCELLED' });
      expect(await h.events(due.organizationId, 'RFQ_CLOSED')).toEqual([]);
    });

    it('a failed close is counted and backed off, the claim given back', async () => {
      const due = await dueRfq();
      h.clock.set(null);
      jest
        .spyOn(h.api.get(RfqCloseService), 'close')
        .mockRejectedValueOnce(new Error('the close failed'));

      const outcome = await h.api.rfqSweeper().runOnce();

      expect(outcome.failed).toBeGreaterThanOrEqual(1);
      const [row] = await h.api.prisma.client.$queryRaw<
        {
          status: string;
          sweep_attempts: number;
          sweep_fence: string | null;
          backed_off: boolean;
        }[]
      >`SELECT status, sweep_attempts, sweep_fence, sweep_next_attempt_at > clock_timestamp() AS backed_off
          FROM rfq WHERE id = ${due.rfq.id as string}`;
      expect(row).toEqual({
        status: 'PUBLISHED',
        sweep_attempts: 1,
        sweep_fence: null,
        backed_off: true,
      });
    });
  });

  it('cancels a PUBLISHED RFQ with a code and a reason: the event carries the code, never the reason; the aggregation stays RFQ_ISSUED', async () => {
    const { organizationId, aggregation, rfq } = await issued();
    const admin = h.admin(organizationId, 'USR-CANCELLER');

    const cancelled = await admin.cancelRfq(rfq.id, 1, 'the depot burned down last night');

    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toMatchObject({
      status: 'CANCELLED',
      cancelledAt: AFTER_READY.toISOString(),
      cancelReasonCode: 'BUYER_REQUEST',
      cancelReason: 'the depot burned down last night',
      version: 2,
    });
    const [event] = await h.events(organizationId, 'RFQ_CANCELLED');
    expect(rfqCancelledPayloadSchema.parse(event)).toEqual({
      rfqId: rfq.id,
      organizationId,
      aggregationId: aggregation.id,
      rfqVersion: 2,
      previousStatus: 'PUBLISHED',
      reasonCode: 'BUYER_REQUEST',
      cancelledBy: 'USR-CANCELLER',
      cancelledAt: AFTER_READY.toISOString(),
    });
    expect(JSON.stringify(event)).not.toContain('depot');
    expect(
      (await client(h.api, buyer(organizationId)).aggregation(aggregation.id)).body,
    ).toMatchObject({
      status: 'RFQ_ISSUED',
      rfqId: rfq.id,
    });

    // A cancelled RFQ is never closed, and never cancelled again.
    h.clock.set(new Date(AFTER_READY.getTime() + 48 * HOUR));
    const close = await admin.closeRfq(rfq.id);
    expect(close.status).toBe(422);
    expect(close.body.details[0].code).toBe('RFQ_CANCELLED');
    const again = await admin.cancelRfq(rfq.id, 2);
    expect(again.status).toBe(422);
    expect(again.body.details[0].code).toBe('RFQ_NOT_CANCELLABLE');
  });

  it('cancels a CLOSED RFQ too, keeping its close; a stale version is 409; the reason is required', async () => {
    const { organizationId, rfq, deadline } = await issued();
    const admin = h.admin(organizationId);
    h.clock.set(deadline);
    expect((await admin.closeRfq(rfq.id)).status).toBe(200);

    const stale = await admin.cancelRfq(rfq.id, 1);
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('OPTIMISTIC_LOCK_FAILED');
    const noReason = await admin.post(`/v1/rfqs/${rfq.id as string}/cancel`, {
      expectedVersion: 2,
      reasonCode: 'BUYER_REQUEST',
    });
    expect(noReason.status).toBe(400);
    const unknownCode = await admin.post(`/v1/rfqs/${rfq.id as string}/cancel`, {
      expectedVersion: 2,
      reasonCode: 'NO_QUALIFIED_QUOTATION',
      reason: 'nobody qualified at all',
    });
    expect(unknownCode.status).toBe(400);

    const cancelled = await admin.cancelRfq(rfq.id, 2);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toMatchObject({ status: 'CANCELLED', closedAt: deadline.toISOString() });
    const [event] = await h.events(organizationId, 'RFQ_CANCELLED');
    expect(event).toMatchObject({ previousStatus: 'CLOSED', rfqVersion: 3 });
  });

  it('a cancel is idempotent under its key; another role is 403; a supplier and a third organization 404', async () => {
    const { organizationId, rfq, invitees } = await issued();
    const k = key();
    const user = await client(h.api, actor(organizationId, ['PROCUREMENT_USER'])).cancelRfq(
      rfq.id,
      1,
    );
    const supplier = await client(h.api, actor(invitees[0]!, ['SUPPLIER'])).cancelRfq(rfq.id, 1);
    const third = await h.admin(h.org()).cancelRfq(rfq.id, 1);
    expect([user.status, supplier.status, third.status]).toEqual([403, 404, 404]);

    const admin = h.admin(organizationId);
    const first = await admin.cancelRfq(rfq.id, 1, 'the budget was withdrawn', k);
    const replay = await admin.cancelRfq(rfq.id, 1, 'the budget was withdrawn', k);
    // The same key from another person of the same organization is another request.
    const other = await h.admin(organizationId).cancelRfq(rfq.id, 1, 'the budget was withdrawn', k);
    expect([first.status, replay.status, other.status]).toEqual([200, 200, 409]);
    expect(replay.body).toEqual(first.body);
    expect(other.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await h.events(organizationId, 'RFQ_CANCELLED')).toHaveLength(1);
  });

  describe('a close and a cancel at once: each order has one outcome', () => {
    const LOCK = /FROM rfq WHERE organization_id/;
    const started = (test: request.Test) => test.then((response) => response);

    function parkFirstMove() {
      const repository = h.api.get(RfqRepository);
      const gate = barrier();
      const original = repository.moveRfq.bind(repository);
      jest.spyOn(repository, 'moveRfq').mockImplementationOnce(async (...args) => {
        gate.arrive();
        await gate.wait;
        return original(...args);
      });
      return gate;
    }

    it('the close first: the cancel waits on the RFQ’s lock, then finds its version moved — 409', async () => {
      const { organizationId, rfq, deadline } = await issued();
      h.clock.set(deadline);
      const gate = parkFirstMove();

      const close = started(h.admin(organizationId).closeRfq(rfq.id));
      await gate.reached;
      const cancel = started(h.admin(organizationId).cancelRfq(rfq.id, 1));
      await waitForLockWaiter(h.api, LOCK);
      gate.release();

      const [c, x] = await Promise.all([close, cancel]);
      expect([c.status, x.status]).toEqual([200, 409]);
      expect(x.body.code).toBe('OPTIMISTIC_LOCK_FAILED');
      expect(await status(organizationId, rfq.id)).toMatchObject({ status: 'CLOSED' });
    });

    it('the cancel first: the close waits on the lock, then finds it cancelled — 422 RFQ_CANCELLED', async () => {
      const { organizationId, rfq, deadline } = await issued();
      h.clock.set(deadline);
      const gate = parkFirstMove();

      const cancel = started(h.admin(organizationId).cancelRfq(rfq.id, 1));
      await gate.reached;
      const close = started(h.admin(organizationId).closeRfq(rfq.id));
      await waitForLockWaiter(h.api, LOCK);
      gate.release();

      const [x, c] = await Promise.all([cancel, close]);
      expect([x.status, c.status]).toEqual([200, 422]);
      expect(c.body.details[0].code).toBe('RFQ_CANCELLED');
      expect(await h.events(organizationId, 'RFQ_CLOSED')).toEqual([]);
    });
  });
});
