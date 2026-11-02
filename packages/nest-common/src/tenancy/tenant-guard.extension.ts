import { AsyncLocalStorage } from 'node:async_hooks';
import { scalarRelationPolicy, type ScalarFkFamily } from './scalar-relation-policy';
import { getOrganizationId, tryGetContext } from '../context/request-context';
import { RastaError } from '../errors/rasta-error';

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
 * fixed platform refusal instead of a silent cross-tenant read.
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
  'updateManyAndReturn',
  'delete',
  'deleteMany',
  'upsert',
]);

const CREATE_OPERATIONS = new Set(['create', 'createMany', 'createManyAndReturn']);
const UPDATE_OPERATIONS = new Set(['update', 'updateMany', 'updateManyAndReturn']);

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
    throw RastaError.forbidden('runUnscoped() requires a written reason of at least 10 characters');
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

/** Structural subset of Prisma.dmmf.datamodel; no dependency on a service's generated client. */
export interface TenantDatamodel {
  models: readonly {
    name: string;
    fields: readonly {
      name: string;
      kind: string;
      type: string;
      isList: boolean;
      relationName?: string;
      relationFromFields?: readonly string[];
      relationToFields?: readonly string[];
    }[];
  }[];
}

interface NestedWriteReview {
  /** Prisma model and relation field, for example Order.lines. */
  relation: string;
  reason: string;
}
const nestedWriteStorage = new AsyncLocalStorage<NestedWriteReview>();

/**
 * Opts one call site into one reviewed relation. This does not bypass scoping:
 * nested data and selectors are still restricted to the acting organization.
 * Return the query (or await it) here so its lazy execution retains the review.
 */
export function runWithNestedTenantWrite<T>(review: NestedWriteReview, fn: () => T): T {
  if (!review.relation || review.reason.trim().length < 10) {
    throw RastaError.forbidden('A nested tenant write requires a relation and a reviewed reason');
  }
  return nestedWriteStorage.run({ ...review }, () => {
    const result = fn();
    if (isThenable(result)) {
      return new Promise((resolve, reject) => result.then(resolve, reject)) as T;
    }
    return result;
  });
}

export interface TenantGuardOptions {
  /** Missing family or unknown owning relation fails closed on scalar FK writes. */
  scalarFkFamily?: ScalarFkFamily;
  /** Always pass Prisma.dmmf.datamodel from this service's generated client. */
  datamodel: TenantDatamodel;
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

  const models = new Map(options.datamodel.models.map((model) => [model.name, model]));
  for (const model of scoped) if (!models.has(model)) refuse();

  function writeData(
    model: string,
    value: unknown,
    create: boolean,
    inheritedTenant = false,
  ): unknown {
    if (Array.isArray(value)) {
      // Empty tenant batches still require context, just like nonempty writes.
      if (scoped.has(model)) actingOrganization();
      return value.map((row) => writeData(model, row, create, inheritedTenant));
    }
    let row = record(value);
    if (scoped.has(model)) {
      const organizationId = actingOrganization();
      if (create) {
        // The same create path protects direct create, bulk create and upsert.
        row = injectTenantOnCreate({ data: row }, tenantColumn, organizationId).data as Record<
          string,
          unknown
        >;
      } else {
        const existing = row[tenantColumn];
        if (
          existing !== undefined &&
          existing !== organizationId &&
          !(
            isRecord(existing) &&
            Object.keys(existing).length === 1 &&
            existing.set === organizationId
          )
        ) {
          refuse();
        }
      }
    }
    const result = { ...row };
    // Prisma omits the owning composite FK columns from nested create input:
    // they come from the guarded parent in the same statement. Validate the
    // caller's tenant above, then let that FK carry it rather than resending it.
    if (create && inheritedTenant) delete result[tenantColumn];
    const metadata = models.get(model);
    if (!metadata) refuse();
    for (const field of metadata.fields) {
      if (field.kind !== 'object') continue;
      const relation = `${model}.${field.name}`;
      const from = field.relationFromFields ?? [];
      if (from.length && from.some((column) => row[column] !== undefined)) {
        const policy = scalarRelationPolicy(options.scalarFkFamily, relation);
        if (policy === 'UNCLASSIFIED') refuse();
        if (policy === 'SAME_TENANT' || policy === 'PROTECTED_BY_COMPOSITE_FK') {
          // No precheck: the database checks the owner in the write itself,
          // including bulk/returning statements and concurrent owner changes.
          const index = from.indexOf(tenantColumn);
          if (
            !scoped.has(model) ||
            !scoped.has(field.type) ||
            index < 0 ||
            field.relationToFields?.[index] !== tenantColumn
          )
            refuse();
        }
      }
      if (row[field.name] === undefined) continue;
      const tenantTarget = scoped.has(field.type);
      if (tenantTarget) {
        actingOrganization();
        if (nestedWriteStorage.getStore()?.relation !== relation) refuse();
      }
      const actions = record(row[field.name]);
      const rewritten: Record<string, unknown> = {};
      for (const [action, input] of Object.entries(actions)) {
        if (input === undefined) continue;
        // An inverse to-one replacement may clear a previous tenant's child
        // FK before linking the new child. Its incoming selector cannot scope
        // that implicit write. Even an owning FK can evict another parent
        // through a unique relation, so its ownership alone is not proof.
        if (
          (tenantTarget || scoped.has(model)) &&
          !field.isList &&
          ['create', 'createMany', 'connect', 'connectOrCreate', 'upsert'].includes(action)
        ) {
          refuse();
        }
        const owning = field.relationName
          ? models
              .get(field.type)
              ?.fields.find(
                (other) =>
                  other.kind === 'object' &&
                  other.relationName === field.relationName &&
                  other.relationFromFields?.includes(tenantColumn),
              )
          : undefined;
        const tenantIndex = owning?.relationFromFields?.indexOf(tenantColumn) ?? -1;
        const inheritsTenant =
          scoped.has(model) &&
          tenantTarget &&
          !from.length &&
          tenantIndex >= 0 &&
          owning?.relationToFields?.[tenantIndex] === tenantColumn;
        rewritten[action] = nestedAction(field.type, action, input, field.isList, inheritsTenant);
      }
      result[field.name] = rewritten;
    }
    return result;
  }

