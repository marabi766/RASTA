import { runWithContext, isRastaError, type RequestContext } from '@rasta/nest-common';
import { assertOwnDriverRecord, currentFleetScope, isFleetSupervisor } from './access';

/**
 * Object-level authorization is the check the `@Roles` guard cannot make: it
 * never sees the record. These tests pin the narrowing behaviour, because the
 * failure mode of getting it wrong is an operator reading the whole yard's
 * assignments.
 */

function context(overrides: Partial<RequestContext>): RequestContext {
  return {
    correlationId: 'corr-1',
    requestId: 'req-1',
    roles: [],
    authType: 'USER',
    startedAt: Date.now(),
    ...overrides,
  };
}

describe('fleet access scope', () => {
  describe('supervisor roles', () => {
    it.each(['SYSTEM_ADMIN', 'UNION_ADMIN', 'ORGANIZATION_ADMIN', 'FLEET_MANAGER'])(
      '%s sees the whole organization',
      (role) => {
        expect(isFleetSupervisor([role])).toBe(true);
        const scope = runWithContext(context({ roles: [role], userId: 'USR_1' }), () =>
          currentFleetScope(),
        );
        expect(scope.kind).toBe('SUPERVISOR');
      },
    );
  });

  describe('operator roles', () => {
    it.each(['DRIVER', 'OPERATOR'])('%s is narrowed to their own record', (role) => {
      expect(isFleetSupervisor([role])).toBe(false);
      const scope = runWithContext(context({ roles: [role], userId: 'USR_7' }), () =>
        currentFleetScope(),
      );
      expect(scope).toEqual({ kind: 'SELF', userId: 'USR_7' });
    });

    it('holding a supervisor role alongside DRIVER widens the scope', () => {
      // The seeded operator holds both OPERATOR and DRIVER; a fleet manager
      // who is also a driver must not lose the manager's view.
      const scope = runWithContext(
        context({ roles: ['DRIVER', 'FLEET_MANAGER'], userId: 'USR_7' }),
        () => currentFleetScope(),
      );
      expect(scope.kind).toBe('SUPERVISOR');
    });
  });

  describe('unknown roles', () => {
    it('narrows rather than widens', () => {
      // The rule is written as a narrowing on purpose. Written the other way
      // round — "grant access if supervisor" — a role that is neither
      // supervisory nor an operator would fall through to full access.
      const scope = runWithContext(context({ roles: ['AUDITOR'], userId: 'USR_9' }), () =>
        currentFleetScope(),
      );
      expect(scope).toEqual({ kind: 'SELF', userId: 'USR_9' });
    });

    it('refuses a request with no user identity to narrow to', () => {
      expect(() =>
        runWithContext(context({ roles: ['DRIVER'] }), () => currentFleetScope()),
      ).toThrow();
    });
  });

  describe('service-to-service callers', () => {
    it('are not narrowed to a driver record they do not have', () => {
      // Already authorized by AuthGuard against @AllowService, which is a
      // stricter question than role membership.
      const scope = runWithContext(
        context({ authType: 'SERVICE', roles: ['SERVICE'], callerService: 'maintenance-service' }),
        () => currentFleetScope(),
      );
      expect(scope.kind).toBe('SUPERVISOR');
    });
  });

  describe('assertOwnDriverRecord', () => {
    it('lets a supervisor through regardless of the record', () => {
      expect(() =>
        assertOwnDriverRecord(
          { kind: 'SUPERVISOR' },
          { id: 'DRV_1', userId: 'USR_OTHER' },
          'Driver',
          'DRV_1',
        ),
      ).not.toThrow();
    });

    it('lets an operator read their own record', () => {
      expect(() =>
        assertOwnDriverRecord(
          { kind: 'SELF', userId: 'USR_7' },
          { id: 'DRV_1', userId: 'USR_7' },
          'Driver',
          'DRV_1',
        ),
      ).not.toThrow();
    });

    it("reports another operator's record as absent, never as forbidden", () => {
      // A 403 confirms the record exists. An operator probing identifiers
      // could then map their colleagues' assignments, so the platform's
      // non-disclosure rule is uniform (docs/09).
      try {
        assertOwnDriverRecord(
          { kind: 'SELF', userId: 'USR_7' },
          { id: 'DRV_2', userId: 'USR_OTHER' },
          'Driver',
          'DRV_2',
        );
        throw new Error('expected a refusal');
      } catch (error) {
        expect(isRastaError(error)).toBe(true);
        expect((error as { code: string }).code).toBe('NOT_FOUND');
        expect((error as { status: number }).status).toBe(404);
      }
    });

    it('reports a missing record as absent too', () => {
      try {
        assertOwnDriverRecord({ kind: 'SELF', userId: 'USR_7' }, null, 'Assignment', 'ASG_1');
        throw new Error('expected a refusal');
      } catch (error) {
        expect((error as { code: string }).code).toBe('NOT_FOUND');
      }
    });
  });
});
