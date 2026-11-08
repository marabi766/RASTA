// FU-234: `node dist/ops/hold-deadline-backfill.cli.js --economic-rule-since <instant>
// --operator <who> --ticket <change> [--apply]`, run by an operator in the service's image, with
// its environment, as its runtime role (D-045). A dry run unless `--apply`. NDJSON on stdout;
// exit 0 only when nothing is left to assign and nothing was refused. A failure is one closed
// line on stderr (`commandFailure`: a refusal's code, never a foreign message), exit 1.
// See docs/runbooks/marketplace-saga-deploy.md, "Legacy rows".
import { assertNoMigratorCredentials, commandFailure } from '@rasta/config';
import { preflightRuntimeRole } from '@rasta/nest-common';
import { loadMarketplaceEnv, SERVICE_NAME } from '../config/env';
import { PrismaClient } from '../generated/prisma';
import { PrismaService } from '../prisma/prisma.service';
import { backfillLegacyHoldDeadlines, parseBackfillArgs } from './hold-deadline-backfill';

const emit = (event: Record<string, unknown>) =>
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);

async function main(): Promise<void> {
  const options = parseBackfillArgs(process.argv.slice(2));
  assertNoMigratorCredentials(process.env);
  const env = loadMarketplaceEnv();
  // D-045: connected as the runtime role, proven before any other query.
  await preflightRuntimeRole(
    () => new PrismaClient({ datasources: { db: { url: env.DATABASE_URL } } }),
    { service: SERVICE_NAME, runtimeVariable: 'DATABASE_URL_MARKETPLACE' },
  );
  const prisma = new PrismaService(env.DATABASE_URL);
  try {
    const { assigned, refused, ...report } = await backfillLegacyHoldDeadlines(
      prisma.client,
      options,
    );
    for (const row of refused) emit({ event: 'refused', ...row });
    for (const row of assigned) emit({ event: 'assigned', runId: report.runId, ...row });
    emit({ event: 'summary', ...report, assigned: assigned.length });
    process.exitCode = report.converged ? 0 : 1;
  } finally {
    await prisma.onModuleDestroy();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${commandFailure(error)}\n`);
  process.exitCode = 1;
});
