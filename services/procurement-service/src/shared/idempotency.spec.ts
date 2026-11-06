import { isRastaError } from '@rasta/nest-common';
import {
  IDEMPOTENCY_KEY_MAX_LENGTH,
  IDEMPOTENCY_KEY_MIN_LENGTH,
  completedExpiryMs,
  hashRequest,
  idempotentRequest,
  parseReplayDeadline,
  requiredIdempotencyKey,
} from './idempotency';

/**
 * The pure halves of the idempotency store; its behaviour against PostgreSQL — claim, replay,
 * takeover, release — is `test/idempotency.int-spec.ts`.
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

  it('differs for another request, another demand and another caller', () => {
    const base = hashRequest({ caller: 'USR_1', body: { id: 'DMD_1', reasonCode: 'OTHER' } });
    expect(hashRequest({ caller: 'USR_2', body: { id: 'DMD_1', reasonCode: 'OTHER' } })).not.toBe(
      base,
    );
    expect(hashRequest({ caller: 'USR_1', body: { id: 'DMD_2', reasonCode: 'OTHER' } })).not.toBe(
      base,
    );
    expect(
      hashRequest({ caller: 'USR_1', body: { id: 'DMD_1', reasonCode: 'TERMS_NOT_AGREED' } }),
    ).not.toBe(base);
  });

  it('hashes a key named __proto__ like any other: two bodies never hash alike', () => {
    const plain = JSON.parse('{"a":1}') as unknown;
    const proto = JSON.parse('{"a":1,"__proto__":{"x":1}}') as unknown;
    expect(hashRequest(proto)).not.toBe(hashRequest(plain));
  });
});

describe('Idempotency-Replay-Deadline (FU-156)', () => {
  const refusalOf = (run: () => unknown) => {
    try {
      run();
      return null;
    } catch (error) {
      return isRastaError(error) ? { code: error.code, details: error.details } : String(error);
    }
  };
  const invalid = {
    code: 'VALIDATION_FAILED',
    details: [expect.objectContaining({ path: 'Idempotency-Replay-Deadline', code: 'invalid' })],
  };

  it('is absent → no fence; one canonical epoch-ms integer → that number', () => {
    expect(parseReplayDeadline(undefined)).toBeUndefined();
    expect(parseReplayDeadline('1767225600000')).toBe(1_767_225_600_000);
    expect(parseReplayDeadline(String(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
  });

  it.each([
    [''],
    ['0'],
    ['01767225600000'],
    ['+1767225600000'],
    ['-1767225600000'],
    [' 1767225600000'],
    ['1767225600000 '],
    ['1.7e12'],
    ['1767225600000.0'],
    ['1767225600000, 1767225600001'],
    ['99999999999999999'],
    [String(Number.MAX_SAFE_INTEGER + 1)],
  ])('refuses %j with 400 invalid, before any claim', (raw) => {
    expect(refusalOf(() => parseReplayDeadline(raw))).toEqual(invalid);
  });

  it('refuses a header sent twice (an array)', () => {
    expect(refusalOf(() => parseReplayDeadline(['1767225600000', '1767225600000']))).toEqual(
      invalid,
    );
  });

  it('is read with the key by idempotentRequest — the only way into the store', () => {
    expect(
      idempotentRequest({
        'idempotency-key': '  key-abcdefgh ',
        'idempotency-replay-deadline': '1767225600000',
      }),
    ).toEqual({ key: 'key-abcdefgh', replayDeadlineMs: 1_767_225_600_000 });
    expect(idempotentRequest({ 'idempotency-key': 'key-abcdefgh' })).toEqual({
      key: 'key-abcdefgh',
      replayDeadlineMs: undefined,
    });
    // The key is judged first; a malformed deadline is refused even with a good key.
    expect(
      refusalOf(() => idempotentRequest({ 'idempotency-replay-deadline': '1767225600000' })),
    ).toEqual({
      code: 'VALIDATION_FAILED',
      details: [expect.objectContaining({ path: 'Idempotency-Key', code: 'required' })],
    });
    expect(
      refusalOf(() =>
        idempotentRequest({
          'idempotency-key': 'key-abcdefgh',
          'idempotency-replay-deadline': '-5',
        }),
      ),
    ).toEqual(invalid);
  });
});

describe('completedExpiryMs (FU-156)', () => {
  const hour = 3_600_000;

  it('is the retention from completion without a deadline', () => {
    expect(completedExpiryMs(1_000, 1, undefined, 67_000)).toBe(1_000 + hour);
  });

  it('is never earlier than B past the deadline, whatever the completing clock read', () => {
    // A completing replica 2·skew behind the claiming one: completion + TTL < H + B.
    const deadline = 10 * hour;
    const behind = deadline - hour + 1_000;
    expect(completedExpiryMs(behind, 1, deadline, 67_000)).toBe(deadline + 67_000);
    // Otherwise the retention, which is later.
    expect(completedExpiryMs(deadline, 1, deadline, 67_000)).toBe(deadline + hour);
  });
});
