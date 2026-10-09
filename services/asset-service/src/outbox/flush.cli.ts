import { assertNoMigratorCredentials } from '@rasta/config';
import { createLogger } from '@rasta/logging';
import { OutboxRelay, kafkaConnection, preflightRuntimeRole } from '@rasta/nest-common';
import { PrismaClient } from '../generated/prisma';
import { loadAssetEnv, SERVICE_NAME } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { KafkaEventPublisher } from './kafka.publisher';
import { PrismaOutboxStore } from './outbox.store';
import { flushOutbox } from './flush.command';

/**
 * `pnpm --filter @rasta/asset-service outbox:flush [--max-seconds <n>]`
 * (docs/runbooks/insurance-reprojection.md, "changing the following-coverage
 * list").
 *
 * Exit 0 when the outbox holds no unpublished row; 1 when `--max-seconds`
 * (default 300) ran out first; 2 on an error. Run with every asset-service
 * replica stopped.
 *
 * Built by hand rather than by booting the Nest application, as
 * `insurance:reproject` is — and for the opposite reason to it: that command
 * only writes rows and leaves publishing to the service; this is the publishing
 * alone. It builds the store, the Kafka publisher and the relay, and calls the
 * relay's `tick()` itself. It starts no HTTP server, no Kafka consumer, no
 * relay timer and no sweep or purge: nothing here writes except the relay's own
 * claim and acknowledgement of outbox rows.
 *
 * Runs as the **runtime** role, never the migrator (D-045), after the same
 * preflight the service runs at boot. Credentials come from the environment
 * only; the arguments carry no secret.
 */
const DEFAULT_MAX_SECONDS = 300;

function parseArgs(argv: readonly string[]): { maxSeconds: number } {
  let maxSeconds = DEFAULT_MAX_SECONDS;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--max-seconds') maxSeconds = Number(argv[++i]);
    else throw new Error(`unknown argument ${String(argv[i])}`);
  }
  if (!Number.isInteger(maxSeconds) || maxSeconds < 1 || maxSeconds > 86_400) {
    throw new Error('--max-seconds must be an integer from 1 to 86400');
  }
  return { maxSeconds };
}

async function main(): Promise<number> {
  const { maxSeconds } = parseArgs(process.argv.slice(2));

  assertNoMigratorCredentials(process.env);
  const env = loadAssetEnv();
  await preflightRuntimeRole(
    () => new PrismaClient({ datasources: { db: { url: env.DATABASE_URL } } }),
    { service: SERVICE_NAME, runtimeVariable: 'DATABASE_URL_ASSET' },
  );
  const logger = createLogger({ serviceName: `${SERVICE_NAME}-outbox-flush` });

  const prisma = new PrismaService(env.DATABASE_URL);
  await prisma.onModuleInit();
  const store = new PrismaOutboxStore(prisma);
  const publisher = new KafkaEventPublisher(
    kafkaConnection(env, `${env.KAFKA_CLIENT_ID}-outbox-flush`),
  );
  // The service's own relay settings. Never `start()`ed: `tick()` does not need it.
  const relay = new OutboxRelay({
    store,
    publisher,
    batchSize: env.OUTBOX_BATCH_SIZE,
    leaseSeconds: env.OUTBOX_CLAIM_LEASE_SECONDS,
    backoff: {
      baseSeconds: env.OUTBOX_CLAIM_BACKOFF_SECONDS,
      maxSeconds: env.OUTBOX_CLAIM_BACKOFF_MAX_SECONDS,
    },
    shutdownGraceSeconds: env.OUTBOX_SHUTDOWN_GRACE_SECONDS,
    logger,
  });
  try {
    const report = await flushOutbox({
      tick: () => relay.tick(),
      unpublished: () => store.pendingCount(),
      maxSeconds,
      pollMs: env.OUTBOX_POLL_INTERVAL_MS,
    });
    // Counts only: no payloads (S-09).
    logger.info(
      { report },
      report.drained
        ? `outbox flushed: ${report.published} published, none left`
        : `outbox NOT flushed within ${maxSeconds}s: ${report.unpublished} unpublished row(s) left`,
    );
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return report.drained ? 0 : 1;
  } finally {
    await relay.stop();
    await publisher.onModuleDestroy();
    await prisma.onModuleDestroy();
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  },
);
