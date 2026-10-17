import { RETURN_SHIPMENT_STATES, type ReturnShipmentStatus } from './dto';
import {
  RETURN_SHIPMENT_TRANSITIONS,
  RETURN_SHIPMENT_VERSION_OF,
  canMove,
} from './return-shipment.state-machine';

describe('the return shipment lifecycle (ADR-048 § 3, physical half)', () => {
  const pairs = RETURN_SHIPMENT_STATES.flatMap((from) =>
    RETURN_SHIPMENT_STATES.map((to) => [from, to] as [ReturnShipmentStatus, ReturnShipmentStatus]),
  );
  const EDGES = new Set(['IN_TRANSIT>RECEIVED', 'RECEIVED>INSPECTED', 'INSPECTED>RESOLVED']);

  it.each(pairs)('%s → %s', (from, to) => {
    // The three consecutive steps are the only edges there are.
    expect(canMove(from, to)).toBe(EDGES.has(`${from}>${to}`));
  });

  it('has no way out of RESOLVED, no way back, and no skipped step', () => {
    expect(RETURN_SHIPMENT_TRANSITIONS.RESOLVED).toEqual([]);
    expect(canMove('RESOLVED', 'INSPECTED')).toBe(false);
    expect(canMove('INSPECTED', 'RECEIVED')).toBe(false);
    expect(canMove('IN_TRANSIT', 'INSPECTED')).toBe(false);
    expect(canMove('RECEIVED', 'RESOLVED')).toBe(false);
  });

  it('gives each status the one version the database requires of it', () => {
    expect(RETURN_SHIPMENT_VERSION_OF).toEqual({
      IN_TRANSIT: 1,
      RECEIVED: 2,
      INSPECTED: 3,
      RESOLVED: 4,
    });
  });

  it('has no refund, no restock and no commercial state: those are not this service’s to move', () => {
    expect([...RETURN_SHIPMENT_STATES]).toEqual([
      'IN_TRANSIT',
      'RECEIVED',
      'INSPECTED',
      'RESOLVED',
    ]);
  });
});
