import type { KeyObject } from 'node:crypto';
import {
  SealingScheme,
  generateSealingKeyPair,
  type ChainVerdict,
  type EnvelopeBinding,
  type ReceiptEvidence,
  type ReceiptLink as EntryReceiptLink,
  type SealedEnvelope,
  type SealingKeyPair,
  type VerifiedReceipts,
} from '@rasta/sealing';

/**
 * Sealing a bid (ADR-066 § 2) and proving it was not changed (§ 3), in this service's words.
 *
 * The cryptography is `@rasta/sealing` (ADR-070 PR 4): one implementation, which procurement-service's
 * quotations are to use too (ADR-070). This file only names it for bids — a tender is the package's **scope**, a
 * bid its **entry**, the bidder organization its **submitter** — and holds the labels that make
 * a bid's bytes a bid's ({@link BID_SEALING_LABELS}). Nothing here decrypts, hashes or decides.
 */

export {
  CONTENT_KEY_BYTES,
  MAX_CONTENT_BYTES,
  NONCE_BYTES,
  RSA_MODULUS_BITS,
  SALT_BYTES,
  TAG_BYTES,
  aeadDecrypt,
  aeadEncrypt,
  lengthPrefixed,
  privateKeyFromDer,
  type ChainVerdict,
  type VerifiedReceipts,
} from '@rasta/sealing';

/**
 * The domain-separation labels of a bid. **Part of every commitment, digest and receipt already
 * recorded** (and audit-service recomputes the genesis with the same label): never change one.
 */
export const BID_SEALING_LABELS = Object.freeze({
  associatedData: 'rasta.bid.aad.v1',
  commitment: 'rasta.bid.commitment.v1',
  ciphertext: 'rasta.bid.ciphertext.v1',
  receiptGenesis: 'rasta.bid.receipt.genesis.v1',
  receipt: 'rasta.bid.receipt.v1',
});

export const BID_SEALING = new SealingScheme(BID_SEALING_LABELS);

/** Everything a sealed bid is bound to. A change to any field fails opening. */
export interface BidBinding {
  readonly tenderId: string;
  readonly bidId: string;
  readonly bidderOrganizationId: string;
  readonly revision: number;
  /** Which tender key pair sealed it. */
  readonly keyId: string;
}

export type SealedBid = SealedEnvelope;
export type TenderKeyPair = SealingKeyPair;

/** What a receipt commits to. Every field is safe to publish. */
export interface ReceiptLink {
  readonly bidId: string;
  readonly revision: number;
  readonly receivedAt: Date;
  readonly ciphertextSha256: string;
  readonly contentCommitment: string;
}

/** A tender's receipts in issue order, and the head as held outside this database. */
export interface TrustedReceipts {
  readonly links: readonly (ReceiptLink & { readonly receipt: string })[];
  readonly head: string;
}

function envelopeBinding(binding: BidBinding): EnvelopeBinding {
  return {
    scopeId: binding.tenderId,
    entryId: binding.bidId,
    submitterId: binding.bidderOrganizationId,
    revision: binding.revision,
    keyId: binding.keyId,
  };
}

function entryLink(link: ReceiptLink): EntryReceiptLink {
  return {
    entryId: link.bidId,
    revision: link.revision,
    receivedAt: link.receivedAt,
    ciphertextSha256: link.ciphertextSha256,
    contentCommitment: link.contentCommitment,
  };
}

const entryLinks = (links: TrustedReceipts['links']) =>
  links.map((link) => ({ ...entryLink(link), receipt: link.receipt }));

export function generateTenderKeyPair(): Promise<TenderKeyPair> {
  return generateSealingKeyPair();
}

export function commitmentOf(salt: Buffer, canonicalContent: string): string {
  return BID_SEALING.commitmentOf(salt, canonicalContent);
}

/** See `SealingScheme.ciphertextDigest`. */
export function ciphertextDigest(
  parts: Pick<SealedBid, 'keyId' | 'nonce' | 'ciphertext' | 'tag' | 'wrappedContentKey'>,
): string {
  return BID_SEALING.ciphertextDigest(parts);
}

/** Seals `content` for a tender. Needs only the tender's public key (`SealingScheme.seal`). */
export function sealBid(input: {
  publicKeyPem: string;
  binding: BidBinding;
  content: unknown;
}): SealedBid {
  return BID_SEALING.seal({
    publicKeyPem: input.publicKeyPem,
    binding: envelopeBinding(input.binding),
    content: input.content,
  });
}

/**
 * Opens a sealed bid with the tender's private key, only against the tender's verified receipts
 * ({@link verifyReceipts}); every check and its refusal is `SealingScheme.open`'s.
 */
export function openBid(input: {
  privateKey: KeyObject;
  binding: BidBinding;
  sealed: SealedBid;
  receipts: VerifiedReceipts;
}): unknown {
  return BID_SEALING.open({
    privateKey: input.privateKey,
    binding: envelopeBinding(input.binding),
    sealed: input.sealed,
    receipts: input.receipts,
  });
}

/** The chain of a tender starts here, so two tenders' chains can never be spliced. */
export function genesisReceipt(tenderId: string): string {
  return BID_SEALING.genesisReceipt(tenderId);
}

export function nextReceipt(tenderId: string, previous: string, link: ReceiptLink): string {
  return BID_SEALING.nextReceipt(tenderId, previous, entryLink(link));
}

/** See `SealingScheme.verifyReceiptChain`: `trustedHead` is the head audit-service holds. */
export function verifyReceiptChain(
  tenderId: string,
  links: TrustedReceipts['links'],
  trustedHead: string,
): ChainVerdict {
  return BID_SEALING.verifyReceiptChain(tenderId, entryLinks(links), trustedHead);
}

/** See `SealingScheme.verifyReceipts`: verified once per tender, then every bid opens against it. */
export function verifyReceipts(tenderId: string, receipts: TrustedReceipts): VerifiedReceipts {
  return BID_SEALING.verifyReceipts(tenderId, {
    links: entryLinks(receipts.links),
    head: receipts.head,
  });
}

/** A tender's chain as audit-service answers it (`TenderChain`, in bid words). */
export interface TenderReceiptEvidence {
  readonly tenderId: string;
  readonly genesis: string;
  readonly head: string;
  readonly links: readonly {
    readonly bidId: string;
    readonly revision: number;
    readonly receivedAt: string;
    readonly ciphertextSha256: string;
    readonly contentCommitment: string;
    readonly receipt: string;
  }[];
}

/** See `SealingScheme.trustedReceiptsOf`. */
export function trustedTenderReceiptsOf(evidence: TenderReceiptEvidence): VerifiedReceipts {
  const entries: ReceiptEvidence = {
    scopeId: evidence.tenderId,
    genesis: evidence.genesis,
    head: evidence.head,
    links: evidence.links.map((link) => ({
      entryId: link.bidId,
      revision: link.revision,
      receivedAt: link.receivedAt,
      ciphertextSha256: link.ciphertextSha256,
      contentCommitment: link.contentCommitment,
      receipt: link.receipt,
    })),
  };
  return BID_SEALING.trustedReceiptsOf(entries);
}
