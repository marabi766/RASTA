import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TENANT_SCOPED_MODELS, TENANT_SCOPE_EXEMPT_MODELS } from './prisma.service';

/**
 * Proves the tenant guard is configured for **this** service's schema.
 *
 * document-service learned why this test has to exist (D-022): its
 * `TENANT_SCOPED_MODELS` held another service's model names, none of which
 * existed in its database, so the guard scoped nothing at all while looking
 * installed. A list can be wrong the same way twice, so this test derives the
 * answer from `schema.prisma`: every model with an `organizationId` field must
 * be guarded, minus the exemptions the service names and justifies.
 */

const SCHEMA = readFileSync(join(__dirname, '..', '..', 'prisma', 'schema.prisma'), 'utf8');

function models(schema: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const match of schema.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
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
    expect([...models(SCHEMA).keys()].sort()).toEqual([
      'DeliveryAttempt',
      'InAppNotification',
      'NotificationDedupe',
      'NotificationDelivery',
      'NotificationIntent',
      'ProcessedEvent',
      'RecipientResolution',
    ]);
  });

  it('scopes every model that carries an organization, and no others', () => {
    const shouldBeScoped = modelsWithTenantColumn(SCHEMA).filter(
      (model) => !(TENANT_SCOPE_EXEMPT_MODELS as readonly string[]).includes(model),
    );
    expect([...TENANT_SCOPED_MODELS].sort()).toEqual(shouldBeScoped);
  });

  it('names no model this schema does not define', () => {
    const defined = new Set(models(SCHEMA).keys());
    expect([...TENANT_SCOPED_MODELS].filter((model) => !defined.has(model))).toEqual([]);
  });

  it('exempts only the idempotency marker, which carries no tenant column', () => {
    expect([...TENANT_SCOPE_EXEMPT_MODELS]).toEqual(['ProcessedEvent']);
    expect(modelsWithTenantColumn(SCHEMA)).not.toContain('ProcessedEvent');
  });

  it('guards the children that could have reached the tenant through a join', () => {
    expect(TENANT_SCOPED_MODELS).toContain('RecipientResolution');
    expect(TENANT_SCOPED_MODELS).toContain('DeliveryAttempt');
    expect(TENANT_SCOPED_MODELS).toContain('InAppNotification');
  });
});

describe('the schema says what NTF-001 does not do', () => {
  it('declares no outbox, so the discovery guard correctly ignores this service', () => {
    expect(SCHEMA).not.toMatch(/model\s+OutboxMessage\b/);
  });

  it('holds IN_APP as the only channel value', () => {
    const channel = SCHEMA.match(/enum NotificationChannel \{([\s\S]*?)\}/)?.[1] ?? '';
    const values = channel
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^[A-Z_]+$/.test(line));
    expect(values).toEqual(['IN_APP']);
  });

  it('declares no preference or template model yet', () => {
    const names = [...models(SCHEMA).keys()];
    expect(names.filter((name) => /Preference|Template/.test(name))).toEqual([]);
  });

  it('uses no cascading delete anywhere', () => {
    expect(SCHEMA).not.toMatch(/onDelete:\s*Cascade/);
    const restricts = [...SCHEMA.matchAll(/onDelete:\s*(\w+)/g)].map((match) => match[1]);
    expect(restricts.length).toBeGreaterThanOrEqual(4);
    expect(new Set(restricts)).toEqual(new Set(['Restrict']));
  });
});