  function selector(model: string, input: unknown): Record<string, unknown> {
    const where = record(input);
    return scoped.has(model)
      ? (injectTenantFilter({ where }, tenantColumn, actingOrganization()).where as Record<
          string,
          unknown
        >)
      : where;
  }

  function nestedAction(
    model: string,
    action: string,
    input: unknown,
    isList: boolean,
    inheritedTenant = false,
  ): unknown {
    // set also disconnects omitted existing children, including foreign ones;
    // even an empty set has effects that its input cannot tenant-constrain.
    if (action === 'set' && scoped.has(model)) refuse();
    if (Array.isArray(input))
      return input.map((item) => nestedAction(model, action, item, isList, inheritedTenant));
    switch (action) {
      case 'create':
        return writeData(model, input, true, inheritedTenant);
      case 'createMany': {
        const envelope = record(input);
        return { ...envelope, data: writeData(model, envelope.data, true, inheritedTenant) };
      }
      case 'connect':
      case 'set':
      case 'deleteMany':
        return selector(model, input);
      case 'delete':
      case 'disconnect':
        // Boolean to-one mutations have no selector. Refuse on tenant targets;
        // callers can supply a where input or use a separate guarded operation.
        if (typeof input === 'boolean' && !scoped.has(model)) return input;
        return selector(model, input);
      case 'connectOrCreate': {
        const envelope = record(input);
        return {
          ...envelope,
          where: selector(model, envelope.where),
          create: writeData(model, envelope.create, true, inheritedTenant),
        };
      }
      case 'upsert': {
        const envelope = record(input);
        return {
          ...envelope,
          where: selector(model, envelope.where ?? {}),
          create: writeData(model, envelope.create, true, inheritedTenant),
          update: writeData(model, envelope.update, false),
        };
      }
      case 'update': {
        const envelope = record(input);
        if (!('data' in envelope) && !isList) {
          return { where: selector(model, {}), data: writeData(model, envelope, false) };
        }
        return {
          ...envelope,
          where: selector(model, envelope.where ?? {}),
          data: writeData(model, envelope.data, false),
        };
      }
      case 'updateMany': {
        const envelope = record(input);
        return {
          ...envelope,
          where: selector(model, envelope.where ?? {}),
          data: writeData(model, envelope.data, false),
        };
      }
      default:
        return refuse();
    }
  }

  return {
    name: 'rasta-tenant-guard',
    query: {
      $allModels: {
        async $allOperations(params: QueryExtensionArgs): Promise<unknown> {
          const { model, operation, args, query } = params;

          const unscopedReason = currentUnscopedReason();
          if (unscopedReason !== undefined) {
            options.onUnscopedQuery?.({ model, operation, reason: unscopedReason });
            return query(args);
          }

          if (!models.has(model)) refuse();
          if (
            scoped.has(model) &&
            !CREATE_OPERATIONS.has(operation) &&
            !SCOPED_OPERATIONS.has(operation)
          ) {
            refuse();
          }
          // Inspect write data even under platform models (User -> Membership).
          // JSON/scalar fields never participate: only DMMF relation fields do.
          let next = args;
          if (CREATE_OPERATIONS.has(operation)) {
            next = { ...args, data: writeData(model, args.data, true) };
          } else if (UPDATE_OPERATIONS.has(operation)) {
            next = { ...args, data: writeData(model, args.data, false) };
          } else if (operation === 'upsert') {
            next = {
              ...args,
              create: writeData(model, args.create, true),
              update: writeData(model, args.update, false),
            };
          }
          if (scoped.has(model) && !CREATE_OPERATIONS.has(operation)) {
            next = injectTenantFilter(next, tenantColumn, actingOrganization());
          }
          return query(next);
        },
      },
    },
  };
}

function refuse(): never {
  throw new RastaError(
    'TENANT_MISMATCH',
    'Tenant write boundary refused the operation; cross-tenant writes are never implicit. Use runUnscoped() only for reviewed platform operations.',
  );
}

function actingOrganization(): string {
  const context = tryGetContext();
  if (!context || (!context.organizationId && context.authType !== 'SERVICE')) {
    throw RastaError.internal(
      'No RequestContext tenant: tenant-scoped data was accessed without an acting organization',
    );
  }
  // Preserve ADR-035's actionable refusal for service calls lacking org_id.
  return getOrganizationId();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) refuse();
  return value;
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
    refuse();
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
    refuse();
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
    throw RastaError.notFound(resourceName);
  }

  const context = tryGetContext();
  if (!context?.organizationId) return;

  if (entity[column] !== context.organizationId) {
    throw new RastaError('TENANT_MISMATCH', 'Tenant boundary violation');
  }
}
