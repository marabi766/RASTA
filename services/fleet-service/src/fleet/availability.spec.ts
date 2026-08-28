import { describeBlockers } from './availability.service';

/**
 * Availability is the one answer on the platform assembled from facts four
 * different services own. These tests pin two properties that matter more than
 * the boolean: that *every* blocker is reported, and that each names the
 * service that can clear it (ADR-026).
 */
describe('availability blockers', () => {
  const free = { status: 'ACTIVE', inMaintenance: false, dispatchBlockedReason: null };

  it('reports a dispatchable machine with no blockers', () => {
    expect(describeBlockers(free, undefined, undefined)).toEqual([]);
  });

  describe('attribution', () => {
    it('names asset-service for a safety withdrawal', () => {
      const [blocker] = describeBlockers(
        { ...free, dispatchBlockedReason: 'The most recent technical inspection failed' },
        undefined,
        undefined,
      );
      expect(blocker).toEqual({
        code: 'DISPATCH_BLOCKED',
        owner: 'asset-service',
        detail: 'The most recent technical inspection failed',
      });
    });

    it('names maintenance-service for a workshop withdrawal', () => {
      const [blocker] = describeBlockers({ ...free, inMaintenance: true }, undefined, undefined);
      expect(blocker!.code).toBe('IN_MAINTENANCE');
      expect(blocker!.owner).toBe('maintenance-service');
    });

    it('names fleet-service for its own two blockers', () => {
      const assigned = describeBlockers(
        free,
        { id: 'ASG_1', driverId: 'DRV_1' },
        { available: false, reason: 'رزرو برای پروژه' },
      );
      expect(assigned.map((b) => [b.code, b.owner])).toEqual([
        ['ACTIVE_ASSIGNMENT', 'fleet-service'],
        ['DECLARED_UNAVAILABLE', 'fleet-service'],
      ]);
    });
  });

  describe('completeness', () => {
    it('reports every blocker, not just the first', () => {
      // A fleet manager who clears one blocker should not have to re-run the
      // query to discover the next.
      const blockers = describeBlockers(
        {
          status: 'OUT_OF_SERVICE',
          inMaintenance: true,
          dispatchBlockedReason: 'The insurance policy has expired',
        },
        { id: 'ASG_1', driverId: 'DRV_1' },
        { available: false, reason: 'رزرو' },
      );

      expect(blockers.map((b) => b.code)).toEqual([
        'DISPATCH_BLOCKED',
        'IN_MAINTENANCE',
        'ASSET_STATUS',
        'ACTIVE_ASSIGNMENT',
        'DECLARED_UNAVAILABLE',
      ]);
    });
  });

  describe('asset lifecycle states', () => {
    it.each(['ACTIVE', 'IDLE'])('%s is dispatchable', (status) => {
      expect(describeBlockers({ ...free, status }, undefined, undefined)).toEqual([]);
    });

    it.each(['REGISTERED', 'ASSIGNED', 'IN_MAINTENANCE', 'OUT_OF_SERVICE', 'DECOMMISSIONED'])(
      '%s is not',
      (status) => {
        const blockers = describeBlockers({ ...free, status }, undefined, undefined);
        expect(blockers.map((b) => b.code)).toContain('ASSET_STATUS');
      },
    );
  });

  describe('declared windows', () => {
    it('a window declaring availability does not clear other blockers', () => {
      // Declaring a machine free does not renew its insurance. The declaration
      // sits alongside the other blockers rather than overriding them.
      const blockers = describeBlockers(
        { ...free, dispatchBlockedReason: 'The insurance policy has expired' },
        undefined,
        { available: true, reason: 'مورد نیاز پروژه' },
      );

      expect(blockers.map((b) => b.code)).toEqual(['DISPATCH_BLOCKED']);
    });

    it('a window declaring unavailability blocks an otherwise-free machine', () => {
      const blockers = describeBlockers(free, undefined, {
        available: false,
        reason: 'تعطیلات',
      });
      expect(blockers.map((b) => b.code)).toEqual(['DECLARED_UNAVAILABLE']);
    });
  });
});
