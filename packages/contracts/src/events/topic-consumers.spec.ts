import { PRODUCER_NAME_PATTERN } from './envelope';
import { TOPIC_PRODUCERS, isDeclaredTopic } from './topic-producers';
import {
  TOPIC_CONSUMERS,
  consumerDeclarationProblem,
  consumerGroupService,
  isDeclaredConsumer,
} from './topic-consumers';

/**
 * RUN-006 — the read side of the topology, which the broker's ACLs are
 * generated from together with `TOPIC_PRODUCERS`.
 *
 * Stated in full, like `TOPIC_PRODUCERS`: a change here is a change to what
 * the broker lets a service read.
 */
describe('TOPIC_CONSUMERS', () => {
  it('declares exactly the subscriptions the services run today', () => {
    expect(TOPIC_CONSUMERS).toEqual({
      'identity-service': {
        subscribes: ['rasta.identity.v1'],
        deadLetterTopic: 'rasta.identity.v1.dlq',
      },
      'asset-service': {
        subscribes: [
          'rasta.fleet.v1',
          'rasta.maintenance.v1',
          'rasta.marketplace.v1',
          'rasta.construction.v1',
        ],
        deadLetterTopic: 'rasta.asset.v1.dlq',
      },
      'fleet-service': {
        subscribes: ['rasta.asset.v1', 'rasta.insurance.v1', 'rasta.maintenance.v1'],
        deadLetterTopic: 'rasta.fleet.v1.dlq',
      },
      'maintenance-service': {
        subscribes: ['rasta.fleet.v1', 'rasta.asset.v1'],
        deadLetterTopic: 'rasta.maintenance.v1.dlq',
      },
      'economic-service': {
        subscribes: ['rasta.maintenance.v1', 'rasta.fleet.v1'],
        deadLetterTopic: 'rasta.economic.v1.dlq',
      },
      'notification-service': {
        subscribes: ['rasta.insurance.v1', 'rasta.maintenance.v1'],
        deadLetterTopic: 'rasta.notification.v1.dlq',
      },
      // Q-83: an ORGANIZATION_MOVED re-checks the policies unions wrote. CON-002:
      // a contractor's qualification and suspension (SUPPLIER_*) are what a bid needs.
      'construction-service': {
        subscribes: ['rasta.organization.v1', 'rasta.supplier.v1'],
        deadLetterTopic: 'rasta.construction.v1.dlq',
      },
      // CON-003: the draft contract of an awarded tender (TENDER_AWARDED, confirmed by the owner).
      'contract-service': {
        subscribes: ['rasta.construction.v1'],
        deadLetterTopic: 'rasta.contract.v1.dlq',
      },
      'supplier-service': {
        subscribes: ['rasta.marketplace.v1'],
        deadLetterTopic: 'rasta.supplier.v1.dlq',
      },
      'audit-service': {
        subscribes: Object.keys(TOPIC_PRODUCERS),
        deadLetterTopic: 'rasta.audit.v1.dlq',
      },
    });
  });

  it('subscribes only to topics whose producer is declared', () => {
    for (const [service, { subscribes }] of Object.entries(TOPIC_CONSUMERS)) {
      for (const topic of subscribes)
        expect([service, topic, isDeclaredTopic(topic)]).toEqual([service, topic, true]);
    }
  });

  it('names consumers as services and gives each its own dead-letter topic', () => {
    const deadLetters = Object.values(TOPIC_CONSUMERS).map((entry) => entry.deadLetterTopic);
    expect(new Set(deadLetters).size).toBe(deadLetters.length);
    for (const [service, { deadLetterTopic }] of Object.entries(TOPIC_CONSUMERS)) {
      expect(service).toMatch(PRODUCER_NAME_PATTERN);
      expect(deadLetterTopic).toMatch(/^rasta\.[a-z]+(\.[a-z]+)*\.v\d+\.dlq$/);
      // A dead-letter topic is never a declared stream: nobody may publish
      // domain events on it, and nobody subscribes to it as one.
      expect(isDeclaredTopic(deadLetterTopic)).toBe(false);
    }
  });

  it('cannot be changed at run time', () => {
    expect(Object.isFrozen(TOPIC_CONSUMERS)).toBe(true);
    for (const entry of Object.values(TOPIC_CONSUMERS)) {
      expect(Object.isFrozen(entry)).toBe(true);
      expect(Object.isFrozen(entry.subscribes)).toBe(true);
    }
  });
});

