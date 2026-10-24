import type { AccessChange } from './access-change';
import { RevocationList, revocationTiming, type TokenFacts } from './revocation-list';

/**
 * The list's decisions (ADR-060, gateway revocation list addendum § 1–§ 3), with the realm's
 * 900-second lifetime and the verifier's 5-second tolerance passed in as configuration is.
 */

const T0 = Date.parse('2026-10-24T10:00:00.000Z');
const timing = revocationTiming(900, 5);

const list = (maxEntries = 1_000) => new RevocationList(timing, maxEntries);

const revoke = (
  atMs: number,
  roles: string[] = [],
  pair = { userId: 'U1', organizationId: 'ORG_A' },
) => ({ kind: 'revoke', ...pair, roles, atMs }) satisfies AccessChange;
const grant = (atMs: number, roles: string[], pair = { userId: 'U1', organizationId: 'ORG_A' }) =>
  ({ kind: 'grant', ...pair, roles, atMs }) satisfies AccessChange;

const token = (
  issuedAtMs: number,
  tenantRoles: string[] = [],
  pair = { userId: 'U1', organizationId: 'ORG_A' },
) => ({ ...pair, issuedAtMs, tenantRoles }) satisfies TokenFacts;

describe('revocationTiming — from configuration, never a constant', () => {
  it('keeps a pair through the lifetime, the tolerance past `exp`, and the grace on `iat`', () => {
    expect(timing).toEqual({
      maxTokenLifetimeMs: 900_000,
      clockToleranceMs: 5_000,
      graceMs: 6_000,
      retentionMs: 911_000,
    });
    expect(revocationTiming(300, 0).retentionMs).toBe(301_000);
  });
});

describe('the issued-at comparison', () => {
  const revoked = () => {
    const l = list();
    l.apply(revoke(T0, ['DRIVER']), T0);
    return l;
  };

  it('refuses a token issued before the revocation', () => {
    expect(revoked().evaluate(token(T0 - 60_000), T0 + 1)).toBe('revoked');
  });

  it('refuses a token issued at the cutoff plus the grace — equality refuses', () => {
    expect(revoked().evaluate(token(T0 + timing.graceMs), T0 + 10_000)).toBe('revoked');
  });

  it('admits a token issued one second after the grace, with the roles the pair still holds', () => {
    // `iat` is whole seconds: the next value a token can carry.
    expect(revoked().evaluate(token(T0 + timing.graceMs + 1_000, ['DRIVER']), T0 + 10_000)).toBe(
      'allow',
    );
  });

  it('refuses a token issued after the cutoff that still carries a removed role (projection lag)', () => {
    expect(
      revoked().evaluate(token(T0 + 60_000, ['DRIVER', 'ORGANIZATION_ADMIN']), T0 + 61_000),
    ).toBe('stale_roles');
  });

  it('lets a confirmed re-grant through: a token issued after it, carrying the granted role', () => {
    const l = revoked();
    l.apply(grant(T0 + 120_000, ['DRIVER', 'ORGANIZATION_ADMIN']), T0 + 120_000);
    expect(l.evaluate(token(T0 + 130_000, ['DRIVER', 'ORGANIZATION_ADMIN']), T0 + 130_000)).toBe(
      'allow',
    );
    // The re-grant moves no cutoff: a token from before the revocation is still refused.
    expect(l.evaluate(token(T0 - 1_000, ['DRIVER']), T0 + 130_000)).toBe('revoked');
  });

  it('refuses every tenant role after a membership revocation, until a grant states one', () => {
    const l = list();
    l.apply(revoke(T0, []), T0);
    expect(l.evaluate(token(T0 + 60_000, ['DRIVER']), T0 + 60_000)).toBe('stale_roles');
  });
});

describe('expiry: the window is the token lifetime plus the tolerance plus the grace', () => {
  it('keeps refusing until the last token issued within the grace could have expired, then forgets', () => {
    const l = list();
    l.apply(revoke(T0), T0);
    expect(l.evaluate(token(T0 - 1_000), T0 + timing.retentionMs)).toBe('revoked');
    expect(l.evaluate(token(T0 - 1_000), T0 + timing.retentionMs + 1)).toBe('allow');
    expect(l.size).toBe(0);
  });

  it('does not store a revocation whose window has already passed', () => {
    const l = list();
    expect(l.apply(revoke(T0), T0 + timing.retentionMs + 1)).toBe('expired');
    expect(l.size).toBe(0);
  });

  it('prune drops only pairs whose window has passed', () => {
    const l = list();
    l.apply(revoke(T0, [], { userId: 'U1', organizationId: 'ORG_A' }), T0);
    l.apply(revoke(T0 + 500_000, [], { userId: 'U2', organizationId: 'ORG_A' }), T0 + 500_000);
    l.prune(T0 + timing.retentionMs + 1);
    expect(l.size).toBe(1);
  });
});

