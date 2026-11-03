import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { withUtcSession } from '@rasta/config';
import { runUnscoped } from '@rasta/nest-common';
import { ulid } from 'ulid';
import { PrismaClient } from '../src/generated/prisma';
import type { PrismaService } from '../src/prisma/prisma.service';
import {
  asActor,
  cleanup,
  key,
  newPrisma,
  publishOffer,
  resolveOpenDispute,
  sagaStep,
  tenants,
  wire,
  type Wiring,
} from './helpers';

/**
 * Where a dispute found its order, as the database keeps it, and what an
 * operator's SETTLE does where that is not known (D-083, marketplace audit F1;
 * migration 20261103130000_order_dispute_origin).
 *
 * - `trg_order_dispute_origin` records the order's status on every dispute
 *   inserted, from either writer, and no later write changes it.
 * - A dispute raised before the migration keeps NULL unless its history says
 *   the origin without doubt (the migration's own UPDATE, run here on planted
 *   legacy rows); SETTLE on a NULL origin is refused `DISPUTE_ORIGIN_UNKNOWN`,
 *   and REFUND still decides it.
 * - `ck_order_receipt_confirmed_has_evidence` refuses any new RECEIPT_CONFIRMED
 *   without the buyer's receipt; an order the old SETTLE left there is found
 *   by the read-only check (prisma/checks/dispute-settle-evidence.sql), never
 *   repaired, and refused SETTLE (`DISPUTE_RECEIPT_EVIDENCE_MISSING`).
 *
 * Legacy rows are planted through the owner connection, which lifts the
 * trigger or the constraint for one transaction — never through the runtime
 * client under test.
 */

jest.setTimeout(60_000);

const MIGRATION = join(__dirname, '../prisma/migrations/20261103130000_order_dispute_origin');
const CHECK_SQL = readFileSync(
  join(__dirname, '../prisma/checks/dispute-settle-evidence.sql'),
  'utf8',
);

/** The migration's backfill, verbatim: its one UPDATE statement. */
function backfillStatement(): string {
  const sql = readFileSync(join(MIGRATION, 'migration.sql'), 'utf8');
  const start = sql.indexOf('UPDATE "order_dispute"');
  const end = sql.indexOf(';', start);
  if (start < 0 || end < 0) throw new Error('the migration has no backfill UPDATE');
  return sql.slice(start, end);
}

function ownerClient(): PrismaClient {
  const url = process.env.DATABASE_URL_MARKETPLACE_MIGRATOR;
  if (!url) throw new Error('DATABASE_URL_MARKETPLACE_MIGRATOR is required by this suite');
  return new PrismaClient({ datasources: { db: { url: withUtcSession(url) } } });
}

interface Finding {
  finding: string;
  order_id: string;
  dispute_id: string | null;
}

