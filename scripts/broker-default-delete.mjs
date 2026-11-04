// Test-only Kafka 3.9 IncrementalAlterConfigs v0, API 44. KafkaJS 2.2 has no
// public incremental API. Use its pinned transport/codecs; never fall back to
// AlterConfigs (which replaces other defaults) or ConfigCommand's absence precheck.
// Wire schema: https://github.com/apache/kafka/blob/3.9.0/clients/src/main/resources/common/message/IncrementalAlterConfigsRequest.json
import { createRequire } from 'node:module';
import { readUrl } from '../packages/config/src/url-reader.js';
const require = createRequire(import.meta.url);
const Encoder = require('kafkajs/src/protocol/encoder');
const Broker = require('kafkajs/src/broker');
const ConnectionPool = require('kafkajs/src/network/connectionPool');
const socketFactory = require('kafkajs/src/network/socketFactory');
const { createLogger } = require('kafkajs/src/loggers');
// Incremental v0 has the same response schema as AlterConfigs v0.
const { decode } = require('kafkajs/src/protocol/requests/alterConfigs/v0/response');
const BROKER = 4;
const DELETE = 1;
const API_KEY = 44;

export const deleteRequest = {
  request: {
    apiKey: API_KEY,
    apiVersion: 0,
    apiName: 'IncrementalAlterConfigs',
    encode: async () =>
      new Encoder()
        .writeArray([
          new Encoder()
            .writeInt8(BROKER)
            .writeString('')
            .writeArray([
              new Encoder().writeString('message.max.bytes').writeInt8(DELETE).writeString(null),
            ]),
        ])
        .writeBoolean(false),
  },
  response: {
    decode,
    parse: async ({ resources }) => {
      if (
        resources.length !== 1 ||
        resources[0].errorCode !== 0 ||
        resources[0].resourceType !== BROKER ||
        resources[0].resourceName !== ''
      ) {
        throw new Error('BROKER_DEFAULT deletion UNCONFIRMED');
      }
    },
  },
};

// The cluster a read/SET path resolved, passed in by the caller. Never derived
// from this adapter's own endpoint: that would bind the check to itself.
const CLUSTER_ID = /^[A-Za-z0-9._-]{1,64}$/;
const BROKER_UNCONFIRMED = 'BROKER_DEFAULT broker UNCONFIRMED';

// FU-006 r2: KafkaJS's ConnectionPool reconnects a closed connection on the
// next send, and a new socket may reach another cluster. The adapter therefore
// owns ONE physical socket for its lifetime: any second socket is refused, so a
// disconnect after the cluster check invalidates it instead of re-routing the
// DELETE. A caller wanting a retry opens a new adapter and repeats the check.
export function oneSocket(factory) {
  let opened = false;
  return (options) => {
    if (opened) throw new Error(BROKER_UNCONFIRMED);
    opened = true;
    return factory(options);
  };
}

export function openBroker(endpoint, { ssl, sasl, clientId }, rawSocketFactory = socketFactory()) {
  const logger = createLogger({ level: 0, logCreator: () => () => {} });
  const connectionPool = new ConnectionPool({
    host: endpoint.hostname,
    port: Number(endpoint.port),
    ssl,
    sasl,
    clientId,
    logger,
    socketFactory: oneSocket(rawSocketFactory),
    connectionTimeout: 5000,
    requestTimeout: 5000,
    enforceRequestTimeout: true,
  });
  const broker = new Broker({ connectionPool, logger, authenticationTimeout: 5000 });
  return {
    connect: () => broker.connect(),
    versions: () => broker.versions,
    metadata: () => broker.metadata([]),
    send: (request) => connectionPool.send(request),
    disconnect: () => broker.disconnect(),
  };
}

/**
 * DELETE the broker-default override on the cluster `clusterId` names: the one
 * the caller's reads and SETs resolved. The broker reached here must report the
 * same cluster on the same physical socket that sends the DELETE (no
 * reconnection); unresolved, malformed, mismatched or disconnected ⇒ refuse
 * before sending (FU-006).
 */
export async function deleteBrokerDefault(
  { brokers, ssl, sasl, clientId, clusterId },
  { open = openBroker } = {},
) {
  if (typeof clusterId !== 'string' || !CLUSTER_ID.test(clusterId)) {
    throw new Error(BROKER_UNCONFIRMED);
  }
  // Tests have one disposable broker. Bad/missing endpoints fail closed.
  const endpoint = readUrl(`tcp://${brokers[0]}`, {
    refusal: 'BROKER_DEFAULT endpoint UNCONFIRMED',
  });
  const broker = open(endpoint, { ssl, sasl, clientId });
  try {
    await broker.connect();
    const version = broker.versions()?.[API_KEY];
    if (!version || version.minVersion > 0) throw new Error('incremental deletion unavailable');
    const metadata = await broker.metadata();
    if (metadata?.clusterId !== clusterId) throw new Error(BROKER_UNCONFIRMED);
    return await broker.send(deleteRequest);
  } finally {
    await broker.disconnect();
  }
}
