/**
 * Reads of a presentation table (a label, a tone, a note) whose key came from
 * outside the portal — a service's status, a reason code, a gateway message.
 *
 * `table[key]` on a plain object also answers for the names every object
 * inherits: a key of `__proto__`, `constructor` or `toString` returns
 * `Object.prototype` or a function, and React refuses to render either. Every
 * such lookup goes through here, so only a key the table itself holds can
 * answer, and the answer is the table's own value. `own-key-guard.spec.ts`
 * fails on a new bracket lookup that tolerates an unknown key without it.
 */
export function ownValue<V>(
  table: { readonly [key: string]: V } | undefined,
  key: string | null | undefined,
): V | undefined {
  return table !== undefined && typeof key === 'string' && Object.hasOwn(table, key)
    ? table[key]
    : undefined;
}

/** The same for a table of sentences: the result is a string or `undefined`, never anything else. */
export function ownText(
  table: { readonly [key: string]: string } | undefined,
  key: string | null | undefined,
): string | undefined {
  const value = ownValue(table, key);
  return typeof value === 'string' ? value : undefined;
}
