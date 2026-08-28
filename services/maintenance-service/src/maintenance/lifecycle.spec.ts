import { RastaError } from '@rasta/nest-common';
import {
  assertRepairOrderTransition,
  assertRequestTransition,
  canTransitionRepairOrder,
  canTransitionRequest,
  COSTABLE_REPAIR_ORDER_STATUSES,
  MAINTAINABLE_ASSET_STATUSES,
  OPEN_REQUEST_STATUSES,
  REPAIR_ORDER_STATUSES,
  REQUEST_STATUSES,
  type RepairOrderStatus,
  type RequestStatus,
} from './lifecycle';

/**
 * The transition tables are written as data so they can be walked, and this is
 * the walk. The point is not that each listed move works — it is that every
 * move *not* listed is refused, including the ones nobody thought about.
 */
describe('maintenance request lifecycle', () => {
  const LEGAL: [RequestStatus, RequestStatus][] = [
    ['OPEN', 'IN_PROGRESS'],
    ['OPEN', 'CANCELLED'],
    ['IN_PROGRESS', 'COMPLETED'],
    ['IN_PROGRESS', 'CANCELLED'],
    ['COMPLETED', 'APPROVED'],
    ['COMPLETED', 'CANCELLED'],
  ];

  it.each(LEGAL)('allows %s → %s', (from, to) => {
    expect(canTransitionRequest(from, to)).toBe(true);
    expect(() => assertRequestTransition(from, to)).not.toThrow();
  });

  it('refuses every move not in the table', () => {
    const legal = new Set(LEGAL.map(([from, to]) => `${from}->${to}`));

    for (const from of REQUEST_STATUSES) {
      for (const to of REQUEST_STATUSES) {
        if (from === to || legal.has(`${from}->${to}`)) continue;
        expect(canTransitionRequest(from, to)).toBe(false);
        expect(() => assertRequestTransition(from, to)).toThrow(RastaError);
      }
    }
  });

  it('makes approval terminal, because it authorises settlement', () => {
    // Reopening an approved request would leave economic-service holding an
    // authorisation for work the platform now says never happened.
    for (const to of REQUEST_STATUSES) {
      if (to === 'APPROVED') continue;
      expect(canTransitionRequest('APPROVED', to)).toBe(false);
    }

    expect(() => assertRequestTransition('APPROVED', 'CANCELLED')).toThrow(/authorises settlement/);
  });

  it('lets a completed request be rejected rather than approved', () => {
    // The owner disputing the bill is the whole point of the approval control.
    // Forcing them to approve work they reject would make it decorative.
    expect(canTransitionRequest('COMPLETED', 'CANCELLED')).toBe(true);
  });

  it('refuses a move to the same status, with a message that says so', () => {
    expect(() => assertRequestTransition('OPEN', 'OPEN')).toThrow(/already OPEN/);
  });

  it('reports a refusal as a conflict, not as a server error', () => {
    try {
      assertRequestTransition('CANCELLED', 'APPROVED');
      throw new Error('expected a refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(RastaError);
      expect((error as RastaError).code).toBe('INVALID_STATE_TRANSITION');
      expect((error as RastaError).status).toBe(409);
    }
  });

  it('counts only OPEN and IN_PROGRESS as live', () => {
    // This list is what the duplicate-request index is written against. If it
    // and the index ever disagree, the product document's duplicate control
    // stops meaning what it says.
    expect([...OPEN_REQUEST_STATUSES]).toEqual(['OPEN', 'IN_PROGRESS']);
  });
});

describe('repair order lifecycle', () => {
  const LEGAL: [RepairOrderStatus, RepairOrderStatus][] = [
    ['OPEN', 'IN_PROGRESS'],
    ['OPEN', 'CANCELLED'],
    ['IN_PROGRESS', 'COMPLETED'],
    ['IN_PROGRESS', 'CANCELLED'],
  ];

  it.each(LEGAL)('allows %s → %s', (from, to) => {
    expect(canTransitionRepairOrder(from, to)).toBe(true);
  });

  it('refuses every move not in the table', () => {
    const legal = new Set(LEGAL.map(([from, to]) => `${from}->${to}`));

    for (const from of REPAIR_ORDER_STATUSES) {
      for (const to of REPAIR_ORDER_STATUSES) {
        if (from === to || legal.has(`${from}->${to}`)) continue;
        expect(canTransitionRepairOrder(from, to)).toBe(false);
        expect(() => assertRepairOrderTransition(from, to)).toThrow(RastaError);
      }
    }
  });

  it('makes completion terminal, because its cost has been reported', () => {
    expect(() => assertRepairOrderTransition('COMPLETED', 'IN_PROGRESS')).toThrow(
      /cost has already been reported/,
    );
  });

  it('accepts cost only while the work is still live', () => {
    expect([...COSTABLE_REPAIR_ORDER_STATUSES]).toEqual(['OPEN', 'IN_PROGRESS']);
  });
});

describe('which machines may take on maintenance', () => {
  it('includes a machine already withdrawn from service', () => {
    // The difference from fleet-service's dispatchable list, and the reason
    // this one is not an import: a machine withdrawn from service is exactly
    // the one most likely to need repairing, and refusing to record work on it
    // would leave the repair that brings it back with nowhere to go.
    expect(MAINTAINABLE_ASSET_STATUSES).toContain('OUT_OF_SERVICE');
    expect(MAINTAINABLE_ASSET_STATUSES).toContain('IN_MAINTENANCE');
  });

  it('excludes a decommissioned machine, which has no way back', () => {
    expect(MAINTAINABLE_ASSET_STATUSES).not.toContain('DECOMMISSIONED');
  });
});
