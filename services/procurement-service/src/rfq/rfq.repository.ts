import { Injectable } from '@nestjs/common';
import { RastaError, runUnscoped } from '@rasta/nest-common';
import type { Rfq, RfqCriterion, RfqInvitation } from '../generated/prisma';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';
import type { RfqStateName } from './rfq.state-machine';
import type { Criterion } from './dto';

/** An RFQ with what it was issued with: its criteria in order, and — buyer side — its invitations. */
export interface RfqRecord {
  readonly rfq: Rfq;
  readonly criteria: readonly RfqCriterion[];
  readonly invitations?: readonly RfqInvitation[];
}

export interface RfqPageFilter {
  readonly status?: RfqStateName;
  readonly cursor?: string;
  readonly limit: number;
}

/** What the issue writes (ADR-070 § 3): the RFQ row, its criteria and its invitations. */
export interface NewRfq {
  id: string;
  organizationId: string;
  aggregationId: string;
  productId: string;
  totalQuantity: number;
  procurementNature: string;
  quotationClosingAt: Date;
  criteria: readonly Criterion[];
  criteriaDigest: string;
  invitedSupplierOrganizationIds: readonly string[];
  key: {
    keyId: string;
    publicKeyPem: string;
    kekId: string;
    nonce: Buffer;
    ciphertext: Buffer;
    tag: Buffer;
  };
  issuedAt: Date;
  issuedBy: string;
  issuedCorrelationId: string;
}

/** One RFQ the close sweeper holds the claim on: the fence is what every later write names. */
export interface ClaimedRfq {
  id: string;
  organizationId: string;
  fence: string;
}

export interface RfqCloseBacklog {
  /** PUBLISHED RFQs past their deadline. */
  due: number;
  /** How long the oldest has been past it, in seconds; 0 when none. */
  oldestDueAgeSeconds: number;
}

/**
 * The RFQ tables (ADR-070 § 3, § 10; plan PR 6).
 *
 * **Buyer side** — every read and write names the buyer's organization and goes through the tenant
 * guard (`TENANT_SCOPED_MODELS`); a lock is raw SQL (`SELECT … FOR UPDATE`, the organization in the
 * predicate), and every change a compare-and-set on the organization, the id, the status and the
 * version it read. The lock order is the aggregation, then its RFQ.
 *
 * **Supplier side** — an invited supplier is another tenant, so its reads cross the guard with
 * `runUnscoped` and a written reason, and the predicate is always the invitation of the
 * organization the token names: no invitation, no row.
 *
 * **The close sweeper's queue** spans tenants too (claiming, the backlog); each RFQ it claims is
 * then closed under its own organization (`RfqCloseService`).
 */
