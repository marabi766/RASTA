import { Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { SERVICE_NAME } from '../config/env';
import {
  createTenantGuardExtension,
  assertRuntimeRole as assertConnectedRuntimeRole,
} from '@rasta/nest-common';
import { PrismaClient } from '../generated/prisma';

/**
 * Models carrying an `organizationId` and therefore scoped automatically (AGENTS.md A-04).
 *
 * Listed explicitly, because the two directions of a mistake are not symmetrical: a model
 * wrongly listed produces an immediate query error, while a model wrongly omitted produces a
 * silent cross-tenant read. `tenant-scope.spec.ts` derives the expected list from
 * `schema.prisma`, so an omission fails a unit test rather than passing review.
 */
export const TENANT_SCOPED_MODELS = ['FactMaintenance'] as const;

/**
 * Models that carry an organization column and are still not guarded. None: the only
 * unguarded model, `ProcessedEvent`, has no organization column to guard.
 */
export const TENANT_SCOPE_EXEMPTIONS: Readonly<Record<string, string>> = {};

/** The names, for callers that only need to know what is exempt. */
export const TENANT_SCOPE_EXEMPT_MODELS: readonly string[] = Object.keys(TENANT_SCOPE_EXEMPTIONS);

export type ExtendedPrismaClient = ReturnType<PrismaService['buildClient']>;

@Injectable()
export class PrismaService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(PrismaService.name);
  private readonly base: PrismaClient;

  /** The client every repository uses. Tenant scoping is already applied. */
  readonly client: ExtendedPrismaClient;

  constructor(databaseUrl: string) {
    this.base = new PrismaClient({
      datasources: { db: { url: databaseUrl } },
      log: [
        { emit: 'event', level: 'warn' },
        { emit: 'event', level: 'error' },
      ],
    });
    this.client = this.buildClient();
  }

  private buildClient() {
    return this.base.$extends(
      createTenantGuardExtension({
        scopedModels: TENANT_SCOPED_MODELS,
        onUnscopedQuery: ({ model, operation, reason }) => {
          // Every deliberate boundary crossing is recorded with its written reason, so an
          // auditor can enumerate them (ADR-011).
          this.logger.warn(`Unscoped query on ${model}.${operation} — reason: ${reason}`);
        },
      }),
    );
  }

  async onModuleInit(): Promise<void> {
    await this.base.$connect();
    this.logger.log('Database connection established');
  }

  /**
   * Refuses to run as anything but this service's runtime role (D-045): not a superuser, not
   * a migrator, owning nothing and holding no CREATE — what the catalogue says about the role
   * actually connected (@rasta/nest-common runtime-role.ts).
   *
   * Called first in `AppModule.onModuleInit`. Not in `onModuleInit` here: the integration
   * suites open owner connections through this class on purpose.
   */
  async assertRuntimeRole(): Promise<void> {
    const facts = await assertConnectedRuntimeRole(this.base, {
      service: SERVICE_NAME,
      runtimeVariable: 'DATABASE_URL_ANALYTICS',
    });
    this.logger.log(
      `Connected as ${facts.role}: not a superuser or a migrator, owns nothing, no CREATE`,
    );
  }

  /**
   * The last thing the close does (#337 r1, Medium): Nest's `onApplicationShutdown`, after the
   * destroy phase — in which `AppModule` stops the projection by the shutdown deadline — and
   * after the HTTP server has closed. Disconnecting in the destroy phase instead ran before
   * `AppModule`'s own hook (Nest destroys a module's providers before the module), so a
   * handler still in flight lost its database under it.
   */
  async onApplicationShutdown(): Promise<void> {
    await this.disconnect();
  }

  async disconnect(): Promise<void> {
    await this.base.$disconnect();
  }

  /** Liveness of the database, for the readiness probe. Never throws. */
  async isHealthy(): Promise<boolean> {
    try {
      await this.base.$queryRaw`SELECT 1`;
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Runs `fn` inside a transaction: a projection's marker and its fact commit together or
   * not at all (docs/07 § 7.5).
   */
  transaction<T>(fn: (tx: ExtendedPrismaClient) => Promise<T>): Promise<T> {
    return this.client.$transaction((tx) => fn(tx as ExtendedPrismaClient));
  }
}
