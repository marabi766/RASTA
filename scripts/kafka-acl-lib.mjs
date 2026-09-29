/**
 * Pure helpers for the broker bootstrap (RUN-006): the connection a script
 * needs to reach the authenticated broker, and the diff between the ACLs the
 * contracts generate and the ACLs the broker holds. No I/O here, so the rules
 * are tested without a broker (`kafka-acl-lib.test.mjs`).
 */
import kafkajs from 'kafkajs';

const { AclOperationTypes, AclPermissionTypes, AclResourceTypes, ResourcePatternTypes } = kafkajs;

/** `fleet-service` -> `KAFKA_SASL_PASSWORD_FLEET`: the name every script and service reads. */
export function passwordVariable(principal) {
  return `KAFKA_SASL_PASSWORD_${principal
    .replace(/-service$/, '')
    .replace(/-/g, '_')
    .toUpperCase()}`;
}

/**
 * The kafkajs connection for `principal`, from the environment: brokers,
 * SCRAM-SHA-512 and TLS trusting `KAFKA_SSL_CA_FILE`. Without a password it
 * connects PLAINTEXT — which the authenticated broker refuses.
 */
export function connectionFor(principal, env, readFile) {
  const brokers = (env.KAFKA_BROKERS ?? 'localhost:9092')
    .split(',')
    .map((broker) => broker.trim())
    .filter(Boolean);
  const password = env[passwordVariable(principal)];
  const connection = { clientId: `rasta-${principal}`, brokers };
  if (password) {
    connection.sasl = { mechanism: 'scram-sha-512', username: principal, password };
  }
  if (env.KAFKA_SSL_CA_FILE) {
    connection.ssl = { ca: [readFile(env.KAFKA_SSL_CA_FILE)], rejectUnauthorized: true };
  }
  return connection;
}

const RESOURCE = {
  TOPIC: AclResourceTypes.TOPIC,
  GROUP: AclResourceTypes.GROUP,
  CLUSTER: AclResourceTypes.CLUSTER,
};
const PATTERN = { LITERAL: ResourcePatternTypes.LITERAL, PREFIXED: ResourcePatternTypes.PREFIXED };
const OPERATION = {
  READ: AclOperationTypes.READ,
  WRITE: AclOperationTypes.WRITE,
  DESCRIBE: AclOperationTypes.DESCRIBE,
};

const invert = (table) =>
  Object.fromEntries(Object.entries(table).map(([name, code]) => [code, name]));
const RESOURCE_NAME = invert(RESOURCE);
const PATTERN_NAME = invert(PATTERN);
const OPERATION_NAME = invert(OPERATION);

/** One generated binding as a kafkajs ACL entry: allow, from any host. */
export function toKafkajsAcl(binding) {
  return {
    resourceType: RESOURCE[binding.resourceType],
    resourceName: binding.resourceName,
    resourcePatternType: PATTERN[binding.patternType],
    principal: `User:${binding.principal}`,
    host: '*',
    operation: OPERATION[binding.operation],
    permissionType: AclPermissionTypes.ALLOW,
  };
}

/**
 * The broker's `describeAcls` resources, flattened into bindings in the
 * generator's shape. A binding the generator cannot express (a DENY, a host
 * restriction, an unknown type) is kept with `unexpected: true`, so it is
 * pruned rather than silently ignored.
 */
export function fromDescribe(resources) {
  const bindings = [];
  for (const resource of resources) {
    for (const acl of resource.acls) {
      const principal = acl.principal.startsWith('User:') ? acl.principal.slice(5) : acl.principal;
      const binding = {
        principal,
        resourceType: RESOURCE_NAME[resource.resourceType] ?? String(resource.resourceType),
        resourceName: resource.resourceName,
        patternType:
          PATTERN_NAME[resource.resourcePatternType] ?? String(resource.resourcePatternType),
        operation: OPERATION_NAME[acl.operation] ?? String(acl.operation),
      };
      const expressible =
        acl.permissionType === AclPermissionTypes.ALLOW &&
        acl.host === '*' &&
        acl.principal.startsWith('User:') &&
        RESOURCE_NAME[resource.resourceType] &&
        PATTERN_NAME[resource.resourcePatternType] &&
        OPERATION_NAME[acl.operation];
      bindings.push(
        expressible ? binding : { ...binding, unexpected: true, raw: { resource, acl } },
      );
    }
  }
  return bindings;
}

export const aclKey = (binding) =>
  [
    binding.principal,
    binding.resourceType,
    binding.patternType,
    binding.resourceName,
    binding.operation,
  ].join('|');

/** What to add and what to remove so the broker holds exactly `wanted`. */
export function diffAcls(wanted, actual) {
  const want = new Map(wanted.map((binding) => [aclKey(binding), binding]));
  const have = new Map(
    actual.filter((binding) => !binding.unexpected).map((binding) => [aclKey(binding), binding]),
  );
  return {
    add: [...want.values()].filter((binding) => !have.has(aclKey(binding))),
    remove: [
      ...actual.filter((binding) => binding.unexpected),
      ...[...have.values()].filter((binding) => !want.has(aclKey(binding))),
    ],
  };
}
