import { readFileSync } from 'node:fs';
import type { KafkaConfig } from 'kafkajs';
import {
  KAFKA_PLAINTEXT_ENVIRONMENTS,
  NODE_ENVS,
  kafkaPasswordVariable,
  kafkaPlaintextAllowed,
  kafkaSaslConfigured,
  type BaseEnv,
  type KafkaEnv,
} from '@rasta/config';

/**
 * How every Kafka client on the platform reaches the broker (ADR-061 § 3,
 * RUN-006): the outbox publishers, `EventConsumer` and its dead-letter
 * producer. One place, so a service cannot authenticate its publisher and
 * forget its consumer.
 *
 * Utility only: it reads the environment, checks it is coherent, and returns
 * the connection. What a principal may do on the broker is the ACLs', not
 * this code's.
 */
export interface KafkaConnectionOptions {
  brokers: string[];
  clientId: string;
  /** SCRAM credential of the service's own principal; absent = PLAINTEXT. */
  sasl?: { mechanism: KafkaEnv['KAFKA_SASL_MECHANISM']; username: string; password: string };
  /** `true` trusts the system store; `{ ca }` pins the broker's CA. */
  ssl?: true | { ca: string[]; rejectUnauthorized: true };
}

export type KafkaConnectionEnv = Pick<BaseEnv, 'NODE_ENV' | 'SERVICE_NAME'> &
  Pick<
    KafkaEnv,
    | 'KAFKA_BROKERS'
    | 'KAFKA_SASL_USERNAME'
    | 'KAFKA_SASL_PASSWORD'
    | 'KAFKA_SASL_MECHANISM'
    | 'KAFKA_SSL'
    | 'KAFKA_SSL_CA_FILE'
    | 'KAFKA_ALLOW_PLAINTEXT'
  >;

export class KafkaConnectionConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KafkaConnectionConfigError';
  }
}

/**
 * The connection for one client of this service.
 *
 * Refuses, at startup (the providers that call it are built at boot):
 *   - a service without its SASL credential and TLS, unless PLAINTEXT is
 *     explicitly allowed: `KAFKA_ALLOW_PLAINTEXT=true` with `NODE_ENV`
 *     `development` or `test` (`kafkaPlaintextAllowed`). Secure by default —
 *     `staging`, `production` and a forgotten variable all fail closed. A
 *     deployment in which anyone who reaches the broker can publish as this
 *     service is the gap ADR-061 § 3 makes a gate;
 *   - anywhere, a username without a password, a credential issued to a
 *     principal other than this service, and a CA file without TLS — each a
 *     configuration that does not do what it looks like it does.
 *
 * The messages name variables, never their values.
 */
export function kafkaConnection(
  env: KafkaConnectionEnv,
  clientId: string,
  readFile: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): KafkaConnectionOptions {
  const brokers = env.KAFKA_BROKERS.split(',')
    .map((broker) => broker.trim())
    .filter((broker) => broker.length > 0);
  if (brokers.length === 0) throw new KafkaConnectionConfigError('KAFKA_BROKERS names no broker');

  if (Boolean(env.KAFKA_SASL_USERNAME) !== Boolean(env.KAFKA_SASL_PASSWORD)) {
    throw new KafkaConnectionConfigError(
      'KAFKA_SASL_USERNAME and KAFKA_SASL_PASSWORD are set together or not at all',
    );
  }
  if (env.KAFKA_SSL_CA_FILE && !env.KAFKA_SSL) {
    throw new KafkaConnectionConfigError('KAFKA_SSL_CA_FILE is set but KAFKA_SSL is not true');
  }
  if (!kafkaPlaintextAllowed(env) && !(kafkaSaslConfigured(env) && env.KAFKA_SSL)) {
    throw new KafkaConnectionConfigError(
      `${env.SERVICE_NAME} refuses to reach Kafka without its SASL credential and TLS ` +
        '(KAFKA_SASL_PASSWORD or KAFKA_SASL_PASSWORD_<SERVICE>, and KAFKA_SSL=true). PLAINTEXT is ' +
        `allowed only with KAFKA_ALLOW_PLAINTEXT=true and NODE_ENV ${KAFKA_PLAINTEXT_ENVIRONMENTS.join(' or ')} ` +
        '(ADR-061 § 3)',
    );
  }

  const connection: KafkaConnectionOptions = { brokers, clientId };

  if (kafkaSaslConfigured(env)) {
    const username = env.KAFKA_SASL_USERNAME as string;
    if (username !== env.SERVICE_NAME) {
      // Another service's credential would let this one publish on that
      // service's topics, with the broker's blessing.
      throw new KafkaConnectionConfigError(
        `${env.SERVICE_NAME} holds a Kafka credential for another principal; ` +
          'each service connects as itself',
      );
    }
    connection.sasl = {
      mechanism: env.KAFKA_SASL_MECHANISM,
      username,
      password: env.KAFKA_SASL_PASSWORD as string,
    };
  }

  if (env.KAFKA_SSL) {
    connection.ssl = env.KAFKA_SSL_CA_FILE
      ? { ca: [readFile(env.KAFKA_SSL_CA_FILE)], rejectUnauthorized: true }
      : true;
  }

  return connection;
}

