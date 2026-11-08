/**
 * Comparing two answers that each carry a freshly minted signed token
 * (`signPayload`: `<base64url JSON>.<mac>`).
 *
 * Every mint stamps `exp = floor(now / 1000) + ttl` and signs it, so two calls
 * that straddle a second boundary return tokens that differ in `exp` and in the
 * MAC although they name the same thing (FU-256: `restoreTopUp` twice,
 * 1796694220 vs 1796694221). Re-minting on each read is intended — a form drawn
 * later gets a fresh lifetime — so the comparison, not the product, must ignore
 * the clock: `withoutExpiry` replaces every token-shaped string, at any depth,
 * by its decoded claims minus `exp`. What the token **names** (scope, id,
 * subject, outcome, baseline values …) is still compared, and a token that is
 * not a token (a different string) still differs.
 *
 * A spec that must see the lifetime itself pins the clock (`jest.useFakeTimers`
 * with `{ now }`, or the `now` argument the signer takes) rather than using this.
 */

/** Same shape `signed-payload.ts` accepts: a body, a dot, a 43-character MAC. */
const TOKEN_SHAPE = /^([A-Za-z0-9_-]+)\.[A-Za-z0-9_-]{43}$/;

/** The decoded claims of a signed token, or `null` when `value` is not one. */
export function claimsOf(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string') return null;
  const match = TOKEN_SHAPE.exec(value);
  if (match === null) return null;
  try {
    const claims: unknown = JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8'));
    return typeof claims === 'object' && claims !== null && !Array.isArray(claims)
      ? (claims as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** `value` with every signed token replaced by `{ signedToken: claims-without-exp }`. */
export function withoutExpiry<T>(value: T): unknown {
  const claims = claimsOf(value);
  if (claims !== null) {
    const stable = Object.fromEntries(Object.entries(claims).filter(([name]) => name !== 'exp'));
    return { signedToken: stable };
  }
  if (Array.isArray(value)) return value.map(withoutExpiry);
  if (typeof value === 'object' && value !== null) {
    // Asymmetric matchers (`expect.any`) and class instances are left whole.
    if (Object.getPrototypeOf(value) !== Object.prototype) return value;
    return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, withoutExpiry(v)]));
  }
  return value;
}
