import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EventEnvelope } from '@rasta/contracts';
import { UnprocessableEventError, type EventDelivery } from '@rasta/nest-common';
import { toCommissionRuleChanges } from './commission-rule-change-projection';
import { toAuditEventRecord } from './audit.mapper';

/**
 * A commission rule change keeps its terms in the audit record (docs/23 D-057;
 * Codex round 1 on #307, F5), by economic's own contract.
 */

const ECONOMIC_SOURCE = readFileSync(
  join(__dirname, '..', '..', '..', 'economic-service', 'src', 'events', 'events.ts'),
  'utf8',
);
const PINNED_SOURCE = readFileSync(join(__dirname, 'commission-rule-change-projection.ts'), 'utf8');

const PINNED_DECLARATIONS = [
  'amountMinor',
  'changeIsCoherent',
  'CHANGE_KINDS',
  'commissionRuleTermsV1',
  'commissionRuleTermsV2',
  'commissionRuleChangedPayloadV1',
  'commissionRuleChangedPayloadV2',
] as const;

/** Removes block comments and whole-line `//` comments; leaves code (and regex literals) alone. */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** `[export ]const <name> = …;` up to the first `;` at bracket depth zero, whitespace removed. */
function declaration(source: string, name: string): string {
  const text = withoutComments(source);
  const start = new RegExp(`^(?:export )?const ${name} = `, 'm').exec(text);
  if (!start) throw new Error(`const ${name} is not declared`);
  let depth = 0;
  for (let index = start.index; index < text.length; index += 1) {
    const char = text[index];
    if (char === '(' || char === '[' || char === '{') depth += 1;
    else if (char === ')' || char === ']' || char === '}') depth -= 1;
    else if (char === ';' && depth === 0) {
      return text.slice(start.index, index + 1).replace(/\s+/g, '');
    }
  }
  throw new Error(`const ${name} has no end`);
}

function pinnedRegion(): string {
  const begin = PINNED_SOURCE.indexOf('// --- BEGIN PINNED COPY');
  const end = PINNED_SOURCE.indexOf('// --- END PINNED COPY ---');
  if (begin < 0 || end < begin) throw new Error('the pinned markers are missing');
  return PINNED_SOURCE.slice(begin, end);
}

describe("the pinned copy of economic's commission-rule contract", () => {
  it.each(PINNED_DECLARATIONS)('declares %s exactly as economic does', (name) => {
    expect(declaration(PINNED_SOURCE, name)).toBe(declaration(ECONOMIC_SOURCE, name));
  });

  it('carries nothing between its markers but those declarations', () => {
    const declared = [...withoutComments(pinnedRegion()).matchAll(/^(?:export )?const (\w+) =/gm)]
      .map((match) => match[1])
      .sort();
    expect(declared).toEqual([...PINNED_DECLARATIONS].sort());
  });

  it('publishes the two versions it decodes (economic ECONOMIC_EVENT_VERSIONS)', () => {
    // The producer publishes v2 and the decoders keep v1; a third version
    // economic adds must reach this projection in the same review.
    expect(ECONOMIC_SOURCE).toMatch(/\[ECONOMIC_EVENTS\.COMMISSION_RULE_CHANGED\]: 2,/);
  });
});

const ECONOMIC: EventDelivery = Object.freeze({ topic: 'rasta.economic.v1', partition: 0 });
const RULE = 'CMR_01JTESTRULE0000000000000000';

const termsV2 = (overrides: Record<string, unknown> = {}) => ({
  organizationId: 'ORG_A',
  businessLine: 'MAINTENANCE',
  transactionType: null,
  rateBasisPoints: 120,
  minAmountMinor: null,
  maxAmountMinor: '5000000',
  validFrom: '2026-10-16T08:00:00.000Z',
  validTo: null,
  status: 'ACTIVE',
  label: null,
  ...overrides,
});

const { businessLine: _line, ...termsV1Base } = termsV2({ transactionType: 'MAINTENANCE_SERVICE' });
const termsV1 = (overrides: Record<string, unknown> = {}) => ({ ...termsV1Base, ...overrides });

function envelope(
  payload: Record<string, unknown>,
  overrides: Partial<EventEnvelope> = {},
): EventEnvelope {
  return {
    eventId: 'EVT_01JTEST000000000000000000',
    eventName: 'COMMISSION_RULE_CHANGED',
    eventVersion: 2,
    occurredAt: '2026-10-16T08:00:00.000Z',
    producer: 'economic-service',
    producerVersion: '1.0.0',
    aggregateType: 'CommissionRule',
    aggregateId: RULE,
    tenantId: 'ORG_A',
    correlationId: 'COR_01JTEST000000000000000000',
    payload,
    ...overrides,
  } as EventEnvelope;
}

const record = (change: 'CREATED' | 'UPDATED', before: unknown, after: unknown) => ({
  ruleId: RULE,
  change,
  changedBy: 'USR_ADMIN',
  changedAt: '2026-10-16T08:00:00.000Z',
  before,
  after,
});

