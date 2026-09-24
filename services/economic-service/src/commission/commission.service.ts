import { Injectable } from '@nestjs/common';
import { ulid } from 'ulid';
import { ID_PREFIXES } from '@rasta/contracts';
import { RastaError, getContext, getOrganizationId, runUnscoped } from '@rasta/nest-common';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { computeCommission, type CommissionDecision, type CommissionRuleView } from './rule-engine';
import { ECONOMIC_EVENTS } from '../events/events';
import { formatMinor, parseMinor } from '../shared/money';
import { nextValidTo } from '../shared/rule-validity';
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

    return this.prisma.transaction(async (tx) => {
      const created = await runUnscoped(
        'a commission rule may be platform-wide, which no tenant scope can express',
        () => tx.commissionRule.create({ data }),
      );
      await this.recordRuleChange(tx, { rule: created, before: null, actor });
      return created;
    });
  }

  /**
   * Closes, deactivates or relabels a rule — and nothing else.
   *
   * **The rate is not editable.** The rule engine selects a rule by when the
   * transaction occurred but reads its rate when the transaction settles, so
   * a rate edited in place re-priced every unsettled transaction that had
   * occurred under the old one. A new rate is a new rule: close this one with
   * `validTo`, create the next with `validFrom` at the same instant (docs/10 §
   * 10.7). `updateCommissionRuleSchema` refuses the field outright, and the
   * window may only move forward ({@link nextValidTo}).
   *
   * Under the row lock, so the `before` in the change record is the state this
   * change was actually applied to.
   */
  async updateRule(id: string, dto: UpdateCommissionRuleDto) {
    const actor = getContext().userId ?? SERVICE_NAME;

    return this.prisma.transaction(async (tx) => {
      const locked = await runUnscoped(
        'commission rules may be platform-wide',
        () =>
          tx.$queryRaw<
            { id: string }[]
          >`SELECT id FROM commission_rule WHERE id = ${id} FOR UPDATE`,
      );
      if (locked.length === 0) throw RastaError.notFound('CommissionRule', id);

      const existing = await runUnscoped('commission rules may be platform-wide', () =>
        tx.commissionRule.findUniqueOrThrow({ where: { id } }),
      );

      const updated = await runUnscoped('commission rules may be platform-wide', () =>
        tx.commissionRule.update({
          where: { id },
          data: {
            ...(dto.status !== undefined ? { status: dto.status } : {}),
            ...(dto.validTo !== undefined
              ? { validTo: nextValidTo(existing, dto.validTo, new Date()) }
              : {}),
            ...(dto.label !== undefined ? { label: dto.label } : {}),
            updatedBy: actor,
          },
        }),
      );

      await this.recordRuleChange(tx, { rule: updated, before: existing, actor });
      return updated;
    });
  }

  /**
   * The audit record of a rule change: who, when, and the terms before and
   * after (`COMMISSION_RULE_CHANGED`).
   *
   * In the same transaction as the change, so a rule never changes without its
   * record and a record never describes a change that rolled back. The envelope
   * tenant is the rule's own organization, or — for a platform-wide rule, which
   * has none — the organization the administrator acted from.
   */
  private async recordRuleChange(
    tx: ExtendedPrismaClient,
    input: { rule: CommissionRuleRow; before: CommissionRuleRow | null; actor: string },
  ): Promise<void> {
    await this.ledger.enqueue(tx, {
      eventName: ECONOMIC_EVENTS.COMMISSION_RULE_CHANGED,
      aggregateId: input.rule.id,
      organizationId: input.rule.organizationId ?? getOrganizationId(),
      payload: {
        ruleId: input.rule.id,
        change: input.before ? 'UPDATED' : 'CREATED',
        changedBy: input.actor,
        changedAt: input.rule.updatedAt.toISOString(),
        before: input.before ? commissionRuleTerms(input.before) : null,
        after: commissionRuleTerms(input.rule),
      },
    });
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

type CommissionRuleRow = Prisma.CommissionRuleGetPayload<Record<string, never>>;

/** A rule's terms as the change record carries them: money as strings, times as ISO. */
function commissionRuleTerms(rule: CommissionRuleRow) {
  return {
    organizationId: rule.organizationId,
    transactionType: rule.transactionType,
    rateBasisPoints: rule.rateBasisPoints,
    minAmountMinor: rule.minAmountMinor === null ? null : formatMinor(rule.minAmountMinor),
    maxAmountMinor: rule.maxAmountMinor === null ? null : formatMinor(rule.maxAmountMinor),
    validFrom: rule.validFrom.toISOString(),
    validTo: rule.validTo ? rule.validTo.toISOString() : null,
    status: rule.status,
    label: rule.label,
  };
}
