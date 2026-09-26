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
      expect.arrayContaining(['Project', 'ProjectNeed', 'IdempotencyKey', 'OutboxMessage']),
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

  it('guards the need, which could have reached the tenant through its project', () => {
    // A guard that has to join is a guard that does not run on a `findMany`.
    expect(TENANT_SCOPED_MODELS).toContain('ProjectNeed');
  });

  it('binds a need to its project and its tenant together', () => {
    // The composite foreign key: a need of organization A can never reference
    // a project of organization B, whatever a future write path forgets.
    expect(SCHEMA).toMatch(
      /@relation\(fields: \[organizationId, projectId\], references: \[organizationId, id\]/,
    );
  });
});

describe('the schema keeps history from being erased', () => {
  it('uses no cascading delete anywhere', () => {
    // One DELETE on a project must not silently remove the needs recorded
    // against it — those are rows an audit reads.
    expect(SCHEMA).not.toMatch(/onDelete:\s*Cascade/);
  });

  it('restricts every relation', () => {
    const restricts = [...SCHEMA.matchAll(/onDelete:\s*(\w+)/g)].map((match) => match[1]);

    expect(restricts.length).toBeGreaterThanOrEqual(1);
    expect(new Set(restricts)).toEqual(new Set(['Restrict']));
  });
});

describe('the schema models nothing CON-001 PR 1 has not decided', () => {
  it('has no approval, policy, tender or progress model yet', () => {
    // Approvals and progress are PR 2 (ADR-063, Q-70, Q-72); tenders CON-002.
    const names = [...models(SCHEMA).keys()];
    expect(names.filter((name) => /Approval|Policy|Tender|Bid|Progress/i.test(name))).toEqual([]);
  });

  it('stores no document reference', () => {
    // Attachments are Q-72; no column claims a document before that is decided.
    expect(SCHEMA).not.toMatch(/^\s*documentId\s/m);
  });
});
