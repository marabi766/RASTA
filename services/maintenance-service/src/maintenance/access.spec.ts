import {
  getOrganizationId,
  isRastaError,
  RastaError,
  runWithContext,
  type RequestContext,
} from '@rasta/nest-common';
import {
  assertOwnReport,
  currentMaintenanceScope,
  isMaintenanceSupervisor,
  MAINTENANCE_SUPERVISOR_ROLES,
} from './access';

/**
 * Object-level authorization.
 *
 * The rule is expressed as a *narrowing*, and these tests are mostly about the
 * default: a caller who is neither a supervisor nor recognisable must end up
 * with less access, not more. Written the other way round — "grant if
 * supervisor" — an unrecognised role would fall through to everything, and no
 * test that only checked the happy path would notice.
 */

function asUser<T>(roles: string[], userId: string | undefined, fn: () => T): T {
  const context: RequestContext = {
    correlationId: 'spec',
    requestId: 'spec',
    organizationId: 'ORG-DEH-0001',
    roles,
    authType: 'USER',
    startedAt: Date.now(),
    ...(userId ? { userId } : {}),
  };
  return runWithContext(context, fn);
}

describe('maintenance scope', () => {
  it.each([...MAINTENANCE_SUPERVISOR_ROLES])('gives %s the whole organization', (role) => {
    asUser([role], 'USR-1', () => {
      expect(currentMaintenanceScope()).toEqual({ kind: 'SUPERVISOR' });
    });
  });

  it('narrows an operator to what they reported', () => {
    asUser(['OPERATOR'], 'USR-OP', () => {
      expect(currentMaintenanceScope()).toEqual({ kind: 'REPORTER', userId: 'USR-OP' });
    });
  });

  it('narrows a role it has never heard of, rather than widening it', () => {
    // The default that matters. A role added to Keycloak next year, with no
    // entry in this file, gets the least access — not the most.
    asUser(['SOME_FUTURE_ROLE'], 'USR-X', () => {
      expect(currentMaintenanceScope()).toEqual({ kind: 'REPORTER', userId: 'USR-X' });
    });
  });

  it('narrows a workshop user, which is what makes deferring the portal safe', () => {
    // docs/09 gives WORKSHOP its own permissions over the orders referred to
    // it. Serving that means reading across a tenant boundary, which this
    // platform has no model for — so until it does, a workshop role falls into
    // the narrowing and sees only what it reported, which is nothing
    // (ADR-029).
    asUser(['WORKSHOP'], 'USR-WS', () => {
      expect(currentMaintenanceScope()).toEqual({ kind: 'REPORTER', userId: 'USR-WS' });
    });
  });

  it('refuses a caller with no identity to narrow to', () => {
    asUser(['OPERATOR'], undefined, () => {
      expect(() => currentMaintenanceScope()).toThrow(RastaError);
    });
  });

  it('treats an internal service caller as a supervisor', () => {
    // AuthGuard has already authorized it against `@AllowService`, which is a
    // stricter question than role membership. Narrowing it to records it never
    // reported would break every internal read.
    const context: RequestContext = {
      correlationId: 'spec',
      requestId: 'spec',
      organizationId: 'ORG-DEH-0001',
      roles: [],
      authType: 'SERVICE',
      callerService: 'analytics-service',
      startedAt: Date.now(),
    };

    runWithContext(context, () => {
      expect(currentMaintenanceScope()).toEqual({ kind: 'SUPERVISOR' });
    });
  });

  it('recognises a supervisor role among several', () => {
    expect(isMaintenanceSupervisor(['DRIVER', 'FLEET_MANAGER'])).toBe(true);
    expect(isMaintenanceSupervisor(['DRIVER', 'OPERATOR'])).toBe(false);
    expect(isMaintenanceSupervisor([])).toBe(false);
  });
});

describe('record-level refusal', () => {
  it('lets a supervisor see anything in the tenant', () => {
    expect(() =>
      assertOwnReport({ kind: 'SUPERVISOR' }, 'USR-SOMEONE-ELSE', 'MaintenanceRequest', 'MNT_1'),
    ).not.toThrow();
  });

  it('lets a reporter see what they reported', () => {
    expect(() =>
      assertOwnReport(
        { kind: 'REPORTER', userId: 'USR-OP' },
        'USR-OP',
        'MaintenanceRequest',
        'MNT_1',
      ),
    ).not.toThrow();
  });

  it('reports a colleague record as absent, never as forbidden', () => {
    // A 403 confirms the record exists. An operator probing identifiers could
    // then map their colleagues' repairs and what they cost, which is exactly
    // the disclosure the platform's uniform 404 rule prevents (docs/09).
    try {
      assertOwnReport(
        { kind: 'REPORTER', userId: 'USR-OP' },
        'USR-SOMEONE-ELSE',
        'MaintenanceRequest',
        'MNT_1',
      );
      throw new Error('expected a refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(RastaError);
      expect((error as RastaError).code).toBe('NOT_FOUND');
      expect((error as RastaError).status).toBe(404);
    }
  });

  it('refuses a record with no reporter at all', () => {
    expect(() =>
      assertOwnReport({ kind: 'REPORTER', userId: 'USR-OP' }, null, 'RepairOrder', 'RPO_1'),
    ).toThrow(RastaError);
  });
});

describe('a service caller after ADR-035', () => {
  /**
   * Regression coverage for the shared change, from a service other than the
   * one it was written for.
   *
   * `currentMaintenanceScope()` returns a **role** scope, not a tenant scope —
   * a service caller sees the whole organization rather than one reporter's
   * records, because narrowing it to a user record it does not have would
   * break every internal read. *Which* organization is still bounded by the
   * tenant-guarded client, from the signed `org_id` on its token.
   *
   * Those are different questions, and this block exists so a future change to
   * one is not mistaken for a change to the other.
   */

  function asService<T>(organizationId: string | undefined, fn: () => T): T {
    const context: RequestContext = {
      correlationId: 'spec',
      requestId: 'spec',
      roles: ['SERVICE'],
      authType: 'SERVICE',
      callerService: 'economic-service',
      startedAt: Date.now(),
      ...(organizationId ? { organizationId } : {}),
    };
    return runWithContext(context, fn);
  }

  it('keeps its supervisor role scope', () => {
    expect(asService('ORG-DEH-0001', () => currentMaintenanceScope()).kind).toBe('SUPERVISOR');
  });

  it('is still bounded by the organization its token was signed for', () => {
    // Never from a header: the shared AuthGuard refuses to honour one that
    // does not match the signed claim (ADR-035).
    expect(asService('ORG-DEH-0001', () => getOrganizationId())).toBe('ORG-DEH-0001');
  });

  it('is refused with a platform 403 when its token carries no organization', () => {
    // Not a 500. Before ADR-035 this raised a raw Error and surfaced as
    // INTERNAL_ERROR, which made a deliberate refusal look like a fault.
    try {
      asService(undefined, () => getOrganizationId());
      throw new Error('expected a refusal');
    } catch (error) {
      expect(isRastaError(error)).toBe(true);
      expect((error as { code: string }).code).toBe('SERVICE_TENANT_CONTEXT_INVALID');
      expect((error as { status: number }).status).toBe(403);
    }
  });
});
