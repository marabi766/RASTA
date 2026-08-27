import { AsyncLocalStorage } from 'node:async_hooks';
import { getOrganizationId, tryGetContext } from '../context/request-context';

/**
 * Automatic tenant scoping at the data layer.
 *
 * ADR-011 promises that "a query that forgets its scope leaks data" is not a
 * risk we manage by review alone. This is the mechanism that makes good on
 * that: a Prisma client extension that injects `organizationId` into every
 * query against a tenant-scoped model, before it reaches the database.
 *
 * The important property is the failure mode. If there is no request context,
 * the query **throws** rather than running unscoped. A missing tenant becomes a
 * loud 500 in development instead of a silent cross-tenant read in production.
 *
 * Escaping the scope requires calling {@link runUnscoped} with a written
 * reason, which makes every legitimate cross-tenant path greppable.
 */

/** The Prisma operations that read or write rows and therefore need scoping. */
const SCOPED_OPERATIONS = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
  'update',
  'updateMany',
  'delete',
  'deleteMany',
  'upsert',
]);

const CREATE_OPERATIONS = new Set(['create', 'createMany']);

interface UnscopedMarker {
  reason: string;
}

const unscopedStorage = new AsyncLocalStorage<UnscopedMarker>();

/**
 * Runs `fn` with tenant scoping disabled.
 *
 * Reserved for genuine platform-wide operations: administrative listings,
 * cross-tenant reporting, background reconciliation. The `reason` is required
 * and is recorded, so an auditor can enumerate every place the boundary is
 * deliberately crossed.
 */
export function runUnscoped<T>(reason: string, fn: () => T): T {
  if (!reason || reason.trim().length < 10) {
    throw new Error('runUnscoped() requires a written reason of at least 10 characters');
  }

  return unscopedStorage.run({ reason }, () => {
    const result = fn();

    // A Prisma query is *lazy*: `client.asset.findFirst(...)` builds a
    // PrismaPromise and runs nothing until something calls `.then` on it. If
    // the caller writes `runUnscoped(reason, () => client.asset.findFirst(…))`
    // — the obvious form — that `.then` happens on the outer `await`, after
    // this scope has already closed, and the query executes *scoped* after
    // all. The failure is silent and reads as correct code: the row is simply
    // not found.
    //
    // Calling `.then` here, inside the scope, is what makes the operation
    // actually run unscoped. It costs one extra promise link and removes a
    // trap that every future call site would otherwise have to remember.
    if (isThenable(result)) {
      // `new Promise` runs its executor synchronously, so `.then` is called
      // while the scope is still open — and the caller gets a real Promise
      // back whatever the thenable's own `then` happens to return.
      return new Promise((resolve, reject) => {
        result.then(resolve, reject);
      }) as T;
    }

    return result;
  });
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

export function isUnscoped(): boolean {
  return unscopedStorage.getStore() !== undefined;
}

export function currentUnscopedReason(): string | undefined {
  return unscopedStorage.getStore()?.reason;
}

export interface TenantGuardOptions {
  /**
   * Models carrying an `organizationId` column.
   *
   * Listed explicitly rather than inferred, because the consequence of a wrong
   * guess differs sharply by direction: a model wrongly listed produces an
   * immediate, obvious query error, while a model wrongly omitted produces a
   * silent leak. Explicit listing makes the safe direction the default.
   */
  scopedModels: readonly string[];
  /** Column name, if a service deviates from the convention. */
  tenantColumn?: string;
  /** Called when a query is executed unscoped, for audit logging. */
  onUnscopedQuery?: (info: { model: string; operation: string; reason: string }) => void;
}

interface QueryExtensionArgs {
  model: string;
  operation: string;
  args: Record<string, unknown>;
  query: (args: Record<string, unknown>) => Promise<unknown>;
}

/**
 * Builds the `$extends` argument for a Prisma client.
 *
 * Typed structurally so this package does not depend on Prisma — each service
 * generates its own client from its own schema (ADR-005), and nest-common must
 * not couple to any one of them.
 */
export function createTenantGuardExtension(options: TenantGuardOptions) {
  const tenantColumn = options.tenantColumn ?? 'organizationId';
  const scoped = new Set(options.scopedModels);

  return {
    name: 'rasta-tenant-guard',
    query: {
      $allModels: {
        async $allOperations(params: QueryExtensionArgs): Promise<unknown> {
          const { model, operation, args, query } = params;

          if (!scoped.has(model)) {
            return query(args);
          }

          const unscopedReason = currentUnscopedReason();
          if (unscopedReason !== undefined) {
            options.onUnscopedQuery?.({ model, operation, reason: unscopedReason });
            return query(args);
          }

          if (CREATE_OPERATIONS.has(operation)) {
            return query(injectTenantOnCreate(args, tenantColumn, getOrganizationId()));
          }

          if (!SCOPED_OPERATIONS.has(operation)) {
            return query(args);
          }

          // findUnique accepts non-unique filters alongside the unique field
          // since Prisma 5 (extendedWhereUnique), so the same injection works
          // for every read operation without rewriting the operation itself.
          const organizationId = getOrganizationId();
          return query(injectTenantFilter(args, tenantColumn, organizationId));
        },
      },
    },
  };
}

export function injectTenantFilter(
  args: Record<string, unknown>,
  column: string,
  organizationId: string,
): Record<string, unknown> {
  const where = (args.where ?? {}) as Record<string, unknown>;

  // A caller-supplied value is preserved only when it matches. Silently
  // overwriting a mismatched value would hide a bug; letting it through would
  // be the leak itself.
  const existing = where[column];
  if (existing !== undefined && existing !== organizationId) {
    throw new Error(
      `Query specified ${column}="${String(existing)}" but the request acts for ` +
        `"${organizationId}". Use runUnscoped() if this is intentional.`,
    );
  }

  return { ...args, where: { ...where, [column]: organizationId } };
}

export function injectTenantOnCreate(
  args: Record<string, unknown>,
  column: string,
  organizationId: string,
): Record<string, unknown> {
  const data = args.data;

  if (Array.isArray(data)) {
    return {
      ...args,
      data: data.map((row) => applyTenant(row as Record<string, unknown>, column, organizationId)),
    };
  }

  if (data && typeof data === 'object') {
    return { ...args, data: applyTenant(data as Record<string, unknown>, column, organizationId) };
  }

  return args;
}

function applyTenant(
  row: Record<string, unknown>,
  column: string,
  organizationId: string,
): Record<string, unknown> {
  const existing = row[column];
  if (existing !== undefined && existing !== organizationId) {
    throw new Error(
      `Attempted to create a row with ${column}="${String(existing)}" while acting for ` +
        `"${organizationId}". Cross-tenant writes are never implicit.`,
    );
  }
  return { ...row, [column]: organizationId };
}

/**
 * Confirms a row belongs to the requesting tenant.
 *
 * A defence-in-depth check for paths that bypass the extension — raw SQL,
 * results handed across a service boundary, cached values. Cheap enough to
 * call liberally.
 */
export function assertTenantOwned<T extends Record<string, unknown>>(
  entity: T | null | undefined,
  resourceName: string,
  column = 'organizationId',
): asserts entity is T {
  if (!entity) {
    // Handled by the caller's notFound path; this only narrows the type.
    throw new Error(`${resourceName} not found`);
  }

  const context = tryGetContext();
  if (!context?.organizationId) return;

  if (entity[column] !== context.organizationId) {
    throw new Error(
      `Tenant boundary violation: ${resourceName} belongs to "${String(entity[column])}" ` +
        `but the request acts for "${context.organizationId}".`,
    );
  }
}
