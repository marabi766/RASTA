import { AUDIT_TRAIL_TOPIC, DLQ_REASONS, PRODUCER_NAME_PATTERN } from './envelope';
import {
  TOPIC_PRODUCERS,
  isAllowedProducer,
  isDeclaredTopic,
  ownerTopicOf,
  producersOf,
} from './topic-producers';

/**
 * ADR-061 § 1 — the topic → producer contract.
 *
 * Stated in full rather than sampled: this list is the platform's topology,
 * and a change to it is a change every consumer applies at once. A reviewer
 * should see the diff here.
 */
describe('TOPIC_PRODUCERS', () => {
  it('declares exactly the topics consumers subscribe to today, with their owners', () => {
    expect(TOPIC_PRODUCERS).toEqual({
      'rasta.identity.v1': ['identity-service'],
      'rasta.organization.v1': ['organization-service'],
      'rasta.asset.v1': ['asset-service'],
      'rasta.insurance.v1': ['asset-service'],
      'rasta.fleet.v1': ['fleet-service'],
      'rasta.maintenance.v1': ['maintenance-service'],
      'rasta.marketplace.v1': ['marketplace-service'],
      'rasta.economic.v1': ['economic-service'],
      'rasta.document.v1': ['document-service'],
      'rasta.supplier.v1': ['supplier-service'],
      'rasta.notification.v1': ['notification-service'],
      'rasta.construction.v1': ['construction-service'],
      [AUDIT_TRAIL_TOPIC]: ['identity-service'],
    });
  });

  it('gives every domain topic exactly one owner', () => {
    for (const [topic, producers] of Object.entries(TOPIC_PRODUCERS)) {
      if (topic === AUDIT_TRAIL_TOPIC) continue;
      expect([topic, producers.length]).toEqual([topic, 1]);
    }
  });

  it('is frozen, so no consumer can widen it at runtime', () => {
    expect(Object.isFrozen(TOPIC_PRODUCERS)).toBe(true);
    for (const producers of Object.values(TOPIC_PRODUCERS)) {
      expect(Object.isFrozen(producers)).toBe(true);
    }
  });

  it('declares no retry or dead-letter topic of its own', () => {
    expect(Object.keys(TOPIC_PRODUCERS).filter((t) => /\.(retry|dlq)$/.test(t))).toEqual([]);
  });

  it('names only producers a valid envelope can carry', () => {
    for (const producer of Object.values(TOPIC_PRODUCERS).flat()) {
      expect([producer, PRODUCER_NAME_PATTERN.test(producer)]).toEqual([producer, true]);
    }
  });

  it('has a dead-letter reason for a refusal', () => {
    expect(DLQ_REASONS.PRODUCER_NOT_ALLOWED).toBe('PRODUCER_NOT_ALLOWED');
  });
});

describe('isAllowedProducer', () => {
  it('allows the owner on its own topic', () => {
    expect(isAllowedProducer('rasta.marketplace.v1', 'marketplace-service')).toBe(true);
    expect(isAllowedProducer('rasta.insurance.v1', 'asset-service')).toBe(true);
    expect(isAllowedProducer(AUDIT_TRAIL_TOPIC, 'identity-service')).toBe(true);
  });

  it('refuses a real service on a topic it does not own', () => {
    expect(isAllowedProducer('rasta.marketplace.v1', 'economic-service')).toBe(false);
    expect(isAllowedProducer('rasta.supplier.v1', 'marketplace-service')).toBe(false);
    expect(isAllowedProducer(AUDIT_TRAIL_TOPIC, 'asset-service')).toBe(false);
  });

  it('refuses an unknown producer and an undeclared topic', () => {
    expect(isAllowedProducer('rasta.asset.v1', 'asset-servíce')).toBe(false);
    expect(isAllowedProducer('rasta.asset.v1', '')).toBe(false);
    expect(isAllowedProducer('rasta.procurement.v1', 'procurement-service')).toBe(false);
  });

  it('lists a topic’s producers, and none for an undeclared topic', () => {
    expect(producersOf('rasta.insurance.v1')).toEqual(['asset-service']);
    expect(producersOf('rasta.insurance.v1.retry')).toEqual(['asset-service']);
    expect(producersOf('rasta.procurement.v1')).toEqual([]);
    expect(producersOf('__proto__')).toEqual([]);
  });

  it('is not fooled by an inherited property name', () => {
    expect(isDeclaredTopic('toString')).toBe(false);
    expect(isAllowedProducer('constructor', 'asset-service')).toBe(false);
  });

  it('judges a retry topic by the topic it was retried from, and only that suffix', () => {
    expect(ownerTopicOf('rasta.asset.v1.retry')).toBe('rasta.asset.v1');
    expect(isAllowedProducer('rasta.asset.v1.retry', 'asset-service')).toBe(true);
    expect(isAllowedProducer('rasta.asset.v1.retry', 'fleet-service')).toBe(false);
    expect(ownerTopicOf('rasta.asset.v1.dlq')).toBe('rasta.asset.v1.dlq');
    expect(isDeclaredTopic('rasta.asset.v1.dlq')).toBe(false);
  });
});
