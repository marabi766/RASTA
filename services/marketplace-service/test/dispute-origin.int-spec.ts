import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { withUtcSession } from '@rasta/config';
import { runUnscoped } from '@rasta/nest-common';
import { ulid } from 'ulid';
import { PrismaClient } from '../src/generated/prisma';
import type { EconomicClient } from '../src/economic/economic.client';
import { createActivities } from '../src/temporal/activities';
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
    await prisma.stop();
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
      wiring.orders.place({ lines: [{ offerId, offerVersion: 1, quantity: 1 }] }, key('origin')),
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
      wiring.orders.place(
        { lines: [{ offerId, offerVersion: 1, quantity: 1 }] },
        key('origin-pending'),
      ),
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

  it('the saga reads the order and its open dispute as one snapshot: a decision between the reads cannot tear it', async () => {
    const orderId = await disputedAtConfirmed();
    const dispute = await disputeOf(orderId);
    // The operator's decision commits right after the saga read the order row
    // and before it reads the dispute.
    const original = wiring.repository.findForParty.bind(wiring.repository);
    let decideBetween = true;
    const spy = jest
      .spyOn(wiring.repository, 'findForParty')
      .mockImplementation(async (...args: Parameters<typeof original>) => {
        const row = await original(...args);
        if (decideBetween) {
          decideBetween = false;
          await asOperator(() =>
            resolveOpenDispute(wiring, orderId, {
              outcome: 'SETTLE',
              resolution: 'decided between the two reads',
              responsibility: 'UNDETERMINED',
            }),
          );
        }
        return row;
      });
    try {
      const torn = await asSaga(() => wiring.orders.sagaView(orderId));
      expect(decideBetween).toBe(false);
      // As of the first read: DISPUTED, with that dispute open.
      expect(torn.status).toBe('DISPUTED');
      expect(torn.dispute?.id).toBe(dispute.id);
    } finally {
      spy.mockRestore();
    }
    // And the next look sees the decision whole.
    const after = await asSaga(() => wiring.orders.sagaView(orderId));
    expect(after.status).toBe('CONFIRMED');
    expect(after.dispute).toBeNull();
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

  /** An order the supplier confirmed: where the legacy disputes below are planted. */
  async function confirmedOrder(): Promise<{ id: string; organizationId: string }> {
    const { offerId } = await publishOffer(wiring, org.supplier);
    const order = await asBuyer(() =>
      wiring.orders.place(
        { lines: [{ offerId, offerVersion: 1, quantity: 1 }] },
        key('origin-legacy'),
      ),
    );
    await asSaga(() => wiring.orders.markFundsHeld(order.id, `TXN_${ulid()}`, sagaStep()));
    await asSupplier(() => wiring.orders.confirm(order.id));
    return { id: order.id, organizationId: org.buyer };
  }

  type Planted = { id: string; organizationId: string };
  const HISTORY = `INSERT INTO "order_status_history"
      ("id", "organization_id", "order_id", "kind", "from_status", "to_status",
       "actor_id", "actor_type", "correlation_id", "occurred_at")
    VALUES ($1, $2, $3, 'TRANSITION', $4::"OrderStatus", $5::"OrderStatus", 'USR-ORG-B', 'USER', 'itest', $6)`;

  /**
   * A dispute as the previous release raised it: no origin, and — unless
   * `split` — its transition into DISPUTED written by the same transaction
   * (`extra` adds a second transition there).
   */
  async function legacyRaise(
    order: Planted,
    from: string,
    at: string,
    options: { split?: boolean; extra?: boolean } = {},
  ): Promise<string> {
    const disputeId = `DSP_${ulid()}`;
    const history = (tx: Pick<PrismaClient, '$executeRawUnsafe'>, fromStatus = from) =>
      tx.$executeRawUnsafe(
        HISTORY,
        `OSH_${ulid()}`,
        order.organizationId,
        order.id,
        fromStatus,
        'DISPUTED',
        new Date(at),
      );
    await owner.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        'ALTER TABLE "order_dispute" DISABLE TRIGGER "trg_order_dispute_origin"',
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO "order_dispute" ("id", "organization_id", "order_id", "reason", "status", "raised_by", "raised_at")
         VALUES ($1, $2, $3, 'a legacy objection', 'OPEN', 'USR-ORG-B', $4)`,
        disputeId,
        order.organizationId,
        order.id,
        new Date(at),
      );
      await tx.$executeRawUnsafe(
        `UPDATE "order" SET "status" = 'DISPUTED' WHERE "id" = $1`,
        order.id,
      );
      if (!options.split) await history(tx);
      if (options.extra) await history(tx, 'FUNDS_HELD');
      await tx.$executeRawUnsafe(
        'ALTER TABLE "order_dispute" ENABLE TRIGGER "trg_order_dispute_origin"',
      );
    });
    if (options.split) await history(owner);
    return disputeId;
  }

  /** The previous release's SETTLE: the dispute closed and the order moved to `to`, in one transaction. */
  async function legacySettle(order: Planted, disputeId: string, to: string, at: string) {
    await owner.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `UPDATE "order_dispute" SET "status" = 'RESOLVED_SETTLE', "resolution" = 'decided',
                "responsibility" = 'UNDETERMINED',
                "resolved_at" = $2, "resolved_by" = 'USR-ORG-OPS' WHERE "id" = $1`,
        disputeId,
        new Date(at),
      );
      await tx.$executeRawUnsafe(
        `UPDATE "order" SET "status" = $2::"OrderStatus",
                "receipt_confirmed_at" = COALESCE("receipt_confirmed_at", $3),
                "receipt_confirmed_by" = COALESCE("receipt_confirmed_by", 'USR-ORG-B')
          WHERE "id" = $1`,
        order.id,
        to,
        new Date(at),
      );
      await tx.$executeRawUnsafe(
        HISTORY,
        `OSH_${ulid()}`,
        order.organizationId,
        order.id,
        'DISPUTED',
        to,
        new Date(at),
      );
    });
  }

  const originOf = async (disputeId: string) =>
    (
      await owner.$queryRawUnsafe<{ raised_from_status: string | null }[]>(
        'SELECT "raised_from_status"::text FROM "order_dispute" WHERE "id" = $1',
        disputeId,
      )
    )[0]?.raised_from_status ?? null;

  it('the backfill associates a legacy dispute with its own transition, never the latest by time (#625 r1 R2)', async () => {
    // Certain: the dispute and its move into DISPUTED, one transaction.
    const certain = await confirmedOrder();
    const certainDispute = await legacyRaise(certain, 'CONFIRMED', '2026-10-01T10:00:00Z');

    // The review's case: A raised at 200, settled back at 100, B raised at
    // 110 — the clock went back. The latest transition is A's; B was raised
    // from RECEIPT_CONFIRMED.
    const reversed = await confirmedOrder();
    const disputeA = await legacyRaise(reversed, 'CONFIRMED', '2026-10-01T10:03:20Z');
    await legacySettle(reversed, disputeA, 'RECEIPT_CONFIRMED', '2026-10-01T10:01:40Z');
    const disputeB = await legacyRaise(reversed, 'RECEIPT_CONFIRMED', '2026-10-01T10:01:50Z');

    // Not provable: the transition written apart from the dispute; or two
    // transitions written with it.
    const split = await confirmedOrder();
    const splitDispute = await legacyRaise(split, 'CONFIRMED', '2026-10-01T10:00:00Z', {
      split: true,
    });
    const twice = await confirmedOrder();
    const twiceDispute = await legacyRaise(twice, 'CONFIRMED', '2026-10-01T10:00:00Z', {
      extra: true,
    });

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

    expect(await originOf(certainDispute)).toBe('CONFIRMED');
    expect(await originOf(disputeB)).toBe('RECEIPT_CONFIRMED');
    expect(await originOf(disputeA)).toBeNull();
    expect(await originOf(splitDispute)).toBeNull();
    expect(await originOf(twiceDispute)).toBeNull();

    // And the saga reads the OPEN dispute, B — not A, the latest raised.
    const view = await asSaga(() => wiring.orders.sagaView(reversed.id, disputeA));
    expect(view.dispute?.id).toBe(disputeB);
    expect(view.mirroredDispute).toEqual({ id: disputeA, resolution: 'decided' });

    // A second open dispute on one order is refused by the database — even
    // one no origin check would stop (its trigger lifted here).
    await expect(
      owner.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          'ALTER TABLE "order_dispute" DISABLE TRIGGER "trg_order_dispute_origin"',
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO "order_dispute" ("id", "organization_id", "order_id", "reason", "status", "raised_by")
           VALUES ($1, $2, $3, 'a second open objection', 'OPEN', 'USR-ORG-B')`,
          `DSP_${ulid()}`,
          reversed.organizationId,
          reversed.id,
        );
      }),
    ).rejects.toThrow(/23505[\s\S]*Key \(order_id\)/); // uq_dispute_one_open_per_order

    // Each is decided now so the next case's report counts only its own.
    for (const order of [certain, reversed, split, twice]) {
      await asOperator(() =>
        resolveOpenDispute(wiring, order.id, {
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
      wiring.orders.place({ lines: [{ offerId, offerVersion: 1, quantity: 1 }] }, key('evidence')),
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

    // The saga authorises nothing for it: no receipt, no call to
    // economic-service (whose obligation for it the economic migration may
    // have returned to HELD).
    const economicCalls: string[] = [];
    const economic = new Proxy(
      {},
      {
        get: (_target, name) => () => {
          economicCalls.push(String(name));
          return Promise.resolve(undefined);
        },
      },
    ) as EconomicClient;
    const acts = createActivities({ orders: wiring.orders, economic, currentStep: sagaStep });
    await expect(acts.authoriseSettlement(order.id, `TXN_${ulid()}`)).rejects.toMatchObject({
      type: 'BUSINESS_RULE_VIOLATION',
      nonRetryable: true,
    });
    expect(economicCalls).toEqual([]);

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
