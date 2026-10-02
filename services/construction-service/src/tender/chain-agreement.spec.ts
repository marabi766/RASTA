import { genesisReceipt, nextReceipt } from './sealing/sealing';
import { compareChains, type LocalLink } from './chain-agreement';
import type { TenderChain } from './tender-evidence.client';

/**
 * Whether this service's own copy of a tender's receipts is the evidence audit-service
 * holds (ADR-066 § 2): the same, behind (retry), or different (refuse).
 */

const TENDER = 'TND_1';
const hex = (char: string) => char.repeat(64);

function links(count: number): LocalLink[] {
  const made: LocalLink[] = [];
  let previous = genesisReceipt(TENDER);
  for (let index = 0; index < count; index += 1) {
    const link = {
      bidId: `BID_${index + 1}`,
      revision: 1,
      receivedAt: new Date(Date.UTC(2026, 9, 1, 10, 0, index)),
      ciphertextSha256: hex(String(index + 1)),
      contentCommitment: hex(String.fromCharCode(97 + index)),
    };
    const receipt = nextReceipt(TENDER, previous, link);
    made.push({ ...link, previousReceipt: previous, receipt });
    previous = receipt;
  }
  return made;
}

const chainOf = (local: readonly LocalLink[]): TenderChain => ({
  tenderId: TENDER,
  genesis: genesisReceipt(TENDER),
  head: local.length > 0 ? local[local.length - 1]!.receipt : genesisReceipt(TENDER),
  links: local.map((link, index) => ({
    seq: index + 1,
    bidId: link.bidId,
    revision: link.revision,
    receivedAt: link.receivedAt.toISOString(),
    ciphertextSha256: link.ciphertextSha256,
    contentCommitment: link.contentCommitment,
    previousReceipt: link.previousReceipt,
    receipt: link.receipt,
  })),
});

const ids = (local: readonly LocalLink[]) => [...new Set(local.map((link) => link.bidId))];

describe('compareChains', () => {
  it('agrees when every link is equal, in order, and every bid has its links', () => {
    const local = links(3);
    expect(compareChains(local, chainOf(local), ids(local))).toBe('AGREES');
  });

  it('agrees on an empty chain with no bids', () => {
    expect(compareChains([], chainOf([]), [])).toBe('AGREES');
  });

  it('is behind, and only behind, when the evidence is a strict prefix of the local chain', () => {
    const local = links(3);
    expect(compareChains(local, chainOf(local.slice(0, 2)), ids(local))).toBe('EVIDENCE_BEHIND');
    expect(compareChains(local, chainOf([]), ids(local))).toBe('EVIDENCE_BEHIND');
  });

  it('differs when the evidence holds a link the local copy does not', () => {
    const local = links(3);
    expect(compareChains(local.slice(0, 2), chainOf(local), ids(local.slice(0, 2)))).toBe(
      'DISAGREES',
    );
  });

  it.each([
    ['a bid id', (link: LocalLink) => ({ ...link, bidId: 'BID_OTHER' })],
    ['a revision', (link: LocalLink) => ({ ...link, revision: 2 })],
    ['the time received', (link: LocalLink) => ({ ...link, receivedAt: new Date(0) })],
    ['the ciphertext digest', (link: LocalLink) => ({ ...link, ciphertextSha256: hex('9') })],
    ['the commitment', (link: LocalLink) => ({ ...link, contentCommitment: hex('9') })],
    ['the predecessor', (link: LocalLink) => ({ ...link, previousReceipt: hex('9') })],
    ['the receipt', (link: LocalLink) => ({ ...link, receipt: hex('9') })],
  ])('differs when %s of a link was changed locally', (_what, change) => {
    const local = links(3);
    const tampered = local.map((link, index) => (index === 1 ? change(link) : link));
    expect(compareChains(tampered, chainOf(local), ids(local))).toBe('DISAGREES');
  });

  it('differs, and not behind, when the same number of links are a different chain (a rewritten chain)', () => {
    const honest = links(3);
    const rewritten = links(3).map((link) => ({ ...link, ciphertextSha256: hex('0') }));
    expect(compareChains(rewritten, chainOf(honest), ids(honest))).toBe('DISAGREES');
  });

  it('differs when a local chain that is shorter and also changed is not a prefix', () => {
    const local = links(3);
    const other = links(3).map((link) => ({ ...link, contentCommitment: hex('0') }));
    expect(compareChains(local, chainOf(other.slice(0, 2)), ids(local))).toBe('DISAGREES');
  });

  it('differs when a bid row was added behind the chain, or one the chain names is missing', () => {
    const local = links(2);
    expect(compareChains(local, chainOf(local), [...ids(local), 'BID_ADDED'])).toBe('DISAGREES');
    expect(compareChains(local, chainOf(local), ids(local).slice(0, 1))).toBe('DISAGREES');
    expect(compareChains(local, chainOf(local), ['BID_1', 'BID_X'])).toBe('DISAGREES');
  });
});
