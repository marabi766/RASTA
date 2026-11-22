import { canonicalDeductionRuleName } from './deduction-rule-name';
import { proposeDeductionSchema, storageText } from './dto';

const create = { kind: 'CREATE', name: 'Tax A', rateBp: 500, base: 'GROSS' };
const retire = { kind: 'RETIRE', deductionRuleId: 'DDR_1', reason: 'به دلیل تغییر' };
describe('deduction proposal input boundary', () => {
  it('uses the existing name normalization without changing its key semantics', () => {
    const parsed = proposeDeductionSchema.parse({ ...create, name: '  Tax\tA  ' });
    expect(parsed.kind === 'CREATE' && canonicalDeductionRuleName(parsed.name)).toBe(create.name);
  });
  it.each([0, 10001, 1.5, '500'])('refuses invalid rate %s', (rateBp) => {
    expect(proposeDeductionSchema.safeParse({ ...create, rateBp }).success).toBe(false);
  });
  it.each(['organizationId', 'proposedBy', 'status', 'version', 'approver'])(
    'refuses authority field %s',
    (field) => {
      expect(proposeDeductionSchema.safeParse({ ...create, [field]: 'untrusted' }).success).toBe(
        false,
      );
    },
  );
  it('accepts rate/name/reason boundaries by Unicode code points', () => {
    expect(
      proposeDeductionSchema.safeParse({ ...create, rateBp: 1, name: 'A'.repeat(200) }).success,
    ).toBe(true);
    expect(proposeDeductionSchema.safeParse({ ...create, rateBp: 10000 }).success).toBe(true);
    expect(proposeDeductionSchema.safeParse({ ...retire, reason: '😀'.repeat(500) }).success).toBe(
      true,
    );
    expect(proposeDeductionSchema.safeParse({ ...retire, reason: '😀'.repeat(501) }).success).toBe(
      false,
    );
  });
  it.each(['', 'A'.repeat(201), 'a\u202eb', 'a\u0000b', 'a\ud800b'])(
    'refuses invalid names without replacement',
    (name) => {
      expect(proposeDeductionSchema.safeParse({ ...create, name }).success).toBe(false);
    },
  );
  it.each(['', ' ', 'a\u202eb', 'a\u0000b', 'a\udc00b'])(
    'refuses invalid reasons without replacement',
    (reason) => {
      expect(proposeDeductionSchema.safeParse({ ...retire, reason }).success).toBe(false);
    },
  );
  it.each(['', 'x'.repeat(129), 'a\u0000b', 'a\ud800b'])(
    'refuses invalid rule IDs',
    (deductionRuleId) => {
      expect(proposeDeductionSchema.safeParse({ ...retire, deductionRuleId }).success).toBe(false);
    },
  );
  it('refuses variant mixing and other bases', () => {
    expect(proposeDeductionSchema.safeParse({ ...create, base: 'NET' }).success).toBe(false);
    expect(proposeDeductionSchema.safeParse({ ...retire, rateBp: 1 }).success).toBe(false);
  });
  it('permits Unicode IDs and well-formed supplementary characters', () => {
    expect(
      proposeDeductionSchema.safeParse({ ...retire, deductionRuleId: 'شناسه😀' }).success,
    ).toBe(true);
    expect(storageText('😀')).toBe(true);
  });
});
