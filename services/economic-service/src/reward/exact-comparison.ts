/** Types of the numeric facts exposed by RewardTriggerConsumer.confirmedFact. */
export const NUMERIC_FACT_TYPES: Readonly<Record<string, 'integer' | 'decimal'>> = {
  totalCostMinor: 'integer',
  downtimeMinutes: 'integer',
  hours: 'decimal',
  kilometres: 'decimal',
  hourMeter: 'decimal',
  odometer: 'decimal',
};

/** JSON numbers cannot preserve arbitrary decimals; exact values travel as strings. */
export function safeNumericOperand(value: number): boolean {
  return Number.isSafeInteger(value);
}

const MAX_DECIMAL_LENGTH = 256;
const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;
const INTEGER = /^[+-]?\d+$/;

function decimal(value: unknown, integer: boolean): { coefficient: bigint; scale: number } | null {
  if (typeof value === 'number') {
    if (!safeNumericOperand(value)) return null;
    value = String(value);
  }
  if (typeof value !== 'string' || value.length > MAX_DECIMAL_LENGTH) return null;
  if (!(integer ? INTEGER : DECIMAL).test(value)) return null;
  const [whole = '', fraction = ''] = value.split('.');
  const sign = whole.startsWith('-') ? -1n : 1n;
  const digits = whole.replace(/^[+-]/, '') + fraction;
  return { coefficient: sign * BigInt(digits), scale: fraction.length };
}

/** -1, 0, 1, or null when either side cannot be compared without losing precision. */
export function exactComparison(left: unknown, right: unknown, field: string): number | null {
  const integer = NUMERIC_FACT_TYPES[field] === 'integer';
  const a = decimal(left, integer);
  const b = decimal(right, integer);
  if (a === null || b === null) return null;
  const scale = Math.max(a.scale, b.scale);
  const x = a.coefficient * 10n ** BigInt(scale - a.scale);
  const y = b.coefficient * 10n ** BigInt(scale - b.scale);
  return x < y ? -1 : x > y ? 1 : 0;
}
