import { z } from 'zod';
import {
  attachDocumentSchema,
  changeStatusSchema,
  createAssetSchema,
  createInspectionSchema,
  createPolicySchema,
  decideClaimSchema,
  decommissionSchema,
  recordClaimSettlementSchema,
  recordLocationSchema,
  reviewClaimSchema,
  submitClaimSchema,
  transferAssetSchema,
  updateAssetSchema,
} from './dto';

/**
 * Server-side bidi controls (#150 triage, item 2): every free-text field and
 * identifier a caller types refuses all of `\p{Bidi_Control}` — U+061C ARABIC
 * LETTER MARK included, which the Arabic-script class used to admit — with a
 * closed message that repeats nothing of the input (S-09). Persian with ZWNJ is
 * still accepted.
 */

const BIDI_CONTROLS = [
  0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069,
].map((cp) => [cp.toString(16).toUpperCase().padStart(4, '0'), cp] as const);
const SAMPLE = 'گواهی شماره ۱۲۳۴';
const SAMPLES: Record<string, string> = {};

/** The schema of one field, through refinements and optional/nullable wrappers. */
function fieldOf(schema: z.ZodTypeAny, path: string): z.ZodTypeAny {
  let current: z.ZodTypeAny = schema;
  for (const key of path.split('.')) {
    for (;;) {
      if (current instanceof z.ZodEffects) current = current.innerType();
      else if (current instanceof z.ZodOptional || current instanceof z.ZodNullable)
        current = current.unwrap();
      else break;
    }
    current = (current as z.AnyZodObject).shape[key] as z.ZodTypeAny;
    if (!current) throw new Error(`no field ${path}`);
  }
  return current;
}

const FIELDS: [z.ZodTypeAny, string][] = [
  [createAssetSchema, 'name'],
  [createAssetSchema, 'assetTag'],
  [createAssetSchema, 'manufacturer'],
  [createAssetSchema, 'serialNumber'],
  [createAssetSchema, 'location.siteName'],
  [createAssetSchema, 'location.addressLine'],
  [updateAssetSchema, 'name'],
  [updateAssetSchema, 'assetTag'],
  [transferAssetSchema, 'reason'],
  [transferAssetSchema, 'referenceNo'],
  [recordLocationSchema, 'siteName'],
  [recordLocationSchema, 'addressLine'],
  [attachDocumentSchema, 'title'],
  [createPolicySchema, 'policyNumber'],
  [createPolicySchema, 'insurerName'],
  [createInspectionSchema, 'centerName'],
  [submitClaimSchema, 'claimNumber'],
  [submitClaimSchema, 'description'],
  [reviewClaimSchema, 'notes'],
  [decideClaimSchema, 'notes'],
  [recordClaimSettlementSchema, 'settlementReference'],
  [recordClaimSettlementSchema, 'notes'],
];

describe.each(FIELDS)('%#: field %s', (schema, path) => {
  const field = fieldOf(schema, path);
  const leaf = path.split('.').pop() ?? path;
  const sample = SAMPLES[leaf] ?? SAMPLE;

  it('accepts clean Persian text with ZWNJ', () => {
    expect(field.safeParse(sample).success).toBe(true);
  });

  it.each(BIDI_CONTROLS)('refuses U+%s, repeating nothing of the input', (_hex, cp) => {
    const value = `${sample.slice(0, 2)}${String.fromCodePoint(cp)}${sample.slice(2)}`;
    const result = field.safeParse(value);

    expect(result.success).toBe(false);
    expect(result.error?.issues).toContainEqual(
      expect.objectContaining({ message: 'Contains unsupported characters' }),
    );
    expect(JSON.stringify(result.error?.issues)).not.toContain(sample.slice(2));
  });
});

/**
 * The eight fields #209 left as bare trimmed strings because the portal's
 * contract specs pinned them, six of them here: they are `plainText()` now, and
 * the portal forms refuse the same characters first. Each sample carries ZWNJ,
 * so "Persian is still accepted" means Persian as it is actually written.
 */
const PORTAL_PINNED: [z.ZodTypeAny, string, string][] = [
  [createAssetSchema, 'model', 'لودر چرخ‌دار WA320'],
  [updateAssetSchema, 'model', 'لودر چرخ‌دار WA320'],
  [changeStatusSchema, 'reason', 'دستگاه برای تعمیر خارج می‌شود'],
  [decommissionSchema, 'reason', 'موتور از کار افتاده و تعمیرش به‌صرفه نیست'],
  [createInspectionSchema, 'certificateNo', 'گواهی‌۱۴۰۳-۱۲'],
  [createInspectionSchema, 'notes', 'لاستیک‌ها باید تا ماه بعد عوض شوند'],
];

describe.each(PORTAL_PINNED)(
  '%#: field %s, pinned by the portal until now',
  (schema, path, sample) => {
    const field = fieldOf(schema, path);

    it('accepts Persian with ZWNJ, trimmed', () => {
      expect(sample).toContain('\u200c');
      expect(field.parse(`  ${sample} `)).toBe(sample);
    });

    it.each(BIDI_CONTROLS)('refuses U+%s, repeating nothing of the input', (_hex, cp) => {
      const value = `${sample.slice(0, 2)}${String.fromCodePoint(cp)}${sample.slice(2)}`;
      const result = field.safeParse(value);

      expect(result.success).toBe(false);
      expect(result.error?.issues).toContainEqual(
        expect.objectContaining({ message: 'Contains unsupported characters' }),
      );
      expect(JSON.stringify(result.error?.issues)).not.toContain(sample.slice(2));
    });
  },
);
