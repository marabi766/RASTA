import { createHash, createPublicKey, randomBytes, type KeyObject } from 'node:crypto';
import {
  MAX_CONTENT_BYTES,
  aeadDecrypt,
  aeadEncrypt,
  generateSealingKeyPair,
  lengthPrefixed,
  privateKeyFromDer,
  SealingScheme,
  VerifiedReceipts,
  type EnvelopeBinding,
  type ReceiptLink,
  type SealedEnvelope,
  type SealingLabels,
  type TrustedReceipts,
  type SealingKeyPair,
} from './sealing';
import * as api from './index';

/**
 * ADR-066 § 2 and § 3, proven without a database: what sealing binds, what
 * opening refuses, and what the commitment and the receipt chain detect.
 *
 * One key pair is generated for the file (RSA-3072 is slow enough to matter),
 * and a second for the "wrong key" case.
 */

jest.setTimeout(60_000);

const LABELS: SealingLabels = {
  associatedData: 'rasta.example.aad.v1',
  commitment: 'rasta.example.commitment.v1',
  ciphertext: 'rasta.example.ciphertext.v1',
  receiptGenesis: 'rasta.example.receipt.genesis.v1',
  receipt: 'rasta.example.receipt.v1',
};

const SCHEME = new SealingScheme(LABELS);

const BINDING: EnvelopeBinding = {
  scopeId: 'SCP_A',
  entryId: 'ENT_1',
  submitterId: 'ORG_SUBMITTER',
  revision: 1,
  keyId: 'TKY_1',
};

const CONTENT = {
  amountMinor: '4200000000',
  durationDays: 120,
  note: 'پیشنهاد ما، شامل مصالح',
  responses: [{ code: 'EXPERIENCE', response: 'Nine road projects' }],
};

let pair: SealingKeyPair;
let privateKey: KeyObject;
let otherPair: SealingKeyPair;

beforeAll(async () => {
  pair = await generateSealingKeyPair();
  privateKey = privateKeyFromDer(pair.privateKeyDer);
  otherPair = await generateSealingKeyPair();
});

const seal = (binding: EnvelopeBinding = BINDING, content: unknown = CONTENT) =>
  SCHEME.seal({ publicKeyPem: pair.publicKeyPem, binding, content });

/** A sealed envelope and the binding it was sealed under (the default binding when omitted). */
type Issued = SealedEnvelope | { sealed: SealedEnvelope; binding?: EnvelopeBinding };

/**
 * The receipts a scope would have issued, in order, for these envelopes, and the head
 * the trusted copy would hold. Each envelope is receipted under the binding it was
 * sealed with.
 */
const receiptsOf = (issuedEnvelopes: Issued[], scopeId = BINDING.scopeId): TrustedReceipts => {
  const links: (ReceiptLink & { receipt: string })[] = [];
  let previous = SCHEME.genesisReceipt(scopeId);
  issuedEnvelopes.forEach((issued, index) => {
    const { sealed, binding } = 'sealed' in issued ? issued : { sealed: issued, binding: BINDING };
    const link: ReceiptLink = {
      entryId: (binding ?? BINDING).entryId,
      revision: (binding ?? BINDING).revision,
      receivedAt: new Date(Date.UTC(2026, 10, 1, 8, index, 0)),
      ciphertextSha256: sealed.ciphertextSha256,
      contentCommitment: sealed.contentCommitment,
    };
    const receipt = SCHEME.nextReceipt(scopeId, previous, link);
    links.push({ ...link, receipt });
    previous = receipt;
  });
  return { links, head: previous };
};

/**
 * Opens `sealed`; unless told otherwise, against the receipts that were issued for it alone,
 * verified for the scope the binding names (as opening verifies them, once per scope).
 */
const open = (
  sealed: SealedEnvelope,
  binding: EnvelopeBinding = BINDING,
  key: KeyObject = privateKey,
  receipts: TrustedReceipts = receiptsOf([{ sealed, binding }], binding.scopeId),
) =>
  SCHEME.open({
    privateKey: key,
    binding,
    sealed,
    receipts: SCHEME.verifyReceipts(binding.scopeId, receipts),
  });

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
    const content = '{"amountMinor":"1"}';
    const label = Buffer.from(LABELS.commitment);
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
    expect(SCHEME.commitmentOf(salt, content)).toBe(expected);
  });
});

