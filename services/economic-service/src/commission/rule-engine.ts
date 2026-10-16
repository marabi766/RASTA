import type { BusinessLine } from '@rasta/contracts';
import { clampCommission, commissionFor } from '../shared/money';

/**
 * The commission engine (docs/10 § 10.7, ADR-023).
 *
 * **CONSTRAINT, from the product document:** "تعیین درصد دقیق کارمزد در هر نوع
 * تراکنش، ساختگی و پیشینی نیست و باید پس از بررسی هزینه واقعی … و الزامات
 * قانونی تعیین شود."
 *
 * Which means the only number this file may produce is one that came from a
 * `commission_rule` row. There is no fallback rate, no default, and no
 * "reasonable" percentage anywhere in this service — **no active rule means no
 * commission**, and that is a result rather than an error (docs/10 § 10.7).
 *
 * Everything here is pure. Rules go in, a decision comes out, and the decision
 * carries the rule it came from so the charge stays explicable after the rule
 * has been superseded.
 */

export interface CommissionRuleView {
  id: string;
  organizationId: string | null;
  /** NULL only on a type-only rule from before ADR-045 (docs/23 D-057). */
  businessLine: BusinessLine | null;
  /** The whole line when NULL. */
  transactionType: string | null;
  rateBasisPoints: number;
  minAmountMinor: bigint | null;
  maxAmountMinor: bigint | null;
  validFrom: Date;
  validTo: Date | null;
  status: string;
}

export interface CommissionDecision {
  /** The rule that produced it, or null when none matched. */
  ruleId: string | null;
  rateBasisPoints: number;
  amountMinor: bigint;
  /** False when no rule matched — a zero that means "unconfigured", not "free". */
  matched: boolean;
  /** `matched`, as the outcome the commission row and its event carry. */
  outcome: CommissionOutcome;
}

/** What the commission step decided (ADR-045 § 2), recorded on every commission row. */
export const COMMISSION_OUTCOMES = ['RULE_APPLIED', 'NO_ACTIVE_RULE'] as const;

export type CommissionOutcome = (typeof COMMISSION_OUTCOMES)[number];

/** What a rule is matched against: whose transaction, and what it is. */
export interface CommissionSubject {
  organizationId: string;
  /** NULL where the source sent none (docs/24 Q-130). */
  businessLine: BusinessLine | null;
  transactionType: string;
}

/**
 * Whether a rule is written for what this transaction is (ADR-045 § 2;
 * docs/23 D-057).
 *
 * A transaction with a line is priced only by rules for that line — the whole
 * line, or the line narrowed to its type. A transaction without one is priced
 * only by the type-only rules that predate business lines, as it was before
 * them. The two never mix: a line rule does not reach a transaction whose
 * source sent no line (that would be inferring the line ADR-045 forbids
 * inferring), and an old type-only rule does not reach a transaction that has
 * one (that would give the old rule a meaning it was not written with).
 */
export function coversSubject(rule: CommissionRuleView, subject: CommissionSubject): boolean {
  if (subject.businessLine === null) {
    return rule.businessLine === null && rule.transactionType === subject.transactionType;
  }
  return (
    rule.businessLine === subject.businessLine &&
    (rule.transactionType === null || rule.transactionType === subject.transactionType)
  );
}

