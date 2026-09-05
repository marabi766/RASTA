import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TENANT_SCOPED_MODELS, TENANT_SCOPE_EXEMPT_MODELS } from './prisma.service';

/**
 * Proves the tenant guard is configured for **this** service's schema.
 *
 * document-service learned why this test has to exist: its
 * `TENANT_SCOPED_MODELS` held marketplace-service's model names, none of which
 * existed in its database. `createTenantGuardExtension` passes any model it does
 * not recognise straight through, so the guard scoped nothing at all while
 * looking installed, and every `runUnscoped(...)` marker recorded the crossing
 * of a boundary that was not there.
 *
 * A list can be wrong the same way twice, so this test does not contain one. It
 * derives the answer from `schema.prisma`: every model with an `organizationId`
 * field must be guarded, minus the exemptions the service names and justifies.
 * Adding a tenant-scoped model without listing it fails here, at unit-test
 * speed, rather than silently widening what a query returns.
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
    expect(models(SCHEMA).size).toBeGreaterThanOrEqual(6);
    expect([...models(SCHEMA).keys()]).toEqual(
      expect.arrayContaining([
        'Supplier',
        'SupplierCapability',
        'Qualification',
        'QualificationEvidence',
        'Suspension',
        'OutboxMessage',
      ]),
    );
  });

  it('scopes every model that carries an organization, and no others', () => {
    const shouldBeScoped = modelsWithTenantColumn(SCHEMA).filter(
      (model) => !(TENANT_SCOPE_EXEMPT_MODELS as readonly string[]).includes(model),
    );

    expect([...TENANT_SCOPED_MODELS].sort()).toEqual(shouldBeScoped);
  });

  it('names no model this schema does not define', () => {
    const defined = new Set(models(SCHEMA).keys());
    const unknown = [...TENANT_SCOPED_MODELS].filter((model) => !defined.has(model));

    expect(unknown).toEqual([]);
  });

  it('exempts the outbox, and says so rather than omitting it quietly', () => {
    expect(TENANT_SCOPE_EXEMPT_MODELS).toContain('OutboxMessage');
    expect(modelsWithTenantColumn(SCHEMA)).toContain('OutboxMessage');
  });

  it('guards the two models that could have reached the tenant through a join', () => {
    // `Qualification` and `QualificationEvidence` both hang off `Supplier`, so
    // the column on them is denormalised. That is deliberate: a guard that has
    // to join is a guard that does not run on a `findMany`.
    expect(TENANT_SCOPED_MODELS).toContain('Qualification');
    expect(TENANT_SCOPED_MODELS).toContain('QualificationEvidence');
  });
});

describe('the schema keeps history from being erased', () => {
  it('uses no cascading delete anywhere', () => {
    // "No destructive cascade may erase qualification or suspension history
    // accidentally." One DELETE on `supplier` must not silently remove every
    // decision anybody recorded about it — those are the rows an audit reads.
    expect(SCHEMA).not.toMatch(/onDelete:\s*Cascade/);
  });

  it('restricts every relation that points at a supplier or a qualification', () => {
    const restricts = [...SCHEMA.matchAll(/onDelete:\s*(\w+)/g)].map((match) => match[1]);

    expect(restricts.length).toBeGreaterThanOrEqual(4);
    expect(new Set(restricts)).toEqual(new Set(['Restrict']));
  });
});

describe('the schema models nothing Q-12 has not decided', () => {
  it('has no performance score or performance event model', () => {
    // Q-12 — the formula and its weights — is open. A column storing a number
    // nobody has agreed how to compute would become the number people build on.
    const names = [...models(SCHEMA).keys()];

    expect(names.filter((name) => /Performance|Score|Rating/i.test(name))).toEqual([]);
  });

  it('has no licence model with a validity period', () => {
    // A licence has an issuing authority, a validity period and a renewal rule.
    // The product document names none of them (AGENTS.md § 9).
    const names = [...models(SCHEMA).keys()];

    expect(names.filter((name) => /Licen[cs]e/i.test(name))).toEqual([]);
    expect(SCHEMA).not.toMatch(/^\s*(validUntil|expiresAt|renewalDueAt)\s/m);
  });
});
