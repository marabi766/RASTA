import { createHash, createPublicKey, randomBytes, type KeyObject } from 'node:crypto';
import {
  MAX_CONTENT_BYTES,
  aeadDecrypt,
  aeadEncrypt,
  ciphertextDigest,
  commitmentOf,
  generateTenderKeyPair,
  genesisReceipt,
  lengthPrefixed,
  nextReceipt,
  openBid,
  privateKeyFromDer,
  sealBid,
  verifyReceiptChain,
  type BidBinding,
  type ReceiptLink,
  type SealedBid,
  type TrustedReceipts,
  type TenderKeyPair,
} from './sealing';

/**
 * ADR-066 § 2 and § 3, proven without a database: what sealing binds, what
 * opening refuses, and what the commitment and the receipt chain detect.
 *
 * One key pair is generated for the file (RSA-3072 is slow enough to matter),
 * and a second for the "wrong key" case.
 */

jest.setTimeout(60_000);

const BINDING: BidBinding = {
  tenderId: 'TND_A',
  bidId: 'BID_1',
  bidderOrganizationId: 'ORG_BIDDER',
  revision: 1,
  keyId: 'TKY_1',
};

const CONTENT = {
  priceMinor: '4200000000',
  durationDays: 120,
  note: 'پیشنهاد ما، شامل مصالح',
  criterionResponses: [{ code: 'EXPERIENCE', response: 'Nine road projects' }],
};

let pair: TenderKeyPair;
let privateKey: KeyObject;
let otherPair: TenderKeyPair;

beforeAll(async () => {
  pair = await generateTenderKeyPair();
  privateKey = privateKeyFromDer(pair.privateKeyDer);
  otherPair = await generateTenderKeyPair();
});

const seal = (binding: BidBinding = BINDING, content: unknown = CONTENT) =>
  sealBid({ publicKeyPem: pair.publicKeyPem, binding, content });

/** A sealed bid and the binding it was sealed under (the default binding when omitted). */
type Issued = SealedBid | { sealed: SealedBid; binding?: BidBinding };

/**
 * The receipts a tender would have issued, in order, for these bids, and the head
 * the trusted copy would hold. Each bid is receipted under the binding it was
 * sealed with.
 */
const receiptsOf = (bids: Issued[], tenderId = BINDING.tenderId): TrustedReceipts => {
  const links: (ReceiptLink & { receipt: string })[] = [];
  let previous = genesisReceipt(tenderId);
  bids.forEach((issued, index) => {
    const { sealed, binding } = 'sealed' in issued ? issued : { sealed: issued, binding: BINDING };
    const link: ReceiptLink = {
      bidId: (binding ?? BINDING).bidId,
      revision: (binding ?? BINDING).revision,
      receivedAt: new Date(Date.UTC(2026, 10, 1, 8, index, 0)),
      ciphertextSha256: sealed.ciphertextSha256,
      contentCommitment: sealed.contentCommitment,
    };
    const receipt = nextReceipt(tenderId, previous, link);
    links.push({ ...link, receipt });
    previous = receipt;
  });
  return { links, head: previous };
};

/** Opens `sealed`; unless told otherwise, against the receipts that were issued for it alone. */
const open = (
  sealed: SealedBid,
  binding: BidBinding = BINDING,
  key: KeyObject = privateKey,
  receipts: TrustedReceipts = receiptsOf([{ sealed, binding }], binding.tenderId),
) => openBid({ privateKey: key, binding, sealed, receipts });

const flip = (bytes: Buffer, index = 0): Buffer => {
  const copy = Buffer.from(bytes);
  copy[index] = (copy[index] ?? 0) ^ 0x01;
  return copy;
};

