import { generateSealingKeyPair, privateKeyFromDer } from '@rasta/sealing';
import { expectNotDisclosed } from '@rasta/testing';
import { RastaError, runWithContext, createSystemContext } from '@rasta/nest-common';
import type { RfqRecord } from '../rfq/rfq.repository';
import { MAX_AMOUNT_MINOR, canonicalText, putQuotationSchema, quotationContentSchema } from './dto';
import { assertSealable } from './quotation.service';
import { QUOTATION_SEALING, QUOTATION_SEALING_LABELS } from './sealing';

const record = (totalQuantity: number, codes = ['PRICE', 'ISO']): RfqRecord =>
  ({
    rfq: { id: 'RFQ_01JABCDEFGHJKMNPQRSTVWXYZ2', totalQuantity },
    criteria: codes.map((code) => ({ code })),
  }) as unknown as RfqRecord;

const content = (unitPriceMinor: string, codes = ['PRICE', 'ISO']) => ({
  unitPriceMinor,
  answers: codes.map((criterionCode) => ({ criterionCode, answer: 'yes' })),
});

/** A price no generated value (a ULID, a digest) can hold a piece of (#452). */
const wholeNumber = (digits: string) => new RegExp(`(?<![0-9A-Za-z])${digits}(?![0-9A-Za-z])`);

const inContext = <T>(fn: () => T): T =>
  runWithContext(
    createSystemContext({ correlationId: 'c', organizationId: 'ORG_X', callerService: 't' }),
    fn,
  );

/** The closed code a refusal names, or 'ACCEPTED'. */
const verdict = (rfq: RfqRecord, value: ReturnType<typeof content>): string =>
  inContext(() => {
    try {
      assertSealable(rfq, value);
      return 'ACCEPTED';
    } catch (error) {
      if (!(error instanceof RastaError)) throw error;
      return String(error.details?.[0]?.code);
    }
  });

describe('the quotation seal (ADR-070 § 4)', () => {
  it('starts every RFQ chain at the genesis audit-service recomputes: the bytes pinned in rfq-evidence.spec.ts', () => {
    expect(QUOTATION_SEALING_LABELS.receiptGenesis).toBe('rasta.quotation.receipt.genesis.v1');
    expect(QUOTATION_SEALING.genesisReceipt('RFQ_01')).toBe(
      '583badc22111e9a83b733c34ebda5090b6781b4d205eb66046ce3b1edc59abf0',
    );
  });

  it('labels nothing like a bid: every label is the quotation’s own', () => {
    for (const label of Object.values(QUOTATION_SEALING_LABELS)) {
      expect(label).toMatch(/^rasta\.quotation\./);
    }
  });

  it('seals what opens again only under the same binding, and commits to the content', async () => {
    const pair = await generateSealingKeyPair();
    const binding = {
      scopeId: 'RFQ_1',
      entryId: 'QOT_1',
      submitterId: 'ORG_S',
      revision: 1,
      keyId: 'RFK_1',
    };
    const value = content('1000');
    const sealed = QUOTATION_SEALING.seal({
      publicKeyPem: pair.publicKeyPem,
      binding,
      content: value,
    });
    expect(sealed.ciphertext.toString('utf8')).not.toContain('1000');
    const link = {
      entryId: 'QOT_1',
      revision: 1,
      receivedAt: new Date('2031-03-02T08:00:00.000Z'),
      ciphertextSha256: sealed.ciphertextSha256,
      contentCommitment: sealed.contentCommitment,
    };
    const genesis = QUOTATION_SEALING.genesisReceipt('RFQ_1');
    const receipt = QUOTATION_SEALING.nextReceipt('RFQ_1', genesis, link);
    const receipts = QUOTATION_SEALING.verifyReceipts('RFQ_1', {
      links: [{ ...link, receipt }],
      head: receipt,
    });
    const privateKey = privateKeyFromDer(pair.privateKeyDer);
    expect(QUOTATION_SEALING.open({ privateKey, binding, sealed, receipts })).toEqual(value);
    expect(() =>
      QUOTATION_SEALING.open({
        privateKey,
        binding: { ...binding, submitterId: 'ORG_T' },
        sealed,
        receipts,
      }),
    ).toThrow();
  });
});

