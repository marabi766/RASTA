import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { join } from 'node:path';
import { DLQ_REASONS, type EventEnvelope } from '@rasta/contracts';
import { UnprocessableEventError, type EventDelivery } from '@rasta/nest-common';
import {
  ECONOMIC_TOPIC,
  EVIDENCE_REFERENCE_PATTERN,
  OPERATOR_ACTIONS,
  OPERATOR_ACTION_FIELDS,
  PAYMENT_RECONCILIATION_EVENTS,
  PAYMENT_RECONCILIATION_PROJECTION_VERSION,
  PROVIDER_OUTCOMES,
  RECONCILIATION_KINDS,
  RESOLUTION_CODES,
  RESOLVED_FIELDS,
  describeIssues,
  toPaymentReconciliationEvidence,
} from './payment-reconciliation-projection';

/**
 * D-046: the consumer side of economic's two payment-reconciliation events.
 *
 * Part one is the **contract pin**. economic's payload schemas live in its own
 * `src/events/events.ts`, which this service may not import (A-02), so the
 * pin reads that file as text and fails the moment the two sides disagree: a
 * payload field nobody has classified as kept or not, a different evidence
 * pattern, a code added to or removed from an enum, an optional field made
 * required. Part two is the mapper's behaviour on payloads shaped exactly as
 * economic's `PaymentReconciliationOperator` and `PaymentReconciler` build them.
 */

const ECONOMIC_EVENTS_SOURCE = join(
  __dirname,
  '..',
  '..',
  '..',
  'economic-service',
  'src',
  'events',
  'events.ts',
);

const source = readFileSync(ECONOMIC_EVENTS_SOURCE, 'utf8');

/** The text of `export const <name> = z.object({ … });` in economic's file. */
function schemaBlock(name: string): string {
  const start = source.indexOf(`export const ${name} = z.object({`);
  if (start < 0) throw new Error(`${name} is not declared in economic's events.ts`);
  const end = source.indexOf('\n});', start);
  return source.slice(start, end);
}

/**
 * The top-level keys of a `z.object({ … })` block: two-space-indented `key:`
 * lines, and shorthand properties (`  amountMinor,`).
 */
function topLevelKeys(block: string): string[] {
  return [...block.matchAll(/^ {2}(\w+)(?::|,$)/gm)].map((match) => match[1] ?? '');
}

/** The quoted literals of the first `z.enum([ … ])` after `anchor` in `text`. */
function enumAfter(text: string, anchor: string): string[] {
  const at = text.indexOf(anchor);
  if (at < 0) throw new Error(`${anchor} not found`);
  const match = /z\.enum\(\[([\s\S]*?)\]\)/.exec(text.slice(at));
  if (!match) throw new Error(`no z.enum after ${anchor}`);
  return [...(match[1] ?? '').matchAll(/'([A-Z_]+)'/g)].map((literal) => literal[1] ?? '');
}

/** The declaration line of one top-level key inside a block. */
function declarationOf(block: string, key: string): string {
  const match = new RegExp(`^ {2}${key}: (.*)$`, 'm').exec(block);
  if (!match) throw new Error(`${key} is not declared`);
  return match[1] ?? '';
}

const RESOLVED_BLOCK = schemaBlock('paymentReconciliationResolvedPayload');
const OPERATOR_BLOCK = schemaBlock('paymentReconciliationOperatorActionPayload');

