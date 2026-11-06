import { recordUsageSchema } from './dto';

const VALID = {
  assetId: 'AST-UNIT',
  periodStart: '2000-01-01T00:00:00.000Z',
  periodEnd: '2100-01-01T00:00:00.000Z',
  hours: '1',
};

describe.each(['periodStart', 'periodEnd'] as const)('usage instant %s', (field) => {
  it.each([
    '2026-09-15T12:00:00Z',
    '2026-09-15T12:00Z',
    '2026-09-15T12:00:00.123456Z',
    '2024-02-29T12:00:00Z',
  ])('preserves the canonical Date instant for %s', (value) => {
    const parsed = recordUsageSchema.parse({ ...VALID, [field]: value });
    expect(parsed[field]).toBe(new Date(value).toISOString());
  });

  it.each([
    'yesterday',
    '',
    '2026-02-29T12:00:00Z',
    '2026-09-15T12:00:00',
    '2026-09-15',
    '2026-09-15T12:00:00+00:00',
    '2026-09-15T12:00:00+03:30',
    '2026-09-15T12:00:00+0330',
    '2026-09-15T12:00:00+24:00',
    '2026-09-15T12:00:60Z',
    '2026-09-15T12:00:00Z ',
    null,
    undefined,
    0,
    true,
    [],
    {},
    new Date('2026-09-15T12:00:00Z'),
  ])('refuses an invalid UTC timestamp (%p) before conversion', (value) => {
    expect(recordUsageSchema.safeParse({ ...VALID, [field]: value }).success).toBe(false);
  });
});
