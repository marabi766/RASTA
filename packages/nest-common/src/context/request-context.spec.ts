import {
  createSystemContext,
  getContext,
  getOrganizationId,
  runWithContext,
  tryGetContext,
  upgradeContext,
  type RequestContext,
  isMemberOfOrganization,
} from './request-context';
import { RastaError } from '../errors/rasta-error';

/**
 * The tenant boundary, at the point where code actually asks for it.
 *
 * `getOrganizationId()` is what makes an operation tenant-scoped — there is no
 * separate list of which endpoints are which, so calling it *is* the
 * declaration. That makes it the right place for the second half of ADR-035:
 * a service call that arrived without a signed `org_id` is refused here, with
 * a platform 403, rather than surfacing as the unhandled 500 it used to.
 */

function contextFor(overrides: Partial<RequestContext>): RequestContext {
  return {
    correlationId: 'COR_1',
    requestId: 'REQ_1',
    roles: [],
    authType: 'ANONYMOUS',
    startedAt: Date.now(),
    ...overrides,
  };
}

describe('getOrganizationId', () => {
  it('returns the tenant a request acts for', () => {
    const value = runWithContext(contextFor({ authType: 'USER', organizationId: 'ORG-A' }), () =>
      getOrganizationId(),
    );

    expect(value).toBe('ORG-A');
  });

  it('refuses a service call with no signed tenant, as a platform 403', () => {
    // ADR-035. The token was minted without an `org_id` and this operation
    // needs one: a refusal the caller can act on by minting the right token,
    // not a fault for an operator to investigate.
    expect(() =>
      runWithContext(
        contextFor({ authType: 'SERVICE', callerService: 'marketplace-service' }),
        () => getOrganizationId(),
      ),
    ).toThrow(expect.objectContaining({ code: 'SERVICE_TENANT_CONTEXT_INVALID', status: 403 }));
  });

  it('keeps which check failed out of the message, and in the log context', () => {
    // The response must not tell a caller *why* their token was rejected —
    // that is how somebody works out the shape of one that would pass (S-09).
    try {
      runWithContext(
        contextFor({ authType: 'SERVICE', callerService: 'marketplace-service', path: '/v1/x' }),
        () => getOrganizationId(),
      );
      throw new Error('expected a refusal');
    } catch (error) {
      const rasta = error as RastaError;
      expect(rasta).toBeInstanceOf(RastaError);
      expect(rasta.message).not.toContain('MISSING_CLAIM');
      expect(rasta.message).not.toContain('marketplace-service');
      expect(rasta.internalContext).toEqual({
        reason: 'MISSING_CLAIM',
        callerService: 'marketplace-service',
        path: '/v1/x',
      });
      // No details array: there is no field for a client to correct.
      expect(rasta.details).toBeUndefined();
    }
  });

  it('still fails loudly for a user request with no tenant', () => {
    // Here it genuinely is a bug rather than a refusal: the guard resolves a
    // tenant for every authenticated user, so arriving with none means an
    // endpoint is tenant-scoped when it should not be. A 403 would make that
    // look like an ordinary authorization outcome and hide it.
    expect(() =>
      runWithContext(contextFor({ authType: 'USER', userId: 'USR-1' }), () => getOrganizationId()),
    ).toThrow(/has no organizationId, but tenant-scoped data was accessed/);

    expect(() =>
      runWithContext(contextFor({ authType: 'USER' }), () => getOrganizationId()),
    ).not.toThrow(expect.objectContaining({ code: 'SERVICE_TENANT_CONTEXT_INVALID' }));
  });

  it('fails loudly for an anonymous request too', () => {
    expect(() => runWithContext(contextFor({}), () => getOrganizationId())).toThrow(
      /tenant-scoped data was accessed/,
    );
  });

  it('refuses to guess outside a request entirely', () => {
    expect(() => getOrganizationId()).toThrow(/No RequestContext available/);
  });
});

describe('the request context itself', () => {
  it('is frozen, so nothing downstream can reassign the tenant', () => {
    // Tenant scoping derived from a mutable value is not a security boundary.
    runWithContext(contextFor({ authType: 'USER', organizationId: 'ORG-A' }), () => {
      const context = getContext();
      expect(() => {
        (context as { organizationId?: string }).organizationId = 'ORG-B';
      }).toThrow();
      expect(getOrganizationId()).toBe('ORG-A');
    });
  });

  it('upgrades exactly once, from anonymous to authenticated', () => {
    runWithContext(contextFor({}), () => {
      expect(tryGetContext()?.authType).toBe('ANONYMOUS');

      upgradeContext({ authType: 'SERVICE', organizationId: 'ORG-A', roles: ['SERVICE'] });

      expect(tryGetContext()?.authType).toBe('SERVICE');
      expect(getOrganizationId()).toBe('ORG-A');
    });
  });

  it('refuses an upgrade outside a request', () => {
    expect(() => upgradeContext({ organizationId: 'ORG-A' })).toThrow(/outside a request context/);
  });

  it('gives background work a service context that carries its tenant', () => {
    // Consumers and the outbox relay build one of these. A consumer knows its
    // tenant from the event envelope, so it can supply one; the relay does not
    // and uses the explicit unscoped API instead.
    const withTenant = createSystemContext({
      correlationId: 'COR_2',
      organizationId: 'ORG-A',
    });
    expect(withTenant.authType).toBe('SERVICE');
    expect(runWithContext(withTenant, () => getOrganizationId())).toBe('ORG-A');

    const withoutTenant = createSystemContext({ correlationId: 'COR_3' });
    expect(() => runWithContext(withoutTenant, () => getOrganizationId())).toThrow(
      expect.objectContaining({ code: 'SERVICE_TENANT_CONTEXT_INVALID' }),
    );
  });
});

