import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { NONCE_BYTES, aeadDecrypt, aeadEncrypt, lengthPrefixed } from './sealing';
import { SealingError } from './errors';

/**
 * Where a tender's private key is kept safe, and who can get it back
 * (ADR-066 § 2).
 *
 * The tender's private key never touches the database in the clear: it is
 * wrapped by a key-encryption key (KEK) that lives outside the database. This
 * interface is the seam. The MVP implementation reads the KEK from the
 * environment ({@link EnvKekProvider}); a KMS that releases a key only after a
 * time, or only to a quorum, is another implementation of the same interface —
 * and is the only thing that would make the operator cryptographically unable to
 * open a bid early (ADR-066 § 1, D-043, Q-87). Nothing above this seam changes
 * when it arrives.
 *
 * What this seam does **not** decide is when a key may be released. That is the
 * tender's state, enforced by the caller before it ever asks (`open-bids`).
 */

/** What a wrapped key is bound to, so it cannot be moved to another tender or key pair. */
export interface KeyContext {
  readonly tenderId: string;
  readonly keyId: string;
}

/** A private key, wrapped. Stored as is; useless without the KEK named by `kekId`. */
export interface WrappedKey {
  readonly kekId: string;
  readonly nonce: Buffer;
  readonly ciphertext: Buffer;
  readonly tag: Buffer;
}

export interface TenderKeyProvider {
  /** Wraps a PKCS#8 private key. Never mutates or retains `privateKeyDer`. */
  wrap(privateKeyDer: Buffer, context: KeyContext): WrappedKey;
  /** Returns the PKCS#8 private key. The caller zeroises it (`fill(0)`) when done. */
  unwrap(wrapped: WrappedKey, context: KeyContext): Buffer;
  /**
   * A keyed digest of request data, under the current KEK, to be stored where an unkeyed hash
   * would let a reader of the database guess a low-entropy body offline — a sealed bid's price
   * (ADR-066 § 1: the commitment is salted for the same reason). It names the KEK it was made
   * under, so `matchesRequestDigest` recognises it after a rotation while that KEK is kept.
   */
  requestDigest(data: string): string;
  /** Whether `stored` is `requestDigest(data)` under the KEK it names. Unknown KEK: false. */
  matchesRequestDigest(stored: string, data: string): boolean;
}

const KEK_BYTES = 32;
const KEK_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;

export interface KekConfiguration {
  readonly keys: ReadonlyMap<string, Buffer>;
  readonly currentId: string;
}

/**
 * Parses `CONSTRUCTION_TENDER_KEKS` (`id:base64,id:base64`, each key 32 bytes) and
 * `CONSTRUCTION_TENDER_KEK_CURRENT`.
 *
 * The messages name the position of a bad entry, never its value: the value is a
 * secret, and a configuration error is exactly what ends up in a log.
 */
export function parseKekConfiguration(
  keys: string | undefined,
  current: string | undefined,
): KekConfiguration | undefined {
  const parsed = parseKekEntries(keys);
  if (parsed.size === 0) {
    if (current?.trim()) throw new SealingError('INVALID_CONFIGURATION');
    return undefined;
  }

  const currentId = current?.trim() ?? '';
  if (!parsed.has(currentId)) throw new SealingError('INVALID_CONFIGURATION');
  return { keys: parsed, currentId };
}

/** Whether `id` is a well-formed KEK version name. */
export function isKekId(id: string): boolean {
  return KEK_ID.test(id);
}

/** The entries of `CONSTRUCTION_TENDER_KEKS`, validated on their own; empty when unset. */
export function parseKekEntries(keys: string | undefined): Map<string, Buffer> {
  const raw = keys?.trim() ?? '';
  const parsed = new Map<string, Buffer>();
  if (raw === '') return parsed;

  for (const entry of raw.split(',')) {
    const separator = entry.indexOf(':');
    const id = separator < 0 ? '' : entry.slice(0, separator).trim();
    const encoded = separator < 0 ? '' : entry.slice(separator + 1).trim();
    const bytes = Buffer.from(encoded, 'base64');
    if (
      !KEK_ID.test(id) ||
      parsed.has(id) ||
      bytes.length !== KEK_BYTES ||
      bytes.toString('base64') !== encoded
    ) {
      throw new SealingError('INVALID_CONFIGURATION');
    }
    parsed.set(id, bytes);
  }
  return parsed;
}

