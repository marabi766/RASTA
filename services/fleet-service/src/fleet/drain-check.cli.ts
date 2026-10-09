import { Kafka } from 'kafkajs';
import { assertNoMigratorCredentials } from '@rasta/config';
import { createLogger } from '@rasta/logging';
import { kafkaClientConfig, kafkaConnection } from '@rasta/nest-common';
import { ASSET_SYNC_GROUP, loadFleetEnv, SERVICE_NAME } from '../config/env';
import { checkConsumerGroupDrained } from './drain-check.command';

/**
 * `pnpm --filter @rasta/fleet-service insurance:drain-check`
 * (docs/runbooks/insurance-reprojection.md, "changing the following-coverage
 * list", step 1b).
 *
 * Exit 0 only when fleet's asset-sync consumer group has no lag on the asset
 * and insurance topics (and their `.retry` twins); exit 1 when it has (the
 * change must not go on); exit 2 on an error, including a broker it cannot
 * read. Read-only, as fleet-service's own Kafka principal — the one the ACLs
 * let describe this group. The outbox half is asset-service's own
 * `insurance:drain-check`: fleet has no credential for asset-service's
 * database and must not get one (D-045). Credentials come from the
 * environment only; the arguments carry none, and the output names topics and
 * counts only.
 */
async function main(): Promise<number> {
  if (process.argv.length > 2) throw new Error('insurance:drain-check takes no arguments');

  assertNoMigratorCredentials(process.env);
  const env = loadFleetEnv();
  const logger = createLogger({ serviceName: `${SERVICE_NAME}-insurance-drain-check` });

  const kafka = new Kafka({
    ...kafkaClientConfig(kafkaConnection(env, `${env.KAFKA_CLIENT_ID}-drain-check`)),
    logLevel: 1,
  });
  const admin = kafka.admin();
  await admin.connect();
  try {
    const report = await checkConsumerGroupDrained(admin, ASSET_SYNC_GROUP);
    logger.info(
      { report },
      report.drained
        ? `consumer group ${ASSET_SYNC_GROUP} has no lag`
        : `consumer group ${ASSET_SYNC_GROUP} is behind — wait for fleet-service to consume, then run again`,
    );
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return report.drained ? 0 : 1;
  } finally {
    await admin.disconnect();
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  },
);
