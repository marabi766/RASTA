import { Injectable } from '@nestjs/common';
import { ulid } from 'ulid';
import { ID_PREFIXES } from '@rasta/contracts';
import { RastaError, getContext, getOrganizationId, runUnscoped } from '@rasta/nest-common';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { computeCommission, type CommissionDecision, type CommissionRuleView } from './rule-engine';
import { ECONOMIC_EVENTS } from '../events/events';
import { formatMinor, parseMinor } from '../shared/money';
import { commissionApplicationsTotal } from '../observability/metrics';
import { SERVICE_NAME } from '../config/env';
import type { Prisma, TransactionType } from '../generated/prisma';
import type { CreateCommissionRuleDto, UpdateCommissionRuleDto } from './dto';

/**
 * Commission: the rules, and what they produced (docs/10 § 10.7, ADR-023).
 *
 * ## The rule this service exists to keep
 *
 * **No rate is hard-coded, anywhere.** Not a default, not a fallback, not a
 * "reasonable" figure for a demo. Every number comes from a `commission_rule`
 * row, and with no matching row the commission is zero — a result, not an
 * error and not a guess. docs/24 Q-08 is open, and the answer to it will be an
 * INSERT rather than a deployment.
 *
 * ## Why rules are not automatically tenant-scoped
 *
 * A rule with `organizationId = NULL` is platform-wide. The tenant guard
 * injects `organization_id = X`, which matches no global rule at all, so a
 * scoped read would find nothing and every transaction would be charged zero.
 * Scoping is therefore explicit here — `{ OR: [null, X] }` — and the isolation
 * it has to provide is proven by `tenant-isolation.int-spec.ts` rather than
 * inherited.
 */
