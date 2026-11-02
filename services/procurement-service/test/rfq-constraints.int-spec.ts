import { eligibilityClockWrite } from '@rasta/testing';
import { eligibilityClockSql } from '@rasta/testing';
import { ulid } from 'ulid';
import type { PrismaClient } from '../src/generated/prisma';
import { runtimeClient } from './helpers';
import { AFTER_READY, HOUR, PAST, T0, startRfqApi, type RfqHarness } from './rfq-helpers';

/**
 * What the database itself keeps of an RFQ (plan PR 6), refused as the **runtime** role from any
 * write path, the service's or not: the criteria and invitations frozen with the issue, the issue
 * atomic with its aggregation's READY → RFQ_ISSUED, the deadline before any close, the lifecycle's
 * transitions, and what an RFQ was issued with — never changed, never erased.
 */
describe('the RFQ guards (database)', () => {
  let h: RfqHarness;
  let db: PrismaClient;

  beforeAll(async () => {
    h = await startRfqApi();
    db = runtimeClient();
  });

  afterAll(async () => {
    await db.$disconnect();
    await h.close();
  });

  /** An RFQ issued 12 hours into `t0`, its deadline 24 hours after that: due now on PAST. */
  async function issued(t0 = T0) {
    const { organizationId, aggregation } = await h.readyAggregation(undefined, t0);
    const quotationClosingAt = new Date(t0.getTime() + 36 * HOUR).toISOString();
    const rfq = (
      await h
        .admin(organizationId)
        .issueRfq(aggregation.id, h.issueBody(aggregation, { quotationClosingAt }))
    ).body;
    expect(rfq.status).toBe('PUBLISHED');
    return { organizationId, aggregation, rfq: rfq as { id: string; quotationClosingAt: string } };
  }

  const refused = async (statements: (tx: PrismaClient) => Promise<unknown>, guard: RegExp) => {
    await expect(
      db.$transaction(async (tx) => {
        await statements(tx as unknown as PrismaClient);
      }),
    ).rejects.toThrow(guard);
  };

  it('a criterion or an invitation added after the issue is refused, even to a PUBLISHED RFQ; none is changed or erased', async () => {
    const { organizationId, rfq } = await issued();

    await refused(
      (tx) => tx.$executeRaw`
        INSERT INTO rfq_criterion (organization_id, rfq_id, position, code, label, weight_bp, scoring_method, max_score)
        VALUES (${organizationId}, ${rfq.id}, 3, 'LATE', 'Late', 1, 'MANUAL_SCORE', 1)`,
      /ck_rfq_criteria_frozen/,
    );
    await refused(
      (tx) => tx.$executeRaw`
        INSERT INTO rfq_invitation (organization_id, rfq_id, supplier_organization_id, invited_at)
        VALUES (${organizationId}, ${rfq.id}, ${`ORG_${ulid()}`}, now())`,
      /ck_rfq_invitations_frozen/,
    );
    await refused(
      (tx) =>
        tx.$executeRaw`UPDATE rfq_criterion SET weight_bp = weight_bp WHERE rfq_id = ${rfq.id}`,
      /ck_rfq_frozen/,
    );
    await refused(
      (tx) => tx.$executeRaw`DELETE FROM rfq_invitation WHERE rfq_id = ${rfq.id}`,
      /ck_rfq_frozen/,
    );
    await refused(
      (tx) => tx.$executeRaw`DELETE FROM rfq WHERE id = ${rfq.id}`,
      /ck_rfq_not_erasable/,
    );
  });

  it('once the RFQ moved on, nothing is added to it at all', async () => {
    const { organizationId, rfq } = await issued(PAST);
    h.clock.set(new Date(rfq.quotationClosingAt));
    expect((await h.admin(organizationId).closeRfq(rfq.id)).status).toBe(200);

    await refused(
      (tx) => tx.$executeRaw`
        INSERT INTO rfq_invitation (organization_id, rfq_id, supplier_organization_id, invited_at)
        VALUES (${organizationId}, ${rfq.id}, ${`ORG_${ulid()}`}, now())`,
      /ck_rfq_frozen/,
    );
  });

  it('what an RFQ was issued with never changes; a skipped transition is refused; the sweeper’s bookkeeping moves no version', async () => {
    const { rfq } = await issued();

    await refused(
      (tx) => eligibilityClockWrite(tx)`
        UPDATE rfq SET quotation_closing_at = quotation_closing_at + interval '1 day', version = version + 1
         WHERE id = ${rfq.id}`,
      /ck_rfq_origin_immutable/,
    );
    await refused(
      (tx) => tx.$executeRaw`
        UPDATE rfq SET status = 'EVALUATING', version = version + 1 WHERE id = ${rfq.id}`,
      /ck_rfq_transition/,
    );
    await refused(
      (tx) => tx.$executeRaw`
        UPDATE rfq SET status = 'CANCELLED', version = version + 1 WHERE id = ${rfq.id}`,
      /ck_rfq_cancelled/,
    );

    await eligibilityClockWrite(db)`
      UPDATE rfq SET sweep_lease_until = now(), sweep_fence = 'F', sweep_attempts = 1 WHERE id = ${rfq.id}`;
    const [row] = await db.$queryRaw<{ version: number; status: string }[]>`
      SELECT version, status FROM rfq WHERE id = ${rfq.id}`;
    expect(row).toEqual({ version: 1, status: 'PUBLISHED' });
  });

  it('the deadline is judged on the database clock at the close, not on the instant the writer states (PR-349 r1 F3)', async () => {
    const close = (id: string, closedAt: Date | string) => (tx: PrismaClient) =>
      typeof closedAt === 'string'
        ? tx.$executeRawUnsafe(
            `UPDATE rfq SET status = 'CLOSED', closed_at = ${closedAt}, updated_at = ${closedAt},
                    version = version + 1 WHERE id = $1`,
            id,
          )
        : tx.$executeRaw`
            UPDATE rfq SET status = 'CLOSED', closed_at = ${closedAt}, updated_at = ${closedAt},
                   version = version + 1 WHERE id = ${id}`;

    // Before the deadline on the database's clock: refused whatever it states — the deadline
    // itself, a later instant, an earlier one.
    const early = await issued();
    const deadline = new Date(early.rfq.quotationClosingAt);
    for (const closedAt of [
      deadline,
      new Date(deadline.getTime() + HOUR),
      new Date(deadline.getTime() - 1),
    ]) {
      await refused(close(early.rfq.id, closedAt), /ck_rfq_deadline/);
    }

    // Past it: never before the deadline, never after the database's clock.
    const due = await issued(PAST);
    const dueAt = new Date(due.rfq.quotationClosingAt);
    await refused(close(due.rfq.id, new Date(dueAt.getTime() - 1)), /ck_rfq_deadline/);
    await refused(close(due.rfq.id, "clock_timestamp() + interval '1 second'"), /ck_rfq_deadline/);
    // At the deadline exactly, once the clock has passed it, and at the clock itself: the RFQ's.
    await db.$transaction(async (tx) => {
      await close(due.rfq.id, dueAt)(tx as unknown as PrismaClient);
    });
    const now = await issued(PAST);
    await db.$transaction(async (tx) => {
      await close(now.rfq.id, 'clock_timestamp()::timestamptz(3)')(tx as unknown as PrismaClient);
    });
    const closed = await db.$queryRaw<{ status: string }[]>`
      SELECT status FROM rfq WHERE id IN (${due.rfq.id}, ${now.rfq.id})`;
    expect(closed).toEqual([{ status: 'CLOSED' }, { status: 'CLOSED' }]);
  });

  it('a cancellation keeps the code’s form, not a list the database cannot read; its text is optional (PR-349 r1 F2)', async () => {
    const cancel = (id: string, code: string, reason: string | null) => (tx: PrismaClient) =>
      tx.$executeRaw`
        UPDATE rfq SET status = 'CANCELLED', cancelled_at = issued_at, cancelled_by = 'USR-RAW',
               cancel_reason_code = ${code}, cancel_reason = ${reason}, version = version + 1
         WHERE id = ${id}`;
    const { rfq } = await issued();

    for (const code of ['buyer_request', 'B', 'BUYER REQUEST', 'NO_QUALIFIED_QUOTATION']) {
      await refused(cancel(rfq.id, code, null), /ck_rfq_cancelled/);
    }
    for (const reason of ['', '   ', 'x'.repeat(501)]) {
      await refused(cancel(rfq.id, 'BUYER_REQUEST', reason), /ck_rfq_cancelled/);
    }
    // A configured code the database never heard of, with no text: accepted.
    await db.$transaction(async (tx) => {
      await cancel(rfq.id, 'BUDGET_WITHDRAWN', null)(tx as unknown as PrismaClient);
    });
  });

  it('an RFQ is born only PUBLISHED, of a READY aggregation, with that aggregation moving to RFQ_ISSUED in the same transaction', async () => {
    const { organizationId, aggregation } = await h.readyAggregation();
    const insert = (
      tx: PrismaClient,
      status = eligibilityClockSql`PUBLISHED`,
    ) => eligibilityClockWrite(tx)`
      INSERT INTO rfq (id, organization_id, aggregation_id, product_id, total_quantity, procurement_nature,
                       status, quotation_closing_at, criteria_count, criteria_digest, invitation_count,
                       key_id, public_key_pem, kek_id, wrap_nonce, wrapped_private_key, wrap_tag,
                       issued_at, issued_by, issued_correlation_id, created_at, updated_at)
      VALUES (${`RFQ_${ulid()}`}, ${organizationId}, ${aggregation.id}, ${aggregation.productId}, 5, 'INQUIRY',
              ${status}, ${new Date(AFTER_READY.getTime() + HOUR)}, 1, ${'c'.repeat(64)}, 1,
              ${`RFK_${ulid()}`}, '-----BEGIN PUBLIC KEY-----x', 'run', ${Buffer.alloc(12)}, ${Buffer.alloc(32)},
              ${Buffer.alloc(16)}, ${AFTER_READY}, 'USR-RAW', 'corr-raw', ${AFTER_READY}, ${AFTER_READY})`;

    await refused((tx) => insert(tx, 'CLOSED'), /ck_rfq_born_published/);
    // A READY aggregation left READY at commit: the RFQ alone is refused.
    await refused(
      (tx) => insert(tx),
      /ck_rfq_issue_atomic|ck_rfq_criteria_frozen|ck_rfq_invitations_frozen/,
    );

    // An OPEN window is no RFQ's.
    const open = (
      await db.$queryRaw<{ id: string; product_id: string }[]>`
        SELECT id, product_id FROM demand_aggregation
         WHERE organization_id = ${organizationId} AND status = 'OPEN'`
    )[0]!;
    await refused(
      (tx) => eligibilityClockWrite(tx)`
        INSERT INTO rfq (id, organization_id, aggregation_id, product_id, total_quantity, procurement_nature,
                         status, quotation_closing_at, criteria_count, criteria_digest, invitation_count,
                         key_id, public_key_pem, kek_id, wrap_nonce, wrapped_private_key, wrap_tag,
                         issued_at, issued_by, issued_correlation_id, created_at, updated_at)
        VALUES (${`RFQ_${ulid()}`}, ${organizationId}, ${open.id}, ${open.product_id}, 1, 'INQUIRY',
                'PUBLISHED', ${new Date(AFTER_READY.getTime() + HOUR)}, 1, ${'c'.repeat(64)}, 1,
                ${`RFK_${ulid()}`}, '-----BEGIN PUBLIC KEY-----x', 'run', ${Buffer.alloc(12)}, ${Buffer.alloc(32)},
                ${Buffer.alloc(16)}, ${AFTER_READY}, 'USR-RAW', 'corr-raw', ${AFTER_READY}, ${AFTER_READY})`,
      /ck_rfq_from_ready_aggregation/,
    );
  });

  it('an aggregation names only an RFQ of its own; an RFQ never invites its buyer', async () => {
    const first = await issued();
    const { organizationId, aggregation } = await h.readyAggregation(first.organizationId);

    await refused(
      (tx) => tx.$executeRaw`
        UPDATE demand_aggregation SET status = 'RFQ_ISSUED', rfq_id = ${first.rfq.id},
               version = version + 1 WHERE organization_id = ${organizationId} AND id = ${aggregation.id}`,
      /fk_demand_aggregation_rfq/,
    );
    await refused(
      (tx) => tx.$executeRaw`
        INSERT INTO rfq_invitation (organization_id, rfq_id, supplier_organization_id, invited_at)
        VALUES (${organizationId}, ${first.rfq.id}, ${organizationId}, now())`,
      /ck_rfq_invitation_not_buyer/,
    );
  });
});
