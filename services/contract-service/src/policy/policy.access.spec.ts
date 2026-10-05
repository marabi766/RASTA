import { runWithContext, type RequestContext } from '@rasta/nest-common';
import type { ContractEnv } from '../config/env';
import { PolicyAccess, signingRoleUnder } from './policy.access';

const env = { CONTRACT_READER_ROLES: ['ORGANIZATION_ADMIN'] } as unknown as ContractEnv;
const access = new PolicyAccess(env);

const policy = { id: 'APL_1', organizationId: 'ORG_EMPLOYER', authorOrganizationId: 'ORG_UNION' };

function as<T>(overrides: Partial<RequestContext>, fn: () => T): T {
  return runWithContext(
    {
      requestId: 'r',
      correlationId: 'c',
      authType: 'USER',
      roles: [],
      startedAt: Date.now(),
      ...overrides,
    } as RequestContext,
    fn,
  );
}

const union = { organizationId: 'ORG_UNION', userId: 'USR_U', roles: ['UNION_ADMIN'] };
const platform = { organizationId: 'ORG_PLATFORM', userId: 'USR_P', roles: ['SYSTEM_ADMIN'] };
const employer = { organizationId: 'ORG_EMPLOYER', userId: 'USR_E', roles: ['ORGANIZATION_ADMIN'] };

describe('who writes, approves, retires and reads an approval policy (Q-70 (7))', () => {
  describe('writing', () => {
    it('a union administrator or the platform administrator writes; the role is the one held', () => {
      expect(as(union, () => access.assertPolicyAuthor())).toEqual({
        organizationId: 'ORG_UNION',
        actor: 'USR_U',
        role: 'UNION_ADMIN',
      });
      expect(as(platform, () => access.assertPolicyAuthor()).role).toBe('SYSTEM_ADMIN');
      // Holding both, the platform's authority is the one exercised.
      expect(
        as({ ...platform, roles: ['UNION_ADMIN', 'SYSTEM_ADMIN'] }, () =>
          access.assertPolicyAuthor(),
        ).role,
      ).toBe('SYSTEM_ADMIN');
    });

    it('an organization administrator never writes its own policy', () => {
      expect(() => as(employer, () => access.assertPolicyAuthor())).toThrow(
        /do not have permission/i,
      );
    });

    it('is refused without an organization to act for, and without an actor', () => {
      expect(() =>
        as({ ...platform, organizationId: undefined as unknown as string }, () =>
          access.assertPolicyAuthor(),
        ),
      ).toThrow(/Select an organization/);
      expect(() =>
        as({ ...union, userId: undefined as unknown as string }, () => access.assertPolicyAuthor()),
      ).toThrow(/records an actor/);
    });

    it('is refused to the oversight role and to a service', () => {
      expect(() =>
        as({ ...union, roles: ['AUDITOR', 'UNION_ADMIN'] }, () => access.assertPolicyAuthor()),
      ).toThrow();
      expect(() =>
        as({ ...union, authType: 'SERVICE' }, () => access.assertPolicyAuthor()),
      ).toThrow();
    });
  });

  describe('the platform approval', () => {
    it('is the platform administrator, with an actor', () => {
      expect(as(platform, () => access.assertPlatformAdministrator())).toEqual({ actor: 'USR_P' });
    });

    it('is nobody else, not the oversight role, not a service, not an anonymous administrator', () => {
      expect(() => as(union, () => access.assertPlatformAdministrator())).toThrow(
        /do not have permission/i,
      );
      expect(() =>
        as({ ...platform, roles: ['AUDITOR', 'SYSTEM_ADMIN'] }, () =>
          access.assertPlatformAdministrator(),
        ),
      ).toThrow();
      expect(() =>
        as({ ...platform, authType: 'SERVICE' }, () => access.assertPlatformAdministrator()),
      ).toThrow();
      expect(() =>
        as({ ...platform, userId: undefined as unknown as string }, () =>
          access.assertPlatformAdministrator(),
        ),
      ).toThrow(/records an actor/);
    });
  });

  describe('reading', () => {
    it('lists for the readers of an organization and for its union', () => {
      expect(as(employer, () => access.assertCanListPolicies())).toEqual({
        organizationId: 'ORG_EMPLOYER',
      });
      expect(as(union, () => access.assertCanListPolicies())).toEqual({
        organizationId: 'ORG_UNION',
      });
      expect(() =>
        as({ ...employer, roles: ['CONTRACTOR'] }, () => access.assertCanListPolicies()),
      ).toThrow();
    });

    it.each([
      ['the platform administrator', platform, true],
      ['the author’s union', union, true],
      ['the governed organization’s reader', employer, true],
      ['a union of another organization', { ...union, organizationId: 'ORG_OTHER' }, false],
      [
        'the governed organization’s contractor role',
        { ...employer, roles: ['CONTRACTOR'] },
        false,
      ],
      ['another organization’s reader', { ...employer, organizationId: 'ORG_OTHER' }, false],
      ['the oversight role', { ...employer, roles: ['AUDITOR'] }, false],
      ['a service', { ...employer, authType: 'SERVICE' as const }, false],
    ])('%s sees a policy: %s', (_label, caller, sees) => {
      expect(as(caller, () => access.canSeePolicy(policy))).toBe(sees);
    });

    it('a policy that may not be seen is 404, never 403', () => {
      expect(() =>
        as({ ...employer, organizationId: 'ORG_OTHER' }, () => access.assertCanSeePolicy(policy)),
      ).toThrow(/not found/i);
      expect(() => as(employer, () => access.assertCanSeePolicy(policy))).not.toThrow();
    });
  });

  describe('submitting and retiring', () => {
    it('only the organization that wrote the policy submits it', () => {
      expect(as(union, () => access.assertCanSubmitPolicy(policy))).toEqual({
        actor: 'USR_U',
        role: 'UNION_ADMIN',
      });
      // A platform administrator sees every policy but submits only its own organization's.
      expect(() => as(platform, () => access.assertCanSubmitPolicy(policy))).toThrow(
        /Only the organization that wrote this policy may submit it/,
      );
      expect(() =>
        as({ ...union, organizationId: 'ORG_OTHER' }, () => access.assertCanSubmitPolicy(policy)),
      ).toThrow(/not found/i);
    });

    it('the platform retires any; a union retires only its own; the organization retires none', () => {
      expect(as(platform, () => access.assertCanRetirePolicy(policy))).toEqual({ actor: 'USR_P' });
      expect(as(union, () => access.assertCanRetirePolicy(policy))).toEqual({ actor: 'USR_U' });
      expect(() =>
        as({ ...union, organizationId: 'ORG_UNION_2' }, () => access.assertCanRetirePolicy(policy)),
      ).toThrow(/not found/i);
      expect(() => as(employer, () => access.assertCanRetirePolicy(policy))).toThrow(
        /do not have permission/i,
      );
      expect(() =>
        as(union, () =>
          access.assertCanRetirePolicy({ ...policy, authorOrganizationId: 'ORG_UNION_2' }),
        ),
      ).toThrow(/not found/i);
    });

    it('a visible policy of another author organization is told why (403)', () => {
      // The employer's own union administrator (author org ≠ policy's author org) who can see it.
      const sibling = {
        ...union,
        organizationId: 'ORG_EMPLOYER',
        roles: ['ORGANIZATION_ADMIN', 'UNION_ADMIN'],
      };
      expect(() => as(sibling, () => access.assertCanRetirePolicy(policy))).toThrow(
        /Only the organization that wrote this policy may retire it/,
      );
    });
  });
});