@Injectable()
export class CommissionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
  ) {}

  // ==========================================================================
  // Rules
  // ==========================================================================

  /**
   * The rules that could apply to one transaction.
   *
   * Explicitly scoped: platform-wide rules, plus this organization's own.
   * Never another organization's — a negotiated rate is commercially sensitive,
   * and `tenant-isolation.int-spec.ts` proves organization B cannot read
   * organization A's.
   */
  private candidateRules(
    tx: ExtendedPrismaClient,
    organizationId: string,
    transactionType: TransactionType,
  ) {
    return runUnscoped(
      'commission rules are platform-wide or organization-specific; scoping is explicit below',
      () =>
        tx.commissionRule.findMany({
          where: {
            transactionType,
            status: 'ACTIVE',
            OR: [{ organizationId: null }, { organizationId }],
          },
        }),
    );
  }

  /**
   * What commission a transaction attracts, at the rate in force when it
   * occurred.
   *
   * `occurredAt`, never `now`. Settling a three-week-old obligation at today's
   * rate would silently reprice work that was agreed under the old one —
   * docs/10 § 10.12 makes this a mandatory test.
   */
  async decide(
    tx: ExtendedPrismaClient,
    input: {
      organizationId: string;
      transactionType: TransactionType;
      occurredAt: Date;
      grossAmountMinor: bigint;
      currency: string;
    },
  ): Promise<CommissionDecision> {
    const rules = await this.candidateRules(tx, input.organizationId, input.transactionType);

    const decision = computeCommission(rules as CommissionRuleView[], {
      organizationId: input.organizationId,
      occurredAt: input.occurredAt,
      grossAmountMinor: input.grossAmountMinor,
      currency: input.currency,
    });

    commissionApplicationsTotal.inc({
      service: SERVICE_NAME,
      type: input.transactionType,
      matched: String(decision.matched),
    });

    return decision;
  }

  /**
   * Records the commission actually charged, inside the settlement transaction.
   *
   * A zero commission still writes a row. It is evidence: "this transaction was
   * settled and no rule matched" is a fact an auditor needs, and its absence
   * would be indistinguishable from a settlement that skipped the commission
   * step entirely.
   *
   * The revenue *journal leg* is not posted here — it is part of the single
   * settlement journal, so that escrow, payee and commission move together or
   * not at all (ADR-031). This method records the commission and announces it.
   */
  async record(
    tx: ExtendedPrismaClient,
    input: {
      transactionId: string;
      organizationId: string;
      decision: CommissionDecision;
      grossAmountMinor: bigint;
      currency: string;
      journalId: string;
      appliedAt: Date;
    },
  ): Promise<{ id: string }> {
    const id = `${ID_PREFIXES.commission}_${ulid()}`;

    await runUnscoped('commission is charged to the payee organization, not to the caller', () =>
      tx.commission.create({
        data: {
          id,
          organizationId: input.organizationId,
          transactionId: input.transactionId,
          ruleId: input.decision.ruleId,
          rateBasisPoints: input.decision.rateBasisPoints,
          grossAmountMinor: input.grossAmountMinor,
          amountMinor: input.decision.amountMinor,
          currency: input.currency,
          journalId: input.journalId,
          appliedAt: input.appliedAt,
        },
      }),
    );

    await this.ledger.enqueue(tx, {
      eventName: ECONOMIC_EVENTS.COMMISSION_APPLIED,
      aggregateId: id,
      organizationId: input.organizationId,
      // Partitioned by transaction, not by commission id: a consumer
      // reconciling one transaction sees its commission in order with the
      // settlement that produced it.
      partitionKey: input.transactionId,
      payload: {
        commissionId: id,
        transactionId: input.transactionId,
        organizationId: input.organizationId,
        ruleId: input.decision.ruleId,
        rateBasisPoints: input.decision.rateBasisPoints,
        grossAmountMinor: formatMinor(input.grossAmountMinor),
        amountMinor: formatMinor(input.decision.amountMinor),
        currency: input.currency,
        appliedAt: input.appliedAt.toISOString(),
      },
    });

    return { id };
  }

  // ==========================================================================
  // Configuration
  // ==========================================================================

  /**
   * Creates a rule.
   *
   * Restricted to `SYSTEM_ADMIN` at the controller, because docs/10 § 10.7 and
   * ADR-023 both require a rate change to go through the steering group and be
   * recorded in the audit trail. The `label` is carried so that demonstration
   * data can say what it is — sample data must be labelled "نمونه — نیازمند
   * تصویب" and must never be mistaken for an approved rate.
   *
   * A platform-wide rule (`organizationId: null`) can only be written by a
   * caller acting for the platform organization; anything else would let one
   * tenant set the rate for all of them.
   */
  async createRule(dto: CreateCommissionRuleDto) {
    const actor = getContext().userId ?? SERVICE_NAME;
    const id = `CMR_${ulid()}`;

    const data: Prisma.CommissionRuleUncheckedCreateInput = {
      id,
      organizationId: dto.organizationId ?? null,
      transactionType: dto.transactionType,
      rateBasisPoints: dto.rateBasisPoints,
      minAmountMinor: dto.minAmountMinor ? parseMinor(dto.minAmountMinor, 'minAmountMinor') : null,
      maxAmountMinor: dto.maxAmountMinor ? parseMinor(dto.maxAmountMinor, 'maxAmountMinor') : null,
      validFrom: dto.validFrom ? new Date(dto.validFrom) : new Date(),
      validTo: dto.validTo ? new Date(dto.validTo) : null,
      status: dto.status ?? 'ACTIVE',
      label: dto.label ?? null,
      createdBy: actor,
      updatedBy: actor,
    };

    if (data.validTo && data.validTo <= data.validFrom) {
      throw RastaError.businessRule('validTo must be after validFrom');
    }

    return runUnscoped(
      'a commission rule may be platform-wide, which no tenant scope can express',
      () => this.prisma.client.commissionRule.create({ data }),
    );
  }

  async updateRule(id: string, dto: UpdateCommissionRuleDto) {
    const actor = getContext().userId ?? SERVICE_NAME;

    const existing = await runUnscoped('commission rules may be platform-wide', () =>
      this.prisma.client.commissionRule.findUnique({ where: { id } }),
    );
    if (!existing) throw RastaError.notFound('CommissionRule', id);

    return runUnscoped('commission rules may be platform-wide', () =>
      this.prisma.client.commissionRule.update({
        where: { id },
        data: {
          ...(dto.rateBasisPoints !== undefined ? { rateBasisPoints: dto.rateBasisPoints } : {}),
          ...(dto.status !== undefined ? { status: dto.status } : {}),
          ...(dto.validTo !== undefined
            ? { validTo: dto.validTo ? new Date(dto.validTo) : null }
            : {}),
          ...(dto.label !== undefined ? { label: dto.label } : {}),
          updatedBy: actor,
        },
      }),
    );
  }

  /**
   * Lists rules the caller may see.
   *
   * A tenant sees platform-wide rules and its own. It does not see another
   * organization's negotiated rate, which is why this is not a plain
   * `findMany`.
   */
  listRules(transactionType?: TransactionType) {
    const organizationId = getOrganizationId();
    return runUnscoped(
      'a tenant sees platform-wide rules and its own; the OR below is the scope',
      () =>
        this.prisma.client.commissionRule.findMany({
          where: {
            ...(transactionType ? { transactionType } : {}),
            OR: [{ organizationId: null }, { organizationId }],
          },
          orderBy: [{ transactionType: 'asc' }, { validFrom: 'desc' }],
        }),
    );
  }

  // ==========================================================================
  // Reads
  // ==========================================================================

  /**
   * Commission charged to the caller's organization.
   *
   * `GET /v1/commissions` in docs/06 § 6.10. Scoped by the tenant guard, so
   * one organization can never read another's charges.
   */
  listCommissions(limit: number, cursor?: string) {
    return this.prisma.client.commission.findMany({
      where: { organizationId: getOrganizationId() },
      orderBy: [{ appliedAt: 'desc' }, { id: 'desc' }],
      take: limit,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
  }
}
