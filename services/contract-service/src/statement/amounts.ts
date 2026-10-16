import { MAX_AMOUNT_MINOR, applyBasisPoints, money } from '@rasta/contracts';

/** A configured deduction as the statement applies it: the rule's id, name, rate and base. */
export interface ConfiguredDeduction {
  readonly id: string;
  readonly name: string;
  readonly rateBp: number;
  readonly base: string;
}

export interface StatementAmounts {
  readonly grossMinor: bigint;
  readonly deductions: readonly (ConfiguredDeduction & { readonly amountMinor: bigint })[];
  readonly deductionsMinor: bigint;
  readonly netMinor: bigint;
}

/** Why the amounts cannot be a statement: the closed reasons the service answers 422 with. */
export type AmountRefusal = 'STATEMENT_EXCEEDS_LIMIT' | 'STATEMENT_NET_NEGATIVE';

/**
 * The one place a statement's money is computed (ADR-068 § 5, "computed once"): the gross is the
 * sum of the lines, each deduction its configured rate of the gross — whole basis points, rounded
 * half up by the platform's `applyBasisPoints` — and `net = gross − Σ deductions`. Bigint
 * throughout. The rate, the base and their order are the configuration's (Q-96 (6)); no deduction
 * means `net = gross`. A gross past the largest bigint, or deductions past the gross, are refused
 * here rather than left to the database's CHECK.
 */
export function computeStatementAmounts(
  lineAmounts: readonly bigint[],
  deductions: readonly ConfiguredDeduction[],
): StatementAmounts | AmountRefusal {
  const grossMinor = lineAmounts.reduce((sum, amount) => sum + amount, 0n);
  if (grossMinor > MAX_AMOUNT_MINOR) return 'STATEMENT_EXCEEDS_LIMIT';
  const applied = deductions.map((rule) => {
    if (rule.base !== 'GROSS') {
      // The database admits no other base (`ck_deduction_rule_rate`); a new one is a code change.
      throw new Error(`Deduction rule ${rule.id} has a base this service does not compute`);
    }
    return {
      ...rule,
      amountMinor: BigInt(applyBasisPoints(money(grossMinor), rule.rateBp).amountMinor),
    };
  });
  const deductionsMinor = applied.reduce((sum, entry) => sum + entry.amountMinor, 0n);
  if (deductionsMinor > grossMinor) return 'STATEMENT_NET_NEGATIVE';
  return {
    grossMinor,
    deductions: applied,
    deductionsMinor,
    netMinor: grossMinor - deductionsMinor,
  };
}
