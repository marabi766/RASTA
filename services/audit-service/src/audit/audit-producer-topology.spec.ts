import { AUDIT_TRAIL_TOPIC } from '@rasta/contracts';
import {
  AUDIT_DOMAIN_TOPIC_OWNERS,
  AUDIT_SOURCE_SERVICE_LABELS,
  AUDIT_SOURCE_SERVICES,
  AUDIT_TRAIL_PRODUCERS,
  AUDIT_UNKNOWN_SOURCE_SERVICE,
  domainSourceServiceLabel,
  isAuditSourceService,
  sourceTopicsOf,
  trailSourceServiceLabel,
} from './audit-producer-topology';
import { DOMAIN_TOPICS } from './audit.mapper';

/**
 * The closed producer topology every `source_service` label is derived from.
 *
 * Pinned exactly, value by value: a label set that grows by accident is how a
 * metrics endpoint turns into an unbounded index, and a topic whose owner is
 * wrong makes the silence alert watch the wrong service.
 */
describe('audit producer topology', () => {
  it('maps each of the twelve path-A topics to exactly its owning service', () => {
    expect(AUDIT_DOMAIN_TOPIC_OWNERS.map(({ topic, owner }) => [topic, owner])).toEqual([
      ['rasta.identity.v1', 'identity-service'],
      ['rasta.organization.v1', 'organization-service'],
      ['rasta.asset.v1', 'asset-service'],
      ['rasta.insurance.v1', 'asset-service'],
      ['rasta.fleet.v1', 'fleet-service'],
      ['rasta.maintenance.v1', 'maintenance-service'],
      ['rasta.marketplace.v1', 'marketplace-service'],
      ['rasta.economic.v1', 'economic-service'],
      ['rasta.document.v1', 'document-service'],
      ['rasta.supplier.v1', 'supplier-service'],
      // Added with NTF-002's audit events. Before them this service consumed
      // and never produced, so there was nothing on this topic to subscribe to.
      ['rasta.notification.v1', 'notification-service'],
      // Added with CON-001: construction-service's project and need events.
      ['rasta.construction.v1', 'construction-service'],
    ]);
  });

  it('is the source the subscription list is derived from, not a copy of it', () => {
    expect([...DOMAIN_TOPICS]).toEqual(AUDIT_DOMAIN_TOPIC_OWNERS.map((entry) => entry.topic));
    expect(new Set(DOMAIN_TOPICS).size).toBe(12);
    expect(DOMAIN_TOPICS).not.toContain(AUDIT_TRAIL_TOPIC);
  });

  it('names identity-service as the only known trail producer today', () => {
    expect([...AUDIT_TRAIL_PRODUCERS]).toEqual(['identity-service']);
  });

  it('deduplicates the known producers into eleven services', () => {
    expect([...AUDIT_SOURCE_SERVICES]).toEqual([
      'identity-service',
      'organization-service',
      'asset-service',
      'fleet-service',
      'maintenance-service',
      'marketplace-service',
      'economic-service',
      'document-service',
      'supplier-service',
      'notification-service',
      'construction-service',
    ]);
    expect(new Set(AUDIT_SOURCE_SERVICES).size).toBe(11);
  });

  it('pins the complete metric label set: eleven services and one fallback', () => {
    expect(AUDIT_UNKNOWN_SOURCE_SERVICE).toBe('unknown');
    expect([...AUDIT_SOURCE_SERVICE_LABELS]).toEqual([...AUDIT_SOURCE_SERVICES, 'unknown']);
    expect(AUDIT_SOURCE_SERVICE_LABELS).toHaveLength(12);
    expect(isAuditSourceService(AUDIT_UNKNOWN_SOURCE_SERVICE)).toBe(false);
  });

  it('is frozen all the way down', () => {
    expect(Object.isFrozen(AUDIT_DOMAIN_TOPIC_OWNERS)).toBe(true);
    for (const entry of AUDIT_DOMAIN_TOPIC_OWNERS) expect(Object.isFrozen(entry)).toBe(true);
    expect(Object.isFrozen(AUDIT_TRAIL_PRODUCERS)).toBe(true);
    expect(Object.isFrozen(AUDIT_SOURCE_SERVICES)).toBe(true);
    expect(Object.isFrozen(AUDIT_SOURCE_SERVICE_LABELS)).toBe(true);
    expect(Object.isFrozen(DOMAIN_TOPICS)).toBe(true);
  });

  describe('path-A label', () => {
    it.each(AUDIT_DOMAIN_TOPIC_OWNERS.map(({ topic, owner }) => [topic, owner]))(
      'keeps the real name when %s is produced by its owner %s',
      (topic, owner) => {
        expect(domainSourceServiceLabel(topic, owner)).toBe(owner);
      },
    );

    it.each([
      // A known service on a topic it does not own.
      ['rasta.asset.v1', 'identity-service'],
      ['rasta.identity.v1', 'asset-service'],
      ['rasta.insurance.v1', 'fleet-service'],
      // A trail producer claiming a domain topic it does not own.
      ['rasta.supplier.v1', 'identity-service'],
      // Arbitrary, near-miss and overlong producers.
      ['rasta.asset.v1', 'asset-service-v2'],
      ['rasta.asset.v1', 'Asset-Service'],
      ['rasta.asset.v1', ' asset-service'],
      ['rasta.asset.v1', 'unknown'],
      ['rasta.asset.v1', 'x'.repeat(128)],
      ['rasta.asset.v1', `asset-service${'x'.repeat(4096)}`],
      // A topic outside the topology, even with a known name.
      ['rasta.contract.v1', 'asset-service'],
      [AUDIT_TRAIL_TOPIC, 'identity-service'],
    ])('uses the fallback for topic %s and producer %s', (topic, producer) => {
      expect(domainSourceServiceLabel(topic, producer)).toBe('unknown');
    });
  });

  describe('path-B label', () => {
    it('keeps a known trail producer', () => {
      expect(trailSourceServiceLabel('identity-service')).toBe('identity-service');
    });

    it.each([
      ['asset-service'],
      ['organization-service'],
      ['audit-service'],
      ['IDENTITY-SERVICE'],
      ['unknown'],
      ['identity-service '],
      ['ORG_01J-tenant-looking-value'],
      ['y'.repeat(128)],
    ])('uses the fallback for producer %s', (producer) => {
      expect(trailSourceServiceLabel(producer)).toBe('unknown');
    });
  });

  it('lists the topics each producer contributes, for zero-seeding', () => {
    expect(sourceTopicsOf('identity-service')).toEqual(['rasta.identity.v1', AUDIT_TRAIL_TOPIC]);
    expect(sourceTopicsOf('asset-service')).toEqual(['rasta.asset.v1', 'rasta.insurance.v1']);
    expect(sourceTopicsOf('supplier-service')).toEqual(['rasta.supplier.v1']);
    expect(sourceTopicsOf('notification-service')).toEqual(['rasta.notification.v1']);
    expect(sourceTopicsOf('construction-service')).toEqual(['rasta.construction.v1']);
    expect(AUDIT_SOURCE_SERVICES.flatMap((service) => sourceTopicsOf(service))).toHaveLength(13);
    expect(Object.isFrozen(sourceTopicsOf('asset-service'))).toBe(true);
  });
});
