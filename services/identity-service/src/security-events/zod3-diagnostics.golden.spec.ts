import type { OutboxRow } from '@rasta/nest-common';
import {
  assertPublishableAuditTrailRow,
  toSecurityEventOutboxRow,
  type SecurityEventDeliveryState,
  type SecurityEventRecord,
} from './audit-trail-envelope';

/**
 * Differential goldens for identity's adapter of a zod refusal, the check an
 * audit-trail row passes before it is published (PR #444 r1 F1). Each `ZOD3`
 * value was recorded by running this file unchanged on main `745d0434` (zod
 * 3.25.76) (`~/worker2/session/t109/scripts/record.sh`). Inputs include the
 * review's envelope whose `actor.type` is `7`.
 */

/** Recorded under zod 3 on main 745d0434; never written by a test run. */
const ZOD3: Record<string, unknown> = {
  'envelope actor.type 7':
    'audit trail event refused before publish: envelope actor.type invalid_type',
  'envelope actor.type outside its enum':
    'audit trail event refused before publish: envelope actor.type invalid_enum_value',
  'envelope without its required fields':
    'audit trail event refused before publish: envelope eventId invalid_type, occurredAt invalid_type, producer invalid_type',
  'payload {}':
    'audit trail event refused before publish: payload actor invalid_type, action invalid_type, resourceType invalid_type, resourceId invalid_type, outcome invalid_type',
  'payload outcome and actor of the wrong types':
    'audit trail event refused before publish: payload actor.type invalid_type, actor.id invalid_type, outcome invalid_type',
  'payload occurrenceCount 0.5':
    'audit trail event refused before publish: payload occurrenceCount invalid_type',
};

function matchesZod3(name: string, observed: unknown): void {
  expect(observed).toEqual(ZOD3[name]);
}

function record(): SecurityEventRecord & SecurityEventDeliveryState {
  return {
    id: '01J9ZC0000000000000000TEST',
    organizationId: 'ORG_A',
    actorType: 'USER',
    actorId: 'USR_A',
    actorRoles: ['FLEET_MANAGER'],
    action: 'identity.active_organization.switch',
    resourceType: 'User',
    resourceId: 'USR_A',
    errorCode: 'TENANT_MISMATCH',
    reason: 'Active organization switch refused',
    sourceIp: '203.0.113.7',
    sourceUserAgent: 'Mozilla/5.0 (identity unit)',
    correlationId: 'COR_1',
    traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
    producerVersion: '1.4.2',
    occurredAt: new Date('2026-09-11T10:00:00.000Z'),
    occurrenceCount: 1,
    createdAt: new Date('2026-09-11T10:00:00.000Z'),
    publishedAt: null,
    attempts: 0,
    lastError: null,
  };
}

/** A built row whose envelope has been edited. */
function tampered(
  edit: (envelope: Record<string, unknown>, payload: Record<string, unknown>) => void,
): OutboxRow {
  const row = toSecurityEventOutboxRow(record());
  const envelope = JSON.parse(JSON.stringify(row.payload)) as Record<string, unknown>;
  edit(envelope, envelope.payload as Record<string, unknown>);
  return { ...row, payload: envelope };
}

function refusal(row: OutboxRow): string {
  try {
    assertPublishableAuditTrailRow(row);
  } catch (error) {
    return (error as Error).message;
  }
  return 'published';
}

describe('an audit-trail row refused before publish names zod 3’s codes', () => {
  it.each([
    [
      'envelope actor.type 7',
      (envelope: Record<string, unknown>) => {
        envelope.actor = { type: 7, id: 'USR_A' };
      },
    ],
    [
      'envelope actor.type outside its enum',
      (envelope: Record<string, unknown>) => {
        envelope.actor = { type: 'ROBOT', id: 'USR_A' };
      },
    ],
    [
      'envelope without its required fields',
      (envelope: Record<string, unknown>) => {
        for (const key of ['eventId', 'producer', 'occurredAt']) delete envelope[key];
      },
    ],
    [
      'payload {}',
      (envelope: Record<string, unknown>) => {
        envelope.payload = {};
      },
    ],
    [
      'payload outcome and actor of the wrong types',
      (_envelope: Record<string, unknown>, payload: Record<string, unknown>) => {
        payload.outcome = 3;
        payload.actor = { type: 7 };
      },
    ],
    [
      'payload occurrenceCount 0.5',
      (_envelope: Record<string, unknown>, payload: Record<string, unknown>) => {
        payload.occurrenceCount = 0.5;
      },
    ],
  ])('%s', (name, edit) => {
    matchesZod3(name, refusal(tampered(edit)));
  });
});
