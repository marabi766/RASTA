import { RastaError, runWithContext, type RequestContext } from '@rasta/nest-common';
import { resolveActor } from './access';

function context(overrides: Partial<RequestContext>): RequestContext {
  return {
    correlationId: 'COR',
    requestId: 'REQ',
    roles: [],
    organizationIds: [],
    authType: 'USER',
    startedAt: 0,
    ...overrides,
  };
}

describe('resolveActor', () => {
  it('returns the verified user and active organization', () => {
    const actor = runWithContext(
      context({ userId: 'USR_1', organizationId: 'ORG_A', organizationIds: ['ORG_A', 'ORG_B'] }),
      () => resolveActor(),
    );
    expect(actor).toEqual({ userId: 'USR_1', organizationId: 'ORG_A' });
  });

  it('lets an AUDITOR read their own inbox like anybody else', () => {
    const actor = runWithContext(
      context({ userId: 'USR_AUD', organizationId: 'ORG_A', roles: ['AUDITOR'] }),
      () => resolveActor(),
    );
    expect(actor.userId).toBe('USR_AUD');
  });

  it('refuses a service token with 403 — a service has no inbox', () => {
    expect(() =>
      runWithContext(
        context({
          authType: 'SERVICE',
          callerService: 'marketplace-service',
          organizationId: 'ORG_A',
        }),
        () => resolveActor(),
      ),
    ).toThrow(RastaError);
    try {
      runWithContext(context({ authType: 'SERVICE', organizationId: 'ORG_A' }), () =>
        resolveActor(),
      );
    } catch (error) {
      expect((error as RastaError).code).toBe('FORBIDDEN');
    }
  });

  it('refuses a user with no active organization with 403, not a 500', () => {
    try {
      runWithContext(context({ userId: 'USR_1' }), () => resolveActor());
      throw new Error('expected a refusal');
    } catch (error) {
      expect((error as RastaError).code).toBe('FORBIDDEN');
      expect((error as RastaError).status).toBe(403);
    }
  });

  it('refuses an anonymous context with 401', () => {
    try {
      runWithContext(context({ authType: 'ANONYMOUS' }), () => resolveActor());
      throw new Error('expected a refusal');
    } catch (error) {
      expect((error as RastaError).code).toBe('UNAUTHENTICATED');
    }
  });

  it('never reads the organization from anywhere but the context', () => {
    expect(() => resolveActor()).toThrow(/No RequestContext/);
  });
});
