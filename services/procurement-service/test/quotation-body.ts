/** Quotation bodies of an exact size, for the unit and the integration suites of the budget. */

/** The largest RFQ's criteria: as many codes as a quotation can answer. */
export const CRITERION_CODES = Array.from(
  { length: 50 },
  (_, index) => `C${String(index).padStart(2, '0')}`,
);

const MAX_TEXT = 2000;

/** What a run of text weighs in compact JSON, without its quotes. */
const jsonBytes = (text: string) => Buffer.byteLength(JSON.stringify(text), 'utf8') - 2;

export interface QuotationBody {
  expectedRevision?: number;
  content: {
    unitPriceMinor: string;
    answers: { criterionCode: string; answer: string }[];
    note?: string;
  };
}

/**
 * A canonical body of exactly `bytes` bytes of compact JSON, made of `unit` as far as it fits (the
 * note first, when asked for) and topped up in ASCII; every text starts and ends in ASCII, so
 * nothing is trimmed. Throws when the field bounds cannot make that size.
 */
export function quotationBodyOfBytes(
  bytes: number,
  unit: string,
  options: { note?: boolean; expectedRevision?: number } = {},
): QuotationBody {
  const fills = [...(options.note ? [''] : []), ...CRITERION_CODES.map(() => '')];
  const build = (): QuotationBody => {
    const text = (fill: string) => `x${fill}x`;
    const answers = options.note ? fills.slice(1) : fills;
    return {
      ...(options.expectedRevision ? { expectedRevision: options.expectedRevision } : {}),
      content: {
        unitPriceMinor: '10',
        answers: answers.map((fill, index) => ({
          criterionCode: CRITERION_CODES[index]!,
          answer: text(fill),
        })),
        ...(options.note ? { note: text(fills[0]!) } : {}),
      },
    };
  };
  let left = bytes - Buffer.byteLength(JSON.stringify(build()), 'utf8');
  for (const piece of [unit, 'x']) {
    const weight = jsonBytes(piece);
    const length = [...piece].length;
    fills.forEach((fill, index) => {
      const room = Math.floor((MAX_TEXT - 2 - [...fill].length) / length);
      const count = Math.min(room, Math.floor(left / weight));
      fills[index] = fill + piece.repeat(count);
      left -= count * weight;
    });
  }
  if (left !== 0) throw new Error(`no body of ${bytes} bytes can be made of this text`);
  return build();
}

/** Every field at its bound in `character`: the most a body can weigh within them. */
export function largestQuotationBody(character: string): QuotationBody {
  const full = `x${character.repeat(MAX_TEXT - 2)}x`;
  return {
    expectedRevision: 2_147_483_647,
    content: {
      unitPriceMinor: '9223372036854775807',
      answers: CRITERION_CODES.map((code) => ({
        criterionCode: code + character.repeat(47),
        answer: full,
      })),
      note: full,
    },
  };
}
