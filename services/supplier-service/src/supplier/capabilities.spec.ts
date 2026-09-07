import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CAPABILITY_ROLE_HINT, isSupplierCapability, SUPPLIER_CAPABILITIES } from './capabilities';

/**
 * The bounded capability vocabulary.
 *
 * The TypeScript enum and the PostgreSQL enum have to agree, or a value the DTO
 * accepts is refused by the database at write time — a 500 on a request that
 * looked entirely valid. So this compares the two rather than asserting one.
 */

const SCHEMA = readFileSync(join(__dirname, '..', '..', 'prisma', 'schema.prisma'), 'utf8');

function prismaEnumMembers(name: string): string[] {
  const match = new RegExp(`^enum\\s+${name}\\s*\\{([\\s\\S]*?)^\\}`, 'm').exec(SCHEMA);
  if (!match) return [];

  return (match[1] as string)
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, '').trim())
    .filter((line) => /^[A-Z][A-Z_]*$/.test(line));
}

describe('the vocabulary', () => {
  it('is the three counterparty kinds the product document names', () => {
    // docs/04 § 4.10: "تأمین‌کنندگان، تعمیرگاه‌ها و پیمانکاران". docs/09 § 9.3
    // gives a Supplier Org exactly three roles, one per kind.
    expect([...SUPPLIER_CAPABILITIES]).toEqual(['GOODS_SUPPLY', 'WORKSHOP_SERVICE', 'CONTRACTING']);
  });

  it('is not a taxonomy of what a supplier sells', () => {
    // "Tyres", "asphalt", "crane hire" are catalogue facts owned by marketplace
    // and procurement. A second copy here would be a second authority for one
    // fact, and the first disagreement between them would be silent.
    expect(SUPPLIER_CAPABILITIES).toHaveLength(3);
  });

  it('matches the PostgreSQL enum exactly', () => {
    // A value the DTO accepts and the database refuses is a 500 on a request
    // that looked entirely valid.
    expect(prismaEnumMembers('SupplierCapabilityKind')).toEqual([...SUPPLIER_CAPABILITIES]);
  });
});

describe('the type guard', () => {
  it.each(SUPPLIER_CAPABILITIES)('accepts %s', (value) => {
    expect(isSupplierCapability(value)).toBe(true);
  });

  it.each(['HAULAGE', 'goods_supply', '', 'CONTRACTING ', null, undefined, 7, {}])(
    'refuses %p',
    (value) => {
      expect(isSupplierCapability(value)).toBe(false);
    },
  );
});

describe('the role hint is documentation, not a rule', () => {
  it('names a role for each capability', () => {
    expect(Object.keys(CAPABILITY_ROLE_HINT).sort()).toEqual([...SUPPLIER_CAPABILITIES].sort());
    expect(CAPABILITY_ROLE_HINT.WORKSHOP_SERVICE).toBe('WORKSHOP');
  });

  it('is not imported by the authorization layer', () => {
    // Wiring it into a guard would invent a restriction no document states:
    // docs/09 gives ORGANIZATION_ADMIN everything within its own organization,
    // and one organization may legitimately be all three kinds at once.
    const access = readFileSync(join(__dirname, '..', 'access', 'access.ts'), 'utf8');

    expect(access).not.toMatch(/CAPABILITY_ROLE_HINT/);
  });
});
