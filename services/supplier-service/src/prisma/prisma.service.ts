import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { createTenantGuardExtension } from '@rasta/nest-common';
import { PrismaClient } from '../generated/prisma';

/**
 * Models carrying an `organizationId` and therefore scoped automatically
 * (AGENTS.md A-04).
 *
 * Listed explicitly, because the two directions of a mistake are not
 * symmetrical: a model wrongly listed produces an immediate, obvious query
 * error, while a model wrongly omitted produces a silent cross-tenant read.
 * `tenant-scope.spec.ts` compares this list against the schema so an omission
 * fails a test rather than passing review.
 *
 * Every domain model carries the column, including the two — `Qualification`
 * and `QualificationEvidence` — that could have reached it through a join to
 * `Supplier`. The column is denormalised precisely so the guard can see it: a
 * guard that has to join is a guard that does not run on a `findMany`.
 */
export const TENANT_SCOPED_MODELS = [
  'Supplier',
  'SupplierCapability',
  'Qualification',
  'QualificationEvidence',
  'Suspension',
  // ADR-052 step 3 — scoped by the supplier organization the fact is about.
  'PerformanceEvent',
  // ADR-052 step 4 — a snapshot and its provenance, scoped the same way.
  'PerformanceScoreSnapshot',
  'PerformanceScoreComponent',
  'PerformanceScoreSourceEvent',
] as const;

/**
 * Models that carry an organization column and are still not guarded.
 *
 * Named rather than merely left out, so the spec can compare the guarded set
 * against the schema exactly instead of allowing any omission. An exemption has
 * to be written down to exist.
 *
 * `OutboxMessage` is the platform's standing exception: the outbox is plumbing
 * written by a relay that has no request context, and it carries its own tenant
 * column for filtering. Same exception every other service makes.
 */
export const TENANT_SCOPE_EXEMPT_MODELS = ['OutboxMessage'] as const;

/**
 * Models that deliberately carry **no** organization column, and why.
 *
 * The guard derives nothing from these — there is no column to scope on — but
 * a table without a tenant key in a multi-tenant service is a claim that has
 * to be written down, so `tenant-scope.spec.ts` requires every model without
 * `organizationId` to appear here or in `PLUMBING_MODELS`.
 *
 * The performance formula is platform-wide configuration: ADR-052 § 3 allows
 * one ACTIVE version at any moment, and the score it produces is one public
 * score per supplier that buyers in every tenant read (§ 16). docs/24 Q-75,
 * closed by the project owner: only SYSTEM_ADMIN changes it. Every query on
 * these models runs under `runUnscoped` with that reason
 * (`performance/formula.repository.ts`), the precedent being
 * economic-service's `reward_evaluation_cutover`.
 */
export const PLATFORM_SCOPED_MODELS = {
  PerformanceFormulaVersion: 'the platform-wide performance formula (ADR-052 § 3, docs/24 Q-75)',
  PerformanceFormulaWeight: 'the weights of that formula, frozen with their version',
} as const;

/** Relay and consumer bookkeeping with no tenant meaning (ADR-021, ADR-032, ADR-051). */
export const PLUMBING_MODELS = ['OutboxStreamSequence', 'ProcessedEvent'] as const;

/** What `assertRuntimeRole` reads about the connected role. */
export interface RuntimeRoleFacts {
  role: string;
  database: string;
  schema: string;
  superuser: boolean;
  createDb: boolean;
  createRole: boolean;
  databaseOwner: boolean;
  schemaOwner: boolean;
}

/** Every reason the connected role may not run the service; empty when it may. */
export function runtimeRoleProblems(facts: RuntimeRoleFacts): string[] {
  const problems: string[] = [];
  if (facts.superuser) problems.push('is a superuser');
  if (facts.createDb) problems.push('holds CREATEDB');
  if (facts.createRole) problems.push('holds CREATEROLE');
  if (facts.databaseOwner) problems.push(`can act as the owner of database ${facts.database}`);
  if (facts.schemaOwner) problems.push(`can act as an owner in schema ${facts.schema}`);
  return problems;
}