function aadOf(context: KeyContext, kekId: string): Buffer {
  return lengthPrefixed('rasta.tenderkey.aad.v1', context.tenderId, context.keyId, kekId);
}

/**
 * The MVP provider: KEKs from the environment, versioned so one can be rotated
 * in while the old stays available to unwrap what it wrapped.
 *
 * **Its limit is the ADR's limit.** Whoever can read this process's environment
 * and the database can unwrap every tender key. With no KEK configured it wraps
 * and unwraps nothing (`KEY_UNAVAILABLE`) rather than falling back to a default.
 */
export class EnvKekProvider implements TenderKeyProvider {
  private readonly configuration: KekConfiguration | undefined;

  constructor(keys: string | undefined, current: string | undefined) {
    this.configuration = parseKekConfiguration(keys, current);
  }

  get configured(): boolean {
    return this.configuration !== undefined;
  }

  wrap(privateKeyDer: Buffer, context: KeyContext): WrappedKey {
    const configuration = this.configuration;
    if (!configuration) throw new SealingError('KEY_UNAVAILABLE');
    const kek = configuration.keys.get(configuration.currentId);
    if (!kek) throw new SealingError('KEY_UNAVAILABLE');

    const nonce = randomBytes(NONCE_BYTES);
    const { ciphertext, tag } = aeadEncrypt(
      kek,
      nonce,
      aadOf(context, configuration.currentId),
      privateKeyDer,
    );
    return { kekId: configuration.currentId, nonce, ciphertext, tag };
  }

  unwrap(wrapped: WrappedKey, context: KeyContext): Buffer {
    const kek = this.configuration?.keys.get(wrapped.kekId);
    if (!kek) throw new SealingError('KEY_UNAVAILABLE');
    return aeadDecrypt(
      kek,
      wrapped.nonce,
      aadOf(context, wrapped.kekId),
      wrapped.ciphertext,
      wrapped.tag,
    );
  }

  requestDigest(data: string): string {
    const configuration = this.configuration;
    if (!configuration) throw new SealingError('KEY_UNAVAILABLE');
    const kek = configuration.keys.get(configuration.currentId);
    if (!kek) throw new SealingError('KEY_UNAVAILABLE');
    return `${REQUEST_DIGEST_VERSION}:${configuration.currentId}:${requestMac(kek, data).toString('hex')}`;
  }

  matchesRequestDigest(stored: string, data: string): boolean {
    const [version, kekId, hex, ...rest] = stored.split(':');
    if (version !== REQUEST_DIGEST_VERSION || !kekId || !hex || rest.length > 0) return false;
    const kek = this.configuration?.keys.get(kekId);
    if (!kek) return false;
    const expected = requestMac(kek, data);
    const actual = Buffer.from(hex, 'hex');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }
}

/** The stored form of a keyed request digest: `hmac-v1:<kekId>:<hex>`. */
const REQUEST_DIGEST_VERSION = 'hmac-v1';

/**
 * HMAC-SHA256 of `data` under a key derived from the KEK (HKDF-SHA256, its own label): the KEK
 * itself never keys anything but the wrapping, and the derived key is used for nothing else.
 */
function requestMac(kek: Buffer, data: string): Buffer {
  const key = Buffer.from(
    hkdfSync('sha256', kek, Buffer.alloc(0), 'rasta.construction.request-digest.v1', 32),
  );
  try {
    return createHmac('sha256', key).update(data, 'utf8').digest();
  } finally {
    key.fill(0);
  }
}