describe('the AEAD', () => {
  it('matches the published AES-256-GCM vector (GCM spec, test case 14)', () => {
    const key = Buffer.alloc(32);
    const nonce = Buffer.alloc(12);
    const { ciphertext, tag } = aeadEncrypt(key, nonce, Buffer.alloc(0), Buffer.alloc(16));
    expect(ciphertext.toString('hex')).toBe('cea7403d4d606b6e074ec5d3baf39d18');
    expect(tag.toString('hex')).toBe('d0d1c8a799996bf0265b98b5d48ab919');
    expect(aeadDecrypt(key, nonce, Buffer.alloc(0), ciphertext, tag)).toEqual(Buffer.alloc(16));
  });

  it('refuses a wrong key, nonce, AAD, tag or ciphertext, all as TAMPERED', () => {
    const key = randomBytes(32);
    const nonce = randomBytes(12);
    const aad = Buffer.from('aad');
    const { ciphertext, tag } = aeadEncrypt(key, nonce, aad, Buffer.from('secret'));

    const attempts = [
      () => aeadDecrypt(randomBytes(32), nonce, aad, ciphertext, tag),
      () => aeadDecrypt(key, randomBytes(12), aad, ciphertext, tag),
      () => aeadDecrypt(key, nonce, Buffer.from('other'), ciphertext, tag),
      () => aeadDecrypt(key, nonce, aad, ciphertext, flip(tag)),
      () => aeadDecrypt(key, nonce, aad, flip(ciphertext), tag),
    ];
    for (const attempt of attempts) {
      expect(attempt).toThrow(expect.objectContaining({ code: 'TAMPERED' }));
    }
  });
});

describe('length-prefixed encoding', () => {
  it('is exactly the documented bytes', () => {
    expect(lengthPrefixed('L', 'ab', Buffer.from([1, 2, 3])).toString('hex')).toBe(
      '00000001' + '4c' + '00000002' + '6162' + '00000003' + '010203',
    );
  });

  it('cannot be made ambiguous by moving a boundary', () => {
    expect(lengthPrefixed('L', 'ab', 'c').equals(lengthPrefixed('L', 'a', 'bc'))).toBe(false);
    expect(lengthPrefixed('L', 'ab').equals(lengthPrefixed('L', 'a', 'b'))).toBe(false);
  });
});

describe('the commitment', () => {
  it('is SHA-256 over the labelled salt and canonical content, spelled out independently', () => {
    const salt = Buffer.alloc(32, 7);
    const content = '{"priceMinor":"1"}';
    const label = Buffer.from('rasta.bid.commitment.v1');
    const be = (n: number) => {
      const b = Buffer.alloc(4);
      b.writeUInt32BE(n);
      return b;
    };
    const expected = createHash('sha256')
      .update(
        Buffer.concat([
          be(label.length),
          label,
          be(32),
          salt,
          be(content.length),
          Buffer.from(content),
        ]),
      )
      .digest('hex');
    expect(commitmentOf(salt, content)).toBe(expected);
  });
});

