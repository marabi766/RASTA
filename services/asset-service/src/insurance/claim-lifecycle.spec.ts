import { RastaError } from '@rasta/nest-common';
import { CLAIM_STATUSES, type ClaimStatus } from '../asset/dto';
import { CLAIM_TRANSITIONS, assertClaimTransition, canTransitionClaim } from './claim-lifecycle';

/**
 * The claim state machine, pinned edge by edge.
 *
 * The table is small enough to enumerate completely, which is the point: a
 * transition that is not listed here is refused, and a future status added to
 * the enum without a row in the table fails to compile.
 */
describe('claim lifecycle', () => {
  const allowed: Array<[ClaimStatus, ClaimStatus]> = [
    ['SUBMITTED', 'UNDER_REVIEW'],
    ['UNDER_REVIEW', 'APPROVED'],
    ['UNDER_REVIEW', 'REJECTED'],
    ['APPROVED', 'SETTLED'],
  ];

  it('allows exactly the four documented edges', () => {
    const edges: Array<[ClaimStatus, ClaimStatus]> = [];
    for (const from of CLAIM_STATUSES) {
      for (const to of CLAIM_STATUSES) {
        if (canTransitionClaim(from, to)) edges.push([from, to]);
      }
    }
    expect(edges.sort()).toEqual([...allowed].sort());
  });

  it('has a row for every status, so no status is silently unreachable or stuck by omission', () => {
    expect(Object.keys(CLAIM_TRANSITIONS).sort()).toEqual([...CLAIM_STATUSES].sort());
  });

  it('refuses to decide a claim that nobody has taken under review', () => {
    // Deciding straight from SUBMITTED would leave no record that anyone
    // looked at the file before the money question was answered.
    expect(() => assertClaimTransition('SUBMITTED', 'APPROVED')).toThrow(
      /decided only after its review has been started/,
    );
    expect(() => assertClaimTransition('SUBMITTED', 'REJECTED')).toThrow(RastaError);
  });

  it('treats REJECTED and SETTLED as final', () => {
    for (const to of CLAIM_STATUSES) {
      expect(canTransitionClaim('REJECTED', to)).toBe(false);
      expect(canTransitionClaim('SETTLED', to)).toBe(false);
    }
    expect(() => assertClaimTransition('SETTLED', 'APPROVED')).toThrow(/final/);
  });

  it('refuses settlement of a claim that was not approved', () => {
    // A SETTLED claim is a financial fact; it must rest on an explicit approval.
    expect(() => assertClaimTransition('UNDER_REVIEW', 'SETTLED')).toThrow(RastaError);
    expect(() => assertClaimTransition('REJECTED', 'SETTLED')).toThrow(RastaError);
  });

  it('reports the platform error code, not a bare Error', () => {
    try {
      assertClaimTransition('APPROVED', 'REJECTED');
      throw new Error('expected a refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(RastaError);
      expect((error as RastaError).code).toBe('INVALID_STATE_TRANSITION');
    }
  });
});
