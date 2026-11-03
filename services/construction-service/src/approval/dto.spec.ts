import { ulid } from 'ulid';
import { hashRequestBody } from '../shared/idempotency';
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
    expect(createPolicySchema.safeParse({ ...POLICY, workflowKey: 'tender.unknown' }).success).toBe(
      false,
    );
    // The three tender gates are workflows of their own (CON-002 PR 11, Q-84).
    for (const workflowKey of ['tender.publication', 'tender.award', 'tender.cancellation']) {
      expect(createPolicySchema.safeParse({ ...POLICY, workflowKey }).success).toBe(true);
    }
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

  it('accepts only platform asset identifiers — never free text', () => {
    const asset = `AST_${ulid()}`;
    expect(
      createProgressSchema.safeParse({ progressBasisPoints: 1, assetsUsed: [asset, 'AST-SEED-01'] })
        .success,
    ).toBe(true);
    for (const bad of ['the grader', 'AST_1', `DRV_${ulid()}`, `ast_${ulid()}`, '', `${asset} `]) {
      expect(
        createProgressSchema.safeParse({ progressBasisPoints: 1, assetsUsed: [bad] }).success,
      ).toBe(false);
    }
  });

  it('refuses a duplicated asset and more than a hundred', () => {
    const asset = `AST_${ulid()}`;
    expect(
      createProgressSchema.safeParse({ progressBasisPoints: 1, assetsUsed: [asset, asset] })
        .success,
    ).toBe(false);
    const many = Array.from({ length: 101 }, () => `AST_${ulid()}`);
    expect(
      createProgressSchema.safeParse({ progressBasisPoints: 1, assetsUsed: many }).success,
    ).toBe(false);
  });
});

/**
 * Task 011 (#385 r2 F1): with both bounds present, the range refinement ran after a bound had
 * failed its pattern — zod runs an object's refinement on a dirty value — and `BigInt('1.5')`
 * threw out of the validation pipe: a 500, with the client's text in the log. The bounds keep
 * their own rule (no leading zeros, nineteen digits, at most a BIGINT); a bound that is not a
 * string of digits is reported by its pattern alone, and the range is compared only between
 * strings of digits, as before.
 */
describe('createPolicy: a malformed amount bound', () => {
  const PATTERN = 'An amount is a non-negative integer string in rial minor units';
  const ORDER = 'minAmountMinor must be less than maxAmountMinor';
  const MAX = '9223372036854775807';

  const issues = (bounds: Record<string, string>) => {
    const parsed = createPolicySchema.safeParse({ ...POLICY, steps: [{ ...STEP, ...bounds }] });
    return parsed.success
      ? []
      : parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
  };

  it.each([
    ['a fraction', '1.5'],
    ['letters', 'abc'],
    ['an exponent', '1e3'],
    ['free text', 'private-invoice-reference-123'],
    ['nothing', ''],
    ['a leading space', ' 1'],
    ['a plus sign', '+1'],
    ['a hexadecimal literal', '0x10'],
    ['a minus sign', '-1'],
  ])('refuses %s as either bound beside a good one, by its pattern alone', (_l, value) => {
    expect(issues({ minAmountMinor: value, maxAmountMinor: '100' })).toEqual([
      `steps.0.minAmountMinor: ${PATTERN}`,
    ]);
    expect(issues({ minAmountMinor: '5', maxAmountMinor: value })).toEqual([
      `steps.0.maxAmountMinor: ${PATTERN}`,
    ]);
    expect(issues({ minAmountMinor: value, maxAmountMinor: value })).toEqual([
      `steps.0.minAmountMinor: ${PATTERN}`,
      `steps.0.maxAmountMinor: ${PATTERN}`,
    ]);
  });

  it.each([
    ['zero with a leading zero', '00'],
    ['one with a leading zero', '01'],
  ])('refuses %s, and still compares it as the digits it is', (_l, value) => {
    expect(issues({ minAmountMinor: value, maxAmountMinor: '100' })).toEqual([
      `steps.0.minAmountMinor: ${PATTERN}`,
    ]);
    expect(issues({ minAmountMinor: '5', maxAmountMinor: value })).toEqual([
      `steps.0.maxAmountMinor: ${PATTERN}`,
      `steps.0.maxAmountMinor: ${ORDER}`,
    ]);
  });

  it('refuses one past a BIGINT and twenty digits as it did, the range compared as digits', () => {
    expect(issues({ minAmountMinor: '9223372036854775808', maxAmountMinor: '100' })).toEqual([
      'steps.0.minAmountMinor: The amount exceeds the largest storable value',
      `steps.0.maxAmountMinor: ${ORDER}`,
    ]);
    expect(issues({ minAmountMinor: '5', maxAmountMinor: '9'.repeat(20) })).toEqual([
      `steps.0.maxAmountMinor: ${PATTERN}`,
      'steps.0.maxAmountMinor: The amount exceeds the largest storable value',
    ]);
  });

  /** The body `zz-pin-recorder` hashed on origin/main before the fix. */
  const HASHED_POLICY = {
    organizationId: 'ORG_A',
    workflowKey: 'project.execution',
    label: 'Council',
    rationale: 'Resolution recorded',
    steps: [
      {
        approvalType: 'Council',
        authorityOrganizationId: 'ORG_A',
        authorityRole: 'ORGANIZATION_ADMIN',
        authorityLabel: 'Council',
      },
    ],
  };

  it.each([
    [{ minAmountMinor: '0' }, '4f27dd180f60c14587b4b166051484ab885dcff5613e601df36e6b1885a3cf2c'],
    [{ maxAmountMinor: '0' }, '98117f88eb70d4e2638425efd1f56b6be9e51a130473215a79d9b98c8d755c47'],
    [{ maxAmountMinor: MAX }, '28b4feee97495763bfc9f813e0cdfc89d0895fdc71630dcf13cdfddbdbbeff14'],
    [
      { minAmountMinor: '0', maxAmountMinor: '100' },
      '04d1f6bbd340fd91030cea6d648674c9cbd63402cb34c37c5ffc79024f793d4c',
    ],
    [
      { minAmountMinor: '5', maxAmountMinor: MAX },
      '52ac88bd1e1da8a6af6255e7c2f08904d28c5920ad560e4ffd64f847dd43f7d5',
    ],
  ])('accepts %j byte-for-byte, with the idempotency hash it had', (bounds, hash) => {
    const body = { ...HASHED_POLICY, steps: [{ ...HASHED_POLICY.steps[0], ...bounds }] };
    const parsed = createPolicySchema.parse(body);
    expect(parsed.steps[0]).toEqual(body.steps[0]);
    expect(hashRequestBody(parsed)).toBe(hash);
  });
});
