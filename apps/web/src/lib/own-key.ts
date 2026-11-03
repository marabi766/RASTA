/**
 * Reads of a presentation table (a label, a tone, a note) whose key came from
 * outside the portal — a service's status, a reason code, a gateway message.
 *
 * `table[key]` on a plain object also answers for the names every object
 * inherits: a key of `__proto__`, `constructor` or `toString` returns
 * `Object.prototype` or a function, and React refuses to render either. Every
 * such lookup goes through here, so only a key the table itself holds can
 * answer, and the answer is the table's own value. `own-key.spec.ts` (a
 * type-checked guard) fails on any element access or `in` test whose key's
 * type admits an `Object.prototype` name, read or write, outside this file.
 */
export function ownValue<V>(
  table: { readonly [key: string]: V } | null | undefined,
  key: string | null | undefined,
): V | undefined {
  return table != null && typeof key === 'string' && Object.hasOwn(table, key)
    ? table[key]
    : undefined;
}

/** The same for a table of sentences: the result is a string or `undefined`, never anything else. */
export function ownText(
  table: { readonly [key: string]: string } | null | undefined,
  key: string | null | undefined,
): string | undefined {
  const value = ownValue(table, key);
  return typeof value === 'string' ? value : undefined;
}

/** Membership by own key: `key in table` also answers for every inherited name. */
export function ownHas(table: object, key: string | null | undefined): boolean {
  return typeof key === 'string' && Object.hasOwn(table, key);
}

/**
 * Writes `value` under `key` as an own, enumerable property, whatever the key:
 * `record[key] = value` with a key of `__proto__` replaces the prototype
 * instead. For accumulators that must stay plain objects (a server action's
 * state crosses to the browser, which refuses a null prototype).
 */
export function setOwn<V>(record: { [key: string]: V }, key: string, value: V): void {
  Object.defineProperty(record, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}
