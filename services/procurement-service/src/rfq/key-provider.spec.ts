import { randomBytes } from 'node:crypto';
import {
  NONCE_BYTES,
  SealingError,
  aeadEncrypt,
  generateSealingKeyPair,
  lengthPrefixed,
} from '@rasta/sealing';
import {
  EnvKekProvider,
  isKekId,
  parseKekConfiguration,
  parseKekEntries,
  type KeyContext,
  type WrappedKey,
} from './key-provider';

/**
 * The seam between an RFQ's private key and the KEK that keeps it (ADR-070 § 4): binding, rotation,
 * a configuration that fails closed without ever repeating a key, and a wrapping that is this
 * service's own — never a tender key's.
 */

jest.setTimeout(60_000);

const K1 = randomBytes(32).toString('base64');
const K2 = randomBytes(32).toString('base64');
const CONTEXT: KeyContext = { rfqId: 'RFQ_A', keyId: 'RFK_1' };

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    return error instanceof SealingError ? error.code : 'OTHER';
  }
  return undefined;
};

describe('EnvKekProvider (RFQ keys)', () => {
  const provider = new EnvKekProvider(`v1:${K1}`, 'v1');
  let der: Buffer;
  let wrapped: WrappedKey;

  beforeAll(async () => {
    der = (await generateSealingKeyPair()).privateKeyDer;
    wrapped = provider.wrap(der, CONTEXT);
  });

  it('wraps a private key so the database never holds it, and unwraps it exactly', () => {
    expect(wrapped.kekId).toBe('v1');
    expect(wrapped.nonce).toHaveLength(NONCE_BYTES);
    expect(wrapped.ciphertext.includes(der.subarray(0, 32))).toBe(false);
    expect(provider.unwrap(wrapped, CONTEXT).equals(der)).toBe(true);
  });

  it('does not touch the key it was given', () => {
    const copy = Buffer.from(der);
    provider.wrap(der, CONTEXT);
    expect(der.equals(copy)).toBe(true);
  });

  it('binds the wrapping to its RFQ and key: moved to another, it does not unwrap', () => {
    expect(codeOf(() => provider.unwrap(wrapped, { ...CONTEXT, rfqId: 'RFQ_B' }))).toBe('TAMPERED');
    expect(codeOf(() => provider.unwrap(wrapped, { ...CONTEXT, keyId: 'RFK_2' }))).toBe('TAMPERED');
  });

  it('never unwraps a key wrapped the way construction wraps a tender key, under the same KEK', () => {
    const nonce = randomBytes(NONCE_BYTES);
    const tenderStyle = aeadEncrypt(
      Buffer.from(K1, 'base64'),
      nonce,
      lengthPrefixed('rasta.tenderkey.aad.v1', CONTEXT.rfqId, CONTEXT.keyId, 'v1'),
      der,
    );
    expect(codeOf(() => provider.unwrap({ kekId: 'v1', nonce, ...tenderStyle }, CONTEXT))).toBe(
      'TAMPERED',
    );
  });

  it('rotates: a new current KEK wraps, the old one still unwraps what it wrapped', () => {
    const rotated = new EnvKekProvider(`v1:${K1},v2:${K2}`, 'v2');
    expect(rotated.unwrap(wrapped, CONTEXT).equals(der)).toBe(true);
    const again = rotated.wrap(der, CONTEXT);
    expect(again.kekId).toBe('v2');
    expect(codeOf(() => provider.unwrap(again, CONTEXT))).toBe('KEY_UNAVAILABLE');
  });

  it('with no KEK configured, wraps nothing: KEY_UNAVAILABLE, no default key', () => {
    const none = new EnvKekProvider(undefined, undefined);
    expect(none.configured).toBe(false);
    expect(codeOf(() => none.wrap(der, CONTEXT))).toBe('KEY_UNAVAILABLE');
    expect(codeOf(() => none.unwrap(wrapped, CONTEXT))).toBe('KEY_UNAVAILABLE');
  });
});

describe('the KEK configuration', () => {
  it('accepts id:base64 pairs of 32 bytes, and names the current one', () => {
    const parsed = parseKekConfiguration(`a-1:${K1}, b:${K2}`, 'b');
    expect(parsed?.currentId).toBe('b');
    expect([...(parsed?.keys.keys() ?? [])]).toEqual(['a-1', 'b']);
    expect(parseKekConfiguration(undefined, undefined)).toBeUndefined();
    expect(parseKekConfiguration('', '')).toBeUndefined();
  });

  it.each([
    ['a short key', `v1:${randomBytes(16).toString('base64')}`, 'v1'],
    ['no separator', K1, 'v1'],
    ['a bad id', `V1:${K1}`, 'V1'],
    ['a duplicate id', `v1:${K1},v1:${K2}`, 'v1'],
    ['non-canonical base64', `v1:${K1.replace(/=+$/, '')}`, 'v1'],
    ['a current id that is not listed', `v1:${K1}`, 'v2'],
    ['a current id without keys', '', 'v1'],
  ])('refuses %s, and never repeats the value', (_label, keys, current) => {
    let message = '';
    try {
      parseKekConfiguration(keys, current);
    } catch (error) {
      message = (error as Error).message;
      expect(error).toBeInstanceOf(SealingError);
      expect((error as SealingError).code).toBe('INVALID_CONFIGURATION');
    }
    expect(message).not.toBe('');
    expect(message).not.toContain(K1);
    expect(message).not.toContain(K2);
  });

  it('reads the entries alone, empty when unset', () => {
    expect(parseKekEntries(undefined).size).toBe(0);
    expect(parseKekEntries(`v1:${K1}`).get('v1')).toEqual(Buffer.from(K1, 'base64'));
    expect(isKekId('v1')).toBe(true);
    expect(isKekId('-v1')).toBe(false);
  });
});
