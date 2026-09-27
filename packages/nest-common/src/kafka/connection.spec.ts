import { Kafka } from 'kafkajs';
import { TOPIC_CONSUMERS } from '@rasta/contracts';
import {
  EventConsumer,
  type ConsumerLogger,
  type EventConsumerOptions,
} from '../consumer/event-consumer';
import {
  KafkaConnectionConfigError,
  kafkaClientConfig,
  kafkaConnection,
  kafkaConnectionFor,
  type KafkaConnectionEnv,
} from './connection';

/**
 * RUN-006 PR A: how a service reaches the broker. PLAINTEXT stays possible in
 * development and test until the local and CI brokers authenticate (PR B);
 * production refuses to start without its own credential and TLS.
 */
function env(overrides: Partial<KafkaConnectionEnv> = {}): KafkaConnectionEnv {
  return {
    NODE_ENV: 'development',
    SERVICE_NAME: 'fleet-service',
    KAFKA_BROKERS: 'kafka-1:9092, kafka-2:9092',
    KAFKA_SASL_MECHANISM: 'scram-sha-512',
    KAFKA_SSL: false,
    ...overrides,
  };
}

const credential = { KAFKA_SASL_USERNAME: 'fleet-service', KAFKA_SASL_PASSWORD: 'fleet-secret' };

describe('kafkaConnection', () => {
  it.each(['development', 'test'] as const)(
    'connects PLAINTEXT without a credential in %s',
    (NODE_ENV) => {
      expect(kafkaConnection(env({ NODE_ENV }), 'fleet-service')).toEqual({
        brokers: ['kafka-1:9092', 'kafka-2:9092'],
        clientId: 'fleet-service',
      });
    },
  );

  it.each([
    ['no credential and no TLS', {}],
    ['a credential without TLS', credential],
    ['TLS without a credential', { KAFKA_SSL: true }],
  ])('refuses to start in production with %s', (_label, overrides) => {
    expect(() =>
      kafkaConnection(env({ NODE_ENV: 'production', ...overrides }), 'fleet-service'),
    ).toThrow(KafkaConnectionConfigError);
  });

  it('connects in production with the service’s own credential over TLS pinned to its CA', () => {
    const connection = kafkaConnection(
      env({
        NODE_ENV: 'production',
        ...credential,
        KAFKA_SSL: true,
        KAFKA_SSL_CA_FILE: '/run/kafka/ca.pem',
      }),
      'fleet-service-asset-sync',
      (path) => `PEM from ${path}`,
    );

    expect(connection).toEqual({
      brokers: ['kafka-1:9092', 'kafka-2:9092'],
      clientId: 'fleet-service-asset-sync',
      sasl: { mechanism: 'scram-sha-512', username: 'fleet-service', password: 'fleet-secret' },
      ssl: { ca: ['PEM from /run/kafka/ca.pem'], rejectUnauthorized: true },
    });
  });

  it('trusts the system store when TLS has no CA file', () => {
    expect(kafkaConnection(env({ ...credential, KAFKA_SSL: true }), 'x').ssl).toBe(true);
  });

  it('uses a credential in development when one is set, so PR B needs no code change', () => {
    expect(kafkaConnection(env(credential), 'fleet-service').sasl?.username).toBe('fleet-service');
  });

  it('refuses another principal’s credential: it would publish on that service’s topics', () => {
    expect(() =>
      kafkaConnection(env({ ...credential, KAFKA_SASL_USERNAME: 'asset-service' }), 'x'),
    ).toThrow(/credential for another principal/);
  });

  it.each([
    ['a username without a password', { KAFKA_SASL_USERNAME: 'fleet-service' }],
    ['a password without a username', { KAFKA_SASL_PASSWORD: 'fleet-secret' }],
    ['a CA file without TLS', { KAFKA_SSL_CA_FILE: '/run/kafka/ca.pem' }],
    ['no broker', { KAFKA_BROKERS: ' , ' }],
  ])('refuses %s anywhere', (_label, overrides) => {
    expect(() => kafkaConnection(env(overrides), 'x')).toThrow(KafkaConnectionConfigError);
  });

  it('never puts the password in an error', () => {
    const error = (() => {
      try {
        kafkaConnection(env({ NODE_ENV: 'production', ...credential }), 'x');
      } catch (caught) {
        return caught as Error;
      }
      return undefined;
    })();
    expect(error?.message).not.toContain('fleet-secret');
  });
});