/**
 * Picks the rule in force for a transaction, at the moment it occurred.
 *
 * The ordering, in the order it is applied:
 *
 *   1. **The rule must be ACTIVE and valid at `occurredAt`** — not at *now*.
 *      This is what makes an old transaction recomputable at the rate that
 *      applied when it happened, which docs/10 § 10.7 requires and docs/10 §
 *      10.12 tests ("نرخ زمان تراکنش اعمال می‌شود، نه نرخ فعلی"). Settling a
 *      three-week-old obligation at today's rate would silently repricing work
 *      that was agreed under the old one.
 *
 *   2. **The rule must be written for what the transaction is**
 *      ({@link coversSubject}): its business line, or — for a transaction
 *      without one — its type alone.
 *
 *   3. **An organization-specific rule beats a platform-wide one.** That is
 *      how a negotiated arrangement is expressed without branching the code
 *      (docs/10 § 10.7).
 *
 *   4. **A rule narrowed to the transaction's type beats one for its whole
 *      line.** The narrower statement is the more deliberate one (docs/23
 *      D-057).
 *
 *   5. **Among equals, the latest `validFrom` wins.** Overlapping rules at the
 *      same specificity are a configuration mistake rather than a modelled
 *      case — the database cannot express "no two active rules may overlap in
 *      time" without an exclusion constraint and `btree_gist`, which is not
 *      installed. Choosing deterministically means the same transaction always
 *      gets the same rate, so a misconfiguration is a wrong number rather than
 *      a *varying* number, and `commission.rateBasisPoints` records which one
 *      was used.
 *
 * `validTo` is exclusive: a rule valid to midnight does not apply at midnight.
 * Half-open intervals are what let a replacement rule start exactly where its
 * predecessor ends without a one-instant overlap or a one-instant gap.
 */
export function selectRule(
  rules: readonly CommissionRuleView[],
  subject: CommissionSubject,
  occurredAt: Date,
): CommissionRuleView | null {
  const applicable = rules.filter(
    (rule) =>
      rule.status === 'ACTIVE' &&
      (rule.organizationId === null || rule.organizationId === subject.organizationId) &&
      coversSubject(rule, subject) &&
      rule.validFrom.getTime() <= occurredAt.getTime() &&
      (rule.validTo === null || rule.validTo.getTime() > occurredAt.getTime()),
  );

  if (applicable.length === 0) return null;

  const [winner] = applicable.sort((a, b) => {
    const specificity = specificityOf(b) - specificityOf(a);
    if (specificity !== 0) return specificity;
    const narrowing = narrownessOf(b) - narrownessOf(a);
    if (narrowing !== 0) return narrowing;
    return b.validFrom.getTime() - a.validFrom.getTime();
  });

  // `applicable` is non-empty here, so this is defensive only — but returning
  // null on the impossible branch means "no rule matched", which is the safe
  // reading: no commission rather than a rate nobody chose.
  return winner ?? null;
}

function specificityOf(rule: CommissionRuleView): number {
  return rule.organizationId === null ? 0 : 1;
}

/** A line rule narrowed to one transaction type, over one for the whole line. */
function narrownessOf(rule: CommissionRuleView): number {
  return rule.businessLine !== null && rule.transactionType !== null ? 1 : 0;
}

/**
 * The commission for one transaction.
 *
 * With no matching rule the answer is a *zero decision*, not an exception and
 * not a guess: `{ ruleId: null, rateBasisPoints: 0, amountMinor: 0n, matched:
 * false, outcome: 'NO_ACTIVE_RULE' }`. The outcome is what lets the caller and the metrics tell "no rule is
 * configured" apart from "a rule is configured at zero" — two facts that look
 * identical if only the amount is kept, and that mean opposite things to
 * whoever has to answer why the platform earned nothing this month.
 *
 * Rounding is half-up on the absolute value, through the platform's single
 * shared implementation (`applyBasisPoints` in `@rasta/contracts`, ADR-022).
 * One rounding rule for the whole platform is the point: a commission computed
 * here and re-checked in analytics must agree to the rial.
 */
export function computeCommission(
  rules: readonly CommissionRuleView[],
  input: CommissionSubject & { occurredAt: Date; grossAmountMinor: bigint; currency: string },
): CommissionDecision {
  const rule = selectRule(rules, input, input.occurredAt);

  if (!rule) {
    return {
      ruleId: null,
      rateBasisPoints: 0,
      amountMinor: 0n,
      matched: false,
      outcome: 'NO_ACTIVE_RULE',
    };
  }

  const raw = commissionFor(input.grossAmountMinor, input.currency, rule.rateBasisPoints);
  const amountMinor = clampCommission(raw, input.grossAmountMinor, {
    minMinor: rule.minAmountMinor,
    maxMinor: rule.maxAmountMinor,
  });

  return {
    ruleId: rule.id,
    rateBasisPoints: rule.rateBasisPoints,
    amountMinor,
    matched: true,
    outcome: 'RULE_APPLIED',
  };
}
