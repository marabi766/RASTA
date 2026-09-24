import { runWithContext, type RequestContext } from '@rasta/nest-common';
import { DEFAULT_PROVISIONING_SCOPE_POLICY, isWithinProvisioningScope } from './provisioning-scope';

const ORG_A = 'ORG_A';

function context(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    correlationId: 'CORR_1',
    requestId: 'REQ_1',
    organizationId: ORG_A,
    userId: 'USR_1',
    roles: ['ORGANIZATION_ADMIN'],
    organizationIds: [],
    authType: 'USER',
    startedAt: 0,
    ...overrides,
  };
}

describe('isWithinProvisioningScope', () => {
  it('fails closed for a SERVICE caller, even one carrying a cross-org role', () => {
    // Unreachable today — the routes that call this are `@Roles`-guarded with
    // no `@AllowService` — but the helper itself must not silently agree with
    // a non-user caller just because it happens to carry the right role.
    const result = runWithContext(
      context({ authType: 'SERVICE', roles: ['SYSTEM_ADMIN'], organizationId: undefined }),
      () => isWithinProvisioningScope(ORG_A, DEFAULT_PROVISIONING_SCOPE_POLICY),
    );

    expect(result).toBe(false);
  });

  it('accepts a USER caller acting for the named organization', () => {
    const result = runWithContext(context({ organizationId: ORG_A }), () =>
      isWithinProvisioningScope(ORG_A, DEFAULT_PROVISIONING_SCOPE_POLICY),
    );

    expect(result).toBe(true);
  });

  it('accepts a USER caller with a cross-org role naming a different organization', () => {
    const result = runWithContext(
      context({ roles: ['SYSTEM_ADMIN'], organizationId: 'ORG_B' }),
      () => isWithinProvisioningScope(ORG_A, DEFAULT_PROVISIONING_SCOPE_POLICY),
    );

    expect(result).toBe(true);
  });

  it('refuses a USER caller naming an organization they have no authority over', () => {
    const result = runWithContext(context({ organizationId: 'ORG_B' }), () =>
      isWithinProvisioningScope(ORG_A, DEFAULT_PROVISIONING_SCOPE_POLICY),
    );

    expect(result).toBe(false);
  });
});