describe('the contract pin against economic-service/src/events/events.ts', () => {
  it('classifies every RESOLVED payload field, and no field the producer lacks', () => {
    expect(topLevelKeys(RESOLVED_BLOCK).sort()).toEqual(Object.keys(RESOLVED_FIELDS).sort());
  });

  it('classifies every OPERATOR_ACTION payload field, and no field the producer lacks', () => {
    expect(topLevelKeys(OPERATOR_BLOCK).sort()).toEqual(Object.keys(OPERATOR_ACTION_FIELDS).sort());
  });

  it('never keeps an amount, a currency, the provider or a timestamp', () => {
    for (const fields of [RESOLVED_FIELDS, OPERATOR_ACTION_FIELDS]) {
      for (const excluded of ['amountMinor', 'currency', 'provider', 'simulated', 'walletId']) {
        expect(fields[excluded]).toBe(false);
      }
    }
    expect(RESOLVED_FIELDS.resolvedAt).toBe(false);
    expect(OPERATOR_ACTION_FIELDS.occurredAt).toBe(false);
  });

  it('uses the exact evidence-reference pattern economic validates with', () => {
    const match = /export const EVIDENCE_REFERENCE_PATTERN = (\/.*\/);/.exec(source);
    expect(match?.[1]).toBe(String(EVIDENCE_REFERENCE_PATTERN));
    // And the field is that pattern on both events, not a looser string.
    expect(declarationOf(RESOLVED_BLOCK, 'evidenceReference')).toBe(
      'evidenceReference.optional(),',
    );
    expect(declarationOf(OPERATOR_BLOCK, 'evidenceReference')).toBe(
      'evidenceReference.nullable(),',
    );
    expect(source).toContain(
      'const evidenceReference = z.string().regex(EVIDENCE_REFERENCE_PATTERN);',
    );
  });

  it('knows exactly the codes economic can send', () => {
    expect(enumAfter(source, 'const reconciliationKind')).toEqual([...RECONCILIATION_KINDS]);
    expect(enumAfter(RESOLVED_BLOCK, '  resolution:')).toEqual([...RESOLUTION_CODES]);
    expect(enumAfter(OPERATOR_BLOCK, '  action:')).toEqual([...OPERATOR_ACTIONS]);
    expect(enumAfter(OPERATOR_BLOCK, '  providerOutcome:')).toEqual([...PROVIDER_OUTCOMES]);
  });

  it('reads the operator group of RESOLVED as optional and the action fields as nullable', () => {
    for (const key of [
      'resolutionId',
      'proposedBy',
      'approvedBy',
      'evidenceReference',
      'fourEyes',
    ]) {
      expect(declarationOf(RESOLVED_BLOCK, key)).toMatch(/\.optional\(\),$/);
    }
    for (const key of [
      'requeueId',
      'resolutionId',
      'providerOutcome',
      'evidenceReference',
      'proposedBy',
    ]) {
      expect(declarationOf(OPERATOR_BLOCK, key)).toMatch(/\.nullable\(\),$/);
    }
    expect(declarationOf(OPERATOR_BLOCK, 'fourEyes')).toBe('z.boolean(),');
    expect(declarationOf(OPERATOR_BLOCK, 'actor')).toBe('z.string().min(1),');
    expect(declarationOf(RESOLVED_BLOCK, 'resolvedBy')).toBe('z.string().min(1),');
  });
});

// ---------------------------------------------------------------------------
// Fixtures shaped as economic builds them (payment-reconciliation.operator.ts,
// payment-reconciler.ts): every producer field, including the ones not kept.
// ---------------------------------------------------------------------------

const ORG = 'ORG-UNION-7';
const INTENT = 'pi_01JABCDEF';
const DELIVERY: EventDelivery = Object.freeze({ topic: ECONOMIC_TOPIC, partition: 0 });

export function approvedResolutionPayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    paymentIntentId: INTENT,
    organizationId: ORG,
    walletId: 'wal_01',
    kind: 'REFUND',
    marker: 'REFUND_UNKNOWN',
    providerRefund: null,
    resolution: 'REFUNDED',
    resolvedBy: 'usr_approver',
    attempts: 4,
    amountMinor: '150000',
    currency: 'IRR',
    provider: 'mock',
    simulated: true,
    resolvedAt: '2026-10-03T10:00:00.000Z',
    resolutionId: 'res_01',
    proposedBy: 'usr_proposer',
    approvedBy: 'usr_approver',
    evidenceReference: 'TICKET-4711',
    fourEyes: true,
    ...overrides,
  };
}

function operatorActionPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    paymentIntentId: INTENT,
    organizationId: ORG,
    walletId: 'wal_01',
    kind: 'UNCREDITED_REFUND',
    action: 'PROPOSED',
    actor: 'usr_proposer',
    requeueId: null,
    resolutionId: 'res_02',
    providerOutcome: 'DECLINED',
    evidenceReference: 'doc:2026/10/03-001',
    proposedBy: 'usr_proposer',
    fourEyes: true,
    amountMinor: '150000',
    currency: 'IRR',
    provider: 'mock',
    simulated: true,
    occurredAt: '2026-10-03T10:00:00.000Z',
    ...overrides,
  };
}

function envelope(
  eventName: string,
  payload: unknown,
  overrides: Partial<EventEnvelope> = {},
): EventEnvelope {
  return {
    eventId: 'EVT-1',
    eventName,
    eventVersion: 1,
    occurredAt: '2026-10-03T10:00:00.000Z',
    producer: 'economic-service',
    aggregateType: 'PaymentIntent',
    aggregateId: INTENT,
    tenantId: ORG,
    correlationId: 'COR-1',
    payload,
    ...overrides,
  } as EventEnvelope;
}

