import {
  absenceHazard,
  errorEnvelope,
  expectNotDisclosed,
  generatedValuesIn,
  instant,
  mintedKey,
  oneOf,
  sameAs,
  searched,
  wholeNumber,
} from './disclosure';

// A ULID that holds "403" and a timestamp whose milliseconds are .403: the r1 collision (#452).
const CORRELATION = '01JABCDE403FGHJKMNPQRSTVWX';
const TIMESTAMP = '2026-10-25T01:39:12.403Z';
const OWN_ORG = 'ORG_01JQ0000000000000000000001';
const OTHER_ORG = 'ORG_01JQ0000000000000000000002';
const headers = { 'x-correlation-id': CORRELATION };
const envelope = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  code: 'KEYCLOAK_UNAVAILABLE',
  message: 'An unexpected error occurred',
  correlationId: CORRELATION,
  timestamp: TIMESTAMP,
  path: `/v1/organizations/${OWN_ORG}/members`,
  ...extra,
});
const metadata = errorEnvelope({ headers, path: `/v1/organizations/${OWN_ORG}/members` });

describe('expectNotDisclosed', () => {
  it('is not failed by a secret-shaped run inside the declared timestamp or correlation ULID', () => {
    // The plain assertion this replaces fails on this body although nothing leaked.
    expect(JSON.stringify(envelope())).toMatch(/403/);
    expect(() => expectNotDisclosed(envelope(), [/403/, '403'], { metadata })).not.toThrow();
  });

  it('still finds a secret in any field that is not declared metadata', () => {
    expect(() =>
      expectNotDisclosed(envelope({ message: 'Keycloak answered 403' }), [/403/], { metadata }),
    ).toThrow(/discloses \/403\//);
    expect(() =>
      expectNotDisclosed(envelope({ details: [{ field: 'x', reason: 'got 403' }] }), ['403'], {
        metadata,
      }),
    ).toThrow(/discloses 403/);
  });

  it('inspects keys and every undeclared field — no *Id/*At field disappears by its name', () => {
    expect(() =>
      expectNotDisclosed(envelope({ '777777': true }), ['777777'], { metadata }),
    ).toThrow(/discloses 777777/);
    expect(() =>
      expectNotDisclosed(envelope({ priceId: '777777', leakedAt: '777777' }), ['777777'], {
        metadata,
      }),
    ).toThrow(/discloses 777777/);
  });

  describe('malformed metadata fails the assertion', () => {
    it.each([
      ['a timestamp that is not an ISO instant', { timestamp: '25/10/2026 01:39' }, /timestamp/],
      [
        'a timestamp that is no real instant',
        { timestamp: '2026-02-30T01:39:12.403Z' },
        /real instant/,
      ],
      [
        'a correlation id that is not the response’s',
        { correlationId: '01JABCDE403FGHJKMNPQRSTVWY' },
        /correlation/,
      ],
      ['a correlation id missing', { correlationId: undefined }, /correlation/],
      [
        'a path that is not the request’s',
        { path: `/v1/organizations/${OTHER_ORG}/members` },
        /metadata path/,
      ],
    ])('%s', (_label, override, message) => {
      const body = envelope(override);
      if ('correlationId' in override && override.correlationId === undefined)
        delete body.correlationId;
      expect(() => expectNotDisclosed(body, ['secret'], { metadata })).toThrow(message);
    });

    it('a response without an x-correlation-id header', () => {
      expect(() =>
        expectNotDisclosed(envelope(), ['secret'], { metadata: errorEnvelope({ headers: {} }) }),
      ).toThrow(/no x-correlation-id header/);
    });

    it('a valid-shaped but WRONG id in a metadata field (another organization’s)', () => {
      const row = { organizationId: OTHER_ORG, note: 'n' };
      expect(() =>
        expectNotDisclosed(row, ['secret'], { metadata: { organizationId: OWN_ORG } }),
      ).toThrow(`expected "${OWN_ORG}", got "${OTHER_ORG}"`);
      expect(() =>
        expectNotDisclosed([row], ['secret'], {
          metadata: { '*.organizationId': oneOf([OWN_ORG]) },
        }),
      ).toThrow(/none of the 1 expected values/);
    });

    it('a path absent from the haystack, and a list with no element to check', () => {
      expect(() => expectNotDisclosed({}, ['x'], { metadata: { timestamp: instant() } })).toThrow(
        /metadata timestamp: absent/,
      );
      expect(() => expectNotDisclosed([], ['x'], { metadata: { '*.id': OWN_ORG } })).toThrow(
        /absent/,
      );
    });
  });

  it('refuses a generated value nobody declared: it could produce or hide a match', () => {
    for (const leftover of [
      { correlationId: CORRELATION },
      { at: TIMESTAMP },
      { requestId: '0b7c62c1-6e7e-4e0e-9a40-5d3f0c2f8e11' },
      { receipt: 'a'.repeat(63) + '0' },
    ]) {
      expect(() => expectNotDisclosed(leftover, ['zzz-not-there'])).toThrow(/undeclared generated/);
    }
    // A ULID inside a longer text, and inside a key, is found as well.
    expect(() => expectNotDisclosed({ path: `/v1/organizations/${OWN_ORG}` }, ['secret'])).toThrow(
      /undeclared generated ulid/,
    );
    expect(() => expectNotDisclosed({ [OWN_ORG]: 1 }, ['secret'])).toThrow(/\(key\)/);
  });

  it('sameAs holds each copy of a value to the field of its own list element', () => {
    const rows = [
      { id: OWN_ORG, payload: { eventId: OWN_ORG }, headers: { 'x-event-id': OWN_ORG } },
      { id: OTHER_ORG, payload: { eventId: OTHER_ORG }, headers: { 'x-event-id': OTHER_ORG } },
    ];
    const metadata = {
      '*.id': oneOf([OWN_ORG, OTHER_ORG]),
      '*.payload.eventId': sameAs('id'),
      '*.headers.x-event-id': sameAs('id'),
    };
    expect(() => expectNotDisclosed(rows, ['secret'], { metadata })).not.toThrow();
    const crossed = [rows[0], { ...rows[1], payload: { eventId: OWN_ORG } }];
    expect(() => expectNotDisclosed(crossed, ['secret'], { metadata })).toThrow(
      `metadata 1.payload.eventId: expected the value of id ("${OTHER_ORG}"), got "${OWN_ORG}"`,
    );
  });

  it('mintedKey takes a bare ULID only: never a prefixed id, never content', () => {
    const key = '01JABCDE403FGHJKMNPQRSTVWX';
    expect(() =>
      expectNotDisclosed({ id: key }, ['403'], { metadata: { id: mintedKey() } }),
    ).not.toThrow();
    for (const value of [OWN_ORG, `${key} 1250000000`, '1250000000', 42]) {
      expect(() =>
        expectNotDisclosed({ id: value }, ['zzz'], { metadata: { id: mintedKey() } }),
      ).toThrow(/expected a bare ULID/);
    }
    // With the row type's prefix: that prefix and a ULID, no other.
    expect(() =>
      expectNotDisclosed({ id: `BAL_${key}` }, ['403'], { metadata: { id: mintedKey('BAL') } }),
    ).not.toThrow();
    expect(() =>
      expectNotDisclosed({ id: OWN_ORG }, ['zzz'], { metadata: { id: mintedKey('BAL') } }),
    ).toThrow(/expected BAL_ and a ULID/);
  });

  it('a known identity is removed wherever it occurs; a word or an amount is never “known”', () => {
    const event = {
      aggregateId: OWN_ORG,
      path: `/v1/organizations/${OWN_ORG}/bids`,
      priceMinor: '1',
    };
    expect(() => expectNotDisclosed(event, ['1250000000'], { known: [OWN_ORG] })).not.toThrow();
    expect(() =>
      expectNotDisclosed(event, ['1250000000'], { known: [OWN_ORG, '1250000000'] }),
    ).toThrow(/known "1250000000" holds no generated value/);
  });

  it('a whole-identity secret is caught even where a declaration would remove it', () => {
    const row = { organizationId: OTHER_ORG };
    expect(() => expectNotDisclosed(row, [OTHER_ORG], { known: [OTHER_ORG] })).toThrow(
      `discloses the identity ${OTHER_ORG}`,
    );
    expect(() =>
      expectNotDisclosed(row, [OTHER_ORG], { metadata: { organizationId: OTHER_ORG } }),
    ).toThrow(`discloses the identity ${OTHER_ORG}`);
  });

  it('removes only instants inside the test window, anywhere; others must be declared', () => {
    const from = new Date('2026-10-25T01:39:00.000Z');
    const to = new Date('2026-10-25T01:40:00.000Z');
    const rows = [{ createdAt: new Date(TIMESTAMP), log: `stored at ${TIMESTAMP}` }];
    expect(() => expectNotDisclosed(rows, ['12.4'], { instantsBetween: [from, to] })).not.toThrow();
    const outside = [{ createdAt: '2026-10-25T01:41:12.403Z' }];
    expect(() => expectNotDisclosed(outside, ['12.4'], { instantsBetween: [from, to] })).toThrow(
      /undeclared generated instant/,
    );
    expect(() =>
      expectNotDisclosed(outside, ['secret'], {
        metadata: { '0.createdAt': instant([from, to]) },
      }),
    ).toThrow(/outside the test window/);
  });

  it('a digest is either its expected value (then removed) or refused — never removed by shape', () => {
    const digest = 'd206e5e97e66b744bc2fd021f7a50638bf1509931f75674d3f44d18a3857a411';
    expect(() =>
      expectNotDisclosed({ receipt: digest }, ['1250000000'], { metadata: { receipt: digest } }),
    ).not.toThrow();
    expect(() => expectNotDisclosed({ receipt: digest }, ['1250000000'])).toThrow(
      /undeclared generated digest/,
    );
  });

  it('serializes as the suites did: a bigint as its digits, a Date as its instant, regex flags kept', () => {
    expect(() =>
      expectNotDisclosed({ amountMinor: 9007199254740993n }, ['9007199254740993']),
    ).toThrow(/discloses 9007199254740993/);
    expect(() => expectNotDisclosed({ reason: 'KEYCLOAK refused' }, [/keycloak/i])).toThrow(
      /discloses/,
    );
    expect(() => expectNotDisclosed({ reason: 'KEYCLOAK refused' }, [/keycloak/])).not.toThrow();
    expect(() => expectNotDisclosed('plain text with 1250000000 in it', ['1250000000'])).toThrow(
      /discloses/,
    );
  });

  it('refuses a vacuous assertion: each secret must be in the input, unless derived', () => {
    const input = { content: { priceMinor: '9007199254740993' } };
    expect(() => expectNotDisclosed({}, ['9007199254740993'], { input })).not.toThrow();
    expect(() => expectNotDisclosed({}, ['9007199254740992'], { input })).toThrow(
      /not in the input/,
    );
    // The rounded double is what a corrupting path would write: derived, never sent.
    expect(() =>
      expectNotDisclosed({}, ['9007199254740992'], { input, derived: ['9007199254740992'] }),
    ).not.toThrow();
  });
});

describe('searched and wholeNumber', () => {
  const digest = '9c1f4200000000aa' + 'b'.repeat(48);

  it('a searched digest stays in what is searched, and needs no other declaration', () => {
    const view = { receipt: digest, note: 'n' };
    expect(() =>
      expectNotDisclosed(view, ['4200000000'], { metadata: { receipt: searched() } }),
    ).toThrow(/discloses 4200000000/);
    expect(() =>
      expectNotDisclosed(view, [wholeNumber('4200000000')], { metadata: { receipt: searched() } }),
    ).not.toThrow();
    expect(() =>
      expectNotDisclosed({ receipt: 'not a digest' }, ['x'], { metadata: { receipt: searched() } }),
    ).toThrow(/expected a digest/);
  });

  it('wholeNumber finds the number as a value or in text, never inside a generated value', () => {
    const price = wholeNumber('4200000000');
    for (const leak of [
      '{"amountMinor":"4200000000"}',
      '{"amount":4200000000}',
      'price 4200000000.',
    ]) {
      expect(price.test(leak)).toBe(true);
    }
    for (const generated of [`ORG_01J4200000000ABCDEFGHJKM`, digest, '2026-10-25T01:39:12.420Z']) {
      expect(price.test(JSON.stringify({ value: generated }))).toBe(false);
      expect(absenceHazard(JSON.stringify({ value: generated }), price)).toBeUndefined();
    }
    expect(() => wholeNumber('42.5')).toThrow(/not digits/);
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
