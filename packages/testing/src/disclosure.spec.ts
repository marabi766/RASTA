import {
  absenceHazard,
  correlationId,
  errorEnvelope,
  expectNotDisclosed,
  generatedValuesIn,
  instant,
  oneOf,
} from './disclosure';

const CORRELATION = '01JABCDE403FGHJKMNPQRSTVWX';
const TIMESTAMP = '2026-10-25T01:39:12.403Z';
const OWN_ORG = 'ORG_01JQ0000000000000000000001';
const OTHER_ORG = 'ORG_01JQ0000000000000000000002';
const window = ['2026-10-25T01:39:00.000Z', '2026-10-25T01:40:00.000Z'] as const;
const headers = { 'x-correlation-id': CORRELATION };
const envelope = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  correlationId: CORRELATION,
  timestamp: TIMESTAMP,
  message: 'refused',
  ...extra,
});
const metadata = errorEnvelope({ headers, instantsBetween: window });

describe('expectNotDisclosed: path-bound independent exemptions', () => {
  it('accepts a substring in verified metadata; rejects the SAME payload with adjacent content', () => {
    const payload = envelope({ details: [{ reason: 'ordinary refusal' }] });
    expect(() => expectNotDisclosed(payload, ['403', /403/], { metadata })).not.toThrow();
    const leaking = { ...payload, details: [{ reason: 'answered 403' }] };
    expect(() => expectNotDisclosed(leaking, ['403', /403/], { metadata })).toThrow(
      /discloses 403/,
    );
  });

  it('only excuses a whole JSON value EQUAL to the independent expected value', () => {
    const expected = `bid-${CORRELATION}`; // request input, not read from the payload
    const options = { metadata: { requestKey: expected } };
    expect(() => expectNotDisclosed({ requestKey: expected }, ['403'], options)).not.toThrow();
    expect(() =>
      expectNotDisclosed({ requestKey: expected + ':price=403' }, ['403'], options),
    ).toThrow(/expected/);
    expect(() =>
      expectNotDisclosed({ requestKey: expected, privateNote: '403' }, ['403'], options),
    ).toThrow(/discloses 403/);
  });

  it('cached-response debug strings containing a generated token stay searched', () => {
    const bidId = OWN_ORG; // independently established fixture id
    const options = { metadata: { bidId } };
    expect(() => expectNotDisclosed({ bidId }, ['1250000000'], options)).not.toThrow();
    expect(() =>
      expectNotDisclosed({ bidId, debug: `${bidId}:price=1250000000` }, ['1250000000'], options),
    ).toThrow(/discloses 1250000000/);
  });

  it('never rewrites keys or merges distinct generated-identity properties', () => {
    const body = { id: OWN_ORG, [OWN_ORG]: '1250000000', [OTHER_ORG]: 'safe' };
    expect(() => expectNotDisclosed(body, ['1250000000'], { metadata: { id: OWN_ORG } })).toThrow(
      /discloses 1250000000/,
    );
    expect(() => expectNotDisclosed({ 'private-1250000000': true }, ['1250000000'])).toThrow(
      /discloses/,
    );
    expect(() => expectNotDisclosed({ [OTHER_ORG]: true }, [OTHER_ORG])).toThrow(
      /discloses the identity/,
    );
  });

  it.each(['__proto__', 'constructor', 'prototype'])('preserves the JSON special key %s', (key) => {
    const body: unknown = JSON.parse(`{"id":"${OWN_ORG}","${key}":{"note":"1250000000"}}`);
    expect(() => expectNotDisclosed(body, ['1250000000'], { metadata: { id: OWN_ORG } })).toThrow(
      /discloses 1250000000/,
    );
  });

  it.each([
    OTHER_ORG,
    new RegExp(OTHER_ORG),
    new RegExp(OTHER_ORG.toLowerCase(), 'gi'),
    new RegExp(`(?:${OWN_ORG}|${OTHER_ORG})`),
  ])('searches identity secret %s in the ORIGINAL payload', (secret) => {
    expect(() =>
      expectNotDisclosed({ organizationId: OTHER_ORG }, [secret], {
        metadata: { organizationId: oneOf([OTHER_ORG]) },
      }),
    ).toThrow(/discloses the identity/);
    expect(() =>
      expectNotDisclosed({ path: `/org/${OTHER_ORG}/read` }, [secret], {
        metadata: { path: `/org/${OTHER_ORG}/read` },
      }),
    ).toThrow(/discloses the identity/);
  });

  it('only excuses bounded instants at declared timestamp paths; privateNote stays searched', () => {
    const body = { createdAt: TIMESTAMP };
    const options = { metadata: { createdAt: instant(window) } };
    expect(() => expectNotDisclosed(body, [TIMESTAMP], options)).not.toThrow();
    expect(() =>
      expectNotDisclosed({ ...body, privateNote: TIMESTAMP }, [TIMESTAMP], options),
    ).toThrow(/discloses/);
    expect(() => expectNotDisclosed({ privateNote: `at ${TIMESTAMP}` }, [TIMESTAMP])).toThrow(
      /discloses/,
    );
    expect(() =>
      expectNotDisclosed({ createdAt: '2026-10-25T01:41:00.000Z' }, ['secret'], options),
    ).toThrow(/outside the test window/);
  });

  it('leaves unknown ids, receipts, digests and instants searched, without shape-only exemptions', () => {
    for (const body of [
      { id: CORRELATION },
      { receipt: 'a'.repeat(64) },
      { timestamp: TIMESTAMP },
    ]) {
      expect(() => expectNotDisclosed(body, ['zzz-not-there'])).not.toThrow();
    }
    expect(() =>
      expectNotDisclosed({ receipt: 'a'.repeat(20) + '4200000000' + 'b'.repeat(34) }, [
        '4200000000',
      ]),
    ).toThrow(/discloses/);
    expect(() => expectNotDisclosed({ id: CORRELATION }, ['403'])).toThrow(/discloses/);
  });

  it.each(['price=4200000000IRR', 'price-4200000000', '4200000000', 4200000000])(
    'catches E2E substring disclosure %s',
    (value) => {
      expect(() => expectNotDisclosed({ price: value }, ['4200000000'])).toThrow(
        /discloses 4200000000/,
      );
    },
  );

  it('numeric and string values use exact path equality', () => {
    expect(() =>
      expectNotDisclosed({ reference: 123403 }, ['403'], { metadata: { reference: 123403 } }),
    ).not.toThrow();
    expect(() =>
      expectNotDisclosed({ reference: 123404 }, ['403'], { metadata: { reference: 123403 } }),
    ).toThrow(/expected/);
    expect(() =>
      expectNotDisclosed({ reference: { privateNote: '403' } }, ['403'], {
        metadata: { reference: 123403 },
      }),
    ).toThrow(/whole JSON string or number/);
  });

  it('rejects malformed, absent or wrong metadata without excusing the value', () => {
    expect(() =>
      expectNotDisclosed(envelope({ timestamp: 'bad' }), ['secret'], { metadata }),
    ).toThrow(/ISO instant/);
    expect(() =>
      expectNotDisclosed(envelope({ timestamp: '2026-02-30T01:39:12.403Z' }), ['secret'], {
        metadata,
      }),
    ).toThrow(/real instant/);
    expect(() =>
      expectNotDisclosed(envelope({ correlationId: OTHER_ORG }), ['secret'], { metadata }),
    ).toThrow(/correlation id/);
    expect(() => expectNotDisclosed({}, ['secret'], { metadata })).toThrow(/absent/);
    expect(() =>
      expectNotDisclosed([], ['secret'], { metadata: { '*.id': oneOf([OWN_ORG]) } }),
    ).toThrow(/absent/);
    expect(() =>
      expectNotDisclosed({ timestamp: TIMESTAMP }, ['secret'], {
        metadata: { timestamp: instant(['bad', 'bad']) },
      }),
    ).toThrow(/invalid test window/);
    expect(() =>
      expectNotDisclosed({ correlationId: CORRELATION }, ['secret'], {
        metadata: { correlationId: correlationId(undefined) },
      }),
    ).toThrow(/no x-correlation-id/);
  });

  it('rejects a valid-shaped but wrong tenant id at a declared path', () => {
    const options = { metadata: { organizationId: OWN_ORG } };
    expect(() =>
      expectNotDisclosed({ organizationId: OWN_ORG }, ['000000'], options),
    ).not.toThrow();
    expect(() => expectNotDisclosed({ organizationId: OTHER_ORG }, ['secret'], options)).toThrow(
      /expected/,
    );
  });

  it('array wildcard matches only arrays and leaves adjacent properties searched', () => {
    const options = { metadata: { '*.id': oneOf([OWN_ORG]) } };
    expect(() => expectNotDisclosed([{ id: OWN_ORG }], ['000000'], options)).not.toThrow();
    expect(() =>
      expectNotDisclosed([{ id: OWN_ORG, note: '000000' }], ['000000'], options),
    ).toThrow(/discloses/);
    expect(() => expectNotDisclosed({ first: { id: OWN_ORG } }, ['secret'], options)).toThrow(
      /absent/,
    );
  });

  it('preserves bigint digits, RegExp flags and substring semantics', () => {
    expect(() => expectNotDisclosed({ amount: 9007199254740993n }, ['9007199254740993'])).toThrow(
      /discloses/,
    );
    expect(() => expectNotDisclosed({ reason: 'KEYCLOAK refused' }, [/keycloak/i])).toThrow(
      /discloses/,
    );
    expect(() => expectNotDisclosed({ reason: 'KEYCLOAK refused' }, [/keycloak/])).not.toThrow();
    expect(() => expectNotDisclosed('price-4200000000', ['4200000000'])).toThrow(/discloses/);
  });

  it('refuses an absent payload rather than passing a vacuous cached-response assertion', () => {
    expect(() => expectNotDisclosed(undefined, ['1250000000'])).toThrow(/payload is absent/);
  });

  it('requires input sentinels, and derived never exempts a disclosure', () => {
    const input = { amount: '9007199254740993' };
    expect(() => expectNotDisclosed({}, ['9007199254740993'], { input })).not.toThrow();
    expect(() => expectNotDisclosed({}, ['9007199254740992'], { input })).toThrow(
      /not in the input/,
    );
    expect(() =>
      expectNotDisclosed({}, ['9007199254740992'], { input, derived: ['9007199254740992'] }),
    ).not.toThrow();
    expect(() =>
      expectNotDisclosed({ leak: '9007199254740992' }, ['9007199254740992'], {
        input,
        derived: ['9007199254740992'],
      }),
    ).toThrow(/discloses/);
    expect(() => expectNotDisclosed({}, [])).toThrow(/no secrets/);
  });
});

