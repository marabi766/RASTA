import { Kafka } from 'kafkajs';
import { assertNoMigratorCredentials } from '@rasta/config';
import { createLogger } from '@rasta/logging';
import { kafkaClientConfig, kafkaConnection } from '@rasta/nest-common';
import { ASSET_SYNC_GROUP, ASSET_SYNC_TOPICS, loadFleetEnv, SERVICE_NAME } from '../config/env';
import { INSURANCE_EVENT_TOPICS, checkConsumerGroupDrained } from './drain-check.command';

/**
 * `pnpm --filter @rasta/fleet-service insurance:drain-check`
 * (docs/runbooks/insurance-reprojection.md, "changing the following-coverage
 * list", step 1b).
 *
 * Exit 0 only when fleet's asset-sync consumer group exists, has a committed
 * offset on every partition of the asset and insurance topics and their
 * `.retry` twins (a partition that never held a message excepted), and no lag;
 * exit 1 when it has not (the change must not go on) — an absent group or an
 * absent offset is that, not "nothing to do"; exit 2 on an error, including a
 * broker it cannot read and an expected topic that is missing. Read-only, as fleet-service's own Kafka principal — the one the ACLs
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
    // From the topics the group is configured to consume, so the list cannot
    // drift from the subscription.
    const report = await checkConsumerGroupDrained(
      admin,
      ASSET_SYNC_GROUP,
      ASSET_SYNC_TOPICS.filter((topic) =>
        (INSURANCE_EVENT_TOPICS as readonly string[]).includes(topic),
      ),
    );
    logger.info(
      { report },
      report.drained
        ? `consumer group ${ASSET_SYNC_GROUP} has no lag`
        : !report.groupFound
          ? `consumer group ${ASSET_SYNC_GROUP} does not exist on the broker — it has committed nothing, so nothing is drained`
          : `consumer group ${ASSET_SYNC_GROUP} is behind or has partitions with no committed offset — wait for fleet-service to consume, then run again`,
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
