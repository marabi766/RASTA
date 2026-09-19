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
      'OutboxMessage',
      'OutboxStreamSequence',
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

  it('exempts exactly three models, and names each one', () => {
    expect([...TENANT_SCOPE_EXEMPT_MODELS]).toEqual([
      'OutboxMessage',
      'OutboxStreamSequence',
      'ProcessedEvent',
    ]);
  });

  // Two of the three carry no organization column at all, so exempting them
  // costs nothing.
  it.each(['ProcessedEvent', 'OutboxStreamSequence'])(
    'exempts %s, which has no tenant',
    (model) => {
      expect(modelsWithTenantColumn(SCHEMA)).not.toContain(model);
    },
  );

  /**
   * `OutboxMessage` is the one exemption that gives something up, so it is
   * asserted rather than assumed.
   *
   * It carries an organization column and is still unscoped, because the relay
   * that claims, publishes and acknowledges its rows runs on a timer with no
   * request context — a guard would refuse every one of those statements. The
   * crossing is declared at each write with `runUnscoped` and a written reason.
   */
  it('exempts the outbox deliberately, even though it does carry a tenant column', () => {
    expect(modelsWithTenantColumn(SCHEMA)).toContain('OutboxMessage');
    expect(TENANT_SCOPE_EXEMPT_MODELS).toContain('OutboxMessage');
    expect(TENANT_SCOPED_MODELS).not.toContain('OutboxMessage');
  });

  it('guards the children that could have reached the tenant through a join', () => {
    expect(TENANT_SCOPED_MODELS).toContain('RecipientResolution');
    expect(TENANT_SCOPED_MODELS).toContain('DeliveryAttempt');
    expect(TENANT_SCOPED_MODELS).toContain('InAppNotification');
  });
});

describe('the schema says what this service does and does not do', () => {
  /**
   * This assertion used to say the opposite.
   *
   * `NTF-001` shipped with no outbox because this service consumed events and
   * published none, and the test pinned that as a fact about the design.
   * `ADR-054 § 3` then recorded why it could not stay that way: reading and
   * dismissing a notification are state changes, `AGENTS.md` S-06 requires an
   * audit record for every state change, and `audit-service` has one input —
   * the event log. The absence was a deviation from a binding rule, accepted
   * only as a draft state, and `NTF-002` could not be accepted until it closed.
   */
  it('declares an outbox, because its state changes have to reach the audit trail', () => {
    expect(SCHEMA).toMatch(/model\s+OutboxMessage\b/);
    expect(SCHEMA).toMatch(/model\s+OutboxStreamSequence\b/);
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
