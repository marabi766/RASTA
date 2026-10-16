import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { UnprocessableEventError, type EventDelivery } from '@rasta/nest-common';
import type { EventEnvelope } from '@rasta/contracts';
import {
  CONTRACT_REFUSAL_ACTIONS,
  CONTRACT_REFUSAL_REASONS,
  CONTRACT_REFUSAL_SIDES,
  POLICY_APPROVAL_REFUSAL_REASONS,
  toContractRefusalProjection,
} from './contract-refusal-projection';
import { toAuditEventRecord } from './audit.mapper';

const delivery = (topic = 'rasta.contract.v1'): EventDelivery =>
  Object.freeze({ topic, partition: 0 });

const authorityPayload = {
  contractId: 'CTR_1',
  organizationId: 'ORG_1',
  action: 'SIGN_AMENDMENT',
  side: 'EMPLOYER',
  subjectId: 'AMD_1',
  reason: 'SAME_PERSON_BOTH_SIDES',
  policyId: null,
  refusedBy: 'USR_1',
  refusedAt: '2026-10-13T10:00:00.000Z',
};

const policyApprovalPayload = {
  policyId: 'APL_1',
  organizationId: 'ORG_1',
  workflowKey: 'contract.signature',
  policyVersion: 2,
  reason: 'SELF_APPROVAL',
  refusedBy: 'USR_1',
  refusedAt: '2026-10-13T10:00:00.000Z',
};

function envelope(eventName: string, payload: unknown): EventEnvelope {
  return {
    eventId: '01JREFUSALSPEC00000000001',
    eventName,
    eventVersion: 1,
    occurredAt: '2026-10-13T10:00:00.000Z',
    producer: 'contract-service',
    aggregateType: 'Contract',
    aggregateId: 'CTR_1',
    tenantId: 'ORG_1',
    correlationId: 'corr-1',
    payload,
  } as EventEnvelope;
}

