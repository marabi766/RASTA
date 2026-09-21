import { RastaError, runWithContext, type RequestContext } from '@rasta/nest-common';
import {
  assertMayDecideClaim,
  assertWithinApprovalCeiling,
  type ClaimAuthority,
} from './claim-access';

/**
 * Who may decide a claim comes from configuration (docs/24 Q-59). These tests
 * pin the direction of the rule: narrowing, never widening.
 */

const authority: ClaimAuthority = {
  decisionRoles: ['ORGANIZATION_ADMIN', 'UNION_ADMIN'],
  approvalCeilingMinor: null,
};

function context(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    correlationId: 'corr-sample',
    requestId: 'req-sample',
    organizationId: 'ORG-DEH-0001',
    userId: 'USR-SEED-DEHYARI-ADMIN',
    roles: ['ORGANIZATION_ADMIN'],
    authType: 'USER',
    startedAt: 0,
    ...overrides,
  };
}

const as = (overrides: Partial<RequestContext>, fn: () => void) =>
  runWithContext(context(overrides), async () => fn());

describe('claim decision authority', () => {
  it('admits a user holding one of the configured roles', async () => {
    await expect(
      as({ roles: ['UNION_ADMIN'] }, () => assertMayDecideClaim(authority)),
    ).resolves.toBeUndefined();
  });

  it('refuses the role that files claims when it is not configured to decide them', async () => {
    // The fleet manager who reports the loss must not be the one who approves
    // paying for it, unless the deployment says so explicitly.
    await expect(
      as({ roles: ['FLEET_MANAGER'] }, () => assertMayDecideClaim(authority)),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_ROLE' });
  });

  it('admits the same role once configuration names it', async () => {
    const widened: ClaimAuthority = { ...authority, decisionRoles: ['FLEET_MANAGER'] };
    await expect(
      as({ roles: ['FLEET_MANAGER'] }, () => assertMayDecideClaim(widened)),
    ).resolves.toBeUndefined();
  });

  it('honours SYSTEM_ADMIN as every other role check does', async () => {
    await expect(
      as({ roles: ['SYSTEM_ADMIN'] }, () => assertMayDecideClaim(authority)),
    ).resolves.toBeUndefined();
  });

  it('refuses a caller that is not a user, whatever roles it carries', async () => {
    await expect(
      as({ authType: 'SERVICE', roles: ['ORGANIZATION_ADMIN'] }, () =>
        assertMayDecideClaim(authority),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('refuses a user with no roles at all', async () => {
    await expect(as({ roles: [] }, () => assertMayDecideClaim(authority))).rejects.toBeInstanceOf(
      RastaError,
    );
  });
});

describe('approval ceiling', () => {
  const capped: ClaimAuthority = { ...authority, approvalCeilingMinor: 500_000_000n };

  it('is not applied when no ceiling is configured', () => {
    expect(() => assertWithinApprovalCeiling(authority, 10n ** 20n)).not.toThrow();
  });

  it('admits an amount at the ceiling and refuses one above it', () => {
    expect(() => assertWithinApprovalCeiling(capped, 500_000_000n)).not.toThrow();
    expect(() => assertWithinApprovalCeiling(capped, 500_000_001n)).toThrow(/above the ceiling/);
  });

  it('reports a business-rule violation, and names the rule for the log only', () => {
    try {
      assertWithinApprovalCeiling(capped, 1_000_000_000n);
      throw new Error('expected a refusal');
    } catch (error) {
      const refusal = error as RastaError;
      expect(refusal.code).toBe('BUSINESS_RULE_VIOLATION');
      expect(refusal.internalContext).toMatchObject({ rule: 'CLAIM_APPROVAL_ABOVE_CEILING' });
      // The ceiling is deployment configuration; it is not for the response body.
      expect(refusal.details).toBeUndefined();
    }
  });

  it('lets an approval without an amount through — there is nothing to compare', () => {
    expect(() => assertWithinApprovalCeiling(capped, null)).not.toThrow();
  });
});
