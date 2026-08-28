import { assertDriverTransition, canTransition, isAssignable } from './driver-lifecycle';
import { isRastaError } from '@rasta/nest-common';

describe('driver lifecycle', () => {
  describe('legal transitions', () => {
    it('suspends and reinstates an active driver', () => {
      expect(canTransition('ACTIVE', 'SUSPENDED')).toBe(true);
      expect(canTransition('SUSPENDED', 'ACTIVE')).toBe(true);
    });

    it('deactivates from either working state', () => {
      expect(canTransition('ACTIVE', 'DEACTIVATED')).toBe(true);
      expect(canTransition('SUSPENDED', 'DEACTIVATED')).toBe(true);
    });
  });

  describe('DEACTIVATED is terminal', () => {
    // Assignment and usage history reference the driver row, so it is never
    // deleted. Reinstating someone who left means a new driver record, which
    // is what the paperwork does too.
    it.each(['ACTIVE', 'SUSPENDED'] as const)('refuses DEACTIVATED -> %s', (target) => {
      expect(canTransition('DEACTIVATED', target)).toBe(false);
      expect(() => assertDriverTransition('DEACTIVATED', target)).toThrow();
    });

    it('explains that a new record is the way back', () => {
      try {
        assertDriverTransition('DEACTIVATED', 'ACTIVE');
        throw new Error('expected a refusal');
      } catch (error) {
        expect(isRastaError(error)).toBe(true);
        expect((error as Error).message).toContain('register a new driver record');
      }
    });
  });

  it('refuses a transition to the state already held', () => {
    // Not a no-op: a "suspend" that silently succeeds against an already
    // suspended driver would report a second suspension that never happened,
    // and publish an event saying so.
    expect(() => assertDriverTransition('ACTIVE', 'ACTIVE')).toThrow(/already ACTIVE/);
  });

  it('reports the platform error code, not an HTTP status', () => {
    try {
      assertDriverTransition('DEACTIVATED', 'ACTIVE');
      throw new Error('expected a refusal');
    } catch (error) {
      expect(isRastaError(error)).toBe(true);
      expect((error as { code: string }).code).toBe('INVALID_STATE_TRANSITION');
      expect((error as { status: number }).status).toBe(409);
    }
  });

  describe('assignability', () => {
    it('permits a new assignment only while ACTIVE', () => {
      expect(isAssignable('ACTIVE')).toBe(true);
      expect(isAssignable('SUSPENDED')).toBe(false);
      expect(isAssignable('DEACTIVATED')).toBe(false);
    });
  });
});