describe('duplicates, reordering and replays keep the latest cutoff', () => {
  it('an older revocation replayed after a newer one neither weakens the cutoff nor restarts the window', () => {
    const l = list();
    l.apply(revoke(T0 + 100_000), T0 + 100_000);
    l.apply(revoke(T0), T0 + 100_001);
    // Issued between the two: still refused by the newer one.
    expect(l.evaluate(token(T0 + 50_000), T0 + 100_002)).toBe('revoked');
    // The window is the newer one's, not restarted by the replay, and not shortened by it.
    expect(l.evaluate(token(T0 + 50_000), T0 + 100_000 + timing.retentionMs)).toBe('revoked');
    expect(l.evaluate(token(T0 + 50_000), T0 + 100_000 + timing.retentionMs + 1)).toBe('allow');
  });

  it('a duplicate changes nothing', () => {
    const once = list();
    const twice = list();
    once.apply(revoke(T0, ['DRIVER']), T0);
    twice.apply(revoke(T0, ['DRIVER']), T0);
    twice.apply(revoke(T0, ['DRIVER']), T0 + 5_000);
    for (const at of [T0 - 1, T0 + 7_000]) {
      expect(twice.evaluate(token(at, ['DRIVER']), T0 + 8_000)).toBe(
        once.evaluate(token(at, ['DRIVER']), T0 + 8_000),
      );
    }
  });

  it('an older grant replayed after a newer revocation does not restore a removed role', () => {
    const l = list();
    l.apply(revoke(T0 + 100_000, ['DRIVER']), T0 + 100_000);
    l.apply(grant(T0, ['DRIVER', 'ORGANIZATION_ADMIN']), T0 + 100_001);
    expect(l.evaluate(token(T0 + 200_000, ['DRIVER', 'ORGANIZATION_ADMIN']), T0 + 200_000)).toBe(
      'stale_roles',
    );
  });

  it('a grant and a revocation at one instant (one role change) take the narrower roles', () => {
    const l = list();
    l.apply(grant(T0, ['DRIVER', 'FLEET_MANAGER']), T0);
    l.apply(revoke(T0, ['DRIVER']), T0);
    expect(l.evaluate(token(T0 + 60_000, ['FLEET_MANAGER']), T0 + 60_000)).toBe('stale_roles');
  });
});

describe('tenant isolation: one pair, never its user elsewhere nor its organization for others', () => {
  const l = list();
  l.apply(revoke(T0, [], { userId: 'U1', organizationId: 'ORG_A' }), T0);

  it('refuses U1 in ORG_A', () => {
    expect(
      l.evaluate(token(T0 - 1, ['DRIVER'], { userId: 'U1', organizationId: 'ORG_A' }), T0),
    ).toBe('revoked');
  });

  it('admits U1 in ORG_B and U2 in ORG_A with tokens of the same age', () => {
    expect(
      l.evaluate(token(T0 - 1, ['DRIVER'], { userId: 'U1', organizationId: 'ORG_B' }), T0),
    ).toBe('allow');
    expect(
      l.evaluate(token(T0 - 1, ['DRIVER'], { userId: 'U2', organizationId: 'ORG_A' }), T0),
    ).toBe('allow');
  });

  it('keys cannot be forged by ids that contain a separator', () => {
    const k = list();
    k.apply(revoke(T0, [], { userId: 'U1:ORG', organizationId: 'A' }), T0);
    expect(k.evaluate(token(T0 - 1, [], { userId: 'U1', organizationId: 'ORG:A' }), T0)).toBe(
      'allow',
    );
  });
});

describe('bound and hold — what cannot be stored is never dropped silently', () => {
  it('a revocation for a new pair at the bound is `full`; a grant is dropped', () => {
    const l = list(1);
    l.apply(revoke(T0, [], { userId: 'U1', organizationId: 'ORG_A' }), T0);
    expect(l.apply(revoke(T0, [], { userId: 'U2', organizationId: 'ORG_A' }), T0)).toBe('full');
    expect(l.apply(grant(T0, ['DRIVER'], { userId: 'U3', organizationId: 'ORG_A' }), T0)).toBe(
      'applied',
    );
    expect(l.size).toBe(1);
  });

  it('a held list answers `held` for every pair until the window of the held event has passed', () => {
    const l = list();
    l.hold(T0);
    expect(
      l.evaluate(token(T0 + 60_000, [], { userId: 'U9', organizationId: 'ORG_Z' }), T0 + 1),
    ).toBe('held');
    expect(l.isHeld(T0 + timing.retentionMs)).toBe(true);
    expect(l.isHeld(T0 + timing.retentionMs + 1)).toBe(false);
  });

  it('an older hold never shortens a newer one', () => {
    const l = list();
    l.hold(T0 + 100_000);
    l.hold(T0);
    expect(l.isHeld(T0 + 100_000 + timing.retentionMs)).toBe(true);
  });
});
