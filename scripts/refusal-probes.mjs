// -----------------------------------------------------------------------------
// The two sentinels every environment-refusal test writes into a setting, and
// the check that none of it comes back out (#385 r4).
//
// A refusal may name a registered setting and say what is wrong with it; it may
// never repeat what was written. The check is on fragments, case-insensitive,
// so a sentinel that comes back upper-cased, with `-` turned into `_`, or cut
// down to a piece (a key prefix, a URL component) is caught too — and on the
// whole thrown object (message, stack, every property, what `util.inspect`
// prints for an uncaught throw), not on its message alone.
// -----------------------------------------------------------------------------
import assert from 'node:assert/strict';
import { inspect } from 'node:util';

export const SENTINELS = Object.freeze(['private-sentinel-79', 'JZ97-another-secret']);

/** Each sentinel as an environment key spells it: upper-cased, with `-` as `_`. */
export const KEY_SENTINELS = Object.freeze(
  SENTINELS.map((sentinel) => sentinel.replaceAll('-', '_').toUpperCase()),
);

/** Matches any piece of either sentinel in any of its spellings. */
const FRAGMENTS = /sentinel|jz97|another[-_]secret/i;

/** Everything a thrown value can print: message, stack, own properties, inspection. */
export function everythingOf(value) {
  if (!(value instanceof Error)) return inspect(value, { depth: 10 });
  return [
    value.message,
    value.stack ?? '',
    JSON.stringify(value, Object.getOwnPropertyNames(value)),
    JSON.stringify(value),
    inspect(value, { depth: 10, showHidden: true }),
    value.cause === undefined ? '' : inspect(value.cause, { depth: 10, showHidden: true }),
  ].join('\n');
}

/** Fails when `text` (or a thrown value's every printable part) holds any piece of a sentinel. */
export function assertNoSentinel(textOrError, label = 'output') {
  const text = typeof textOrError === 'string' ? textOrError : everythingOf(textOrError);
  const found = FRAGMENTS.exec(text);
  assert.equal(found, null, `${label} repeats a sentinel fragment "${found?.[0]}":\n${text}`);
}

/** The value `fn` throws (fails when it returns). */
export function thrownBy(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  assert.fail('expected a refusal');
}
