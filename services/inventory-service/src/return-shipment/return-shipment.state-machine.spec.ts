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

  it.each(pairs)('%s → %s', (from, to) => {
    // IN_TRANSIT → RECEIVED is the only edge there is.
    expect(canMove(from, to)).toBe(from === 'IN_TRANSIT' && to === 'RECEIVED');
  });

  it('has no way out of RECEIVED, and none back to IN_TRANSIT', () => {
    expect(RETURN_SHIPMENT_TRANSITIONS.RECEIVED).toEqual([]);
    expect(canMove('RECEIVED', 'IN_TRANSIT')).toBe(false);
  });

  it('gives each status the one version the database requires of it', () => {
    expect(RETURN_SHIPMENT_VERSION_OF).toEqual({ IN_TRANSIT: 1, RECEIVED: 2 });
  });

  it('has no refund, no restock and no commercial state: those are not this service’s to move', () => {
    expect([...RETURN_SHIPMENT_STATES]).toEqual(['IN_TRANSIT', 'RECEIVED']);
  });
});
