// -----------------------------------------------------------------------------
// ADR-051 Phase B2 — the database port, implemented with Prisma.
//
// The only I/O in B2. `outbox-b2-lib.mjs` holds the SQL and the orchestration
// and knows nothing about Prisma; this file knows nothing about sequences. The
// separation is what lets the PostgreSQL tests drive the real library against a
// real database through a port pointed at an isolated schema, rather than
// against a mock or a second copy of the SQL.
// -----------------------------------------------------------------------------
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { B2RefusalError } from './outbox-b2-lib.mjs';

const REPO_ROOT = resolve(import.meta.dirname, '..');
// The services' own startup gate (@rasta/nest-common runtime-role.ts), as built.
const { preflightRuntimeRole } = createRequire(import.meta.url)(
  join(REPO_ROOT, 'packages', 'nest-common', 'dist', 'index.js'),
);

/**
 * A port over one service's own generated Prisma client.
 *
 * Each service's client, not one shared client: A-01 says a service's database
 * is reached through that service's own datasource, and resolving the client
 * from the service directory is what makes a mistyped target fail to load
 * rather than quietly open the wrong database.
 *
 * `$transaction` with a callback gives a real transaction, so a batch that
 * trips the ordering guard rolls back with nothing written. `execute` runs a
 * statement outside any transaction — `outbox-b2-vacuum.mjs`'s `VACUUM`, which
 * PostgreSQL refuses inside a transaction block; the backfill itself never
 * vacuums (D-045).
 */
export function prismaPort(service, url) {
  const serviceDir = join(REPO_ROOT, 'services', `${service}-service`);
  const generated = join(serviceDir, 'src', 'generated', 'prisma');
  if (!existsSync(serviceDir)) {
    throw new B2RefusalError(`No such service directory: services/${service}-service.`);
  }
  if (!existsSync(generated)) {
    throw new B2RefusalError(
      `The Prisma client for ${service} has not been generated. ` +
        'Run `pnpm db:generate` before the B2 backfill.',
    );
  }

  const require = createRequire(join(serviceDir, 'package.json'));
  const { PrismaClient } = require(generated);
  const client = new PrismaClient({ datasources: { db: { url } } });

  const wrap = (handle) => ({
    query: (sql, params = []) =>
      params.length > 0 ? handle.$queryRawUnsafe(sql, ...params) : handle.$queryRawUnsafe(sql),
  });

  return {
    ...wrap(client),
    /**
     * D-045 (Codex on #178): before the first query, a short-lived client on
     * the same URL proves it is the service's runtime role — not its migrator,
     * an owner or a superuser — exactly as the service's own main.ts does.
     * Rejects with RuntimeRoleRefusedError, which names the role, never the URL.
     */
    preflight: (runtimeVariable) =>
      preflightRuntimeRole(() => new PrismaClient({ datasources: { db: { url } } }), {
        service: `${service}-service`,
        runtimeVariable,
      }),
    execute: (sql) => client.$executeRawUnsafe(sql),
    transaction: (fn) => client.$transaction((tx) => fn(wrap(tx))),
    close: () => client.$disconnect(),
  };
}
