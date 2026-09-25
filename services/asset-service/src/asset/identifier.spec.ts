import { canonicalIdentifier } from './identifier';
import { createAssetSchema, createPolicySchema } from './dto';

/**
 * The spelling a uniqueness check compares (audit L3-10).
 *
 * Each case below is two strings that a person reads as the same identifier.
 * Before canonicalisation they are different byte sequences, so the database
 * would have stored both.
 */
describe('canonicalIdentifier', () => {
  it.each([
    ['Arabic yeh', 'ماشين-1', 'ماشین-1'],
    ['Arabic alef maksura', 'ماشىن-1', 'ماشین-1'],
    ['Arabic kaf', 'كامیون', 'کامیون'],
    ['Persian digits', 'ت-۱۲۳', 'ت-123'],
    ['Arabic-Indic digits', 'ت-١٢٣', 'ت-123'],
    ['tatweel', 'کامـیون', 'کامیون'],
    ['a run of spaces', '  ب  ۱۲  ', 'ب 12'],
  ])('folds %s into the canonical spelling', (_name, variant, canonical) => {
    expect(canonicalIdentifier(variant)).toBe(canonical);
  });

  it('keeps a canonical value unchanged', () => {
    expect(canonicalIdentifier('D1-TRK-001')).toBe('D1-TRK-001');
  });

  it('keeps Latin case and the zero-width non-joiner, which may be meant', () => {
    expect(canonicalIdentifier('ab‌C')).toBe('ab‌C');
  });
});

describe('the input boundary', () => {
  it('stores an asset tag and serial number in canonical form', () => {
    const parsed = createAssetSchema.parse({
      name: 'لودر',
      type: 'LOADER',
      assetTag: 'ماشين-۱',
      serialNumber: 'VIN-٤٥٦',
    });

    expect(parsed.assetTag).toBe('ماشین-1');
    expect(parsed.serialNumber).toBe('VIN-456');
  });

  it('stores a policy number and insurer name in canonical form', () => {
    const parsed = createPolicySchema.parse({
      policyNumber: 'بيمه-۷۸۹',
      insurerName: 'بيمه ايران',
      coverage: 'THIRD_PARTY',
      validFrom: '2026-01-01T00:00:00.000Z',
      validTo: '2027-01-01T00:00:00.000Z',
    });

    expect(parsed.policyNumber).toBe('بیمه-789');
    expect(parsed.insurerName).toBe('بیمه ایران');
  });

  it('checks the length after canonicalising, so tatweel cannot pad a value past the minimum', () => {
    expect(() =>
      createAssetSchema.parse({ name: 'لودر', type: 'LOADER', serialNumber: 'ـــa' }),
    ).toThrow();
  });
});
