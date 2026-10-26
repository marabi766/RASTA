import type { ArgumentMetadata } from '@nestjs/common';
import {
  AUDIT_EVENT_RECORDED,
  AUDIT_EVENT_RECORDED_VERSION,
  AUDIT_TRAIL_TOPIC,
  OPS_REPLAY_PRODUCER,
  OPS_REPLAY_TOPIC,
  REPLAY_EXECUTED,
  REPLAY_EXECUTED_VERSION,
  type EventEnvelope,
} from '@rasta/contracts';
import type { EventConsumer, EventDelivery } from '@rasta/nest-common';
import type { Logger } from '@rasta/logging';
import type { AuditEnv } from '../config/env';
import { DomainProjectorConsumer } from '../consumers/domain-projector.consumer';
import type { AuditRepository, IngestOutcome } from './audit.repository';
import { AuditEventQueryPipe, AuditVerifyQueryPipe } from './audit.query.pipes';
import { toAuditTrailRecord } from './audit-trail.mapper';
import {
  COMMISSION_RULE_CHANGED,
  toCommissionRuleChanges,
} from './commission-rule-change-projection';
import {
  CONTRACT_REFUSAL_EVENTS,
  CONTRACT_TOPIC,
  toContractRefusalProjection,
} from './contract-refusal-projection';
import { toReplayExecutedRecord } from './ops-replay.mapper';
import { ORGANIZATION_PROJECTION_EVENTS, ORGANIZATION_TOPIC } from './organization-projection';
import {
  ECONOMIC_TOPIC,
  PAYMENT_RECONCILIATION_EVENTS,
  toPaymentReconciliationEvidence,
} from './payment-reconciliation-projection';
import { SETTLEMENT_REFUSED, toSettlementRefusalProjection } from './settlement-refusal-projection';

/**
 * Differential goldens for every audit-service adapter of a zod refusal (PR #444
 * r1 F1): the same inputs through the same public entry points, answered as
 * zod 3 answered them. Each `ZOD3` value was recorded by running this file
 * unchanged on main `745d0434` (zod 3.25.76), where these entry points have the
 * same signatures (`~/worker2/session/t109/scripts/record.sh`); the PR body
 * lists the r1 head's answers beside them. Inputs are the review's
 * reproductions: `limit=1e999`/`nope` and a numeric `action` at the query pipe,
 * `CONTRACT_AUTHORITY_REFUSED` with payload `{}`, an envelope whose
 * `actor.type` is `7`. The two `limit=0.5` list cases are Codex PR-444 r2 F1's,
 * recorded the same way on main `5c88ae21`
 * (`~/worker6/session/039/scripts/record.sh`).
 */

const META: ArgumentMetadata = { type: 'query' };
const WINDOW = { from: '2026-10-01T00:00:00.000Z', to: '2026-10-02T00:00:00.000Z' };
const ENV = { AUDIT_MAX_QUERY_WINDOW_DAYS: 90 } as AuditEnv;

/** The 400 the pipe throws, as the client reads its details. */
function pipeRefusal(
  pipe: { transform(value: unknown, meta: ArgumentMetadata): unknown },
  query: unknown,
) {
  try {
    pipe.transform(query, META);
  } catch (error) {
    return (error as { details?: unknown }).details;
  }
  throw new Error('the pipe accepted the query');
}

/** The refusal's message, which is what reaches the log and `x-dlq-error`. */
function refusalText(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('accepted');
}

const delivery = (topic: string): EventDelivery => Object.freeze({ topic, partition: 0 });

function envelope(
  eventName: string,
  payload: unknown,
  overrides: Record<string, unknown> = {},
): EventEnvelope {
  return {
    eventId: '01JB9V5Q6K8M2N4P7R3S5T7V9X',
    eventName,
    eventVersion: 1,
    occurredAt: '2026-10-01T10:00:00.000Z',
    producer: 'contract-service',
    producerVersion: '1.0.0',
    aggregateType: 'Aggregate',
    aggregateId: 'AGG_1',
    tenantId: 'ORG_01JB9V5Q6K8M2N4P7R3S5T7V9X',
    correlationId: 'corr-zod3',
    actor: { type: 'USER', id: 'USR_1' },
    payload,
    ...overrides,
  } as EventEnvelope;
}

