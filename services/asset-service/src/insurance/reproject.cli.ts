import { assertNoMigratorCredentials } from '@rasta/config';
import { createLogger } from '@rasta/logging';
import { preflightRuntimeRole } from '@rasta/nest-common';
import { PrismaClient } from '../generated/prisma';
import { loadAssetEnv, SERVICE_NAME } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { AssetRepository } from '../asset/asset.repository';
import { MAX_PAGE_SIZE, reprojectInsurance } from './reproject.command';

/**
 * `pnpm --filter @rasta/asset-service insurance:reproject [--dry-run]
 * [--organization <id>] [--page-size <n>] [--reissue <label>]` (docs/runbooks/insurance-reprojection.md).
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
 * error, naming the role and never the URL.
 */
interface Args {
  dryRun: boolean;
  organizationId?: string;
  pageSize: number;
  reissue?: string;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { dryRun: false, pageSize: 200 };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--dry-run') args.dryRun = true;
    else if (flag === '--organization') args.organizationId = argv[++i];
    else if (flag === '--page-size') args.pageSize = Number(argv[++i]);
    else if (flag === '--reissue') args.reissue = argv[++i];
    else throw new Error(`unknown argument ${String(flag)}`);
  }
  if (args.organizationId !== undefined && args.organizationId.length === 0) {
    throw new Error('--organization needs an organization id');
  }
  if (args.reissue !== undefined && !/^[A-Za-z0-9._-]{1,64}$/.test(args.reissue)) {
    throw new Error('--reissue needs a label of 1 to 64 letters, digits, dot, dash or underscore');
  }
  if (!Number.isInteger(args.pageSize) || args.pageSize < 1 || args.pageSize > MAX_PAGE_SIZE) {
    throw new Error(`--page-size must be an integer from 1 to ${MAX_PAGE_SIZE}`);
  }
  return args;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

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
      ...(args.reissue ? { reissue: args.reissue } : {}),
    });
    // Organization ids and counts only: no policy numbers, insurers or amounts (S-09).
    logger.info(
      { report },
      `${args.dryRun ? 'DRY RUN — ' : ''}insurance re-projection: ${report.emitted} to emit, ` +
        `${report.alreadyEmitted} already emitted, ${report.notCounting} not counting, ` +
        `${report.scanned} scanned`,
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
