import { assertNoMigratorCredentials } from '@rasta/config';
import { preflightRuntimeRole } from '@rasta/nest-common';
import { PrismaClient } from '../generated/prisma';
import { loadEconomicEnv, SERVICE_NAME } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import {
  backfillExitCode,
  backfillResolvedDisputes,
  parseResolvedDisputeBackfillArgs,
} from './resolved-dispute-backfill';

/**
 * `pnpm --dir services/economic-service db:backfill:resolved-dispute [--apply]
 * [--batch-size n] [--max-batches n] [--after <id>] [--statement-timeout-ms n]
 * [--lock-timeout-ms n]` — see resolved-dispute-backfill.ts and docs/23 D-060.
 *
 * Runs with the service's environment (`loadEconomicEnv`) and connects as its
 * runtime role, through `DATABASE_URL_ECONOMIC`; refuses an owner's credential
 * in its environment or on the connection (D-045). Prints NDJSON, counts and
 * ids only; exits 1 unless the run planned or finished.
 */
async function main(): Promise<number> {
  const options = parseResolvedDisputeBackfillArgs(process.argv.slice(2));
  assertNoMigratorCredentials(process.env);
  const env = loadEconomicEnv();
  await preflightRuntimeRole(
    () => new PrismaClient({ datasources: { db: { url: env.DATABASE_URL } } }),
    { service: SERVICE_NAME, runtimeVariable: 'DATABASE_URL_ECONOMIC' },
  );
  const prisma = new PrismaService(env.DATABASE_URL);
  try {
    const summary = await backfillResolvedDisputes(prisma.client, options, (event) =>
      process.stdout.write(`${JSON.stringify(event)}\n`),
    );
    return backfillExitCode(summary);
  } finally {
    await prisma.onModuleDestroy();
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`${String(error)}\n`);
    process.exit(1);
  },
);