describe('the contract refusal projection', () => {
  it('stores an authority refusal as REFUSED under its closed action and reason', () => {
    const record = toAuditEventRecord(
      envelope('CONTRACT_AUTHORITY_REFUSED', authorityPayload),
      delivery(),
    );

    expect(record.outcome).toBe('REFUSED');
    expect(record.action).toBe('SIGN_AMENDMENT');
    expect(record.reason).toBe('SAME_PERSON_BOTH_SIDES');
    expect(record.sourceEventName).toBe('CONTRACT_AUTHORITY_REFUSED');
    expect(record.changes).toBeUndefined();
  });

  it('stores the employer’s signature refusal as a refused SIGN_CONTRACT', () => {
    const record = toAuditEventRecord(
      envelope('CONTRACT_SIGNATURE_REFUSED', {
        contractId: 'CTR_1',
        organizationId: 'ORG_1',
        side: 'EMPLOYER',
        reason: 'POLICY_AUTHOR_NOT_GOVERNING',
        policyId: 'POL_1',
        refusedBy: 'USR_1',
        refusedAt: '2026-10-13T10:00:00.000Z',
      }),
      delivery(),
    );

    expect([record.outcome, record.action, record.reason]).toEqual([
      'REFUSED',
      'SIGN_CONTRACT',
      'POLICY_AUTHOR_NOT_GOVERNING',
    ]);
  });

  it('stores the platform administrator refused for a party under the closed reason', () => {
    const record = toAuditEventRecord(
      envelope('CONTRACT_AUTHORITY_REFUSED', {
        ...authorityPayload,
        action: 'CANCEL_CONTRACT',
        subjectId: null,
        reason: 'PLATFORM_ADMINISTRATOR',
      }),
      delivery(),
    );

    expect([record.outcome, record.action, record.reason]).toEqual([
      'REFUSED',
      'CANCEL_CONTRACT',
      'PLATFORM_ADMINISTRATOR',
    ]);
  });

  it('stores a statement draft refused to the employer as a refused DRAFT_STATEMENT (CON-003 PR 4)', () => {
    const record = toAuditEventRecord(
      envelope('CONTRACT_AUTHORITY_REFUSED', {
        ...authorityPayload,
        action: 'DRAFT_STATEMENT',
        subjectId: null,
        reason: 'NOT_CONTRACTOR',
      }),
      delivery(),
    );

    expect([record.outcome, record.action, record.reason]).toEqual([
      'REFUSED',
      'DRAFT_STATEMENT',
      'NOT_CONTRACTOR',
    ]);
  });

  it('stores a statement submission refused to the contractor’s person without the role as a refused SUBMIT_STATEMENT (CON-003 PR 5)', () => {
    const record = toAuditEventRecord(
      envelope('CONTRACT_AUTHORITY_REFUSED', {
        ...authorityPayload,
        action: 'SUBMIT_STATEMENT',
        side: 'CONTRACTOR',
        subjectId: 'STM_1',
        reason: 'ROLE_NOT_PERMITTED',
      }),
      delivery(),
    );

    expect([record.outcome, record.action, record.reason]).toEqual([
      'REFUSED',
      'SUBMIT_STATEMENT',
      'ROLE_NOT_PERMITTED',
    ]);
    expect(JSON.stringify(record)).not.toContain('STM_1');
  });

  it.each([
    ['APPROVE_STATEMENT', 'APPROVER', 'NOT_STEP_AUTHORITY'],
    ['APPROVE_STATEMENT', 'EMPLOYER', 'SUBMITTER_MAY_NOT_DECIDE'],
    ['REJECT_STATEMENT', 'EMPLOYER', 'ALREADY_DECIDED_STATEMENT'],
    ['REJECT_STATEMENT', 'APPROVER', 'MEMBER_OF_CONTRACTOR'],
    ['APPROVE_STATEMENT', 'APPROVER', 'ACTOR_IDENTITY_UNKNOWN'],
  ])(
    'stores a statement decision refused (%s, side %s, %s) under its closed action and reason (CON-003 PR 6)',
    (action, side, reason) => {
      const record = toAuditEventRecord(
        envelope('CONTRACT_AUTHORITY_REFUSED', {
          ...authorityPayload,
          action,
          side,
          subjectId: 'STM_1',
          reason,
        }),
        delivery(),
      );

      expect([record.outcome, record.action, record.reason]).toEqual(['REFUSED', action, reason]);
      expect(JSON.stringify(record)).not.toContain('STM_1');
    },
  );

  it('refuses a side outside the closed list without storing anything', () => {
    expect(() =>
      toAuditEventRecord(
        envelope('CONTRACT_AUTHORITY_REFUSED', { ...authorityPayload, side: 'BYSTANDER' }),
        delivery(),
      ),
    ).toThrow(UnprocessableEventError);
  });

  it('stores a policy approval refused by four eyes as a refused APPROVE_POLICY', () => {
    const record = toAuditEventRecord(
      envelope('APPROVAL_POLICY_APPROVAL_REFUSED', policyApprovalPayload),
      delivery(),
    );

    expect([record.outcome, record.action, record.reason]).toEqual([
      'REFUSED',
      'APPROVE_POLICY',
      'SELF_APPROVAL',
    ]);
    expect(record.sourceEventName).toBe('APPROVAL_POLICY_APPROVAL_REFUSED');
    expect(JSON.stringify(record)).not.toContain('USR_1');
  });

  it.each([
    ['a reason outside the closed list', { ...policyApprovalPayload, reason: 'BECAUSE' }],
    ['a field the contract does not declare', { ...policyApprovalPayload, note: 'free text' }],
    ['a missing field', { ...policyApprovalPayload, policyVersion: undefined }],
  ])('refuses a policy approval refusal with %s without storing anything', (_label, payload) => {
    expect(() =>
      toAuditEventRecord(envelope('APPROVAL_POLICY_APPROVAL_REFUSED', payload), delivery()),
    ).toThrow(UnprocessableEventError);
  });

  it('copies nothing of the payload but the action and the reason', () => {
    const record = toAuditEventRecord(
      envelope('CONTRACT_AUTHORITY_REFUSED', { ...authorityPayload, policyId: 'POL_SECRET_1' }),
      delivery(),
    );

    expect(JSON.stringify(record)).not.toContain('POL_SECRET_1');
    expect(JSON.stringify(record)).not.toContain('AMD_1');
    expect(JSON.stringify(record)).not.toContain('USR_1');
  });

  it('leaves every other contract event a success under its own name', () => {
    const record = toAuditEventRecord(
      envelope('CONTRACT_SIGNED', { contractId: 'CTR_1' }),
      delivery(),
    );

    expect([record.outcome, record.action]).toEqual(['SUCCESS', 'CONTRACT_SIGNED']);
    expect('reason' in record).toBe(false);
  });

  it('ignores a refusal-named event on another topic', () => {
    expect(
      toContractRefusalProjection(
        envelope('CONTRACT_AUTHORITY_REFUSED', authorityPayload),
        delivery('rasta.asset.v1'),
      ),
    ).toBeNull();
  });

  it.each([
    ['an action outside the closed list', { ...authorityPayload, action: 'DELETE_EVERYTHING' }],
    ['a reason outside the closed list', { ...authorityPayload, reason: 'BECAUSE' }],
    ['a field the contract does not declare', { ...authorityPayload, note: 'free text' }],
    ['a missing field', { ...authorityPayload, refusedBy: undefined }],
  ])('refuses %s without storing anything', (_label, payload) => {
    expect(() =>
      toAuditEventRecord(envelope('CONTRACT_AUTHORITY_REFUSED', payload), delivery()),
    ).toThrow(UnprocessableEventError);
  });

  it('names schema paths and issue codes in a refusal, never a value', () => {
    try {
      toContractRefusalProjection(
        envelope('CONTRACT_AUTHORITY_REFUSED', { ...authorityPayload, reason: 'secret-value-x' }),
        delivery(),
      );
      throw new Error('expected a refusal');
    } catch (error) {
      expect((error as Error).message).toContain('reason');
      expect((error as Error).message).not.toContain('secret-value-x');
    }
  });

  describe('against contract-service’s own declaration', () => {
    const source = readFileSync(
      join(__dirname, '../../../contract-service/src/events/events.ts'),
      'utf8',
    );
    const listOf = (name: string): string[] => {
      const match = new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\] as const`).exec(source);
      if (!match) throw new Error(`${name} not found in contract-service`);
      return [...(match[1] ?? '').matchAll(/'([A-Z_]+)'/g)].map((entry) => entry[1] as string);
    };

    it('lists the same actions', () => {
      expect([...CONTRACT_REFUSAL_ACTIONS].sort()).toEqual(
        listOf('AUTHORITY_REFUSED_ACTIONS').sort(),
      );
    });

    it('lists the same reasons', () => {
      expect([...CONTRACT_REFUSAL_REASONS].sort()).toEqual(
        listOf('AUTHORITY_REFUSED_REASONS').sort(),
      );
    });

    it('lists the same sides', () => {
      expect([...CONTRACT_REFUSAL_SIDES].sort()).toEqual(listOf('AUTHORITY_REFUSED_SIDES').sort());
    });

    it('lists the same policy approval reasons', () => {
      expect([...POLICY_APPROVAL_REFUSAL_REASONS].sort()).toEqual(
        listOf('POLICY_APPROVAL_REFUSED_REASONS').sort(),
      );
    });
  });
});
