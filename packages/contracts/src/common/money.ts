import { z } from 'zod';

/**
 * Money in the Rasta platform.
 *
 * Amounts are **integer minor units** (IRR rial — the currency has no
 * subdivision in practice, so 1 minor unit = 1 rial). Floating point is never
 * used for money: `0.1 + 0.2 !== 0.3` is not an acceptable property for a
 * ledger that must reconcile to zero.
 *
 * Transport encoding is a *string* so that amounts beyond `Number.MAX_SAFE_INTEGER`
 * (≈ 9.007e15 rial, roughly 900 trillion toman) survive JSON round-trips
 * intact. Services parse to `bigint` at the edge.
 */

export const CURRENCIES = ['IRR'] as const;
export type Currency = (typeof CURRENCIES)[number];

export const currencySchema = z.enum(CURRENCIES);

/** A non-negative integer amount encoded as a decimal string. */
export const amountMinorSchema = z
  .string()
  .regex(/^\d{1,30}$/, 'Amount must be a non-negative integer string in minor units');

/** A signed integer amount — used by ledger entries, which may be negative. */
export const signedAmountMinorSchema = z
  .string()
  .regex(/^-?\d{1,30}$/, 'Amount must be an integer string in minor units');

export const moneySchema = z.object({
  amountMinor: amountMinorSchema,
  currency: currencySchema,
});

export type Money = z.infer<typeof moneySchema>;

export const signedMoneySchema = z.object({
  amountMinor: signedAmountMinorSchema,
  currency: currencySchema,
});

export type SignedMoney = z.infer<typeof signedMoneySchema>;

export function money(amountMinor: bigint | number | string, currency: Currency = 'IRR'): Money {
  const value = typeof amountMinor === 'bigint' ? amountMinor : BigInt(amountMinor);
  if (value < 0n) {
    throw new RangeError('Money amount cannot be negative; use SignedMoney for ledger entries.');
  }
  return { amountMinor: value.toString(), currency };
}

export function toBigInt(value: Money | SignedMoney): bigint {
  return BigInt(value.amountMinor);
}

export function addMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return { amountMinor: (toBigInt(a) + toBigInt(b)).toString(), currency: a.currency };
}

export function subtractMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  const result = toBigInt(a) - toBigInt(b);
  if (result < 0n) throw new RangeError('Money subtraction produced a negative amount.');
  return { amountMinor: result.toString(), currency: a.currency };
}

/**
 * Applies a rate expressed in **basis points** (1 bp = 0.01%), rounding half-up.
 * Commission rates are stored as basis points rather than floats precisely so
 * that "2.5%" is exactly 250 and never 0.024999999999999998.
 */
export function applyBasisPoints(value: Money, basisPoints: number): Money {
  if (!Number.isInteger(basisPoints) || basisPoints < 0) {
    throw new RangeError('Basis points must be a non-negative integer.');
  }
  const numerator = toBigInt(value) * BigInt(basisPoints);
  const denominator = 10_000n;
  // Round half-up on the absolute value.
  const rounded = (numerator + denominator / 2n) / denominator;
  return { amountMinor: rounded.toString(), currency: value.currency };
}

function assertSameCurrency(a: Money | SignedMoney, b: Money | SignedMoney): void {
  if (a.currency !== b.currency) {
    throw new TypeError(`Currency mismatch: ${a.currency} vs ${b.currency}`);
  }
}
