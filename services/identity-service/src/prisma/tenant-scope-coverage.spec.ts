import { describeTenantScopeCoverage } from '@rasta/testing';
import { Prisma } from '../generated/prisma';
import { TENANT_SCOPED_MODELS, TENANT_SCOPE_EXEMPTIONS } from './prisma.service';

/**
 * Holds the tenant guard's list to this service's generated Prisma client:
 * every listed model exists, and every model with an `organization_id` column is
 * listed or exempted with a written reason. The comparison is shared
 * (`@rasta/testing`), so the rule is the same in every service that has a guard.
 */
describeTenantScopeCoverage({
  scoped: TENANT_SCOPED_MODELS,
  exemptions: TENANT_SCOPE_EXEMPTIONS,
  models: Prisma.dmmf.datamodel.models,
});
