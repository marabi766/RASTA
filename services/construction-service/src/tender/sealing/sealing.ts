import {
  constants,
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  generateKeyPair as nodeGenerateKeyPair,
  privateDecrypt,
  publicEncrypt,
  randomBytes,
  timingSafeEqual,
  type KeyObject,
} from 'node:crypto';
import { promisify } from 'node:util';
import { canonicalize } from './canonical';
import { SealingError } from './errors';

/**
 * Sealing a bid (ADR-066 § 2) and proving it was not changed (§ 3).
 *
 * ## What this module is, and is not
 *
 * Pure functions over `node:crypto`: no database, no clock, no I/O, no
 * configuration. It never decides **who** may open a bid or **when** — that is
 * the tender's state and the caller's authorization. What it guarantees is
 * mechanical:
 *
 *   - a bid sealed here can be opened only with the tender's private key;
 *   - the sealed bytes are bound to the tender, the bid, the bidder, the
 *     revision and the key, so a ciphertext cannot be lifted into another bid;
 *   - a commitment recorded at submission detects a change of content afterwards,
 *     even by someone holding the tender's **public** key who re-encrypts other
 *     content (the salt inside the sealed content is what they cannot know).
 *
 * It does **not** make the operator unable to read a bid: whoever holds the
 * key-encryption key and the database can. That limit is ADR-066 § 1 and D-043;
 * nothing here claims otherwise.
 *
 * ## Construction
 *
 *   per tender   an RSA-3072 key pair; the private half is wrapped by a KEK
 *                (`key-provider.ts`) and stored, the public half is stored plain;
 *   per bid      a random AES-256-GCM content key encrypts the content; that key
 *                is wrapped to the tender's public key with RSA-OAEP (SHA-256).
 *                At submission time the service holds only the public key.
 *
 * Every hashed or authenticated structure is encoded with {@link lengthPrefixed},
 * never by joining strings, so two different field lists cannot produce the same
 * bytes (`"ab" + "c"` vs `"a" + "bc"`).
 */

const generateKeyPairAsync = promisify(nodeGenerateKeyPair);

export const CONTENT_KEY_BYTES = 32;
export const NONCE_BYTES = 12;
export const SALT_BYTES = 32;
export const TAG_BYTES = 16;
export const RSA_MODULUS_BITS = 3072;

/** Sealed content is text a bidder typed; a megabyte would be a storage vector, not a bid. */
export const MAX_CONTENT_BYTES = 256 * 1024;

const SEAL_VERSION = 1;

/** Everything a sealed bid is bound to. A change to any field fails opening. */
export interface BidBinding {
  readonly tenderId: string;
  readonly bidId: string;
  readonly bidderOrganizationId: string;
  readonly revision: number;
  /** Which tender key pair sealed it. */
  readonly keyId: string;
}

export interface SealedBid {
  readonly version: number;
  readonly keyId: string;
  readonly nonce: Buffer;
  readonly ciphertext: Buffer;
  readonly tag: Buffer;
  /** The content key, wrapped to the tender's public key. */
  readonly wrappedContentKey: Buffer;
  /** hex SHA-256 over the salt and the canonical content. Safe to publish. */
  readonly contentCommitment: string;
  /** hex SHA-256 over everything stored. Safe to publish. */
  readonly ciphertextSha256: string;
}

