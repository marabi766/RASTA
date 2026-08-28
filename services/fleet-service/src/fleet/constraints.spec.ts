import {
  ACTIVE_ASSET_STATUSES,
  ACTIVE_ASSIGNMENT_ASSET_CONSTRAINT,
  ACTIVE_ASSIGNMENT_DRIVER_CONSTRAINT,
  identifyExclusivityConstraint,
} from './constraints';

/**
 * These tests exist because of a bug the integration suite found and this file
 * could not have found on its own.
 *
 * The translation matched on the index name — `ux_assignment_active_driver` —
 * but Prisma reports the indexed *column* in a P2002's `meta.target` and never
 * the index name. Every genuine race therefore fell through to a generic
 * ALREADY_EXISTS instead of "this driver already holds an assignment", which
 * quietly broke the promise ADR-025 makes that a race is indistinguishable
 * from an ordinary conflict.
 *
 * Nothing here can prove Prisma's shape — only a real PostgreSQL does that, in
 * `test/assignment-concurrency.int-spec.ts`. What these pin is that both forms
 * stay recognised, so the fix cannot be undone by someone tidying the
 * "redundant" branch away.
 */
describe('exclusivity constraint identification', () => {
  describe('what Prisma actually reports', () => {
    it('recognises the driver column', () => {
      expect(identifyExclusivityConstraint('driver_id')).toBe('driver');
    });

    it('recognises the asset column', () => {
      expect(identifyExclusivityConstraint('asset_id')).toBe('asset');
    });

    it('recognises a comma-joined multi-column target', () => {
      // `violatedConstraint` joins an array target with commas, which is the
      // shape Prisma uses for a composite index.
      expect(identifyExclusivityConstraint('organization_id,driver_id')).toBe('driver');
    });
  });

  describe('the index names, kept as a fallback', () => {
    it('recognises the driver index by name', () => {
      expect(identifyExclusivityConstraint(ACTIVE_ASSIGNMENT_DRIVER_CONSTRAINT)).toBe('driver');
    });

    it('recognises the asset index by name', () => {
      expect(identifyExclusivityConstraint(ACTIVE_ASSIGNMENT_ASSET_CONSTRAINT)).toBe('asset');
    });
  });

  describe('anything else', () => {
    it('falls through rather than guessing', () => {
      // A violation on some other unique index must not be reported as an
      // assignment conflict: telling a caller "this driver is busy" when the
      // real problem was elsewhere sends them to fix the wrong thing.
      expect(identifyExclusivityConstraint('client_reference')).toBe('other');
      expect(identifyExclusivityConstraint('')).toBe('other');
      expect(identifyExclusivityConstraint(undefined)).toBe('other');
    });
  });

  describe('dispatchable asset states', () => {
    it('permits only ACTIVE and IDLE', () => {
      expect(ACTIVE_ASSET_STATUSES).toEqual(['ACTIVE', 'IDLE']);
    });

    it('excludes ASSIGNED, so a stale replica cannot look like permission', () => {
      expect(ACTIVE_ASSET_STATUSES).not.toContain('ASSIGNED');
    });
  });
});