function refusalOf(run: () => unknown): UnprocessableEventError {
  try {
    run();
  } catch (error) {
    if (error instanceof UnprocessableEventError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('toCommissionRuleChanges', () => {
  it('records every term of a created rule, from null', () => {
    expect(toCommissionRuleChanges(envelope(record('CREATED', null, termsV2())), ECONOMIC)).toEqual(
      [
        { field: 'organizationId', from: null, to: 'ORG_A' },
        { field: 'businessLine', from: null, to: 'MAINTENANCE' },
        { field: 'transactionType', from: null, to: null },
        { field: 'rateBasisPoints', from: null, to: 120 },
        { field: 'minAmountMinor', from: null, to: null },
        { field: 'maxAmountMinor', from: null, to: '5000000' },
        { field: 'validFrom', from: null, to: '2026-10-16T08:00:00.000Z' },
        { field: 'validTo', from: null, to: null },
        { field: 'status', from: null, to: 'ACTIVE' },
        { field: 'label', from: null, to: null },
      ],
    );
  });

  it('records only what an update changed: a rule ended now', () => {
    const ended = termsV2({ validTo: '2026-10-17T00:00:00.000Z' });
    expect(
      toCommissionRuleChanges(envelope(record('UPDATED', termsV2(), ended)), ECONOMIC),
    ).toEqual([{ field: 'validTo', from: null, to: '2026-10-17T00:00:00.000Z' }]);
  });

  it('records a withdrawal and a relabel as they happened', () => {
    const after = termsV2({ status: 'INACTIVE', label: 'withdrawn before start' });
    expect(
      toCommissionRuleChanges(envelope(record('UPDATED', termsV2(), after)), ECONOMIC),
    ).toEqual([
      { field: 'status', from: 'ACTIVE', to: 'INACTIVE' },
      { field: 'label', from: null, to: 'withdrawn before start' },
    ]);
  });

  it('decodes a v1 record from before business lines (no businessLine field)', () => {
    const v1 = envelope(record('UPDATED', termsV1(), termsV1({ status: 'INACTIVE' })), {
      eventVersion: 1,
    });
    expect(toCommissionRuleChanges(v1, ECONOMIC)).toEqual([
      { field: 'status', from: 'ACTIVE', to: 'INACTIVE' },
    ]);
  });

  it('refuses a v2 shape sent as v1, and a v1 shape sent as v2', () => {
    const v2AsV1 = envelope(record('CREATED', null, termsV2()), { eventVersion: 1 });
    expect(refusalOf(() => toCommissionRuleChanges(v2AsV1, ECONOMIC)).reason).toBe(
      'VALIDATION_FAILED',
    );
    const v1AsV2 = envelope(record('CREATED', null, termsV1()));
    expect(refusalOf(() => toCommissionRuleChanges(v1AsV2, ECONOMIC)).reason).toBe(
      'VALIDATION_FAILED',
    );
  });

  it('refuses a version economic never published', () => {
    const v3 = envelope(record('CREATED', null, termsV2()), { eventVersion: 3 });
    expect(refusalOf(() => toCommissionRuleChanges(v3, ECONOMIC)).reason).toBe(
      'SCHEMA_VERSION_UNSUPPORTED',
    );
  });

  it('refuses a malformed payload without naming any value', () => {
    const bad = envelope(record('CREATED', null, termsV2({ rateBasisPoints: 'secret-figure' })));
    const refusal = refusalOf(() => toCommissionRuleChanges(bad, ECONOMIC));
    expect(refusal.reason).toBe('VALIDATION_FAILED');
    expect(refusal.message).toContain('after.rateBasisPoints:invalid_type');
    expect(refusal.message).not.toContain('secret-figure');
  });

  it('refuses an incoherent change record (UPDATED with no before)', () => {
    const bad = envelope(record('UPDATED', null, termsV2()));
    expect(refusalOf(() => toCommissionRuleChanges(bad, ECONOMIC)).reason).toBe(
      'VALIDATION_FAILED',
    );
  });

  it("refuses a payload about another rule than the envelope's aggregate", () => {
    const bad = envelope({ ...record('CREATED', null, termsV2()), ruleId: 'CMR_OTHER' });
    expect(refusalOf(() => toCommissionRuleChanges(bad, ECONOMIC)).message).toContain(
      'ruleId is not the envelope aggregateId',
    );
  });

  it('refuses a label past the platform bound on a change value rather than truncating it', () => {
    const bad = envelope(record('CREATED', null, termsV2({ label: 'x'.repeat(2001) })));
    expect(refusalOf(() => toCommissionRuleChanges(bad, ECONOMIC)).reason).toBe(
      'VALIDATION_FAILED',
    );
  });

  it('ignores the same name on another topic, and every other economic event', () => {
    const payload = record('CREATED', null, termsV2());
    expect(
      toCommissionRuleChanges(envelope(payload), { topic: 'rasta.contract.v1', partition: 0 }),
    ).toBeNull();
    expect(
      toCommissionRuleChanges(envelope(payload, { eventName: 'REWARD_RULE_CHANGED' }), ECONOMIC),
    ).toBeNull();
  });
});

describe('toAuditEventRecord with a commission rule change', () => {
  it('keeps the delta in `changes`, and nothing else of the payload', () => {
    const ended = termsV2({ validTo: '2026-10-17T00:00:00.000Z' });
    const stored = toAuditEventRecord(envelope(record('UPDATED', termsV2(), ended)), ECONOMIC);
    expect(stored.changes).toEqual([
      { field: 'validTo', from: null, to: '2026-10-17T00:00:00.000Z' },
    ]);
    expect(stored.action).toBe('COMMISSION_RULE_CHANGED');
    expect(stored.resourceId).toBe(RULE);
    expect(JSON.stringify(stored)).not.toContain('USR_ADMIN');
  });

  it('leaves every other economic record without a `changes` key', () => {
    const other = toAuditEventRecord(
      envelope({ anything: 1 }, { eventName: 'JOURNAL_POSTED', eventVersion: 1 }),
      ECONOMIC,
    );
    expect('changes' in other).toBe(false);
  });
});