const RESOLVED = PAYMENT_RECONCILIATION_EVENTS.RESOLVED;
const OPERATOR_ACTION = PAYMENT_RECONCILIATION_EVENTS.OPERATOR_ACTION;

function project(event: EventEnvelope, delivery: EventDelivery = DELIVERY) {
  return toPaymentReconciliationEvidence(event, delivery);
}

/** The thrown refusal, asserted to be the immediate-DLQ kind. */
function refusalOf(event: EventEnvelope): UnprocessableEventError {
  try {
    project(event);
  } catch (error) {
    expect(error).toBeInstanceOf(UnprocessableEventError);
    return error as UnprocessableEventError;
  }
  throw new Error('expected a refusal');
}

describe('PAYMENT_RECONCILIATION_RESOLVED', () => {
  it('keeps the proposer, the approver, the evidence reference and four-eyes', () => {
    expect(project(envelope(RESOLVED, approvedResolutionPayload()))).toEqual({
      projectionVersion: PAYMENT_RECONCILIATION_PROJECTION_VERSION,
      organizationId: ORG,
      eventName: RESOLVED,
      paymentIntentId: INTENT,
      kind: 'REFUND',
      operatorAction: null,
      actor: null,
      resolution: 'REFUNDED',
      resolvedBy: 'usr_approver',
      providerOutcome: null,
      resolutionId: 'res_01',
      requeueId: null,
      proposedBy: 'usr_proposer',
      approvedBy: 'usr_approver',
      evidenceReference: 'TICKET-4711',
      fourEyes: true,
    });
  });

  it("keeps the reconciler's own resolution with no operator fields", () => {
    const payload = approvedResolutionPayload({ resolvedBy: 'PAYMENT_RECONCILER' });
    for (const key of [
      'resolutionId',
      'proposedBy',
      'approvedBy',
      'evidenceReference',
      'fourEyes',
    ]) {
      delete payload[key];
    }
    const projection = project(envelope(RESOLVED, payload));
    expect(projection).toMatchObject({
      resolution: 'REFUNDED',
      resolvedBy: 'PAYMENT_RECONCILER',
      resolutionId: null,
      proposedBy: null,
      approvedBy: null,
      evidenceReference: null,
      fourEyes: null,
    });
  });

  it('refuses part of the operator group', () => {
    const payload = approvedResolutionPayload();
    delete payload.evidenceReference;
    const refusal = refusalOf(envelope(RESOLVED, payload));
    expect(refusal.reason).toBe(DLQ_REASONS.VALIDATION_FAILED);
    expect(refusal.message).toContain('operator custom');
  });
});

describe('PAYMENT_RECONCILIATION_OPERATOR_ACTION', () => {
  it('keeps a proposal: action, actor, resolution id, outcome, evidence, proposer', () => {
    expect(project(envelope(OPERATOR_ACTION, operatorActionPayload()))).toEqual({
      projectionVersion: 1,
      organizationId: ORG,
      eventName: OPERATOR_ACTION,
      paymentIntentId: INTENT,
      kind: 'UNCREDITED_REFUND',
      operatorAction: 'PROPOSED',
      actor: 'usr_proposer',
      resolution: null,
      resolvedBy: null,
      providerOutcome: 'DECLINED',
      resolutionId: 'res_02',
      requeueId: null,
      proposedBy: 'usr_proposer',
      approvedBy: null,
      evidenceReference: 'doc:2026/10/03-001',
      fourEyes: true,
    });
  });

  it('keeps a rejection with the rejected proposer beside the rejecting actor', () => {
    const projection = project(
      envelope(OPERATOR_ACTION, operatorActionPayload({ action: 'REJECTED', actor: 'usr_second' })),
    );
    expect(projection).toMatchObject({
      operatorAction: 'REJECTED',
      actor: 'usr_second',
      proposedBy: 'usr_proposer',
      resolutionId: 'res_02',
    });
  });

  it('keeps a requeue by its requeue id and nothing of a resolution', () => {
    const projection = project(
      envelope(
        OPERATOR_ACTION,
        operatorActionPayload({
          action: 'REQUEUED',
          requeueId: 'rq_01',
          resolutionId: null,
          providerOutcome: null,
          evidenceReference: null,
          proposedBy: null,
          fourEyes: false,
        }),
      ),
    );
    expect(projection).toMatchObject({
      operatorAction: 'REQUEUED',
      requeueId: 'rq_01',
      resolutionId: null,
      providerOutcome: null,
      evidenceReference: null,
      proposedBy: null,
      fourEyes: false,
    });
  });

  it.each([
    [
      'a requeue that names a resolution',
      { action: 'REQUEUED', requeueId: 'rq_01' },
      'resolutionId',
    ],
    ['a proposal without evidence', { evidenceReference: null }, 'evidenceReference'],
    ['a rejection without its proposer', { action: 'REJECTED', proposedBy: null }, 'proposedBy'],
  ])('refuses %s', (_label, overrides, field) => {
    const refusal = refusalOf(envelope(OPERATOR_ACTION, operatorActionPayload(overrides)));
    expect(refusal.reason).toBe(DLQ_REASONS.VALIDATION_FAILED);
    expect(refusal.message).toContain(field);
  });
});

