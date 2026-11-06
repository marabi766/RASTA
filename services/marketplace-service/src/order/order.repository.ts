import { Injectable } from '@nestjs/common';
import { RastaError, getContext, getOrganizationId, runUnscoped } from '@rasta/nest-common';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';
import { newId, ID_PREFIX } from '../events/publisher';
import type { OrderStatus, Prisma } from '../generated/prisma';

/**
 * What every path that builds an order view selects (`toView`): its lines,
 * whether it was reviewed, and the dispute it holds now — the one an
 * operator's decision names (D-083). One constant, so no path can forget part
 * of it.
 */
export const ORDER_VIEW_INCLUDE = {
  lines: true,
  review: { select: { id: true } },
  // The one OPEN dispute (`uq_dispute_one_open_per_order`), by status, not by time.
  disputes: {
    where: { status: 'OPEN' },
    select: { id: true },
    take: 1,
  },
} as const satisfies Prisma.OrderInclude;

/**
 * Data access for orders and offers.
 *
 * Two things here are load-bearing rather than plumbing.
 *
 * **`lockOffers` takes row locks in a deterministic order.** Two buyers
 * ordering the same two offers at the same time would otherwise be able to
 * deadlock each other; sorting the ids first means every transaction takes
 * them in the same sequence, which makes a deadlock structurally impossible —
 * the same reason economic-service locks wallets by ascending id (ADR-031).
 *
 * **A supplier's reads cross the tenant guard with a written reason.** An
 * `Order` is scoped to the buyer (ADR-037 § 8), so the seller — who is
 * legitimately a party to it — cannot see it through the automatic scope. Each
 * crossing is narrow, states its reason, and lands in `access.ts` where the
 * check is explicit.
 */
