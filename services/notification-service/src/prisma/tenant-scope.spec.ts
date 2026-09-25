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
      'NotificationPreference',
      'NotificationQuietHours',
      'NotificationTemplate',
      'NotificationTemplateVersion',
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

  it('exempts exactly five models, and names each one', () => {
    // Asserted in full rather than by membership: a model added to the schema
    // and quietly added here too would otherwise never be read by anybody, and
    // "unscoped" is the one property in this file that must not be acquirable
    // without a reviewer noticing.
    expect([...TENANT_SCOPE_EXEMPT_MODELS]).toEqual([
      'OutboxMessage',
      'OutboxStreamSequence',
      'ProcessedEvent',
      'NotificationTemplate',
      'NotificationTemplateVersion',
    ]);
  });

  // Four of the five carry no organization column at all, so exempting them
  // costs nothing. The template pair is platform configuration: the same text
  // for every tenant, seeded from the code catalogue and written by nothing
  // else.
  it.each([
    'ProcessedEvent',
    'OutboxStreamSequence',
    'NotificationTemplate',
    'NotificationTemplateVersion',
  ])('exempts %s, which has no tenant', (model) => {
    expect(modelsWithTenantColumn(SCHEMA)).not.toContain(model);
  });

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

  /**
   * This assertion used to read `toEqual(['IN_APP'])`, and widening it rather
   * than deleting it is the point.
   *
   * The invariant was never "there is one channel". It is **no channel value
   * exists that no code path can write** — the Q-07 rule this service has
   * already applied to an enum value, to a configuration flag and to a
   * preference row. NTF-004 gave `EMAIL` a writer, so `EMAIL` may exist.
   * `SMS` may not: Q-15 has no answer and there is no adapter.
   */
  it('holds exactly the channels something can actually deliver on', () => {
    const channel = SCHEMA.match(/enum NotificationChannel \{([\s\S]*?)\}/)?.[1] ?? '';
    const values = channel
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^[A-Z_]+$/.test(line));
    expect(values).toEqual(['IN_APP', 'EMAIL']);
    expect(values).not.toContain('SMS');
    expect(values).not.toContain('PUSH');
  });

  /**
   * NTF-003 brought the preference model; the template model is still NTF-004's.
   *
   * Splitting the old single assertion rather than loosening it: "no preference
   * *or* template" passed for two different reasons, and an assertion that can
   * pass for a reason you did not mean is one that stops testing the other.
   */
  it('declares the preference model', () => {
    expect([...models(SCHEMA).keys()]).toContain('NotificationPreference');
  });

  /**
   * The inversion NTF-004 promised, with the invariant kept.
   *
   * The old assertion — no template model — was a statement about scope. What
   * matters now is the property the tables have to carry: a published version
   * is immutable, so a delivery citing `(templateKey, version)` still answers
   * "exactly what did we send them" after the text is next edited. Hence the
   * content hash, and hence a key that makes a new version a row rather than
   * an update.
   */
  it('declares the template model, with versions that can be pinned', () => {
    const names = [...models(SCHEMA).keys()];
    expect(names).toContain('NotificationTemplate');
    expect(names).toContain('NotificationTemplateVersion');

    const version = models(SCHEMA).get('NotificationTemplateVersion') ?? '';
    expect(version).toMatch(/contentHash/);
    expect(version).toMatch(/@@id\(\[templateKey, channel, version, locale\]\)/);
  });

  it('keeps a quiet window per person per tenant, not per preference row', () => {
    // ADR-054 § 5 draws quiet hours as columns on the preference table, which
    // holds one row per scope per channel — so one person could hold three
    // windows for one channel with nothing saying which a delivery obeys. The
    // deviation is recorded in the migration header and in the plan; this is
    // what makes it visible in the schema rather than only in prose.
    const quiet = models(SCHEMA).get('NotificationQuietHours') ?? '';
    expect(quiet).toMatch(/@@id\(\[organizationId, userId\]\)/);
    expect(models(SCHEMA).get('NotificationPreference') ?? '').not.toMatch(/quietHours/);
  });

  it('uses no cascading delete anywhere', () => {
    expect(SCHEMA).not.toMatch(/onDelete:\s*Cascade/);
    const restricts = [...SCHEMA.matchAll(/onDelete:\s*(\w+)/g)].map((match) => match[1]);
    expect(restricts.length).toBeGreaterThanOrEqual(4);
    expect(new Set(restricts)).toEqual(new Set(['Restrict']));
  });
});
