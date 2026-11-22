import { Logger } from '@nestjs/common';
import { assertNoMigratorCredentials, commandFailure, markRefusal } from '@rasta/config';
import { meterReconcileOperatorSchema } from '@rasta/contracts';
import { preflightRuntimeRole } from '@rasta/nest-common';
import { loadMaintenanceEnv, SERVICE_NAME } from '../config/env';
import { PrismaClient } from '../generated/prisma';
import { PrismaService } from '../prisma/prisma.service';
import { MeterFullRun, type MeterFullRunStatus } from './meter-full-run';
import { parseMeterFullRunStatusArgs } from './meter-full-run-status.args';

// Existing status: run <=64, digest 64, boundary <=256 printable ASCII (<=512
// JSON-escaped bytes), two counts <=20,000 and fixed keys fit within 1 KiB.
const MAX_STATUS_JSON_BYTES = 1024;

async function main(): Promise<void> {
  const { runId } = parseMeterFullRunStatusArgs(process.argv.slice(2));
  const operator = meterReconcileOperatorSchema.safeParse(process.env.METER_RECONCILE_OPERATOR_ID);
  if (!operator.success) throw markRefusal(new Error('OPERATOR_ID_REQUIRED'), 'configuration');
  assertNoMigratorCredentials(process.env);
  const env = loadMaintenanceEnv();
  await preflightRuntimeRole(
    () => new PrismaClient({ datasources: { db: { url: env.DATABASE_URL } } }),
    { service: SERVICE_NAME, runtimeVariable: 'DATABASE_URL_MAINTENANCE' },
  );
  // Standalone read: no Nest application, relay, consumer or background work.
  // Keep stdout exclusively the existing bounded status JSON, even during drain.
  Logger.overrideLogger(false);
  const prisma = new PrismaService(env.DATABASE_URL);
  let status: MeterFullRunStatus | null;
  try {
    await prisma.onModuleInit();
    status = await new MeterFullRun(prisma).status(runId, operator.data);
  } finally {
    await prisma.stop().then(({ drained }) => {
      if (!drained) throw new Error('Database close UNCONFIRMED');
    });
  }
  const json = JSON.stringify(status);
  if (Buffer.byteLength(json, 'utf8') > MAX_STATUS_JSON_BYTES)
    throw new Error('FULL_RUN_STATUS_OUTPUT_REFUSED');
  process.stdout.write(`${json}\n`);
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    process.stderr.write(`${commandFailure(error)}\n`);
    process.exit(2);
  },
);