describe('absenceHazard (the Jest guard’s rule)', () => {
  it('refuses a sentinel that fits inside a generated value present in the text', () => {
    expect(absenceHazard(JSON.stringify(envelope()), '403')).toMatch(/inside the generated/);
    expect(absenceHazard('{"timestamp":"2026-10-25T01:39:12.584Z"}', '12.5')).toMatch(/instant/);
    expect(absenceHazard(`{"id":"${OWN_ORG}"}`, '777777')).toMatch(/ulid/);
    expect(absenceHazard(`{"id":"${CORRELATION}"}`, /attempt/i)).toMatch(/ulid/);
    expect(absenceHazard('{"h":"' + 'a'.repeat(64) + '"}', 'cafe')).toMatch(/digest/);
  });

  it('accepts a sentinel no generated value can hold, or a text with none', () => {
    expect(absenceHazard('{"timestamp":"2026-10-25T01:39:12.584Z"}', '482139.5')).toBeUndefined();
    expect(absenceHazard('{"timestamp":"2026-10-25T01:39:12.584Z"}', '4111')).toBeUndefined();
    expect(absenceHazard(`{"id":"${OWN_ORG}"}`, 'SMUGGLED')).toBeUndefined();
    expect(absenceHazard(`{"id":"${OWN_ORG}"}`, /Licence 1234|mock/)).toBeUndefined();
    expect(absenceHazard('{"price":"12.5"}', '12.5')).toBeUndefined();
  });

  it('exempts a sentinel that is itself an identity: only that identity holds it', () => {
    expect(absenceHazard(`{"id":"${OWN_ORG}"}`, OTHER_ORG)).toBeUndefined();
  });

  it('reads a regular expression as the literal pieces its matches contain — never fewer matches', () => {
    const body = JSON.stringify({ id: OWN_ORG, at: TIMESTAMP, note: 'idempotencyKey.delete(' });
    // Zero-width parts only restrict a match; dropping them keeps every hazard.
    expect(absenceHazard(body, /keycloak(?!_unavailable)/i)).toBeUndefined();
    expect(absenceHazard(body, /keycloak(?!_write_settling)|attempt|KWA_/i)).toMatch(/"attempt"/);
    expect(absenceHazard(body, /^ORG_$/)).toBeUndefined();
    // Groups and small classes are expanded; a non-alphanumeric run never reaches a generated value.
    expect(
      absenceHazard(body, /\b(?:m[lr]|p[lr]|left|right|text-left|text-right)-/),
    ).toBeUndefined();
    expect(absenceHazard(body, /idempotencyKey\s*\.\s*(delete|deleteMany)\(/)).toBeUndefined();
    // A lookaround that keeps word characters off a side is kept: no generated value is entered.
    expect(absenceHazard(body, /(?<![\w-])1000(?![\w-])/)).toBeUndefined();
    expect(absenceHazard(`{"n":"${OWN_ORG}-1000"}`, /(?<!\w)1000/)).toBeUndefined();
    expect(absenceHazard(body, /(?<=x)1000/)).toMatch(/"1000"/);
    // \b holds the neighbour: inside a ULID every neighbour is a word character.
    expect(absenceHazard(`{"id":"${OWN_ORG}"}`, /\b7\b/)).toBeUndefined();
    expect(absenceHazard(`{"id":"${OWN_ORG}"}`, /7/)).toMatch(/ulid/);
  });

  it('refuses a regular expression it cannot reduce when generated values are present', () => {
    expect(absenceHazard(`{"id":"${OWN_ORG}"}`, /\d{6,}/)).toMatch(/cannot be reduced/);
    expect(absenceHazard(`{"id":"${OWN_ORG}"}`, /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/)).toMatch(
      /cannot be reduced/,
    );
    expect(absenceHazard('{"id":"none"}', /\d{6,}/)).toBeUndefined();
  });

  it('lines a sentinel up with the real characters around a generated value', () => {
    // "-5" needs a '-' where the text has '"' or 'T': it cannot occur in this instant.
    expect(absenceHazard('{"at":"2026-10-25T01:39:12.584Z"}', '-5')).toBeUndefined();
    expect(absenceHazard('{"at":"2026-10-25T01:39:12.584Z"}', '-2')).toMatch(/instant/);
  });
});

describe('generatedValuesIn', () => {
  it('finds prefixed ULIDs, UUIDs, instants and digests, and nothing in plain content', () => {
    const shapes = generatedValuesIn(
      `${OWN_ORG} 0b7c62c1-6e7e-4e0e-9a40-5d3f0c2f8e11 ${TIMESTAMP} ${'f'.repeat(64)}`,
    ).map((value) => value.shape);
    expect(shapes).toEqual(['ulid', 'uuid', 'instant', 'digest']);
    expect(generatedValuesIn('KEYCLOAK_WRITE_SETTLING 1250000000 9223372036854775807')).toEqual([]);
  });
});