/** Recorded under zod 3 on main 745d0434; never written by a test run. */
const ZOD3: Record<string, unknown> = {
  'list limit=1e999': [
    { path: 'limit', message: 'Expected integer, received float', code: 'invalid_type' },
    { path: 'limit', message: 'Number must be less than or equal to 200', code: 'too_big' },
  ],
  'list limit=nope': [
    { path: 'limit', message: 'Expected number, received nan', code: 'invalid_type' },
  ],
  'list limit=0': [
    { path: 'limit', message: 'Number must be greater than or equal to 1', code: 'too_small' },
  ],
  'list action is a number (pipe input)': [
    { path: 'action', message: 'Expected string, received number', code: 'invalid_type' },
  ],
  'list outcome outside its enum': [
    {
      path: 'outcome',
      message: "Invalid enum value. Expected 'SUCCESS' | 'FAILURE' | 'REFUSED'",
      code: 'invalid_enum_value',
    },
  ],
  'list actorType missing its enum, given a number': [
    {
      path: 'actorType',
      message: "Expected 'USER' | 'SERVICE' | 'SYSTEM' | 'ANONYMOUS', received number",
      code: 'invalid_type',
    },
  ],
  'list an unknown parameter': [
    { path: '(root)', message: 'Unrecognized key(s) in object (1)', code: 'unrecognized_keys' },
  ],
  'list limit=0.5, a resource id without its type, a bad cursor': [
    { path: 'limit', message: 'Expected integer, received float', code: 'invalid_type' },
    { path: 'limit', message: 'Number must be greater than or equal to 1', code: 'too_small' },
    {
      path: 'resourceType',
      message: '`resourceId` may only be used together with `resourceType`',
      code: 'custom',
    },
    { path: 'cursor', message: 'The cursor is not valid', code: 'custom' },
  ],
  'list the same, window reversed': [
    { path: 'limit', message: 'Expected integer, received float', code: 'invalid_type' },
    { path: 'limit', message: 'Number must be greater than or equal to 1', code: 'too_small' },
    { path: 'to', message: '`to` must not be earlier than `from`', code: 'custom' },
    {
      path: 'resourceType',
      message: '`resourceId` may only be used together with `resourceType`',
      code: 'custom',
    },
    { path: 'cursor', message: 'The cursor is not valid', code: 'custom' },
  ],
  'list no window': [
    { path: 'from', message: 'Required', code: 'invalid_type' },
    { path: 'to', message: 'Required', code: 'invalid_type' },
  ],
  'verify limit=1e999': [
    { path: '(root)', message: 'Unrecognized key(s) in object (1)', code: 'unrecognized_keys' },
  ],
  'contract AUTHORITY {}':
    'CONTRACT_AUTHORITY_REFUSED does not match the contract refusal projection (contractId:invalid_type, organizationId:invalid_type, action:invalid_type, side:invalid_type, subjectId:invalid_type, reason:invalid_type, policyId:invalid_type, refusedBy:invalid_type, refusedAt:invalid_type)',
  'contract AUTHORITY wrong types':
    'CONTRACT_AUTHORITY_REFUSED does not match the contract refusal projection (contractId:invalid_type, organizationId:invalid_type, action:invalid_type, side:invalid_type, subjectId:invalid_type, reason:invalid_enum_value, policyId:invalid_type, refusedBy:invalid_type, refusedAt:invalid_type)',
  'contract SIGNATURE {}':
    'CONTRACT_SIGNATURE_REFUSED does not match the contract refusal projection (contractId:invalid_type, organizationId:invalid_type, side:invalid_literal, reason:invalid_type, policyId:invalid_type, refusedBy:invalid_type, refusedAt:invalid_type)',
  'contract POLICY_APPROVAL {}':
    'APPROVAL_POLICY_APPROVAL_REFUSED does not match the contract refusal projection (policyId:invalid_type, organizationId:invalid_type, workflowKey:invalid_type, policyVersion:invalid_type, reason:invalid_type, refusedBy:invalid_type, refusedAt:invalid_type)',
  'commission {}':
    'COMMISSION_RULE_CHANGED does not match the commission-rule projection (ruleId:invalid_type, change:invalid_type, changedBy:invalid_type, changedAt:invalid_type, before:invalid_type, after:invalid_type)',
  'commission an after without its terms':
    'COMMISSION_RULE_CHANGED does not match the commission-rule projection (change:invalid_type, changedBy:invalid_type, changedAt:invalid_type, after.organizationId:invalid_type, after.transactionType:invalid_type, after.rateBasisPoints:invalid_type, after.minAmountMinor:invalid_type, after.maxAmountMinor:invalid_type, after.validFrom:invalid_type, after.validTo:invalid_type, after.status:invalid_type, after.label:invalid_type)',
  'settlement {}':
    'SETTLEMENT_REFUSED does not match the settlement-refusal projection (transactionId:invalid_type, organizationId:invalid_type, payerOrganizationId:invalid_type, payeeOrganizationId:invalid_type, transactionType:invalid_type, businessLine:invalid_type, reason:invalid_type, refusedBy:invalid_type, refusedAt:invalid_type)',
  'payment RESOLVED {}':
    "PAYMENT_RECONCILIATION_RESOLVED does not satisfy the payment-reconciliation evidence contract v1: economic's event contract: paymentIntentId invalid_type; organizationId invalid_type; walletId invalid_type; kind invalid_type; marker invalid_type; providerRefund invalid_type; resolution invalid_type; resolvedBy invalid_type; and 6 more",
  'payment OPERATOR_ACTION {}':
    "PAYMENT_RECONCILIATION_OPERATOR_ACTION does not satisfy the payment-reconciliation evidence contract v1: economic's event contract: paymentIntentId invalid_type; organizationId invalid_type; walletId invalid_type; kind invalid_type; action invalid_type; actor invalid_type; requeueId invalid_type; resolutionId invalid_type; and 9 more",
  'trail actor.type 7':
    'audit trail message rejected: trail_invalid_envelope (actor.type invalid_type)',
  'trail payload {}':
    'audit trail message rejected: trail_invalid_payload (actor invalid_type, action invalid_type, resourceType invalid_type, resourceId invalid_type, outcome invalid_type)',
  'replay actor.type 7':
    'replay record rejected: replay_unsupported_event (actor.type invalid_type)',
  'replay payload {}':
    'replay record rejected: replay_invalid_payload (reportId invalid_type, operator invalid_type, replayedEvent invalid_type, dlq invalid_type, target invalid_type, stale invalid_union)',
  'organization CREATED {}':
    'organization projection refused ORGANIZATION_CREATED v1: organizationId invalid_type, status invalid_type, parentId invalid_union, path invalid_type, depth invalid_type',
  'organization STATUS_CHANGED wrong types':
    'organization projection refused ORGANIZATION_STATUS_CHANGED v1: organizationId invalid_type, newStatus invalid_type, affectedIds invalid_type',
};

