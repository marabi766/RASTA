import { FLEET_EVENTS, FLEET_EVENT_SCHEMAS, validateFleetPayload } from './events';

/**
 * Contract tests for the events this service publishes.
 *
 * These are not "does zod work" tests. Each one pins a property another
 * service already depends on, and would otherwise only discover in production
 * — in asset-service's case, by silently dropping the event.
 */
describe('fleet event contracts', () => {
  it('publishes exactly the catalogued names', () => {
    // The names come from docs/events/README.md § Fleet, not from here. A
    // typo would produce an event no consumer has a projection for, which
    // fails silently: the projector skips what it does not recognise.
    expect(Object.keys(FLEET_EVENT_SCHEMAS).sort()).toEqual([
      'ASSET_ASSIGNED',
      'ASSIGNMENT_ENDED',
      'AVAILABILITY_CHANGED',
      'DRIVER_REGISTERED',
      'DRIVER_STATUS_CHANGED',
      'USAGE_RECORDED',
    ]);
  });

  it('names every event in SCREAMING_SNAKE_CASE past tense', () => {
    // The envelope schema enforces the casing; this pins the convention at the
    // point the names are defined, where a mistake is cheap to fix.
    for (const name of Object.values(FLEET_EVENTS)) {
      expect(name).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
  });

  describe('events asset-service projects onto the dossier', () => {
    // asset-service's TimelineConsumer requires `assetId` on every event it
    // projects — its `timelineSourceSchema` skips anything without one. These
    // three appear in its PROJECTIONS table by name, so omitting `assetId`
    // would mean the dossier silently never records them.
    it.each([
      [FLEET_EVENTS.ASSET_ASSIGNED],
      [FLEET_EVENTS.ASSIGNMENT_ENDED],
      [FLEET_EVENTS.USAGE_RECORDED],
    ])('%s requires assetId', (eventName) => {
      const schema = FLEET_EVENT_SCHEMAS[eventName];
      expect(schema.safeParse({}).success).toBe(false);

      const shape = (schema as unknown as { shape: Record<string, unknown> }).shape;
      expect(Object.keys(shape)).toContain('assetId');
    });

    it('ASSIGNMENT_ENDED carries assetId even though the catalogue summary omits it', () => {
      // The catalogue's "key payload" column lists only assignmentId and
      // endedAt. Following it literally would leave asset-service unable to
      // attach the entry to anything: the projection ASSIGNMENT_ENDED -> ACTIVE
      // would never fire and every released machine would stay ASSIGNED.
      const payload = {
        assignmentId: 'ASG_01JBQ8Z4K7M2N5P8R1T3V6X9Y2',
        assetId: 'AST_01JBQ8Z4K7M2N5P8R1T3V6X9Y2',
        driverId: 'DRV_01JBQ8Z4K7M2N5P8R1T3V6X9Y2',
        organizationId: 'ORG-DEH-0001',
        startedAt: '2026-08-27T08:00:00.000Z',
        endedAt: '2026-08-27T16:00:00.000Z',
        reason: 'COMPLETED',
      };
      expect(() => validateFleetPayload(FLEET_EVENTS.ASSIGNMENT_ENDED, payload)).not.toThrow();

      const { assetId: _dropped, ...withoutAsset } = payload;
      expect(() => validateFleetPayload(FLEET_EVENTS.ASSIGNMENT_ENDED, withoutAsset)).toThrow();
    });
  });

  describe('USAGE_RECORDED', () => {
    const valid = {
      usageRecordId: 'USG_01JBQ8Z4K7M2N5P8R1T3V6X9Y2',
      assetId: 'AST_01JBQ8Z4K7M2N5P8R1T3V6X9Y2',
      organizationId: 'ORG-DEH-0001',
      driverId: null,
      assignmentId: null,
      periodStart: '2026-08-27T08:00:00.000Z',
      periodEnd: '2026-08-27T16:00:00.000Z',
      hours: '7.50',
      kilometres: null,
      hourMeter: '1240.50',
      odometer: null,
      source: 'MANUAL',
    };

    it('accepts a complete reading', () => {
      expect(() => validateFleetPayload(FLEET_EVENTS.USAGE_RECORDED, valid)).not.toThrow();
    });

    it('carries quantities as strings, never numbers', () => {
      // The column is NUMERIC precisely because a float cannot hold these
      // exactly. maintenance-service accumulates hours off this event to
      // decide when a service is due, so drift here eventually means a machine
      // that missed one (ADR-022 applies the same reasoning to money).
      expect(() =>
        validateFleetPayload(FLEET_EVENTS.USAGE_RECORDED, { ...valid, hours: 7.5 }),
      ).toThrow();
    });

    it('distinguishes a delta from a meter reading', () => {
      // Both are carried, and they mean different things: `hours` is what was
      // consumed in the period, `hourMeter` is what the instrument now shows.
      const shape = (
        FLEET_EVENT_SCHEMAS.USAGE_RECORDED as unknown as { shape: Record<string, unknown> }
      ).shape;
      expect(Object.keys(shape)).toEqual(expect.arrayContaining(['hours', 'hourMeter']));
      expect(Object.keys(shape)).toEqual(expect.arrayContaining(['kilometres', 'odometer']));
    });

    it('requires nullable fields to be present as null, not absent', () => {
      // `undefined` versus `null` is a documented source of consumer bugs
      // (docs/07 § 7.3): a consumer reading `payload.driverId` must find the
      // key, whether or not a driver was named.
      const { driverId: _absent, ...missingKey } = valid;
      expect(() => validateFleetPayload(FLEET_EVENTS.USAGE_RECORDED, missingKey)).toThrow();
    });
  });

  describe('payloads carry identifiers, not personal data', () => {
    it('DRIVER_REGISTERED does not put licence details on the log', () => {
      // The event lives in a durable log every service reads and retains for
      // days. A licence number sitting there has no consumer and is a privacy
      // liability (docs/07 § 7.3).
      const shape = (
        FLEET_EVENT_SCHEMAS.DRIVER_REGISTERED as unknown as { shape: Record<string, unknown> }
      ).shape;
      const keys = Object.keys(shape);
      expect(keys).toEqual(['driverId', 'organizationId', 'userId', 'status']);
      expect(keys).not.toContain('licenceNumber');
      expect(keys).not.toContain('employeeNo');
    });
  });

  describe('tenant context', () => {
    it.each(Object.values(FLEET_EVENTS))('%s carries organizationId in the payload', (name) => {
      // The envelope carries `tenantId` too, but a consumer building a local
      // replica reads the payload. Both agreeing is what makes the replica
      // placeable in an organization.
      const shape = (FLEET_EVENT_SCHEMAS[name] as unknown as { shape: Record<string, unknown> })
        .shape;
      expect(Object.keys(shape)).toContain('organizationId');
    });
  });
});