describe('a dispute’s origin and the receipt evidence, in the database (D-083)', () => {
  let prisma: PrismaService;
  let wiring: Wiring;
  let owner: PrismaClient;
  const org = tenants();

  beforeAll(() => {
    prisma = newPrisma();
    wiring = wire(prisma);
    owner = ownerClient();
  });

  afterAll(async () => {
    await cleanup(prisma, [org.buyer, org.supplier, org.other]);
    await owner.$disconnect();
    await prisma.onModuleDestroy();
  });

  const asBuyer = <T>(fn: () => Promise<T>) =>
    asActor({ organizationId: org.buyer, roles: ['PROCUREMENT_USER'], userId: 'USR-ORG-B' }, fn);
  const asSupplier = <T>(fn: () => Promise<T>) =>
    asActor({ organizationId: org.supplier, roles: ['SUPPLIER'], userId: 'USR-ORG-S' }, fn);
  const asOperator = <T>(fn: () => Promise<T>) =>
    asActor({ organizationId: org.other, roles: ['SYSTEM_ADMIN'], userId: 'USR-ORG-OPS' }, fn);
  const asSaga = <T>(fn: () => Promise<T>) =>
    asActor(
      {
        organizationId: org.buyer,
        authType: 'SERVICE',
        callerService: 'marketplace-service',
        roles: ['SERVICE'],
      },
      fn,
    );

  /** An order the supplier confirmed, then disputed by the buyer there. */
  async function disputedAtConfirmed(): Promise<string> {
    const { offerId } = await publishOffer(wiring, org.supplier);
    const order = await asBuyer(() =>
      wiring.orders.place({ lines: [{ offerId, quantity: 1 }] }, key('origin')),
    );
    await asSaga(() => wiring.orders.markFundsHeld(order.id, `TXN_${ulid()}`, sagaStep()));
    await asSupplier(() => wiring.orders.confirm(order.id));
    await asBuyer(() => wiring.orders.raiseDispute(order.id, { reason: 'the parts are late' }));
    return order.id;
  }

  async function disputeOf(orderId: string) {
    return runUnscoped('the suite reads the dispute it raised', () =>
      prisma.client.orderDispute.findFirstOrThrow({
        where: { orderId },
        orderBy: { raisedAt: 'desc' },
        select: { id: true, status: true, raisedFromStatus: true },
      }),
    );
  }

  async function orderRow(orderId: string) {
    return runUnscoped('the suite reads the order', () =>
      prisma.client.order.findUniqueOrThrow({ where: { id: orderId } }),
    );
  }

  async function writesFor(orderId: string): Promise<{ history: number; outbox: number }> {
    const [history, outbox] = await runUnscoped('the suite counts what the order wrote', () =>
      Promise.all([
        prisma.client.orderStatusHistory.count({ where: { orderId } }),
        prisma.client.outboxMessage.count({ where: { aggregateId: orderId } }),
      ]),
    );
    return { history, outbox };
  }

  /** Makes a dispute look as one raised before the migration: no origin recorded. */
  async function forgetOrigin(disputeId: string): Promise<void> {
    await owner.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        'ALTER TABLE "order_dispute" DISABLE TRIGGER "trg_order_dispute_origin"',
      );
      await tx.$executeRawUnsafe(
        'UPDATE "order_dispute" SET "raised_from_status" = NULL WHERE "id" = $1',
        disputeId,
      );
      await tx.$executeRawUnsafe(
        'ALTER TABLE "order_dispute" ENABLE TRIGGER "trg_order_dispute_origin"',
      );
    });
  }

  async function findings(): Promise<Finding[]> {
    const rows = await owner.$queryRawUnsafe<Finding[]>(CHECK_SQL);
    return rows.map(({ finding, order_id, dispute_id }) => ({ finding, order_id, dispute_id }));
  }

  // -------------------------------------------------------------------------

  it('finds nothing to report in a database every suite so far has written through the service', async () => {
    // What CI's fixtures hold: every order and dispute the integration suites
    // wrote before this one, through the code under test.
    expect(await findings()).toEqual([]);
  });

  it('records the status the dispute found, and no later write changes it', async () => {
    const orderId = await disputedAtConfirmed();
    const dispute = await disputeOf(orderId);
    expect(dispute.raisedFromStatus).toBe('CONFIRMED');

    // The runtime role writes another value: the trigger keeps the recorded one.
    await runUnscoped('the suite tries to rewrite where the dispute was raised', () =>
      prisma.client.orderDispute.update({
        where: { id: dispute.id },
        data: { raisedFromStatus: 'RECEIPT_CONFIRMED' },
      }),
    );
    expect((await disputeOf(orderId)).raisedFromStatus).toBe('CONFIRMED');
  });

  it('refuses a dispute inserted for an order in a status no dispute is raised from, instead of recording it', async () => {
    // A writer that inserted before checking — or after moving the order —
    // finds a status outside the four; the CHECK refuses the row.
    const { offerId } = await publishOffer(wiring, org.supplier);
    const pending = await asBuyer(() =>
      wiring.orders.place({ lines: [{ offerId, quantity: 1 }] }, key('origin-pending')),
    );
    await expect(
      owner.$executeRawUnsafe(
        `INSERT INTO "order_dispute" ("id", "organization_id", "order_id", "reason", "status", "raised_by")
         VALUES ($1, $2, $3, 'an objection to an order not yet held', 'OPEN', 'USR-ORG-B')`,
        `DSP_${ulid()}`,
        org.buyer,
        pending.id,
      ),
    ).rejects.toThrow(/ck_order_dispute_raised_from/);
  });

  it('a legacy dispute with no origin: SETTLE refused, nothing written; REFUND still decides it', async () => {
    const orderId = await disputedAtConfirmed();
    const dispute = await disputeOf(orderId);
    await forgetOrigin(dispute.id);
    expect(await findings()).toEqual([
      { finding: 'OPEN_DISPUTE_ORIGIN_UNKNOWN', order_id: orderId, dispute_id: dispute.id },
    ]);
    const before = await writesFor(orderId);

    await expect(
      asOperator(() =>
        resolveOpenDispute(wiring, orderId, {
          outcome: 'SETTLE',
          resolution: 'the supplier showed a dispatch note',
          responsibility: 'BUYER',
        }),
      ),
    ).rejects.toMatchObject({
      code: 'BUSINESS_RULE_VIOLATION',
      details: [expect.objectContaining({ code: 'DISPUTE_ORIGIN_UNKNOWN', path: 'outcome' })],
    });
    expect((await orderRow(orderId)).status).toBe('DISPUTED');
    expect((await disputeOf(orderId)).status).toBe('OPEN');
    expect(await writesFor(orderId)).toEqual(before);

    const refunded = await asOperator(() =>
      resolveOpenDispute(wiring, orderId, {
        outcome: 'REFUND',
        resolution: 'the parts never arrived',
        responsibility: 'SUPPLIER',
      }),
    );
    expect(refunded.status).toBe('CANCELLING');
  });

  it('the backfill records a legacy origin only where the history states it without doubt', async () => {
    const certain = await disputedAtConfirmed();
    const doubtful = await disputedAtConfirmed();
    const certainDispute = await disputeOf(certain);
    const doubtfulDispute = await disputeOf(doubtful);
    await forgetOrigin(certainDispute.id);
    await forgetOrigin(doubtfulDispute.id);

    // A second transition at the very instant of the move into DISPUTED: which
    // one was the move is no longer certain.
    const last = await owner.$queryRawUnsafe<{ occurred_at: Date; organization_id: string }[]>(
      `SELECT "occurred_at", "organization_id" FROM "order_status_history"
        WHERE "order_id" = $1 AND "kind" = 'TRANSITION' ORDER BY "occurred_at" DESC LIMIT 1`,
      doubtful,
    );
    await owner.$executeRawUnsafe(
      `INSERT INTO "order_status_history"
         ("id", "organization_id", "order_id", "kind", "from_status", "to_status",
          "actor_id", "actor_type", "correlation_id", "occurred_at")
       VALUES ($1, $2, $3, 'TRANSITION', 'FUNDS_HELD', 'DISPUTED', 'USR-ORG-B', 'USER', 'itest', $4)`,
      `OSH_${ulid()}`,
      last[0]!.organization_id,
      doubtful,
      last[0]!.occurred_at,
    );

    // As the migration runs it: the backfill comes before the trigger that
    // keeps an origin from changing exists.
    await owner.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        'ALTER TABLE "order_dispute" DISABLE TRIGGER "trg_order_dispute_origin"',
      );
      await tx.$executeRawUnsafe(backfillStatement());
      await tx.$executeRawUnsafe(
        'ALTER TABLE "order_dispute" ENABLE TRIGGER "trg_order_dispute_origin"',
      );
    });

    expect((await disputeOf(certain)).raisedFromStatus).toBe('CONFIRMED');
    expect((await disputeOf(doubtful)).raisedFromStatus).toBeNull();

    // Each is decided now so the next case's report counts only its own.
    for (const orderId of [certain, doubtful]) {
      await asOperator(() =>
        resolveOpenDispute(wiring, orderId, {
          outcome: 'REFUND',
          resolution: 'closed for the next case',
          responsibility: 'UNDETERMINED',
        }),
      );
    }
  });

  it('an order the old SETTLE left RECEIPT_CONFIRMED with no receipt: found, refused SETTLE, REFUND still possible', async () => {
    const { offerId } = await publishOffer(wiring, org.supplier);
    const order = await asBuyer(() =>
      wiring.orders.place({ lines: [{ offerId, quantity: 1 }] }, key('evidence')),
    );
    await asSaga(() => wiring.orders.markFundsHeld(order.id, `TXN_${ulid()}`, sagaStep()));
    await asSupplier(() => wiring.orders.confirm(order.id));

    // A new write claiming a receipt nobody recorded is refused by the database.
    await expect(
      runUnscoped('the suite writes what the old SETTLE wrote', () =>
        prisma.client.order.update({
          where: { id: order.id },
          data: { status: 'RECEIPT_CONFIRMED' },
        }),
      ),
    ).rejects.toThrow(/ck_order_receipt_confirmed_has_evidence/);

    // Planted as the old release left it, before the constraint existed.
    await owner.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        'ALTER TABLE "order" DROP CONSTRAINT "ck_order_receipt_confirmed_has_evidence"',
      );
      await tx.$executeRawUnsafe(
        `UPDATE "order" SET "status" = 'RECEIPT_CONFIRMED' WHERE "id" = $1`,
        order.id,
      );
      await tx.$executeRawUnsafe(
        `ALTER TABLE "order" ADD CONSTRAINT "ck_order_receipt_confirmed_has_evidence"
           CHECK ("status" <> 'RECEIPT_CONFIRMED'
                  OR ("receipt_confirmed_at" IS NOT NULL AND "receipt_confirmed_by" IS NOT NULL))
           NOT VALID`,
      );
    });

    expect(await findings()).toEqual([
      { finding: 'RECEIPT_CONFIRMED_WITHOUT_RECEIPT', order_id: order.id, dispute_id: null },
    ]);

    // The way out the runbook names: a dispute, then the operator's decision.
    await asBuyer(() =>
      wiring.orders.raiseDispute(order.id, { reason: 'nothing ever arrived here' }),
    );
    expect((await disputeOf(order.id)).raisedFromStatus).toBe('RECEIPT_CONFIRMED');
    const before = await writesFor(order.id);
    await expect(
      asOperator(() =>
        resolveOpenDispute(wiring, order.id, {
          outcome: 'SETTLE',
          resolution: 'the supplier says it was delivered',
          responsibility: 'BUYER',
        }),
      ),
    ).rejects.toMatchObject({
      code: 'BUSINESS_RULE_VIOLATION',
      details: [expect.objectContaining({ code: 'DISPUTE_RECEIPT_EVIDENCE_MISSING' })],
    });
    expect(await writesFor(order.id)).toEqual(before);
    expect((await orderRow(order.id)).status).toBe('DISPUTED');

    const refunded = await asOperator(() =>
      resolveOpenDispute(wiring, order.id, {
        outcome: 'REFUND',
        resolution: 'no receipt was ever confirmed',
        responsibility: 'SUPPLIER',
      }),
    );
    expect(refunded.status).toBe('CANCELLING');
    expect(await findings()).toEqual([]);
  });
});
