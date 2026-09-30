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

/**
 * The digest a receipt commits to for the stored bytes. Recomputed from them,
 * never read from the stored `ciphertextSha256`, when a bid is opened.
 */
export function ciphertextDigest(
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

/** Two hex digests equal, in constant time. */
function sameDigest(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * What the caller must hold to open a bid: the tender's receipts, in the order
 * they were issued, and the **head** — the newest receipt — as kept somewhere the
 * service's own database cannot rewrite (audit-service holds every receipt,
 * ADR-066 § 3). Without them there is nothing to check a stored bid against, and
 * a stored bid is exactly what an operator could have replaced.
 */
export interface TrustedReceipts {
  readonly links: readonly (ReceiptLink & { readonly receipt: string })[];
  readonly head: string;
}

/**
 * Opens a sealed bid with the tender's private key — **only** against the receipts
 * that were issued when it was submitted (Codex review of #163).
 *
 * Opening compares the bid with what the bidder was given, not with what the
 * database now says about itself. In order, before any decryption:
 *
 *   1. the receipt chain verifies, link by link, and ends at the trusted head
 *      (`RECEIPT_CHAIN_BROKEN`: an edited, removed, reordered, spliced or
 *      truncated chain, or one that ends somewhere the trusted copy does not);
 *   2. the bid has a receipt, and the newest one it has is for this revision
 *      (`RECEIPT_MISMATCH`: a stale or invented revision);
 *   3. the digest **recomputed** from the stored ciphertext, tag, nonce, wrapped
 *      key and key id equals the receipted one, and so does the stored
 *      commitment (`RECEIPT_MISMATCH`: a substituted bid — whether re-sealed with
 *      the public key or altered byte by byte — even one whose own stored digest
 *      and commitment were rewritten to match).
 *
 * Then it decrypts (`TAMPERED` if the tag, the binding or the key do not verify)
 * and checks the decrypted content against the receipted commitment
 * (`COMMITMENT_MISMATCH`).
 */
export function openBid(input: {
  privateKey: KeyObject;
  binding: BidBinding;
  sealed: SealedBid;
  receipts: TrustedReceipts;
}): unknown {
  const { sealed, binding, receipts } = input;
  if (sealed.version !== SEAL_VERSION || sealed.keyId !== binding.keyId) {
    throw new SealingError('TAMPERED');
  }

  const verdict = verifyReceiptChain(binding.tenderId, receipts.links, receipts.head);
  if (!verdict.ok) throw new SealingError('RECEIPT_CHAIN_BROKEN');

  const receiptsOfBid = receipts.links.filter((link) => link.bidId === binding.bidId);
  const receipted = receiptsOfBid[receiptsOfBid.length - 1];
  if (!receipted || receipted.revision !== binding.revision) {
    throw new SealingError('RECEIPT_MISMATCH');
  }
  const recomputedDigest = ciphertextDigest(sealed);
  if (
    !sameDigest(recomputedDigest, receipted.ciphertextSha256) ||
    !sameDigest(sealed.ciphertextSha256, receipted.ciphertextSha256) ||
    !sameDigest(sealed.contentCommitment, receipted.contentCommitment)
  ) {
    throw new SealingError('RECEIPT_MISMATCH');
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
    const recomputed = commitmentOf(salt, canonicalize(parsed.content));
    salt.fill(0);
    // Against the receipted commitment, which is the bidder's copy — never the
    // stored one alone.
    if (!sameDigest(recomputed, receipted.contentCommitment)) {
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

export type ChainVerdict =
  | { ok: true }
  /** The link at `brokenAt` does not follow from the one before it. */
  | { ok: false; reason: 'LINK_BROKEN'; brokenAt: number }
  /** Every link verifies, but the chain does not end at the trusted head. */
  | { ok: false; reason: 'HEAD_MISMATCH' };

/**
 * Walks a tender's receipts in the order they were issued and checks where they
 * end. `LINK_BROKEN` names the first link that does not follow from the one
 * before it — one that was edited, removed, reordered or spliced in from
 * elsewhere. `HEAD_MISMATCH` is a chain that is internally sound but is not the
 * chain that was issued: cut short, extended, or replaced whole.
 *
 * `trustedHead` is **required**. A chain checked against nothing but itself
 * proves only that it is self-consistent, and a consistent forgery is one call
 * away for anyone who can write the table. The head is the newest receipt as
 * held outside this service's database (audit-service, from `BID_SUBMITTED`); an
 * empty chain's head is {@link genesisReceipt}.
 */
export function verifyReceiptChain(
  tenderId: string,
  links: readonly (ReceiptLink & { readonly receipt: string })[],
  trustedHead: string,
): ChainVerdict {
  let previous = genesisReceipt(tenderId);
  for (const [index, link] of links.entries()) {
    if (!sameDigest(nextReceipt(tenderId, previous, link), link.receipt)) {
      return { ok: false, reason: 'LINK_BROKEN', brokenAt: index };
    }
    previous = link.receipt;
  }
  return sameDigest(previous, trustedHead) ? { ok: true } : { ok: false, reason: 'HEAD_MISMATCH' };
}
