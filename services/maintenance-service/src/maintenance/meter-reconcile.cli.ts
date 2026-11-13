import { meterReconcileOperatorSchema } from '@rasta/contracts';
import { z } from 'zod';
import { assertNoMigratorCredentials, commandFailure, serviceUrlSchema } from '@rasta/config';
import { InternalTokenService, preflightRuntimeRole } from '@rasta/nest-common';
import { PrismaClient } from '../generated/prisma';
import { loadMaintenanceEnv, SERVICE_NAME } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { MeterReconcile, MeterUsageClient } from './meter-reconcile';
import { parseMeterReconcileArgs } from './meter-reconcile.args';

async function main(): Promise<number> {
  const { organizationId, apply } = parseMeterReconcileArgs(process.argv.slice(2));
  const operatorId = process.env.METER_RECONCILE_OPERATOR_ID;
  if (apply && !meterReconcileOperatorSchema.safeParse(operatorId).success)
    throw new Error('OPERATOR_ID_REQUIRED');
  assertNoMigratorCredentials(process.env);
  const env = loadMaintenanceEnv();
  // Existing service URL validation; never repeat a bad environment value.
  const url = z.object({ FLEET_SERVICE_URL: serviceUrlSchema }).safeParse(process.env);
  if (!url.success) throw new Error('FLEET_SERVICE_URL configuration refused');
  await preflightRuntimeRole(
    () => new PrismaClient({ datasources: { db: { url: env.DATABASE_URL } } }),
    { service: SERVICE_NAME, runtimeVariable: 'DATABASE_URL_MAINTENANCE' },
  );
  const prisma = new PrismaService(env.DATABASE_URL);
  await prisma.onModuleInit();
  try {
    const source = new MeterUsageClient({
      baseUrl: url.data.FLEET_SERVICE_URL,
      timeoutMs: 3000,
      tokens: new InternalTokenService(
        env.INTERNAL_TOKEN_SECRET,
        env.INTERNAL_TOKEN_ISSUER,
        env.INTERNAL_TOKEN_TTL_SECONDS,
      ),
    });
    const report = await new MeterReconcile(prisma, source, undefined, operatorId).report(
      organizationId,
      new Date(),
      apply,
    );
    process.stdout.write(`${JSON.stringify(report)}\n`);
    // Per-asset apply does not prove a complete global inventory or activate its marker.
    return 1;
  } finally {
    await prisma.stop().then(({ drained }) => {
      if (!drained) throw new Error('Database close UNCONFIRMED');
    });
  }
}
main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`${commandFailure(error)}\n`);
    process.exit(2);
  },
);
