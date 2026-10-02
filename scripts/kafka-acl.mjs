#!/usr/bin/env node
/**
 * Applies the generated principals' ACLs to the broker (RUN-006, ADR-061 § 3).
 *
 *   node scripts/kafka-acl.mjs apply --profile development|deployment
 *
 * The profile is required (review of #131, #5): `development` adds the
 * development-only principals (test observer, Kafka UI, exporter) and exists
 * only for compose and CI; nothing picks it by default.
 *
 * Reads `infrastructure/docker/kafka/broker-acls.<profile>.json` — generated from
 * TOPIC_PRODUCERS and TOPIC_CONSUMERS (`pnpm kafka:acl:generate`), checked by
 * `packages/contracts` — and makes the broker hold exactly those bindings:
 * missing ones are created in one request, any other ALLOW binding (a stale
 * grant, a hand-made one) is removed, and the result is read back and
 * compared. A mismatch fails the bootstrap.
 *
 * Connects as `admin` (KAFKA_SASL_PASSWORD_ADMIN) to KAFKA_BROKERS over
 * SASL_SSL. It trusts KAFKA_SSL_CA_FILE when that is an absolute path (CI,
 * `infrastructure/docker/kafka/ci-up.sh`); otherwise — the repository `.env`
 * names it relative to a service's directory — the CA certificate
 * `pnpm infra:up` exported to `infrastructure/docker/kafka/.tls/ca.pem`.
 *
 * Development: `pnpm infra:up` (and `pnpm kafka:acl:apply:dev`) run it on the
 * host after `docker compose up -d` with the bootstrap-only env file
 * (`infrastructure/docker/kafka/bootstrap.env`, from its committed example) —
 * the admin's password is never in the services' `.env` — so nothing beyond
 * Node and pnpm is needed. There is no profile-less command (review of #131).
 *
 * A deployment calls it directly, `--profile deployment`, with the admin's
 * password, KAFKA_BROKERS and the CA from its own secret store — never from
 * any file in this repository, and never from bootstrap.env.example.
 */
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import kafkajs from 'kafkajs';
import { connectionFor, diffAcls, fromDescribe, toKafkajsAcl } from './kafka-acl-lib.mjs';

const {
  Kafka,
  logLevel,
  AclResourceTypes,
  AclOperationTypes,
  AclPermissionTypes,
  ResourcePatternTypes,
} = kafkajs;

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [command, flag, profile] = process.argv.slice(2);
const PROFILES = ['development', 'deployment'];
if (command !== 'apply' || flag !== '--profile' || !PROFILES.includes(profile)) {
  process.stderr.write(
    'usage: node scripts/kafka-acl.mjs apply --profile development|deployment\n',
  );
  process.exit(2);
}

const spec = JSON.parse(
  readFileSync(resolve(root, `infrastructure/docker/kafka/broker-acls.${profile}.json`), 'utf8'),
);
if (spec.profile !== profile) {
  process.stderr.write(`kafka acl: broker-acls.${profile}.json says profile ${spec.profile}\n`);
  process.exit(1);
}
const exportedCa = resolve(root, 'infrastructure/docker/kafka/.tls/ca.pem');
const configuredCa = process.env.KAFKA_SSL_CA_FILE?.trim();
const env = {
  ...process.env,
  KAFKA_SSL_CA_FILE: configuredCa && isAbsolute(configuredCa) ? configuredCa : exportedCa,
};
const connection = connectionFor(spec.admin, env, (path) => readFileSync(path, 'utf8'));
if (!connection.sasl || !connection.ssl) {
  process.stderr.write(
    'kafka acl: KAFKA_SASL_PASSWORD_ADMIN is required — in development from ' +
      'infrastructure/docker/kafka/bootstrap.env (`pnpm kafka:acl:apply:dev`); ' +
      'in a deployment from its secret store\n',
  );
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
    `kafka acl: ${profile}: ${spec.acls.length} bindings for ${spec.principals.length} principals in place ` +
      `(${add.length} added, ${remove.length} removed)\n`,
  );
} finally {
  await admin.disconnect();
}