export interface TenderKeyPair {
  readonly publicKeyPem: string;
  /** PKCS#8 DER. The caller wraps it and drops it (`fill(0)`); it is never stored as is. */
  readonly privateKeyDer: Buffer;
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

/** `uint32-be length` then the bytes, for each part, after a domain label. */
export function lengthPrefixed(label: string, ...parts: (string | Buffer)[]): Buffer {
  const chunks: Buffer[] = [];
  for (const part of [label, ...parts]) {
    const bytes = typeof part === 'string' ? Buffer.from(part, 'utf8') : part;
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    chunks.push(length, bytes);
  }
  return Buffer.concat(chunks);
}

const sha256Hex = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

function associatedData(binding: BidBinding): Buffer {
  return lengthPrefixed(
    'rasta.bid.aad.v1',
    binding.tenderId,
    binding.bidId,
    binding.bidderOrganizationId,
    String(binding.revision),
    binding.keyId,
  );
}

// ---------------------------------------------------------------------------
// AES-256-GCM
// ---------------------------------------------------------------------------

/** The AEAD used for both the bid content and the wrapped private key. Exported for the vectors. */
export function aeadEncrypt(
  key: Buffer,
  nonce: Buffer,
  aad: Buffer,
  plaintext: Buffer,
): { ciphertext: Buffer; tag: Buffer } {
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ciphertext, tag: cipher.getAuthTag() };
}

export function aeadDecrypt(
  key: Buffer,
  nonce: Buffer,
  aad: Buffer,
  ciphertext: Buffer,
  tag: Buffer,
): Buffer {
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    // Wrong key, tag, nonce, AAD or ciphertext all look the same from outside,
    // and must: a caller must not learn which part failed.
    throw new SealingError('TAMPERED');
  }
}

// ---------------------------------------------------------------------------
// Tender key pair
// ---------------------------------------------------------------------------

export async function generateTenderKeyPair(): Promise<TenderKeyPair> {
  const { publicKey, privateKey } = await generateKeyPairAsync('rsa', {
    modulusLength: RSA_MODULUS_BITS,
    publicExponent: 0x10001,
  });
  return {
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKeyDer: privateKey.export({ type: 'pkcs8', format: 'der' }),
  };
}

export function privateKeyFromDer(der: Buffer): KeyObject {
  try {
    return createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  } catch {
    throw new SealingError('KEY_UNAVAILABLE');
  }
}

// ---------------------------------------------------------------------------
// Sealing and opening a bid
// ---------------------------------------------------------------------------

export function commitmentOf(salt: Buffer, canonicalContent: string): string {
  return sha256Hex(lengthPrefixed('rasta.bid.commitment.v1', salt, canonicalContent));
}

function ciphertextDigest(
  parts: Pick<SealedBid, 'keyId' | 'nonce' | 'ciphertext' | 'tag' | 'wrappedContentKey'>,
): string {
  return sha256Hex(
    lengthPrefixed(
      'rasta.bid.ciphertext.v1',
      parts.keyId,
      parts.nonce,
      parts.ciphertext,
      parts.tag,
      parts.wrappedContentKey,
    ),
  );
}

/**
 * Seals `content` for a tender. Needs only the tender's public key.
 *
 * The content is canonicalised (`canonical.ts`), given a fresh 32-byte salt, and
 * committed to. The salt and the content are what is encrypted — the commitment
 * (which a consumer may see) reveals neither.
 */