describe('consumerGroupService', () => {
  it.each([
    ['fleet-service.asset-sync', 'fleet-service'],
    ['audit-service.domain-projector', 'audit-service'],
    ['notification-service.dispatcher.blue', 'notification-service'],
    ['fleet-itest-01J', undefined],
    ['.leading-dot', undefined],
  ])('%s → %s', (groupId, service) => {
    expect(consumerGroupService(groupId)).toBe(service);
  });
});

describe('consumerDeclarationProblem', () => {
  const fleet = {
    groupId: 'fleet-service.asset-sync',
    topics: ['rasta.asset.v1', 'rasta.insurance.v1', 'rasta.maintenance.v1'],
    deadLetterTopic: 'rasta.fleet.v1.dlq',
  };

  it('accepts a consumer exactly as declared', () => {
    expect(consumerDeclarationProblem('fleet-service', fleet)).toBeUndefined();
  });

  it('accepts a subset of the declared topics and their retry twins', () => {
    expect(
      consumerDeclarationProblem('fleet-service', {
        groupId: 'fleet-service.replay',
        topics: ['rasta.asset.v1.retry'],
        deadLetterTopic: 'rasta.fleet.v1.dlq',
      }),
    ).toBeUndefined();
  });

  it.each(Object.keys(TOPIC_CONSUMERS))(
    'refuses a %s consumer without its dead-letter topic: an unprocessable event would be lost',
    (service) => {
      const declared = TOPIC_CONSUMERS[service as keyof typeof TOPIC_CONSUMERS];
      expect(
        consumerDeclarationProblem(service, {
          groupId: `${service}.x`,
          topics: [declared.subscribes[0]!],
        }),
      ).toMatch(
        new RegExp(`must dead-letter to ${declared.deadLetterTopic.replace(/\./g, '\\.')}`),
      );
    },
  );

  it('refuses an undeclared service', () => {
    expect(
      consumerDeclarationProblem('marketplace-service', {
        ...fleet,
        groupId: 'marketplace-service.x',
      }),
    ).toMatch(/marketplace-service is not declared/);
    expect(isDeclaredConsumer('toString')).toBe(false);
  });

  it('refuses a group outside the service’s namespace', () => {
    expect(
      consumerDeclarationProblem('fleet-service', {
        ...fleet,
        groupId: 'economic-service.reward-trigger',
      }),
    ).toMatch(/outside fleet-service's namespace/);
    expect(
      consumerDeclarationProblem('fleet-service', { ...fleet, groupId: 'fleet-service' }),
    ).toMatch(/outside/);
  });

  it('refuses a topic the service does not declare, even one that exists', () => {
    expect(
      consumerDeclarationProblem('fleet-service', { ...fleet, topics: ['rasta.economic.v1'] }),
    ).toMatch(/does not declare a subscription to rasta\.economic\.v1/);
    expect(
      consumerDeclarationProblem('fleet-service', { ...fleet, topics: ['rasta.nowhere.v1'] }),
    ).toMatch(/rasta\.nowhere\.v1/);
  });

  it('refuses another dead-letter topic', () => {
    expect(
      consumerDeclarationProblem('fleet-service', {
        ...fleet,
        deadLetterTopic: 'rasta.asset.v1.dlq',
      }),
    ).toMatch(/dead-letters to rasta\.fleet\.v1\.dlq/);
  });
});
