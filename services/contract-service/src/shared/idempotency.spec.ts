import { isRastaError } from '@rasta/nest-common';
import {
  IDEMPOTENCY_KEY_MAX_LENGTH,
  IDEMPOTENCY_KEY_MIN_LENGTH,
  hashRequest,
  requiredIdempotencyKey,
} from './idempotency';

/**
 * The pure halves of the idempotency store; its behaviour against PostgreSQL — claim, replay,
 * takeover, release — is `test/sign.int-spec.ts` and `test/cancel.int-spec.ts`.
 */
describe('requiredIdempotencyKey (docs/06 § 6.8)', () => {
  const refusalOf = (value: string | undefined) => {
    try {
      requiredIdempotencyKey(value);
      return null;
    } catch (error) {
      return isRastaError(error) ? { code: error.code, details: error.details } : String(error);
    }
  };

  it('is trimmed, and 8 to 255 characters', () => {
    expect(requiredIdempotencyKey('  abcdefgh  ')).toBe('abcdefgh');
    expect(requiredIdempotencyKey('x'.repeat(IDEMPOTENCY_KEY_MAX_LENGTH))).toHaveLength(255);
    expect(requiredIdempotencyKey('x'.repeat(IDEMPOTENCY_KEY_MIN_LENGTH))).toHaveLength(8);
  });

  it('is required: none or blank is 400 `required`', () => {
    for (const value of [undefined, '', '   ']) {
      expect(refusalOf(value)).toEqual({
        code: 'VALIDATION_FAILED',
        details: [expect.objectContaining({ path: 'Idempotency-Key', code: 'required' })],
      });
    }
  });

  it('is bounded: too short or too long is 400 `invalid`', () => {
    for (const value of ['short', 'x'.repeat(IDEMPOTENCY_KEY_MAX_LENGTH + 1)]) {
      expect(refusalOf(value)).toEqual({
        code: 'VALIDATION_FAILED',
        details: [expect.objectContaining({ path: 'Idempotency-Key', code: 'invalid' })],
      });
    }
  });

  it('never repeats the key in the refusal', () => {
    expect(JSON.stringify(refusalOf('short'))).not.toContain('short');
  });
});

describe('hashRequest', () => {
  it('is the same for the same request in another key order, at any depth', () => {
    expect(hashRequest({ a: 1, b: { c: 2, d: [1, { e: 3, f: 4 }] } })).toBe(
      hashRequest({ b: { d: [1, { f: 4, e: 3 }], c: 2 }, a: 1 }),
    );
  });

  it('differs for another request, another contract and another caller', () => {
    const base = hashRequest({ caller: 'USR_1', body: { id: 'CTR_1', reasonCode: 'OTHER' } });
    expect(hashRequest({ caller: 'USR_2', body: { id: 'CTR_1', reasonCode: 'OTHER' } })).not.toBe(
      base,
    );
    expect(hashRequest({ caller: 'USR_1', body: { id: 'CTR_2', reasonCode: 'OTHER' } })).not.toBe(
      base,
    );
    expect(
      hashRequest({ caller: 'USR_1', body: { id: 'CTR_1', reasonCode: 'TERMS_NOT_AGREED' } }),
    ).not.toBe(base);
  });

  it('hashes a key named __proto__ like any other: two bodies never hash alike', () => {
    const plain = JSON.parse('{"a":1}') as unknown;
    const proto = JSON.parse('{"a":1,"__proto__":{"x":1}}') as unknown;
    expect(hashRequest(proto)).not.toBe(hashRequest(plain));
  });
});
