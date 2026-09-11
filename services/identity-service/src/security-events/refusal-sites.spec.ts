import { AUDIT_ACTION_PATTERN, ERROR_CODES } from '@rasta/contracts';
import { RastaError } from '@rasta/nest-common';
import { markRefusal, refusalSiteOf, REFUSAL_SITES } from './refusal-sites';

describe('refusal site allowlist (ADR-053 § 4, AUD-004 Phase C1)', () => {
  it('instruments exactly one refusal site in this phase', () => {
    expect(Object.keys(REFUSAL_SITES)).toEqual(['SWITCH_ACTIVE_ORGANIZATION']);
  });

  it('pins the active-organization switch to its route, method, 403 and TENANT_MISMATCH', () => {
    expect(REFUSAL_SITES.SWITCH_ACTIVE_ORGANIZATION).toEqual({
      key: 'identity.switch_active_organization',
      method: 'POST',
      route: '/v1/users/me/active-organization',
      status: 403,
      errorCode: ERROR_CODES.TENANT_MISMATCH,
      action: 'identity.active_organization.switch',
      resourceType: 'User',
      resource: 'ACTOR_USER',
      reason:
        'Active organization switch refused: no active membership in the requested organization',
    });
  });

  it.each(Object.values(REFUSAL_SITES))(
    '$key names a dotted action the contract accepts',
    (site) => {
      expect(site.action).toMatch(AUDIT_ACTION_PATTERN);
      expect(site.status).toBe(403);
    },
  );

  it('marks an error without changing anything the platform filter reads', () => {
    const plain = RastaError.tenantMismatch('ORG_X', []);
    const marked = markRefusal(
      RastaError.tenantMismatch('ORG_X', []),
      'SWITCH_ACTIVE_ORGANIZATION',
    );

    expect(marked).toBeInstanceOf(RastaError);
    expect(marked.status).toBe(plain.status);
    expect(marked.code).toBe(plain.code);
    expect(marked.message).toBe(plain.message);
    expect(marked.internalContext).toEqual(plain.internalContext);
    expect(Object.keys(marked).sort()).toEqual(Object.keys(plain).sort());
    expect(JSON.stringify(marked)).toBe(JSON.stringify(plain));
  });

  it('recognises only the error instance that was marked', () => {
    const marked = markRefusal(
      RastaError.tenantMismatch('ORG_X', []),
      'SWITCH_ACTIVE_ORGANIZATION',
    );
    expect(refusalSiteOf(marked)).toBe(REFUSAL_SITES.SWITCH_ACTIVE_ORGANIZATION);

    // Same code, same message, different instance — e.g. the auth guard's own
    // TENANT_MISMATCH for a bad X-Organization-Id header.
    expect(refusalSiteOf(RastaError.tenantMismatch('ORG_X', ['ORG_A']))).toBeUndefined();
  });

  it.each([
    ['an unmarked FORBIDDEN', RastaError.forbidden()],
    ['an unmarked INSUFFICIENT_ROLE', RastaError.insufficientRole(['UNION_ADMIN'], [])],
    ['an unmarked 401', RastaError.unauthenticated()],
    ['a plain Error', new Error('boom')],
    ['a string', 'TENANT_MISMATCH'],
    ['null', null],
    ['undefined', undefined],
  ])('returns no site for %s', (_label, value) => {
    expect(refusalSiteOf(value)).toBeUndefined();
  });
});
