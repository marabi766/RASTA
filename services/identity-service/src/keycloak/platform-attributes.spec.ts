import {
  divergentAttributes,
  platformAttributesFor,
  readPlatformAttributes,
} from './platform-attributes';

/**
 * The attribute set a user's token is built from, derived from their rows
 * alone (ADR-060 § 5). Everything authorization will read comes from here, so
 * each rule that decides what counts is asserted on its own.
 */
describe('platformAttributesFor', () => {
  const now = new Date('2026-09-24T12:00:00.000Z');
  const user = { id: 'USR_1', activeOrganizationId: 'ORG-A' };
  const membership = (organizationId: string, roles: string[], extra = {}) => ({
    organizationId,
    roles,
    status: 'ACTIVE',
    validFrom: new Date('2026-01-01T00:00:00.000Z'),
    validUntil: null as Date | null,
    ...extra,
  });

  it('writes the user id, every organization and every organization-role pair', () => {
    expect(
      platformAttributesFor(
        user,
        [
          membership('ORG-B', ['DRIVER']),
          membership('ORG-A', ['ORGANIZATION_ADMIN', 'FLEET_MANAGER']),
        ],
        now,
      ),
    ).toEqual({
      rasta_user_id: ['USR_1'],
      organization_ids: ['ORG-A', 'ORG-B'],
      organization_roles: ['ORG-A:FLEET_MANAGER', 'ORG-A:ORGANIZATION_ADMIN', 'ORG-B:DRIVER'],
      active_organization_id: ['ORG-A'],
    });
  });

  it('binds each role to the organization it was granted in, never to the user', () => {
    // The whole of ADR-060: administrator in A, driver in B, is two pairs.
    const attributes = platformAttributesFor(
      user,
      [membership('ORG-A', ['ORGANIZATION_ADMIN']), membership('ORG-B', ['DRIVER'])],
      now,
    );
    expect(attributes.organization_roles).not.toContain('ORG-B:ORGANIZATION_ADMIN');
    expect(attributes.organization_roles).toContain('ORG-B:DRIVER');
  });

  it('counts a membership only while it is active and inside its validity window', () => {
    const attributes = platformAttributesFor(
      { id: 'USR_1', activeOrganizationId: null },
      [
        membership('ORG-A', ['DRIVER']),
        membership('ORG-SUSPENDED', ['DRIVER'], { status: 'SUSPENDED' }),
        membership('ORG-EXPIRED', ['DRIVER'], { validUntil: new Date('2026-09-24T11:59:59.000Z') }),
        membership('ORG-FUTURE-END', ['DRIVER'], {
          validUntil: new Date('2026-12-01T00:00:00.000Z'),
        }),
        // The end is exclusive: at exactly validUntil the membership is over.
        membership('ORG-ENDS-NOW', ['DRIVER'], { validUntil: now }),
        membership('ORG-NOT-YET', ['DRIVER'], { validFrom: new Date('2026-09-24T12:00:01.000Z') }),
      ],
      now,
    );
    expect(attributes.organization_ids).toEqual(['ORG-A', 'ORG-FUTURE-END']);
    expect(attributes.organization_roles).toEqual(['ORG-A:DRIVER', 'ORG-FUTURE-END:DRIVER']);
  });

  it('drops an active organization the user no longer belongs to', () => {
    // Kept, the token's org_id would name an organization absent from org_ids.
    const attributes = platformAttributesFor(user, [membership('ORG-B', ['DRIVER'])], now);
    expect(attributes.active_organization_id).toEqual([]);
  });

  it('writes empty lists for a user with no live membership, never a stale one', () => {
    expect(platformAttributesFor(user, [], now)).toEqual({
      rasta_user_id: ['USR_1'],
      organization_ids: [],
      organization_roles: [],
      active_organization_id: [],
    });
  });

  it('gives the same rows the same attributes whatever their order', () => {
    const rows = [
      membership('ORG-B', ['DRIVER', 'OPERATOR']),
      membership('ORG-A', ['FLEET_MANAGER']),
    ];
    expect(platformAttributesFor(user, rows, now)).toEqual(
      platformAttributesFor(user, [...rows].reverse(), now),
    );
  });
});

describe('reconcile comparison', () => {
  const expected = {
    rasta_user_id: ['USR_1'],
    organization_ids: ['ORG-A'],
    organization_roles: ['ORG-A:DRIVER'],
    active_organization_id: ['ORG-A'],
  };

  it('treats a missing attribute as empty and ignores order', () => {
    const actual = readPlatformAttributes({
      organization_roles: ['ORG-A:DRIVER'],
      organization_ids: ['ORG-A'],
      active_organization_id: ['ORG-A'],
      locale: ['fa'],
    });
    expect(divergentAttributes(actual, expected)).toEqual(['rasta_user_id']);
  });

  it('reports a role Keycloak still holds after a demotion', () => {
    const actual = readPlatformAttributes({
      ...expected,
      organization_roles: ['ORG-A:DRIVER', 'ORG-A:ORGANIZATION_ADMIN'],
    });
    expect(divergentAttributes(actual, expected)).toEqual(['organization_roles']);
  });
});