/**
 * D-2 — the membership set, and why it is a separate field from the tenant.
 *
 * `organizationId` is which organization a request *acts for*; the caller
 * chooses it per request with `X-Organization-Id`. `organizationIds` is which
 * organizations they *belong to*, which the identity provider decides. A
 * conflict-of-interest rule must ask the second question, and asking the first
 * is what let a supplier-service operator approve their own submission by
 * selecting a different tenant.
 */
describe('organization memberships', () => {
  const base = {
    correlationId: 'COR_M',
    requestId: 'REQ_M',
    roles: ['UNION_ADMIN'],
    authType: 'USER' as const,
    startedAt: Date.now(),
  };

  it('reports membership from the set, not only from the selected tenant', () => {
    const context = { ...base, organizationId: 'ORG-UNION', organizationIds: ['ORG-UNION', 'ORG-SUP'] };

    runWithContext(context, () => {
      expect(isMemberOfOrganization('ORG-UNION')).toBe(true);
      // The one the caller did not select — and the whole point.
      expect(isMemberOfOrganization('ORG-SUP')).toBe(true);
      expect(isMemberOfOrganization('ORG-STRANGER')).toBe(false);
    });
  });

  it('folds the selected tenant in, so it can never be weaker than the old check', () => {
    // A context built without memberships — a consumer, a background job, an
    // older call site. The selected tenant alone must still match.
    const context = { ...base, organizationId: 'ORG-A', organizationIds: [] };
    runWithContext(context, () => {
      expect(isMemberOfOrganization('ORG-A')).toBe(true);
      expect(isMemberOfOrganization('ORG-B')).toBe(false);
    });
  });

  it('treats an unknown or absent organization as no match', () => {
    const context = { ...base, organizationIds: ['ORG-A'] };
    runWithContext(context, () => {
      expect(isMemberOfOrganization(undefined)).toBe(false);
      expect(isMemberOfOrganization('')).toBe(false);
    });
    // Outside a request there is no caller to be a member of anything.
    expect(isMemberOfOrganization('ORG-A')).toBe(false);
  });

  it('freezes the membership set, so nothing downstream can add one', () => {
    const mutable = ['ORG-A'];
    const context = { ...base, organizationId: 'ORG-A', organizationIds: mutable };

    runWithContext(context, () => {
      const current = getContext();
      expect(Object.isFrozen(current.organizationIds)).toBe(true);
      expect(() => {
        (current.organizationIds as string[]).push('ORG-INJECTED');
      }).toThrow();
      expect(isMemberOfOrganization('ORG-INJECTED')).toBe(false);
    });

    // The caller's own array is copied, so mutating it afterwards changes
    // nothing that was authenticated.
    mutable.push('ORG-LATER');
    runWithContext(context, () => {
      expect(isMemberOfOrganization('ORG-LATER')).toBe(true);
    });
  });

  it('keeps the set across an upgrade, and lets the guard replace it', () => {
    const anonymous = { ...base, roles: [], authType: 'ANONYMOUS' as const, organizationIds: [] };

    runWithContext(anonymous, () => {
      expect(isMemberOfOrganization('ORG-A')).toBe(false);

      upgradeContext({
        authType: 'USER',
        organizationId: 'ORG-A',
        organizationIds: ['ORG-A', 'ORG-B'],
        roles: ['UNION_ADMIN'],
      });

      expect(isMemberOfOrganization('ORG-B')).toBe(true);
      expect(Object.isFrozen(getContext().organizationIds)).toBe(true);
    });
  });

  it('gives background work no memberships at all', () => {
    // Empty means *unknown*, not *any*. A relay or consumer must never satisfy
    // a membership check, and must never be exempted from one either.
    const system = createSystemContext({ correlationId: 'COR_S', organizationId: 'ORG-A' });
    expect(system.organizationIds).toEqual([]);

    runWithContext(system, () => {
      // Acting for ORG-A still counts as ORG-A, which is what the fold gives
      // us; it belongs to nothing else.
      expect(isMemberOfOrganization('ORG-A')).toBe(true);
      expect(isMemberOfOrganization('ORG-B')).toBe(false);
    });
  });
});