@Injectable()
export class RfqRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** The issue's rows, in the issue's transaction (the aggregation locked first). */
  async insertRfq(tx: ExtendedPrismaClient, input: NewRfq): Promise<void> {
    await tx.rfq.create({
      data: {
        id: input.id,
        organizationId: input.organizationId,
        aggregationId: input.aggregationId,
        productId: input.productId,
        totalQuantity: input.totalQuantity,
        procurementNature: input.procurementNature,
        status: 'PUBLISHED',
        quotationClosingAt: input.quotationClosingAt,
        criteriaCount: input.criteria.length,
        criteriaDigest: input.criteriaDigest,
        invitationCount: input.invitedSupplierOrganizationIds.length,
        keyId: input.key.keyId,
        publicKeyPem: input.key.publicKeyPem,
        kekId: input.key.kekId,
        wrapNonce: new Uint8Array(input.key.nonce),
        wrappedPrivateKey: new Uint8Array(input.key.ciphertext),
        wrapTag: new Uint8Array(input.key.tag),
        issuedAt: input.issuedAt,
        issuedBy: input.issuedBy,
        issuedCorrelationId: input.issuedCorrelationId,
        createdAt: input.issuedAt,
        updatedAt: input.issuedAt,
      },
    });
    await tx.rfqCriterion.createMany({
      data: input.criteria.map((criterion, index) => ({
        organizationId: input.organizationId,
        rfqId: input.id,
        position: index + 1,
        code: criterion.code,
        label: criterion.label,
        weightBp: criterion.weightBp,
        scoringMethod: criterion.scoringMethod,
        maxScore: criterion.maxScore,
      })),
    });
    await tx.rfqInvitation.createMany({
      data: input.invitedSupplierOrganizationIds.map((supplierOrganizationId) => ({
        organizationId: input.organizationId,
        rfqId: input.id,
        supplierOrganizationId,
        invitedAt: input.issuedAt,
      })),
    });
  }

  /** One RFQ of the caller's organization (the tenant guard's), or null. */
  findRfq(id: string, tx: ExtendedPrismaClient = this.prisma.client): Promise<Rfq | null> {
    return tx.rfq.findFirst({ where: { id } });
  }

  /** One RFQ, locked for the rest of the transaction, or null when it is not the caller's. */
  async lockRfq(tx: ExtendedPrismaClient, organizationId: string, id: string): Promise<Rfq | null> {
    await tx.$queryRaw`
      SELECT 1 FROM rfq WHERE organization_id = ${organizationId} AND id = ${id} FOR UPDATE`;
    return tx.rfq.findFirst({ where: { organizationId, id } });
  }

  /** The RFQ as the buyer reads it: with its criteria and invitations. */
  async buyerRecord(rfq: Rfq, tx: ExtendedPrismaClient = this.prisma.client): Promise<RfqRecord> {
    const [criteria, invitations] = await Promise.all([
      tx.rfqCriterion.findMany({
        where: { organizationId: rfq.organizationId, rfqId: rfq.id },
        orderBy: { position: 'asc' },
      }),
      tx.rfqInvitation.findMany({
        where: { organizationId: rfq.organizationId, rfqId: rfq.id },
        orderBy: { supplierOrganizationId: 'asc' },
      }),
    ]);
    return { rfq, criteria, invitations };
  }

  /** The caller organization's RFQs, newest first. */
  listRfqs(filter: RfqPageFilter): Promise<Rfq[]> {
    return this.prisma.client.rfq.findMany({
      where: {
        ...(filter.status ? { status: filter.status } : {}),
        ...(filter.cursor ? { id: { lt: filter.cursor } } : {}),
      },
      orderBy: { id: 'desc' },
      take: filter.limit + 1,
    });
  }

  /** The criteria of each RFQ of a page, by RFQ id. */
  async criteriaOf(rfqs: readonly Rfq[], unscoped: boolean): Promise<Map<string, RfqCriterion[]>> {
    const byRfq = new Map<string, RfqCriterion[]>(rfqs.map((rfq) => [rfq.id, []]));
    if (rfqs.length === 0) return byRfq;
    const read = () =>
      this.prisma.client.rfqCriterion.findMany({
        where: {
          OR: rfqs.map((rfq) => ({ organizationId: rfq.organizationId, rfqId: rfq.id })),
        },
        orderBy: [{ rfqId: 'asc' }, { position: 'asc' }],
      });
    const rows = unscoped
      ? await runUnscoped(
          'an invited supplier reads the criteria of the RFQs it is invited to (ADR-070 § 10): each named by its buyer and id, both read from an invitation of the caller organization',
          read,
        )
      : await read();
    for (const row of rows) byRfq.get(row.rfqId)?.push(row);
    return byRfq;
  }

  /** The invitations of each RFQ of the caller organization's page, by RFQ id. */
  async invitationsOf(rfqs: readonly Rfq[]): Promise<Map<string, RfqInvitation[]>> {
    const byRfq = new Map<string, RfqInvitation[]>(rfqs.map((rfq) => [rfq.id, []]));
    if (rfqs.length === 0) return byRfq;
    const rows = await this.prisma.client.rfqInvitation.findMany({
      where: { rfqId: { in: rfqs.map((rfq) => rfq.id) } },
      orderBy: [{ rfqId: 'asc' }, { supplierOrganizationId: 'asc' }],
    });
    for (const row of rows) byRfq.get(row.rfqId)?.push(row);
    return byRfq;
  }

  /**
   * One RFQ as an invited supplier reads it, or null when it does not invite `supplierOrganizationId`
   * — the organization the token names. Crosses the tenant guard: the RFQ is its buyer's.
   */
  async invitedRecord(supplierOrganizationId: string, id: string): Promise<RfqRecord | null> {
    return runUnscoped(
      'an invited supplier reads an RFQ it is invited to (ADR-070 § 10); the predicate is its own invitation, from the organization the token names',
      async () => {
        const invitation = await this.prisma.client.rfqInvitation.findFirst({
          where: { rfqId: id, supplierOrganizationId },
        });
        if (!invitation) return null;
        const rfq = await this.prisma.client.rfq.findFirst({
          where: { organizationId: invitation.organizationId, id },
        });
        if (!rfq) return null;
        const criteria = await this.prisma.client.rfqCriterion.findMany({
          where: { organizationId: rfq.organizationId, rfqId: rfq.id },
          orderBy: { position: 'asc' },
        });
        return { rfq, criteria };
      },
    );
  }

  /** The RFQs that invite `supplierOrganizationId`, newest first. Crosses the tenant guard. */
  async listInvited(supplierOrganizationId: string, filter: RfqPageFilter): Promise<Rfq[]> {
    return runUnscoped(
      'an invited supplier lists the RFQs it is invited to (ADR-070 § 10); the predicate is its own invitations, from the organization the token names',
      async () => {
        const ids = await this.prisma.client.$queryRaw<{ id: string }[]>`
          SELECT r.id FROM rfq_invitation i
            JOIN rfq r ON r.organization_id = i.organization_id AND r.id = i.rfq_id
           WHERE i.supplier_organization_id = ${supplierOrganizationId}
             AND (${filter.status ?? null}::text IS NULL OR r.status = ${filter.status ?? null}::text)
             AND (${filter.cursor ?? null}::text IS NULL OR r.id < ${filter.cursor ?? null}::text)
           ORDER BY r.id DESC
           LIMIT ${filter.limit + 1}`;
        if (ids.length === 0) return [];
        const rows = await this.prisma.client.rfq.findMany({
          where: { id: { in: ids.map((row) => row.id) } },
        });
        return rows.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
      },
    );
  }

  /**
   * The one compare-and-set every RFQ change goes through: the organization, the id, the status and
   * the version it read in the predicate, the version moved by one.
   */
  async moveRfq(
    tx: ExtendedPrismaClient,
    rfq: Rfq,
    to: RfqStateName,
    change: {
      closedAt?: Date;
      closedBy?: string | null;
      cancelledAt?: Date;
      cancelledBy?: string;
      cancelReasonCode?: string;
      cancelReason?: string | null;
      updatedAt: Date;
    },
  ): Promise<Rfq> {
    const { count } = await tx.rfq.updateMany({
      where: {
        organizationId: rfq.organizationId,
        id: rfq.id,
        status: rfq.status,
        version: rfq.version,
      },
      data: { ...change, status: to, version: rfq.version + 1 },
    });
    if (count !== 1) throw RastaError.optimisticLockFailed('Rfq', rfq.id);
    const after = await tx.rfq.findFirst({
      where: { organizationId: rfq.organizationId, id: rfq.id },
    });
    if (!after) throw new Error(`rfq ${rfq.id} vanished inside its own transaction`);
    return after;
  }

  // ---- the close sweeper's queue --------------------------------------------------------------

  /**
   * Claims up to `limit` PUBLISHED RFQs past `quotation_closing_at` on the database's clock, not
   * under a live lease nor in a failed attempt's backoff, earliest deadline first, in one statement
   * (`FOR UPDATE SKIP LOCKED`: two sweepers never queue on the same rows, and an RFQ a command holds
   * locked is claimed on the next sweep). A first cut, not the decision: the deadline is judged
   * again after the RFQ is locked.
   */
  claimDue(limit: number, leaseSeconds: number, fence: string): Promise<ClaimedRfq[]> {
    return runUnscoped(
      'the RFQ close sweeper claims PUBLISHED RFQs past their deadline of every tenant; each is then closed in its own tenant (ADR-070 § 3)',
      () =>
        this.prisma.client.$queryRawUnsafe<ClaimedRfq[]>(
          `UPDATE "rfq"
              SET "sweep_lease_until" = clock_timestamp() + ($2::int * interval '1 second'),
                  "sweep_fence" = $3
            WHERE "id" IN (
                  SELECT "id" FROM "rfq"
                   WHERE "status" = 'PUBLISHED' AND "quotation_closing_at" <= clock_timestamp()
                     AND ("sweep_lease_until" IS NULL OR "sweep_lease_until" <= clock_timestamp())
                     AND ("sweep_next_attempt_at" IS NULL OR "sweep_next_attempt_at" <= clock_timestamp())
                   ORDER BY "quotation_closing_at", "id"
                   LIMIT $1
                     FOR UPDATE SKIP LOCKED)
        RETURNING "id", "organization_id" AS "organizationId", "sweep_fence" AS "fence"`,
          limit,
          leaseSeconds,
          fence,
        ),
    );
  }

  /** Lets go of the claim; its failures are forgotten. Only the holder's fence matches. */
  async release(
    tx: ExtendedPrismaClient,
    rfq: { organizationId: string; id: string },
    fence: string,
  ) {
    await tx.$executeRaw`
      UPDATE rfq
         SET sweep_lease_until = NULL, sweep_fence = NULL, sweep_attempts = 0,
             sweep_next_attempt_at = NULL
       WHERE organization_id = ${rfq.organizationId} AND id = ${rfq.id} AND sweep_fence = ${fence}`;
  }

  /**
   * A failed attempt: counted, the claim given back, and the next try pushed out by
   * `min(maxSeconds, baseSeconds × 2^attempts)` on the database's clock. Only the holder's fence.
   */
  async recordFailure(
    tx: ExtendedPrismaClient,
    input: {
      organizationId: string;
      id: string;
      fence: string;
      baseSeconds: number;
      maxSeconds: number;
    },
  ): Promise<void> {
    await tx.$executeRaw`
      UPDATE rfq
         SET sweep_attempts = sweep_attempts + 1,
             sweep_next_attempt_at = clock_timestamp() + interval '1 second'
                 * LEAST(${input.maxSeconds}::double precision,
                         ${input.baseSeconds}::double precision * power(2, LEAST(sweep_attempts, 30))),
             sweep_lease_until = NULL,
             sweep_fence = NULL
       WHERE organization_id = ${input.organizationId} AND id = ${input.id}
         AND sweep_fence = ${input.fence}`;
  }

  /** Sampled for the gauges: how many RFQs are past their deadline and still PUBLISHED, for how long. */
  async closeBacklog(): Promise<RfqCloseBacklog> {
    const rows = await runUnscoped(
      'the RFQ close gauges count the PUBLISHED RFQs past their deadline of every tenant (ADR-070 § 3)',
      () =>
        this.prisma.client.$queryRawUnsafe<{ due: bigint; oldest: number | null }[]>(
          `SELECT count(*) AS due,
                  extract(epoch FROM clock_timestamp() - min("quotation_closing_at")) AS oldest
             FROM "rfq"
            WHERE "status" = 'PUBLISHED' AND "quotation_closing_at" <= clock_timestamp()`,
        ),
    );
    const row = rows[0];
    return {
      due: Number(row?.due ?? 0),
      oldestDueAgeSeconds: Math.max(0, Number(row?.oldest ?? 0)),
    };
  }
}
