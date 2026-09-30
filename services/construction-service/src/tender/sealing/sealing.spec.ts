import { createHash, createPublicKey, randomBytes, type KeyObject } from 'node:crypto';
import {
  MAX_CONTENT_BYTES,
  aeadDecrypt,
  aeadEncrypt,
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

const open = (sealed: SealedBid, binding: BidBinding = BINDING, key: KeyObject = privateKey) =>
  openBid({ privateKey: key, binding, sealed });

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

  it('binds the sealed bytes to tender, bid, bidder, revision and key', () => {
    const sealed = seal();
    const changes: Partial<BidBinding>[] = [
      { tenderId: 'TND_B' },
      { bidId: 'BID_2' },
      { bidderOrganizationId: 'ORG_OTHER' },
      { revision: 2 },
    ];
    for (const change of changes) {
      expect(() => open(sealed, { ...BINDING, ...change })).toThrow(
        expect.objectContaining({ code: 'TAMPERED' }),
      );
    }
    expect(() => open(sealed, { ...BINDING, keyId: 'TKY_2' })).toThrow(
      expect.objectContaining({ code: 'TAMPERED' }),
    );
  });

  it.each(['nonce', 'ciphertext', 'tag', 'wrappedContentKey'] as const)(
    'refuses a %s that was changed by one bit',
    (field) => {
      const sealed = seal();
      const tampered: SealedBid = { ...sealed, [field]: flip(sealed[field], 3) };
      expect(() => open(tampered)).toThrow(expect.objectContaining({ code: 'TAMPERED' }));
    },
  );

  it('refuses a sealed bid of another version', () => {
    expect(() => open({ ...seal(), version: 2 })).toThrow(
      expect.objectContaining({ code: 'TAMPERED' }),
    );
  });

  it('detects other content sealed with the public key under the old commitment', () => {
    // The scenario the salt exists for: someone who holds the tender's PUBLIC key
    // (which is not secret) replaces a bid by sealing other content and keeping
    // the commitment recorded at submission.
    const original = seal();
    const forged = seal(BINDING, { ...CONTENT, priceMinor: '1' });
    const swapped: SealedBid = { ...forged, contentCommitment: original.contentCommitment };

    expect(() => open(swapped)).toThrow(expect.objectContaining({ code: 'COMMITMENT_MISMATCH' }));
    // And the forgery is honest about itself when left alone.
    expect(open(forged)).toMatchObject({ priceMinor: '1' });
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
      () => open({ ...sealed, contentCommitment: '00'.repeat(32) }),
      () => seal(BINDING, { priceMinor: 12.5 }),
    ]) {
      try {
        attempt();
      } catch (error) {
        errors.push(error);
      }
    }
    expect(errors).toHaveLength(3);
    const text = errors.map((error) => `${String(error)} ${JSON.stringify(error)}`).join(' ');
    for (const secret of [
      '4200000000',
      'Nine road projects',
      sealed.ciphertext.toString('base64'),
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
    return links;
  }

  it('starts from a genesis of its own tender', () => {
    expect(genesisReceipt('TND_A')).toMatch(/^[0-9a-f]{64}$/);
    expect(genesisReceipt('TND_A')).not.toBe(genesisReceipt('TND_B'));
  });

  it('verifies a chain issued in order, and the empty chain', () => {
    expect(verifyReceiptChain('TND_A', chain())).toEqual({ ok: true });
    expect(verifyReceiptChain('TND_A', [])).toEqual({ ok: true });
  });

  it.each([
    ['bidId', { bidId: 'BID_X' }],
    ['revision', { revision: 2 }],
    ['receivedAt', { receivedAt: new Date(Date.UTC(2026, 10, 1, 8, 59, 0)) }],
    ['ciphertextSha256', { ciphertextSha256: 'ab'.repeat(32) }],
    ['contentCommitment', { contentCommitment: 'cd'.repeat(32) }],
  ])('finds an edited %s at the link it was edited in', (_field, change) => {
    const links = chain();
    links[1] = { ...links[1]!, ...change };
    expect(verifyReceiptChain('TND_A', links)).toEqual({ ok: false, brokenAt: 1 });
  });

  it('finds a removed link, a reordered pair, and a link spliced in from another tender', () => {
    const links = chain();
    expect(verifyReceiptChain('TND_A', [links[0]!, links[2]!])).toEqual({ ok: false, brokenAt: 1 });
    expect(verifyReceiptChain('TND_A', [links[1]!, links[0]!, links[2]!])).toEqual({
      ok: false,
      brokenAt: 0,
    });
    expect(verifyReceiptChain('TND_B', chain('TND_A'))).toEqual({ ok: false, brokenAt: 0 });
  });

  it('cannot see a chain cut short on its own: the head is pinned by the audit copy, not here', () => {
    // Stated so nobody relies on this function for what it does not do: dropping
    // the newest receipts leaves a valid prefix. audit-service holds the head
    // (BID_SUBMITTED carries every receipt), which is what closes that gap.
    expect(verifyReceiptChain('TND_A', chain().slice(0, 2))).toEqual({ ok: true });
  });
});
