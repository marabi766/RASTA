import { createHash, randomBytes } from 'node:crypto';
import { SealingError } from './errors';
import {
  EnvKekProvider,
  isKekId,
  parseKekConfiguration,
  parseKekEntries,
  type KeyContext,
  type WrappedKey,
} from './key-provider';
import {
  generateTenderKeyPair,
  genesisReceipt,
  nextReceipt,
  openBid,
  verifyReceipts,
  privateKeyFromDer,
  sealBid,
} from './sealing';

/**
 * The seam between a tender's private key and the KEK that keeps it (ADR-066
 * § 2): binding, rotation, and a configuration that fails closed without ever
 * repeating a key.
 */

jest.setTimeout(60_000);

const K1 = randomBytes(32).toString('base64');
const K2 = randomBytes(32).toString('base64');
const CONTEXT: KeyContext = { tenderId: 'TND_A', keyId: 'TKY_1' };

const flip = (bytes: Buffer): Buffer => {
  const copy = Buffer.from(bytes);
  copy[0] = (copy[0] ?? 0) ^ 0x01;
  return copy;
};

describe('EnvKekProvider', () => {
  const provider = new EnvKekProvider(`v1:${K1}`, 'v1');
  let der: Buffer;
  let wrapped: WrappedKey;

  beforeAll(async () => {
    der = (await generateTenderKeyPair()).privateKeyDer;
    wrapped = provider.wrap(der, CONTEXT);
  });

  it('wraps a private key so the database never holds it, and unwraps it exactly', () => {
    expect(wrapped.kekId).toBe('v1');
    expect(wrapped.ciphertext.includes(der.subarray(0, 32))).toBe(false);
    expect(provider.unwrap(wrapped, CONTEXT).equals(der)).toBe(true);
  });

  it('does not touch the key it was given', () => {
    const copy = Buffer.from(der);
    provider.wrap(der, CONTEXT);
    expect(der.equals(copy)).toBe(true);
  });

  it('opens a real bid end to end through the wrapped key', async () => {
    const pair = await generateTenderKeyPair();
    const binding = { ...CONTEXT, bidId: 'BID_1', bidderOrganizationId: 'ORG_B', revision: 1 };
    const sealed = sealBid({
      publicKeyPem: pair.publicKeyPem,
      binding,
      content: { priceMinor: '1' },
    });

    // The receipt the bidder was given, and the head the trusted copy holds.
    const link = {
      bidId: binding.bidId,
      revision: binding.revision,
      receivedAt: new Date('2026-11-01T08:00:00.000Z'),
      ciphertextSha256: sealed.ciphertextSha256,
      contentCommitment: sealed.contentCommitment,
    };
    const receipt = nextReceipt(binding.tenderId, genesisReceipt(binding.tenderId), link);

    const stored = provider.wrap(pair.privateKeyDer, CONTEXT);
    const recovered = provider.unwrap(stored, CONTEXT);
    expect(
      openBid({
        privateKey: privateKeyFromDer(recovered),
        binding,
        sealed,
        receipts: verifyReceipts(binding.tenderId, {
          links: [{ ...link, receipt }],
          head: receipt,
        }),
      }),
    ).toEqual({ priceMinor: '1' });
  });

  it('binds a wrapped key to its tender and its key id', () => {
    for (const other of [
      { ...CONTEXT, tenderId: 'TND_B' },
      { ...CONTEXT, keyId: 'TKY_2' },
    ]) {
      expect(() => provider.unwrap(wrapped, other)).toThrow(
        expect.objectContaining({ code: 'TAMPERED' }),
      );
    }
  });

  it('binds a wrapped key to the KEK version that wrapped it', () => {
    const rebranded = new EnvKekProvider(`v1:${K1},v9:${K1}`, 'v1');
    expect(() => rebranded.unwrap({ ...wrapped, kekId: 'v9' }, CONTEXT)).toThrow(
      expect.objectContaining({ code: 'TAMPERED' }),
    );
  });

  it.each(['nonce', 'ciphertext', 'tag'] as const)('refuses a %s changed by one bit', (field) => {
    expect(() => provider.unwrap({ ...wrapped, [field]: flip(wrapped[field]) }, CONTEXT)).toThrow(
      expect.objectContaining({ code: 'TAMPERED' }),
    );
  });

  it('cannot unwrap with a different KEK under the same id', () => {
    const wrong = new EnvKekProvider(`v1:${K2}`, 'v1');
    expect(() => wrong.unwrap(wrapped, CONTEXT)).toThrow(
      expect.objectContaining({ code: 'TAMPERED' }),
    );
  });

  it('rotates: new keys use the current KEK, and the old KEK still unwraps what it wrapped', () => {
    const rotated = new EnvKekProvider(`v1:${K1},v2:${K2}`, 'v2');
    expect(rotated.unwrap(wrapped, CONTEXT).equals(der)).toBe(true);

    const fresh = rotated.wrap(der, CONTEXT);
    expect(fresh.kekId).toBe('v2');
    expect(rotated.unwrap(fresh, CONTEXT).equals(der)).toBe(true);
    // A deployment that dropped v2 cannot open what v2 wrapped.
    expect(() => provider.unwrap(fresh, CONTEXT)).toThrow(
      expect.objectContaining({ code: 'KEY_UNAVAILABLE' }),
    );
  });

  it('wraps twice differently: a fresh nonce every time', () => {
    const again = provider.wrap(der, CONTEXT);
    expect(again.nonce.equals(wrapped.nonce)).toBe(false);
    expect(again.ciphertext.equals(wrapped.ciphertext)).toBe(false);
  });

  it('with no KEK configured wraps and unwraps nothing, and does not invent one', () => {
    for (const unset of [new EnvKekProvider(undefined, undefined), new EnvKekProvider('', '')]) {
      expect(unset.configured).toBe(false);
      expect(() => unset.wrap(der, CONTEXT)).toThrow(
        expect.objectContaining({ code: 'KEY_UNAVAILABLE' }),
      );
      expect(() => unset.unwrap(wrapped, CONTEXT)).toThrow(
        expect.objectContaining({ code: 'KEY_UNAVAILABLE' }),
      );
    }
    expect(provider.configured).toBe(true);
  });
});

