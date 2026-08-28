import { hashRequestBody } from './idempotency';

/**
 * Request-body canonicalisation for idempotent writes (docs/06 § 6.8).
 *
 * The failure mode this guards against is subtle and expensive: a client
 * retrying with the *same* request, serialised with its keys in a different
 * order, would hash differently and be refused with
 * `409 IDEMPOTENCY_KEY_REUSED` — a legitimate retry rejected as a conflict,
 * and no clear way for the caller to tell the difference.
 *
 * The opposite failure matters just as much. Two *different* requests must
 * never hash alike, or the second would silently replay the first's response
 * and a caller would be told a payment succeeded that never ran.
 */

describe('hashRequestBody', () => {
  it('is stable for the same body', () => {
    const body = { amountMinor: '10000000', currency: 'IRR' };
    expect(hashRequestBody(body)).toBe(hashRequestBody(body));
  });

  it('ignores key order', () => {
    // The whole reason for canonicalising. Two clients, two JSON serialisers,
    // one request.
    expect(hashRequestBody({ a: 1, b: 2 })).toBe(hashRequestBody({ b: 2, a: 1 }));
  });

  it('ignores key order at any depth', () => {
    expect(hashRequestBody({ outer: { a: 1, b: { c: 3, d: 4 } }, top: 'x' })).toBe(
      hashRequestBody({ top: 'x', outer: { b: { d: 4, c: 3 }, a: 1 } }),
    );
  });

  it('respects array order, which is meaningful', () => {
    // Unlike object keys. `[1,2]` and `[2,1]` are different requests.
    expect(hashRequestBody({ items: [1, 2] })).not.toBe(hashRequestBody({ items: [2, 1] }));
  });

  it('distinguishes a changed amount', () => {
    // The case that must never collide: the same idempotency key with a
    // different amount is a bug or an attack, and it has to be refused.
    expect(hashRequestBody({ amountMinor: '10000000' })).not.toBe(
      hashRequestBody({ amountMinor: '10000001' }),
    );
  });

  it('distinguishes a string from a number', () => {
    // Amounts cross the wire as strings (ADR-022); `"100"` and `100` are not
    // the same request.
    expect(hashRequestBody({ amountMinor: '100' })).not.toBe(hashRequestBody({ amountMinor: 100 }));
  });

  it('distinguishes null from absent', () => {
    expect(hashRequestBody({ a: null })).not.toBe(hashRequestBody({}));
  });

  it('distinguishes an added field', () => {
    expect(hashRequestBody({ a: 1 })).not.toBe(hashRequestBody({ a: 1, b: 2 }));
  });

  it('handles a body that is not an object', () => {
    expect(hashRequestBody('plain')).toBe(hashRequestBody('plain'));
    expect(hashRequestBody(null)).toBe(hashRequestBody(null));
    expect(hashRequestBody('plain')).not.toBe(hashRequestBody(null));
  });

  it('produces a hex digest of the expected length', () => {
    expect(hashRequestBody({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });
});
