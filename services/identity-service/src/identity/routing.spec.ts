import { AUDIT_EVENT_RECORDED, AUDIT_TRAIL_TOPIC } from '@rasta/contracts';
import { IDENTITY_EVENTS } from './events';
import {
  PARTITION_SCOPE_OF,
  PRODUCED_EVENTS,
  assertTopicFor,
  resolvePartitionKey,
} from './routing';

/**
 * Routing after AUD-003 correction: identity's own events are exactly as they were, and
 * the one audit-trail event the correction command produces has an explicit,
 * separate decision.
 */

describe('identity outbox routing', () => {
  it('decides a scope for every identity event, plus the correction, and nothing else', () => {
    expect(Object.keys(PARTITION_SCOPE_OF).sort()).toEqual(
      [...PRODUCED_EVENTS, AUDIT_EVENT_RECORDED].sort(),
    );
  });

  it('keeps every identity domain event aggregate-scoped, unchanged', () => {
    for (const eventName of PRODUCED_EVENTS) {
      expect(resolvePartitionKey(eventName, 'USR-1')).toEqual({ scope: 'AGGREGATE', key: 'USR-1' });
    }
  });

  it('never makes the correction an identity domain event', () => {
    expect(Object.values(IDENTITY_EVENTS)).not.toContain(AUDIT_EVENT_RECORDED);
    expect(PRODUCED_EVENTS).not.toContain(AUDIT_EVENT_RECORDED);
  });

  it('orders a correction by the record it corrects', () => {
    expect(resolvePartitionKey(AUDIT_EVENT_RECORDED, '01JAUDIT0000000000000001')).toEqual({
      scope: 'AUDIT_TARGET',
      key: '01JAUDIT0000000000000001',
    });
  });

  it('refuses a correction with no target to key it by', () => {
    expect(() => resolvePartitionKey(AUDIT_EVENT_RECORDED, '')).toThrow(/empty partition key/);
  });

  describe('assertTopicFor', () => {
    it('allows the correction on the trail topic, and identity events on theirs', () => {
      expect(() => assertTopicFor(AUDIT_EVENT_RECORDED, AUDIT_TRAIL_TOPIC)).not.toThrow();
      expect(() => assertTopicFor(IDENTITY_EVENTS.USER_UPDATED, 'rasta.identity.v1')).not.toThrow();
    });

    it('refuses the correction anywhere but the trail topic', () => {
      expect(() => assertTopicFor(AUDIT_EVENT_RECORDED, 'rasta.identity.v1')).toThrow();
    });

    it('refuses any identity domain event on the trail topic', () => {
      for (const eventName of PRODUCED_EVENTS) {
        expect(() => assertTopicFor(eventName, AUDIT_TRAIL_TOPIC)).toThrow();
      }
    });
  });
});
