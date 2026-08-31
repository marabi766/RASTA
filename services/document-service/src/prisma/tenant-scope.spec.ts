import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TENANT_SCOPED_MODELS, TENANT_SCOPE_EXEMPT_MODELS } from './prisma.service';

/**
 * Proves the tenant guard is configured for **this** service's schema.
 *
 * It was not. `TENANT_SCOPED_MODELS` held marketplace-service's model names —
 * `Product`, `Offer`, `Order`, `OrderLine`, `Fulfillment`, `Review` — none of
 * which exist in this database. `createTenantGuardExtension` passes any model
 * it does not recognise straight through, so the guard scoped nothing at all
 * while looking installed, and the `runUnscoped(...)` markers in the
 * repository recorded crossings of a boundary that was not there.
 *
 * A list can be wrong the same way twice, so this test does not contain one.
 * It derives the answer from `schema.prisma` — every model with an
 * `organizationId` field must be guarded, minus the exemptions the service
 * names and justifies. Adding a tenant-scoped model without listing it fails
 * here, at unit-test speed, rather than silently widening what a query returns.
 */

const SCHEMA = readFileSync(join(__dirname, '..', '..', 'prisma', 'schema.prisma'), 'utf8');

/** Every `model X { ... }` block in the schema, as name → body. */
function models(schema: string): Map<string, string> {
  const found = new Map<string, string>();
  const pattern = /^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm;

  for (const match of schema.matchAll(pattern)) {
    found.set(match[1] as string, match[2] as string);
  }
  return found;
}

function modelsWithTenantColumn(schema: string): string[] {
  return [...models(schema)]
    .filter(([, body]) => /^\s*organizationId\s/m.test(body))
    .map(([name]) => name)
    .sort();
}

describe('the tenant guard covers this service schema', () => {
  it('finds the models it is meant to be comparing against', () => {
    // Guards the guard. A regex that stopped matching would make every
    // assertion below trivially true against an empty set.
    expect(models(SCHEMA).size).toBeGreaterThanOrEqual(4);
    expect([...models(SCHEMA).keys()]).toEqual(
      expect.arrayContaining(['Document', 'UploadIntent', 'AccessGrant', 'OutboxMessage']),
    );
  });

  it('scopes every model that carries an organization, and no others', () => {
    const shouldBeScoped = modelsWithTenantColumn(SCHEMA).filter(
      (model) => !(TENANT_SCOPE_EXEMPT_MODELS as readonly string[]).includes(model),
    );

    expect([...TENANT_SCOPED_MODELS].sort()).toEqual(shouldBeScoped);
  });

  it('names no model this schema does not define', () => {
    // The failure that actually happened: names from another service's schema,
    // silently ignored at runtime.
    const defined = new Set(models(SCHEMA).keys());
    const unknown = [...TENANT_SCOPED_MODELS].filter((model) => !defined.has(model));

    expect(unknown).toEqual([]);
  });

  it('exempts the outbox, and says so rather than omitting it quietly', () => {
    // The outbox is written by a relay with no request context and filtered by
    // its own tenant column. That is a real exception, and it is listed as one
    // so the derived comparison above stays exact instead of being loosened.
    expect(TENANT_SCOPE_EXEMPT_MODELS).toContain('OutboxMessage');
    expect(modelsWithTenantColumn(SCHEMA)).toContain('OutboxMessage');
  });
});