@Injectable()
export class OrderRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Locks the named offers `FOR UPDATE`, in a fixed order.
   *
   * Raw SQL because Prisma has no expression for `FOR UPDATE`, and the whole
   * correctness of concurrent ordering rests on it: without the lock, two
   * requests both read `availableQuantity: 1` and both succeed.
   *
   * Crosses the tenant guard deliberately: a buyer prices offers belonging to
   * a *supplier*, so scoping this read to the caller would return nothing and
   * make the marketplace unable to sell anything.
   */
  async lockOffers(tx: ExtendedPrismaClient, offerIds: readonly string[]) {
    const ordered = [...new Set(offerIds)].sort();
    if (ordered.length === 0) return [];

    return runUnscoped(
      'a buyer prices offers owned by suppliers; the object-level check is in pricing and access',
      () => tx.$queryRaw<LockedOfferRow[]>`
        SELECT id, organization_id, product_id, unit_price_minor, currency,
               available_quantity, minimum_quantity, version, status::text AS status,
               lead_time_days
        FROM "offer"
        WHERE id = ANY(${ordered}::text[])
        ORDER BY id
        FOR UPDATE
      `,
    );
  }

  /** Reduces availability by the ordered quantity, under the lock above. */
  async consumeAvailability(
    tx: ExtendedPrismaClient,
    lines: readonly { offerId: string; quantity: number }[],
  ): Promise<void> {
    for (const line of lines) {
      await runUnscoped(
        'availability belongs to the supplier whose offer the buyer just bought',
        () => tx.$executeRaw`
          UPDATE "offer"
          SET available_quantity = available_quantity - ${line.quantity}
          WHERE id = ${line.offerId}
        `,
      );
    }
  }

  /** Restores availability when an order is cancelled before delivery. */
  async restoreAvailability(
    tx: ExtendedPrismaClient,
    lines: readonly { offerId: string; quantity: number }[],
  ): Promise<void> {
    for (const line of lines) {
      await runUnscoped(
        'a cancelled order returns what it reserved to its supplier',
        () =>
          tx.$executeRaw`
          UPDATE "offer"
          SET available_quantity = available_quantity + ${line.quantity}
          WHERE id = ${line.offerId}
        `,
      );
    }
  }

  /**
   * Reads an order either party may see.
   *
   * Crosses the guard because the supplier is not the scoped owner, and
   * narrows to the two named organizations immediately. The caller then runs
   * `assertOrderVisible`, which is where a stranger gets a 404.
   */
  /** `client` is the caller's transaction when the read belongs to its snapshot. */
  async findForParty(orderId: string, client: ExtendedPrismaClient = this.prisma.client) {
    return runUnscoped('an order names two organizations and the seller is one of them', () =>
      client.order.findUnique({
        where: { id: orderId },
        include: ORDER_VIEW_INCLUDE,
      }),
    );
  }

  /**
   * Locks one order row for a state transition.
   *
   * Every command that changes status goes through this, so two concurrent
   * commands on the same order serialise rather than both reading the old
   * status and both deciding their transition is legal.
   */
  async lockOrder(tx: ExtendedPrismaClient, orderId: string) {
    const rows = await runUnscoped(
      'an order is locked for transition by either of its two parties',
      () => tx.$queryRaw<RawLockedOrderRow[]>`
        SELECT id, organization_id, supplier_organization_id, status::text AS status,
               total_amount_minor, currency, economic_transaction_id, correlation_id,
               cancellation_cause::text AS cancellation_cause,
               (receipt_confirmed_at IS NOT NULL AND receipt_confirmed_by IS NOT NULL)
                 AS receipt_confirmed
        FROM "order"
        WHERE id = ${orderId}
        FOR UPDATE
      `,
    );

    const row = rows[0];
    if (!row) throw RastaError.notFound('Order', orderId);

    // Mapped to the domain's own casing here rather than at each call site.
    // `access.ts` takes the same shape a Prisma row has, so a caller can pass
    // either without thinking about which one it is holding.
    return {
      id: row.id,
      organizationId: row.organization_id,
      supplierOrganizationId: row.supplier_organization_id,
      status: row.status,
      totalAmountMinor: row.total_amount_minor,
      currency: row.currency,
      economicTransactionId: row.economic_transaction_id,
      correlationId: row.correlation_id,
      cancellationCause: row.cancellation_cause,
      receiptConfirmed: row.receipt_confirmed,
    };
  }

  /** Writes the audit row every transition and every reminder produces. */
  async recordHistory(
    tx: ExtendedPrismaClient,
    input: {
      orderId: string;
      organizationId: string;
      kind: 'TRANSITION' | 'REMINDER';
      fromStatus: OrderStatus;
      toStatus: OrderStatus;
      reason?: string | null;
    },
  ): Promise<void> {
    const context = getContext();
    await runUnscoped('history mirrors the order it belongs to and carries its own tenant', () =>
      tx.orderStatusHistory.create({
        data: {
          id: newId(ID_PREFIX.history),
          organizationId: input.organizationId,
          orderId: input.orderId,
          kind: input.kind,
          fromStatus: input.fromStatus,
          toStatus: input.toStatus,
          reason: input.reason ?? null,
          actorId: context.userId ?? context.callerService ?? 'unknown',
          actorType: context.authType,
          correlationId: context.correlationId,
        },
      }),
    );
  }

  /**
   * What a saga step recorded when it took effect, or null if it has not
   * (D-053).
   *
   * A local transition reads this under the order's row lock, so another
   * attempt of the same step has either committed its record or not begun.
   * A key includes the workflow, run and activity ids: a restart or reset may
   * reuse activity ids, but belongs to a different run. A record for another
   * activity violates that identity and is refused rather than replayed.
   */
  async findSagaStep(
    client: ExtendedPrismaClient,
    order: { id: string; organizationId: string },
    step: SagaStep,
    activity: SagaActivity,
  ): Promise<{ result: Prisma.JsonValue } | null> {
    const row = await runUnscoped('a saga step reads its own record on the order it drives', () =>
      client.sagaStep.findUnique({
        where: {
          organizationId_orderId_stepKey: {
            organizationId: order.organizationId,
            orderId: order.id,
            stepKey: step.key,
          },
        },
        select: { activity: true, result: true },
      }),
    );
    if (!row) return null;
    if (row.activity !== activity) {
      throw new Error(
        `Saga step ${step.key} of order ${order.id} was recorded by ${row.activity}, not ${activity}`,
      );
    }
    return { result: row.result };
  }

  /**
   * Records that a saga step took effect and what it returned (D-053).
   *
   * `skipDuplicates`: two attempts of one economic call can overlap after a
   * timeout, and both reach here with the same answer from economic-service's
   * idempotent replay. A local transition never collides — it read the record
   * under the lock it still holds.
   */
  async recordSagaStep(
    client: ExtendedPrismaClient,
    order: { id: string; organizationId: string },
    step: SagaStep,
    activity: SagaActivity,
    result: Prisma.InputJsonValue | undefined,
  ): Promise<void> {
    await runUnscoped('a saga step records itself on the order it drives, under its tenant', () =>
      client.sagaStep.createMany({
        data: [
          {
            organizationId: order.organizationId,
            orderId: order.id,
            stepKey: step.key,
            activity,
            ...(result === undefined ? {} : { result }),
          },
        ],
        skipDuplicates: true,
      }),
    );
  }

  /**
   * A saga call to economic-service is about to be made (FU-104), by the
   * scheduled command `command` (#836 r1 R1). One statement, under the row's
   * lock, decides the whole opening, so a confirmation racing it lands wholly
   * before (the episode restarts) or after (it confirms an earlier generation,
   * which closes nothing):
   *
   * - the record names the command that owns it and when Temporal scheduled it.
   *   The owner, or a command scheduled strictly later, opens it: a new
   *   generation, which only this opening's own answer confirms. Every attempt
   *   opens it again, whatever an earlier one confirmed: only this attempt's
   *   outcome says anything about the funds now (#769 r1 F3);
   * - any other command, scheduled earlier or not provably later, is refused
   *   (`SagaCallSuperseded`) before it calls: the saga has moved past it, so its
   *   answer — a step record's cached one included — must not end the episode
   *   of a newer command (#836 r1 R1). A record no command owns yet (opened
   *   before this release) is taken by the first command that opens it;
   * - `opened_at` is when the episode began: kept while the record stays open,
   *   however many attempts or commands follow, so unconfirmed money never
   *   grows younger; restarted only when a confirmed record is opened again,
   *   a new call (#792 r2 F2).
   *
   * @returns the generation this attempt confirms with.
   */
  async openSagaCall(
    client: ExtendedPrismaClient,
    order: { id: string; organizationId: string },
    operation: SagaActivity,
    subject: string,
    command: SagaStep,
  ): Promise<number> {
    const scheduledAt = command.scheduledAt.toISOString();
    const [opened] = await runUnscoped(
      'a saga step records its call on the order it drives, under its tenant',
      () => client.$queryRaw<{ generation: number }[]>`
        INSERT INTO saga_unconfirmed_call AS c
          (organization_id, order_id, operation, subject, command, command_scheduled_at)
        VALUES (${order.organizationId}, ${order.id}, ${operation}, ${subject}, ${command.key},
          ${scheduledAt}::timestamptz)
        ON CONFLICT (organization_id, order_id, operation, subject) DO UPDATE SET
          opened_at = CASE WHEN c.confirmed_at IS NULL THEN c.opened_at ELSE CURRENT_TIMESTAMP END,
          confirmed_at = NULL,
          generation = c.generation + 1,
          command = EXCLUDED.command,
          command_scheduled_at = EXCLUDED.command_scheduled_at
        WHERE c.command IS NULL OR c.command = EXCLUDED.command
          OR c.command_scheduled_at < EXCLUDED.command_scheduled_at
        RETURNING generation
      `,
    );
    if (!opened) throw new SagaCallSuperseded(order.id, operation, command.key);
    return opened.generation;
  }

  /**
   * economic-service has answered that call (FU-104): only the opening's own
   * generation, of the command that opened it. An attempt overtaken by a newer
   * opening says nothing about the newer one's outcome.
   */
  async confirmSagaCall(
    client: ExtendedPrismaClient,
    order: { id: string; organizationId: string },
    operation: SagaActivity,
    subject: string,
    opening: { command: SagaStep; generation: number },
  ): Promise<void> {
    await runUnscoped('a saga step records its call on the order it drives, under its tenant', () =>
      client.sagaUnconfirmedCall.updateMany({
        where: {
          organizationId: order.organizationId,
          orderId: order.id,
          operation,
          subject,
          command: opening.command.key,
          generation: opening.generation,
          confirmedAt: null,
        },
        data: { confirmedAt: new Date() },
      }),
    );
  }

  /**
   * economic-service has shown a state of `subject` no call of `operations` can
   * change any more, so none of them is in doubt, whichever command made it:
   * the obligation REFUNDED, which is terminal (#792 r2 F2), or the order's own
   * obligation found, which a create's late commit cannot duplicate (#836 r1
   * R2). Closes every open row of theirs on it, whatever its generation or owner.
   */
  async confirmSagaCallsOn(
    client: ExtendedPrismaClient,
    order: { id: string; organizationId: string },
    operations: readonly SagaActivity[],
    subject: string,
  ): Promise<void> {
    await runUnscoped('a saga step records its call on the order it drives, under its tenant', () =>
      client.sagaUnconfirmedCall.updateMany({
        where: {
          organizationId: order.organizationId,
          orderId: order.id,
          operation: { in: [...operations] },
          subject,
          confirmedAt: null,
        },
        data: { confirmedAt: new Date() },
      }),
    );
  }

  /**
   * Whether the order's history holds a row a saga step wrote since `since`
   * (D-053): evidence of a step that took effect before its record could
   * exist — its first attempt ran on a worker older than `saga_step`.
   *
   * The history row is written in the step's own transaction, so it exists
   * exactly when the effect does. Read under the order's lock, like the record.
   */
  async hasSagaHistorySince(
    tx: ExtendedPrismaClient,
    order: { id: string; organizationId: string },
    row: {
      kind: 'TRANSITION' | 'REMINDER';
      from?: readonly OrderStatus[];
      to?: OrderStatus;
      /** Matched exactly when given; `null` matches a row written without one. */
      reason?: string | null;
      since: Date;
    },
  ): Promise<boolean> {
    const found = await runUnscoped(
      'a saga step looks for its own history row on the order it drives',
      () =>
        tx.orderStatusHistory.findFirst({
          where: {
            organizationId: order.organizationId,
            orderId: order.id,
            kind: row.kind,
            ...(row.from ? { fromStatus: { in: [...row.from] } } : {}),
            ...(row.to ? { toStatus: row.to } : {}),
            ...(row.reason === undefined ? {} : { reason: row.reason }),
            occurredAt: { gte: row.since },
          },
          select: { id: true },
        }),
    );
    return found !== null;
  }

  /** Lists orders the caller is a party to, on whichever side. */
  async listForCaller(query: {
    status?: OrderStatus;
    role: 'BUYER' | 'SUPPLIER';
    cursor?: string;
    limit: number;
  }) {
    const organizationId = getOrganizationId();
    const where: Prisma.OrderWhereInput =
      query.role === 'BUYER' ? { organizationId } : { supplierOrganizationId: organizationId };

    if (query.status) where.status = query.status;
    if (query.cursor) where.id = { lt: query.cursor };

    return runUnscoped(
      'a supplier lists orders where it is the named counterparty, narrowed to its own id',
      () =>
        this.prisma.client.order.findMany({
          where,
          include: ORDER_VIEW_INCLUDE,
          orderBy: { id: 'desc' },
          take: query.limit,
        }),
    );
  }
}

