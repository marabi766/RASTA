import {
  snapshotChains,
  stepApplies,
  type ChainPolicy,
  type ChainPolicyStep,
} from './approval-chains';

const step = (stepOrder: number, overrides: Partial<ChainPolicyStep> = {}): ChainPolicyStep => ({
  stepOrder,
  authorityOrganizationId: 'ORG_OWNER',
  authorityRole: 'ORGANIZATION_ADMIN',
  authorityLabel: `Step ${stepOrder}`,
  minAmountMinor: null,
  maxAmountMinor: null,
  ...overrides,
});

const policy = (id: string, steps: ChainPolicyStep[]): ChainPolicy => ({
  id,
  policyVersion: 3,
  steps,
});

describe('which policy steps apply to a statement (Q-70 (3), Q-134)', () => {
  it('applies a step with neither bound to every gross', () => {
    expect(stepApplies(step(1), 1n)).toBe(true);
    expect(stepApplies(step(1), 9_223_372_036_854_775_807n)).toBe(true);
  });

  it('takes the minimum inclusive and the maximum exclusive', () => {
    const bounded = step(1, { minAmountMinor: 100n, maxAmountMinor: 200n });
    expect([99n, 100n, 199n, 200n].map((gross) => stepApplies(bounded, gross))).toEqual([
      false,
      true,
      true,
      false,
    ]);
    expect(stepApplies(step(1, { minAmountMinor: 100n }), 100n)).toBe(true);
    expect(stepApplies(step(1, { maxAmountMinor: 100n }), 100n)).toBe(false);
  });
});

describe('the two chains of a statement, snapshotted at submission (ADR-068 § 5, Q-96 (1))', () => {
  const technical = policy('APL_T', [
    step(2, { authorityOrganizationId: 'ORG_CONSULTANT', authorityRole: 'ORGANIZATION_ADMIN' }),
    step(1),
  ]);
  const financial = policy('APL_F', [step(1, { authorityRole: 'UNION_ADMIN' })]);

  it('is every applicable step of each policy, in the policy’s order, with its id and version', () => {
    const snapshot = snapshotChains(
      { TECHNICAL: technical, FINANCIAL: financial },
      500n,
      'ORG_WIN',
    );
    expect(snapshot).toEqual({
      ok: true,
      chains: {
        TECHNICAL: { policyId: 'APL_T', policyVersion: 3, steps: [step(1), technical.steps[0]] },
        FINANCIAL: { policyId: 'APL_F', policyVersion: 3, steps: [financial.steps[0]] },
      },
    });
  });

  it('leaves out a step that does not apply to the gross, and keeps the others', () => {
    const banded = policy('APL_T', [
      step(1),
      step(2, { minAmountMinor: 1_000n }),
      step(3, { maxAmountMinor: 1_000n }),
    ]);
    const small = snapshotChains({ TECHNICAL: banded, FINANCIAL: financial }, 999n, 'ORG_WIN');
    const large = snapshotChains({ TECHNICAL: banded, FINANCIAL: financial }, 1_000n, 'ORG_WIN');
    expect(small.ok && small.chains.TECHNICAL.steps.map((s) => s.stepOrder)).toEqual([1, 3]);
    expect(large.ok && large.chains.TECHNICAL.steps.map((s) => s.stepOrder)).toEqual([1, 2]);
  });

  it('refuses for each missing policy, technical first: never a default approval', () => {
    expect(snapshotChains({ TECHNICAL: null, FINANCIAL: null }, 1n, 'ORG_WIN')).toEqual({
      ok: false,
      refusals: ['TECHNICAL_POLICY_REQUIRED', 'FINANCIAL_POLICY_REQUIRED'],
    });
    expect(snapshotChains({ TECHNICAL: technical, FINANCIAL: null }, 1n, 'ORG_WIN')).toEqual({
      ok: false,
      refusals: ['FINANCIAL_POLICY_REQUIRED'],
    });
  });

  it('refuses a chain none of whose steps applies to the gross', () => {
    const above = policy('APL_F', [step(1, { minAmountMinor: 1_000n })]);
    expect(snapshotChains({ TECHNICAL: technical, FINANCIAL: above }, 999n, 'ORG_WIN')).toEqual({
      ok: false,
      refusals: ['FINANCIAL_STEP_NOT_APPLICABLE'],
    });
    expect(snapshotChains({ TECHNICAL: above, FINANCIAL: above }, 1n, 'ORG_WIN')).toEqual({
      ok: false,
      refusals: ['TECHNICAL_STEP_NOT_APPLICABLE', 'FINANCIAL_STEP_NOT_APPLICABLE'],
    });
  });

  it('refuses when a step that applies names the contractor — never drops it from the chain', () => {
    const consultantIsContractor = snapshotChains(
      { TECHNICAL: technical, FINANCIAL: financial },
      500n,
      'ORG_CONSULTANT',
    );
    expect(consultantIsContractor).toEqual({
      ok: false,
      refusals: ['APPROVAL_STEP_NAMES_CONTRACTOR'],
    });
    // A step naming the contractor that does not apply to this gross refuses nothing.
    const banded = policy('APL_T', [
      step(1),
      step(2, { authorityOrganizationId: 'ORG_WIN', minAmountMinor: 1_000n }),
    ]);
    expect(snapshotChains({ TECHNICAL: banded, FINANCIAL: financial }, 999n, 'ORG_WIN').ok).toBe(
      true,
    );
    expect(snapshotChains({ TECHNICAL: banded, FINANCIAL: financial }, 1_000n, 'ORG_WIN')).toEqual({
      ok: false,
      refusals: ['APPROVAL_STEP_NAMES_CONTRACTOR'],
    });
  });
});
