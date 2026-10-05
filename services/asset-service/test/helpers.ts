import { withUtcSession } from '@rasta/config';
import { ulid } from 'ulid';
import { runWithContext, type RequestContext } from '@rasta/nest-common';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Shared scaffolding for asset-service integration tests.
 *
 * Deliberately thin, for the same reason fleet-service's is: the point of
 * these tests is that they touch the real database — PostGIS included, since
 * the radius search is raw SQL that Prisma never sees — so anything that hides
 * the database behind a helper defeats them.
 */

export function databaseUrl(): string {
  const url = process.env.DATABASE_URL ?? process.env.DATABASE_URL_ASSET;
  if (!url) {
    throw new Error(
      'DATABASE_URL_ASSET is not set. These tests run against a real PostgreSQL with PostGIS; ' +
        'start it with `pnpm infra:up` and copy .env.example to .env.',
    );
  }
  return withUtcSession(url);
}

/**
 * The owner of rasta_asset (`DATABASE_URL_ASSET_MIGRATOR`), for the suite that
 * re-runs a shipped migration file and calls the SQL function it creates.
 * **Required, with no fallback** to the runtime URL: since D-045 the runtime
 * role owns nothing, can create nothing and may not execute the migrator's
 * functions — falling back would only fail later, for a reason that hides the
 * missing variable.
 */
export function ownerDatabaseUrl(): string {
  const url = process.env.DATABASE_URL_ASSET_MIGRATOR;
  if (!url) {
    throw new Error(
      'DATABASE_URL_ASSET_MIGRATOR is not set. Migration files run as the owner, never the ' +
        'runtime role; see .env.migrator.example (docs/23 D-045).',
    );
  }
  return withUtcSession(url);
}

export function newPrisma(): PrismaService {
  return new PrismaService(databaseUrl());
}

export function id(prefix: string): string {
  return `${prefix}_${ulid()}`;
}

/**
 * Two organizations, generated fresh per run.
 *
 * Generated rather than fixed so a re-run cannot collide with rows an earlier
 * run left behind, and so a tenant-isolation assertion is proving isolation
 * between two tenants that genuinely exist rather than between a tenant and an
 * empty set.
 */
export function tenants() {
  const suffix = ulid().slice(-10);
  return { a: `ORG-ITEST-A-${suffix}`, b: `ORG-ITEST-B-${suffix}` };
}

export interface ActorOptions {
  organizationId: string;
  userId?: string;
  roles?: string[];
}

/**
 * Runs `fn` as a user acting for an organization.
 *
 * The tenant guard reads the organization from this context, and so does
 * `AssetService.nearby` — which is the whole point here: the radius search is
 * raw SQL outside the Prisma extension, so its scoping is only as good as the
 * organization the service passes down.
 *
 * Wrapped in `async () => fn()` rather than passed straight through: a Prisma
 * query is lazy, so a caller that built the promise outside the context would
 * run it outside the context too.
 */
export function asActor<T>(options: ActorOptions, fn: () => Promise<T>): Promise<T> {
  const context: RequestContext = {
    correlationId: `itest-${ulid()}`,
    requestId: `itest-${ulid()}`,
    organizationId: options.organizationId,
    userId: options.userId ?? `USR-ITEST-${ulid().slice(-8)}`,
    roles: options.roles ?? ['FLEET_MANAGER'],
    organizationIds: [],
    authType: 'USER',
    startedAt: Date.now(),
  };

  return runWithContext(context, async () => fn());
}