/**
 * One scheduled saga activity, the same on every Temporal retry of it (D-053).
 *
 * `key` is `<workflowId>/<runId>/<activityId>`. The activity id is the
 * workflow's own sequence for the call (legacy numeric or `saga-step-N`).
 * A second settlement attempt or reminder is a different step, while a retry
 * is not. Restarts and resets get a new run id. Continue-As-New is safe because
 * checkpoints occur only with no activity in flight; no step spans two runs.
 */
/**
 * A scheduled command opened a call record another command scheduled later owns
 * (#836 r1 R1): the saga has moved past it. Thrown before it calls
 * economic-service, so it changes nothing there or here.
 */
export class SagaCallSuperseded extends Error {
  constructor(orderId: string, operation: string, command: string) {
    super(
      `Saga command ${command} may not make ${operation} of order ${orderId}: ` +
        'a command scheduled later owns its call record',
    );
    this.name = 'SagaCallSuperseded';
  }
}

export interface SagaStep {
  key: string;
  /**
   * When the workflow first scheduled the activity — the same on every retry
   * of it. Anything the step wrote is newer; the same edge written by an
   * earlier step is older (D-053).
   */
  scheduledAt: Date;
}

/** The saga activities that leave a record: every one with an effect. */
export type SagaActivity =
  | 'createObligation'
  | 'markFundsHeld'
  | 'markFailed'
  | 'authoriseSettlement'
  | 'markSettling'
  | 'settle'
  | 'markSettlementFailed'
  | 'markObligationDisputed'
  | 'markCompleted'
  | 'compensate'
  | 'disputeObligation'
  | 'resolveObligationDispute'
  | 'markCancelled'
  | 'recordReminder';