function matchesZod3(name: string, observed: unknown): void {
  expect(observed).toEqual(ZOD3[name]);
}

describe('audit query pipes answer as zod 3 did (valid window, authorized caller is the controller’s)', () => {
  const list = new AuditEventQueryPipe(ENV);
  it.each([
    ['limit=1e999', { ...WINDOW, limit: '1e999' }],
    ['limit=nope', { ...WINDOW, limit: 'nope' }],
    ['limit=0', { ...WINDOW, limit: '0' }],
    ['action is a number (pipe input)', { ...WINDOW, action: 5 }],
    ['outcome outside its enum', { ...WINDOW, outcome: 'MAYBE' }],
    ['actorType missing its enum, given a number', { ...WINDOW, actorType: 7 }],
    ['an unknown parameter', { ...WINDOW, colour: 'red' }],
    ['no window', {}],
    // Codex PR-444 r2 F1: zod 4 stopped at the integer, and lost both refinements.
    [
      'limit=0.5, a resource id without its type, a bad cursor',
      { ...WINDOW, limit: '0.5', resourceId: 'AST_1', cursor: 'bad' },
    ],
    [
      'the same, window reversed',
      { from: WINDOW.to, to: WINDOW.from, limit: '0.5', resourceId: 'AST_1', cursor: 'bad' },
    ],
  ])('list: %s', (name, query) => {
    matchesZod3(`list ${name}`, pipeRefusal(list, query));
  });

  it('verify: limit=1e999', () => {
    matchesZod3(
      'verify limit=1e999',
      pipeRefusal(new AuditVerifyQueryPipe(ENV), { ...WINDOW, limit: '1e999' }),
    );
  });
});

