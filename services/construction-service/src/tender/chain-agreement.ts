import { timingSafeEqual } from 'node:crypto';
import type { TenderChain } from './tender-evidence.client';

/**
 * Does this service's own copy of a tender's receipts agree with the evidence
 * audit-service holds (ADR-066 § 2)? Opening trusts the evidence and nothing else; this
 * is the second check, that what is stored here is **the same thing**. A bid replaced
 * with another sealed to the same key fails `openBid` against the evidence; a row
 * removed, added or reordered fails here.
 *
 *   AGREES          every link equal, in order, and every bid has its links
 *   EVIDENCE_BEHIND the evidence is a strict prefix of the local chain: audit-service
 *                   has not caught up with the newest receipts yet (events are at
 *                   least once and asynchronous). Retryable, and **nothing is opened**
 *   DISAGREES       anything else: not a lag, a difference
 *
 * Digests are compared in constant time (they are public, but the comparison is the
 * same one `openBid` makes, and a forged one should cost the same to refuse).
 */
export type ChainAgreement = 'AGREES' | 'EVIDENCE_BEHIND' | 'DISAGREES';

export interface LocalLink {
  readonly bidId: string;
  readonly revision: number;
  readonly receivedAt: Date;
  readonly ciphertextSha256: string;
  readonly contentCommitment: string;
  readonly previousReceipt: string;
  readonly receipt: string;
}

const same = (a: string, b: string): boolean => {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
};

function linkEquals(local: LocalLink, trusted: TenderChain['links'][number]): boolean {
  return (
    local.bidId === trusted.bidId &&
    local.revision === trusted.revision &&
    local.receivedAt.getTime() === new Date(trusted.receivedAt).getTime() &&
    same(local.ciphertextSha256, trusted.ciphertextSha256) &&
    same(local.contentCommitment, trusted.contentCommitment) &&
    same(local.previousReceipt, trusted.previousReceipt) &&
    same(local.receipt, trusted.receipt)
  );
}

export function compareChains(
  local: readonly LocalLink[],
  trusted: TenderChain,
  bidIds: readonly string[],
): ChainAgreement {
  for (const [index, mine] of local.entries()) {
    const theirs = trusted.links[index];
    if (!theirs) break; // the evidence ends here: behind, decided below
    if (!linkEquals(mine, theirs)) return 'DISAGREES';
  }
  if (trusted.links.length > local.length) return 'DISAGREES';
  if (trusted.links.length < local.length) return 'EVIDENCE_BEHIND';

  // Same chain. Every bid stored here has receipts in it, and every receipt is of a bid
  // stored here: a bid row added or deleted behind the chain's back is not a bid.
  const receipted = new Set(trusted.links.map((link) => link.bidId));
  const stored = new Set(bidIds);
  if (receipted.size !== stored.size) return 'DISAGREES';
  for (const id of receipted) if (!stored.has(id)) return 'DISAGREES';
  return 'AGREES';
}