export interface LockedOfferRow {
  id: string;
  organization_id: string;
  product_id: string;
  unit_price_minor: bigint;
  currency: string;
  available_quantity: number;
  minimum_quantity: number;
  version: number;
  status: string;
  lead_time_days: number;
}

/** The raw shape `FOR UPDATE` returns, before it is mapped. */
interface RawLockedOrderRow {
  id: string;
  organization_id: string;
  supplier_organization_id: string;
  status: OrderStatus;
  total_amount_minor: bigint;
  currency: string;
  economic_transaction_id: string | null;
  correlation_id: string;
  cancellation_cause: string | null;
  receipt_confirmed: boolean;
}

export interface LockedOrderRow {
  id: string;
  organizationId: string;
  supplierOrganizationId: string;
  status: OrderStatus;
  totalAmountMinor: bigint;
  currency: string;
  economicTransactionId: string | null;
  correlationId: string;
  /**
   * Set at `CANCELLING` by whichever command got the order there (ADR-052
   * § 1-c); read back by `markCancelled` once the saga's compensation
   * finishes. Null for every order that never entered `CANCELLING`.
   */
  cancellationCause: string | null;
  /**
   * The buyer's receipt is recorded — who and when (ADR-038 § 5). What lets
   * an operator's SETTLE return an order to RECEIPT_CONFIRMED (D-083).
   */
  receiptConfirmed: boolean;
}
