import {
  checkProcurementThreshold,
  procurementThresholdsSchema,
  type ThresholdPolicy,
} from './procurement-thresholds';

const range = { minAmountMinor: '10', maxAmountMinor: '20', mode: 'REJECT' as const };
const value = { FORMAL_TENDER: range, INQUIRY: range, RFP: range, MARKETPLACE_DEAL: range };
const policy: ThresholdPolicy = { id: 'policy', value };

describe('manual procurement nature thresholds', () => {
  it.each(['10', '20', '15'])('includes amount %s', (amount) => {
    expect(checkProcurementThreshold(policy, 'FORMAL_TENDER', BigInt(amount))).toBe('PASS');
  });
  it.each(['9', '21'])('rejects amount %s outside the range', (amount) => {
    expect(checkProcurementThreshold(policy, 'FORMAL_TENDER', BigInt(amount))).toBe('REJECT');
  });
  it('warns without changing the manual choice', () => {
    const warn: ThresholdPolicy = {
      id: 'warn',
      value: { ...value, INQUIRY: { ...range, mode: 'WARN' } },
    };
    expect(checkProcurementThreshold(warn, 'INQUIRY', 21n)).toBe('WARN');
  });
  it('requires an estimate only with a configured table', () => {
    expect(checkProcurementThreshold(null, 'FORMAL_TENDER', null)).toBe('PASS');
    expect(checkProcurementThreshold(policy, 'FORMAL_TENDER', null)).toBe('ESTIMATE_REQUIRED');
  });
  it('allows unbounded ranges and exact bigint amounts', () => {
    const unbounded = {
      minAmountMinor: '9007199254740993',
      maxAmountMinor: null,
      mode: 'REJECT' as const,
    };
    expect(
      checkProcurementThreshold(
        { id: 'p', value: { ...value, RFP: unbounded } },
        'RFP',
        9007199254740992n,
      ),
    ).toBe('REJECT');
    expect(
      checkProcurementThreshold(
        { id: 'p', value: { ...value, RFP: unbounded } },
        'RFP',
        9007199254740993n,
      ),
    ).toBe('PASS');
  });
  it('rejects partial, inverted, numeric and unknown-mode configuration', () => {
    for (const bad of [
      {},
      { ...value, RFP: { ...range, minAmountMinor: 'bad' } },
      { ...value, RFP: { ...range, minAmountMinor: '21' } },
      { ...value, RFP: { ...range, maxAmountMinor: 20 } },
      { ...value, RFP: { ...range, mode: 'ALLOW' } },
    ])
      expect(procurementThresholdsSchema.safeParse(bad).success).toBe(false);
  });
});
