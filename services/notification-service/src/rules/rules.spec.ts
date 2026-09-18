import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import {
  INSPECTION_EXPIRING_RULE,
  INSURANCE_EXPIRING_RULE,
  MAINTENANCE_DUE_RULE,
  RULES_BY_EVENT,
  RULES_BY_KEY,
  ruleForEvent,
  ruleForKey,
  SUBSCRIBED_TOPICS,
  TEMPLATE_CATALOGUE_VERSION,
  type NotificationRule,
} from './rules';
import { renderInApp } from './render';

/**
 * The rule catalogue's contract — with itself, and with the producers whose
 * payloads it reads.
 *
 * Producer schemas cannot be imported (AGENTS.md A-02), so the second half of
 * this file reads the producers' source text and checks the field names this
 * catalogue depends on are still declared there. A rename upstream fails here
 * at unit-test speed rather than as a poison event in a dead-letter topic.
 */

const REPO_ROOT = join(__dirname, '..', '..', '..', '..');

function producerSource(relative: string): string {
  return readFileSync(join(REPO_ROOT, 'services', relative), 'utf8');
}

/** The keys a `z.object` payload schema declares. */
function declaredKeys(rule: NotificationRule): string[] {
  const schema = rule.payloadSchema as unknown as z.ZodObject<z.ZodRawShape>;
  return Object.keys(schema.shape);
}

const RULES = [INSURANCE_EXPIRING_RULE, INSPECTION_EXPIRING_RULE, MAINTENANCE_DUE_RULE] as const;

describe('rule catalogue — NTF-001 cut', () => {
  it('holds exactly the three events the story names, and nothing else', () => {
    expect([...RULES_BY_EVENT.keys()].sort()).toEqual([
      'INSPECTION_EXPIRING',
      'INSURANCE_EXPIRING',
      'MAINTENANCE_DUE',
    ]);
    expect(RULES_BY_KEY.size).toBe(3);
    expect(ruleForEvent('BREAKDOWN_REPORTED')).toBeUndefined();
    expect(ruleForKey('nope')).toBeUndefined();
  });

  it('subscribes to exactly the two topics those events travel on', () => {
    expect([...SUBSCRIBED_TOPICS].sort()).toEqual(['rasta.insurance.v1', 'rasta.maintenance.v1']);
    for (const rule of RULES) expect(SUBSCRIBED_TOPICS).toContain(rule.topic);
  });

  it.each(RULES.map((rule) => [rule.ruleKey, rule] as const))(
    '%s: allowlist ⊆ payload, required variables ⊆ allowlist, subject id is allowlisted',
    (_key, rule) => {
      const declared = declaredKeys(rule);
      for (const key of rule.contextAllowlist) expect(declared).toContain(key);
      for (const variable of rule.template.requiredVariables) {
        expect(rule.contextAllowlist).toContain(variable);
      }
      expect(rule.template.version).toBe(TEMPLATE_CATALOGUE_VERSION);
      expect(rule.recipientRoles.length).toBeGreaterThan(0);
    },
  );

  it('never allowlists organizationId into context: the tenant lives on the row', () => {
    for (const rule of RULES) expect(rule.contextAllowlist).not.toContain('organizationId');
  });

  it('gives each rule a template whose placeholders are all declared', () => {
    for (const rule of RULES) {
      const placeholders = [
        ...`${rule.template.title} ${rule.template.body} ${rule.template.actionPath ?? ''}`.matchAll(
          /\{\{\s*(\w+)\s*\}\}/g,
        ),
      ].map((match) => match[1]);
      for (const name of placeholders) expect(rule.template.requiredVariables).toContain(name);
    }
  });

  it('renders each rule from a payload its producer would send', () => {
    const insurance = renderInApp(INSURANCE_EXPIRING_RULE.template, {
      assetId: 'AST_1',
      policyId: 'POL_1',
      insurerName: 'بیمه ایران',
      validTo: '2026-10-17',
      daysRemaining: 7,
    });
    expect(insurance.title.length).toBeGreaterThan(0);
    expect(insurance.body).toContain('AST_1');
    expect(insurance.actionPath).toBe('/assets/AST_1');

    const maintenance = renderInApp(MAINTENANCE_DUE_RULE.template, {
      assetId: 'AST_2',
      scheduleId: 'SCH_1',
      title: 'تعویض روغن',
      basis: 'HOURS',
      state: 'DUE_SOON',
      dueBy: null,
      dueAtMeter: '1200',
    });
    expect(maintenance.body).toContain('تعویض روغن');
  });

  it('buckets expiry rules by band and the maintenance rule by state', () => {
    const insurance = (daysRemaining: number) =>
      INSURANCE_EXPIRING_RULE.dedupeBucket({
        assetId: 'a',
        organizationId: 'o',
        policyId: 'p',
        insurerName: 'i',
        validTo: 'v',
        daysRemaining,
      });
    expect(insurance(25)).toBe('band:30');
    expect(insurance(2)).toBe('band:3');

    const due = (state: string) =>
      MAINTENANCE_DUE_RULE.dedupeBucket({
        scheduleId: 's',
        assetId: 'a',
        organizationId: 'o',
        title: 't',
        basis: 'TIME',
        state,
        dueBy: null,
        dueAtMeter: null,
      });
    expect(due('DUE_SOON')).toBe('state:DUE_SOON');
    expect(due('OVERDUE')).toBe('state:OVERDUE');
  });

  it('accepts a payload with extra fields — a producer adding one is not a poison event', () => {
    const parsed = INSURANCE_EXPIRING_RULE.payloadSchema.safeParse({
      assetId: 'a',
      organizationId: 'o',
      policyId: 'p',
      insurerName: 'i',
      validTo: 'v',
      daysRemaining: 3,
      newField: 'ignored',
    });
    expect(parsed.success).toBe(true);
  });
});

describe('the producers still declare the fields the catalogue reads', () => {
  const assetEvents = producerSource('asset-service/src/asset/events.ts');
  const maintenanceEvents = producerSource('maintenance-service/src/maintenance/events.ts');

  function fieldsOf(source: string, schemaName: string): string[] {
    const block = source.match(
      new RegExp(`export const ${schemaName} = z\\.object\\(\\{([\\s\\S]*?)\\}\\)`),
    );
    if (!block) throw new Error(`${schemaName} not found in producer source`);
    return [...(block[1] as string).matchAll(/^\s*(\w+):/gm)].map((match) => match[1] as string);
  }

  it('INSURANCE_EXPIRING', () => {
    const upstream = fieldsOf(assetEvents, 'insuranceExpiringPayload');
    for (const key of declaredKeys(INSURANCE_EXPIRING_RULE)) expect(upstream).toContain(key);
  });

  it('INSPECTION_EXPIRING', () => {
    const upstream = fieldsOf(assetEvents, 'inspectionExpiringPayload');
    for (const key of declaredKeys(INSPECTION_EXPIRING_RULE)) expect(upstream).toContain(key);
  });

  it('MAINTENANCE_DUE', () => {
    const upstream = fieldsOf(maintenanceEvents, 'maintenanceDuePayload');
    for (const key of declaredKeys(MAINTENANCE_DUE_RULE)) expect(upstream).toContain(key);
  });
});
