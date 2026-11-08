// FU-234: `node dist/ops/hold-deadline-backfill.cli.js --economic-rule-since <instant> [--apply]`,
// run by an operator in the service's image, as its runtime role (D-045). A dry run unless
// `--apply`. NDJSON on stdout; exit 0 only when nothing is left to assign and nothing was
// refused. See docs/runbooks/marketplace-saga-deploy.md, "Legacy rows".
import { assertNoMigratorCredentials, withUtcSession } from '@rasta/config';
import { PrismaService } from '../prisma/prisma.service';
import { backfillLegacyHoldDeadlines, parseBackfillArgs } from './hold-deadline-backfill';

const emit = (event: Record<string, unknown>) =>
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);

async function main(): Promise<void> {
  assertNoMigratorCredentials(process.env);
  const options = parseBackfillArgs(process.argv.slice(2));
  const url = process.env.DATABASE_URL_MARKETPLACE;
  if (!url) throw new Error('DATABASE_URL_MARKETPLACE is not set');
  const prisma = new PrismaService(withUtcSession(url));
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
  emit({ event: 'failed', message: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});
