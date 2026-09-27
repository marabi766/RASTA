#!/usr/bin/env node
/**
 * Applies the generated principals' ACLs to the broker (RUN-006, ADR-061 § 3).
 *
 *   node scripts/kafka-acl.mjs apply
 *
 * Reads `infrastructure/docker/kafka/broker-acls.json` — generated from
 * TOPIC_PRODUCERS and TOPIC_CONSUMERS (`pnpm kafka:acl:generate`), checked by
 * `packages/contracts` — and makes the broker hold exactly those bindings:
 * missing ones are created in one request, any other ALLOW binding (a stale
 * grant, a hand-made one) is removed, and the result is read back and
 * compared. A mismatch fails the bootstrap.
 *
 * Connects as `admin` (KAFKA_SASL_PASSWORD_ADMIN) to KAFKA_BROKERS over
 * SASL_SSL, trusting KAFKA_SSL_CA_FILE. The same script runs in compose
 * (`kafka-acl` service) and in CI (`infrastructure/docker/kafka/ci-up.sh`).
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import kafkajs from 'kafkajs';
import { connectionFor, diffAcls, fromDescribe, toKafkajsAcl } from './kafka-acl-lib.mjs';

const { Kafka, logLevel, AclResourceTypes, AclOperationTypes, AclPermissionTypes, ResourcePatternTypes } =
  kafkajs;

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const command = process.argv[2];
if (command !== 'apply') {
  process.stderr.write('usage: node scripts/kafka-acl.mjs apply\n');
  process.exit(2);
}

const spec = JSON.parse(readFileSync(resolve(root, 'infrastructure/docker/kafka/broker-acls.json'), 'utf8'));
const connection = connectionFor(spec.admin, process.env, (path) => readFileSync(path, 'utf8'));
if (!connection.sasl || !connection.ssl) {
  process.stderr.write('kafka acl: KAFKA_SASL_PASSWORD_ADMIN and KAFKA_SSL_CA_FILE are required\n');
  process.exit(1);
}

const admin = new Kafka({
  ...connection,
  logLevel: logLevel.ERROR,
  retry: { initialRetryTime: 500, retries: 10 },
}).admin();

const everything = {
  resourceType: AclResourceTypes.ANY,
  resourcePatternType: ResourcePatternTypes.ANY,
  operation: AclOperationTypes.ANY,
  permissionType: AclPermissionTypes.ANY,
};

async function current() {
  const { resources } = await admin.describeAcls(everything);
  return fromDescribe(resources);
}

try {
  await admin.connect();
  const { add, remove } = diffAcls(spec.acls, await current());

  if (remove.length > 0) {
    await admin.deleteAcls({
      filters: remove.map((binding) =>
        binding.unexpected
          ? {
              resourceType: binding.raw.resource.resourceType,
              resourceName: binding.raw.resource.resourceName,
              resourcePatternType: binding.raw.resource.resourcePatternType,
              principal: binding.raw.acl.principal,
              host: binding.raw.acl.host,
              operation: binding.raw.acl.operation,
              permissionType: binding.raw.acl.permissionType,
            }
          : toKafkajsAcl(binding),
      ),
    });
  }
  if (add.length > 0) await admin.createAcls({ acl: add.map(toKafkajsAcl) });

  const after = diffAcls(spec.acls, await current());
  if (after.add.length > 0 || after.remove.length > 0) {
    process.stderr.write(
      `kafka acl: the broker does not hold the generated ACLs (${after.add.length} missing, ${after.remove.length} extra)\n`,
    );
    process.exit(1);
  }
  process.stdout.write(
    `kafka acl: ${spec.acls.length} bindings for ${spec.principals.length} principals in place ` +
      `(${add.length} added, ${remove.length} removed)\n`,
  );
} finally {
  await admin.disconnect();
}
