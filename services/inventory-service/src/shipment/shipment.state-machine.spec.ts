import { Prisma } from '../generated/prisma';
import { SHIPMENT_STATES } from './dto';
import { visibleTo } from './shipment.repository';
import { SHIPMENT_TRANSITIONS, SHIPMENT_VERSION_OF, canMove } from './shipment.state-machine';

describe('the shipment lifecycle (plan step 8, Q-114)', () => {
  it('goes CREATED → DISPATCHED → DELIVERED, one way, once each', () => {
    expect(canMove('CREATED', 'DISPATCHED')).toBe(true);
    expect(canMove('DISPATCHED', 'DELIVERED')).toBe(true);
    for (const from of SHIPMENT_STATES) {
      for (const to of SHIPMENT_STATES) {
        const allowed =
          (from === 'CREATED' && to === 'DISPATCHED') ||
          (from === 'DISPATCHED' && to === 'DELIVERED');
        expect([from, to, canMove(from, to)]).toEqual([from, to, allowed]);
      }
    }
  });

  it('never delivers what was not dispatched, and ends at DELIVERED', () => {
    expect(canMove('CREATED', 'DELIVERED')).toBe(false);
    expect(SHIPMENT_TRANSITIONS.DELIVERED).toEqual([]);
  });

  it('knows no state the documents have not decided (no FAILED, no CANCELLED)', () => {
    expect(Object.keys(SHIPMENT_TRANSITIONS)).toEqual([...SHIPMENT_STATES]);
    expect(SHIPMENT_STATES).toEqual(['CREATED', 'DISPATCHED', 'DELIVERED']);
  });

  it('numbers each status by its position, as the database does (ck_shipment_version_matches_status)', () => {
    expect(SHIPMENT_VERSION_OF).toEqual({ CREATED: 1, DISPATCHED: 2, DELIVERED: 3 });
  });
});

describe('who sees a shipment (ADR-056 § 5)', () => {
  const sqlOf = (sql: Prisma.Sql | null) =>
    sql === null ? null : { text: sql.sql.replace(/\s+/g, ' '), values: sql.values };
  const org = 'ORG_A';

  it('reads the owner’s side by organization_id and the consignee’s by consignee_organization_id', () => {
    expect(sqlOf(visibleTo({ organizationId: org, asOrigin: true, asConsignee: true }))).toEqual({
      text: '("organization_id" = ? OR "consignee_organization_id" = ?)',
      values: [org, org],
    });
    expect(sqlOf(visibleTo({ organizationId: org, asOrigin: true, asConsignee: false }))).toEqual({
      text: '("organization_id" = ?)',
      values: [org],
    });
    expect(sqlOf(visibleTo({ organizationId: org, asOrigin: false, asConsignee: true }))).toEqual({
      text: '("consignee_organization_id" = ?)',
      values: [org],
    });
  });

  it('narrows to the side asked for, and shows nothing when no side is open', () => {
    const both = { organizationId: org, asOrigin: true, asConsignee: true };
    expect(sqlOf(visibleTo(both, 'origin'))?.text).toBe('("organization_id" = ?)');
    expect(sqlOf(visibleTo(both, 'consignee'))?.text).toBe('("consignee_organization_id" = ?)');
    expect(visibleTo({ organizationId: org, asOrigin: false, asConsignee: true }, 'origin')).toBe(
      null,
    );
    expect(visibleTo({ organizationId: org, asOrigin: false, asConsignee: false })).toBe(null);
  });
});
