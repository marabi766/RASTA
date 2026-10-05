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
    expect([...models(SCHEMA).keys()]).toEqual(
      expect.arrayContaining(['Contract', 'OutboxMessage', 'OutboxStreamSequence']),
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

  it('guards the contract, the aggregate root of this service', () => {
    expect(TENANT_SCOPED_MODELS).toContain('Contract');
  });
});

describe('the schema keeps history from being erased', () => {
  it('uses no cascading delete anywhere', () => {
    expect(SCHEMA).not.toMatch(/onDelete:\s*Cascade/);
  });
});

describe('the schema models nothing CON-003 has not decided so far', () => {
  it('has the contract, its signatures, the idempotency store and the approval policies (statements, amendments and milestones are later PRs)', () => {
    // Each step adds its models here, so an unplanned one still fails this test.
    const names = [...models(SCHEMA).keys()].filter(
      (name) => !['OutboxMessage', 'OutboxStreamSequence'].includes(name),
    );
    expect(names).toEqual([
      'Contract',
      'ContractSignature',
      'ApprovalPolicy',
      'ApprovalPolicyStep',
      'IdempotencyKey',
    ]);
  });

  it('stores money as a bigint of minor units and no float anywhere', () => {
    expect(SCHEMA).toMatch(/amountMinor\s+BigInt/);
    expect(SCHEMA).not.toMatch(/\b(Float|Decimal)\b/);
  });

  it('is born timestamptz: no plain timestamp column (D-048)', () => {
    const plain = [...SCHEMA.matchAll(/^\s*(\w+)\s+DateTime\??\s*(?!.*@db\.Timestamptz).*$/gm)]
      .map((match) => match[0].trim())
      .filter((line) => !line.includes('@db.Timestamptz'));
    expect(plain).toEqual([]);
  });

  it('stores no document reference', () => {
    // The contract file belongs to document-service; no column claims one yet.
    expect(SCHEMA).not.toMatch(/^\s*documentId\s/m);
  });
});