export function sealBid(input: {
  publicKeyPem: string;
  binding: BidBinding;
  content: unknown;
}): SealedBid {
  const canonicalContent = canonicalize(input.content);
  const salt = randomBytes(SALT_BYTES);
  const plaintext = Buffer.from(
    canonicalize({ v: SEAL_VERSION, salt: salt.toString('base64'), content: input.content }),
    'utf8',
  );
  if (plaintext.length > MAX_CONTENT_BYTES) throw new SealingError('INVALID_CONTENT');

  const contentKey = randomBytes(CONTENT_KEY_BYTES);
  const nonce = randomBytes(NONCE_BYTES);
  try {
    const { ciphertext, tag } = aeadEncrypt(
      contentKey,
      nonce,
      associatedData(input.binding),
      plaintext,
    );
    let wrappedContentKey: Buffer;
    try {
      wrappedContentKey = publicEncrypt(
        { key: input.publicKeyPem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
        contentKey,
      );
    } catch {
      throw new SealingError('KEY_UNAVAILABLE');
    }
    const parts = { keyId: input.binding.keyId, nonce, ciphertext, tag, wrappedContentKey };
    return {
      version: SEAL_VERSION,
      ...parts,
      contentCommitment: commitmentOf(salt, canonicalContent),
      ciphertextSha256: ciphertextDigest(parts),
    };
  } finally {
    contentKey.fill(0);
    plaintext.fill(0);
    salt.fill(0);
  }
}

/**
 * Opens a sealed bid with the tender's private key.
 *
 * Fails `TAMPERED` if the ciphertext, its tag, the binding or the key do not
 * verify, and `COMMITMENT_MISMATCH` if it decrypts but the content is not the
 * content committed to at submission — for example because someone with the
 * public key sealed other content and kept the old commitment.
 */
export function openBid(input: {
  privateKey: KeyObject;
  binding: BidBinding;
  sealed: SealedBid;
}): unknown {
  const { sealed, binding } = input;
  if (sealed.version !== SEAL_VERSION || sealed.keyId !== binding.keyId) {
    throw new SealingError('TAMPERED');
  }

  let contentKey: Buffer;
  try {
    contentKey = privateDecrypt(
      {
        key: input.privateKey,
        padding: constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256',
      },
      sealed.wrappedContentKey,
    );
  } catch {
    throw new SealingError('TAMPERED');
  }

  let plaintext: Buffer | undefined;
  try {
    plaintext = aeadDecrypt(
      contentKey,
      sealed.nonce,
      associatedData(binding),
      sealed.ciphertext,
      sealed.tag,
    );

    let parsed: { v?: unknown; salt?: unknown; content?: unknown };
    try {
      parsed = JSON.parse(plaintext.toString('utf8')) as typeof parsed;
    } catch {
      throw new SealingError('TAMPERED');
    }
    if (parsed.v !== SEAL_VERSION || typeof parsed.salt !== 'string') {
      throw new SealingError('TAMPERED');
    }
    const salt = Buffer.from(parsed.salt, 'base64');
    const recomputed = Buffer.from(commitmentOf(salt, canonicalize(parsed.content)), 'hex');
    const committed = Buffer.from(sealed.contentCommitment, 'hex');
    salt.fill(0);
    if (recomputed.length !== committed.length || !timingSafeEqual(recomputed, committed)) {
      throw new SealingError('COMMITMENT_MISMATCH');
    }
    return parsed.content;
  } finally {
    contentKey.fill(0);
    plaintext?.fill(0);
  }
}

// ---------------------------------------------------------------------------
// The receipt chain (ADR-066 § 3)
// ---------------------------------------------------------------------------

/** What a receipt commits to. Every field is safe to publish. */
export interface ReceiptLink {
  readonly bidId: string;
  readonly revision: number;
  readonly receivedAt: Date;
  readonly ciphertextSha256: string;
  readonly contentCommitment: string;
}

/** The chain of a tender starts here, so two tenders' chains can never be spliced. */
export function genesisReceipt(tenderId: string): string {
  return sha256Hex(lengthPrefixed('rasta.bid.receipt.genesis.v1', tenderId));
}

export function nextReceipt(tenderId: string, previous: string, link: ReceiptLink): string {
  return sha256Hex(
    lengthPrefixed(
      'rasta.bid.receipt.v1',
      tenderId,
      previous,
      link.bidId,
      String(link.revision),
      link.receivedAt.toISOString(),
      link.ciphertextSha256,
      link.contentCommitment,
    ),
  );
}

export type ChainVerdict = { ok: true } | { ok: false; brokenAt: number };

/**
 * Walks a tender's receipts in the order they were issued. `brokenAt` is the
 * index of the first link that does not follow from the one before it — a link
 * that was edited, removed, reordered or spliced in from elsewhere.
 */
export function verifyReceiptChain(
  tenderId: string,
  links: readonly (ReceiptLink & { readonly receipt: string })[],
): ChainVerdict {
  let previous = genesisReceipt(tenderId);
  for (const [index, link] of links.entries()) {
    const expected = nextReceipt(tenderId, previous, link);
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(link.receipt, 'utf8');
    if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, brokenAt: index };
    previous = link.receipt;
  }
  return { ok: true };
}