describe('the allow-list', () => {
  it('stores nothing it was not told to, whatever the payload carries', () => {
    const smuggled = {
      reason: 'the customer called and said the money arrived',
      amountMinor: '999999999',
      issuer: 'https://idp.example',
      subject: 'abc',
      note: 'free text',
    };
    for (const event of [
      envelope(RESOLVED, approvedResolutionPayload(smuggled)),
      envelope(OPERATOR_ACTION, operatorActionPayload(smuggled)),
    ]) {
      const projection = project(event);
      const serialised = JSON.stringify(projection);
      for (const value of Object.values(smuggled)) expect(serialised).not.toContain(value);
      for (const key of [...Object.keys(smuggled), 'currency', 'provider', 'walletId']) {
        expect(projection).not.toHaveProperty(key);
      }
    }
  });
});

describe('refusals go to the dead-letter topic, and never repeat a value', () => {
  const secret = 'SECRET VALUE WITH SPACES';

  it.each([
    ['an evidence reference that is prose', RESOLVED, { evidenceReference: secret }],
    ['an evidence reference that is too short', RESOLVED, { evidenceReference: 'ab' }],
    ['an actor with whitespace', RESOLVED, { approvedBy: secret }],
    ['an unknown resolution code', RESOLVED, { resolution: 'SECRET_CODE' }],
    ['a missing resolver', RESOLVED, { resolvedBy: undefined }],
    ['a non-boolean four-eyes', RESOLVED, { fourEyes: 'yes' }],
    ['an unknown action', OPERATOR_ACTION, { action: 'SECRET_CODE' }],
    ['an oversized resolution id', OPERATOR_ACTION, { resolutionId: 'r'.repeat(129) }],
    ['a missing four-eyes', OPERATOR_ACTION, { fourEyes: undefined }],
  ])('refuses %s', (_label, eventName, overrides) => {
    const payload =
      eventName === RESOLVED
        ? approvedResolutionPayload(overrides)
        : operatorActionPayload(overrides);
    const refusal = refusalOf(envelope(eventName, payload));
    expect(refusal.reason).toBe(DLQ_REASONS.VALIDATION_FAILED);
    expect(refusal.message).not.toContain(secret);
    expect(refusal.message).not.toContain('SECRET_CODE');
  });

  it('refuses a payload whose organization is not the envelope tenant', () => {
    const refusal = refusalOf(
      envelope(RESOLVED, approvedResolutionPayload({ organizationId: 'ORG-OTHER' })),
    );
    expect(refusal.reason).toBe(DLQ_REASONS.VALIDATION_FAILED);
    expect(refusal.message).toContain('tenantId');
    expect(refusal.message).not.toContain('ORG-OTHER');
  });

  it('refuses an envelope with no tenant', () => {
    const refusal = refusalOf(
      envelope(RESOLVED, approvedResolutionPayload(), { tenantId: undefined }),
    );
    expect(refusal.message).toContain('tenantId');
  });

  it('refuses a payload whose intent is not the envelope aggregate', () => {
    const refusal = refusalOf(
      envelope(OPERATOR_ACTION, operatorActionPayload({ paymentIntentId: 'pi_other' })),
    );
    expect(refusal.message).toContain('aggregateId');
  });

  it('refuses an event version it does not understand, as such', () => {
    const refusal = refusalOf(envelope(RESOLVED, approvedResolutionPayload(), { eventVersion: 2 }));
    expect(refusal.reason).toBe(DLQ_REASONS.SCHEMA_VERSION_UNSUPPORTED);
  });

  it('refuses a payload that is not an object', () => {
    expect(refusalOf(envelope(OPERATOR_ACTION, 'a string')).reason).toBe(
      DLQ_REASONS.VALIDATION_FAILED,
    );
  });
});

