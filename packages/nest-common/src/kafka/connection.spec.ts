import { inspect } from 'node:util';
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
 * RUN-006 PR A: how a service reaches the broker. Secure by default: without
 * its own credential and TLS a service refuses to start, unless PLAINTEXT is
 * explicitly allowed — `KAFKA_ALLOW_PLAINTEXT=true` in development or test.
 */
function env(overrides: Partial<KafkaConnectionEnv> = {}): KafkaConnectionEnv {
  return {
    NODE_ENV: 'development',
    SERVICE_NAME: 'fleet-service',
    KAFKA_BROKERS: 'kafka-1:9092, kafka-2:9092',
    KAFKA_SASL_MECHANISM: 'scram-sha-512',
    KAFKA_SSL: false,
    KAFKA_ALLOW_PLAINTEXT: false,
    ...overrides,
  };
}

const credential = { KAFKA_SASL_USERNAME: 'fleet-service', KAFKA_SASL_PASSWORD: 'fleet-secret' };
const plaintext = { KAFKA_ALLOW_PLAINTEXT: true };

describe('kafkaConnection', () => {
  it.each(['development', 'test'] as const)(
    'connects PLAINTEXT in %s with the explicit opt-out',
    (NODE_ENV) => {
      expect(kafkaConnection(env({ NODE_ENV, ...plaintext }), 'fleet-service')).toEqual({
        brokers: ['kafka-1:9092', 'kafka-2:9092'],
        clientId: 'fleet-service',
      });
    },
  );

  it.each(['development', 'test'] as const)(
    'refuses PLAINTEXT in %s without the opt-out: forgetting a variable fails closed',
    (NODE_ENV) => {
      expect(() => kafkaConnection(env({ NODE_ENV }), 'fleet-service')).toThrow(
        /refuses to reach Kafka without its SASL credential and TLS/,
      );
    },
  );

  it.each(['staging', 'production'] as const)(
    'refuses PLAINTEXT in %s, with the opt-out or without it',
    (NODE_ENV) => {
      expect(() => kafkaConnection(env({ NODE_ENV }), 'fleet-service')).toThrow(
        KafkaConnectionConfigError,
      );
      expect(() => kafkaConnection(env({ NODE_ENV, ...plaintext }), 'fleet-service')).toThrow(
        KafkaConnectionConfigError,
      );
    },
  );

  it.each(['development', 'test', 'staging', 'production'] as const)(
    'refuses in %s a credential without TLS, and TLS without a credential',
    (NODE_ENV) => {
      for (const overrides of [credential, { KAFKA_SSL: true }]) {
        expect(() => kafkaConnection(env({ NODE_ENV, ...overrides }), 'fleet-service')).toThrow(
          KafkaConnectionConfigError,
        );
      }
    },
  );

  it('names the variables to set, never a value', () => {
    expect(() => kafkaConnection(env({ NODE_ENV: 'staging' }), 'fleet-service')).toThrow(
      /KAFKA_SASL_PASSWORD.*KAFKA_SSL=true.*KAFKA_ALLOW_PLAINTEXT=true.*development or test/,
    );
  });

  it.each(['development', 'staging', 'production'] as const)(
    'connects in %s with the service’s own credential over TLS pinned to its CA',
    (NODE_ENV) => {
      const connection = kafkaConnection(
        env({
          NODE_ENV,
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
    },
  );

  it('trusts the system store when TLS has no CA file', () => {
    expect(kafkaConnection(env({ ...credential, KAFKA_SSL: true }), 'x').ssl).toBe(true);
  });

  it('uses a credential in development when one is set, opt-out or not', () => {
    const connection = kafkaConnection(env({ ...credential, ...plaintext }), 'fleet-service');
    expect(connection.sasl?.username).toBe('fleet-service');
  });

  it('refuses another principal’s credential: it would publish on that service’s topics', () => {
    expect(() =>
      kafkaConnection(
        env({ ...credential, KAFKA_SSL: true, KAFKA_SASL_USERNAME: 'asset-service' }),
        'x',
      ),
    ).toThrow(/credential for another principal/);
  });

  it.each([
    ['a username without a password', { KAFKA_SASL_USERNAME: 'fleet-service' }],
    ['a password without a username', { KAFKA_SASL_PASSWORD: 'fleet-secret' }],
    ['a CA file without TLS', { KAFKA_SSL_CA_FILE: '/run/kafka/ca.pem' }],
    ['no broker', { KAFKA_BROKERS: ' , ' }],
  ])('refuses %s anywhere', (_label, overrides) => {
    expect(() => kafkaConnection(env({ ...plaintext, ...overrides }), 'x')).toThrow(
      KafkaConnectionConfigError,
    );
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

/**
 * #385 r4: `SERVICE_NAME` passes its schema as any string (asset's loader keeps
 * an override), and the CA path is whatever was configured; each refusal is a
 * fixed text, and no part of the thrown error — stack, properties, what an
 * uncaught throw or the boot log's inspection prints — repeats either, in any
 * spelling.
 */
describe('kafkaConnection refusals repeat nothing that was configured', () => {
  const SENTINELS = ['private-sentinel-79', 'JZ97-another-secret'];
  const FRAGMENTS = /sentinel|jz97|another[-_]secret/i;
  const NO_CREDENTIAL =
    'This Kafka client refuses to reach Kafka without its SASL credential and TLS ' +
    '(KAFKA_SASL_PASSWORD or KAFKA_SASL_PASSWORD_<SERVICE>, and KAFKA_SSL=true). PLAINTEXT is ' +
    'allowed only with KAFKA_ALLOW_PLAINTEXT=true and NODE_ENV development or test (ADR-061 § 3)';
  const OTHER_PRINCIPAL =
    'KAFKA_SASL_USERNAME is not SERVICE_NAME: this process holds a Kafka credential for ' +
    'another principal; each service connects as itself';
  const UNREADABLE_CA =
    'KAFKA_SSL_CA_FILE cannot be read; with KAFKA_SSL=true it must name a readable file ' +
    "holding the broker's CA certificate";

  function refusalOf(connect: () => unknown): Error {
    try {
      connect();
    } catch (error) {
      return error as Error;
    }
    throw new Error('expected a refusal');
  }

  function expectFixed(error: Error, text: string): void {
    expect(error).toBeInstanceOf(KafkaConnectionConfigError);
    expect(error.message).toBe(text);
    expect(error.cause).toBeUndefined();
    const everything = [
      error.stack,
      JSON.stringify(error, Object.getOwnPropertyNames(error)),
      inspect(error, { depth: 10, showHidden: true }),
    ].join('\n');
    expect(everything).not.toMatch(FRAGMENTS);
  }

  it.each([
    ['credentials before the host', `${'private-sentinel-79'}:${'JZ97-another-secret'}@kafka:9092`],
    ['a scheme', `SASL_SSL://${'private-sentinel-79'}.example:9092`],
    ['no port', 'private-sentinel-79.example'],
    ['a path', 'kafka:9092/JZ97-another-secret'],
  ])('KAFKA_BROKERS with %s is refused before kafkajs could quote it (#385 r6)', (_, broker) => {
    expectFixed(
      refusalOf(() =>
        kafkaConnection(env({ ...plaintext, KAFKA_BROKERS: `kafka:9092,${broker}` }), 'x'),
      ),
      'KAFKA_BROKERS must list host:port entries, without a scheme or credentials; ' +
        'its value is not repeated',
    );
  });

  it('KAFKA_BROKERS of names, addresses and bracketed IPv6, with ports, connects', () => {
    expect(
      kafkaConnection(
        env({
          ...plaintext,
          KAFKA_BROKERS: 'kafka-1:9092, 10.0.0.7:19092,[::1]:9093,b.example.org:1',
        }),
        'x',
      ).brokers,
    ).toEqual(['kafka-1:9092', '10.0.0.7:19092', '[::1]:9093', 'b.example.org:1']);
  });

  it.each(SENTINELS)('without a credential and TLS, SERVICE_NAME=%s is not named', (sentinel) => {
    expectFixed(
      refusalOf(() =>
        kafkaConnection(env({ NODE_ENV: 'production', SERVICE_NAME: sentinel }), 'x'),
      ),
      NO_CREDENTIAL,
    );
    // The script and test-harness path: the principal stands in for SERVICE_NAME.
    expectFixed(
      refusalOf(() => kafkaConnectionFor(sentinel, 'x', { NODE_ENV: 'production' })),
      NO_CREDENTIAL,
    );
  });

  it.each(SENTINELS)('another principal’s credential: SERVICE_NAME=%s is not named', (sentinel) => {
    for (const names of [
      { SERVICE_NAME: sentinel, KAFKA_SASL_USERNAME: 'asset-service' },
      { SERVICE_NAME: 'asset-service', KAFKA_SASL_USERNAME: sentinel },
    ]) {
      expectFixed(
        refusalOf(() => kafkaConnection(env({ ...credential, KAFKA_SSL: true, ...names }), 'x')),
        OTHER_PRINCIPAL,
      );
    }
  });

  it.each(SENTINELS)('an unreadable CA file: the path %s is not repeated', (sentinel) => {
    const missing = `/nonexistent/${sentinel}/${sentinel.replaceAll('-', '_')}/ca.pem`;
    // The real filesystem read: its ENOENT names the path, on .message and .path.
    expectFixed(
      refusalOf(() =>
        kafkaConnection(env({ ...credential, KAFKA_SSL: true, KAFKA_SSL_CA_FILE: missing }), 'x'),
      ),
      UNREADABLE_CA,
    );
    expectFixed(
      refusalOf(() =>
        kafkaConnectionFor('fleet-service', 'x', {
          NODE_ENV: 'production',
          KAFKA_SASL_PASSWORD_FLEET: 'fleet-secret',
          KAFKA_SSL: 'true',
          KAFKA_SSL_CA_FILE: missing,
        }),
      ),
      UNREADABLE_CA,
    );
  });

  it('each check still refuses at the same point, and a valid configuration still connects', () => {
    // Positive controls: the same calls with valid settings return a connection.
    expect(
      kafkaConnection(
        env({ NODE_ENV: 'production', ...credential, KAFKA_SSL: true, KAFKA_SSL_CA_FILE: '/ca' }),
        'x',
        () => 'PEM',
      ),
    ).toMatchObject({
      sasl: { username: 'fleet-service' },
      ssl: { ca: ['PEM'], rejectUnauthorized: true },
    });
    expect(
      kafkaConnectionFor('itest-observer', 'x', {
        NODE_ENV: 'production',
        KAFKA_SASL_PASSWORD_ITEST_OBSERVER: 'observer-secret',
        KAFKA_SSL: 'true',
      }),
    ).toMatchObject({ sasl: { username: 'itest-observer' }, ssl: true });
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

  it('is PLAINTEXT without a password only with the explicit opt-out, in test', () => {
    const source = { KAFKA_BROKERS: 'b:9092', NODE_ENV: 'test', KAFKA_ALLOW_PLAINTEXT: 'true' };
    expect(kafkaConnectionFor('itest-observer', 'x', source)).toEqual({
      brokers: ['b:9092'],
      clientId: 'x',
    });
  });

  it.each([
    ['without the opt-out', { NODE_ENV: 'test' }],
    ['with NODE_ENV unset', { KAFKA_ALLOW_PLAINTEXT: 'true' }],
    ['in staging', { NODE_ENV: 'staging', KAFKA_ALLOW_PLAINTEXT: 'true' }],
    ['with an unknown NODE_ENV', { NODE_ENV: 'qa', KAFKA_ALLOW_PLAINTEXT: 'true' }],
  ])('refuses PLAINTEXT %s, as a service would', (_label, extra) => {
    expect(() =>
      kafkaConnectionFor('itest-observer', 'x', { KAFKA_BROKERS: 'b:9092', ...extra }),
    ).toThrow(KafkaConnectionConfigError);
  });
});

describe('kafkaClientConfig', () => {
  it('leaves out what is not configured, so kafkajs connects PLAINTEXT', () => {
    expect(kafkaClientConfig({ brokers: ['b:9092'], clientId: 'c' })).toEqual({
      brokers: ['b:9092'],
      clientId: 'c',
      logCreator: expect.any(Function),
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

  it('refuses to start a declared service’s consumer without its dead-letter topic', () => {
    // Codex review of #128, round 2: without one, an unprocessable event is
    // logged and committed past — lost.
    const { deadLetterTopic: _omitted, ...withoutDlq } = fleet;
    expect(() => build(withoutDlq)).toThrow(/must dead-letter to rasta\.fleet\.v1\.dlq/);
    expect(() => build({ ...withoutDlq, sasl })).toThrow(/must dead-letter to/);
    expect(() => build({ ...fleet, deadLetterTopic: undefined })).toThrow(/must dead-letter to/);
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
        groupId: 'organization-service.orders',
        sasl: { ...sasl, username: 'organization-service' },
      }),
    ).toThrow(/the consumer's service is not declared in TOPIC_CONSUMERS/);
  });

  it('refuses, even unauthenticated, a service’s consumer that is not declared at all', () => {
    expect(() =>
      build({ ...fleet, groupId: 'procurement-service.demand', topics: ['rasta.fleet.v1'] }),
    ).toThrow(/the consumer's service is not declared in TOPIC_CONSUMERS/);
  });

  it('leaves an unauthenticated group outside every declared namespace to the topic check alone', () => {
    expect(() =>
      build({ ...fleet, groupId: 'fleet-itest-01JABC', topics: ['rasta.economic.v1'] }),
    ).not.toThrow();
  });

  it('leaves a principal that is not a service to the broker ACLs', () => {
    // The development observer reads every topic under its own group prefix;
    // TOPIC_CONSUMERS does not describe it, broker-acls.development.json does.
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
    ).toThrow(/the consumer's service is not declared in TOPIC_CONSUMERS/);
  });

  // #385 r4: the group and an undeclared principal can come from the
  // environment (KAFKA_CONSUMER_GROUP, SERVICE_NAME); neither is named.
  it.each(['private-sentinel-79', 'JZ97-another-secret'])(
    'names neither a configured group nor an undeclared principal (%s)',
    (sentinel) => {
      const fragments = /sentinel|jz97|another[-_]secret/i;
      const refusals = [
        { ...fleet, groupId: `${sentinel}.x`, topics: ['rasta.unknown.v1'] },
        { ...fleet, groupId: `fleet-service.${sentinel}`, topics: ['rasta.economic.v1'] },
        { ...fleet, groupId: `${sentinel}.x`, sasl },
        { ...fleet, groupId: `${sentinel}-service.x` },
        { ...fleet, sasl: { ...sasl, username: `${sentinel}-service` } },
      ].map((options) => {
        try {
          build(options);
        } catch (error) {
          return error as Error;
        }
        throw new Error(`not refused: ${options.groupId}`);
      });
      for (const error of refusals) {
        expect(
          [error.stack, inspect(error, { depth: 10, showHidden: true })].join('\n'),
        ).not.toMatch(fragments);
      }
      // Positive control: the declared consumer still starts.
      expect(() => build({ ...fleet, sasl })).not.toThrow();
    },
  );
});
