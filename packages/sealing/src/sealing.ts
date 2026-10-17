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
 * Sealing content in an envelope (ADR-066 § 2) and proving it was not changed (§ 3).
 *
 * ## What this module is, and is not
 *
 * Pure functions over `node:crypto`: no database, no clock, no I/O, no
 * configuration. It never decides **who** may open an envelope or **when** — that
 * is the consumer's state and the caller's authorization. What it guarantees is
 * mechanical:
 *
 *   - an envelope sealed here can be opened only with its scope's private key;
 *   - the sealed bytes are bound to the scope, the entry, the submitter, the
 *     revision and the key, so a ciphertext cannot be lifted into another entry;
 *   - a commitment recorded at submission detects a change of content afterwards,
 *     even by someone holding the scope's **public** key who re-encrypts other
 *     content (the salt inside the sealed content is what they cannot know).
 *
 * It does **not** make the operator unable to read an envelope: whoever holds the
 * key-encryption key and the database can. That limit is ADR-066 § 1 and D-043;
 * nothing here claims otherwise.
 *
 * ## Vocabulary
 *
 *   scope       what one key pair and one receipt chain belong to;
 *   entry       one sealed submission within a scope, revised in place;
 *   submitter   who the entry belongs to.
 *
 * A consumer maps its own nouns onto these, and names its own domain-separation
 * labels ({@link SealingLabels}): two consumers with different labels can never
 * produce each other's bytes.
 *
 * ## Construction
 *
 *   per scope    an RSA-3072 key pair; the private half is wrapped by a KEK
 *                (the consumer's) and stored, the public half is stored plain;
 *   per entry    a random AES-256-GCM content key encrypts the content; that key
 *                is wrapped to the scope's public key with RSA-OAEP (SHA-256).
 *                At submission time the consumer holds only the public key.
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

/** Sealed content is text a person typed; a megabyte would be a storage vector, not a submission. */
export const MAX_CONTENT_BYTES = 256 * 1024;

const SEAL_VERSION = 1;

/** Everything a sealed envelope is bound to. A change to any field fails opening. */
export interface EnvelopeBinding {
  readonly scopeId: string;
  readonly entryId: string;
  readonly submitterId: string;
  readonly revision: number;
  /** Which scope key pair sealed it. */
  readonly keyId: string;
}

export interface SealedEnvelope {
  readonly version: number;
  readonly keyId: string;
  readonly nonce: Buffer;
  readonly ciphertext: Buffer;
  readonly tag: Buffer;
  /** The content key, wrapped to the scope's public key. */
  readonly wrappedContentKey: Buffer;
  /** hex SHA-256 over the salt and the canonical content. Safe to publish. */
  readonly contentCommitment: string;
  /** hex SHA-256 over everything stored. Safe to publish. */
  readonly ciphertextSha256: string;
}

export interface SealingKeyPair {
  readonly publicKeyPem: string;
  /** PKCS#8 DER. The caller wraps it and drops it (`fill(0)`); it is never stored as is. */
  readonly privateKeyDer: Buffer;
}

/**
 * The domain-separation label of every structure a scheme hashes or authenticates. Part of the
 * bytes: changing one changes every commitment, digest and receipt ever made under it, and
 * opens nothing sealed before.
 */
export interface SealingLabels {
  /** The AEAD's associated data: the {@link EnvelopeBinding}. */
  readonly associatedData: string;
  /** {@link SealingScheme.commitmentOf}. */
  readonly commitment: string;
  /** {@link SealingScheme.ciphertextDigest}. */
  readonly ciphertext: string;
  /** {@link SealingScheme.genesisReceipt}. */
  readonly receiptGenesis: string;
  /** {@link SealingScheme.nextReceipt}. */
  readonly receipt: string;
}

const LABEL_NAMES = [
  'associatedData',
  'commitment',
  'ciphertext',
  'receiptGenesis',
  'receipt',
] as const satisfies readonly (keyof SealingLabels)[];

const MAX_LABEL_LENGTH = 128;

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

// ---------------------------------------------------------------------------
// AES-256-GCM
// ---------------------------------------------------------------------------

/** The AEAD used for the sealed content (and by consumers to wrap private keys). Exported for the vectors. */
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
// Scope key pair
// ---------------------------------------------------------------------------

export async function generateSealingKeyPair(): Promise<SealingKeyPair> {
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

/** Two hex digests equal, in constant time. */
function sameDigest(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

// ---------------------------------------------------------------------------
// The receipt chain (ADR-066 § 3): its shapes
// ---------------------------------------------------------------------------

/** What a receipt commits to. Every field is safe to publish. */
export interface ReceiptLink {
  readonly entryId: string;
  readonly revision: number;
  readonly receivedAt: Date;
  readonly ciphertextSha256: string;
  readonly contentCommitment: string;
}

type Receipted = ReceiptLink & { readonly receipt: string };

/**
 * What the caller must hold to open an envelope: the scope's receipts, in the order
 * they were issued, and the **head** — the newest receipt — as kept somewhere the
 * consumer's own database cannot rewrite (ADR-066 § 3). Without them there is nothing
 * to check a stored envelope against, and a stored envelope is exactly what an
 * operator could have replaced.
 */
export interface TrustedReceipts {
  readonly links: readonly Receipted[];
  readonly head: string;
}

/**
 * A scope's receipts as an outside holder answers them (ADR-066 § 2): its genesis, its head, and
 * each link with the receipt it was issued; `receivedAt` as the ISO-8601 text that was hashed.
 */
export interface ReceiptEvidence {
  readonly scopeId: string;
  readonly genesis: string;
  readonly head: string;
  readonly links: readonly {
    readonly entryId: string;
    readonly revision: number;
    readonly receivedAt: string;
    readonly ciphertextSha256: string;
    readonly contentCommitment: string;
    readonly receipt: string;
  }[];
}

export type ChainVerdict =
  | { ok: true }
  /** The link at `brokenAt` does not follow from the one before it. */
  | { ok: false; reason: 'LINK_BROKEN'; brokenAt: number }
  /** Every link verifies, but the chain does not end at the trusted head. */
  | { ok: false; reason: 'HEAD_MISMATCH' };

/** What a verification established: the scheme, the scope, its trusted head, each entry's newest receipt. */
interface VerifiedIndex {
  readonly scheme: SealingScheme;
  readonly scopeId: string;
  readonly head: string;
  readonly newest: ReadonlyMap<string, Receipted>;
}

/**
 * Only what {@link SealingScheme.verifyReceipts} made, and what it found — kept here, module-private,
 * and never on the object handed out (Codex r2 on #250): a holder of a `VerifiedReceipts` cannot
 * reach the index to change it, and opening reads the index from here, not through anything the
 * holder could replace.
 */
const VERIFIED = new WeakMap<VerifiedReceipts, VerifiedIndex>();

/** Set once, by {@link VerifiedReceipts}' static block: the only way a handle is made. */
let issueVerified: (index: VerifiedIndex) => VerifiedReceipts;

/**
 * A scope's receipts after their chain was verified against the trusted head — **once** — with
 * the newest receipt of each entry indexed by entry id.
 *
 * The chain is immutable once the scope is closed, so verifying it again for every envelope
 * opened proves nothing more and costs O(receipts) each time: at construction's caps (200 bids,
 * 10,000 receipts) that was some 30 s of hashing inside the opening's transaction (Codex r1 on
 * #250, R2). Made only by {@link SealingScheme.verifyReceipts}, from a copy of what it verified,
 * so nothing changed after the check is ever read; opening refuses any other object, and any
 * handle verified under another scheme. The object itself is a frozen handle: what it stands for
 * lives in the module-private {@link VERIFIED}.
 */
export class VerifiedReceipts {
  static {
    issueVerified = (index) => {
      const verified = new VerifiedReceipts();
      VERIFIED.set(verified, index);
      return verified;
    };
  }

  private constructor() {
    Object.freeze(this);
  }

  /** The scope whose chain was verified. */
  get scopeId(): string {
    return indexOf(this).scopeId;
  }

  /** The trusted head the chain was verified to end at. */
  get head(): string {
    return indexOf(this).head;
  }

  /** The newest receipt issued for `entryId` — a copy — or undefined when it has none. */
  newestOf(entryId: string): Receipted | undefined {
    const link = indexOf(this).newest.get(entryId);
    return link && Object.freeze({ ...link, receivedAt: new Date(link.receivedAt.getTime()) });
  }
}
Object.freeze(VerifiedReceipts);
Object.freeze(VerifiedReceipts.prototype);

function indexOf(receipts: VerifiedReceipts): VerifiedIndex {
  const index = VERIFIED.get(receipts);
  if (!index) throw new SealingError('RECEIPT_CHAIN_BROKEN');
  return index;
}

// ---------------------------------------------------------------------------
// The scheme
// ---------------------------------------------------------------------------

/**
 * Sealing, opening and the receipt chain under one set of {@link SealingLabels}. A consumer makes
 * one, at module scope, and never changes its labels.
 *
 * Refuses (`INVALID_CONFIGURATION`) a label that is empty, longer than 128 characters, or shared
 * by two of the five structures.
 */
export class SealingScheme {
  private readonly labels: SealingLabels;

  constructor(labels: SealingLabels) {
    const copy = Object.freeze({ ...labels });
    const values = LABEL_NAMES.map((name) => copy[name] as unknown);
    if (
      values.some(
        (value) =>
          typeof value !== 'string' || value.length === 0 || value.length > MAX_LABEL_LENGTH,
      ) ||
      new Set(values).size !== values.length
    ) {
      throw new SealingError('INVALID_CONFIGURATION');
    }
    this.labels = copy;
    Object.freeze(this);
  }

  /** The bytes the AEAD authenticates for `binding`. Exported for the vectors. */
  associatedDataOf(binding: EnvelopeBinding): Buffer {
    return lengthPrefixed(
      this.labels.associatedData,
      binding.scopeId,
      binding.entryId,
      binding.submitterId,
      String(binding.revision),
      binding.keyId,
    );
  }

  commitmentOf(salt: Buffer, canonicalContent: string): string {
    return sha256Hex(lengthPrefixed(this.labels.commitment, salt, canonicalContent));
  }

  /**
   * The digest a receipt commits to for the stored bytes. Recomputed from them,
   * never read from the stored `ciphertextSha256`, when an envelope is opened.
   */
  ciphertextDigest(
    parts: Pick<SealedEnvelope, 'keyId' | 'nonce' | 'ciphertext' | 'tag' | 'wrappedContentKey'>,
  ): string {
    return sha256Hex(
      lengthPrefixed(
        this.labels.ciphertext,
        parts.keyId,
        parts.nonce,
        parts.ciphertext,
        parts.tag,
        parts.wrappedContentKey,
      ),
    );
  }

  /**
   * Seals `content` for a scope. Needs only the scope's public key.
   *
   * The content is canonicalised (`canonical.ts`), given a fresh 32-byte salt, and
   * committed to. The salt and the content are what is encrypted — the commitment
   * (which a consumer may see) reveals neither.
   */
  seal(input: {
    publicKeyPem: string;
    binding: EnvelopeBinding;
    content: unknown;
  }): SealedEnvelope {
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
        this.associatedDataOf(input.binding),
        plaintext,
      );
      let wrappedContentKey: Buffer;
      try {
        wrappedContentKey = publicEncrypt(
          {
            key: input.publicKeyPem,
            padding: constants.RSA_PKCS1_OAEP_PADDING,
            oaepHash: 'sha256',
          },
          contentKey,
        );
      } catch {
        throw new SealingError('KEY_UNAVAILABLE');
      }
      const parts = { keyId: input.binding.keyId, nonce, ciphertext, tag, wrappedContentKey };
      return {
        version: SEAL_VERSION,
        ...parts,
        contentCommitment: this.commitmentOf(salt, canonicalContent),
        ciphertextSha256: this.ciphertextDigest(parts),
      };
    } finally {
      contentKey.fill(0);
      plaintext.fill(0);
      salt.fill(0);
    }
  }

  /**
   * Opens a sealed envelope with the scope's private key — **only** against the receipts
   * that were issued when it was submitted (Codex review of #163), verified once for
   * the whole scope ({@link verifyReceipts}).
   *
   * Opening compares the envelope with what the submitter was given, not with what the
   * database now says about itself. In order, before any decryption:
   *
   *   1. the receipts are a {@link VerifiedReceipts} of this scheme and this scope: their
   *      chain verified, link by link, and ended at the trusted head
   *      (`RECEIPT_CHAIN_BROKEN` otherwise);
   *   2. the entry has a receipt, and the newest one it has is for this revision
   *      (`RECEIPT_MISMATCH`: a stale or invented revision);
   *   3. the digest **recomputed** from the stored ciphertext, tag, nonce, wrapped
   *      key and key id equals the receipted one, and so does the stored
   *      commitment (`RECEIPT_MISMATCH`: a substituted envelope — whether re-sealed
   *      with the public key or altered byte by byte — even one whose own stored
   *      digest and commitment were rewritten to match).
   *
   * Then it decrypts (`TAMPERED` if the tag, the binding or the key do not verify)
   * and checks the decrypted content against the receipted commitment
   * (`COMMITMENT_MISMATCH`).
   */
  open(input: {
    privateKey: KeyObject;
    binding: EnvelopeBinding;
    sealed: SealedEnvelope;
    receipts: VerifiedReceipts;
  }): unknown {
    const { sealed, binding, receipts } = input;
    if (sealed.version !== SEAL_VERSION || sealed.keyId !== binding.keyId) {
      throw new SealingError('TAMPERED');
    }

    // Verified once for the scope (`verifyReceipts`), under this scheme, and for this one.
    // Read from the module's own record of the verification, never through the object's methods.
    const verified = VERIFIED.get(receipts);
    if (!verified || verified.scheme !== this || verified.scopeId !== binding.scopeId) {
      throw new SealingError('RECEIPT_CHAIN_BROKEN');
    }

    const receipted = verified.newest.get(binding.entryId);
    if (!receipted || receipted.revision !== binding.revision) {
      throw new SealingError('RECEIPT_MISMATCH');
    }
    const recomputedDigest = this.ciphertextDigest(sealed);
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
        this.associatedDataOf(binding),
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
      const recomputed = this.commitmentOf(salt, canonicalize(parsed.content));
      salt.fill(0);
      // Against the receipted commitment, which is the submitter's copy — never the
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

  // -------------------------------------------------------------------------
  // The receipt chain (ADR-066 § 3)
  // -------------------------------------------------------------------------

  /** The chain of a scope starts here, so two scopes' chains can never be spliced. */
  genesisReceipt(scopeId: string): string {
    return sha256Hex(lengthPrefixed(this.labels.receiptGenesis, scopeId));
  }

  nextReceipt(scopeId: string, previous: string, link: ReceiptLink): string {
    return sha256Hex(
      lengthPrefixed(
        this.labels.receipt,
        scopeId,
        previous,
        link.entryId,
        String(link.revision),
        link.receivedAt.toISOString(),
        link.ciphertextSha256,
        link.contentCommitment,
      ),
    );
  }

  /**
   * Walks a scope's receipts in the order they were issued and checks where they
   * end. `LINK_BROKEN` names the first link that does not follow from the one
   * before it — one that was edited, removed, reordered or spliced in from
   * elsewhere. `HEAD_MISMATCH` is a chain that is internally sound but is not the
   * chain that was issued: cut short, extended, or replaced whole.
   *
   * `trustedHead` is **required**. A chain checked against nothing but itself
   * proves only that it is self-consistent, and a consistent forgery is one call
   * away for anyone who can write the table. The head is the newest receipt as
   * held outside the consumer's database; an empty chain's head is
   * {@link genesisReceipt}.
   */
  verifyReceiptChain(
    scopeId: string,
    links: readonly Receipted[],
    trustedHead: string,
  ): ChainVerdict {
    let previous = this.genesisReceipt(scopeId);
    for (const [index, link] of links.entries()) {
      if (!sameDigest(this.nextReceipt(scopeId, previous, link), link.receipt)) {
        return { ok: false, reason: 'LINK_BROKEN', brokenAt: index };
      }
      previous = link.receipt;
    }
    return sameDigest(previous, trustedHead)
      ? { ok: true }
      : { ok: false, reason: 'HEAD_MISMATCH' };
  }

  /**
   * Verifies a scope's receipts — the chain, link by link, from the genesis to the trusted head —
   * and indexes them for opening. `RECEIPT_CHAIN_BROKEN` when they do not verify: an edited,
   * removed, reordered, spliced or truncated chain, or one that ends somewhere the trusted copy
   * does not.
   */
  verifyReceipts(scopeId: string, receipts: TrustedReceipts): VerifiedReceipts {
    // One copy, verified and then indexed: what is read later is exactly what was checked.
    const links = receipts.links.map((link) =>
      Object.freeze({
        entryId: link.entryId,
        revision: link.revision,
        receivedAt: new Date(link.receivedAt.getTime()),
        ciphertextSha256: link.ciphertextSha256,
        contentCommitment: link.contentCommitment,
        receipt: link.receipt,
      }),
    );
    if (!this.verifyReceiptChain(scopeId, links, receipts.head).ok) {
      throw new SealingError('RECEIPT_CHAIN_BROKEN');
    }
    // In chain order, so each entry's map value ends as its newest receipt.
    const newest = new Map<string, Receipted>();
    for (const link of links) newest.set(link.entryId, link);
    return issueVerified(Object.freeze({ scheme: this, scopeId, head: receipts.head, newest }));
  }

  /**
   * The receipts opening is checked against, **from the evidence** an outside holder
   * keeps — links and head — after checking that the chain is sound: it starts at this
   * scope's genesis, every link follows from the one before it, and it ends at the head
   * named. Anything else is `RECEIPT_CHAIN_BROKEN` and nothing is opened. The stored
   * envelopes are then compared with *these* links ({@link open}), not with the
   * consumer's own copy, which whoever rewrote an envelope could have rewritten with it.
   *
   * Verified here, once per read of the evidence, and indexed by entry: every envelope an
   * opening (or a read) opens reuses it (Codex r1 on #250, R2).
   */
  trustedReceiptsOf(evidence: ReceiptEvidence): VerifiedReceipts {
    if (evidence.genesis !== this.genesisReceipt(evidence.scopeId)) {
      throw new SealingError('RECEIPT_CHAIN_BROKEN');
    }
    const links = evidence.links.map((link) => ({
      entryId: link.entryId,
      revision: link.revision,
      receivedAt: new Date(link.receivedAt),
      ciphertextSha256: link.ciphertextSha256,
      contentCommitment: link.contentCommitment,
      receipt: link.receipt,
    }));
    return this.verifyReceipts(evidence.scopeId, { links, head: evidence.head });
  }
}