describe('kafkaConnectionFor', () => {
  it('connects as the named principal with its own password, over TLS when asked', () => {
    const connection = kafkaConnectionFor(
      'fleet-service',
      'fleet-itest',
      {
        KAFKA_BROKERS: 'localhost:9092',
        KAFKA_SASL_PASSWORD_FLEET: 'fleet-secret',
        KAFKA_SASL_PASSWORD_ASSET: 'asset-secret',
        KAFKA_SSL: 'true',
        KAFKA_SSL_CA_FILE: '/ca.pem',
      },
      () => 'PEM',
    );
    expect(connection).toEqual({
      brokers: ['localhost:9092'],
      clientId: 'fleet-itest',
      sasl: { mechanism: 'scram-sha-512', username: 'fleet-service', password: 'fleet-secret' },
      ssl: { ca: ['PEM'], rejectUnauthorized: true },
    });
  });

  it('is PLAINTEXT when the principal has no password', () => {
    expect(kafkaConnectionFor('itest-observer', 'x', { KAFKA_BROKERS: 'b:9092' })).toEqual({
      brokers: ['b:9092'],
      clientId: 'x',
    });
  });
});

describe('kafkaClientConfig', () => {
  it('leaves out what is not configured, so kafkajs connects PLAINTEXT', () => {
    expect(kafkaClientConfig({ brokers: ['b:9092'], clientId: 'c' })).toEqual({
      brokers: ['b:9092'],
      clientId: 'c',
    });
  });

  it('is accepted by kafkajs as it is', () => {
    const connection = kafkaConnection(env({ ...credential, KAFKA_SSL: true }), 'fleet-service');
    expect(() => new Kafka(kafkaClientConfig(connection))).not.toThrow();
  });
});

describe('EventConsumer and TOPIC_CONSUMERS', () => {
  const logger: ConsumerLogger = {
    log: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
  const handler = async () => undefined;
  const fleet: EventConsumerOptions = {
    brokers: ['localhost:9092'],
    clientId: 'fleet-service-asset-sync',
    groupId: 'fleet-service.asset-sync',
    topics: [...TOPIC_CONSUMERS['fleet-service'].subscribes] as string[],
    deadLetterTopic: TOPIC_CONSUMERS['fleet-service'].deadLetterTopic,
  };
  const sasl = { mechanism: 'scram-sha-512' as const, username: 'fleet-service', password: 'p' };
  const build = (options: EventConsumerOptions) => new EventConsumer(options, handler, logger);

  it('starts a consumer exactly as declared, with or without a credential', () => {
    expect(() => build(fleet)).not.toThrow();
    expect(() => build({ ...fleet, sasl })).not.toThrow();
  });

  it('refuses, in a declared namespace, a topic the service does not declare', () => {
    expect(() => build({ ...fleet, topics: ['rasta.economic.v1'] })).toThrow(
      /does not declare a subscription to rasta\.economic\.v1/,
    );
  });

  it('refuses, in a declared namespace, another dead-letter topic', () => {
    expect(() => build({ ...fleet, deadLetterTopic: 'rasta.asset.v1.dlq' })).toThrow(
      /dead-letters to rasta\.fleet\.v1\.dlq/,
    );
  });

  it('refuses an authenticated consumer whose group is in another service’s namespace', () => {
    expect(() =>
      build({
        ...fleet,
        groupId: 'economic-service.reward-trigger',
        topics: ['rasta.fleet.v1'],
        deadLetterTopic: 'rasta.economic.v1.dlq',
        sasl,
      }),
    ).toThrow(/outside fleet-service's namespace/);
  });

  it('refuses an authenticated consumer for a service with no declared subscription', () => {
    expect(() =>
      build({
        ...fleet,
        groupId: 'marketplace-service.orders',
        sasl: { ...sasl, username: 'marketplace-service' },
      }),
    ).toThrow(/marketplace-service is not declared/);
  });

  it('refuses, even unauthenticated, a service’s consumer that is not declared at all', () => {
    expect(() =>
      build({ ...fleet, groupId: 'contract-service.statements', topics: ['rasta.fleet.v1'] }),
    ).toThrow(/contract-service is not declared/);
  });

  it('leaves an unauthenticated group outside every declared namespace to the topic check alone', () => {
    expect(() =>
      build({ ...fleet, groupId: 'fleet-itest-01JABC', topics: ['rasta.economic.v1'] }),
    ).not.toThrow();
  });

  it('leaves a principal that is not a service to the broker ACLs', () => {
    // The development observer reads every topic under its own group prefix;
    // TOPIC_CONSUMERS does not describe it, broker-acls.json does.
    expect(() =>
      build({
        ...fleet,
        groupId: 'itest-observer.audit-trail-01JABC',
        topics: ['rasta.audit.trail.v1'],
        deadLetterTopic: undefined,
        sasl: { ...sasl, username: 'itest-observer' },
      }),
    ).not.toThrow();
    expect(() =>
      build({ ...fleet, groupId: 'itest-observer.x', sasl: { ...sasl, username: 'ops-service' } }),
    ).toThrow(/ops-service is not declared/);
  });
});
