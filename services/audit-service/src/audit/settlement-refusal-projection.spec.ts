import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EventEnvelope } from '@rasta/contracts';
import { UnprocessableEventError, type EventDelivery } from '@rasta/nest-common';
import { toSettlementRefusalProjection } from './settlement-refusal-projection';
import { toAuditEventRecord } from './audit.mapper';

/**
 * A refused settlement is stored as a refusal, with its reason, business line and transaction
 * type (docs/24 Q-29; review of #364 round 1, F3), by economic's own contract.
 */

const ECONOMIC_SOURCE = readFileSync(
  join(__dirname, '..', '..', '..', 'economic-service', 'src', 'events', 'events.ts'),
  'utf8',
);
const PINNED_SOURCE = readFileSync(join(__dirname, 'settlement-refusal-projection.ts'), 'utf8');

const PINNED_DECLARATIONS = [
  'SETTLEMENT_REFUSAL_REASONS',
  'SETTLEMENT_REFUSAL_TRANSACTION_TYPES',
  'settlementRefusedPayload',
] as const;

/** Removes block comments and whole-line `//` comments; leaves code alone. */
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

describe("the pinned copy of economic's settlement-refusal contract", () => {
  it.each(PINNED_DECLARATIONS)('declares %s exactly as economic does', (name) => {
    expect(declaration(PINNED_SOURCE, name)).toBe(declaration(ECONOMIC_SOURCE, name));
  });

  it('carries nothing between its markers but those declarations', () => {
    const declared = [...withoutComments(pinnedRegion()).matchAll(/^(?:export )?const (\w+) =/gm)]
      .map((match) => match[1])
      .sort();
    expect(declared).toEqual([...PINNED_DECLARATIONS].sort());
  });

  it('decodes the one version economic publishes', () => {
    // Absent from ECONOMIC_EVENT_VERSIONS means v1; a v2 must reach this projection in the same
    // review.
    expect(ECONOMIC_SOURCE).not.toMatch(/\[ECONOMIC_EVENTS\.SETTLEMENT_REFUSED\]: \d/);
  });
});

const ECONOMIC: EventDelivery = Object.freeze({ topic: 'rasta.economic.v1', partition: 0 });
const TXN = 'TXN_01JTESTREFUSED000000000000';

const payload = (overrides: Record<string, unknown> = {}) => ({
  transactionId: TXN,
  organizationId: 'ORG_PAYER',
  payerOrganizationId: 'ORG_PAYER',
  payeeOrganizationId: 'ORG_PAYEE',
  transactionType: 'LOGISTICS',
  businessLine: 'LOGISTICS',
  reason: 'NO_ACTIVE_RULE',
  refusedBy: 'USR_ADMIN',
  refusedAt: '2026-10-23T08:00:00.000Z',
  ...overrides,
});

function envelope(
  body: Record<string, unknown>,
  overrides: Partial<EventEnvelope> = {},
): EventEnvelope {
  return {
    eventId: 'EVT_01JTEST000000000000000000',
    eventName: 'SETTLEMENT_REFUSED',
    eventVersion: 1,
    occurredAt: '2026-10-23T08:00:00.000Z',
    producer: 'economic-service',
    producerVersion: '1.0.0',
    aggregateType: 'Transaction',
    aggregateId: TXN,
    tenantId: 'ORG_PAYER',
    correlationId: 'COR_01JTEST000000000000000000',
    actor: { type: 'USER', id: 'USR_ADMIN' },
    payload: body,
    ...overrides,
  } as EventEnvelope;
}

function refusalOf(run: () => unknown): UnprocessableEventError {
  try {
    run();
  } catch (error) {
    if (error instanceof UnprocessableEventError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('a refused settlement through the mapper', () => {
  it('is REFUSED under its own name, with the closed reason and its line and type', () => {
    const record = toAuditEventRecord(envelope(payload()), ECONOMIC);
    expect(record).toMatchObject({
      action: 'SETTLEMENT_REFUSED',
      outcome: 'REFUSED',
      reason: 'NO_ACTIVE_RULE',
      resourceType: 'Transaction',
      resourceId: TXN,
      organizationId: 'ORG_PAYER',
      actorType: 'USER',
      actorId: 'USR_ADMIN',
      changes: [
        { field: 'businessLine', from: 'LOGISTICS', to: 'LOGISTICS' },
        { field: 'transactionType', from: 'LOGISTICS', to: 'LOGISTICS' },
      ],
    });
    expect(record).not.toHaveProperty('errorCode');
    // Nothing else of the payload: the payee is not audit-row material.
    expect(JSON.stringify(record)).not.toContain('ORG_PAYEE');
  });

  it('is not projected from another topic', () => {
    const record = toAuditEventRecord(envelope(payload()), {
      topic: 'rasta.marketplace.v1',
      partition: 0,
    });
    expect(record.outcome).toBe('SUCCESS');
    expect(record).not.toHaveProperty('reason');
    expect(record).not.toHaveProperty('changes');
    expect(toSettlementRefusalProjection(envelope(payload()), { ...ECONOMIC, topic: 'x' })).toBe(
      null,
    );
  });

  it('leaves every other economic event a success with nothing projected', () => {
    const record = toAuditEventRecord(
      envelope({ transactionId: TXN }, { eventName: 'SETTLEMENT_COMPLETED' }),
      ECONOMIC,
    );
    expect(record.outcome).toBe('SUCCESS');
    expect(record).not.toHaveProperty('reason');
    expect(record).not.toHaveProperty('changes');
  });

  it.each<[string, Record<string, unknown>]>([
    ['an amount', { grossAmountMinor: '2000000' }],
    ['a reason outside the closed list', { reason: 'MISCONFIGURED' }],
    ['a line outside the contract', { businessLine: 'TAXI' }],
    ['no line', { businessLine: null }],
    ['a type outside the list', { transactionType: 'WALLET_TOP_UP' }],
    ['a missing field', { refusedAt: undefined }],
  ])('refuses %s, naming paths and codes only', (_label, overrides) => {
    const refusal = refusalOf(() => toAuditEventRecord(envelope(payload(overrides)), ECONOMIC));
    expect(refusal.reason).toBe('VALIDATION_FAILED');
    expect(refusal.message).not.toMatch(/2000000|MISCONFIGURED|TAXI|WALLET_TOP_UP/);
  });

  it('refuses a payload about another transaction or another payer than the envelope', () => {
    expect(
      refusalOf(() =>
        toAuditEventRecord(envelope(payload({ transactionId: 'TXN_OTHER' })), ECONOMIC),
      ).message,
    ).toContain('aggregateId');
    expect(
      refusalOf(() => toAuditEventRecord(envelope(payload(), { tenantId: 'ORG_OTHER' }), ECONOMIC))
        .message,
    ).toContain('tenantId');
  });

  it('refuses a version it does not decode', () => {
    expect(
      refusalOf(() => toAuditEventRecord(envelope(payload(), { eventVersion: 2 }), ECONOMIC))
        .reason,
    ).toBe('SCHEMA_VERSION_UNSUPPORTED');
  });
});