describe('what may be sealed (assertSealable)', () => {
  // 2^63 − 1 = 7 × 7 × 73 × 127 × 337 × 92737 × 649657: an exact product at the bound.
  const QUANTITY = 7 * 7 * 73;
  const AT_BOUND = (MAX_AMOUNT_MINOR / BigInt(QUANTITY)).toString();

  it('accepts unitPriceMinor × totalQuantity exactly at 2^63 − 1, and refuses one rial more per unit', () => {
    expect(BigInt(AT_BOUND) * BigInt(QUANTITY)).toBe(MAX_AMOUNT_MINOR);
    expect(verdict(record(QUANTITY), content(AT_BOUND))).toBe('ACCEPTED');
    expect(verdict(record(QUANTITY), content((BigInt(AT_BOUND) + 1n).toString()))).toBe(
      'QUOTATION_AMOUNT_OUT_OF_RANGE',
    );
  });

  it('judges the product in bigint, never a float: the largest unit price at the largest quantity is refused', () => {
    expect(verdict(record(2_147_483_647), content(MAX_AMOUNT_MINOR.toString()))).toBe(
      'QUOTATION_AMOUNT_OUT_OF_RANGE',
    );
    // 2^53 + 1 as a float is 2^53: a float product would accept it at the bound of 2^53.
    expect(verdict(record(1), content('9007199254740993'))).toBe('ACCEPTED');
  });

  it('wants one answer per criterion: an unknown code and a missing one are each refused', () => {
    expect(verdict(record(5), content('10', ['PRICE', 'ISO', 'EXTRA']))).toBe('UNKNOWN_CRITERION');
    expect(verdict(record(5), content('10', ['PRICE']))).toBe('CRITERION_UNANSWERED');
  });

  it('names a closed code in its refusal, never the price', () => {
    inContext(() => {
      try {
        assertSealable(record(QUANTITY), content('987654321987654321'));
        throw new Error('not refused');
      } catch (error) {
        const price = wholeNumber('987654321987654321');
        expectNotDisclosed({ error, message: (error as Error).message }, [price]);
      }
    });
  });
});

describe('the quotation body', () => {
  it('takes a positive whole price as text, up to 2^63 − 1, and never a number', () => {
    for (const ok of ['1', '9223372036854775807']) {
      expect(quotationContentSchema.safeParse(content(ok)).success).toBe(true);
    }
    for (const bad of ['0', '-1', '01', '1.5', '9223372036854775808', '1e3', ' 1']) {
      expect(quotationContentSchema.safeParse(content(bad)).success).toBe(false);
    }
    expect(quotationContentSchema.safeParse({ ...content('1'), unitPriceMinor: 1 }).success).toBe(
      false,
    );
  });

  it('writes CRLF and a lone CR as LF and composes to NFC before counting and sealing', () => {
    expect(canonicalText('a\r\nb\rc')).toBe('a\nb\nc');
    const parsed = quotationContentSchema.parse({
      ...content('1'),
      note: 'line one\r\nline two',
      answers: [{ criterionCode: 'PRICE', answer: 'é' }],
    });
    expect(parsed.note).toBe('line one\nline two');
    expect(parsed.answers[0]?.answer).toBe('é');
  });

  it('decides nothing from the body but the content and the revision the caller read', () => {
    expect(putQuotationSchema.safeParse({ content: content('1'), revision: 2 }).success).toBe(
      false,
    );
    expect(
      putQuotationSchema.safeParse({ content: { ...content('1'), currency: 'USD' } }).success,
    ).toBe(false);
    expect(
      putQuotationSchema.safeParse({ expectedRevision: 0, content: content('1') }).success,
    ).toBe(false);
  });
});
