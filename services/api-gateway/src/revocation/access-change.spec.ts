import { readAccessChange } from './access-change';

/**
 * Reading the identity topic (ADR-060, gateway revocation list addendum § 5 and § 6): what is a
 * change, what is not read, and what cannot be read — the last is held against every pair.
 */

const OCCURRED_AT = '2026-10-24T10:00:00.000Z';

function message(eventName: string, payload: unknown, overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    eventId: '01JAXXXXXXXXXXXXXXXXXXXXXX',
    eventName,
    eventVersion: 1,
    occurredAt: OCCURRED_AT,
    producer: 'identity-service',
    aggregateType: 'Membership',
    aggregateId: 'M1',
    tenantId: 'ORG_A',
    correlationId: 'COR-1',
    payload,
    ...overrides,
  });
}

const roleChange = {
  membershipId: 'M1',
  userId: 'U1',
  organizationId: 'ORG_A',
  previousRoles: ['DRIVER', 'ORGANIZATION_ADMIN'],
  newRoles: ['DRIVER'],
  reason: 'a private note about the demotion',
};

describe('readAccessChange', () => {
  it('reads ROLE_REVOKED as a revocation with the roles held from then on', () => {
    expect(readAccessChange(message('ROLE_REVOKED', roleChange))).toEqual({
      outcome: 'change',
      change: {
        kind: 'revoke',
        userId: 'U1',
        organizationId: 'ORG_A',
        roles: ['DRIVER'],
        atMs: Date.parse(OCCURRED_AT),
      },
    });
  });

  it.each(['MEMBERSHIP_REVOKED', 'MEMBERSHIP_EXPIRED'])(
    'reads %s as a revocation of every role',
    (name) => {
      const read = readAccessChange(
        message(name, {
          membershipId: 'M1',
          userId: 'U1',
          organizationId: 'ORG_A',
          reason: 'x',
          validUntil: OCCURRED_AT,
        }),
      );
      expect(read).toMatchObject({ outcome: 'change', change: { kind: 'revoke', roles: [] } });
    },
  );

  it('reads ROLE_ASSIGNED and MEMBERSHIP_CREATED as grants', () => {
    expect(readAccessChange(message('ROLE_ASSIGNED', roleChange))).toMatchObject({
      change: { kind: 'grant', roles: ['DRIVER'] },
    });
    expect(
      readAccessChange(
        message('MEMBERSHIP_CREATED', {
          membershipId: 'M1',
          userId: 'U1',
          organizationId: 'ORG_A',
          roles: ['DRIVER'],
        }),
      ),
    ).toMatchObject({ change: { kind: 'grant', roles: ['DRIVER'] } });
  });

  it('never carries the reason, or any field it does not need, out of the payload', () => {
    const read = readAccessChange(message('ROLE_REVOKED', roleChange));
    expect(JSON.stringify(read)).not.toContain('private note');
    expect(JSON.stringify(read)).not.toContain('previousRoles');
  });

  it('ignores events it does not read', () => {
    expect(readAccessChange(message('USER_UPDATED', { userId: 'U1', changedFields: [] }))).toEqual({
      outcome: 'ignored',
    });
  });

  describe('unreadable — and only the event name, never the payload or the validation message', () => {
    it.each([
      ['not JSON', '{'],
      ['null', null],
      ['no event name', JSON.stringify({ payload: {} })],
    ])('%s', (_label, value) => {
      expect(readAccessChange(value)).toEqual({ outcome: 'unreadable' });
    });

    it.each([
      ['the envelope tenant differs from the payload organization', { tenantId: 'ORG_B' }],
      ['the envelope names no tenant', { tenantId: undefined }],
      ['a payload version this reader does not know', { eventVersion: 2 }],
      ['an envelope that fails its schema', { occurredAt: 'yesterday' }],
    ])('%s', (_label, overrides) => {
      expect(readAccessChange(message('ROLE_REVOKED', roleChange, overrides))).toEqual({
        outcome: 'unreadable',
        eventName: 'ROLE_REVOKED',
      });
    });

    it('a payload missing the user', () => {
      const { userId: _userId, ...withoutUser } = roleChange;
      expect(readAccessChange(message('ROLE_REVOKED', withoutUser))).toEqual({
        outcome: 'unreadable',
        eventName: 'ROLE_REVOKED',
      });
    });
  });
});
