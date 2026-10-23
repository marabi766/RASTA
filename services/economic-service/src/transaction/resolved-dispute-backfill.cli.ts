import { assertNoMigratorCredentials } from '@rasta/config';
import { preflightRuntimeRole } from '@rasta/nest-common';
import { PrismaClient } from '../generated/prisma';
import { SERVICE_NAME } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import {
  backfillResolvedDisputes,
  parseResolvedDisputeBackfillArgs,
} from './resolved-dispute-backfill';

/**
 * `pnpm --dir services/economic-service db:backfill:resolved-dispute [--apply]
 * [--batch-size n] [--max-batches n] [--after <id>] [--statement-timeout-ms n]
 * [--lock-timeout-ms n]` — see resolved-dispute-backfill.ts and docs/23 D-060.
 *
 * Connects as the service's runtime role, through `DATABASE_URL_ECONOMIC`,
 * and refuses an owner's credential in its environment or on the connection
 * (D-045). Prints NDJSON, counts and ids only; exits 1 unless the run planned
 * or finished.
 */
async function main(): Promise<number> {
  const options = parseResolvedDisputeBackfillArgs(process.argv.slice(2));
  assertNoMigratorCredentials(process.env);
  const url = process.env.DATABASE_URL_ECONOMIC;
  if (!url) throw new Error('DATABASE_URL_ECONOMIC is not set');
  await preflightRuntimeRole(() => new PrismaClient({ datasources: { db: { url } } }), {
    service: SERVICE_NAME,
    runtimeVariable: 'DATABASE_URL_ECONOMIC',
  });
  const prisma = new PrismaService(url);
  try {
    const summary = await backfillResolvedDisputes(prisma.client, options, (event) =>
      process.stdout.write(`${JSON.stringify(event)}\n`),
    );
    return summary.status === 'planned' || summary.status === 'done' ? 0 : 1;
  } finally {
    await prisma.onModuleDestroy();
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  },
);
