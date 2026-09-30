import { randomBytes } from 'node:crypto';
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
        receipts: { links: [{ ...link, receipt }], head: receipt },
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

  it('recognises well-formed ids only', () => {
    expect(['v1', '2026-10', 'a'].every(isKekId)).toBe(true);
    expect(['', 'V1', '-a', 'a_b', 'a b'].some(isKekId)).toBe(false);
  });
});