describe('the role a signature is accepted under (signingRoleUnder)', () => {
  const governing = {
    organizationId: 'ORG_EMPLOYER',
    steps: [
      { authorityOrganizationId: 'ORG_EMPLOYER', authorityRole: 'FLEET_MANAGER' },
      { authorityOrganizationId: 'ORG_EMPLOYER', authorityRole: 'ORGANIZATION_ADMIN' },
    ],
  };

  it('is the first role of the policy, in its order, that the caller holds', () => {
    expect(signingRoleUnder(governing, ['ORGANIZATION_ADMIN', 'FLEET_MANAGER'])).toBe(
      'FLEET_MANAGER',
    );
    expect(signingRoleUnder(governing, ['ORGANIZATION_ADMIN'])).toBe('ORGANIZATION_ADMIN');
  });

  it('is nothing when the caller holds none of them', () => {
    expect(signingRoleUnder(governing, ['DRIVER', 'CONTRACTOR'])).toBeUndefined();
    expect(
      signingRoleUnder({ organizationId: 'ORG_EMPLOYER', steps: [] }, ['ORGANIZATION_ADMIN']),
    ).toBeUndefined();
  });

  it('counts a step only if it names a role of the organization the policy governs', () => {
    const foreign = {
      organizationId: 'ORG_EMPLOYER',
      steps: [{ authorityOrganizationId: 'ORG_ELSEWHERE', authorityRole: 'ORGANIZATION_ADMIN' }],
    };
    expect(signingRoleUnder(foreign, ['ORGANIZATION_ADMIN'])).toBeUndefined();
  });
});
