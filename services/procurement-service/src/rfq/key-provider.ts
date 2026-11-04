import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  NONCE_BYTES,
  SALT_BYTES,
  SealingError,
  aeadDecrypt,
  aeadEncrypt,
  lengthPrefixed,
} from '@rasta/sealing';

/**
 * Where an RFQ's private sealing key is kept safe, and who can get it back (ADR-070 § 4, the seam
 * of ADR-066 § 2 that construction-service's tender keys go through).
 *
 * An RFQ's private key never touches the database in the clear: it is wrapped by a key-encryption
 * key (KEK) that lives outside the database — `PROCUREMENT_RFQ_KEKS`, never construction's, so a
 * bid's key and a quotation's are wrapped apart. This interface is the seam: the MVP reads the
 * KEK from the environment ({@link EnvKekProvider}); a KMS that releases a key only after a time,
 * or only to a quorum, is another implementation of it (D-043, D-055).
 *
 * The AEAD is `@rasta/sealing`'s (plan PR 4), the same construction uses; the binding label is
 * this service's own (`rasta.rfqkey.aad.v1`), so a wrapped RFQ key never unwraps as a tender key
 * or the other way round.
 *
 * What this seam does **not** decide is when a key may be released. That is the RFQ's state,
 * enforced by the caller before it ever asks (the opening of plan PR 9).
 */

/** What a wrapped key is bound to, so it cannot be moved to another RFQ or key pair. */
export interface KeyContext {
  readonly rfqId: string;
  readonly keyId: string;
}

/** A private key, wrapped. Stored as is; useless without the KEK named by `kekId`. */
export interface WrappedKey {
  readonly kekId: string;
  readonly nonce: Buffer;
  readonly ciphertext: Buffer;
  readonly tag: Buffer;
}

export interface RfqKeyProvider {
  /** Wraps a PKCS#8 private key. Never mutates or retains `privateKeyDer`. */
  wrap(privateKeyDer: Buffer, context: KeyContext): WrappedKey;
  /** Returns the PKCS#8 private key. The caller zeroises it (`fill(0)`) when done. */
  unwrap(wrapped: WrappedKey, context: KeyContext): Buffer;
  /**
   * A keyed, salted digest of a quotation command's request, bound to who asked — what the
   * idempotency store keeps instead of the plain SHA-256 it keeps for other commands (plan PR 8;
   * the construction design of Codex r1 on #250, R1). The request is the price: a plain digest of a
   * low-entropy price lets any reader of a backup confirm a guess. Under a key derived from the
   * current KEK (never stored with the data), salted per call, the organization and the user inside
   * the MAC — so no two digests compare, and a reader who can also quote cannot test candidates.
   * Stored as `hmac-v1:<kekId>:<salt>:<mac>`, so a rotation keeps recognising it while the KEK is
   * kept. No KEK: throws `KEY_UNAVAILABLE` (and no quotation could be sealed either).
   */
  requestDigest(context: RequestDigestContext, data: string): string;
  /** Whether `stored` is a `requestDigest(context, data)`; anything else, an unknown KEK included: false. */
  matchesRequestDigest(stored: string, context: RequestDigestContext, data: string): boolean;
}

/** Who a keyed request digest belongs to: both are inside its MAC. */
export interface RequestDigestContext {
  readonly organizationId: string;
  readonly userId: string;
}

const KEK_BYTES = 32;
const KEK_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;

export interface KekConfiguration {
  readonly keys: ReadonlyMap<string, Buffer>;
  readonly currentId: string;
}

/**
 * Parses `PROCUREMENT_RFQ_KEKS` (`id:base64,id:base64`, each key 32 bytes) and
 * `PROCUREMENT_RFQ_KEK_CURRENT`.
 *
 * The messages name nothing of a bad entry: its value is a secret, and a configuration error is
 * exactly what ends up in a log.
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

/** The entries of `PROCUREMENT_RFQ_KEKS`, validated on their own; empty when unset. */
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
  return lengthPrefixed('rasta.rfqkey.aad.v1', context.rfqId, context.keyId, kekId);
}

/**
 * The MVP provider: KEKs from the environment, versioned so one can be rotated in while the old
 * stays available to unwrap what it wrapped.
 *
 * **Its limit is the ADR's limit.** Whoever can read this process's environment and the database
 * can unwrap every RFQ key (ADR-070 § 4: "enforced by the application and tamper-evident"). With no
 * KEK configured it wraps and unwraps nothing (`KEY_UNAVAILABLE`) rather than falling back to a
 * default.
 */
export class EnvKekProvider implements RfqKeyProvider {
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

  requestDigest(context: RequestDigestContext, data: string): string {
    const configuration = this.configuration;
    const kek = configuration?.keys.get(configuration.currentId);
    if (!configuration || !kek) throw new SealingError('KEY_UNAVAILABLE');
    const salt = randomBytes(SALT_BYTES);
    const mac = requestMac(kek, salt, context, data);
    return [
      REQUEST_DIGEST_VERSION,
      configuration.currentId,
      salt.toString('hex'),
      mac.toString('hex'),
    ].join(':');
  }

  matchesRequestDigest(stored: string, context: RequestDigestContext, data: string): boolean {
    const [version, kekId, saltHex, macHex, ...rest] = stored.split(':');
    if (version !== REQUEST_DIGEST_VERSION || !kekId || !saltHex || !macHex || rest.length > 0) {
      return false;
    }
    const kek = this.configuration?.keys.get(kekId);
    if (!kek) return false;
    const salt = Buffer.from(saltHex, 'hex');
    if (salt.length !== SALT_BYTES || salt.toString('hex') !== saltHex) return false;
    const expected = requestMac(kek, salt, context, data);
    const actual = Buffer.from(macHex, 'hex');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }
}

/** The stored form of a keyed request digest: `hmac-v1:<kekId>:<salt hex>:<mac hex>`. */
const REQUEST_DIGEST_VERSION = 'hmac-v1';
const REQUEST_DIGEST_LABEL = 'rasta.procurement.request-digest.v1';

/**
 * HMAC-SHA256 under a key derived from the KEK (HKDF-SHA256, its own label: the KEK itself keys
 * nothing but the wrapping), over the salt, the requester and the data, length-prefixed.
 */
function requestMac(
  kek: Buffer,
  salt: Buffer,
  context: RequestDigestContext,
  data: string,
): Buffer {
  const key = Buffer.from(hkdfSync('sha256', kek, Buffer.alloc(0), REQUEST_DIGEST_LABEL, 32));
  try {
    return createHmac('sha256', key)
      .update(
        lengthPrefixed(REQUEST_DIGEST_LABEL, salt, context.organizationId, context.userId, data),
      )
      .digest();
  } finally {
    key.fill(0);
  }
}