describe('what is not projected at all', () => {
  it('ignores the same names on another topic', () => {
    expect(
      project(envelope(RESOLVED, approvedResolutionPayload()), {
        topic: 'rasta.marketplace.v1',
        partition: 0,
      }),
    ).toBeNull();
  });

  it('ignores every other economic event, even with a malformed payload', () => {
    expect(project(envelope('PAYMENT_RECONCILIATION_ESCALATED', 'nonsense'))).toBeNull();
    expect(project(envelope('PAYMENT_CAPTURED', null))).toBeNull();
  });
});

describe("economic's whole contract first (Codex on #204, MED 3)", () => {
  it.each([
    ['RESOLVED without walletId', RESOLVED, { walletId: undefined }, 'walletId'],
    ['RESOLVED without amountMinor', RESOLVED, { amountMinor: undefined }, 'amountMinor'],
    ['RESOLVED with walletId as an object', RESOLVED, { walletId: { id: 'wal_1' } }, 'walletId'],
    ['RESOLVED with a fractional amount', RESOLVED, { amountMinor: '1.50' }, 'amountMinor'],
    ['RESOLVED with an unknown marker', RESOLVED, { marker: 'GUESSED' }, 'marker'],
    ['RESOLVED without resolvedAt', RESOLVED, { resolvedAt: undefined }, 'resolvedAt'],
    ['OPERATOR_ACTION without currency', OPERATOR_ACTION, { currency: undefined }, 'currency'],
    ['OPERATOR_ACTION with simulated as text', OPERATOR_ACTION, { simulated: 'yes' }, 'simulated'],
    [
      'OPERATOR_ACTION without occurredAt',
      OPERATOR_ACTION,
      { occurredAt: undefined },
      'occurredAt',
    ],
  ])(
    'refuses %s, though nothing it lacks would be stored',
    (_label, eventName, overrides, field) => {
      const payload =
        eventName === RESOLVED
          ? approvedResolutionPayload(overrides)
          : operatorActionPayload(overrides);
      const refusal = refusalOf(envelope(eventName, payload));
      expect(refusal.reason).toBe(DLQ_REASONS.VALIDATION_FAILED);
      expect(refusal.message).toContain("economic's event contract");
      expect(refusal.message).toContain(field);
    },
  );

  it('still never stores what it validated: amounts, currency, provider', () => {
    const projection = project(envelope(RESOLVED, approvedResolutionPayload()));
    expect(JSON.stringify(projection)).not.toMatch(/150000|IRR|mock|wal_01/);
  });
});

describe('refusal messages name schema fields only (Codex on #204, MED 2)', () => {
  const KEY_WITH_TEXT = 'nationalId 0012345678 of the payer';

  it('never repeats a payload-supplied property name', () => {
    // A malformed payload that also carries a key whose *name* is text. The
    // refusal must describe the schema field that failed, never that key.
    const payload = approvedResolutionPayload({
      evidenceReference: 'not a reference',
      [KEY_WITH_TEXT]: { nested: true },
    });
    const refusal = refusalOf(envelope(RESOLVED, payload));
    expect(refusal.message).toContain('evidenceReference');
    expect(refusal.message).not.toContain('nationalId');
    expect(refusal.message).not.toContain('0012345678');
  });

  it('reports a non-object payload without naming anything from it', () => {
    const refusal = refusalOf(envelope(OPERATOR_ACTION, [KEY_WITH_TEXT]));
    expect(refusal.message).toContain('(payload) invalid_type');
    expect(refusal.message).not.toContain('nationalId');
  });

  it('masks any path segment that is not a schema field, whatever produced it', () => {
    // zod builds these paths from the schema, so a payload key cannot reach
    // one today; the mask is what keeps it so if a schema ever records keys.
    const error = new z.ZodError([
      { code: z.ZodIssueCode.custom, path: [KEY_WITH_TEXT, 'x'], message: KEY_WITH_TEXT },
      { code: z.ZodIssueCode.custom, path: ['walletId', KEY_WITH_TEXT], message: 'm' },
      { code: z.ZodIssueCode.custom, path: [3], message: 'm' },
    ]);
    expect(describeIssues(error)).toBe('(payload) custom; walletId custom; (payload) custom');
  });
});
