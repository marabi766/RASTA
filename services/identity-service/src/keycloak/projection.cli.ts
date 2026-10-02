import { assertNoMigratorCredentials } from '@rasta/config';
import { createLogger } from '@rasta/logging';
import { preflightRuntimeRole } from '@rasta/nest-common';
import { PrismaClient } from '../generated/prisma';
import { loadIdentityEnv, SERVICE_NAME } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { IdentityRepository } from '../identity/identity.repository';
import { KeycloakAdminClient } from './keycloak.client';
import { KeycloakProjector } from './keycloak.projector';
import { isClean, runProjectionCommand, type ProjectionCommandMode } from './projection.command';

/**
 * `pnpm --filter @rasta/identity-service keycloak:reconcile` / `keycloak:backfill`.
 *
 * Built by hand rather than by booting the Nest application: the application
 * starts the outbox relays and the Kafka consumers, and a one-off sweep must
 * not become a second instance of the service. Exits non-zero when anything
 * diverged or failed, so it can gate the next migration step.
 *
 * Built by hand, it also skips both of the service's runtime-role gates —
 * main.ts's preflight and AppModule's check — so it runs the same preflight
 * itself, before it reads a row or calls Keycloak (D-045, Codex on #177):
 * pointed at the migrator, it would otherwise read identity data and write
 * Keycloak attributes as the database owner. A refusal exits 2, naming the
 * role, never the URL.
 */
async function main(): Promise<number> {
  const mode = process.argv[2];
  if (mode !== 'reconcile' && mode !== 'backfill') {
    throw new Error('usage: projection.cli.ts <reconcile|backfill>');
  }

  assertNoMigratorCredentials(process.env);
  const env = loadIdentityEnv();
  await preflightRuntimeRole(
    () => new PrismaClient({ datasources: { db: { url: env.DATABASE_URL } } }),
    { service: SERVICE_NAME, runtimeVariable: 'DATABASE_URL_IDENTITY' },
  );
  const logger = createLogger({ serviceName: `${SERVICE_NAME}-keycloak-${mode}` });
  if (!env.KEYCLOAK_SYNC_ENABLED) {
    logger.error('KEYCLOAK_SYNC_ENABLED is false: there is no Keycloak to reconcile against');
    return 2;
  }

  const prisma = new PrismaService(env.DATABASE_URL);
  await prisma.onModuleInit();
  try {
    const repository = new IdentityRepository(prisma);
    const keycloak = new KeycloakAdminClient({
      baseUrl: env.KEYCLOAK_URL,
      realm: env.KEYCLOAK_REALM,
      clientId: env.KEYCLOAK_BACKEND_CLIENT_ID,
      clientSecret: env.KEYCLOAK_BACKEND_CLIENT_SECRET,
      enabled: true,
    });
    const projector = new KeycloakProjector(repository, keycloak);

    const report = await runProjectionCommand(mode as ProjectionCommandMode, {
      repository,
      projector,
    });
    // User ids only — never names, emails or roles in an operations log (S-09).
    logger.info({ report }, `Keycloak ${mode}: ${report.accounts} accounts`);
    return isClean(report) ? 0 : 1;
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