export type ExtendedPrismaClient = ReturnType<PrismaService['buildClient']>;

@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
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
          // Every deliberate boundary crossing is recorded with its written
          // reason, so an auditor can enumerate them without reading the whole
          // codebase (ADR-011).
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
   * Refuses to run as a role that could remove this service's own guarantees.
   *
   * The performance tables are append-only, frozen or insert-only by trigger,
   * and a trigger binds only a role that cannot drop or disable it. The
   * database and every object in it belong to `rasta_supplier_migrator`
   * (infrastructure/docker/postgres/lib/supplier-privilege-split.bash); this
   * service must connect as `rasta_supplier`, which owns nothing. So startup
   * asks the catalogue who it is and stops if that role:
   *
   *   * is a superuser;
   *   * holds CREATEDB or CREATEROLE;
   *   * can act as the owner of this database — it could DROP DATABASE;
   *   * can act as the owner of the schema it is connected to, or of any
   *     relation in it — it could disable a trigger, alter or drop a table.
   *
   * Called by `AppModule` before the relay starts. Not in `onModuleInit`
   * here: tests open owner connections through this class on purpose.
   */
  async assertRuntimeRole(): Promise<void> {
    const rows = await this.base.$queryRaw<RuntimeRoleFacts[]>`
      SELECT current_user::text AS role,
             current_database()::text AS database,
             current_schema()::text AS schema,
             r.rolsuper AS superuser,
             r.rolcreatedb AS "createDb",
             r.rolcreaterole AS "createRole",
             EXISTS (
               SELECT 1 FROM pg_database d
                WHERE d.datname = current_database()
                  AND pg_has_role(current_user, d.datdba, 'USAGE')
             ) AS "databaseOwner",
             (
               EXISTS (
                 SELECT 1 FROM pg_namespace n
                  WHERE n.nspname = current_schema()
                    AND pg_has_role(current_user, n.nspowner, 'USAGE')
               )
               OR EXISTS (
                 SELECT 1 FROM pg_class c
                   JOIN pg_namespace n ON n.oid = c.relnamespace
                  WHERE n.nspname = current_schema()
                    AND pg_has_role(current_user, c.relowner, 'USAGE')
               )
             ) AS "schemaOwner"
        FROM pg_roles r
       WHERE r.rolname = current_user
    `;
    const row = rows[0];
    if (!row) throw new Error('supplier-service could not read the role it is connected as');
    const reasons = runtimeRoleProblems(row);
    if (reasons.length > 0) {
      throw new Error(
        `supplier-service refuses to start: it is connected as ${row.role}, which ` +
          `${reasons.join(', ')}. Only the runtime role (DATABASE_URL_SUPPLIER) may run the ` +
          'service; the migrator (DATABASE_URL_SUPPLIER_MIGRATOR) is for migration tooling only.',
      );
    }
    this.logger.log(
      `Connected as ${row.role}: not a superuser, no CREATEDB, owns nothing in ${row.database}`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.base.$disconnect();
  }

  /**
   * Liveness of the database dependency, for the readiness probe.
   *
   * Returns false rather than throwing: an unhealthy dependency is a reported
   * state, not an exception.
   */
  async isHealthy(): Promise<boolean> {
    try {
      await this.base.$queryRaw`SELECT 1`;
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Runs `fn` inside a transaction.
   *
   * Exposed deliberately: the outbox pattern requires the state change and the
   * outbox insert to share one transaction, and that is the whole reason the
   * platform does not lose or invent events (AGENTS.md A-08, ADR-021).
   */
  transaction<T>(fn: (tx: ExtendedPrismaClient) => Promise<T>): Promise<T> {
    return this.client.$transaction((tx) => fn(tx as ExtendedPrismaClient));
  }
}
