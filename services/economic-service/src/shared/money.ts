import { applyBasisPoints, money, toBigInt, type Currency, type Money } from '@rasta/contracts';
import { RastaError } from '@rasta/nest-common';

/**
 * The financial value objects shared by the five modules (docs/10 § 10.2).
 *
 * Deliberately thin. `@rasta/contracts` already owns the money representation
 * and the basis-point arithmetic (ADR-022), and duplicating either here would
 * create a second rounding rule for the platform to disagree with itself over.
 * What lives in this file is only what a *ledger* needs and a contract package
 * must not know: parsing an amount at the service boundary, and the sign
 * convention that turns a direction and a magnitude into an arithmetic value.
 *
 * `packages/*` may hold no business logic (AGENTS.md A-03), and "how a debit
 * affects a liability account" is business logic.
 */

export const MINOR_UNIT_PATTERN = /^\d{1,30}$/;

/**
 * Parses an amount that arrived over HTTP or on an event.
 *
 * Amounts cross the wire as strings so that a rial figure beyond
 * `Number.MAX_SAFE_INTEGER` survives JSON intact (ADR-022). Parsing is a
 * boundary concern and it fails loudly: a malformed amount must never reach
 * arithmetic, because `BigInt('12.5')` throws a `SyntaxError` a caller cannot
 * interpret, and `Number('12.5')` would quietly introduce a fraction of a rial
 * into a ledger.
 */
export function parseMinor(value: string, field = 'amountMinor'): bigint {
  if (!MINOR_UNIT_PATTERN.test(value)) {
    throw RastaError.validation(
      [{ path: field, message: 'Expected a non-negative integer string in minor units' }],
      'Malformed monetary amount',
    );
  }
  return BigInt(value);
}

/** The transport form: a decimal string, never a JSON number. */
export function formatMinor(value: bigint): string {
  return value.toString();
}

export function toMoney(amountMinor: bigint, currency: string): Money {
  return money(amountMinor, currency as Currency);
}

/**
 * Applies a rate in basis points, with the platform's single rounding rule.
 *
 * Delegates to `@rasta/contracts` rather than reimplementing: "half up on the
 * absolute value" has to be one function for the whole platform, or a
 * commission computed in this service and re-checked in analytics can differ
 * by one rial and nobody can say which is right (docs/10 § 10.11).
 */
export function commissionFor(grossMinor: bigint, currency: string, basisPoints: number): bigint {
  return toBigInt(applyBasisPoints(toMoney(grossMinor, currency), basisPoints));
}

/**
 * Clamps a computed commission to the rule's floor and ceiling.
 *
 * Order matters and is fixed here rather than at each call site: the floor is
 * applied first, then the ceiling, so a rule whose minimum exceeds its maximum
 * cannot produce a figure above the maximum. That combination is already
 * refused by `ck_commission_rule_bounds`, and this is what the code does if
 * the constraint is ever relaxed.
 *
 * The floor never raises a commission above the gross amount. A rule with a
 * minimum larger than the transaction would otherwise charge more than the
 * transaction is worth, which `ck_commission_amounts` refuses — better to cap
 * it here and charge the whole amount than to fail the settlement.
 */
export function clampCommission(
  computedMinor: bigint,
  grossMinor: bigint,
  options: { minMinor?: bigint | null; maxMinor?: bigint | null },
): bigint {
  let result = computedMinor;
  if (options.minMinor !== undefined && options.minMinor !== null && result < options.minMinor) {
    result = options.minMinor;
  }
  if (options.maxMinor !== undefined && options.maxMinor !== null && result > options.maxMinor) {
    result = options.maxMinor;
  }
  if (result > grossMinor) result = grossMinor;
  return result;
}

/**
 * The arithmetic sign of one ledger entry.
 *
 * A debit adds, a credit subtracts. That convention is what makes "sum the
 * journal and expect zero" the balance test, and it is the same expression the
 * database trigger uses — deliberately, so the two cannot drift apart.
 */
export function signedValue(direction: 'DEBIT' | 'CREDIT', amountMinor: bigint): bigint {
  return direction === 'DEBIT' ? amountMinor : -amountMinor;
}

/** The opposite direction. What a reversal entry uses. */
export function opposite(direction: 'DEBIT' | 'CREDIT'): 'DEBIT' | 'CREDIT' {
  return direction === 'DEBIT' ? 'CREDIT' : 'DEBIT';
}