describe('Kafka projections name zod 3’s codes', () => {
  it.each([
    ['AUTHORITY {}', CONTRACT_REFUSAL_EVENTS.AUTHORITY, {}],
    [
      'AUTHORITY wrong types',
      CONTRACT_REFUSAL_EVENTS.AUTHORITY,
      { action: 7, side: null, reason: 'NOPE' },
    ],
    ['SIGNATURE {}', CONTRACT_REFUSAL_EVENTS.SIGNATURE, {}],
    ['POLICY_APPROVAL {}', CONTRACT_REFUSAL_EVENTS.POLICY_APPROVAL, {}],
  ])('contract refusal: %s', (name, eventName, payload) => {
    matchesZod3(
      `contract ${name}`,
      refusalText(() =>
        toContractRefusalProjection(envelope(eventName, payload), delivery(CONTRACT_TOPIC)),
      ),
    );
  });

  it.each([
    ['{}', {}],
    ['an after without its terms', { ruleId: 'RUL_1', before: null, after: { currency: 'USD' } }],
  ])('commission rule change: %s', (name, payload) => {
    matchesZod3(
      `commission ${name}`,
      refusalText(() =>
        toCommissionRuleChanges(
          envelope(COMMISSION_RULE_CHANGED, payload, { producer: 'economic-service' }),
          delivery(ECONOMIC_TOPIC),
        ),
      ),
    );
  });

  it('settlement refusal: {}', () => {
    matchesZod3(
      'settlement {}',
      refusalText(() =>
        toSettlementRefusalProjection(
          envelope(SETTLEMENT_REFUSED, {}, { producer: 'economic-service' }),
          delivery(ECONOMIC_TOPIC),
        ),
      ),
    );
  });

  it.each([
    ['RESOLVED {}', PAYMENT_RECONCILIATION_EVENTS.RESOLVED],
    ['OPERATOR_ACTION {}', PAYMENT_RECONCILIATION_EVENTS.OPERATOR_ACTION],
  ])('payment reconciliation: %s', (name, eventName) => {
    matchesZod3(
      `payment ${name}`,
      refusalText(() =>
        toPaymentReconciliationEvidence(
          envelope(eventName, {}, { producer: 'economic-service' }),
          delivery(ECONOMIC_TOPIC),
        ),
      ),
    );
  });

  it.each([
    ['actor.type 7', { actor: { type: 7, id: 'USR_1' } }, {}],
    ['payload {}', {}, null],
  ])('audit trail (path B): %s', (name, overrides, payload) => {
    matchesZod3(
      `trail ${name}`,
      refusalText(() =>
        toAuditTrailRecord(
          envelope(AUDIT_EVENT_RECORDED, payload ?? {}, {
            eventVersion: AUDIT_EVENT_RECORDED_VERSION,
            producer: 'identity-service',
            ...overrides,
          }),
          delivery(AUDIT_TRAIL_TOPIC),
        ),
      ),
    );
  });

  it.each([
    ['actor.type 7', { actor: { type: 7, id: 'USR_1' } }],
    ['payload {}', {}],
  ])('ops replay: %s', (name, overrides) => {
    matchesZod3(
      `replay ${name}`,
      refusalText(() =>
        toReplayExecutedRecord(
          envelope(
            REPLAY_EXECUTED,
            {},
            {
              eventVersion: REPLAY_EXECUTED_VERSION,
              producer: OPS_REPLAY_PRODUCER,
              ...overrides,
            },
          ),
          delivery(OPS_REPLAY_TOPIC),
        ),
      ),
    );
  });

  it.each([
    ['CREATED {}', ORGANIZATION_PROJECTION_EVENTS.CREATED, {}],
    [
      'STATUS_CHANGED wrong types',
      ORGANIZATION_PROJECTION_EVENTS.STATUS_CHANGED,
      { organizationId: 7, newStatus: null },
    ],
  ])('organization projection (path A): %s', async (name, eventName, payload) => {
    const projector = new DomainProjectorConsumer(
      () => ({}) as unknown as EventConsumer,
      { ingest: async (): Promise<IngestOutcome> => 'WRITTEN' } as unknown as AuditRepository,
      {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
        debug: () => undefined,
      } as unknown as Logger,
    );
    const failure = await projector
      .handle(
        envelope(eventName, payload, { producer: 'organization-service' }),
        delivery(ORGANIZATION_TOPIC),
      )
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    matchesZod3(`organization ${name}`, (failure as Error | undefined)?.message);
  });
});
