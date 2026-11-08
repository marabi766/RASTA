/**
 * @jest-environment node
 */
import { claimsOf, withoutExpiry } from './minted-tokens';

const body = (claims: unknown) => Buffer.from(JSON.stringify(claims)).toString('base64url');
const MAC = 'A'.repeat(43);
const token = (claims: Record<string, unknown>, mac = MAC) => `${body(claims)}.${mac}`;

describe('withoutExpiry (FU-256)', () => {
  it("reads a signed token's claims, and nothing else", () => {
    expect(claimsOf(token({ id: 'x', exp: 5 }))).toEqual({ id: 'x', exp: 5 });
    for (const notAToken of [
      'plain',
      'a.b',
      `${body([1])}.${MAC}`,
      `!!.${MAC}`,
      7,
      null,
      undefined,
    ])
      expect(claimsOf(notAToken)).toBeNull();
  });

  it('makes tokens that differ only in lifetime (and so in MAC) equal, at any depth', () => {
    const at = (exp: number, mac: string) => ({
      kind: 'HELD',
      releaseToken: token({ scope: 's', id: 'i', exp }, mac),
      nested: [{ again: token({ scope: 's', id: 'i', exp }, mac) }],
    });
    expect(withoutExpiry(at(100, 'A'.repeat(43)))).toEqual(withoutExpiry(at(101, 'B'.repeat(43))));
  });

  it('still tells apart what a token names, and a string that is not the same token', () => {
    expect(withoutExpiry({ t: token({ id: 'a', exp: 1 }) })).not.toEqual(
      withoutExpiry({ t: token({ id: 'b', exp: 1 }) }),
    );
    expect(withoutExpiry({ t: token({ id: 'a', exp: 1 }) })).not.toEqual(
      withoutExpiry({ t: token({ id: 'a', exp: 1, extra: true }) }),
    );
    expect(withoutExpiry({ t: 'one' })).not.toEqual(withoutExpiry({ t: 'two' }));
    expect(withoutExpiry({ t: token({ id: 'a', exp: 1 }) })).not.toEqual(withoutExpiry({ t: 'a' }));
  });

  it('leaves matchers, null and undefined whole', () => {
    const matcher = expect.any(String);
    expect(withoutExpiry({ a: matcher, b: null, c: undefined })).toEqual({
      a: matcher,
      b: null,
      c: undefined,
    });
    expect({ releaseToken: token({ id: 'a', exp: 1 }) }).toEqual({ releaseToken: matcher });
  });
});
