import { assertNoMigratorCredentials } from '@rasta/config';
import { createLogger } from '@rasta/logging';
import { preflightRuntimeRole } from '@rasta/nest-common';
import { PrismaClient } from '../generated/prisma';
import { loadIdentityEnv, SERVICE_NAME } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { IdentityRepository } from '../identity/identity.repository';
import { KeycloakAdminClient } from './keycloak.client';
import { KeycloakProjector } from './keycloak.projector';
import { FENCE_POOL_CONNECTIONS, KeycloakWriteFences } from './keycloak-write-fence';
import {
  isClean,
  RECOVERY_STOP_MS,
  runProjectionCommand,
  tearDownProjectionCommand,
  type ProjectionCommandMode,
} from './projection.command';

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
  // The write fences' own pool, as in the service (D-069): the backfill's
  // projections and orphan repairs are fenced like every other writer.
  const fencePool = new PrismaService(env.DATABASE_URL, { connections: FENCE_POOL_CONNECTIONS });
  await prisma.onModuleInit();
  await fencePool.onModuleInit();
  let projector: KeycloakProjector | undefined;
  let clean = false;
  let tornDown = false;
  try {
    const repository = new IdentityRepository(prisma);
    const keycloak = new KeycloakAdminClient({
      baseUrl: env.KEYCLOAK_URL,
      realm: env.KEYCLOAK_REALM,
      clientId: env.KEYCLOAK_BACKEND_CLIENT_ID,
      clientSecret: env.KEYCLOAK_BACKEND_CLIENT_SECRET,
      enabled: true,
    });
    const fences = new KeycloakWriteFences(fencePool);
    projector = new KeycloakProjector(repository, keycloak, fences, {
      writeSettleSeconds: env.KEYCLOAK_WRITE_SETTLE_SECONDS,
    });

    const report = await runProjectionCommand(mode as ProjectionCommandMode, {
      repository,
      projector,
      keycloak,
      fences,
    });
    // User ids only — never names, emails or roles in an operations log (S-09).
    logger.info(
      { report },
      `Keycloak ${mode}: ${report.accounts} accounts, ` +
        `${report.fences.outstanding} write fences outstanding` +
        (report.fences.outstanding === 0
          ? ' (the fence migration may be rolled back while every identity-service replica stays stopped)'
          : ''),
    );
    clean = isClean(report);
  } finally {
    // Whatever ended the command — a thrown error included — no recovery
    // projection of it reaches the database after the disconnect (#458 r1
    // F2): none starts any more, and those running are cancelled and waited
    // for first. Then both pools, last, by the same deadline (#458 r2 F2):
    // each waits for a transaction still in flight — a COMMIT included —
    // then refuses everything and disconnects. Anything still unwinding or
    // unsettled then makes the command unclean, loudly.
    const left = await tearDownProjectionCommand(
      { projector, pools: [fencePool, prisma] },
      Date.now() + RECOVERY_STOP_MS,
    );
    tornDown = left.recoveriesUnwinding === 0 && left.transactionsUnsettled === 0;
    if (!tornDown) {
      logger.error(
        left,
        `Keycloak ${mode}: teardown reached its deadline with work still in flight; ` +
          'it may still commit after the command exits — the run is not clean',
      );
    }
  }
  return clean && tornDown ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  },
);
