import { Injectable } from '@nestjs/common';
import { ulid } from 'ulid';
import { ID_PREFIXES } from '@rasta/contracts';
import { RastaError, getContext, getOrganizationId, runUnscoped } from '@rasta/nest-common';
import { PrismaService, type ExtendedPrismaClient } from '../prisma/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import {
  computeCommission,
  NO_ACTIVE_RULE_DECISION,
  priceWithRule,
  pricingSubjectAt,
  type CommissionDecision,
  type CommissionOutcome,
  type CommissionRuleView,
  type CommissionSubject,
} from './rule-engine';
import { ECONOMIC_EVENTS } from '../events/events';
import { formatMinor, parseMinor } from '../shared/money';
import { nextValidTo } from '../shared/rule-validity';
import { after, resolveCursor } from '../shared/cursor';
import { commissionApplicationsTotal } from '../observability/metrics';
import { SERVICE_NAME } from '../config/env';
import type { BusinessLine, Prisma, TransactionType } from '../generated/prisma';
import type { CreateCommissionRuleDto, UpdateCommissionRuleDto } from './dto';

/**
 * Commission: the rules, and what they produced (docs/10 § 10.7, ADR-023).
 *
 * ## The rule this service exists to keep
 *
 * **No rate is hard-coded in this code.** Not a default, not a fallback, not a
 * "reasonable" figure. Every number comes from a `commission_rule` row, and
 * with no matching row the commission is zero and recorded as
 * `NO_ACTIVE_RULE` — a result, not an error and not a guess (ADR-045 § 2).
 * docs/24 Q-08 is open, and the answer to it will be an INSERT rather than a
 * deployment. The one rate in the repository is the demonstration seed's
 * 200 bps (`prisma/seed.ts`): written only behind its flag, labelled "نمونه —
 * نیازمند تصویب", and never a production default.
 *
 * ## What was in force stays what it was (docs/23 D-057)
 *
 * A rule is created from now on — never backdated — and its terms never
 * change. Its status is fixed once it has come into force: ending it is a
 * `validTo`, at or after the present, so the rules in force at any instant
 * already passed are a closed set. Two active rules of one scope never overlap
 * (the database refuses it). And an obligation records the rule it was priced
 * with when its source fact is recorded, so settlement charges that.
 *
 * ## Business lines (ADR-045, docs/23 D-057)
 *
 * A rule is written for a business line, optionally narrowed to one
 * transaction type; the source service states the line and never the rate
 * (ADR-045 § 4). Type-only rules from before business lines keep pricing the
 * transactions that carry no line, and nothing else.
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
  private candidateRules(tx: ExtendedPrismaClient, subject: CommissionSubject) {
    // What a rule must be written for (`coversSubject`, which the engine
    // applies again): the transaction's line — whole, or narrowed to its type
    // — or, for a transaction without one, its type alone (docs/23 D-057).
    const covers: Prisma.CommissionRuleWhereInput =
      subject.businessLine === null
        ? { businessLine: null, transactionType: subject.transactionType as TransactionType }
        : {
            businessLine: subject.businessLine,
            OR: [
              { transactionType: null },
              { transactionType: subject.transactionType as TransactionType },
            ],
          };
    return runUnscoped(
      'commission rules are platform-wide or organization-specific; scoping is explicit below',
      () =>
        tx.commissionRule.findMany({
          where: {
            AND: [
              covers,
              { status: 'ACTIVE' },
              { OR: [{ organizationId: null }, { organizationId: subject.organizationId }] },
            ],
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
   * docs/10 § 10.12 makes this a mandatory test. A fact that occurred before
   * the pricing cutover is matched as it was before business lines
   * ({@link pricingSubjectAt}).
   *
   * Called when the source fact is recorded, which is when the obligation's
   * pricing is fixed ({@link pricingOf}); and at settlement only for an
   * obligation recorded before that existed.
   *
   * **Under the scope locks** (Codex round 2 on #307, R2). The rules are read
   * only once this transaction holds the platform's and the tenant's lock for
   * the subject's scope, shared, and the locks last until it commits — with
   * the pricing it records. A change to those rules holds the same lock
   * exclusively ({@link lockScopeForChange}), so it either committed before
   * this read, and is seen, or waits until the pricing is recorded. The lock
   * exists whether or not a rule does, so a rule being created is waited for
   * too. `tx` must be a transaction: outside one the lock would end with the
   * statement.
   */
  async decide(
    tx: ExtendedPrismaClient,
    input: {
      organizationId: string;
      transactionType: TransactionType;
      businessLine: BusinessLine | null;
      occurredAt: Date;
      grossAmountMinor: bigint;
      currency: string;
    },
  ): Promise<CommissionDecision> {
    const subject = pricingSubjectAt(input, input.occurredAt, await this.linePricingFrom(tx));
    await tx.$executeRaw`SELECT commission_pricing_scope_lock(
      ${subject.organizationId}, ${subject.businessLine}::"BusinessLine",
      ${subject.transactionType}::"TransactionType")`;
    const rules = await this.candidateRules(tx, subject);
    return computeCommission(rules as CommissionRuleView[], { ...input, ...subject });
  }

  /**
   * The pricing an obligation records with its source fact: the rule, or that
   * none matched. Stored on the transaction and never changed
   * (`trg_transaction_pricing_fixed`).
   */
  async pricingOf(
    tx: ExtendedPrismaClient,
    input: Parameters<CommissionService['decide']>[1],
  ): Promise<{ pricingOutcome: CommissionOutcome; pricingRuleId: string | null }> {
    const decision = await this.decide(tx, input);
    return { pricingOutcome: decision.outcome, pricingRuleId: decision.ruleId };
  }

  /**
   * The commission an obligation is charged at settlement.
   *
   * What was recorded with its source fact decides: that rule's terms — whatever
   * its status or window has become since — or nothing, when none matched then.
   * Only an obligation recorded before pricing was recorded (`pricingOutcome`
   * null) is decided now, at its `occurredAt`, as it always was.
   */
  async chargeFor(
    tx: ExtendedPrismaClient,
    input: Parameters<CommissionService['decide']>[1] & {
      pricingOutcome: CommissionOutcome | null;
      pricingRuleId: string | null;
    },
  ): Promise<CommissionDecision> {
    if (input.pricingOutcome === null) return this.decide(tx, input);
    if (input.pricingOutcome === 'NO_ACTIVE_RULE') return NO_ACTIVE_RULE_DECISION;
    if (!input.pricingRuleId) {
      throw RastaError.internal('A transaction priced by a rule does not name the rule');
    }
    const ruleId = input.pricingRuleId;
    const rule = await runUnscoped(
      'the rule an obligation was priced with may be platform-wide',
      () => tx.commissionRule.findUnique({ where: { id: ruleId } }),
    );
    // RESTRICT keeps the rule while a transaction names it; this is the
    // impossible branch, and it fails rather than charging something else.
    if (!rule) throw RastaError.internal('The rule a transaction was priced with is missing');
    return priceWithRule(rule, input);
  }

  /**
   * The instant line rules began to price, as its migration recorded it.
   *
   * Read once: the row is fixed (`trg_commission_pricing_cutover_fixed`). A
   * database without it is not one this code may price against, so it fails
   * rather than guessing a side of the cutover.
   */
  private async linePricingFrom(tx: ExtendedPrismaClient): Promise<Date> {
    if (this.cutover) return this.cutover;
    const row = await runUnscoped('the pricing cutover is platform configuration', () =>
      tx.commissionPricingCutover.findUnique({ where: { id: 1 } }),
    );
    if (!row) throw RastaError.internal('The commission pricing cutover is not recorded');
    this.cutover = row.linePricingFrom;
    return this.cutover;
  }

  private cutover: Date | null = null;

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
      transactionType: TransactionType;
      businessLine: BusinessLine | null;
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
          businessLine: input.businessLine,
          outcome: input.decision.outcome,
          rateBasisPoints: input.decision.rateBasisPoints,
          grossAmountMinor: input.grossAmountMinor,
          amountMinor: input.decision.amountMinor,
          currency: input.currency,
          journalId: input.journalId,
          appliedAt: input.appliedAt,
        },
      }),
    );

    commissionApplicationsTotal.inc({
      service: SERVICE_NAME,
      type: input.transactionType,
      business_line: input.businessLine ?? 'NONE',
      matched: String(input.decision.matched),
    });

    await this.ledger.enqueue(tx, {
      eventName: ECONOMIC_EVENTS.COMMISSION_APPLIED,
      aggregateId: id,
      organizationId: input.organizationId,
      payload: {
        commissionId: id,
        transactionId: input.transactionId,
        organizationId: input.organizationId,
        ruleId: input.decision.ruleId,
        businessLine: input.businessLine,
        outcome: input.decision.outcome,
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
   *
   * **From now on, never backdated** (docs/23 D-057). `validFrom` defaults to
   * the database's clock and may not precede it: a rule inserted into the past
   * would reprice whatever occurred there. "Now" is read once the scope's lock
   * is held, so a create that waited for it cannot start in the time it waited
   * (Codex round 2 on #307, R1), and no pricing of the scope runs until it
   * commits (R2). And it may not overlap an active
   * rule of the same scope — the database refuses that
   * (`ex_commission_rule_*_no_overlap`), and two concurrent creates cannot
   * both pass; the loser is a 409.
   */
  async createRule(dto: CreateCommissionRuleDto) {
    const actor = getContext().userId ?? SERVICE_NAME;
    const id = `CMR_${ulid()}`;

    return this.prisma
      .transaction(async (tx) => {
        const now = await lockScopeForChange(tx, {
          organizationId: dto.organizationId ?? null,
          businessLine: dto.businessLine,
          transactionType: dto.transactionType ?? null,
        });
        const validFrom = dto.validFrom ? new Date(dto.validFrom) : now;
        const validTo = dto.validTo ? new Date(dto.validTo) : null;

        if (validFrom < now) {
          throw RastaError.businessRule(
            'A rule starts now or later, never in the past: a backdated rule would reprice what already occurred',
          );
        }
        if (validTo && validTo <= validFrom) {
          throw RastaError.businessRule('validTo must be after validFrom');
        }

        const data: Prisma.CommissionRuleUncheckedCreateInput = {
          id,
          organizationId: dto.organizationId ?? null,
          businessLine: dto.businessLine,
          transactionType: dto.transactionType ?? null,
          rateBasisPoints: dto.rateBasisPoints,
          minAmountMinor: dto.minAmountMinor
            ? parseMinor(dto.minAmountMinor, 'minAmountMinor')
            : null,
          maxAmountMinor: dto.maxAmountMinor
            ? parseMinor(dto.maxAmountMinor, 'maxAmountMinor')
            : null,
          validFrom,
          validTo,
          status: 'ACTIVE',
          label: dto.label ?? null,
          createdBy: actor,
          updatedBy: actor,
        };

        const created = await runUnscoped(
          'a commission rule may be platform-wide, which no tenant scope can express',
          () => tx.commissionRule.create({ data }),
        );
        await this.recordRuleChange(tx, { rule: created, before: null, actor });
        return created;
      })
      .catch(overlapAsConflict);
  }

  /**
   * Ends, withdraws, reinstates or relabels a rule — and nothing else.
   *
   * **The rate is not editable.** A new rate is a new rule: end this one with
   * `validTo`, create the next with `validFrom` at the same instant (docs/10 §
   * 10.7). `updateCommissionRuleSchema` refuses the field outright, and the
   * window may only move forward ({@link nextValidTo}).
   *
   * **Status is effective-dated** (docs/23 D-057, Codex round 1 on #307, F2).
   * A status flip on a rule in force would change what applied at instants
   * already passed — an unsettled obligation that occurred under it would fall
   * through to another rate or to none. So:
   *
   * - `INACTIVE` on a rule that has come into force **ends it now**: `validTo`
   *   becomes the database's present and the status stays. Before its start it
   *   withdraws the rule, which never applied to anything.
   * - `ACTIVE` reinstates a withdrawn rule only while its start is still ahead;
   *   after that it would apply retroactively to the time it was withdrawn.
   *
   * Every change is checked against the database clock as it reads once the
   * row and the scope are locked — after any wait for either (Codex round 2
   * on #307, R1) — and an extension or a reinstatement that would overlap an
   * active rule of the same scope is refused by the database (409).
   * `trg_commission_rule_effective_dated` holds the same rules, at the same
   * instant, for any writer that goes around this method.
   *
   * Under the row lock, so the `before` in the change record is the state this
   * change was actually applied to; and under the scope lock, so no pricing
   * reads the scope between this change and its commit (R2).
   */
  async updateRule(id: string, dto: UpdateCommissionRuleDto) {
    const actor = getContext().userId ?? SERVICE_NAME;

    return this.prisma
      .transaction(async (tx) => {
        // The row, then its scope — the order an UPDATE written around this
        // method takes them in, through the trigger. NO KEY: an obligation
        // being priced with this rule keys its row, and must not wait on it.
        const [locked] = await runUnscoped(
          'commission rules may be platform-wide',
          () =>
            tx.$queryRaw<ScopeOfRule[]>`
            SELECT organization_id AS "organizationId", business_line::TEXT AS "businessLine",
                   transaction_type::TEXT AS "transactionType"
              FROM commission_rule WHERE id = ${id} FOR NO KEY UPDATE`,
        );
        if (!locked) throw RastaError.notFound('CommissionRule', id);
        // After every wait: the instant this change is decided at (R1).
        const now = await lockScopeForChange(tx, locked);

        const existing = await runUnscoped('commission rules may be platform-wide', () =>
          tx.commissionRule.findUniqueOrThrow({ where: { id } }),
        );
        const change = effectiveDatedChange(existing, dto, now);

        const updated = await runUnscoped('commission rules may be platform-wide', () =>
          tx.commissionRule.update({
            where: { id },
            data: {
              ...change,
              ...(dto.label !== undefined ? { label: dto.label } : {}),
              updatedBy: actor,
            },
          }),
        );

        await this.recordRuleChange(tx, { rule: updated, before: existing, actor });
        return updated;
      })
      .catch(overlapAsConflict);
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
  listRules(filter: { businessLine?: BusinessLine; transactionType?: TransactionType } = {}) {
    const organizationId = getOrganizationId();
    return runUnscoped(
      'a tenant sees platform-wide rules and its own; the OR below is the scope',
      () =>
        this.prisma.client.commissionRule.findMany({
          where: {
            ...(filter.businessLine ? { businessLine: filter.businessLine } : {}),
            ...(filter.transactionType ? { transactionType: filter.transactionType } : {}),
            OR: [{ organizationId: null }, { organizationId }],
          },
          orderBy: [
            { businessLine: { sort: 'asc', nulls: 'last' } },
            { transactionType: { sort: 'asc', nulls: 'first' } },
            { validFrom: 'desc' },
            { id: 'asc' },
          ],
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
   * one organization can never read another's charges — including through
   * the cursor, which is resolved in the same scope as the page
   * (shared/cursor.ts).
   *
   * "The same scope" includes the filters: the tenant and the requested
   * `businessLine` / `outcome` form one predicate, and both the cursor lookup
   * and the page read through it. A cursor naming the caller's own commission
   * from another filtered view is therefore refused like an unknown or foreign
   * one, instead of being accepted as a boundary that silently skips the rows
   * of this view between it and the real last row seen (Codex review of #308).
   * Unlike a transaction's status, which the transactions list deliberately
   * leaves out of its cursor scope, a commission's line and outcome never
   * change (the row is append-only), so no row can leave the view mid-paging.
   */
  async listCommissions(
    limit: number,
    cursor?: string,
    filter: { businessLine?: BusinessLine; outcome?: CommissionOutcome } = {},
  ) {
    const scope = {
      organizationId: getOrganizationId(),
      ...(filter.businessLine ? { businessLine: filter.businessLine } : {}),
      ...(filter.outcome ? { outcome: filter.outcome } : {}),
    };
    const boundary = await resolveCursor(cursor, (id) =>
      this.prisma.client.commission
        .findFirst({ where: { ...scope, id }, select: { id: true, appliedAt: true } })
        .then((row) => (row ? { at: row.appliedAt, id: row.id } : null)),
    );
    return this.prisma.client.commission.findMany({
      where: boundary ? { ...scope, ...after('appliedAt', boundary) } : scope,
      orderBy: [{ appliedAt: 'desc' }, { id: 'desc' }],
      take: limit,
    });
  }
}

type CommissionRuleRow = Prisma.CommissionRuleGetPayload<Record<string, never>>;

/** What a rule's scope lock is named by: whose, which line — or, before lines, which type. */
interface ScopeOfRule {
  organizationId: string | null;
  businessLine: string | null;
  transactionType: string | null;
}

/**
 * Takes one scope's lock for a change to its rules, and returns the instant
 * the change is decided at (`commission_rule_scope_change`).
 *
 * Exclusive, so no pricing reads the scope's rules until this transaction has
 * committed or rolled back (Codex round 2 on #307, R2). The instant is the
 * database clock read once the lock is held — `clock_timestamp()`, never
 * `now()`, which is when the transaction began and can lie before the wait
 * (R1) — to the millisecond the rule columns keep. The same instant is what
 * `trg_commission_rule_effective_dated` decides by in this transaction, so the
 * service and the database never disagree about whether a rule has started
 * or ended; and an application host whose clock runs behind cannot place a
 * rule's start or end in the past.
 */
async function lockScopeForChange(tx: ExtendedPrismaClient, scope: ScopeOfRule): Promise<Date> {
  const [row] = await tx.$queryRaw<{ at: Date }[]>`
    SELECT commission_rule_scope_change(
      ${scope.organizationId}, ${scope.businessLine}::"BusinessLine",
      ${scope.transactionType}::"TransactionType") AT TIME ZONE 'UTC' AS at`;
  if (!row) throw RastaError.internal('The database did not report the change instant');
  return row.at;
}

/**
 * What a PATCH may do to a rule's window and status, at `now`
 * ({@link CommissionService.updateRule}).
 */
export function effectiveDatedChange(
  existing: { status: 'ACTIVE' | 'INACTIVE'; validFrom: Date; validTo: Date | null },
  dto: Pick<UpdateCommissionRuleDto, 'status' | 'validTo'>,
  now: Date,
): { status?: 'ACTIVE' | 'INACTIVE'; validTo?: Date | null } {
  const started = existing.validFrom <= now;
  const statusChange = dto.status !== undefined && dto.status !== existing.status;

  if (!statusChange) {
    return dto.validTo !== undefined ? { validTo: nextValidTo(existing, dto.validTo, now) } : {};
  }

  if (dto.status === 'INACTIVE') {
    if (!started) {
      // Withdrawn before it ever applied: nothing occurred under it.
      return dto.validTo !== undefined
        ? { status: 'INACTIVE', validTo: nextValidTo(existing, dto.validTo, now) }
        : { status: 'INACTIVE' };
    }
    if (dto.validTo !== undefined) {
      throw RastaError.businessRule(
        'Ending a rule in force is one change: send validTo, or status INACTIVE to end it now — not both',
      );
    }
    // In force: deactivating it is ending it now. The status stays, so what it
    // priced before this instant it still prices.
    return { validTo: nextValidTo(existing, now.toISOString(), now) };
  }

  if (started) {
    throw RastaError.businessRule(
      'A withdrawn rule whose start has passed cannot be reinstated: it would apply to the time it was withdrawn. Create a new rule',
    );
  }
  return dto.validTo !== undefined
    ? { status: 'ACTIVE', validTo: nextValidTo(existing, dto.validTo, now) }
    : { status: 'ACTIVE' };
}

/** The no-overlap constraints, by name: each is one scope's timeline. */
const NO_OVERLAP_CONSTRAINTS = [
  'ex_commission_rule_type_only_no_overlap',
  'ex_commission_rule_line_no_overlap',
  'ex_commission_rule_line_type_no_overlap',
] as const;

/**
 * An overlap the database refused is the caller's conflict, not a 500.
 *
 * Matched by constraint name in the driver's message, so another failure is
 * never mislabelled as this one.
 */
function overlapAsConflict(error: unknown): never {
  const message = (error as { message?: unknown } | null)?.message;
  if (
    typeof message === 'string' &&
    NO_OVERLAP_CONSTRAINTS.some((name) => message.includes(name))
  ) {
    throw new RastaError(
      'CONFLICT',
      'An active rule for the same organization, business line and transaction type is already in force for part of this period. End it first (validTo), then start this one where it ends',
    );
  }
  throw error;
}

/** A rule's terms as the change record carries them: money as strings, times as ISO. */
function commissionRuleTerms(rule: CommissionRuleRow) {
  return {
    organizationId: rule.organizationId,
    businessLine: rule.businessLine,
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
