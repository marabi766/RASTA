import { assertNoMigratorCredentials } from '@rasta/config';
import { createLogger } from '@rasta/logging';
import { preflightRuntimeRole } from '@rasta/nest-common';
import { PrismaClient } from '../generated/prisma';
import { loadFleetEnv, SERVICE_NAME } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { FleetRepository } from './fleet.repository';
import { MAX_PAGE_SIZE, clearTransferredInsurance } from './clear-transferred.command';

/**
 * `pnpm --filter @rasta/fleet-service insurance:clear-transferred [--dry-run]
 * [--organization <id>] [--page-size <n>] [--include-unknown-generation]`
 * (docs/runbooks/insurance-reprojection.md, "changing the following-coverage
 * list").
 *
 * Built by hand rather than by booting the Nest application, as asset-service's
 * `insurance:reproject` is: the application starts the Kafka consumers and the
 * outbox relay, and a one-off command must not become a second instance of the
 * service.
 *
 * Runs as the **runtime** role, never the migrator (D-045): it updates only
 * `asset_ref`, which that role may. The preflight the service runs at boot is
 * run here too. Credentials come from the environment only; the arguments carry
 * no secret. Exit 2 on a refusal or an error, naming the role and never the URL.
 */
interface Args {
  dryRun: boolean;
  includeUnknownGeneration: boolean;
  organizationId?: string;
  pageSize: number;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { dryRun: false, includeUnknownGeneration: false, pageSize: 100 };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--dry-run') args.dryRun = true;
    else if (flag === '--include-unknown-generation') args.includeUnknownGeneration = true;
    else if (flag === '--organization') args.organizationId = argv[++i];
    else if (flag === '--page-size') args.pageSize = Number(argv[++i]);
    else throw new Error(`unknown argument ${String(flag)}`);
  }
  if (args.organizationId !== undefined && args.organizationId.length === 0) {
    throw new Error('--organization needs an organization id');
  }
  if (!Number.isInteger(args.pageSize) || args.pageSize < 1 || args.pageSize > MAX_PAGE_SIZE) {
    throw new Error(`--page-size must be an integer from 1 to ${MAX_PAGE_SIZE}`);
  }
  return args;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  assertNoMigratorCredentials(process.env);
  const env = loadFleetEnv();
  await preflightRuntimeRole(
    () => new PrismaClient({ datasources: { db: { url: env.DATABASE_URL } } }),
    { service: SERVICE_NAME, runtimeVariable: 'DATABASE_URL_FLEET' },
  );
  const logger = createLogger({ serviceName: `${SERVICE_NAME}-insurance-clear-transferred` });

  const prisma = new PrismaService(env.DATABASE_URL);
  await prisma.onModuleInit();
  try {
    const report = await clearTransferredInsurance(new FleetRepository(prisma), {
      dryRun: args.dryRun,
      includeUnknownGeneration: args.includeUnknownGeneration,
      pageSize: args.pageSize,
      ...(args.organizationId ? { organizationId: args.organizationId } : {}),
    });
    // Organization ids and counts only: no policy numbers or insurers (S-09).
    logger.info(
      { report },
      `${args.dryRun ? 'DRY RUN — ' : ''}insurance windows of transferred machines: ` +
        `${report.cleared} to clear, ${report.skipped} no longer qualified, ${report.scanned} scanned`,
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