describe('sealing and opening a bid', () => {
  it('round-trips the content, unicode included', () => {
    expect(open(seal())).toEqual(CONTENT);
  });

  it('needs only the public key to seal, and only the private key to open', () => {
    // `seal` is handed the public key alone: sealing has no use for the private one.
    const sealed = seal();
    expect(open(sealed)).toEqual(CONTENT);
    expect(() => open(sealed, BINDING, privateKeyFromDer(otherPair.privateKeyDer))).toThrow(
      expect.objectContaining({ code: 'TAMPERED' }),
    );
  });

  it('uses an RSA-3072 tender key', () => {
    expect(createPublicKey(pair.publicKeyPem).asymmetricKeyDetails?.modulusLength).toBe(3072);
  });

  it('stores neither the content nor its parts in the clear', () => {
    const sealed = seal();
    const everything = Buffer.concat([
      sealed.nonce,
      sealed.ciphertext,
      sealed.tag,
      sealed.wrappedContentKey,
      Buffer.from(sealed.contentCommitment),
      Buffer.from(sealed.ciphertextSha256),
    ]);
    for (const secret of ['4200000000', 'Nine road projects', 'EXPERIENCE', 'priceMinor']) {
      expect(everything.includes(Buffer.from(secret))).toBe(false);
    }
  });

  it('seals the same content differently each time: fresh salt, key and nonce', () => {
    const a = seal();
    const b = seal();
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
    expect(a.nonce.equals(b.nonce)).toBe(false);
    expect(a.wrappedContentKey.equals(b.wrappedContentKey)).toBe(false);
    // The salt is what stops a published commitment from being guessed back to a price.
    expect(a.contentCommitment).not.toBe(b.contentCommitment);
  });

  it('binds the sealed bytes to bidder, and refuses a key id that is not the sealed one', () => {
    const sealed = seal();
    expect(() => open(sealed, { ...BINDING, bidderOrganizationId: 'ORG_OTHER' })).toThrow(
      expect.objectContaining({ code: 'TAMPERED' }),
    );
    expect(() => open(sealed, { ...BINDING, keyId: 'TKY_2' })).toThrow(
      expect.objectContaining({ code: 'TAMPERED' }),
    );
  });

  it('refuses another tender, another bid and another revision than the receipts are for', () => {
    const sealed = seal();
    const receipts = receiptsOf([sealed]);
    // Another tender: its chain starts from another genesis.
    expect(() => open(sealed, { ...BINDING, tenderId: 'TND_B' }, privateKey, receipts)).toThrow(
      expect.objectContaining({ code: 'RECEIPT_CHAIN_BROKEN' }),
    );
    // A bid the chain has no receipt for.
    expect(() => open(sealed, { ...BINDING, bidId: 'BID_2' }, privateKey, receipts)).toThrow(
      expect.objectContaining({ code: 'RECEIPT_MISMATCH' }),
    );
    // A revision that is not the receipted one.
    expect(() => open(sealed, { ...BINDING, revision: 2 }, privateKey, receipts)).toThrow(
      expect.objectContaining({ code: 'RECEIPT_MISMATCH' }),
    );
  });

  it.each(['nonce', 'ciphertext', 'tag', 'wrappedContentKey'] as const)(
    'refuses a %s changed by one bit: the recomputed digest is not the receipted one',
    (field) => {
      const sealed = seal();
      const tampered: SealedBid = { ...sealed, [field]: flip(sealed[field], 3) };
      expect(() => open(tampered, BINDING, privateKey, receiptsOf([sealed]))).toThrow(
        expect.objectContaining({ code: 'RECEIPT_MISMATCH' }),
      );
    },
  );

  it('is not fooled by a tampered bid whose stored digest was rewritten to match', () => {
    // The stored `ciphertextSha256` is data the same writer can change. Opening
    // recomputes the digest from the bytes and compares it with the receipt.
    const sealed = seal();
    const tampered: SealedBid = { ...sealed, ciphertext: flip(sealed.ciphertext, 3) };
    const rewritten: SealedBid = { ...tampered, ciphertextSha256: ciphertextDigest(tampered) };
    expect(() => open(rewritten, BINDING, privateKey, receiptsOf([sealed]))).toThrow(
      expect.objectContaining({ code: 'RECEIPT_MISMATCH' }),
    );
  });

  it('refuses a sealed bid of another version', () => {
    expect(() => open({ ...seal(), version: 2 })).toThrow(
      expect.objectContaining({ code: 'TAMPERED' }),
    );
  });

  it('refuses a substituted bid: same binding, other content, its own consistent digest and commitment', () => {
    // Codex review of #163. Someone who can write the table (and holds the tender's
    // public key, which is not secret) seals other content under the very same
    // binding. The forgery is perfectly self-consistent — its own commitment, its
    // own digest — and decrypts cleanly. Only the receipt the bidder was given
    // can tell it from the bid.
    const original = seal();
    const receipts = receiptsOf([original]);
    const forged = seal(BINDING, { ...CONTENT, priceMinor: '1' });

    expect(open(forged, BINDING, privateKey, receiptsOf([forged]))).toMatchObject({
      priceMinor: '1',
    });
    expect(() => open(forged, BINDING, privateKey, receipts)).toThrow(
      expect.objectContaining({ code: 'RECEIPT_MISMATCH' }),
    );
  });

  it('refuses a substitution that also rebuilds the whole chain, against the trusted head', () => {
    const original = seal();
    const trusted = receiptsOf([original]);
    const forged = seal(BINDING, { ...CONTENT, priceMinor: '1' });
    const rebuilt = receiptsOf([forged]);

    // The rebuilt chain is internally sound, and opens the forgery — until it is
    // checked against the head held outside the database.
    expect(() => open(forged, BINDING, privateKey, { ...rebuilt, head: trusted.head })).toThrow(
      expect.objectContaining({ code: 'RECEIPT_CHAIN_BROKEN' }),
    );
  });

  it('refuses a bid opened against a chain that has been cut short', () => {
    const [first, second] = [seal(), seal({ ...BINDING, bidId: 'BID_2' })];
    const whole = receiptsOf([first, { sealed: second, binding: { ...BINDING, bidId: 'BID_2' } }]);
    const cut = { links: whole.links.slice(0, 1), head: whole.head };
    expect(() => open(first, BINDING, privateKey, cut)).toThrow(
      expect.objectContaining({ code: 'RECEIPT_CHAIN_BROKEN' }),
    );
  });

  it('opens each bid of a longer chain against its own receipt, and only the newest revision', () => {
    const one = seal();
    const two = seal({ ...BINDING, bidId: 'BID_2', bidderOrganizationId: 'ORG_OTHER' });
    const revised = seal({ ...BINDING, revision: 2 }, { ...CONTENT, priceMinor: '4100000000' });
    const receipts = receiptsOf([
      { sealed: one },
      { sealed: two, binding: { ...BINDING, bidId: 'BID_2', bidderOrganizationId: 'ORG_OTHER' } },
      { sealed: revised, binding: { ...BINDING, revision: 2 } },
    ]);

    expect(
      open(
        two,
        { ...BINDING, bidId: 'BID_2', bidderOrganizationId: 'ORG_OTHER' },
        privateKey,
        receipts,
      ),
    ).toEqual(CONTENT);
    expect(open(revised, { ...BINDING, revision: 2 }, privateKey, receipts)).toMatchObject({
      priceMinor: '4100000000',
    });
    // Revision 1 of BID_1 is no longer the bid: its receipt is not the newest.
    expect(() => open(one, BINDING, privateKey, receipts)).toThrow(
      expect.objectContaining({ code: 'RECEIPT_MISMATCH' }),
    );
  });

  it('detects content that does not match the commitment the receipt recorded', () => {
    // A bid whose recorded commitment was never the commitment of its content —
    // a fault at submission, however it arose. The digest and the receipt agree
    // with each other; the decrypted content does not agree with either.
    const sealed = seal();
    const wrongCommitment: SealedBid = { ...sealed, contentCommitment: 'ab'.repeat(32) };
    expect(() => open(wrongCommitment, BINDING, privateKey, receiptsOf([wrongCommitment]))).toThrow(
      expect.objectContaining({ code: 'COMMITMENT_MISMATCH' }),
    );
  });

  it('publishes only two fixed-size digests, and they differ from seal to seal', () => {
    const sealed = seal();
    expect(sealed.ciphertextSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(sealed.contentCommitment).toMatch(/^[0-9a-f]{64}$/);
    expect(seal().ciphertextSha256).not.toBe(sealed.ciphertextSha256);
  });

  it('refuses content that cannot be written down exactly, or is too large', () => {
    expect(() => seal(BINDING, { priceMinor: 12.5 })).toThrow(
      expect.objectContaining({ code: 'INVALID_CONTENT' }),
    );
    expect(() => seal(BINDING, { note: 'x'.repeat(MAX_CONTENT_BYTES + 1) })).toThrow(
      expect.objectContaining({ code: 'INVALID_CONTENT' }),
    );
  });

  it('refuses a public key it cannot use, without saying anything about the content', () => {
    expect(() =>
      sealBid({ publicKeyPem: 'not a key', binding: BINDING, content: CONTENT }),
    ).toThrow(expect.objectContaining({ code: 'KEY_UNAVAILABLE' }));
  });

  it('refuses a private key that is not PKCS#8', () => {
    expect(() => privateKeyFromDer(randomBytes(64))).toThrow(
      expect.objectContaining({ code: 'KEY_UNAVAILABLE' }),
    );
  });

  it('never puts content, keys or ciphertext into an error', () => {
    const sealed = seal();
    const errors: unknown[] = [];
    for (const attempt of [
      () => open({ ...sealed, ciphertext: flip(sealed.ciphertext) }),
      () => open(sealed, { ...BINDING, bidderOrganizationId: 'ORG_OTHER' }),
      () => open({ ...sealed, contentCommitment: '00'.repeat(32) }),
      () => seal(BINDING, { priceMinor: 12.5 }),
    ]) {
      try {
        attempt();
      } catch (error) {
        errors.push(error);
      }
    }
    expect(errors).toHaveLength(4);
    const text = errors.map((error) => `${String(error)} ${JSON.stringify(error)}`).join(' ');
    for (const secret of [
      '4200000000',
      'Nine road projects',
      sealed.ciphertext.toString('base64'),
      sealed.contentCommitment,
    ]) {
      expect(text).not.toContain(secret);
    }
  });
});

describe('the receipt chain', () => {
  const at = (n: number) => new Date(Date.UTC(2026, 10, 1, 8, n, 0));

  /** Three bids' receipts, issued in order, as the tender would. */
  function chain(tenderId = 'TND_A') {
    const sealed = [
      seal(),
      seal({ ...BINDING, bidId: 'BID_2' }),
      seal({ ...BINDING, bidId: 'BID_3' }),
    ];
    const links: (ReceiptLink & { receipt: string })[] = [];
    let previous = genesisReceipt(tenderId);
    sealed.forEach((bid, index) => {
      const link: ReceiptLink = {
        bidId: `BID_${index + 1}`,
        revision: 1,
        receivedAt: at(index),
        ciphertextSha256: bid.ciphertextSha256,
        contentCommitment: bid.contentCommitment,
      };
      const receipt = nextReceipt(tenderId, previous, link);
      links.push({ ...link, receipt });
      previous = receipt;
    });
    return { links, head: previous };
  }

  it('starts from a genesis of its own tender', () => {
    expect(genesisReceipt('TND_A')).toMatch(/^[0-9a-f]{64}$/);
    expect(genesisReceipt('TND_A')).not.toBe(genesisReceipt('TND_B'));
  });

  it('verifies a chain that ends at the trusted head, and the empty chain at genesis', () => {
    const { links, head } = chain();
    expect(verifyReceiptChain('TND_A', links, head)).toEqual({ ok: true });
    expect(verifyReceiptChain('TND_A', [], genesisReceipt('TND_A'))).toEqual({ ok: true });
  });

  it.each([
    ['bidId', { bidId: 'BID_X' }],
    ['revision', { revision: 2 }],
    ['receivedAt', { receivedAt: new Date(Date.UTC(2026, 10, 1, 8, 59, 0)) }],
    ['ciphertextSha256', { ciphertextSha256: 'ab'.repeat(32) }],
    ['contentCommitment', { contentCommitment: 'cd'.repeat(32) }],
  ])('finds an edited %s at the link it was edited in', (_field, change) => {
    const { links, head } = chain();
    links[1] = { ...links[1]!, ...change };
    expect(verifyReceiptChain('TND_A', links, head)).toEqual({
      ok: false,
      reason: 'LINK_BROKEN',
      brokenAt: 1,
    });
  });

  it('finds a removed link, a reordered pair, and a link spliced in from another tender', () => {
    const { links, head } = chain();
    expect(verifyReceiptChain('TND_A', [links[0]!, links[2]!], head)).toEqual({
      ok: false,
      reason: 'LINK_BROKEN',
      brokenAt: 1,
    });
    expect(verifyReceiptChain('TND_A', [links[1]!, links[0]!, links[2]!], head)).toEqual({
      ok: false,
      reason: 'LINK_BROKEN',
      brokenAt: 0,
    });
    expect(verifyReceiptChain('TND_B', chain('TND_A').links, head)).toEqual({
      ok: false,
      reason: 'LINK_BROKEN',
      brokenAt: 0,
    });
  });

  it('finds a chain cut short, extended or replaced, by the head it does not end at', () => {
    const { links, head } = chain();
    // Cut short: the newest receipts are gone, and what is left is perfectly sound.
    expect(verifyReceiptChain('TND_A', links.slice(0, 2), head)).toEqual({
      ok: false,
      reason: 'HEAD_MISMATCH',
    });
    // Emptied.
    expect(verifyReceiptChain('TND_A', [], head)).toEqual({ ok: false, reason: 'HEAD_MISMATCH' });
    // Replaced by another sound chain: sound on its own, and not the one issued.
    const other = chain();
    expect(verifyReceiptChain('TND_A', other.links, other.head)).toEqual({ ok: true });
    expect(verifyReceiptChain('TND_A', other.links, head)).toEqual({
      ok: false,
      reason: 'HEAD_MISMATCH',
    });
  });
});