/**
 * The fields of a {@link KafkaConnectionOptions} that `new Kafka(...)` takes,
 * with the absent ones left out rather than set to `undefined`.
 */
export function kafkaClientConfig(
  connection: KafkaConnectionOptions,
): Pick<KafkaConfig, 'brokers' | 'clientId' | 'sasl' | 'ssl'> {
  return {
    clientId: connection.clientId,
    brokers: connection.brokers,
    ...(connection.sasl ? { sasl: { ...connection.sasl } } : {}),
    ...(connection.ssl ? { ssl: connection.ssl } : {}),
  };
}

/**
 * The connection for a named principal, from the environment: for a test
 * harness or a script that acts as one service (publishing on the topic that
 * service owns) or as the development observer, never for a service itself —
 * a service reads its own configuration through {@link kafkaConnection}.
 *
 * The password is `KAFKA_SASL_PASSWORD_<PRINCIPAL>` (`fleet-service` →
 * `..._FLEET`, `itest-observer` → `..._ITEST_OBSERVER`); without one the
 * connection is PLAINTEXT, which is refused unless `KAFKA_ALLOW_PLAINTEXT=true`
 * with `NODE_ENV` development or test — the rule a service follows.
 * `KAFKA_SSL` and `KAFKA_SSL_CA_FILE` as for a service.
 */
export function kafkaConnectionFor(
  principal: string,
  clientId: string,
  source: NodeJS.ProcessEnv = process.env,
  readFile?: (path: string) => string,
): KafkaConnectionOptions {
  const password = source[kafkaPasswordVariable(principal)] || undefined;
  const flag = (value: string | undefined) => /^(true|1|yes|on)$/i.test((value ?? '').trim());
  const given = source.NODE_ENV?.trim();
  return kafkaConnection(
    {
      // Unset or unknown reads as production: PLAINTEXT is refused, as for a service.
      NODE_ENV: (NODE_ENVS as readonly string[]).includes(given ?? '')
        ? (given as BaseEnv['NODE_ENV'])
        : 'production',
      SERVICE_NAME: principal,
      KAFKA_BROKERS: source.KAFKA_BROKERS || 'localhost:9092',
      KAFKA_SASL_USERNAME: password ? principal : undefined,
      KAFKA_SASL_PASSWORD: password,
      KAFKA_SASL_MECHANISM: 'scram-sha-512',
      KAFKA_SSL: flag(source.KAFKA_SSL),
      KAFKA_SSL_CA_FILE: source.KAFKA_SSL_CA_FILE || undefined,
      KAFKA_ALLOW_PLAINTEXT: flag(source.KAFKA_ALLOW_PLAINTEXT),
    },
    clientId,
    readFile,
  );
}