describe('the KEK configuration', () => {
  it('reads id:base64 pairs of 32 bytes each', () => {
    const configuration = parseKekConfiguration(` v1:${K1} , v2:${K2} `, 'v2');
    expect([...configuration!.keys.keys()]).toEqual(['v1', 'v2']);
    expect(configuration!.currentId).toBe('v2');
    expect(configuration!.keys.get('v1')!.toString('base64')).toBe(K1);
  });

  it('is nothing when nothing is set', () => {
    expect(parseKekConfiguration(undefined, undefined)).toBeUndefined();
    expect(parseKekConfiguration('  ', '')).toBeUndefined();
    expect(parseKekEntries(undefined).size).toBe(0);
  });

  it.each([
    ['a key that is too short', `v1:${randomBytes(16).toString('base64')}`, 'v1'],
    ['a key that is too long', `v1:${randomBytes(33).toString('base64')}`, 'v1'],
    ['base64 that is not canonical', `v1:${K1.replace(/=+$/, '')}x`, 'v1'],
    ['an entry with no id', `:${K1}`, 'v1'],
    ['an entry with no colon', K1, 'v1'],
    ['an id with capitals', `V1:${K1}`, 'V1'],
    ['an id that is too long', `${'a'.repeat(33)}:${K1}`, 'a'],
    ['a duplicate id', `v1:${K1},v1:${K2}`, 'v1'],
    ['a current id that is not among the keys', `v1:${K1}`, 'v2'],
    ['keys but no current id', `v1:${K1}`, undefined],
    ['a current id but no keys', undefined, 'v1'],
  ])('refuses %s', (_label, keys, current) => {
    expect(() => parseKekConfiguration(keys, current)).toThrow(
      expect.objectContaining({ code: 'INVALID_CONFIGURATION' }),
    );
  });

  it('never repeats a key in a refusal', () => {
    const secret = randomBytes(24).toString('base64');
    for (const keys of [`v1:${secret}`, `v1:${K1},v1:${secret}`, secret]) {
      try {
        parseKekConfiguration(keys, 'v1');
      } catch (error) {
        expect(`${String(error)} ${JSON.stringify(error)}`).not.toContain(secret);
        expect(`${String(error)} ${JSON.stringify(error)}`).not.toContain(K1);
      }
    }
  });

  describe('the keyed request digest (a bid submission’s Idempotency-Key, construction audit F4)', () => {
    const data = '{"body":{"content":{"priceMinor":"1250000000"}},"id":"TND_A"}';
    const alice = { organizationId: 'ORG_A', userId: 'USR_A' };

    it('is a keyed, salted digest naming its KEK, recognised for the same requester and data only', () => {
      const provider = new EnvKekProvider(`v1:${K1}`, 'v1');
      const digest = provider.requestDigest(alice, data);
      expect(digest).toMatch(/^hmac-v1:v1:[0-9a-f]{64}:[0-9a-f]{64}$/);
      // Not the unkeyed SHA-256 a reader of the database could recompute for a guessed price.
      expect(digest).not.toContain(createHash('sha256').update(data).digest('hex'));
      expect(provider.matchesRequestDigest(digest, alice, data)).toBe(true);
      expect(provider.matchesRequestDigest(digest, alice, `${data} `)).toBe(false);
      expect(provider.matchesRequestDigest(digest, alice, data.replace('125', '126'))).toBe(false);
    });

    it('never compares across claims: a fresh salt each time, and the organization and user inside the MAC (Codex r1 on #250, R1)', () => {
      const provider = new EnvKekProvider(`v1:${K1}`, 'v1');
      const sameOrganization = { organizationId: 'ORG_A', userId: 'USR_B' };
      const otherOrganization = { organizationId: 'ORG_B', userId: 'USR_A' };
      const digests = [
        provider.requestDigest(alice, data),
        provider.requestDigest(alice, data),
        provider.requestDigest(sameOrganization, data),
        provider.requestDigest(otherOrganization, data),
      ];
      // Neither the whole digest nor its MAC repeats, the same requester's included.
      expect(new Set(digests).size).toBe(digests.length);
      expect(new Set(digests.map((d) => d.split(':')[3])).size).toBe(digests.length);
      // Each is recognised for its own requester and no other.
      expect(provider.matchesRequestDigest(digests[0]!, alice, data)).toBe(true);
      expect(provider.matchesRequestDigest(digests[2]!, sameOrganization, data)).toBe(true);
      expect(provider.matchesRequestDigest(digests[0]!, sameOrganization, data)).toBe(false);
      expect(provider.matchesRequestDigest(digests[0]!, otherOrganization, data)).toBe(false);
      expect(provider.matchesRequestDigest(digests[3]!, alice, data)).toBe(false);
      // The fields are length-prefixed: moving characters between them is another requester.
      const shifted = provider.requestDigest({ organizationId: 'ORG_AU', userId: 'SR_A' }, data);
      expect(provider.matchesRequestDigest(shifted, alice, data)).toBe(false);
      // The salt is part of the MAC: another digest's salt does not carry this one's MAC.
      const [version, kekId, , mac] = digests[0]!.split(':');
      const otherSalt = digests[1]!.split(':')[2];
      expect(
        provider.matchesRequestDigest([version, kekId, otherSalt, mac].join(':'), alice, data),
      ).toBe(false);
    });

    it('depends on the KEK, and is still recognised after a rotation while the old KEK is kept', () => {
      const before = new EnvKekProvider(`v1:${K1}`, 'v1').requestDigest(alice, data);
      expect(new EnvKekProvider(`v1:${K2}`, 'v1').matchesRequestDigest(before, alice, data)).toBe(
        false,
      );
      const rotated = new EnvKekProvider(`v1:${K1},v2:${K2}`, 'v2');
      expect(rotated.requestDigest(alice, data)).toMatch(/^hmac-v1:v2:/);
      expect(rotated.matchesRequestDigest(before, alice, data)).toBe(true);
      // The old KEK removed: nothing it made is recognised any more.
      expect(new EnvKekProvider(`v2:${K2}`, 'v2').matchesRequestDigest(before, alice, data)).toBe(
        false,
      );
    });

    it('recognises nothing malformed, and makes nothing without a KEK', () => {
      const provider = new EnvKekProvider(`v1:${K1}`, 'v1');
      const digest = provider.requestDigest(alice, data);
      const [version, kekId, salt, mac] = digest.split(':');
      for (const stored of [
        '',
        createHash('sha256').update(data).digest('hex'),
        digest.replace('hmac-v1', 'hmac-v2'),
        `${digest}:extra`,
        // The unsalted form of the first round of this PR.
        [version, kekId, mac].join(':'),
        [version, kekId, '', mac].join(':'),
        [version, kekId, salt!.slice(0, -2), mac].join(':'),
        [version, kekId, salt!.toUpperCase(), mac].join(':'),
        digest.slice(0, -2),
        digest.replace(/.$/, (last) => (last === '0' ? '1' : '0')),
      ]) {
        expect(provider.matchesRequestDigest(stored, alice, data)).toBe(false);
      }
      const unset = new EnvKekProvider(undefined, undefined);
      expect(() => unset.requestDigest(alice, data)).toThrow(SealingError);
      expect(unset.matchesRequestDigest(digest, alice, data)).toBe(false);
    });
  });

  it('recognises well-formed ids only', () => {
    expect(['v1', '2026-10', 'a'].every(isKekId)).toBe(true);
    expect(['', 'V1', '-a', 'a_b', 'a b'].some(isKekId)).toBe(false);
  });
});
