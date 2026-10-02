/**
 * Whether a service's tenant guard covers its Prisma schema.
 *
 * `createTenantGuardExtension` (nest-common) scopes the models it is **told**
 * about and passes every other name straight through. That makes a typo in the
 * list invisible — marketplace-service listed `IdempotencyRecord` for a model
 * called `IdempotencyKey`, and the guard was silently off for it — and makes a
 * new model with an `organization_id` column unguarded until somebody
 * remembers. The guard cannot notice either, because it only ever sees the
 * names it was given.
 *
 * This reads the answer from the **Prisma DMMF** of the service's own generated
 * client (not from the schema text, so a rename the generator resolved, a
 * `@map`, or a model split across files are all seen as the client sees them)
 * and holds the service's list to it:
 *
 *  - every listed model **exists**, and has the tenant field the guard filters
 *    on (`organizationId` unless the service says otherwise);
 *  - every model with an `organization_id` **column** is either listed or
 *    **exempted with a written reason** — an exemption without a reason is not
 *    one;
 *  - an exemption names a model that exists, is not also listed, and is not
 *    there twice.
 *
 * The comparison is a pure function (`tenantScopeProblems`) so its own failure
 * modes are tested here; `describeTenantScopeCoverage` registers it as a
 * service's unit tests, one line in that service's `prisma/` folder.
 */

/** The part of a Prisma DMMF model this needs; structural, so no Prisma import. */
export interface DmmfModelLike {
  readonly name: string;
  readonly fields: ReadonlyArray<{ readonly name: string; readonly dbName?: string | null }>;
}

export interface TenantScopeInput {
  /** The service's `TENANT_SCOPED_MODELS`. */
  readonly scoped: readonly string[];
  /** Model name → why it carries an organization column and is not guarded. */
  readonly exemptions: Readonly<Record<string, string>>;
  /** `Prisma.dmmf.datamodel.models` of the service's generated client. */
  readonly models: readonly DmmfModelLike[];
  /** The field the guard filters on. */
  readonly tenantField?: string;
  /** The database column that makes a model tenant-owned. */
  readonly tenantColumn?: string;
}

/** Long enough to be a sentence, so "n/a" and "x" are not reasons. */
export const MIN_REASON_LENGTH = 30;

/** Every way the list and the schema can disagree, as readable sentences. Empty means they agree. */
export function tenantScopeProblems(input: TenantScopeInput): string[] {
  const tenantField = input.tenantField ?? 'organizationId';
  const tenantColumn = input.tenantColumn ?? 'organization_id';
  const problems: string[] = [];
  const byName = new Map(input.models.map((model) => [model.name, model]));

  if (input.models.length === 0) {
    return ['the DMMF has no models: the generated client was not read, so nothing was checked'];
  }

  const duplicates = (names: readonly string[]) =>
    names.filter((name, index) => names.indexOf(name) !== index);
  for (const name of new Set(duplicates(input.scoped))) {
    problems.push(`${name} is listed as tenant-scoped more than once`);
  }

  for (const name of input.scoped) {
    const model = byName.get(name);
    if (!model) {
      problems.push(
        `${name} is listed as tenant-scoped but is not a model in this service's schema ` +
          '(a typo, or a name from another service): the guard passes unknown names through, ' +
          'so it scopes nothing for it',
      );
      continue;
    }
    if (!model.fields.some((field) => field.name === tenantField)) {
      problems.push(
        `${name} is listed as tenant-scoped but has no \`${tenantField}\` field, ` +
          'which is what the guard filters and stamps',
      );
    }
  }

  for (const [name, reason] of Object.entries(input.exemptions)) {
    if (!byName.has(name)) {
      problems.push(`${name} is exempted from tenant scoping but is not a model in this schema`);
    }
    if (input.scoped.includes(name)) {
      problems.push(`${name} is both tenant-scoped and exempted; it can only be one`);
    }
    if (reason.trim().length < MIN_REASON_LENGTH) {
      problems.push(
        `${name} is exempted without a reason (at least ${MIN_REASON_LENGTH} characters saying why ` +
          'an organization-owned model is read or written without the guard)',
      );
    }
  }

  for (const model of input.models) {
    const ownsTenantColumn = model.fields.some(
      (field) => (field.dbName ?? field.name) === tenantColumn,
    );
    if (!ownsTenantColumn) continue;
    if (input.scoped.includes(model.name)) continue;
    if (Object.prototype.hasOwnProperty.call(input.exemptions, model.name)) continue;
    problems.push(
      `${model.name} has an \`${tenantColumn}\` column and is neither tenant-scoped nor exempted: ` +
        'list it in TENANT_SCOPED_MODELS, or add it to TENANT_SCOPE_EXEMPTIONS with the reason',
    );
  }

  return problems;
}

/**
 * Registers the coverage check as unit tests. Call it once, at the top level of
 * a spec file beside the service's `prisma.service.ts`:
 *
 * ```ts
 * import { Prisma } from '../generated/prisma';
 * import { describeTenantScopeCoverage } from '@rasta/testing';
 * import { TENANT_SCOPED_MODELS, TENANT_SCOPE_EXEMPTIONS } from './prisma.service';
 *
 * describeTenantScopeCoverage({
 *   scoped: TENANT_SCOPED_MODELS,
 *   exemptions: TENANT_SCOPE_EXEMPTIONS,
 *   models: Prisma.dmmf.datamodel.models,
 * });
 * ```
 */
export function describeTenantScopeCoverage(input: TenantScopeInput): void {
  describe('the tenant guard covers this service schema (DMMF)', () => {
    it('reads the models of the generated client, or every check below is vacuous', () => {
      expect(input.models.length).toBeGreaterThan(0);
      expect(input.scoped.length).toBeGreaterThan(0);
    });

    it('lists only models that exist, each with the field the guard filters on', () => {
      expect(
        tenantScopeProblems(input).filter(
          (problem) =>
            problem.includes('is not a model in this service') ||
            problem.includes('has no `') ||
            problem.includes('more than once'),
        ),
      ).toEqual([]);
    });

    it('guards or explicitly exempts every model with an organization column', () => {
      expect(
        tenantScopeProblems(input).filter((problem) => problem.includes('neither tenant-scoped')),
      ).toEqual([]);
    });

    it('gives every exemption a reason, a model that exists, and no double life as a guarded one', () => {
      expect(
        tenantScopeProblems(input).filter(
          (problem) => problem.includes('exempted') && !problem.includes('neither tenant-scoped'),
        ),
      ).toEqual([]);
    });

    it('has no other disagreement', () => {
      expect(tenantScopeProblems(input)).toEqual([]);
    });
  });
}
