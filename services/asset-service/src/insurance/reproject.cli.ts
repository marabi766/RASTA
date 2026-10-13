import { assertNoMigratorCredentials } from '@rasta/config';
import { createLogger } from '@rasta/logging';
import { preflightRuntimeRole } from '@rasta/nest-common';
import { PrismaClient } from '../generated/prisma';
import { loadAssetEnv, SERVICE_NAME } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { AssetRepository } from '../asset/asset.repository';
import { reprojectInsurance } from './reproject.command';
import { parseReprojectArgs } from './reproject.args';

/**
 * `pnpm --filter @rasta/asset-service insurance:reproject [--dry-run]
 * [--organization <id>] [--page-size <n>] [--reissue]` (docs/runbooks/insurance-reprojection.md).
 *
 * Built by hand rather than by booting the Nest application, for the reason
 * identity-service's projection CLI gives: the application starts the outbox
 * relay and the Kafka consumers, and a one-off command must not become a
 * second instance of the service. The events it writes are published by the
 * running service's relay.
 *
 * Runs as the **runtime** role, never the migrator (D-045): it writes only
 * outbox rows, which that role may. The same preflight the service runs at
 * boot is run here, since this entry point skips it. Credentials come from the
 * environment only; the arguments carry no secret. Exit 2 on a refusal or an
 * error, naming the role and never the URL. The arguments are parsed first,
 * before the environment or the database ({@link parseReprojectArgs}): a
 * malformed command line touches nothing.
 */
async function main(): Promise<number> {
  const args = parseReprojectArgs(process.argv.slice(2));

  assertNoMigratorCredentials(process.env);
  const env = loadAssetEnv();
  await preflightRuntimeRole(
    () => new PrismaClient({ datasources: { db: { url: env.DATABASE_URL } } }),
    { service: SERVICE_NAME, runtimeVariable: 'DATABASE_URL_ASSET' },
  );
  const logger = createLogger({ serviceName: `${SERVICE_NAME}-insurance-reproject` });

  const prisma = new PrismaService(env.DATABASE_URL);
  await prisma.onModuleInit();
  try {
    const report = await reprojectInsurance(new AssetRepository(prisma), {
      dryRun: args.dryRun,
      pageSize: args.pageSize,
      transferRule: { coveragesFollowingVehicle: env.INSURANCE_COVERAGES_FOLLOWING_VEHICLE },
      ...(args.organizationId ? { organizationId: args.organizationId } : {}),
      reissue: args.reissue,
    });
    // Organization ids and counts only: no policy numbers, insurers or amounts (S-09).
    logger.info(
      { report },
      `${args.dryRun ? 'DRY RUN — ' : ''}insurance re-projection: ${report.emitted} to emit, ` +
        `${report.alreadyEmitted} already emitted, ${report.notCounting} not counting, ` +
        `${report.scanned} scanned${report.reissueRunId ? `, reissue run ${report.reissueRunId}` : ''}`,
    );
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return 0;
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
