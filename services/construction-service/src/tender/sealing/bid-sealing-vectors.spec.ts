import { SealingError as PackageSealingError } from '@rasta/sealing';
import { SealingError } from './errors';
import { EnvKekProvider } from './key-provider';
import {
  BID_SEALING,
  ciphertextDigest,
  commitmentOf,
  generateTenderKeyPair,
  genesisReceipt,
  nextReceipt,
  openBid,
  privateKeyFromDer,
  sealBid,
  verifyReceipts,
  type BidBinding,
} from './sealing';
import { trustedReceiptsOf } from '../tender-evidence.client';

/**
 * The bytes of a bid, pinned (ADR-070 PR 4). Every value below was computed by this service's
 * sealing code **before** it moved to `@rasta/sealing`; a bid sealed, a receipt issued or a key
 * wrapped before the move must verify after it. A change to a label, to the order of a
 * binding's fields or to how a bid's words map onto the package's breaks one of these.
 */

jest.setTimeout(60_000);

const BINDING: BidBinding = {
  tenderId: 'TND_A',
  bidId: 'BID_1',
  bidderOrganizationId: 'ORG_B',
  revision: 2,
  keyId: 'TKY_1',
};

const LINK = {
  bidId: 'BID_1',
  revision: 2,
  receivedAt: new Date('2026-11-01T08:00:00.123Z'),
  ciphertextSha256: 'a'.repeat(64),
  contentCommitment: 'b'.repeat(64),
};

const GENESIS = 'c8e90ec8fd85c0ad583dc22923bc264f3b98b32d7dad24b743c8e44b3c166d9e';

describe('a bid’s bytes, as before the move', () => {
  it('starts a tender’s chain at the same genesis (audit-service recomputes it too)', () => {
    expect(genesisReceipt('TND_A')).toBe(GENESIS);
  });

  it('issues the same receipt for the same link', () => {
    expect(nextReceipt('TND_A', GENESIS, LINK)).toBe(
      '1e865f47dcdde80b70a8ab0d12d5657a39990b2bf75de48f2831e0593f1f3276',
    );
  });

  it('makes the same commitment and the same ciphertext digest', () => {
    expect(commitmentOf(Buffer.alloc(32, 7), '{"priceMinor":"1"}')).toBe(
      'a27ea5d7d69e9dfa9cd9b52850d84ddad6934af5fb98de41a6532474bb7be8a3',
    );
    expect(
      ciphertextDigest({
        keyId: 'TKY_1',
        nonce: Buffer.alloc(12, 1),
        ciphertext: Buffer.from('ciphertext'),
        tag: Buffer.alloc(16, 2),
        wrappedContentKey: Buffer.alloc(384, 3),
      }),
    ).toBe('0c923718b21b3a650dab04d44443b5d3dab40224521754d709342534cb116f59');
  });

  it('authenticates the same associated data: tender, bid, bidder, revision, key, in that order', () => {
    // Confirmed against a bid sealed before the move: its ciphertext decrypted under exactly this.
    expect(
      BID_SEALING.associatedDataOf({
        scopeId: BINDING.tenderId,
        entryId: BINDING.bidId,
        submitterId: BINDING.bidderOrganizationId,
        revision: BINDING.revision,
        keyId: BINDING.keyId,
      }).toString('hex'),
    ).toBe(
      '0000001072617374612e6269642e6161642e763100000005544e445f41000000054249445f31' +
        '000000054f52475f42000000013200000005544b595f31',
    );
  });

  it('unwraps a tender key wrapped before the move, and recognises its request digest', () => {
    // A fixed, non-secret KEK: the bytes are the point, not the key.
    const provider = new EnvKekProvider(`v1:${Buffer.alloc(32, 1).toString('base64')}`, 'v1');
    const wrapped = {
      kekId: 'v1',
      nonce: Buffer.from('6b6702668d73015b0bbe58d7', 'hex'),
      ciphertext: Buffer.from('8076f772c5720737934f6548ac6714b3b4', 'hex'),
      tag: Buffer.from('36580e3931150789a10238651187efe9', 'hex'),
    };
    expect(provider.unwrap(wrapped, { tenderId: 'TND_A', keyId: 'TKY_1' }).toString()).toBe(
      'not a private key',
    );
    const digest =
      'hmac-v1:v1:12fcc233fd6236879e4f1d0442e79c4c4038cb8c9daf187feb3ee03a806894f8:' +
      '5b4da9069b69073d3de79ff3c44575d89269ec10f28546c911e31e7de39e4dbb';
    expect(
      provider.matchesRequestDigest(
        digest,
        { organizationId: 'ORG_A', userId: 'USR_A' },
        '{"x":1}',
      ),
    ).toBe(true);
  });
});

describe('a bid’s words, mapped onto the package', () => {
  it('seals, receipts, verifies and opens a bid end to end, and the evidence path agrees', async () => {
    const pair = await generateTenderKeyPair();
    const privateKey = privateKeyFromDer(pair.privateKeyDer);
    const sealed = sealBid({
      publicKeyPem: pair.publicKeyPem,
      binding: BINDING,
      content: { a: 1 },
    });
    const link = {
      ...LINK,
      ciphertextSha256: sealed.ciphertextSha256,
      contentCommitment: sealed.contentCommitment,
    };
    const receipt = nextReceipt('TND_A', GENESIS, link);

    const receipts = verifyReceipts('TND_A', { links: [{ ...link, receipt }], head: receipt });
    expect(openBid({ privateKey, binding: BINDING, sealed, receipts })).toEqual({ a: 1 });

    const fromEvidence = trustedReceiptsOf({
      tenderId: 'TND_A',
      genesis: GENESIS,
      head: receipt,
      links: [
        {
          seq: 1,
          ...link,
          receivedAt: link.receivedAt.toISOString(),
          previousReceipt: GENESIS,
          receipt,
        },
      ],
    });
    expect(openBid({ privateKey, binding: BINDING, sealed, receipts: fromEvidence })).toEqual({
      a: 1,
    });

    // The bidder and the bid are not interchangeable, and the revision is the receipted one.
    for (const [binding, code] of [
      [{ ...BINDING, bidderOrganizationId: 'ORG_OTHER' }, 'TAMPERED'],
      [{ ...BINDING, bidId: 'BID_2' }, 'RECEIPT_MISMATCH'],
      [{ ...BINDING, revision: 1 }, 'RECEIPT_MISMATCH'],
      [{ ...BINDING, tenderId: 'TND_B' }, 'RECEIPT_CHAIN_BROKEN'],
    ] as const) {
      expect(() => openBid({ privateKey, binding, sealed, receipts })).toThrow(
        expect.objectContaining({ code }),
      );
    }
  });

  it('refuses evidence that does not start at this tender’s genesis', () => {
    expect(() =>
      trustedReceiptsOf({ tenderId: 'TND_A', genesis: 'e'.repeat(64), head: GENESIS, links: [] }),
    ).toThrow(expect.objectContaining({ code: 'RECEIPT_CHAIN_BROKEN' }));
    expect(
      trustedReceiptsOf({ tenderId: 'TND_A', genesis: GENESIS, head: GENESIS, links: [] }).head,
    ).toBe(GENESIS);
  });

  it('throws the package’s one SealingError, from the package and from this service alike', () => {
    expect(SealingError).toBe(PackageSealingError);
    expect(() => new EnvKekProvider('not a kek', 'v1')).toThrow(PackageSealingError);
  });
});