describe('sealing and opening an envelope', () => {
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

  it('uses an RSA-3072 scope key', () => {
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
    for (const secret of ['4200000000', 'Nine road projects', 'EXPERIENCE', 'amountMinor']) {
      expect(everything.includes(Buffer.from(secret))).toBe(false);
    }
  });

  it('seals the same content differently each time: fresh salt, key and nonce', () => {
    const a = seal();
    const b = seal();
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
    expect(a.nonce.equals(b.nonce)).toBe(false);
    expect(a.wrappedContentKey.equals(b.wrappedContentKey)).toBe(false);
    // The salt is what stops a published commitment from being guessed back to an amount.
    expect(a.contentCommitment).not.toBe(b.contentCommitment);
  });

  it('binds the sealed bytes to the submitter, and refuses a key id that is not the sealed one', () => {
    const sealed = seal();
    expect(() => open(sealed, { ...BINDING, submitterId: 'ORG_OTHER' })).toThrow(
      expect.objectContaining({ code: 'TAMPERED' }),
    );
    expect(() => open(sealed, { ...BINDING, keyId: 'TKY_2' })).toThrow(
      expect.objectContaining({ code: 'TAMPERED' }),
    );
  });

  it('refuses another scope, another entry and another revision than the receipts are for', () => {
    const sealed = seal();
    const receipts = receiptsOf([sealed]);
    // Another scope: its chain starts from another genesis.
    expect(() => open(sealed, { ...BINDING, scopeId: 'SCP_B' }, privateKey, receipts)).toThrow(
      expect.objectContaining({ code: 'RECEIPT_CHAIN_BROKEN' }),
    );
    // An entry the chain has no receipt for.
    expect(() => open(sealed, { ...BINDING, entryId: 'ENT_2' }, privateKey, receipts)).toThrow(
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
      const tampered: SealedEnvelope = { ...sealed, [field]: flip(sealed[field], 3) };
      expect(() => open(tampered, BINDING, privateKey, receiptsOf([sealed]))).toThrow(
        expect.objectContaining({ code: 'RECEIPT_MISMATCH' }),
      );
    },
  );

  it('is not fooled by a tampered envelope whose stored digest was rewritten to match', () => {
    // The stored `ciphertextSha256` is data the same writer can change. Opening
    // recomputes the digest from the bytes and compares it with the receipt.
    const sealed = seal();
    const tampered: SealedEnvelope = { ...sealed, ciphertext: flip(sealed.ciphertext, 3) };
    const rewritten: SealedEnvelope = {
      ...tampered,
      ciphertextSha256: SCHEME.ciphertextDigest(tampered),
    };
    expect(() => open(rewritten, BINDING, privateKey, receiptsOf([sealed]))).toThrow(
      expect.objectContaining({ code: 'RECEIPT_MISMATCH' }),
    );
  });

  it('refuses a sealed envelope of another version', () => {
    expect(() => open({ ...seal(), version: 2 })).toThrow(
      expect.objectContaining({ code: 'TAMPERED' }),
    );
  });

  it('refuses a substituted envelope: same binding, other content, its own consistent digest and commitment', () => {
    // Codex review of #163. Someone who can write the table (and holds the scope's
    // public key, which is not secret) seals other content under the very same
    // binding. The forgery is perfectly self-consistent — its own commitment, its
    // own digest — and decrypts cleanly. Only the receipt the submitter was given
    // can tell it from the original.
    const original = seal();
    const receipts = receiptsOf([original]);
    const forged = seal(BINDING, { ...CONTENT, amountMinor: '1' });

    expect(open(forged, BINDING, privateKey, receiptsOf([forged]))).toMatchObject({
      amountMinor: '1',
    });
    expect(() => open(forged, BINDING, privateKey, receipts)).toThrow(
      expect.objectContaining({ code: 'RECEIPT_MISMATCH' }),
    );
  });

  it('refuses a substitution that also rebuilds the whole chain, against the trusted head', () => {
    const original = seal();
    const trusted = receiptsOf([original]);
    const forged = seal(BINDING, { ...CONTENT, amountMinor: '1' });
    const rebuilt = receiptsOf([forged]);

    // The rebuilt chain is internally sound, and opens the forgery — until it is
    // checked against the head held outside the database.
    expect(() => open(forged, BINDING, privateKey, { ...rebuilt, head: trusted.head })).toThrow(
      expect.objectContaining({ code: 'RECEIPT_CHAIN_BROKEN' }),
    );
  });

  it('refuses an envelope opened against a chain that has been cut short', () => {
    const [first, second] = [seal(), seal({ ...BINDING, entryId: 'ENT_2' })];
    const whole = receiptsOf([
      first,
      { sealed: second, binding: { ...BINDING, entryId: 'ENT_2' } },
    ]);
    const cut = { links: whole.links.slice(0, 1), head: whole.head };
    expect(() => open(first, BINDING, privateKey, cut)).toThrow(
      expect.objectContaining({ code: 'RECEIPT_CHAIN_BROKEN' }),
    );
  });

  describe('the receipts verified once per scope (Codex r1 on #250, R2)', () => {
    const openWith = (sealed: SealedEnvelope, receipts: VerifiedReceipts, binding = BINDING) =>
      SCHEME.open({ privateKey, binding, sealed, receipts });

    it('opens every envelope of a scope against one verification', () => {
      const bindings = [1, 2, 3].map((n) => ({
        ...BINDING,
        entryId: `ENT_${n}`,
        submitterId: `ORG_${n}`,
      }));
      const sealed = bindings.map((binding) => seal(binding));
      const verified = SCHEME.verifyReceipts(
        BINDING.scopeId,
        receiptsOf(sealed.map((s, i) => ({ sealed: s, binding: bindings[i] }))),
      );
      expect(verified.head).toBe(
        receiptsOf(sealed.map((s, i) => ({ sealed: s, binding: bindings[i] }))).head,
      );
      sealed.forEach((s, i) => expect(openWith(s, verified, bindings[i])).toEqual(CONTENT));
    });

    it('refuses to verify a chain that does not end at the trusted head', () => {
      const trusted = receiptsOf([seal()]);
      const rebuilt = receiptsOf([seal(BINDING, { ...CONTENT, amountMinor: '1' })]);
      expect(() =>
        SCHEME.verifyReceipts(BINDING.scopeId, { links: rebuilt.links, head: trusted.head }),
      ).toThrow(expect.objectContaining({ code: 'RECEIPT_CHAIN_BROKEN' }));
    });

    it('is for one scope: verified for SCP_A, it opens nothing of SCP_B', () => {
      const sealedB = seal({ ...BINDING, scopeId: 'SCP_B' });
      const verifiedA = SCHEME.verifyReceipts('SCP_A', receiptsOf([seal()]));
      expect(() => openWith(sealedB, verifiedA, { ...BINDING, scopeId: 'SCP_B' })).toThrow(
        expect.objectContaining({ code: 'RECEIPT_CHAIN_BROKEN' }),
      );
    });

    it('cannot be forged: an object that did not come from verifyReceipts opens nothing', () => {
      const sealed = seal();
      const verified = SCHEME.verifyReceipts(BINDING.scopeId, receiptsOf([sealed]));
      const lookalike = Object.create(VerifiedReceipts.prototype as object, {
        scopeId: { value: verified.scopeId },
        head: { value: verified.head },
        newestOf: { value: (id: string) => verified.newestOf(id) },
      }) as VerifiedReceipts;
      expect(() => openWith(sealed, lookalike)).toThrow(
        expect.objectContaining({ code: 'RECEIPT_CHAIN_BROKEN' }),
      );
      expect(openWith(sealed, verified)).toEqual(CONTENT);
    });

    it('cannot be changed in-process once verified (Codex r2 on #250)', () => {
      const original = seal();
      const forged = seal(BINDING, { ...CONTENT, amountMinor: '1' });
      const verified = SCHEME.verifyReceipts(BINDING.scopeId, receiptsOf([original]));
      const writable = verified as unknown as Record<string, unknown>;

      // The handle is frozen and carries nothing: no field to point at another scope or index.
      expect(Object.isFrozen(verified)).toBe(true);
      expect(Object.keys(verified)).toEqual([]);
      expect(() => (writable.scopeId = 'SCP_OTHER')).toThrow(TypeError);
      expect(() => (writable.newest = new Map())).toThrow(TypeError);
      // Nor can the class's behaviour be swapped for every handle at once.
      expect(() => {
        (VerifiedReceipts.prototype as unknown as Record<string, unknown>).newestOf = () =>
          undefined;
      }).toThrow(TypeError);
      expect(() => {
        (VerifiedReceipts as unknown as Record<string, unknown>).verify = () => verified;
      }).toThrow(TypeError);

      // What it hands out is a copy: rewriting it to vouch for the forgery changes nothing.
      const handedOut = verified.newestOf(BINDING.entryId) as unknown as Record<string, unknown>;
      expect(() => (handedOut.ciphertextSha256 = forged.ciphertextSha256)).toThrow(TypeError);
      (handedOut.receivedAt as Date).setTime(0);
      expect(verified.newestOf(BINDING.entryId)?.receivedAt.getTime()).not.toBe(0);

      expect(() => openWith(forged, verified)).toThrow(
        expect.objectContaining({ code: 'RECEIPT_MISMATCH' }),
      );
      expect(openWith(original, verified)).toEqual(CONTENT);
    });

    it('reads only what it verified: editing the receipts afterwards changes nothing', () => {
      const original = seal();
      const forged = seal(BINDING, { ...CONTENT, amountMinor: '1' });
      const receipts = receiptsOf([original]);
      const verified = SCHEME.verifyReceipts(BINDING.scopeId, receipts);
      // The caller's copy rewritten to vouch for the forgery after the check.
      const link = receipts.links[0] as { ciphertextSha256: string; contentCommitment: string };
      link.ciphertextSha256 = forged.ciphertextSha256;
      link.contentCommitment = forged.contentCommitment;
      expect(() => openWith(forged, verified)).toThrow(
        expect.objectContaining({ code: 'RECEIPT_MISMATCH' }),
      );
      expect(openWith(original, verified)).toEqual(CONTENT);
    });
  });

  it('opens each envelope of a longer chain against its own receipt, and only the newest revision', () => {
    const one = seal();
    const two = seal({ ...BINDING, entryId: 'ENT_2', submitterId: 'ORG_OTHER' });
    const revised = seal({ ...BINDING, revision: 2 }, { ...CONTENT, amountMinor: '4100000000' });
    const receipts = receiptsOf([
      { sealed: one },
      { sealed: two, binding: { ...BINDING, entryId: 'ENT_2', submitterId: 'ORG_OTHER' } },
      { sealed: revised, binding: { ...BINDING, revision: 2 } },
    ]);

    expect(
      open(two, { ...BINDING, entryId: 'ENT_2', submitterId: 'ORG_OTHER' }, privateKey, receipts),
    ).toEqual(CONTENT);
    expect(open(revised, { ...BINDING, revision: 2 }, privateKey, receipts)).toMatchObject({
      amountMinor: '4100000000',
    });
    // Revision 1 of ENT_1 is no longer the entry: its receipt is not the newest.
    expect(() => open(one, BINDING, privateKey, receipts)).toThrow(
      expect.objectContaining({ code: 'RECEIPT_MISMATCH' }),
    );
  });

  it('detects content that does not match the commitment the receipt recorded', () => {
    // An envelope whose recorded commitment was never the commitment of its content —
    // a fault at submission, however it arose. The digest and the receipt agree
    // with each other; the decrypted content does not agree with either.
    const sealed = seal();
    const wrongCommitment: SealedEnvelope = { ...sealed, contentCommitment: 'ab'.repeat(32) };
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
    expect(() => seal(BINDING, { amountMinor: 12.5 })).toThrow(
      expect.objectContaining({ code: 'INVALID_CONTENT' }),
    );
    expect(() => seal(BINDING, { note: 'x'.repeat(MAX_CONTENT_BYTES + 1) })).toThrow(
      expect.objectContaining({ code: 'INVALID_CONTENT' }),
    );
  });

  it('refuses a public key it cannot use, without saying anything about the content', () => {
    expect(() =>
      SCHEME.seal({ publicKeyPem: 'not a key', binding: BINDING, content: CONTENT }),
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
      () => open(sealed, { ...BINDING, submitterId: 'ORG_OTHER' }),
      () => open({ ...sealed, contentCommitment: '00'.repeat(32) }),
      () => seal(BINDING, { amountMinor: 12.5 }),
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

  /** Three envelopes' receipts, issued in order, as the scope would. */
  function chain(scopeId = 'SCP_A') {
    const sealed = [
      seal(),
      seal({ ...BINDING, entryId: 'ENT_2' }),
      seal({ ...BINDING, entryId: 'ENT_3' }),
    ];
    const links: (ReceiptLink & { receipt: string })[] = [];
    let previous = SCHEME.genesisReceipt(scopeId);
    sealed.forEach((envelope, index) => {
      const link: ReceiptLink = {
        entryId: `ENT_${index + 1}`,
        revision: 1,
        receivedAt: at(index),
        ciphertextSha256: envelope.ciphertextSha256,
        contentCommitment: envelope.contentCommitment,
      };
      const receipt = SCHEME.nextReceipt(scopeId, previous, link);
      links.push({ ...link, receipt });
      previous = receipt;
    });
    return { links, head: previous };
  }

  it('starts from a genesis of its own scope', () => {
    expect(SCHEME.genesisReceipt('SCP_A')).toMatch(/^[0-9a-f]{64}$/);
    expect(SCHEME.genesisReceipt('SCP_A')).not.toBe(SCHEME.genesisReceipt('SCP_B'));
  });

  it('verifies a chain that ends at the trusted head, and the empty chain at genesis', () => {
    const { links, head } = chain();
    expect(SCHEME.verifyReceiptChain('SCP_A', links, head)).toEqual({ ok: true });
    expect(SCHEME.verifyReceiptChain('SCP_A', [], SCHEME.genesisReceipt('SCP_A'))).toEqual({
      ok: true,
    });
  });

  it.each([
    ['entryId', { entryId: 'ENT_X' }],
    ['revision', { revision: 2 }],
    ['receivedAt', { receivedAt: new Date(Date.UTC(2026, 10, 1, 8, 59, 0)) }],
    ['ciphertextSha256', { ciphertextSha256: 'ab'.repeat(32) }],
    ['contentCommitment', { contentCommitment: 'cd'.repeat(32) }],
  ])('finds an edited %s at the link it was edited in', (_field, change) => {
    const { links, head } = chain();
    links[1] = { ...links[1]!, ...change };
    expect(SCHEME.verifyReceiptChain('SCP_A', links, head)).toEqual({
      ok: false,
      reason: 'LINK_BROKEN',
      brokenAt: 1,
    });
  });

  it('finds a removed link, a reordered pair, and a link spliced in from another scope', () => {
    const { links, head } = chain();
    expect(SCHEME.verifyReceiptChain('SCP_A', [links[0]!, links[2]!], head)).toEqual({
      ok: false,
      reason: 'LINK_BROKEN',
      brokenAt: 1,
    });
    expect(SCHEME.verifyReceiptChain('SCP_A', [links[1]!, links[0]!, links[2]!], head)).toEqual({
      ok: false,
      reason: 'LINK_BROKEN',
      brokenAt: 0,
    });
    expect(SCHEME.verifyReceiptChain('SCP_B', chain('SCP_A').links, head)).toEqual({
      ok: false,
      reason: 'LINK_BROKEN',
      brokenAt: 0,
    });
  });

  it('finds a chain cut short, extended or replaced, by the head it does not end at', () => {
    const { links, head } = chain();
    // Cut short: the newest receipts are gone, and what is left is perfectly sound.
    expect(SCHEME.verifyReceiptChain('SCP_A', links.slice(0, 2), head)).toEqual({
      ok: false,
      reason: 'HEAD_MISMATCH',
    });
    // Emptied.
    expect(SCHEME.verifyReceiptChain('SCP_A', [], head)).toEqual({
      ok: false,
      reason: 'HEAD_MISMATCH',
    });
    // Replaced by another sound chain: sound on its own, and not the one issued.
    const other = chain();
    expect(SCHEME.verifyReceiptChain('SCP_A', other.links, other.head)).toEqual({ ok: true });
    expect(SCHEME.verifyReceiptChain('SCP_A', other.links, head)).toEqual({
      ok: false,
      reason: 'HEAD_MISMATCH',
    });
  });
});

describe('the receipts from outside evidence (trustedReceiptsOf)', () => {
  /** Evidence as an outside holder answers it: `receivedAt` as text, the genesis named. */
  const evidenceOf = (receipts: TrustedReceipts, scopeId = BINDING.scopeId) => ({
    scopeId,
    genesis: SCHEME.genesisReceipt(scopeId),
    head: receipts.head,
    links: receipts.links.map((link) => ({ ...link, receivedAt: link.receivedAt.toISOString() })),
  });

  it('verifies sound evidence once, and every envelope it receipted opens against it', () => {
    const sealed = seal();
    const verified = SCHEME.trustedReceiptsOf(evidenceOf(receiptsOf([sealed])));
    expect(verified.scopeId).toBe(BINDING.scopeId);
    expect(SCHEME.open({ privateKey, binding: BINDING, sealed, receipts: verified })).toEqual(
      CONTENT,
    );
  });

  it('refuses evidence that names another genesis, or does not end at its head', () => {
    const receipts = receiptsOf([seal()]);
    const sound = evidenceOf(receipts);
    for (const broken of [
      { ...sound, genesis: SCHEME.genesisReceipt('SCP_B') },
      { ...sound, genesis: 'e'.repeat(64) },
      { ...sound, head: 'f'.repeat(64) },
      { ...sound, links: [] },
    ]) {
      expect(() => SCHEME.trustedReceiptsOf(broken)).toThrow(
        expect.objectContaining({ code: 'RECEIPT_CHAIN_BROKEN' }),
      );
    }
  });

  it('refuses a link whose receivedAt text is not the instant that was hashed', () => {
    const sound = evidenceOf(receiptsOf([seal()]));
    const shifted = {
      ...sound,
      links: sound.links.map((link) => ({ ...link, receivedAt: '2026-11-01T08:00:00.001Z' })),
    };
    expect(() => SCHEME.trustedReceiptsOf(shifted)).toThrow(
      expect.objectContaining({ code: 'RECEIPT_CHAIN_BROKEN' }),
    );
  });
});

describe('the scheme', () => {
  const OTHER = new SealingScheme({
    associatedData: 'rasta.other.aad.v1',
    commitment: 'rasta.other.commitment.v1',
    ciphertext: 'rasta.other.ciphertext.v1',
    receiptGenesis: 'rasta.other.receipt.genesis.v1',
    receipt: 'rasta.other.receipt.v1',
  });

  /** The receipts of `issued` under `scheme`, verified for the default scope. */
  const verifiedUnder = (scheme: SealingScheme, sealed: SealedEnvelope) => {
    const link: ReceiptLink = {
      entryId: BINDING.entryId,
      revision: BINDING.revision,
      receivedAt: new Date(Date.UTC(2026, 10, 1, 8, 0, 0)),
      ciphertextSha256: sealed.ciphertextSha256,
      contentCommitment: sealed.contentCommitment,
    };
    const receipt = scheme.nextReceipt(
      BINDING.scopeId,
      scheme.genesisReceipt(BINDING.scopeId),
      link,
    );
    return scheme.verifyReceipts(BINDING.scopeId, { links: [{ ...link, receipt }], head: receipt });
  };

  it('puts its labels in every structure: another scheme makes none of the same bytes', () => {
    const salt = Buffer.alloc(32, 7);
    const parts = {
      keyId: 'TKY_1',
      nonce: Buffer.alloc(12, 1),
      ciphertext: Buffer.from('ciphertext'),
      tag: Buffer.alloc(16, 2),
      wrappedContentKey: Buffer.alloc(384, 3),
    };
    const link: ReceiptLink = {
      entryId: 'ENT_1',
      revision: 1,
      receivedAt: new Date(0),
      ciphertextSha256: 'a'.repeat(64),
      contentCommitment: 'b'.repeat(64),
    };
    const mine = SCHEME.genesisReceipt('SCP_A');
    const theirs = OTHER.genesisReceipt('SCP_A');
    expect(theirs).not.toBe(mine);
    expect(OTHER.nextReceipt('SCP_A', mine, link)).not.toBe(
      SCHEME.nextReceipt('SCP_A', mine, link),
    );
    expect(OTHER.commitmentOf(salt, '{}')).not.toBe(SCHEME.commitmentOf(salt, '{}'));
    expect(OTHER.ciphertextDigest(parts)).not.toBe(SCHEME.ciphertextDigest(parts));
    expect(OTHER.associatedDataOf(BINDING).equals(SCHEME.associatedDataOf(BINDING))).toBe(false);
    // Each is exactly the length-prefixed encoding under its own label.
    expect(SCHEME.associatedDataOf(BINDING)).toEqual(
      lengthPrefixed(LABELS.associatedData, 'SCP_A', 'ENT_1', 'ORG_SUBMITTER', '1', 'TKY_1'),
    );
    expect(mine).toBe(
      createHash('sha256').update(lengthPrefixed(LABELS.receiptGenesis, 'SCP_A')).digest('hex'),
    );
  });

  it('opens nothing sealed under another scheme, and accepts no other scheme’s verification', () => {
    const sealed = seal();
    // Receipts verified under this scheme do not stand for the other's.
    expect(() =>
      OTHER.open({ privateKey, binding: BINDING, sealed, receipts: verifiedUnder(SCHEME, sealed) }),
    ).toThrow(expect.objectContaining({ code: 'RECEIPT_CHAIN_BROKEN' }));
    // Receipted under the other scheme, the digest it recomputes is not the receipted one.
    expect(() =>
      OTHER.open({ privateKey, binding: BINDING, sealed, receipts: verifiedUnder(OTHER, sealed) }),
    ).toThrow(expect.objectContaining({ code: 'RECEIPT_MISMATCH' }));
    // Sealed by the other scheme and receipted there: still its own scheme's only.
    const theirs = OTHER.seal({
      publicKeyPem: pair.publicKeyPem,
      binding: BINDING,
      content: CONTENT,
    });
    expect(
      OTHER.open({
        privateKey,
        binding: BINDING,
        sealed: theirs,
        receipts: verifiedUnder(OTHER, theirs),
      }),
    ).toEqual(CONTENT);
    expect(() =>
      SCHEME.open({
        privateKey,
        binding: BINDING,
        sealed: theirs,
        receipts: verifiedUnder(SCHEME, theirs),
      }),
    ).toThrow(expect.objectContaining({ code: 'RECEIPT_MISMATCH' }));
    // Even given this scheme's digest and receipts, its associated data is not the other's.
    const relabelled = { ...theirs, ciphertextSha256: SCHEME.ciphertextDigest(theirs) };
    expect(() =>
      SCHEME.open({
        privateKey,
        binding: BINDING,
        sealed: relabelled,
        receipts: verifiedUnder(SCHEME, relabelled),
      }),
    ).toThrow(expect.objectContaining({ code: 'TAMPERED' }));
  });

  it.each([
    ['an empty label', { ...LABELS, commitment: '' }],
    ['a label over 128 characters', { ...LABELS, receipt: 'x'.repeat(129) }],
    ['one label for two structures', { ...LABELS, receipt: LABELS.receiptGenesis }],
    ['a label that is not a string', { ...LABELS, ciphertext: 7 as unknown as string }],
    ['a missing label', { ...LABELS, associatedData: undefined as unknown as string }],
  ])('refuses %s', (_label, labels) => {
    expect(() => new SealingScheme(labels)).toThrow(
      expect.objectContaining({ code: 'INVALID_CONFIGURATION' }),
    );
  });

  it('keeps its own copy of the labels, and cannot be changed', () => {
    const labels = { ...LABELS };
    const scheme = new SealingScheme(labels);
    const before = scheme.genesisReceipt('SCP_A');
    labels.receiptGenesis = 'rasta.changed.v1';
    expect(scheme.genesisReceipt('SCP_A')).toBe(before);
    expect(Object.isFrozen(scheme)).toBe(true);
    expect(() => {
      (scheme as unknown as Record<string, unknown>).labels = { ...LABELS, receiptGenesis: 'x' };
    }).toThrow(TypeError);
  });

  it('makes a VerifiedReceipts only by verifying: one made any other way opens nothing', () => {
    const sealed = seal();
    const made = new (VerifiedReceipts as unknown as new () => VerifiedReceipts)();
    expect(() => made.scopeId).toThrow(expect.objectContaining({ code: 'RECEIPT_CHAIN_BROKEN' }));
    expect(() => SCHEME.open({ privateKey, binding: BINDING, sealed, receipts: made })).toThrow(
      expect.objectContaining({ code: 'RECEIPT_CHAIN_BROKEN' }),
    );
  });
});

describe('the API', () => {
  it('names no domain: nothing it exports speaks of a tender, a bid, a quotation or an RFQ', () => {
    const exported = Object.keys(api);
    expect(exported).toEqual(expect.arrayContaining(['SealingScheme', 'canonicalize']));
    expect(exported.filter((name) => /tender|bid|quotation|rfq/i.test(name))).toEqual([]);
  });
});
