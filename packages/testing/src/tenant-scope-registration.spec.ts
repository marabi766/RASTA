import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every service that installs the tenant guard also runs the coverage check.
 *
 * `describeTenantScopeCoverage` only protects a service that calls it, and a
 * new service (or a new guard in an old one) that forgot to would be exactly the
 * silent gap the check exists to close. So this asks the repository instead of
 * trusting a list: any `services/*` whose `prisma.service.ts` exports
 * `TENANT_SCOPED_MODELS` must have a spec beside it that calls
 * `describeTenantScopeCoverage`, with that service's own list and exemptions.
 */
const SERVICES = join(__dirname, '..', '..', '..', 'services');

const withGuard = readdirSync(SERVICES, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .filter((name) => {
    const file = join(SERVICES, name, 'src', 'prisma', 'prisma.service.ts');
    return (
      existsSync(file) && /export const TENANT_SCOPED_MODELS\b/.test(readFileSync(file, 'utf8'))
    );
  })
  .sort();

describe('the tenant-scope coverage check is registered in every service with a guard', () => {
  it('finds the services that install the guard, or this proves nothing', () => {
    expect(withGuard.length).toBeGreaterThanOrEqual(10);
  });

  it.each(withGuard)(
    '%s calls describeTenantScopeCoverage with its own list and exemptions',
    (name) => {
      const dir = join(SERVICES, name, 'src', 'prisma');
      const specs = readdirSync(dir)
        .filter((file) => file.endsWith('.spec.ts'))
        .map((file) => readFileSync(join(dir, file), 'utf8'))
        .filter((text) => text.includes('describeTenantScopeCoverage('));

      expect(specs).toHaveLength(1);
      const text = specs[0] as string;
      expect(text).toContain('scoped: TENANT_SCOPED_MODELS');
      expect(text).toMatch(/exemptions: TENANT_SCOPE_EXEMPTIONS/);
      expect(text).toContain('Prisma.dmmf.datamodel.models');
    },
  );
});
