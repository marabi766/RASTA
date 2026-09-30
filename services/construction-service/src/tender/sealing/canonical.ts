import { SealingError } from './errors';

/**
 * The one byte-exact way a bid's content is written down (ADR-066 § 3).
 *
 * A commitment is only worth something if the same content always yields the
 * same bytes, on every machine and every version of this service. So:
 *
 *   - object keys are sorted (by UTF-16 code unit, as `Array.prototype.sort`
 *     does), recursively;
 *   - there is no whitespace;
 *   - strings are JSON-escaped exactly as `JSON.stringify` does;
 *   - numbers must be safe integers. A price is a decimal **string** in rial
 *     minor units (AGENTS.md § 3): a float, a `bigint`, `NaN` and `Infinity` are
 *     refused rather than rounded, so an amount can never be silently altered
 *     on its way into a commitment;
 *   - `undefined`, functions, symbols, dates and class instances are refused:
 *     the content is plain JSON data.
 */

const MAX_DEPTH = 16;

export function canonicalize(value: unknown): string {
  return write(value, 0);
}

function write(value: unknown, depth: number): string {
  if (depth > MAX_DEPTH) throw new SealingError('INVALID_CONTENT');

  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isSafeInteger(value)) throw new SealingError('INVALID_CONTENT');
      return String(value);
    case 'object':
      break;
    default:
      throw new SealingError('INVALID_CONTENT');
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => write(item, depth + 1)).join(',')}]`;
  }

  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new SealingError('INVALID_CONTENT');
  }
  const record = value as Record<string, unknown>;
  const members = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${write(record[key], depth + 1)}`);
  return `{${members.join(',')}}`;
}
