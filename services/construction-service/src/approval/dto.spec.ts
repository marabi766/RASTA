import { createPolicySchema, decisionSchema, inboxQuerySchema } from './dto';
import { createProgressSchema } from '../progress/dto';

const STEP = {
  approvalType: 'Council approval',
  authorityOrganizationId: 'ORG_COUNCIL',
  authorityRole: 'ORGANIZATION_ADMIN',
  authorityLabel: 'Village council',
};

const POLICY = {
  organizationId: 'ORG_DEH_1',
  workflowKey: 'project.execution',
  label: 'Execution approvals',
  rationale: 'As resolved by the council',
  steps: [STEP],
};

describe('createPolicy', () => {
  it('accepts a policy and defaults isSample to false', () => {
    expect(createPolicySchema.parse(POLICY).isSample).toBe(false);
  });

  it('never accepts the oversight role as an authority', () => {
    expect(
      createPolicySchema.safeParse({ ...POLICY, steps: [{ ...STEP, authorityRole: 'AUDITOR' }] })
        .success,
    ).toBe(false);
  });

  it('refuses an unknown role, an unknown workflow, and an empty step list', () => {
    expect(
      createPolicySchema.safeParse({ ...POLICY, steps: [{ ...STEP, authorityRole: 'MAYOR' }] })
        .success,
    ).toBe(false);
    expect(createPolicySchema.safeParse({ ...POLICY, workflowKey: 'tender.award' }).success).toBe(
      false,
    );
    expect(createPolicySchema.safeParse({ ...POLICY, steps: [] }).success).toBe(false);
  });

  it('refuses an empty or inverted amount range', () => {
    for (const range of [
      { minAmountMinor: '100', maxAmountMinor: '100' },
      { minAmountMinor: '200', maxAmountMinor: '100' },
    ]) {
      expect(
        createPolicySchema.safeParse({ ...POLICY, steps: [{ ...STEP, ...range }] }).success,
      ).toBe(false);
    }
    expect(
      createPolicySchema.safeParse({
        ...POLICY,
        steps: [{ ...STEP, minAmountMinor: '100', maxAmountMinor: '101' }],
      }).success,
    ).toBe(true);
  });

  it('refuses a status, an author, and a policy that names no governed organization', () => {
    expect(createPolicySchema.safeParse({ ...POLICY, status: 'ACTIVE' }).success).toBe(false);
    expect(createPolicySchema.safeParse({ ...POLICY, authorOrganizationId: 'ORG_X' }).success).toBe(
      false,
    );
    const { organizationId: _o, ...withoutTarget } = POLICY;
    expect(createPolicySchema.safeParse(withoutTarget).success).toBe(false);
  });

  it('requires a rationale somebody can read later', () => {
    expect(createPolicySchema.safeParse({ ...POLICY, rationale: 'short' }).success).toBe(false);
  });
});

describe('decision', () => {
  it('accepts a grant with a number and conditions', () => {
    expect(
      decisionSchema.safeParse({
        expectedVersion: 1,
        decision: 'GRANT',
        decisionNumber: '12',
        conditions: 'Daylight only',
      }).success,
    ).toBe(true);
  });

  it('requires a rejection to state its reason, and keeps conditions to grants', () => {
    expect(decisionSchema.safeParse({ expectedVersion: 1, decision: 'REJECT' }).success).toBe(
      false,
    );
    expect(
      decisionSchema.safeParse({
        expectedVersion: 1,
        decision: 'REJECT',
        reason: 'Not itemised enough',
        conditions: 'x',
      }).success,
    ).toBe(false);
    expect(
      decisionSchema.safeParse({
        expectedVersion: 1,
        decision: 'GRANT',
        reason: 'Looks fine to me',
      }).success,
    ).toBe(false);
  });

  it('refuses any decision word but GRANT and REJECT — there is no automatic approval', () => {
    expect(decisionSchema.safeParse({ expectedVersion: 1, decision: 'AUTO_APPROVE' }).success).toBe(
      false,
    );
  });

  it('defaults the inbox to PENDING', () => {
    expect(inboxQuerySchema.parse({}).status).toBe('PENDING');
  });
});

describe('progress', () => {
  it('accepts basis points from 0 to 10000 only, as integers', () => {
    for (const value of [0, 5000, 10_000]) {
      expect(createProgressSchema.safeParse({ progressBasisPoints: value }).success).toBe(true);
    }
    for (const value of [-1, 10_001, 50.5]) {
      expect(createProgressSchema.safeParse({ progressBasisPoints: value }).success).toBe(false);
    }
  });

  it('refuses a duplicated asset and more than a hundred', () => {
    expect(
      createProgressSchema.safeParse({ progressBasisPoints: 1, assetsUsed: ['AST_1', 'AST_1'] })
        .success,
    ).toBe(false);
    const many = Array.from({ length: 101 }, (_, i) => `AST_${i}`);
    expect(
      createProgressSchema.safeParse({ progressBasisPoints: 1, assetsUsed: many }).success,
    ).toBe(false);
  });
});
