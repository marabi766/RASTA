import { z } from 'zod';
import {
  approveRequestSchema,
  assignWorkshopSchema,
  cancelRepairSchema,
  cancelRequestSchema,
  changeScheduleStatusSchema,
  completeRepairSchema,
  createRequestSchema,
  createScheduleSchema,
  recordCostSchema,
  recordLabourSchema,
  recordPartSchema,
  startRepairSchema,
  updateScheduleSchema,
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
  [createScheduleSchema, 'title'],
  [createScheduleSchema, 'notes'],
  [updateScheduleSchema, 'title'],
  [changeScheduleStatusSchema, 'reason'],
  [createRequestSchema, 'title'],
  [createRequestSchema, 'description'],
  [assignWorkshopSchema, 'workshopName'],
  [assignWorkshopSchema, 'workSummary'],
  [approveRequestSchema, 'notes'],
  [cancelRequestSchema, 'reason'],
  [startRepairSchema, 'workSummary'],
  [completeRepairSchema, 'workPerformed'],
  [cancelRepairSchema, 'reason'],
  [recordPartSchema, 'partName'],
  [recordPartSchema, 'unit'],
  [recordLabourSchema, 'description'],
  [recordLabourSchema, 'technician'],
  [recordCostSchema, 'description'],
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
 * The part's two references, which #209 left as bare trimmed strings because
 * the portal's contract spec pinned them. They are identifiers — the portal
 * takes both left-to-right — so they are `referenceId()`: every bidi control
 * and also every other control or format character, ZWNJ included, is refused
 * with the same closed message. Persian letters and digits are still accepted.
 */
describe.each(['partReference', 'sourceReference'])('recordPartSchema.%s', (path) => {
  const field = fieldOf(recordPartSchema, path);
  const SAMPLE_REFERENCE = 'حواله-۱۴۰۳-ORD01';
  const OTHER_CONTROLS = [
    ['ZWNJ', 0x200c],
    ['ZWJ', 0x200d],
    ['a byte-order mark', 0xfeff],
    ['a soft hyphen', 0x00ad],
    ['a tab', 0x09],
    ['a line separator', 0x2028],
  ] as const;

  it('accepts a reference in Persian or Latin letters and digits, trimmed', () => {
    expect(field.parse(` ${SAMPLE_REFERENCE}  `)).toBe(SAMPLE_REFERENCE);
    expect(field.parse('PO-2026-0042')).toBe('PO-2026-0042');
  });

  it.each([...BIDI_CONTROLS.map(([hex, cp]) => [`U+${hex}`, cp] as const), ...OTHER_CONTROLS])(
    'refuses %s, repeating nothing of the input',
    (_label, cp) => {
      const value = `${SAMPLE_REFERENCE.slice(0, 2)}${String.fromCodePoint(cp)}${SAMPLE_REFERENCE.slice(2)}`;
      const result = field.safeParse(value);

      expect(result.success).toBe(false);
      expect(result.error?.issues).toContainEqual(
        expect.objectContaining({ message: 'Contains unsupported characters' }),
      );
      expect(JSON.stringify(result.error?.issues)).not.toContain(SAMPLE_REFERENCE.slice(2));
    },
  );
});
