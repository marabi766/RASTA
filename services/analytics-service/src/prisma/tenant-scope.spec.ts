import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TENANT_SCOPED_MODELS, TENANT_SCOPE_EXEMPT_MODELS } from './prisma.service';

/**
 * Proves the tenant guard is configured for **this** service's schema, derived from
 * `schema.prisma` rather than from a second list (the lesson document-service learned:
 * a guard listing another service's models scopes nothing while looking installed).
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
    // Guards the guard: a regex that stopped matching would make every assertion below
    // trivially true against an empty set.
    expect([...models(SCHEMA).keys()]).toEqual(
      expect.arrayContaining(['FactMaintenance', 'ProcessedEvent']),
    );
  });

  it('scopes every model that carries an organization, and no others', () => {
    const shouldBeScoped = modelsWithTenantColumn(SCHEMA).filter(
      (model) => !(TENANT_SCOPE_EXEMPT_MODELS as readonly string[]).includes(model),
    );

    expect([...TENANT_SCOPED_MODELS].sort()).toEqual(shouldBeScoped);
  });

  it('exempts nothing: the idempotency marker and the coverage start carry no organization to scope', () => {
    expect(TENANT_SCOPE_EXEMPT_MODELS).toEqual([]);
    expect(modelsWithTenantColumn(SCHEMA)).not.toContain('ProcessedEvent');
    // Deployment-wide by design (Q-154): consumption is not per tenant.
    expect(modelsWithTenantColumn(SCHEMA)).not.toContain('ProjectionCoverage');
  });
});

describe('the schema models nothing RUN-001 PR 2 has not decided', () => {
  it('has the first fact, consumer marker, baseline and projection coverage only (ADR-071 § 3, § 6)', () => {
    // Each PR adds its models here, so an unplanned one still fails this test.
    expect([...models(SCHEMA).keys()].sort()).toEqual([
      'BaselineMetric',
      'FactMaintenance',
      'ProcessedEvent',
      'ProjectionCoverage',
    ]);
  });

  it('stores money as a bigint of minor units beside its currency, and no float anywhere', () => {
    expect(SCHEMA).toMatch(/totalCostMinor\s+BigInt/);
    expect(SCHEMA).toMatch(/currency\s+String/);
    expect(SCHEMA).not.toMatch(/\b(Float|Decimal)\b/);
  });

  it('is born timestamptz: no plain timestamp column (D-048)', () => {
    const plain = [...SCHEMA.matchAll(/^\s*(\w+)\s+DateTime\??\s*(?!.*@db\.Timestamptz).*$/gm)]
      .map((match) => match[0].trim())
      .filter((line) => !line.includes('@db.Timestamptz'));
    expect(plain).toEqual([]);
  });

  it('keeps no person on a fact: no user, actor, name or free-text column (ADR-071 § 2 (6))', () => {
    const fact = models(SCHEMA).get('FactMaintenance') ?? '';
    expect(fact).toMatch(/requestId/);
    expect(fact).not.toMatch(/^\s*\w*(By|UserId|Name|Title|Note|Reason)\s/m);
  });

  it('uses no cascading delete anywhere', () => {
    expect(SCHEMA).not.toMatch(/onDelete:\s*Cascade/);
  });
});
