import { assertNoMigratorCredentials } from '@rasta/config';
import { createLogger } from '@rasta/logging';
import { preflightRuntimeRole } from '@rasta/nest-common';
import { PrismaClient } from '../generated/prisma';
import { loadAssetEnv, SERVICE_NAME } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { checkOutboxDrained } from './drain-check.command';

/**
 * `pnpm --filter @rasta/asset-service insurance:drain-check`
 * (docs/runbooks/insurance-reprojection.md, "changing the following-coverage
 * list", step 1a).
 *
 * Exit 0 only when asset-service's outbox holds no unpublished row; exit 1
 * when it does (the change must not go on); exit 2 on an error. Read-only, as
 * the **runtime** role, with the same preflight and environment-only
 * credentials as `insurance:reproject`. Prints counts, never row contents.
 * The Kafka half — fleet's consumer lag — is fleet-service's own
 * `insurance:drain-check`: this principal may not describe fleet's group.
 */
async function main(): Promise<number> {
  if (process.argv.length > 2) throw new Error('insurance:drain-check takes no arguments');

  assertNoMigratorCredentials(process.env);
  const env = loadAssetEnv();
  await preflightRuntimeRole(
    () => new PrismaClient({ datasources: { db: { url: env.DATABASE_URL } } }),
    { service: SERVICE_NAME, runtimeVariable: 'DATABASE_URL_ASSET' },
  );
  const logger = createLogger({ serviceName: `${SERVICE_NAME}-insurance-drain-check` });

  const prisma = new PrismaService(env.DATABASE_URL);
  await prisma.onModuleInit();
  try {
    const report = await checkOutboxDrained(prisma);
    logger.info(
      { report },
      report.drained
        ? 'outbox drained: no unpublished row'
        : `outbox NOT drained: ${report.unpublished} unpublished row(s) — keep the relay running (asset-service stopped means no relay: start ONE replica only if the rows cannot publish, see outbox-stuck) and run again`,
    );
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return report.drained ? 0 : 1;
  } finally {
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
